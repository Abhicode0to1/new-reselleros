import { describe, it, expect, vi } from "vitest";
import { isOAuthProviderEnabled } from "./oauth-enabled";

const reply = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

describe("isOAuthProviderEnabled (R-098)", () => {
  it("reads the provider flag from /auth/v1/settings", async () => {
    const f = reply({ external: { google: false, github: true } });
    expect(await isOAuthProviderEnabled("http://127.0.0.1:54321/", "google", f)).toBe(false);
    expect(await isOAuthProviderEnabled("http://127.0.0.1:54321", "github", f)).toBe(true);
    expect((f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("http://127.0.0.1:54321/auth/v1/settings");
  });

  it("cannot tell → null, so the login goes ahead as before", async () => {
    expect(await isOAuthProviderEnabled("https://x.supabase.co", "google", reply({}, false))).toBeNull();
    expect(await isOAuthProviderEnabled("https://x.supabase.co", "google", reply({ external: {} }))).toBeNull();
    const boom = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    expect(await isOAuthProviderEnabled("https://x.supabase.co", "google", boom)).toBeNull();
  });
});
