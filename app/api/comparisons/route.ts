import { z } from "zod";
import { withAuth } from "@/lib/guard";
import { createComparison } from "@/lib/services/runs";

export const dynamic = "force-dynamic";

const side = z.object({ profileId: z.string().regex(/^[a-z0-9-]+$/), profileRef: z.string().uuid().optional() });
const body = z.object({ a: side, b: side, domains: z.array(z.string().max(200)).min(1).max(500) });

/** Starts two linked runs over the same domains, one per profile. */
export async function POST(req: Request) {
  return withAuth(req, async () => {
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid request body." }, { status: 400 });
    try {
      const { a, b, domains } = parsed.data;
      return Response.json(await createComparison({ a: { slug: a.profileId, dbId: a.profileRef }, b: { slug: b.profileId, dbId: b.profileRef }, domains }));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 400 });
    }
  });
}
