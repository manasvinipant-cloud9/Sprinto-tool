import { z } from "zod";
import { csrfOk } from "@/lib/guard";
import { AuthFailure, loginBlocked, loginFailed, loginOk, passwordSignIn, setSession, throttleKeys } from "@/lib/session";
import { safeError } from "@/lib/scrub";

export const dynamic = "force-dynamic";
const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  if (!csrfOk(req)) return Response.json({ error: "Request blocked: it did not come from this app." }, { status: 403 });
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Enter your email and password." }, { status: 400 });
  const email = parsed.data.email.toLowerCase();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const keys = throttleKeys(email, ip);
  if (keys.some(loginBlocked)) return Response.json({ error: "Too many attempts. Wait a few minutes and try again." }, { status: 429 });
  try {
    const tokens = await passwordSignIn(email, parsed.data.password);
    keys.forEach(loginOk);
    await setSession(tokens);
    return Response.json({ user: tokens.user });
  } catch (e) {
    if (e instanceof AuthFailure && e.status === 401) keys.forEach(loginFailed);
    return Response.json({ error: e instanceof AuthFailure ? e.message : safeError(e) }, { status: e instanceof AuthFailure ? e.status : 500 });
  }
}
