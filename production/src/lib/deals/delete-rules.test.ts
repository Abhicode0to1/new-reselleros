import { describe, it, expect } from "vitest";
import { dealDeleteBlock, friendlyDeleteError } from "./delete-rules";

describe("deleting a deal (2 Oct 2026)", () => {
  it("only an owner or manager may", () => {
    expect(dealDeleteBlock({ role: "sales", quoteIds: [] })).toMatch(/Only an owner or manager/);
    expect(dealDeleteBlock({ role: undefined, quoteIds: [] })).toMatch(/Only an owner or manager/);
    expect(dealDeleteBlock({ role: "owner", quoteIds: [] })).toBeNull();
    expect(dealDeleteBlock({ role: "manager", quoteIds: [] })).toBeNull();
  });
  it("never with a quote on it — and names the quotes", () => {
    expect(dealDeleteBlock({ role: "owner", quoteIds: ["Q-FBB9-27-0006"] })).toMatch(/a quote \(Q-FBB9-27-0006\).*Mark it Lost/);
    expect(dealDeleteBlock({ role: "owner", quoteIds: ["Q1", "Q2", "Q3", "Q4"] })).toMatch(/quotes \(Q1, Q2 and 2 more\)/);
  });
  it("turns the database's refusal into words", () => {
    expect(friendlyDeleteError("update or delete on table \"leads\" violates foreign key constraint", "23503")).toMatch(/Mark it Lost/);
    expect(friendlyDeleteError("new row violates row-level security policy", "42501")).toMatch(/owner or manager/);
    expect(friendlyDeleteError("network down", null)).toBeNull();
  });
});
