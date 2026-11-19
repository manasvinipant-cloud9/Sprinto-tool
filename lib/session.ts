import { createHash } from "node:crypto";
import { cookies } from "next/headers";

const AT = "og_at"; const RT = "og_rt"; const WS = "og_ws";

export class AuthFailure extends Error { constructor(message: string, public status = 401) { super(message); } }

function cfg() {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new AuthFailure("Sign-in is not configured on this server.", 500);
  return { url, key };
}

export interface Tokens { access_token: string; refresh_token: string; expires_in: number; user: { id: string; email: string } }

async function tokenRequest(grant: "password" | "refresh_token", body: Record<string, string>): Promise<Tokens> {
  const { url, key } = cfg();
  const res = await fetch(`${url}/auth/v1/token?grant_type=${grant}`, { method: "POST", headers: { apikey: key, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new AuthFailure(grant === "password" ? "Wrong email or password." : "Your session expired. Sign in again.", res.status === 429 ? 429 : 401);
  const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; user: { id: string; email?: string } };
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in, user: { id: j.user.id, email: j.user.email ?? "" } };
}

export const passwordSignIn = (email: string, password: string) => tokenRequest("password", { email, password });
export const refreshTokens = (refresh_token: string) => tokenRequest("refresh_token", { refresh_token });

// Asking Supabase whether a token is still valid is the authority; remember a good answer for a minute to keep polling cheap.
const verified = new Map<string, { user: { id: string; email: string }; until: number }>();
const fingerprint = (t: string) => createHash("sha256").update(t).digest("hex");

export async function verifyToken(token: string): Promise<{ id: string; email: string } | null> {
  const fp = fingerprint(token); const hit = verified.get(fp);
  if (hit && hit.until > Date.now()) return hit.user;
  const { url, key } = cfg();
  const res = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, authorization: `Bearer ${token}` } });
  if (!res.ok) { verified.delete(fp); return null; }
  const j = (await res.json()) as { id: string; email?: string };
  const user = { id: j.id, email: j.email ?? "" };
  if (verified.size > 500) verified.clear();
  verified.set(fp, { user, until: Date.now() + 60_000 });
  return user;
}
export function forgetToken(token: string) { verified.delete(fingerprint(token)); }

const base = () => ({ httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" });

export async function setSession(t: Tokens) {
  const c = await cookies();
  c.set(AT, t.access_token, { ...base(), maxAge: Math.max(60, t.expires_in) });
  c.set(RT, t.refresh_token, { ...base(), maxAge: 60 * 60 * 24 * 14 });
}
export async function setWorkspaceCookie(id: string) { (await cookies()).set(WS, id, { ...base(), maxAge: 60 * 60 * 24 * 90 }); }
export async function clearSession() { const c = await cookies(); for (const n of [AT, RT, WS]) c.delete(n); }
export async function readSession() { const c = await cookies(); return { at: c.get(AT)?.value, rt: c.get(RT)?.value, ws: c.get(WS)?.value }; }

// Slow down password guessing. Best effort in memory (it resets on restart); Supabase also rate limits sign-ins.
// Attempts are counted per email-and-address pair, so a stranger cannot lock someone else out, plus a looser cap per address.
const fails = new Map<string, { n: number; until: number }>();
const WINDOW_MS = 15 * 60_000;
export interface Throttle { id: string; max: number }
export function throttleKeys(email: string, ip: string): Throttle[] {
  return ip ? [{ id: `pair:${ip}:${email}`, max: 6 }, { id: `ip:${ip}`, max: 30 }] : [{ id: `pair:unknown:${email}`, max: 6 }];
}
export function loginBlocked(t: Throttle | string, max = 6): boolean {
  const id = typeof t === "string" ? t : t.id; const m = typeof t === "string" ? max : t.max;
  const f = fails.get(id); return !!f && f.n >= m && f.until > Date.now();
}
export function loginFailed(t: Throttle | string) { const id = typeof t === "string" ? t : t.id; const f = fails.get(id); fails.set(id, !f || f.until < Date.now() ? { n: 1, until: Date.now() + WINDOW_MS } : { n: f.n + 1, until: f.until }); }
export function loginOk(t: Throttle | string) { fails.delete(typeof t === "string" ? t : t.id); }
