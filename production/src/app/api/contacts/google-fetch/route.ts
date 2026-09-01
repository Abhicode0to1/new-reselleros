/**
 * GET /api/contacts/google-fetch
 *
 * Fetches contacts from the signed-in user's Google account via the People API.
 * Uses the provider_token from the Supabase OAuth session.
 *
 * Setup required:
 *   1. Supabase Dashboard → Auth → Providers → Google → enable + add scope:
 *      https://www.googleapis.com/auth/contacts.readonly
 *   2. Google Cloud Console → OAuth consent screen → include same scope
 *
 * If the user hasn't granted the contacts scope yet, returns 403 with
 * `code: 'needs_reauth'` so the UI can trigger a re-auth flow with the
 * additional scope.
 *
 * Returns: { contacts: ParsedContact[], totalConnections, mode }
 */

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PeopleApiPerson {
  resourceName?:   string;
  names?:          Array<{ displayName?: string; givenName?: string; familyName?: string }>;
  emailAddresses?: Array<{ value?: string; type?: string }>;
  phoneNumbers?:   Array<{ value?: string; type?: string }>;
  organizations?:  Array<{ name?: string; title?: string }>;
  biographies?:    Array<{ value?: string }>;
}

interface PeopleApiResponse {
  connections?:        PeopleApiPerson[];
  totalPeople?:        number;
  nextPageToken?:      string;
  nextSyncToken?:      string;
}

export interface FetchedContact {
  resourceName: string;
  fullName:     string;
  email:        string | null;
  phone:        string | null;
  company:      string | null;
  title:        string | null;
  notes:        string | null;
}

function normalizePerson(p: PeopleApiPerson): FetchedContact | null {
  const name = p.names?.[0]?.displayName
    || [p.names?.[0]?.givenName, p.names?.[0]?.familyName].filter(Boolean).join(" ").trim()
    || p.emailAddresses?.[0]?.value?.split("@")[0].replace(/[._-]+/g, " ");
  if (!name) return null;
  return {
    resourceName: p.resourceName ?? "",
    fullName:     name,
    email:        p.emailAddresses?.[0]?.value?.toLowerCase() ?? null,
    phone:        p.phoneNumbers?.[0]?.value ?? null,
    company:      p.organizations?.[0]?.name ?? null,
    title:        p.organizations?.[0]?.title ?? null,
    notes:        p.biographies?.[0]?.value ?? null,
  };
}

export async function GET() {
  const supabase = createClient();
  /* Pehchan getUser() se — wo JWT ko SERVER par verify karta hai; getSession()
     cookie par bharosa karta hai (middleware.ts:47 isi wajah se getUser hai —
     audit C8 ne yahan do chhoote hue pakde). provider_token phir bhi session
     se hi milta hai, isliye dono call hain: getUser = darwaza, getSession =
     Google ka token. */
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { data: { session } } = await supabase.auth.getSession();

  const accessToken = session?.provider_token;
  if (!accessToken) {
    return NextResponse.json(
      {
        error: "Google access token unavailable — connect Google Contacts first",
        code:  "needs_reauth",
      },
      { status: 403 },
    );
  }

  // ── Paginated fetch from People API ─────────────────────────────
  const all: FetchedContact[] = [];
  let pageToken: string | undefined;
  let totalConnections = 0;

  try {
    do {
      const url = new URL("https://people.googleapis.com/v1/people/me/connections");
      url.searchParams.set("personFields", "names,emailAddresses,phoneNumbers,organizations,biographies");
      url.searchParams.set("pageSize", "200");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const res = await fetch(url.toString(), {
        headers: { authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 401 || res.status === 403) {
        const txt = await res.text().catch(() => "");
        // Token expired or scope missing
        return NextResponse.json(
          {
            error: "Google rejected the token. Re-connect to grant the contacts scope.",
            code:  "needs_reauth",
            detail: txt.slice(0, 300),
          },
          { status: 403 },
        );
      }
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        return NextResponse.json(
          { error: `Google API error: ${res.status}`, detail: txt.slice(0, 300) },
          { status: 502 },
        );
      }

      const data = (await res.json()) as PeopleApiResponse;
      totalConnections = data.totalPeople ?? totalConnections;
      for (const conn of data.connections ?? []) {
        const norm = normalizePerson(conn);
        if (norm) all.push(norm);
      }
      pageToken = data.nextPageToken;
      // safety: cap at 5000 to prevent runaway loops on huge contact lists
      if (all.length >= 5000) break;
    } while (pageToken);

    return NextResponse.json({
      contacts:         all,
      totalConnections: totalConnections || all.length,
      mode:             "live",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "fetch failed" },
      { status: 500 },
    );
  }
}
