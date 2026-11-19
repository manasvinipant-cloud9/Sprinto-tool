import { currentCtx } from "./ctx";
import { scrub, safeError } from "./scrub";

export interface AuditEvent { id: number; created_at: string; actor: string; user_id: string | null; action: string; entity_type: string | null; entity_id: string | null; detail: Record<string, unknown> }

/** Clean a detail object: strings are scrubbed and long values cut, so the trail never becomes a place secrets land. */
function clean(d: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === "string" ? scrub(v).slice(0, 300) : typeof v === "number" || typeof v === "boolean" || v === null ? v : Array.isArray(v) ? v.slice(0, 20).map((x) => (typeof x === "string" ? scrub(x).slice(0, 120) : x)) : undefined]).filter(([, v]) => v !== undefined));
}

/** Records who did what, in which workspace. Best effort: a failed audit write is logged but does not undo the action. */
export async function audit(action: string, entity?: { type: string; id?: string }, detail: Record<string, unknown> = {}): Promise<void> {
  const c = currentCtx();
  const res = await c.db.from("audit_log").insert({ workspace_id: c.workspaceId, user_id: c.userId, actor: c.email, action, entity_type: entity?.type ?? null, entity_id: entity?.id ?? null, detail: clean(detail) });
  if (res.error) console.error("audit write failed:", safeError(res.error.message));
}

export async function listAudit(limit = 100, before?: number): Promise<AuditEvent[]> {
  const c = currentCtx();
  let q = c.db.from("audit_log").select("id, created_at, actor, user_id, action, entity_type, entity_id, detail").eq("workspace_id", c.workspaceId).order("id", { ascending: false }).limit(Math.min(limit, 200));
  if (before) q = q.lt("id", before);
  const res = await q;
  if (res.error) throw new Error("Could not load the audit trail.");
  return res.data as AuditEvent[];
}
