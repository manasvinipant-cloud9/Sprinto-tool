import { z } from "zod";
import { csrfOk, membershipsFor } from "@/lib/guard";
import { readSession, setWorkspaceCookie, verifyToken } from "@/lib/session";

export const dynamic = "force-dynamic";
const body = z.object({ id: z.string().uuid() });

/** Switches the active workspace. The choice is checked against the user's memberships on every request, not trusted from the cookie. */
export async function POST(req: Request) {
  if (!csrfOk(req)) return Response.json({ error: "Request blocked." }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  const s = await readSession();
  const user = s.at ? await verifyToken(s.at) : null;
  if (!parsed.success || !s.at || !user) return Response.json({ error: "Sign in required." }, { status: 401 });
  const ms = await membershipsFor(user.id, s.at);
  const m = ms.find((x) => x.workspaceId === parsed.data.id);
  if (!m) return Response.json({ error: "You are not a member of that workspace." }, { status: 403 });
  await setWorkspaceCookie(m.workspaceId);
  return Response.json({ current: { id: m.workspaceId, name: m.name, role: m.role } });
}
