import YAML from "yaml";
import { withAuth } from "@/lib/guard";
import { profileSchema } from "@/lib/profile-schema";
import { profileHash } from "@/lib/profile-hash";

export const dynamic = "force-dynamic";

/** Validates a profile draft against the real schema. Never writes to disk (Vercel's filesystem is read-only). */
export async function POST(req: Request) {
  return withAuth(req, async () => {
    const body = (await req.json().catch(() => null)) as { profile?: unknown } | null;
    const parsed = profileSchema.safeParse(body?.profile);
    if (!parsed.success) {
      const errors = parsed.error.issues.map((i) => ({ path: i.path.join(".") || "profile", message: i.message }));
      return Response.json({ ok: false, errors });
    }
    return Response.json({ ok: true, errors: [], hash: profileHash(parsed.data), yaml: YAML.stringify(parsed.data, { lineWidth: 100 }) });
  });
}
