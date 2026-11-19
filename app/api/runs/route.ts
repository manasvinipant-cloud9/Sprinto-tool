import { z } from "zod";
import { withAuth } from "@/lib/guard";
import { createRun, listRuns } from "@/lib/services/runs";

export const dynamic = "force-dynamic";

const body = z.object({
  profileId: z.string().regex(/^[a-z0-9-]+$/),
  profileRef: z.string().uuid().optional(),
  domains: z.array(z.string().max(200)).min(1).max(500),
});

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try { return Response.json({ runs: await listRuns() }); } catch (e) { return Response.json({ error: (e as Error).message }, { status: 500 }); }
  });
}

/** Creates a run. Accounts beyond the profile's max_accounts_per_run are stored as capped, never silently dropped. */
export async function POST(req: Request) {
  return withAuth(req, async () => {
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid request body." }, { status: 400 });
    try {
      return Response.json(await createRun({ profileSlug: parsed.data.profileId, profileDbId: parsed.data.profileRef, domains: parsed.data.domains }));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  });
}
