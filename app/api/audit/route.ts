import { withAuth } from "@/lib/guard";
import { listAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** The workspace's append-only trail, newest first. Pass ?before=<id> for the next page. */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    const u = new URL(req.url);
    const before = Number(u.searchParams.get("before")) || undefined;
    try { return Response.json({ events: await listAudit(Number(u.searchParams.get("limit")) || 100, before) }); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: 500 }); }
  });
}
