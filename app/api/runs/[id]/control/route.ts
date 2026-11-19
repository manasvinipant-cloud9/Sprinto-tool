import { z } from "zod";
import { withAuth } from "@/lib/guard";
import { controlRun } from "@/lib/services/runs";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;
const body = z.object({ action: z.enum(["pause", "resume", "retry_failed"]) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params;
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!UUID.test(id) || !parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
    try { return Response.json({ status: await controlRun(id, parsed.data.action) }); } catch (e) { return Response.json({ error: (e as Error).message }, { status: 409 }); }
  });
}
