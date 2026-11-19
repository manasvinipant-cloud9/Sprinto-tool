import { withAuth } from "@/lib/guard";
import { exportRunCsv } from "@/lib/services/runs";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;

/** GET /api/runs/:id/export?scope=all|qualified returns the ranked shortlist with evidence as CSV. No drafts are required. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid run id." }, { status: 400 });
    const scope = new URL(req.url).searchParams.get("scope") === "qualified" ? "qualified" : "all";
    try {
      const csv = await exportRunCsv(id, scope);
      return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="shortlist-${id.slice(0, 8)}-${scope}.csv"` } });
    } catch {
      return Response.json({ error: "Run not found." }, { status: 404 });
    }
  });
}
