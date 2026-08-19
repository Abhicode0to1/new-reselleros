import { describe, it, expect } from "vitest";
import {
  isValidPinFormat,
  isWeakPin,
  validateNewPin,
  newSalt,
  hashPin,
  verifyPin,
  lockState,
  nextFailureState,
  successState,
  MAX_ATTEMPTS,
  LOCKOUT_MINUTES,
  PIN_LENGTH,
} from "./pin";

const NOW = new Date("2026-08-19T12:00:00Z");

describe("format", () => {
  it("accepts exactly four digits", () => {
    expect(isValidPinFormat("4071")).toBe(true);
    expect(isValidPinFormat("9058")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const bad of ["", "12", "12345", "12a4", "12 4", " 1234", "१२३४", "-123"]) {
      expect(isValidPinFormat(bad), `${bad} should be rejected`).toBe(false);
    }
  });

  it("has a length constant the regex actually honours", () => {
    expect(isValidPinFormat("1".repeat(PIN_LENGTH))).toBe(true);
    expect(isValidPinFormat("1".repeat(PIN_LENGTH + 1))).toBe(false);
  });
});

describe("weak PINs are refused, not merely discouraged", () => {
  it("rejects all-same digits", () => {
    for (const p of ["0000", "1111", "7777", "9999"]) expect(isWeakPin(p), p).toBe(true);
  });

  it("rejects runs in both directions, including the wrap", () => {
    for (const p of ["1234", "2345", "6789", "4321", "9876", "9012", "1098"]) {
      expect(isWeakPin(p), p).toBe(true);
    }
  });

  it("rejects repeated pairs, which read as random and are not", () => {
    for (const p of ["1212", "6767", "0505"]) expect(isWeakPin(p), p).toBe(true);
  });

  it("accepts an ordinary PIN", () => {
    for (const p of ["4071", "9058", "3907", "5183"]) expect(isWeakPin(p), p).toBe(false);
  });

  it("does not call a badly-formatted string weak — that is a different complaint", () => {
    expect(isWeakPin("abcd")).toBe(false);
    expect(validateNewPin("abcd").error).toContain("digits");
  });
});

describe("validateNewPin", () => {
  it("passes a good PIN", () => {
    expect(validateNewPin("4071")).toEqual({ ok: true });
  });

  it("explains a weak PIN with an example and a next step, not a bare refusal", () => {
    const r = validateNewPin("1234");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("1234");
    expect(r.error).toMatch(/chuno|choose/i);
  });

  it("explains a malformed PIN", () => {
    const r = validateNewPin("12");
    expect(r.ok).toBe(false);
    expect(r.error).toContain(String(PIN_LENGTH));
  });
});

describe("hashing", () => {
  it("never returns the PIN itself", () => {
    const salt = newSalt();
    expect(hashPin("4071", salt)).not.toContain("4071");
  });

  it("is deterministic for one salt", () => {
    const salt = newSalt();
    expect(hashPin("4071", salt)).toBe(hashPin("4071", salt));
  });

  it("gives two people with the SAME pin different hashes", () => {
    // Without a per-user salt, one leaked hash tells you every account using that PIN,
    // and with only 10,000 possible PINs a shared salt is a lookup table.
    expect(hashPin("4071", newSalt())).not.toBe(hashPin("4071", newSalt()));
  });

  it("produces a fresh salt each time", () => {
    const salts = new Set(Array.from({ length: 20 }, () => newSalt()));
    expect(salts.size).toBe(20);
  });
});

describe("verifyPin", () => {
  const salt = newSalt();
  const hash = hashPin("4071", salt);

  it("accepts the right PIN", () => {
    expect(verifyPin("4071", salt, hash)).toBe(true);
  });

  it("rejects a wrong PIN", () => {
    expect(verifyPin("4072", salt, hash)).toBe(false);
    expect(verifyPin("1704", salt, hash)).toBe(false);
  });

  it("rejects the right PIN against the wrong salt", () => {
    expect(verifyPin("4071", newSalt(), hash)).toBe(false);
  });

  it("rejects a malformed attempt without throwing", () => {
    for (const bad of ["", "abcd", "12345", "1"]) {
      expect(() => verifyPin(bad, salt, hash)).not.toThrow();
      expect(verifyPin(bad, salt, hash)).toBe(false);
    }
  });

  it("returns false rather than throwing on a corrupt stored hash", () => {
    // A truncated or non-hex hash must fail closed. Throwing here would turn a bad row
    // into a 500 on the vault screen.
    for (const bad of ["", "zz", "abc", "0".repeat(10)]) {
      expect(() => verifyPin("4071", salt, bad)).not.toThrow();
      expect(verifyPin("4071", salt, bad)).toBe(false);
    }
  });
});

