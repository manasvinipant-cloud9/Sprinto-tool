import { withAuth } from "@/lib/guard";
import { getComparison } from "@/lib/services/runs";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;

/** GET /api/compare?a=<runId>&b=<runId>: two runs side by side, paired by domain. */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    const u = new URL(req.url);
    const a = u.searchParams.get("a") ?? ""; const b = u.searchParams.get("b") ?? "";
    if (!UUID.test(a) || !UUID.test(b)) return Response.json({ error: "Pass two run ids as a and b." }, { status: 400 });
    try { return Response.json({ comparison: await getComparison(a, b) }); } catch { return Response.json({ error: "Run not found." }, { status: 404 }); }
  });
}
