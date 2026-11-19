import { withAuth } from "@/lib/guard";
import { exportApprovedCsv } from "@/lib/services/drafts";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;

/** Approved drafts as CSV. Only drafts a person approved are included. Nothing is sent. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid run id." }, { status: 400 });
    try {
      return new Response(await exportApprovedCsv(id), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="approved-drafts-${id.slice(0, 8)}.csv"` } });
    } catch { return Response.json({ error: "Run not found." }, { status: 404 }); }
  });
}
