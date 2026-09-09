import { describe, it, expect } from "vitest";
import { planDnsSync, planIsNoop, toDnsRow, type LocalDnsRow } from "./dns-sync";
import type { RcDnsRecord, RcDnsListOutcome } from "@/lib/resellerclub/dns";

/**
 * Most of this file is about NOT deleting things.
 *
 * A reconcile deletes local rows that have no upstream match, and "no upstream
 * match" is indistinguishable from "we failed to read that record type" unless
 * somebody checks. `rcListDnsRecords` needs seven calls to list a zone, so a
 * single rate-limited query is enough to make a customer's MX records look
 * absent — and deleting them from the mirror means the portal shows a domain
 * with no mail.
 */

const rc = (over: Partial<RcDnsRecord> = {}): RcDnsRecord => ({
  providerRecordId: "1",
  type: "A",
  host: "acmecorp.com",
  value: "203.0.113.10",
  ttl: 7200,
  priority: null,
  ...over,
});

const row = (over: Partial<LocalDnsRow> = {}): LocalDnsRow => ({
  id: "row-1",
  record_type: "A",
  host: "acmecorp.com",
  value: "203.0.113.10",
  ttl: 7200,
  priority: null,
  provider_record_id: "1",
  ...over,
});

const listed = (records: RcDnsRecord[]): RcDnsListOutcome => ({ kind: "listed", records });
const partial = (
  records: RcDnsRecord[],
  failed: Array<{ type: RcDnsRecord["type"]; reason: string }>,
): RcDnsListOutcome => ({ kind: "partial", records, failed });

