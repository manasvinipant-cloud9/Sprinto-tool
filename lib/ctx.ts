import { AsyncLocalStorage } from "node:async_hooks";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Who is acting, in which workspace, and the database client that acts for them. */
export interface Ctx {
  userId: string | null;      // null only for the local worker and admin scripts
  email: string;              // shown in audit trails
  workspaceId: string;
  role: "owner" | "member";
  db: SupabaseClient;         // signed-in users get a client that Postgres row-level security applies to
  accessToken: string | null;
  isService: boolean;
  /** True for the public read-only demo user, whose view hides real people's email addresses. */
  demo?: boolean;
}

const store = new AsyncLocalStorage<Ctx>();

export function runWithCtx<T>(ctx: Ctx, fn: () => Promise<T>): Promise<T> { return store.run(ctx, fn); }
/** For scripts and tests that make many service calls in a row. */
export function enterCtx(ctx: Ctx): void { store.enterWith(ctx); }

export function currentCtx(): Ctx {
  const c = store.getStore();
  if (!c) throw new Error("No workspace context. Service code must run inside a signed-in request or an explicit service context.");
  return c;
}
export const currentWorkspaceId = () => currentCtx().workspaceId;
export const tryCtx = () => store.getStore() ?? null;
