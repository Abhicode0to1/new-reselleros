import { describe, it, expect } from "vitest";
import { quickAddProblem, quickAddLabel, whatsappNumber } from "./quick-add";

describe("quickAddProblem (R-099)", () => {
  it("a phone alone is enough", () => {
    expect(quickAddProblem({ phone: "98765 43210" })).toBeNull();
    expect(quickAddProblem({ phone: "+91-98765-43210" })).toBeNull();
  });
  it("an email alone, or a name alone, is enough", () => {
    expect(quickAddProblem({ email: "ravi@acme.in" })).toBeNull();
    expect(quickAddProblem({ name: "Ravi" })).toBeNull();
  });
  it("nothing → one plain sentence", () => {
    expect(quickAddProblem({})).toBe("Add a phone number, an email or a name.");
    expect(quickAddProblem({ name: " R " })).toBe("Add a phone number, an email or a name.");
  });
  it("a half-typed phone or a broken email is called out", () => {
    expect(quickAddProblem({ name: "Ravi", phone: "98765" })).toBe("A phone number needs at least 10 digits.");
    expect(quickAddProblem({ phone: "9876543210", email: "ravi@" })).toBe("That email doesn't look right.");
  });
});

describe("labels and WhatsApp", () => {
  it("names the lead by name, then company, then phone", () => {
    expect(quickAddLabel({ name: "Ravi", company: "Acme" })).toBe("Ravi");
    expect(quickAddLabel({ company: "Acme", phone: "9876543210" })).toBe("Acme");
    expect(quickAddLabel({ phone: "9876543210" })).toBe("9876543210");
  });
  it("wa.me number gets 91 on a 10-digit Indian number", () => {
    expect(whatsappNumber("98765 43210")).toBe("919876543210");
    expect(whatsappNumber("+91 98765 43210")).toBe("919876543210");
    expect(whatsappNumber("12345")).toBeNull();
  });
});
