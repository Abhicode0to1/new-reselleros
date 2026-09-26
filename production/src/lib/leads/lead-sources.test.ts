import { describe, it, expect } from "vitest";
import { LEAD_SOURCES, sourceOptions, sourceLabel } from "./lead-sources";
import { AD_CHANNELS } from "@/lib/marketing/ad-channels";

describe("lead sources", () => {
  const keys = LEAD_SOURCES.map((s) => s.value);

  it("every channel spend can be tagged with is also a lead source — same key", () => {
    for (const c of AD_CHANNELS) expect(keys, `${c.value} has spend but no leads can carry it`).toContain(c.value);
  });

  it("Facebook ads and the Facebook page are separate", () => {
    expect(keys).toContain("meta-ads");
    expect(keys).toContain("meta-organic");
  });

  it("no duplicates", () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps an unknown saved source visible instead of blanking it", () => {
    expect(sourceOptions("meta-ads")).toBe(LEAD_SOURCES);
    const opts = sourceOptions("old-partner-form");
    expect(opts.at(-1)).toEqual({ value: "old-partner-form", label: "old-partner-form" });
    expect(sourceOptions(null)).toBe(LEAD_SOURCES);
  });

  it("labels", () => {
    expect(sourceLabel("meta-ads")).toBe("Facebook / Instagram Ads");
    expect(sourceLabel("xyz")).toBe("xyz");
    expect(sourceLabel(null)).toBe("—");
  });
});
