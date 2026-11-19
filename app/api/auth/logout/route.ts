import { csrfOk } from "@/lib/guard";
import { clearSession, forgetToken, readSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!csrfOk(req)) return Response.json({ error: "Request blocked." }, { status: 403 });
  const s = await readSession();
  if (s.at) forgetToken(s.at);
  await clearSession();
  return Response.json({ ok: true });
}
