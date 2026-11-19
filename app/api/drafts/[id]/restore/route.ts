import { z } from "zod";
import { withAuth } from "@/lib/guard";
import { restoreVersion, ReviewError } from "@/lib/services/drafts";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;
const body = z.object({ fromVersion: z.number().int().min(1), reviewer: z.string().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params;
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!UUID.test(id) || !parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
    try { return Response.json({ draft: await restoreVersion(id, parsed.data.fromVersion) }); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: e instanceof ReviewError ? e.status : 500 }); }
  });
}
