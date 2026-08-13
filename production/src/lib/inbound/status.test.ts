import { describe, it, expect } from "vitest";
import { inboundStatusMeta, canConvertToLead } from "./status";

describe("inboundStatusMeta", () => {
  it("maps known statuses to label + tone", () => {
    expect(inboundStatusMeta("lead_created")).toEqual({ label: "Lead Created", kind: "success" });
    // Renamed from "Appended" so an operator reads it as a reply, not a merge.
    expect(inboundStatusMeta("appended_to_lead")).toEqual({ label: "Follow-up Reply", kind: "info" });
    expect(inboundStatusMeta("received")).toEqual({ label: "New Enquiry", kind: "warning" });
    expect(inboundStatusMeta("skipped_non_enquiry").label).toBe("System / Non-Sales");
    expect(inboundStatusMeta("duplicate").kind).toBe("muted");
    expect(inboundStatusMeta("error").kind).toBe("danger");
  });

  it("falls back gracefully for unknown / empty status", () => {
    expect(inboundStatusMeta("weird").label).toBe("weird");
    expect(inboundStatusMeta("weird").kind).toBe("muted");
    expect(inboundStatusMeta("").label).toBe("—");
  });
});

describe("canConvertToLead", () => {
  it("allows converting untriaged / non-enquiry / errored emails with no lead", () => {
    expect(canConvertToLead({ status: "received", lead_id: null })).toBe(true);
    expect(canConvertToLead({ status: "skipped_non_enquiry", lead_id: null })).toBe(true);
    expect(canConvertToLead({ status: "error", lead_id: null })).toBe(true);
  });

  it("blocks converting when a lead already exists (idempotency at the UI)", () => {
    expect(canConvertToLead({ status: "lead_created", lead_id: "L-1" })).toBe(false);
    // Even a stale status shouldn't allow a second lead once one is linked.
    expect(canConvertToLead({ status: "received", lead_id: "L-1" })).toBe(false);
  });

  it("blocks converting duplicates / already-attached emails", () => {
    expect(canConvertToLead({ status: "duplicate", lead_id: null })).toBe(false);
    expect(canConvertToLead({ status: "appended_to_lead", lead_id: "L-9" })).toBe(false);
  });
});
