/**
 * The key DMS presents when IT calls ResellerOS (25 Sep 2026, owner decision 30).
 *
 * Every other link between the apps runs the other way: ResellerOS calls DMS with
 * DMS_ENGINE_COMMAND_KEY. The panel's orders and bills run DMS → ResellerOS, so they use
 * their own key, DMS_PANEL_API_KEY, and one leaked key never opens both directions.
 *
 * - Sent as `Authorization: Bearer <key>`.
 * - The env var may hold a comma-separated list so a key can be rotated with both
 *   valid for a while (L87).
 * - Compared in constant time.
 * - No key configured on this server → 503, because that is our deployment to fix,
 *   not the caller's (L6). A wrong or missing key → 401.
 */
import { timingSafeEqual } from "node:crypto";

export type PanelAuth = { ok: true } | { ok: false; status: 401 | 503; error: string };

function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function checkPanelKey(headers: Headers): PanelAuth {
  const keys = (process.env.DMS_PANEL_API_KEY ?? "").split(",").map((k) => k.trim()).filter((k) => k.length >= 16);
  if (!keys.length) {
    return { ok: false, status: 503, error: "Panel orders are not set up on ResellerOS: DMS_PANEL_API_KEY is not configured. Set the same value on both apps." };
  }
  const m = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "");
  const given = m?.[1]?.trim() ?? "";
  if (!given || !keys.some((k) => same(k, given))) {
    return { ok: false, status: 401, error: "The panel key was missing or wrong. Check DMS_PANEL_API_KEY on DMS matches this app's." };
  }
  return { ok: true };
}
