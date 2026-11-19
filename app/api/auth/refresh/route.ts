import { csrfOk } from "@/lib/guard";
import { AuthFailure, clearSession, readSession, refreshTokens, setSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Trades the long-lived refresh cookie for a new short-lived access cookie. Neither token is ever readable by page scripts. */
export async function POST(req: Request) {
  if (!csrfOk(req)) return Response.json({ error: "Request blocked." }, { status: 403 });
  const s = await readSession();
  if (!s.rt) return Response.json({ error: "Sign in required.", code: "signin" }, { status: 401 });
  try { await setSession(await refreshTokens(s.rt)); return Response.json({ ok: true }); }
  catch (e) { await clearSession(); return Response.json({ error: e instanceof AuthFailure ? e.message : "Sign in again.", code: "signin" }, { status: 401 }); }
}
