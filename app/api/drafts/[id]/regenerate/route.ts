import { z } from "zod";
import { withAuth } from "@/lib/guard";
import { regenerateDraft, ReviewError } from "@/lib/services/drafts";

export const maxDuration = 120;
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;
const body = z.object({ instruction: z.string(), reviewer: z.string().optional() });

/** Writes a new version following the reviewer's instruction. The previous version stays in the history. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params;
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!UUID.test(id) || !parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
    try { return Response.json({ draft: await regenerateDraft(id, parsed.data.instruction) }); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: e instanceof ReviewError ? e.status : 500 }); }
  });
}
