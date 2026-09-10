/**
 * Can this deployment actually deliver a domain or a hosting account?
 *
 * ─── THE QUESTION THIS ANSWERS, AND WHY IT NEEDED ANSWERING ─────────────────
 * `razorpay-readiness.ts` exists because "can take money, cannot hear about it"
 * is a state nobody would choose and which nothing announced. The provisioning
 * side has the same problem with more moving parts — ResellerClub credentials, a
 * separate money gate, DirectAdmin credentials, its own gate — and until now the
 * only way to find out was to sell a domain and wait.
 *
 * ─── THE STATE THAT LOSES MONEY, SAID PLAINLY ────────────────────────────────
 * With the gate shut, a paid domain order does NOT fail. `decideProvisioning`
 * QUEUES it with `engine_not_connected`. So the customer is charged, the order
 * sits in a list, and nothing registers anything until somebody notices. Nothing
 * errors. That is the shape of every expensive bug in this codebase's history,
 * and it is the state this deployment is in right now.
 *
 * ─── WHY IT TAKES `canCollect` ───────────────────────────────────────────────
 * Provisioning being unready is only benign if no money can be taken. Razorpay's
 * own readiness calls its unconfigured state harmless for exactly that reason —
 * "nothing is at risk". Here the two are independent: Razorpay can be live while
 * ResellerClub is not, and that combination is the one that charges a customer
 * for a domain nobody will register. So the severity is a function of BOTH, and a
 * verdict computed from provisioning alone would be reassuring and wrong.
 *
 * Pure, and takes plain booleans rather than reading `process.env` itself, so
 * every combination can be tested — which matters because the combination that
 * costs money is not the one anybody sets on purpose.
 */

export type ProvisioningPath = "domain" | "hosting";

export type ProvisioningState =
  /** No upstream credentials. Nothing can be delivered. */
  | "not_configured"
  /** Credentials present, the money gate shut. One env var from working. */
  | "gate_shut"
  /** Credentials and gate both present. Orders complete by themselves. */
  | "ready";

export interface PathReadiness {
  path: ProvisioningPath;
  state: ProvisioningState;
  /** Reads work — availability, pricing, package specs, usage. */
  canRead: boolean;
  /** An order placed today will actually be delivered without a person. */
  canProvision: boolean;
  /**
   * `critical` ONLY when money can be taken for something that will not be
   * delivered. Everything else is information — a deployment that cannot charge
   * anyone is not in danger, however little of it is configured.
   */
  severity: "none" | "info" | "critical";
  /** One line, plain language. */
  headline: string;
  /** What will actually happen, and the exact next step. Null when ready. */
  detail: string | null;
}

export interface ProvisioningEnv {
  /** `rcWriteConfigured()` — ResellerClub id + key present. */
  rcConfigured: boolean;
  /** `DOMAIN_REGISTER_LIVE === "1"`. */
  domainRegisterLive: boolean;
  /** `daWriteConfigured()` — DirectAdmin url + admin user + key present. */
  daConfigured: boolean;
  /** `HOSTING_TRIAL_LIVE === "1"`. */
  hostingTrialLive: boolean;
  /**
   * From `razorpayReadiness().canCollect`. Whether a customer can be charged at
   * all — see the header on why this changes the severity rather than the state.
   */
  canCollect: boolean;
}

const UPSTREAM: Record<ProvisioningPath, string> = {
  domain: "ResellerClub",
  hosting: "DirectAdmin",
};

const FLAG: Record<ProvisioningPath, string> = {
  domain: "DOMAIN_REGISTER_LIVE=1",
  hosting: "HOSTING_TRIAL_LIVE=1",
};

const THING: Record<ProvisioningPath, string> = {
  domain: "domain",
  hosting: "hosting account",
};

function judge(
  path: ProvisioningPath,
  configured: boolean,
  gateOpen: boolean,
  canCollect: boolean,
): PathReadiness {
  const upstream = UPSTREAM[path];
  const thing = THING[path];

  if (configured && gateOpen) {
    return {
      path,
      state: "ready",
      canRead: true,
      canProvision: true,
      severity: "none",
      headline: `${upstream} is connected and ordering is on.`,
      detail: null,
    };
  }

  /* The shared consequence of both unready states, and the thing worth saying
     first: the order is not refused, it is QUEUED. */
  const queued =
    `A paid ${thing} order will NOT fail — it queues, and nothing is delivered until ` +
    `somebody drains it by hand.`;

  if (configured && !gateOpen) {
    return {
      path,
      state: "gate_shut",
      /* Reads use the same credentials and no gate, so availability and pricing
         work in this state — which is exactly why it looks fine. */
      canRead: true,
      canProvision: false,
      severity: canCollect ? "critical" : "info",
      headline: canCollect
        ? `You can sell ${thing}s and none of them will be delivered.`
        : `${upstream} is connected, but ordering is switched off.`,
      detail:
        `${upstream}'s credentials are present, so searches and prices work — but ordering is off. ` +
        `${queued} Set ${FLAG[path]} on the service to turn it on.` +
        (canCollect
          ? ` Razorpay CAN currently charge a customer, which is what makes this urgent rather than just incomplete.`
          : ` Nothing can be charged in this deployment yet, so nobody is at risk today.`),
    };
  }

  return {
    path,
    state: "not_configured",
    canRead: false,
    canProvision: false,
    severity: canCollect ? "critical" : "info",
    headline: canCollect
      ? `You can sell ${thing}s and ${upstream} is not connected at all.`
      : `${upstream} is not connected.`,
    detail:
      `No ${upstream} credentials in this environment, so nothing can be looked up or ordered. ` +
      `${queued} Add the credentials and set ${FLAG[path]}.` +
      (canCollect
        ? ` Razorpay CAN currently charge a customer, so a sale today takes money for something nobody will deliver.`
        : ` Nothing can be charged in this deployment yet, so nobody is at risk today.`),
  };
}

export function provisioningReadiness(env: ProvisioningEnv): {
  domain: PathReadiness;
  hosting: PathReadiness;
} {
  return {
    domain: judge("domain", env.rcConfigured, env.domainRegisterLive, env.canCollect),
    hosting: judge("hosting", env.daConfigured, env.hostingTrialLive, env.canCollect),
  };
}

/**
 * The one line for a dashboard, when only one line fits.
 *
 * Reports the WORST of the two, because a deployment that delivers domains but
 * not hosting is not half-ready to somebody who just bought hosting.
 */
export function worstProvisioning(r: { domain: PathReadiness; hosting: PathReadiness }): PathReadiness {
  const rank: Record<PathReadiness["severity"], number> = { critical: 2, info: 1, none: 0 };
  return rank[r.hosting.severity] > rank[r.domain.severity] ? r.hosting : r.domain;
}
