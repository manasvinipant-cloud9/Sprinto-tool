import { z } from "zod";
import { checkAuth } from "@/lib/auth";
import { loadProfile } from "@/lib/profiles";
import { createLLM, runDomain, realDeps } from "@/lib/pipeline";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

const body = z.object({ domain: z.string().min(3).max(120), profileId: z.string().regex(/^[a-z0-9-]+$/), send: z.boolean().default(true) });

export async function POST(req: Request) {
  const denied = checkAuth(req);
  if (denied) return denied;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request body." }, { status: 400 });
  let profile;
  try {
    profile = loadProfile(parsed.data.profileId);
  } catch {
    return Response.json({ error: "Unknown profile." }, { status: 404 });
  }
  const llm = createLLM();
  const result = await runDomain(parsed.data.domain, profile, { send: parsed.data.send }, realDeps(llm));
  return Response.json(result);
}