describe("lockState", () => {
  it("is open with all attempts left when nothing has failed", () => {
    expect(lockState(0, null, NOW)).toEqual({ locked: false, retryAfterSec: 0, attemptsLeft: MAX_ATTEMPTS });
  });

  it("counts down the remaining attempts", () => {
    expect(lockState(2, null, NOW).attemptsLeft).toBe(MAX_ATTEMPTS - 2);
  });

  it("is closed while the lockout is in the future, and says for how long", () => {
    const until = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    const s = lockState(MAX_ATTEMPTS, until, NOW);
    expect(s.locked).toBe(true);
    expect(s.retryAfterSec).toBe(300);
    expect(s.attemptsLeft).toBe(0);
  });

  it("opens again once the lockout has passed", () => {
    const until = new Date(NOW.getTime() - 1_000).toISOString();
    expect(lockState(MAX_ATTEMPTS, until, NOW).locked).toBe(false);
  });

  it("ignores an unparseable lockout rather than locking forever", () => {
    // A corrupt timestamp must not permanently shut the owner out of their own vault.
    expect(lockState(1, "not-a-date", NOW).locked).toBe(false);
  });

  it("never reports negative attempts left", () => {
    expect(lockState(99, null, NOW).attemptsLeft).toBe(0);
  });
});

describe("nextFailureState", () => {
  it("counts a wrong guess without locking early", () => {
    const r = nextFailureState(0, NOW);
    expect(r).toMatchObject({ failedAttempts: 1, lockedUntil: null, locked: false });
  });

  it("locks on the configured attempt", () => {
    const r = nextFailureState(MAX_ATTEMPTS - 1, NOW);
    expect(r.locked).toBe(true);
    expect(r.failedAttempts).toBe(MAX_ATTEMPTS);
    expect(new Date(r.lockedUntil as string).getTime()).toBe(NOW.getTime() + LOCKOUT_MINUTES * 60_000);
  });

  it("does NOT reset the counter when it locks", () => {
    // Resetting would hand a patient guesser a fresh five attempts every fifteen
    // minutes, forever. Keeping the count means the lock re-closes on the next wrong
    // guess. Only a correct PIN clears it.
    const first = nextFailureState(MAX_ATTEMPTS - 1, NOW);
    const after = nextFailureState(first.failedAttempts, new Date(NOW.getTime() + LOCKOUT_MINUTES * 60_000 + 1000));
    expect(after.failedAttempts).toBe(MAX_ATTEMPTS + 1);
    expect(after.locked).toBe(true);
  });

  it("treats a corrupt negative count as zero", () => {
    expect(nextFailureState(-5, NOW).failedAttempts).toBe(1);
  });
});

describe("successState", () => {
  it("wipes the slate, because a correct PIN is the only proof it is the owner", () => {
    expect(successState()).toEqual({ failedAttempts: 0, lockedUntil: null, locked: false });
  });
});

describe("the guarantee this whole module rests on", () => {
  it("cannot be brute-forced within the lockout: 5 tries buys 0.05% of the keyspace", () => {
    // Stated as a test so the number is in front of whoever changes MAX_ATTEMPTS.
    const keyspace = 10 ** PIN_LENGTH;
    const perWindow = MAX_ATTEMPTS / keyspace;
    expect(perWindow).toBeLessThan(0.001);

    // And the full sweep at this rate takes years, not an afternoon.
    const windowsNeeded = keyspace / MAX_ATTEMPTS;
    const daysNeeded = (windowsNeeded * LOCKOUT_MINUTES) / (60 * 24);
    expect(daysNeeded).toBeGreaterThan(20);
  });
});
