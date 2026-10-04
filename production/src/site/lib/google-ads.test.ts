// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { adsTagId, reportLeadConversion, GOOGLE_ADS_SEND_TO } from "./google-ads";

describe("Google Ads conversion (R-139)", () => {
  beforeEach(() => { document.head.innerHTML = ""; delete window.gtag; delete window.dataLayer; });

  it("accepts only a real send_to shape", () => {
    expect(adsTagId("AW-123456789/AbCdEfGhIj")).toBe("AW-123456789");
    expect(adsTagId("")).toBeNull();
    expect(adsTagId("AW-123/x")).toBeNull();
    expect(adsTagId("G-ABC/123456")).toBeNull();
    expect(adsTagId("AW-123456789/ab\"><script>")).toBeNull();
  });

  it("does nothing at all while no conversion is configured", async () => {
    expect(GOOGLE_ADS_SEND_TO === "" || adsTagId(GOOGLE_ADS_SEND_TO)).toBeTruthy();
    await reportLeadConversion("");
    expect(document.getElementById("gtag-js")).toBeNull();
    expect(window.dataLayer).toBeUndefined();
  });

  it("when configured: loads gtag once and queues one conversion", async () => {
    await reportLeadConversion("AW-123456789/AbCdEfGhIj");
    await reportLeadConversion("AW-123456789/AbCdEfGhIj");
    expect(document.querySelectorAll("#gtag-js")).toHaveLength(1);
    expect((document.getElementById("gtag-js") as HTMLScriptElement).src).toContain("id=AW-123456789");
    const events = (window.dataLayer ?? []).map((a) => Array.from(a as ArrayLike<unknown>)).filter((a) => a[0] === "event");
    expect(events).toHaveLength(2);
    expect((events[0][2] as { send_to: string }).send_to).toBe("AW-123456789/AbCdEfGhIj");
  });
});
