/**
 * A key identifying ONE submit intent, so the server can tell a retry from a second
 * request (R-060).
 *
 * `crypto.randomUUID()` needs a secure context. localhost and https both qualify, so in
 * practice it is always there — but a page opened over plain http on a LAN address
 * (`http://192.168.x.x:3000`, which is how this app gets demoed on a phone) has
 * `crypto.randomUUID === undefined`, and the throw would surface as "Network error" on a
 * button that never sent anything. The fallback is not cryptography: the key only has to
 * be unique among one operator's own submissions, and it is scoped per tenant in the
 * database on top of that.
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}
