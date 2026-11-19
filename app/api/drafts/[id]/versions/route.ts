import { withAuth } from "@/lib/guard";
import { getVersions, ReviewError } from "@/lib/services/drafts";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid draft id." }, { status: 400 });
    try { return Response.json({ versions: await getVersions(id) }); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: e instanceof ReviewError ? e.status : 500 }); }
  });
}
