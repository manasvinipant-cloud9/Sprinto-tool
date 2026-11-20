import { csrfOk } from "@/lib/guard";
import { safeError } from "@/lib/scrub";
import { passwordSignIn, setSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Signs a visitor in as the read-only demo user. The demo's password lives only on the server and is never shown. */
export async function POST(req: Request) {
  if (!csrfOk(req)) return Response.json({ error: "Request blocked: it did not come from this app." }, { status: 403 });
  const email = process.env.DEMO_EMAIL; const password = process.env.DEMO_PASSWORD;
  if (!email || !password || !process.env.DEMO_USER_ID) return Response.json({ error: "No demo is set up.", code: "no_demo" }, { status: 404 });
  try {
    const tokens = await passwordSignIn(email, password);
    await setSession(tokens);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: safeError(e) }, { status: 500 });
  }
}
