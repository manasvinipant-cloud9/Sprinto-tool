import { withAuth } from "@/lib/guard";
import { listReview } from "@/lib/services/drafts";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid run id." }, { status: 400 });
    try { return Response.json({ items: await listReview(id) }); } catch (e) { return Response.json({ error: (e as Error).message }, { status: 500 }); }
  });
}
