/** Types for e2e-roles.mjs (tsconfig has allowJs: false). Keep in sync with the .mjs. */
export type E2ERole = "owner" | "manager" | "sales" | "accountant";

export declare const E2E_TENANT_NAME: string;
export declare const E2E_TENANT_EMAIL: string;
export declare const E2E_CUSTOMER_NAME: string;
export declare const E2E_BANK_NAME: string;
export declare const E2E_VENDOR_NAME: string;
export declare const E2E_VENDOR_GSTIN: string;
export declare const E2E_ROLES: readonly E2ERole[];

type Env = Record<string, string | undefined>;

export declare function roleEnvNames(role: E2ERole): { email: string; password: string };
export declare function roleCreds(
  role: E2ERole,
  env?: Env,
): { role: E2ERole; email: string; password: string | undefined };
export declare function missingEnvFor(roles: readonly E2ERole[], env?: Env): string[];
export declare function productionHostReason(urlOrHost: string | undefined | null): string | null;
