import { checkAuth } from "@/lib/auth";
import { listProfileIds, loadProfile } from "@/lib/profiles";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;
  const profiles = listProfileIds().map((id) => {
    const p = loadProfile(id);
    return { id: p.id, version: p.version, seller: p.seller.name, icp: p.icp_summary, gates: p.gates.map((g) => ({ id: g.id, question: g.question })) };
  });
  return Response.json({ profiles });
}
