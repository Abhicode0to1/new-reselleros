-- 0070_tenant_secrets_gemini.sql
--
-- Per-tenant Gemini (AI) credentials so the workspace owner can configure AI
-- from Settings → Integrations instead of a global Cloud Run env var.
--
-- Resolver precedence (src/lib/ai/gemini.ts): tenant_secrets.gemini_api_key
-- → process.env.GEMINI_API_KEY → stub fallback. Existing env-based behaviour
-- is preserved when a tenant hasn't set its own key.
--
-- tenant_secrets already has RLS (owner-only, migration 0035); the new columns
-- inherit that policy. Like the other secrets here, the raw key is never
-- returned to the client — the integration route surfaces only a masked
-- preview + a "configured" boolean.

alter table public.tenant_secrets
  add column if not exists gemini_api_key text,
  add column if not exists gemini_model  text;

comment on column public.tenant_secrets.gemini_api_key is
  'Per-tenant Google Gemini API key (server-only; never returned raw to the client).';
comment on column public.tenant_secrets.gemini_model is
  'Optional Gemini model override (default gemini-1.5-flash).';
