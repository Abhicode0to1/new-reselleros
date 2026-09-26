import { describe, it, expect } from "vitest";
import { buildTrackingUrl, defaultMedium, slugCampaign, DESTINATIONS } from "./tracking-link";
import { captureUtm, channelFor } from "./utm";
import { AD_CHANNELS } from "./ad-channels";
import { LEAD_SOURCES } from "@/lib/leads/lead-sources";

describe("tracking links", () => {
  it("builds a link with the channel key as utm_source", () => {
    const url = buildTrackingUrl({ origin: "https://anutech.in/", path: "/enquiry", channel: "meta-ads", campaign: "Diwali Offer 2026!" });
    expect(url).toBe("https://anutech.in/enquiry?utm_source=meta-ads&utm_medium=cpc&utm_campaign=diwali-offer-2026");
  });

  it("round trip: a lead from the link lands on the same channel in ROAS", () => {
    // Every channel a link can be made for must come back as itself — for paid AND unpaid.
    const channels = [...new Set([...AD_CHANNELS.map((c) => c.value), ...LEAD_SOURCES.map((s) => s.value)])];
    for (const ch of channels) {
      const url = buildTrackingUrl({ origin: "https://x.in", path: "/enquiry", channel: ch, campaign: "test", content: "ad 1" });
      const utm = captureUtm({ url, selfHosts: ["x.in"] });
      expect(channelFor(utm, "enquiry-form"), ch).toBe(ch);
    }
  });

  it("a Facebook PAGE post is not credited to Facebook ads", () => {
    const url = buildTrackingUrl({ origin: "https://x.in", path: "/enquiry", channel: "meta-organic", campaign: "post" });
    expect(channelFor(captureUtm({ url }), null)).toBe("meta-organic");
  });

  it("medium follows the channel", () => {
    expect(defaultMedium("google-ads")).toBe("cpc");
    expect(defaultMedium("meta-organic")).toBe("social");
    expect(defaultMedium("google-organic")).toBe("organic");
    expect(defaultMedium("indiamart")).toBe("listing");
    expect(defaultMedium("referral")).toBe("referral");
  });

  it("campaign and content are slugged; content optional; medium overridable", () => {
    expect(slugCampaign("  Hello — World  ")).toBe("hello-world");
    const u = new URL(buildTrackingUrl({ origin: "https://x.in", path: "/buy/workspace", channel: "google-ads", campaign: "", medium: "display" }));
    expect(u.searchParams.get("utm_campaign")).toBe("general");
    expect(u.searchParams.get("utm_medium")).toBe("display");
    expect(u.searchParams.has("utm_content")).toBe(false);
  });

  it("only form pages are destinations", () => {
    for (const d of DESTINATIONS) expect(d.path.startsWith("/")).toBe(true);
    expect(DESTINATIONS.map((d) => d.path)).toContain("/enquiry");
  });
});
