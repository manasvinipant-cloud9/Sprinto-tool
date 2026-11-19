import { z } from "zod";
import { withAuth } from "@/lib/guard";
import { editDraft, ReviewError } from "@/lib/services/drafts";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;
const body = z.object({ subject: z.string().optional(), body: z.string().optional(), notes: z.string().optional(), reviewer: z.string().optional() });

/** Edits the current draft. Changing the wording sends it back to pending review. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params;
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!UUID.test(id) || !parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
    try { return Response.json({ draft: await editDraft(id, parsed.data) }); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: e instanceof ReviewError ? e.status : 500 }); }
  });
}
