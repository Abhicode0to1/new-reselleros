/**
 * POST /api/leads/finder/contacts — { ids?: string[], force?: boolean }
 * Read published email/phone from the candidates' own websites. Without ids: the 25
 * best-scored candidates that were never checked (older runs predate this step).
 */
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/server";
import { enrichCandidateContacts } from "@/lib/leads/lead-finder.server";
import { withRoute } from "@/lib/api/with-route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
  ids: z.array(z.string().uuid()).max(50).optional(),
  force: z.boolean().optional(),
});

export const POST = withRoute(
  { route: "api/leads/finder/contacts", input: schema, roles: ["owner", "manager"] },
  async ({ input, tenantId }) => enrichCandidateContacts(createAdminClient(), tenantId, { ids: input.ids, force: input.force }),
);
