import YAML from "yaml";
import { withAuth } from "@/lib/guard";
import { profileSchema } from "@/lib/profile-schema";
import { listProfiles, saveProfileVersion, uniqueSlug } from "@/lib/services/profiles";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      return Response.json({ profiles: await listProfiles() });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 500 });
    }
  });
}

/** Body: { yaml } or { spec }, optional { cloneOf: <row id> }. Always saves a new immutable version. */
export async function POST(req: Request) {
  return withAuth(req, async () => {
    const body = (await req.json().catch(() => null)) as { yaml?: string; spec?: unknown; cloneOf?: string; cloneSlug?: boolean } | null;
    let raw: unknown = body?.spec;
    if (typeof body?.yaml === "string") {
      try { raw = YAML.parse(body.yaml); } catch (e) { return Response.json({ error: `YAML error: ${(e as Error).message}` }, { status: 400 }); }
    }
    const parsed = profileSchema.safeParse(raw);
    if (!parsed.success) return Response.json({ error: parsed.error.issues.map((i) => `${i.path.join(".") || "profile"}: ${i.message}`).join("; ") }, { status: 400 });
    try {
      const spec = body?.cloneSlug ? { ...parsed.data, id: await uniqueSlug(parsed.data.id), version: 1 } : parsed.data;
      return Response.json({ profile: await saveProfileVersion(spec, { cloneOfDbId: body?.cloneOf }) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 500 });
    }
  });
}
