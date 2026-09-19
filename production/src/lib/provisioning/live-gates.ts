/**
 * The two switches that let this app spend real money, and how they are read.
 *
 * ─── WHAT CHANGED, AND WHO ASKED ────────────────────────────────────────────
 * Pardeep, 11 Sep 2026: "Keep those turned on by default until admin ask
 * otherwise." Until then `DOMAIN_REGISTER_LIVE` and `HOSTING_TRIAL_LIVE` were
 * opt-IN — absent meant off — and eight call sites each compared
 * `process.env.X === "1"` for themselves.
 *
 * So the default is now OPEN: unset, empty, or anything unrecognised means
 * ordering is allowed. Only an explicit, deliberate off value closes it.
 *
 * ─── THIS INVERTS A FAIL-SAFE, WHICH IS WORTH SAYING OUT LOUD ───────────────
 * The old default was safe by accident of absence: a fresh deployment, a missing
 * secret, a half-written env file, a container that lost its config — every one
 * of those produced "do not buy anything". Now every one of them produces "buy".
 *
 * That is the instruction and it is a reasonable one for a business that wants
 * to sell. It is written down here because the failure mode moved rather than
 * disappeared, and the person who reads this file next should know which way it
 * now falls.
 *
 * Two things still stand between a mistake and a charge, and neither is this
 * flag:
 *   1. CREDENTIALS. `rcOrderingEnabled()` and `hostingProvisioningEnabled()`
 *      require the upstream credentials as well as the gate. A deployment
 *      without ResellerClub keys cannot order however open this is.
 *   2. TESTS. See below — under test the old opt-in rule still applies.
 *
 * ─── UNDER TEST THE DEFAULT STAYS SHUT ──────────────────────────────────────
 * A unit test must not be able to buy a domain. Ever. If the open default
 * applied to the test environment then every one of the ~7,300 tests that
 * reaches a provisioning path would be one accidental credential away from a
 * real order, and the suite would be the least supervised place in the project.
 *
 * So in a test run the gate is CLOSED unless a test sets it ON explicitly. That
 * also keeps the existing suite honest in both directions: tests that assert the
 * refusal still get a refusal by saying nothing, and tests that exercise the
 * live path still get the live path by setting the flag, exactly as they do now.
 *
 * ─── AND WHY THE VALUES ARE PARSED, NOT COMPARED ────────────────────────────
 * `=== "1"` treated `DOMAIN_REGISTER_LIVE=true` as OFF, which is a silent,
 * wrong answer to a reasonable thing to type. Now that off is the exceptional
 * case, mis-typing it is the expensive direction: `DOMAIN_REGISTER_LIVE=disable`
 * must not read as "still on". So the off list is deliberately generous, and
 * anything outside BOTH lists is reported by `liveGateDiagnostic()` rather than
 * silently resolved.
 */
import "server-only";

/** Values that mean "off". Generous on purpose — see the header. */
const OFF = new Set(["0", "false", "no", "off", "disabled", "disable", "none"]);
/** Values that mean "on". Needed under test, where absence means off. */
const ON = new Set(["1", "true", "yes", "on", "enabled", "enable", "live"]);

export type LiveGateName = "DOMAIN_REGISTER_LIVE" | "HOSTING_TRIAL_LIVE";

/**
 * A test run, where absence means OFF.
 *
 * Read at call time rather than module load: vitest sets these before importing
 * the module under test, but a caller that stubs `process.env` mid-file would
 * otherwise be reading a decision frozen at import.
 */
function isTestRun(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true" || Boolean(process.env.VITEST_WORKER_ID);
}

function raw(name: LiveGateName): string {
  return (process.env[name] ?? "").trim().toLowerCase();
}

/**
 * Is this gate open?
 *
 * Permission only — NOT capability. Every caller must also require the upstream
 * credentials, which is why `rcOrderingEnabled()` and
 * `hostingProvisioningEnabled()` exist and why call sites should prefer them.
 */
export function liveGateOpen(name: LiveGateName): boolean {
  const value = raw(name);
  if (OFF.has(value)) return false;
  if (ON.has(value)) return true;
  /* Unset, empty, or unrecognised. Open in production and development — the
     instruction — and shut under test, which is the one place an accident is
     both likely and unsupervised. */
  return !isTestRun();
}

/** `DOMAIN_REGISTER_LIVE`. Permission to place real ResellerClub orders. */
export function domainOrderingAllowed(): boolean {
  return liveGateOpen("DOMAIN_REGISTER_LIVE");
}

/** `HOSTING_TRIAL_LIVE`. Permission to create real DirectAdmin accounts. */
export function hostingProvisioningAllowed(): boolean {
  return liveGateOpen("HOSTING_TRIAL_LIVE");
}

/**
 * How this gate got its answer, for the readiness screen and the logs.
 *
 * Exists because "ordering is off" is now an unusual state that somebody CHOSE,
 * and the old operator copy said "set DOMAIN_REGISTER_LIVE=1" — advice that is
 * actively wrong under the new default. A closed gate now means a person or a
 * deploy set it closed, and the screen has to say that instead of telling them
 * to switch on something that is already on by default.
 */
export function liveGateDiagnostic(name: LiveGateName): {
  open: boolean;
  /** True when the value was neither a known on nor a known off value. */
  unrecognised: boolean;
  /** One sentence naming why, safe to show an operator. Never the value. */
  because: string;
} {
  const value = raw(name);
  const testRun = isTestRun();

  if (OFF.has(value)) {
    return {
      open: false,
      unrecognised: false,
      because: `${name} is explicitly set to an off value, so ordering is switched off deliberately. Remove it, or set it to 1, to allow orders again.`,
    };
  }
  if (ON.has(value)) {
    return { open: true, unrecognised: false, because: `${name} is set on.` };
  }
  if (value.length > 0) {
    /* Neither list. Resolved as open outside tests, and said so — a typo in the
       off direction is the expensive one now. */
    return {
      open: !testRun,
      unrecognised: true,
      because: `${name} is set to a value this app does not recognise, so it was treated as ${testRun ? "off (test run)" : "ON"}. Use 1 or 0.`,
    };
  }
  return testRun
    ? { open: false, unrecognised: false, because: `${name} is unset and this is a test run, where ordering is never live.` }
    : { open: true, unrecognised: false, because: `${name} is unset, and ordering is allowed by default.` };
}
