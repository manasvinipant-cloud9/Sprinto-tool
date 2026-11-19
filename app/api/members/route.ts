import { z } from "zod";
import { withAuth } from "@/lib/guard";
import { addMember, listMembers, removeMember, WorkspaceError } from "@/lib/services/workspace";

export const dynamic = "force-dynamic";
const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: e instanceof WorkspaceError ? e.status : 500 });

export async function GET(req: Request) {
  return withAuth(req, async () => { try { return Response.json({ members: await listMembers() }); } catch (e) { return fail(e); } });
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    const parsed = z.object({ email: z.string().max(200) }).safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Enter an email address." }, { status: 400 });
    try { return Response.json({ member: await addMember(parsed.data.email) }); } catch (e) { return fail(e); }
  }, { owner: true });
}

export async function DELETE(req: Request) {
  return withAuth(req, async () => {
    const id = new URL(req.url).searchParams.get("user") ?? "";
    if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "Invalid member." }, { status: 400 });
    try { await removeMember(id); return Response.json({ ok: true }); } catch (e) { return fail(e); }
  }, { owner: true });
}
