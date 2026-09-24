import { describe, it, expect } from "vitest";
import { cleanTlds, splitDomain } from "./live-lookup";

describe("splitDomain — only a single registrable name can be charged", () => {
  it.each([
    ["acme.in", { name: "acme", tld: "in" }],
    ["Acme.CO.IN", { name: "acme", tld: "co.in" }],
    ["my-shop.com", { name: "my-shop", tld: "com" }],
  ])("%s", (raw, want) => {
    expect(splitDomain(raw)).toEqual(want);
  });

  it.each(["", "acme", "https://acme.in", "www.acme.in.x.y", "-acme.in", "acme-.in", "ac me.in", "acme.in/", "acme..in"])(
    "refuses %j",
    (raw) => {
      expect(splitDomain(raw)).toBeNull();
    },
  );
});

describe("cleanTlds", () => {
  it("strips dots, lowercases, drops blanks, caps at ten", () => {
    expect(cleanTlds([".IN", " com ", "", "..org"])).toEqual(["in", "com", "org"]);
    expect(cleanTlds(Array.from({ length: 15 }, (_, i) => `t${i}`))).toHaveLength(10);
  });
});
