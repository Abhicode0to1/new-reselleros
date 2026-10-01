import { describe, it, expect } from "vitest";
import { hostingDomain } from "./hosting-domain";

describe("hostingDomain — the one rule for a hosting domain (30 Sep 2026)", () => {
  it("accepts real domains, lower-cased", () => {
    expect(hostingDomain("yourcompany.in")).toBe("yourcompany.in");
    expect(hostingDomain("My-Shop.co.in")).toBe("my-shop.co.in");
  });
  it("forgives how people paste a site address", () => {
    expect(hostingDomain(" https://www.Acme.in/about ")).toBe("acme.in");
    expect(hostingDomain("http://acme.com/")).toBe("acme.com");
  });
  it("refuses what is not a domain name", () => {
    for (const bad of ["", "mywebsite", "acme.", ".in", "acme..in", "-acme.in", "acme-.in", "ac me.in", "acme.c", "acme.in@x"]) {
      expect(hostingDomain(bad), bad).toBeNull();
    }
    expect(hostingDomain(null)).toBeNull();
  });
});

describe("planDomains — one domain for each hosting plan (30 Sep 2026)", () => {
  // Imported here so the block stands alone at the end of the file.
  const load = () => import("./hosting-domain").then((m) => m.planDomains);

  it("one plan: the typed domain, cleaned", async () => {
    const planDomains = await load();
    expect(planDomains([{ label: "Starter hosting", typed: "https://www.Acme.in/" }])).toEqual({ ok: true, domains: ["acme.in"] });
  });
  it("one plan, nothing typed, one domain in the cart: that domain (the bundle)", async () => {
    const planDomains = await load();
    expect(planDomains([{ label: "Starter hosting", typed: "" }], ["acme.in"])).toEqual({ ok: true, domains: ["acme.in"] });
  });
  it("one plan keeps today's wording", async () => {
    const planDomains = await load();
    expect(planDomains([{ label: "Starter hosting", typed: "" }])).toEqual({ ok: false, problems: ["the domain for your hosting (like yourcompany.in)"] });
    expect(planDomains([{ label: "Starter hosting", typed: "mywebsite" }])).toEqual({ ok: false, problems: ["a valid domain for your hosting (like yourcompany.in)"] });
  });
  it("several plans: each its own domain, in cart order", async () => {
    const planDomains = await load();
    expect(planDomains([{ label: "Starter hosting", typed: "a.in" }, { label: "Plus hosting", typed: "b.com" }])).toEqual({ ok: true, domains: ["a.in", "b.com"] });
  });
  it("several plans never borrow the cart's domain — each needs its own", async () => {
    const planDomains = await load();
    const r = planDomains([{ label: "Starter hosting", typed: "" }, { label: "Plus hosting", typed: "b.in" }], ["a.in"]);
    expect(r).toEqual({ ok: false, problems: ["the domain for your Starter hosting (like yourcompany.in)"] });
  });
  it("two plans cannot share a domain, however it is written", async () => {
    const planDomains = await load();
    expect(planDomains([{ label: "Starter hosting", typed: "a.in" }, { label: "Plus hosting", typed: "WWW.a.in" }])).toEqual({
      ok: false, problems: ["a different domain for your Plus hosting — a.in is already on your Starter hosting"],
    });
  });
  it("names every problem at once", async () => {
    const planDomains = await load();
    const r = planDomains([{ label: "Starter hosting", typed: "x" }, { label: "Plus hosting", typed: "" }]);
    expect(r.ok ? [] : r.problems).toHaveLength(2);
  });
});
