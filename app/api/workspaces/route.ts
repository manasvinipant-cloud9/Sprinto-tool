import { z } from "zod";
import { withAuth } from "@/lib/guard";
import { setWorkspaceCookie } from "@/lib/session";
import { createWorkspaceForUser, renameWorkspace, WorkspaceError } from "@/lib/services/workspace";

export const dynamic = "force-dynamic";
const body = z.object({ name: z.string().min(1).max(80) });

/** Creates a new workspace (for example a new client) and switches to it. Only an existing owner can. */
export async function POST(req: Request) {
  return withAuth(req, async () => {
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "A workspace name must be 1 to 80 characters." }, { status: 400 });
    try { const w = await createWorkspaceForUser(parsed.data.name); await setWorkspaceCookie(w.id); return Response.json({ workspace: w }); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: e instanceof WorkspaceError ? e.status : 500 }); }
  });
}

export async function PATCH(req: Request) {
  return withAuth(req, async () => {
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "A workspace name must be 1 to 80 characters." }, { status: 400 });
    try { await renameWorkspace(parsed.data.name); return Response.json({ ok: true }); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: e instanceof WorkspaceError ? e.status : 500 }); }
  }, { owner: true });
}
