/**
 * markProvisioningActivated writes activated_at with the status (29 Sep 2026). The first
 * real engine activation — DirectAdmin account e2esife250 — was left "activated" with an
 * empty activated_at, because only status, vendor_ref and updated_at were written.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const writes: Array<{ table: string; values: Record<string, unknown>; id: unknown }> = [];
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: async (_col: string, id: unknown) => { writes.push({ table, values, id }); return { error: null }; },
      }),
    }),
  }),
}));

import { markProvisioningActivated } from "./provisioning.server";

beforeEach(() => {
  writes.length = 0;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:14321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:03:07.000Z"));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("markProvisioningActivated", () => {
  it("records WHEN it was activated, not only that it was", async () => {
    await markProvisioningActivated("46606f57-ebd6-420d-b515-ef3e4ac1268a", "e2esife250");
    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe("provisioning_requests");
    expect(writes[0].id).toBe("46606f57-ebd6-420d-b515-ef3e4ac1268a");
    expect(writes[0].values).toEqual({
      status: "activated",
      vendor_ref: "e2esife250",
      activated_at: "2026-09-29T12:03:07.000Z",
      updated_at: "2026-09-29T12:03:07.000Z",
    });
  });
});
