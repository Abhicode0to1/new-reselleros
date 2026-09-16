/**
 * Keep credentials out of Sentry breadcrumbs.
 *
 * ─── THE LEAK, MEASURED ─────────────────────────────────────────────────────
 * Sentry's Node SDK instruments outgoing `fetch` below the application, at the
 * undici diagnostics-channel level, and records a breadcrumb per response. In
 * `getBreadcrumbData` (@sentry/node-core/build/cjs/utils/outgoingFetchRequest.js)
 * it sanitises the URL — and then puts the query string back, verbatim, in a
 * separate `http.query` field:
 *
 *     data.url = getSanitizedUrlString(parsedUrl);        // query stripped
 *     if (parsedUrl.search) data["http.query"] = parsedUrl.search;   // and restored
 *
 * That matters here because ResellerClub has no header auth — `authedUrl()` in
 * lib/resellerclub/index.ts puts `auth-userid` and `api-key` IN THE QUERY
 * STRING, and `call.ts` does the same for every write. Both modules refuse to
 * log the URL and say why in comments. This went around them: any exception
 * captured after a registrar call carried the live key to the Sentry project in
 * plaintext, readable by anyone with project access.
 *
 * Reproduced 16 Sep 2026 with the app's own init before this file existed:
 *
 *   data={"status_code":200,"url":"http://localhost:3000/api/version",
 *         "http.method":"GET","http.query":"?auth-userid=1299294&api-key=…"}
 *
 * ─── REDACT BY DEFAULT, NAME THE EXCEPTIONS ─────────────────────────────────
 * The obvious fix — delete `http.query` — also throws away the one thing an
 * engineer reading the breadcrumb actually wants: WHICH domain was being looked
 * up when it broke. So the rule is inverted instead: every value is redacted
 * unless its key is named below. An upstream that invents a new credential
 * parameter is covered without anybody remembering to add it, which is the
 * failure mode a deny-list has; the cost of the mistake in the other direction
 * is one less debugging hint.
 *
 * Applies to every init — server, edge, and browser. The browser never calls
 * ResellerClub, but a query-string credential is not a ResellerClub-only shape
 * and one rule in one file cannot drift between five copies.
 */

/** Query keys whose values are safe to read in an error report. */
const SAFE_QUERY_KEYS = new Set([
  /* ResellerClub asks in kebab-case. */
  "domain-name",
  "tlds",
  "order-id",
  "no-of-records",
  "page-no",
  /* Ours, and the ordinary shapes of a page or list request. */
  "domain",
  "name",
  "tld",
  "type",
  "format",
  "page",
  "limit",
  "offset",
  "status",
  "id",
]);

const REDACTED = "[redacted]";

/**
 * Rewrite a query string, keeping the shape and losing the secrets.
 *
 * Returns the search string with a leading "?" as Sentry stores it. Exported so
 * the behaviour can be tested without constructing a breadcrumb.
 */
export function redactQueryString(search: string): string {
  if (!search) return search;
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return search;
  const out = raw
    .split("&")
    .map((pair) => {
      if (!pair) return pair;
      const eq = pair.indexOf("=");
      /* A bare flag carries no value to leak. */
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      let decoded: string;
      try {
        decoded = decodeURIComponent(key).toLowerCase();
      } catch {
        /* Malformed percent-encoding — treat it as unknown, so: redact. */
        decoded = "";
      }
      return SAFE_QUERY_KEYS.has(decoded) ? pair : `${key}=${REDACTED}`;
    })
    .join("&");
  return `?${out}`;
}

/**
 * Sentry's `beforeBreadcrumb` hook. Pass it to every `Sentry.init`.
 *
 * Typed structurally rather than against Sentry's `Breadcrumb` so this module
 * can be imported from the browser bundle without dragging the Node types in.
 */
export function redactBreadcrumb<T extends { data?: Record<string, unknown> | undefined }>(
  breadcrumb: T,
): T {
  const query = breadcrumb?.data?.["http.query"];
  if (typeof query === "string" && query.length > 0) {
    breadcrumb.data!["http.query"] = redactQueryString(query);
  }
  return breadcrumb;
}