describe("a complete read reconciles in both directions", () => {
  it("inserts what is upstream and missing locally", () => {
    const plan = planDnsSync(listed([rc(), rc({ providerRecordId: "2", type: "MX", value: "mail.acmecorp.com", priority: 10 })]), [row()]);
    expect(plan.insert.map((r) => r.providerRecordId)).toEqual(["2"]);
    expect(plan.update).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  it("updates a row whose contents drifted upstream", () => {
    const plan = planDnsSync(listed([rc({ value: "203.0.113.99", ttl: 3600 })]), [row()]);
    expect(plan.update).toEqual([{ id: "row-1", to: expect.objectContaining({ value: "203.0.113.99" }) }]);
    expect(plan.delete).toEqual([]);
  });

  it("deletes a local row that upstream no longer has", () => {
    const plan = planDnsSync(listed([]), [row()]);
    expect(plan.delete).toEqual(["row-1"]);
    expect(plan.deletesWithheld).toBeNull();
  });

  it("changes nothing when the mirror already matches", () => {
    const plan = planDnsSync(listed([rc()]), [row()]);
    expect(planIsNoop(plan)).toBe(true);
  });
});

describe("a PARTIAL read must never delete — the whole point of this module", () => {
  it("withholds every delete, and says why", () => {
    /* MX failed to read, so the local MX row has no upstream match. Deleting it
       would take the customer's mail records out of the mirror. */
    const plan = planDnsSync(
      partial([rc()], [{ type: "MX", reason: "IP not whitelisted" }]),
      [row(), row({ id: "row-mx", record_type: "MX", value: "mail.acmecorp.com", priority: 10, provider_record_id: "9" })],
    );
    expect(plan.delete).toEqual([]);
    expect(plan.deletesWithheld).toMatch(/incomplete/);
    expect(plan.deletesWithheld).toMatch(/MX/);
  });

  it("withholds a delete even for a type that DID answer", () => {
    /* The case that exercises the completeness guard on its own. The local A row
       is absent from the partial list AND type A read fine, so the only thing
       standing between it and deletion is "the read was incomplete". Written
       after a mutation test showed the headline case above was being saved by a
       second guard (deletes confined to covered types) rather than by this one. */
    const plan = planDnsSync(
      partial([], [{ type: "MX", reason: "IP not whitelisted" }]),
      [row()],
    );
    expect(plan.delete).toEqual([]);
    expect(plan.deletesWithheld).toMatch(/incomplete/);
  });

  it("still applies inserts and updates from the types that DID answer", () => {
    /* A partial read is not useless — it is just not authority to delete. */
    const plan = planDnsSync(
      partial([rc({ providerRecordId: "2", value: "203.0.113.55" })], [{ type: "TXT", reason: "timeout" }]),
      [row()],
    );
    expect(plan.insert.map((r) => r.providerRecordId)).toEqual(["2"]);
    expect(plan.delete).toEqual([]);
  });

  it("reports which types the read actually covered", () => {
    const plan = planDnsSync(partial([], [{ type: "MX", reason: "x" }, { type: "SRV", reason: "y" }]), []);
    expect(plan.typesCovered).not.toContain("MX");
    expect(plan.typesCovered).not.toContain("SRV");
    expect(plan.typesCovered).toContain("A");
  });
});

describe("a failed or absent zone is not authority to empty the mirror", () => {
  it("a hard failure changes nothing at all", () => {
    const plan = planDnsSync({ kind: "hard_failure", reason: "api key is invalid" }, [row()]);
    expect(planIsNoop(plan)).toBe(true);
    expect(plan.deletesWithheld).toMatch(/could not be read/);
  });

  it("not_found does NOT empty the mirror — DNS may simply not be active yet", () => {
    const plan = planDnsSync({ kind: "not_found", reason: "no zone" }, [row(), row({ id: "row-2" })]);
    expect(plan.delete).toEqual([]);
    expect(planIsNoop(plan)).toBe(true);
    expect(plan.deletesWithheld).toMatch(/not active/);
  });
});

describe("matching a local row to an upstream record", () => {
  it("prefers the registrar's record id over the contents", () => {
    /* Value changed upstream; the id says it is the same record, so this is an
       update and not an insert-plus-delete. */
    const plan = planDnsSync(listed([rc({ value: "203.0.113.77" })]), [row()]);
    expect(plan.insert).toEqual([]);
    expect(plan.update).toHaveLength(1);
  });

  it("falls back to type+host+value when there is no id on either side", () => {
    const plan = planDnsSync(listed([rc({ providerRecordId: null })]), [row({ provider_record_id: null })]);
    expect(planIsNoop(plan)).toBe(true);
  });

  it("treats host case as insignificant, because DNS does", () => {
    const plan = planDnsSync(listed([rc({ providerRecordId: null, host: "ACMEcorp.com" })]), [row({ provider_record_id: null })]);
    expect(plan.insert).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  it("does not match one upstream record to two local rows", () => {
    /* Two identical local rows and one upstream record: one is a duplicate and
       should be deleted, not silently reconciled twice. */
    const plan = planDnsSync(listed([rc({ providerRecordId: null })]), [
      row({ id: "a", provider_record_id: null }),
      row({ id: "b", provider_record_id: null }),
    ]);
    expect(plan.insert).toEqual([]);
    expect(plan.delete).toEqual(["b"]);
  });

  it("notices when only the record id was learned", () => {
    /* Same contents, but the mirror never had RC's id — worth writing so a
       later modify/delete can address the record. */
    const plan = planDnsSync(listed([rc({ providerRecordId: "42" })]), [row({ provider_record_id: null })]);
    expect(plan.update).toEqual([{ id: "row-1", to: expect.objectContaining({ providerRecordId: "42" }) }]);
  });
});

describe("toDnsRow", () => {
  it("maps the registrar's record onto the table's columns", () => {
    expect(toDnsRow(rc({ type: "MX", priority: 10 }), "t-1", "d-1")).toEqual({
      tenant_id: "t-1",
      domain_id: "d-1",
      record_type: "MX",
      host: "acmecorp.com",
      value: "203.0.113.10",
      ttl: 7200,
      priority: 10,
      provider_record_id: "1",
    });
  });
});
