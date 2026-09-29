import { describe, it, expect } from "vitest";
import { parseAllowlist, recipientAllowed } from "./recipient-allowlist";

describe("EMAIL_RECIPIENT_ALLOWLIST", () => {
  it("unset or blank → no filter (production)", () => {
    expect(recipientAllowed("anyone@gmail.com", undefined).allowed).toBe(true);
    expect(recipientAllowed("anyone@gmail.com", " ").allowed).toBe(true);
  });

  it("@domain allows that domain only — not a lookalike, not a subdomain", () => {
    expect(recipientAllowed("Pawan@Anutech.in", "@anutech.in").allowed).toBe(true);
    expect(recipientAllowed("x@notanutech.in", "@anutech.in").allowed).toBe(false);
    expect(recipientAllowed("x@mail.anutech.in", "@anutech.in").allowed).toBe(false);
  });

  it("a plain entry is one exact address", () => {
    expect(recipientAllowed("tester@gmail.com", "@anutech.in, tester@gmail.com").allowed).toBe(true);
    expect(recipientAllowed("other@gmail.com", "@anutech.in, tester@gmail.com").allowed).toBe(false);
  });

  it("a refusal names the address and says it was not sent", () => {
    expect(recipientAllowed("owner@customer.com", "@anutech.in").reason).toMatch(/^not sent — owner@customer\.com is not on EMAIL_RECIPIENT_ALLOWLIST/);
  });

  it("parses commas, semicolons and spaces", () => {
    expect(parseAllowlist("@a.in;b@c.com  d@e.com")).toEqual(["@a.in", "b@c.com", "d@e.com"]);
  });
});
