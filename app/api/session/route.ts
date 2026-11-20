import { isDemoUser, membershipsFor } from "@/lib/guard";
import { readSession, verifyToken } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Who is signed in and which workspaces they belong to. Safe to call before a workspace is chosen. */
export async function GET() {
  const s = await readSession();
  if (!s.at) return Response.json({ error: "Sign in required.", code: "signin" }, { status: 401 });
  const user = await verifyToken(s.at);
  if (!user) return Response.json({ error: "Your session expired.", code: "expired" }, { status: 401 });
  const ms = await membershipsFor(user.id, s.at);
  const current = ms.find((m) => m.workspaceId === s.ws) ?? ms[0] ?? null;
  return Response.json({ user: isDemoUser(user.id) ? { ...user, email: "Demo visitor" } : user, demo: isDemoUser(user.id), workspaces: ms, current: current ? { id: current.workspaceId, name: current.name, role: current.role } : null });
}
