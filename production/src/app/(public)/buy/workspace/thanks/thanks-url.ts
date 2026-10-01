/**
 * The address the buy page sends a paying customer to. It carries the quote's secret
 * `public_token` as `t`, because the thanks page shows order details only with it (S11,
 * 29 Sep 2026): quote numbers are sequential, so the number alone must not be enough.
 */
export function thanksUrl(quoteId: string | undefined, publicToken: string | undefined, simulated: boolean): string {
  const q = new URLSearchParams();
  q.set("order", quoteId ?? "");
  if (publicToken) q.set("t", publicToken);
  if (simulated) q.set("sim", "1");
  return `/buy/workspace/thanks?${q.toString()}`;
}
