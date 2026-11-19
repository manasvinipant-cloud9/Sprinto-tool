import { z } from "zod";
import { withAuth } from "@/lib/guard";
import { clearKey, listKeyStatus, setKey, WorkspaceError } from "@/lib/services/workspace";

export const dynamic = "force-dynamic";
const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: e instanceof WorkspaceError ? e.status : 500 });

/** Which keys are set, never their values. */
export async function GET(req: Request) {
  return withAuth(req, async () => { try { return Response.json(await listKeyStatus()); } catch (e) { return fail(e); } });
}

export async function PUT(req: Request) {
  return withAuth(req, async () => {
    const parsed = z.object({ name: z.string(), value: z.string() }).safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
    try { await setKey(parsed.data.name, parsed.data.value); return Response.json(await listKeyStatus()); } catch (e) { return fail(e); }
  }, { owner: true });
}

export async function DELETE(req: Request) {
  return withAuth(req, async () => {
    try { await clearKey(new URL(req.url).searchParams.get("name") ?? ""); return Response.json(await listKeyStatus()); } catch (e) { return fail(e); }
  }, { owner: true });
}
