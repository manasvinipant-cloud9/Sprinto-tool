import { withAuth } from "@/lib/guard";
import { tickRun } from "@/lib/services/runs";

// One account per call keeps each request inside the platform's function time limit.
export const maxDuration = 300;
export const dynamic = "force-dynamic";
const UUID = /^[0-9a-f-]{36}$/i;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    const { id } = await params;
    if (!UUID.test(id)) return Response.json({ error: "Invalid run id." }, { status: 400 });
    try { return Response.json(await tickRun(id)); } catch (e) { return Response.json({ error: (e as Error).message }, { status: 500 }); }
  });
}
