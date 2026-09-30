/**
 * Run work the caller does not need to wait for — AFTER the response has gone out.
 *
 * Found 30 Sep 2026: starting a hosting trial kept the customer on "Starting your trial…"
 * for 30 seconds while the server emailed the OWNER an internal alert (25 s of that single
 * send), because both emails were awaited together. An internal alert must never be on the
 * customer's wait.
 *
 * Next's `after()` keeps the work inside the request's lifetime, so the host does not
 * freeze it the moment the response is sent. Outside a request (tests, scripts) `after`
 * throws, and the work simply starts without being awaited.
 */
import { after } from "next/server";

export function afterResponse(work: () => Promise<unknown>, label: string): void {
  const run = () => work().catch((e: unknown) => console.error(`[after-response] ${label} failed:`, e));
  try {
    after(run);
  } catch {
    void run();
  }
}
