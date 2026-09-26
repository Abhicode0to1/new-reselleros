/**
 * Is this PDF password-protected?
 *
 * Bank e-statements (HDFC's among them) are usually encrypted with the customer's
 * password. The AI reader cannot open them — Gemini answers a bare 400 "invalid
 * argument" — and the operator used to see only "Couldn't read this statement".
 * An encrypted PDF declares it in its trailer with an /Encrypt entry, so the file can
 * be checked in the browser before it is sent anywhere, and the message can say what
 * to do instead.
 */
export function isEncryptedPdf(bytes: Uint8Array): boolean {
  // Latin-1 keeps every byte as one char, so a binary PDF decodes without loss.
  const text = new TextDecoder("latin1").decode(bytes);
  return /\/Encrypt\s*\d+\s+\d+\s+R|\/Encrypt\s*<</.test(text);
}
