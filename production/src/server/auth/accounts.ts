/**
 * Accounts — the rows GoTrue kept in auth.users, now read and written by the app itself.
 *
 * Same table, same columns, same bcrypt hashes: every existing password keeps working, and
 * because GoTrue's own format is preserved, switching AUTH_PROVIDER back to gotrue loses
 * nothing. Returned objects have the shape of a supabase-js `User`, so the ~190 call sites
 * that read `user.id`, `user.email`, `user.user_metadata` need no change.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { withAuthStore } from "@/server/db/auth-store";

export interface AuthUser {
  id: string;
  aud: "authenticated";
  role: "authenticated";
  email: string;
  email_confirmed_at: string | null;
  confirmed_at: string | null;
  phone: string;
  last_sign_in_at: string | null;
  created_at: string;
  updated_at: string;
  app_metadata: Record<string, unknown>;
  user_metadata: Record<string, unknown>;
  identities: unknown[];
  is_anonymous: false;
  banned_until?: string | null;
}

interface Row {
  id: string;
  email: string | null;
  encrypted_password: string | null;
  email_confirmed_at: Date | null;
  last_sign_in_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  raw_app_meta_data: Record<string, unknown> | null;
  raw_user_meta_data: Record<string, unknown> | null;
  banned_until: Date | null;
}

const COLS = `id::text as id, email, encrypted_password, email_confirmed_at, last_sign_in_at, created_at, updated_at,
              raw_app_meta_data, raw_user_meta_data, banned_until`;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const GOTRUE_INSTANCE = "00000000-0000-0000-0000-000000000000";
const BCRYPT_COST = 10; // GoTrue's default

function toUser(r: Row): AuthUser {
  return {
    id: r.id,
    aud: "authenticated",
    role: "authenticated",
    email: r.email ?? "",
    email_confirmed_at: iso(r.email_confirmed_at),
    confirmed_at: iso(r.email_confirmed_at),
    phone: "",
    last_sign_in_at: iso(r.last_sign_in_at),
    created_at: iso(r.created_at) ?? new Date(0).toISOString(),
    updated_at: iso(r.updated_at) ?? new Date(0).toISOString(),
    app_metadata: r.raw_app_meta_data ?? { provider: "email", providers: ["email"] },
    user_metadata: r.raw_user_meta_data ?? {},
    identities: [],
    is_anonymous: false,
    banned_until: iso(r.banned_until),
  };
}

export const normalise = (email: string) => email.trim().toLowerCase();

export async function getUserById(id: string): Promise<AuthUser | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<Row[]>(`select ${COLS} from auth.users where id = $1::uuid`, id));
  return rows[0] ? toUser(rows[0]) : null;
}

export async function getUserByEmail(email: string): Promise<AuthUser | null> {
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<Row[]>(
    `select ${COLS} from auth.users where lower(email) = $1 order by created_at limit 1`, normalise(email)));
  return rows[0] ? toUser(rows[0]) : null;
}

export async function listUsers(page = 1, perPage = 50): Promise<{ users: AuthUser[]; total: number }> {
  return withAuthStore(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Row[]>(`select ${COLS} from auth.users order by created_at desc limit $1 offset $2`,
      Math.min(Math.max(perPage, 1), 1000), Math.max(page - 1, 0) * perPage);
    const t = await tx.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int as n from auth.users`);
    return { users: rows.map(toUser), total: Number(t[0]?.n ?? 0) };
  });
}

const isBanned = (u: AuthUser) => Boolean(u.banned_until && new Date(u.banned_until).getTime() > Date.now());

export type PasswordCheck =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: "invalid_credentials" | "email_not_confirmed" | "banned" };

// A real bcrypt hash of a random string: comparing against it costs the same as a real check,
// so "no such account" and "wrong password" take the same time.
let dummyHash: string | undefined;
const dummy = () => (dummyHash ??= bcrypt.hashSync(randomUUID(), BCRYPT_COST));

export async function checkPassword(email: string, password: string): Promise<PasswordCheck> {
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<Row[]>(
    `select ${COLS} from auth.users where lower(email) = $1 and deleted_at is null order by created_at limit 1`, normalise(email)));
  const row = rows[0];
  const hash = row?.encrypted_password || dummy();
  const match = await bcrypt.compare(password, hash.replace(/^\$2y\$/, "$2b$"));
  if (!row || !row.encrypted_password || !match) return { ok: false, reason: "invalid_credentials" };
  const user = toUser(row);
  if (isBanned(user)) return { ok: false, reason: "banned" };
  if (!user.email_confirmed_at) return { ok: false, reason: "email_not_confirmed" };
  return { ok: true, user };
}

export async function recordSignIn(id: string): Promise<void> {
  await withAuthStore((tx) => tx.$executeRawUnsafe(`update auth.users set last_sign_in_at = now() where id = $1::uuid`, id));
}

export interface CreateUserInput {
  email: string;
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
}

export async function createUser(input: CreateUserInput): Promise<AuthUser> {
  const email = normalise(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError("Unable to validate email address: invalid format", "email_address_invalid", 400);
  const hash = input.password ? await bcrypt.hash(input.password, BCRYPT_COST) : null;
  return withAuthStore(async (tx) => {
    const existing = await tx.$queryRawUnsafe<{ id: string }[]>(`select id::text as id from auth.users where lower(email) = $1 limit 1`, email);
    if (existing.length) throw new AuthError("A user with this email address has already been registered", "email_exists", 422);
    const provider = (input.app_metadata?.provider as string | undefined) ?? "email";
    const rows = await tx.$queryRawUnsafe<Row[]>(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                               raw_app_meta_data, raw_user_meta_data, created_at, updated_at, is_sso_user, is_anonymous)
       values ($1::uuid, $2::uuid, 'authenticated', 'authenticated', $3, $4, $5::timestamptz, $6::jsonb, $7::jsonb, now(), now(), false, false)
       returning ${COLS}`,
      GOTRUE_INSTANCE, randomUUID(), email, hash, input.email_confirm ? new Date().toISOString() : null,
      JSON.stringify({ provider, providers: [provider], ...(input.app_metadata ?? {}) }),
      JSON.stringify(input.user_metadata ?? {}),
    );
    return toUser(rows[0]);
  });
}

export interface UpdateUserInput {
  email?: string;
  password?: string;
  email_confirm?: boolean;
  user_metadata?: Record<string, unknown>;
  app_metadata?: Record<string, unknown>;
  /** GoTrue style: "none" to unban, or "<hours>h" e.g. "876000h". */
  ban_duration?: string;
}

