import { describe, it, expect } from "vitest";
import { missingCheckoutDetails, missingDetailsMessage, type CheckoutDetails } from "./checkout-details";

const ok: CheckoutDetails = {
  name: "Pawan", email: "pawan@anutech.in", phone: "7778886760", domain: "mywebsite.com",
  hasHosting: true, hasDomain: false, address: { line1: "", city: "", state: "", pin: "" },
};

describe("what the checkout still needs", () => {
  it("the owner's case: no company name → nothing missing (it is optional)", () => {
    expect(missingCheckoutDetails(ok)).toEqual([]);
    expect(missingDetailsMessage([])).toBeNull();
  });

  it("names each missing field in words a buyer can act on", () => {
    const m = missingCheckoutDetails({ ...ok, name: "", phone: "98765", domain: "" });
    expect(m).toEqual(["your name", "your mobile number (10 digits)", "the domain for your hosting (like yourcompany.in)"]);
    expect(missingDetailsMessage(m)).toBe(
      "Please add your name, your mobile number (10 digits) and the domain for your hosting (like yourcompany.in) to continue.",
    );
  });

  it("an email must look like one, not merely contain @", () => {
    expect(missingCheckoutDetails({ ...ok, email: "pawan@" })).toEqual(["a valid email address"]);
  });

  it("the phone counts digits, so spaces and +91 do not fail it", () => {
    expect(missingCheckoutDetails({ ...ok, phone: "+91 77788 86760" })).toEqual([]);
  });

  it("a domain purchase needs the owner's address, a hosting-only one does not", () => {
    expect(missingCheckoutDetails({ ...ok, hasDomain: true })).toEqual([
      "the domain owner's postal address (address, city, state and a 6-digit PIN code)",
    ]);
    expect(missingCheckoutDetails({ ...ok, hasHosting: false, domain: "" })).toEqual([]);
  });

  it("a word that is not a domain is still missing a domain (30 Sep 2026)", () => {
    expect(missingCheckoutDetails({ ...ok, domain: "mywebsite" })).toEqual(["a valid domain for your hosting (like yourcompany.in)"]);
  });

  it("one item reads as a sentence too", () => {
    expect(missingDetailsMessage(["your name"])).toBe("Please add your name to continue.");
  });
});
