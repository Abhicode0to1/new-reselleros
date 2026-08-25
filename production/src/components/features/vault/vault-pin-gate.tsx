/**
 * The PIN lock over the private vault.
 *
 * ─── IT SAYS WHAT IT IS ─────────────────────────────────────────────────────
 * The screen tells the owner, in plain words, that this is a lock on the screen and not
 * encryption. That sentence is the most important thing in this file. A person who
 * believes their net worth is encrypted behaves differently — they will leave it open on
 * a shared machine, or store something here they should not — and the gap between what
 * a 4-digit PIN can do and what people assume it does is exactly where that happens.
 *
 * ─── THE UNLOCK IS PER-TAB AND SHORT-LIVED ──────────────────────────────────
 * Held in component state, so it dies on reload and on a new tab, and expires by itself
 * after UNLOCK_TTL_MINUTES. Deliberately NOT in localStorage: the whole point is the
 * walk-away case, and an unlock that survives a reload survives the person walking away.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { usePinStatus, useVerifyPin } from "@/lib/queries/personal-vault";
import { PIN_LENGTH, UNLOCK_TTL_MINUTES } from "@/lib/vault/personal/pin-rules";

export function VaultPinGate({ children }: { children: React.ReactNode }) {
  const { data: status, isLoading } = usePinStatus();
  const verify = useVerifyPin();

  const [unlockedAt, setUnlockedAt] = React.useState<number | null>(null);
  const [pin, setPin] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Re-lock on its own. A tab left open all afternoon should not stay unlocked.
  const [, forceTick] = React.useState(0);
  React.useEffect(() => {
    if (unlockedAt === null) return;
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [unlockedAt]);

  const unlockExpired = unlockedAt !== null && Date.now() - unlockedAt > UNLOCK_TTL_MINUTES * 60_000;
  const unlocked = unlockedAt !== null && !unlockExpired;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await verify.mutateAsync(pin);
      setUnlockedAt(Date.now());
      setPin("");
    } catch (err) {
      setPin("");
      setError(err instanceof Error ? err.message : "PIN galat hai");
    }
  };

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto space-y-4">
        <Skeleton className="h-10 w-64 rounded" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  // No PIN configured — the vault is open. The PIN is optional by design; forcing one
  // on somebody who does not want it just gets a sticky note on the monitor.
  if (!status?.configured || unlocked) return <>{children}</>;

  const locked = status.locked;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[440px] mx-auto">
      <Card className="p-8">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-paper-2 border border-hairline">
            <Icon name="lock" size={26} className="text-ink-2" />
          </div>
          <h2 className="text-xl font-serif text-ink">Private Vault locked hai</h2>
          <p className="mt-1.5 text-sm text-ink-3">
            {unlockExpired ? "Kaafi der ho gayi — PIN dobara daalo." : `Apna ${PIN_LENGTH}-digit PIN daalo.`}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-3">
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            maxLength={PIN_LENGTH}
            disabled={locked || verify.isPending}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH))}
            aria-label="Vault PIN"
            className="w-full text-center text-3xl tracking-[0.6em] font-mono py-3 rounded-lg border border-hairline bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
          />

          {locked ? (
            <p className="text-xs text-rose text-center">
              Bahut galat koshishein. {Math.ceil(status.retryAfterSec / 60)} minute baad dobara try karo.
            </p>
          ) : error ? (
            <p className="text-xs text-rose text-center">{error}</p>
          ) : (
            <p className="text-xs text-ink-4 text-center">{status.attemptsLeft} koshish baaki</p>
          )}

          <Button
            type="submit"
            disabled={locked || pin.length !== PIN_LENGTH || verify.isPending}
            className="w-full bg-primary text-white font-bold"
          >
            {verify.isPending ? "Check kar rahe hain…" : "Unlock"}
          </Button>
        </form>

        {/* The sentence that matters. */}
        <p className="mt-5 pt-4 border-t border-hairline text-2xs leading-relaxed text-ink-4">
          Ye PIN <b>screen ka lock</b> hai — data encrypt nahi karta. Ye us sthiti ke liye hai jab
          aapka laptop khula chhoot jaye. Aapka data alag cheez se surakshit hai: database ka apna
          niyam, jo in rows ko sirf aapke login ko deta hai — PIN ho ya na ho.
        </p>
      </Card>
    </div>
  );
}