export async function updateUser(id: string, input: UpdateUserInput): Promise<AuthUser> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [id];
  const add = (sql: string, v: unknown) => { params.push(v); sets.push(sql.replace("?", `$${params.length}`)); };
  if (input.email !== undefined) add("email = ?", normalise(input.email));
  if (input.password !== undefined) add("encrypted_password = ?", await bcrypt.hash(input.password, BCRYPT_COST));
  if (input.email_confirm === true) sets.push("email_confirmed_at = coalesce(email_confirmed_at, now())");
  if (input.email_confirm === false) sets.push("email_confirmed_at = null");
  if (input.user_metadata) add("raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || ?::jsonb", JSON.stringify(input.user_metadata));
  if (input.app_metadata) add("raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || ?::jsonb", JSON.stringify(input.app_metadata));
  if (input.ban_duration !== undefined) {
    if (input.ban_duration === "none") sets.push("banned_until = null");
    else {
      const hours = /^(\d+)h$/.exec(input.ban_duration)?.[1];
      if (!hours) throw new AuthError("ban_duration must be 'none' or '<hours>h'", "validation_failed", 400);
      add("banned_until = now() + (? || ' hours')::interval", hours);
    }
  }
  const rows = await withAuthStore((tx) => tx.$queryRawUnsafe<Row[]>(
    `update auth.users set ${sets.join(", ")} where id = $1::uuid returning ${COLS}`, ...params));
  if (!rows[0]) throw new AuthError("User not found", "user_not_found", 404);
  return toUser(rows[0]);
}

export async function deleteUser(id: string): Promise<void> {
  await withAuthStore((tx) => tx.$executeRawUnsafe(`delete from auth.users where id = $1::uuid`, id));
}

/** Google (or another OAuth provider) proved this address: find the account, or create a confirmed one. */
export async function ensureOAuthUser(email: string, name: string | null, provider: string): Promise<AuthUser | null> {
  const found = await getUserByEmail(email);
  if (found) {
    if (isBanned(found)) return null;
    if (!found.email_confirmed_at) return updateUser(found.id, { email_confirm: true });
    return found;
  }
  return createUser({
    email, email_confirm: true,
    user_metadata: name ? { full_name: name, name } : {},
    app_metadata: { provider },
  });
}

export class AuthError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "AuthApiError";
  }
}
