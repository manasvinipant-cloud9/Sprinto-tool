import { z } from "zod";
import { withAuth } from "@/lib/guard";
import { deleteOverride, listOverrides, OverrideError, setOverride } from "@/lib/services/overrides";

export const dynamic = "force-dynamic";
const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: e instanceof OverrideError ? e.status : 500 });
const body = z.object({ domain: z.string(), name: z.string(), email: z.string(), title: z.string().optional(), linkedin: z.string().optional() });

export async function GET(req: Request) {
  return withAuth(req, async () => { try { return Response.json({ overrides: await listOverrides() }); } catch (e) { return fail(e); } });
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    const parsed = body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Invalid request." }, { status: 400 });
    try { await setOverride(parsed.data); return Response.json({ overrides: await listOverrides() }); } catch (e) { return fail(e); }
  });
}

export async function DELETE(req: Request) {
  return withAuth(req, async () => {
    try { await deleteOverride(new URL(req.url).searchParams.get("domain") ?? ""); return Response.json({ overrides: await listOverrides() }); } catch (e) { return fail(e); }
  });
}
