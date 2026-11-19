import { withAuth } from "@/lib/guard";
import { listProfiles, seedExamples } from "@/lib/services/profiles";

export const dynamic = "force-dynamic";

/** Copies the shipped example profiles into this workspace. */
export async function POST(req: Request) {
  return withAuth(req, async () => {
    try { const added = await seedExamples(); return Response.json({ added, profiles: await listProfiles() }); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: 500 }); }
  }, { owner: true });
}
