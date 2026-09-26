import { describe, it, expect, beforeAll } from "vitest";
import { signUnsubscribe, verifyUnsubscribe, unsubscribeUrl, unsubscribeFooter } from "./unsubscribe-token";

beforeAll(() => { process.env.UNSUBSCRIBE_SIGNING_SECRET = "test-secret-for-unsubscribe"; });

const T = "fbb976f1-9090-4f10-9726-0901bd144e42";

describe("unsubscribe links", () => {
  it("a signed link verifies; case and spaces in the email do not matter", () => {
    const s = signUnsubscribe(T, "Deepak@Excel.in ");
    expect(verifyUnsubscribe(T, "deepak@excel.in", s)).toBe(true);
  });

  it("cannot be reused for another address or another company", () => {
    const s = signUnsubscribe(T, "deepak@excel.in");
    expect(verifyUnsubscribe(T, "someone@else.in", s)).toBe(false);
    expect(verifyUnsubscribe("22222222-2222-2222-2222-222222222222", "deepak@excel.in", s)).toBe(false);
    expect(verifyUnsubscribe(T, "deepak@excel.in", "")).toBe(false);
    expect(verifyUnsubscribe(T, "deepak@excel.in", s.slice(0, -1) + "0")).toBe(s.endsWith("0"));
  });

  it("builds an absolute link, or none without a host", () => {
    const u = unsubscribeUrl("https://app.anutech.in/", T, "Deepak@Excel.in", "CMP-7");
    expect(u).toMatch(/^https:\/\/app\.anutech\.in\/unsubscribe\?t=/);
    const q = new URL(u!).searchParams;
    expect(q.get("e")).toBe("deepak@excel.in");
    expect(q.get("c")).toBe("CMP-7");
    expect(verifyUnsubscribe(q.get("t")!, q.get("e")!, q.get("s")!)).toBe(true);
    expect(unsubscribeUrl("", T, "a@b.in")).toBeNull();
    expect(unsubscribeUrl("app.anutech.in", T, "a@b.in")).toBeNull();
  });

  it("footer carries the link in both text and HTML", () => {
    const f = unsubscribeFooter("https://x.in/unsubscribe?t=1", "Anutech <Digital>");
    expect(f.text).toContain("https://x.in/unsubscribe?t=1");
    expect(f.html).toContain('href="https://x.in/unsubscribe?t=1"');
    expect(f.html).not.toContain("<Digital>");
  });
});
