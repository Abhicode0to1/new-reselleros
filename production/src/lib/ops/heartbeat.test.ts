import { describe, it, expect, afterEach } from "vitest";
import { heartbeatUrl } from "./heartbeat";

const orig = process.env.HEARTBEAT_PING_URL;
afterEach(() => { if (orig === undefined) delete process.env.HEARTBEAT_PING_URL; else process.env.HEARTBEAT_PING_URL = orig; });

describe("heartbeat url", () => {
  it("is a no-op when unset", () => {
    delete process.env.HEARTBEAT_PING_URL;
    expect(heartbeatUrl("renewals")).toBeNull();
  });
  it("fills the {job} placeholder with a safe slug", () => {
    process.env.HEARTBEAT_PING_URL = "https://hc-ping.com/abc/resellersos-{job}";
    expect(heartbeatUrl("google-contacts-sync")).toBe("https://hc-ping.com/abc/resellersos-google-contacts-sync");
    expect(heartbeatUrl("Weird Job!")).toBe("https://hc-ping.com/abc/resellersos-weird-job-");
  });
  it("appends the slug when there is no placeholder", () => {
    process.env.HEARTBEAT_PING_URL = "https://cronitor.link/p/key/";
    expect(heartbeatUrl("backup")).toBe("https://cronitor.link/p/key/backup");
  });
});
