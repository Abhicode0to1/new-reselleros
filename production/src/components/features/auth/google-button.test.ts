import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (p: string) => readFileSync(join(process.cwd(), "src", p), "utf8");

describe("Google sign-in / sign-up (R-102)", () => {
  it("signup offers Google, through the same button login uses", () => {
    expect(src("app/(auth)/signup/page.tsx")).toMatch(/<GoogleAuthButton label="Sign up with Google"/);
    expect(src("app/(auth)/login/page.tsx")).toMatch(/<GoogleAuthButton label="Sign in with Google"/);
  });

  it("no page calls signInWithOAuth on its own — one path, with the R-098 'is Google on?' check", () => {
    for (const p of ["app/(auth)/signup/page.tsx", "app/(auth)/login/page.tsx"]) {
      expect(src(p)).not.toMatch(/signInWithOAuth/);
    }
    const btn = src("components/features/auth/google-button.tsx");
    expect(btn).toMatch(/isOAuthProviderEnabled/);
    expect(btn).toMatch(/\/callback\?next=/);
  });
});
