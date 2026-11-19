import { withAuth } from "@/lib/guard";
import { deleteRun, getRun } from "@/lib/services/runs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid run id." }, { status: 400 });
    try { return Response.json({ run: await getRun(id) }); } catch { return Response.json({ error: "Run not found." }, { status: 404 }); }
  });
}

export async function DELETE(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid run id." }, { status: 400 });
    try { await deleteRun(id); return Response.json({ ok: true }); } catch (e) { return Response.json({ error: (e as Error).message }, { status: 404 }); }
  });
}
