import { describe, it, expect } from "vitest";
import { AD_CHANNELS, isMarketingCategory, suggestAdChannel } from "./ad-channels";

describe("ad channels", () => {
  it("uses the keys lead sources and utm mapping already use", () => {
    const keys = AD_CHANNELS.map((c) => c.value);
    for (const k of ["google-ads", "meta-ads", "linkedin-ads", "whatsapp", "email-outreach", "tele-calling", "referral"]) {
      expect(keys).toContain(k);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("Marketing and Advertising are marketing categories; Rent is not", () => {
    expect(isMarketingCategory("Marketing")).toBe(true);
    expect(isMarketingCategory("Advertising")).toBe(true);
    expect(isMarketingCategory("Rent")).toBe(false);
    expect(isMarketingCategory(null)).toBe(false);
  });

  it("names the channel from the vendor", () => {
    expect(suggestAdChannel("Google India Pvt Ltd")).toBe("google-ads");
    expect(suggestAdChannel("Facebook India Online Services")).toBe("meta-ads");
    expect(suggestAdChannel("Meta Platforms Ireland")).toBe("meta-ads");
    expect(suggestAdChannel("LinkedIn Singapore")).toBe("linkedin-ads");
    expect(suggestAdChannel("Wati — WhatsApp API")).toBe("whatsapp");
  });

  it("offers nothing when the words point nowhere", () => {
    expect(suggestAdChannel("Sharma Printers")).toBeNull();
    expect(suggestAdChannel("")).toBeNull();
    expect(suggestAdChannel(null)).toBeNull();
  });
});
