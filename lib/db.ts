import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { currentCtx, type Ctx } from "./ctx";

let service: SupabaseClient | null = null;

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Database is not configured (${name} missing).`);
  return v;
}

/** Privileged client that bypasses row-level security. Server-only. Use for admin tooling, never to answer a user's request. */
export function serviceDb(): SupabaseClient {
  return (service ??= createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } }));
}

/** A client that carries the signed-in user's token, so Postgres applies row-level security to every query. */
export function userDb(accessToken: string): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_PUBLISHABLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** The current request's client. Throws outside a workspace context so a forgotten context can never fall back to the service role. */
export function db(): SupabaseClient { return currentCtx().db; }

export function serviceCtx(workspaceId: string, label = "worker"): Ctx {
  return { userId: null, email: label, workspaceId, role: "owner", db: serviceDb(), accessToken: null, isService: true };
}

export function must<T = { id: string }>(res: { data: unknown; error: { message: string } | null }, what: string): T {
  if (res.error || res.data === null || res.data === undefined) throw new Error(`${what} failed: ${res.error?.message ?? "no data"}`);
  return res.data as T;
}
