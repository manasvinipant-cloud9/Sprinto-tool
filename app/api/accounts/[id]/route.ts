import { withAuth } from "@/lib/guard";
import { getAccountResult } from "@/lib/services/runs";

export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid account id." }, { status: 400 });
    try { return Response.json({ result: await getAccountResult(id) }); } catch { return Response.json({ error: "Account not found." }, { status: 404 }); }
  });
}
