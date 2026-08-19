/**
 * PIN hashing and verification — SERVER ONLY.
 *
 * ─── DO NOT IMPORT THIS FROM A CLIENT COMPONENT ─────────────────────────────
 * It pulls in `node:crypto`, which webpack cannot bundle for a browser: the route dies
 * with `UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins` and
 * returns a 500. That is exactly how this file came to be split — the lock screen
 * imported `PIN_LENGTH` from here and took the whole `/vault/personal` route down with
 * it, while typecheck, lint and vitest all stayed green.
 *
 * Anything a browser needs — PIN_LENGTH, the weak-PIN rules, the lockout maths — lives
 * in `./pin-rules`, which has no crypto in it. Everything in THIS file handles a secret
 * and has no business in a bundle.
 *
 * The rules are re-exported at the bottom purely so the API route can import one module.
 *
 * WHAT THE PIN IS WORTH: see the header of `./pin-rules`. Short version — it is a lock
 * on the screen, not encryption, and the real access control is the RLS policy
 * `owner_user_id = auth.uid()`.
 */
import crypto from "node:crypto";
import { isValidPinFormat } from "./pin-rules";

/** scrypt cost. N=16384 is the usual interactive default and is ~50ms here. */
const SCRYPT_N = 16_384;
const KEY_LEN = 32;

export function newSalt(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function hashPin(pin: string, salt: string): string {
  return crypto.scryptSync(pin, salt, KEY_LEN, { N: SCRYPT_N }).toString("hex");
}

/**
 * Timing-safe comparison.
 *
 * `===` on the hex strings leaks how many leading characters matched. That matters more
 * here than usual: with only 10,000 candidates, a timing signal turns an infeasible
 * search into a trivial one.
 */
export function verifyPin(pin: string, salt: string, expectedHash: string): boolean {
  if (!isValidPinFormat(pin)) return false;

  let actual: Buffer;
  try {
    actual = Buffer.from(hashPin(pin, salt), "hex");
  } catch {
    return false;
  }

  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHash, "hex");
  } catch {
    return false;
  }

  // A short or non-hex stored hash must fail closed rather than throw — a corrupt row
  // should lock the owner out politely, not 500 the vault screen.
  if (actual.length !== expected.length || expected.length === 0) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export {
  PIN_LENGTH,
  MAX_ATTEMPTS,
  LOCKOUT_MINUTES,
  UNLOCK_TTL_MINUTES,
  isValidPinFormat,
  isWeakPin,
  validateNewPin,
  lockState,
  nextFailureState,
  successState,
} from "./pin-rules";
export type { PinValidation, LockState, FailureOutcome } from "./pin-rules";
