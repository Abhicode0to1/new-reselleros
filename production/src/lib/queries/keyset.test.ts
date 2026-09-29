import { describe, it, expect } from "vitest";
import {
  flattenPages, inboxCursorQuery, inboxOlderThanFilter, pageFromOverfetch, parseInboxCursor,
  readInboxNextCursor,
} from "./keyset";

const ID = "00000000-0000-4000-8000-000000000001";
const AT = "2026-09-28T10:00:00.123456+00:00";

describe("flattenPages", () => {
  it("keeps page order and drops a repeated key (first occurrence wins)", () => {
    const out = flattenPages([{ rows: [{ id: "a" }, { id: "b" }] }, { rows: [{ id: "b" }, { id: "c" }] }], (r) => r.id);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
  it("no pages is an empty list", () => {
    expect(flattenPages<{ id: string }>(undefined, (r) => r.id)).toEqual([]);
  });
});

describe("inbox cursor", () => {
  it("round-trips through the query string with the timestamp untouched (microseconds kept)", () => {
    const qs = inboxCursorQuery({ created_at: AT, id: ID });
    const parsed = parseInboxCursor(new URLSearchParams(qs.slice(1)));
    expect(parsed).toEqual({ cursor: { created_at: AT, id: ID }, error: null });
  });

  it("no params is the first page", () => {
    expect(parseInboxCursor(new URLSearchParams(""))).toEqual({ cursor: null, error: null });
    expect(inboxCursorQuery(null)).toBe("");
  });

  it("half a cursor, a non-timestamp, or a non-uuid id is an error — never a silent first page", () => {
    expect(parseInboxCursor(new URLSearchParams({ before: AT })).error).toMatch(/both/);
    expect(parseInboxCursor(new URLSearchParams({ before_id: ID })).error).toMatch(/both/);
    expect(parseInboxCursor(new URLSearchParams({ before: "yesterday-ish", before_id: ID })).error).toMatch(/timestamp/);
    /* Date() would accept this one; the ISO check does not. */
    expect(parseInboxCursor(new URLSearchParams({ before: "Sep 28 2026 (x),or(y)", before_id: ID })).error).toMatch(/timestamp/);
    expect(parseInboxCursor(new URLSearchParams({ before: "2026-09-28T10:00:00Z", before_id: ID })).error).toBeNull();
    expect(parseInboxCursor(new URLSearchParams({ before: "2026-09-28 10:00:00.5+05:30", before_id: ID })).error).toBeNull();
    /* The id is spliced into a PostgREST filter, so anything but a uuid is refused. */
    expect(parseInboxCursor(new URLSearchParams({ before: AT, before_id: "1),or(tenant_id.neq.x" })).error).toMatch(/id/);
  });

  it("'older than' is created_at < c OR (created_at = c AND id < c.id), timestamp quoted", () => {
    expect(inboxOlderThanFilter({ created_at: AT, id: ID })).toBe(
      `created_at.lt."${AT}",and(created_at.eq."${AT}",id.lt.${ID})`,
    );
  });

  it("a double quote cannot break out of the quoted timestamp", () => {
    expect(inboxOlderThanFilter({ created_at: `${AT}"),x(`, id: ID })).not.toContain(`"),x(`);
  });
});

describe("pageFromOverfetch", () => {
  const rows = [
    { id: "3", created_at: "2026-09-28T03:00:00Z" },
    { id: "2", created_at: "2026-09-28T02:00:00Z" },
    { id: "1", created_at: "2026-09-28T01:00:00Z" },
  ];
  it("limit+1 rows → serve limit, cursor = last SERVED row", () => {
    expect(pageFromOverfetch(rows, 2)).toEqual({ rows: rows.slice(0, 2), next: { created_at: rows[1].created_at, id: "2" } });
  });
  it("exactly limit rows or fewer → no next page", () => {
    expect(pageFromOverfetch(rows, 3).next).toBeNull();
    expect(pageFromOverfetch([], 3)).toEqual({ rows: [], next: null });
  });
});

describe("readInboxNextCursor", () => {
  it("parses the header, and treats anything malformed as the last page", () => {
    expect(readInboxNextCursor(JSON.stringify({ created_at: AT, id: ID }))).toEqual({ created_at: AT, id: ID });
    expect(readInboxNextCursor(null)).toBeNull();
    expect(readInboxNextCursor("not json")).toBeNull();
    expect(readInboxNextCursor(JSON.stringify({ created_at: AT }))).toBeNull();
  });
});
