import { currentCtx, runWithCtx, type Ctx } from "./ctx";
import { userDb } from "./db";
import { safeError } from "./scrub";
import { forgetToken, readSession, verifyToken } from "./session";

const MEMBERS = new Map<string, { until: number; rows: { workspace_id: string; role: "owner" | "member"; name: string }[] }>();
const MEMBER_TTL_MS = 10_000;

export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "outreach";
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/** Cookies identify the user, so every request that changes something must prove it came from this app's own page. */
export function csrfOk(req: Request): boolean { return SAFE.has(req.method) || req.headers.get(CSRF_HEADER) === CSRF_VALUE; }

/**
 * The public demo: visitors are signed in automatically as one special user who can only look.
 * Any change is refused, and pages that list people, keys or the audit trail are closed to it.
 */
export const isDemoUser = (userId: string) => Boolean(process.env.DEMO_USER_ID) && userId === process.env.DEMO_USER_ID;
const DEMO_CLOSED = [/^\/api\/members/, /^\/api\/audit/, /^\/api\/keys/];
export function demoBlocks(method: string, pathname: string): string | null {
  if (!SAFE.has(method)) return "This is a read-only demo. Sign in as an owner to make changes.";
  if (DEMO_CLOSED.some((re) => re.test(pathname))) return "Not available in the read-only demo.";
  return null;
}

export interface Membership { workspaceId: string; name: string; role: "owner" | "member" }

export async function membershipsFor(userId: string, token: string): Promise<Membership[]> {
  const hit = MEMBERS.get(userId);
  if (hit && hit.until > Date.now()) return hit.rows.map((r) => ({ workspaceId: r.workspace_id, name: r.name, role: r.role }));
  const res = await userDb(token).from("workspace_members").select("workspace_id, role, workspaces(name)").eq("user_id", userId);
  if (res.error) throw new Error("Could not load your workspaces.");
  const rows = (res.data as unknown as { workspace_id: string; role: "owner" | "member"; workspaces: { name: string } | { name: string }[] | null }[]).map((r) => ({
    workspace_id: r.workspace_id, role: r.role, name: (Array.isArray(r.workspaces) ? r.workspaces[0]?.name : r.workspaces?.name) ?? "Workspace",
  }));
  MEMBERS.set(userId, { until: Date.now() + MEMBER_TTL_MS, rows });
  return rows.map((r) => ({ workspaceId: r.workspace_id, name: r.name, role: r.role }));
}
export const forgetMemberships = (userId: string) => MEMBERS.delete(userId);

export async function authenticate(req: Request, opts: { owner?: boolean } = {}): Promise<Ctx | Response> {
  if (!csrfOk(req)) return Response.json({ error: "Request blocked: it did not come from this app." }, { status: 403 });
  const s = await readSession();
  if (!s.at) return Response.json({ error: "Sign in required.", code: "signin" }, { status: 401 });
  const user = await verifyToken(s.at);
  if (!user) { forgetToken(s.at); return Response.json({ error: "Your session expired.", code: "expired" }, { status: 401 }); }
  if (isDemoUser(user.id)) {
    const why = demoBlocks(req.method, new URL(req.url).pathname);
    if (why) return Response.json({ error: why, code: "demo" }, { status: 403 });
  }
  const ms = await membershipsFor(user.id, s.at);
  if (ms.length === 0) return Response.json({ error: "You are not a member of any workspace. Ask a workspace owner to add you.", code: "no_workspace" }, { status: 403 });
  const chosen = ms.find((m) => m.workspaceId === s.ws) ?? ms[0];
  if (opts.owner && chosen.role !== "owner") return Response.json({ error: "Only a workspace owner can do that." }, { status: 403 });
  return { userId: user.id, email: user.email, workspaceId: chosen.workspaceId, role: chosen.role, db: userDb(s.at), accessToken: s.at, isService: false };
}

/** Wraps a route handler: checks the session, workspace and CSRF header, then runs it inside that workspace's context. */
export async function withAuth(req: Request, fn: (ctx: Ctx) => Promise<Response>, opts: { owner?: boolean } = {}): Promise<Response> {
  try {
    const c = await authenticate(req, opts);
    if (c instanceof Response) return c;
    return await runWithCtx(c, () => fn(c));
  } catch (e) {
    return Response.json({ error: safeError(e) }, { status: 500 });
  }
}

export { currentCtx };
