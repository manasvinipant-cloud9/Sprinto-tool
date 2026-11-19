// Phase 6 check over real HTTP against a running server (default http://localhost:3111): sign-in, cookies, CSRF,
// workspace switching, key handling and response headers. Uses a throwaway user, removed afterwards.
import { randomBytes } from "node:crypto";
import { serviceDb } from "../lib/db";

const BASE = process.env.BASE_URL ?? "http://localhost:3111";
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) process.exitCode = 1; };
const H = { "content-type": "application/json", "x-requested-with": "outreach" };

class Jar {
  private c = new Map<string, string>();
  take(res: Response) { for (const line of res.headers.getSetCookie()) { const [kv] = line.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(line) || v === "") this.c.delete(k); else this.c.set(k, v); } }
  header() { return [...this.c].map(([k, v]) => `${k}=${v}`).join("; "); }
  drop(k: string) { this.c.delete(k); }
  has(k: string) { return this.c.has(k); }
}
async function call(jar: Jar, method: string, path: string, body?: unknown, headers: Record<string, string> = H) {
  const res = await fetch(BASE + path, { method, headers: { ...headers, ...(jar.header() ? { cookie: jar.header() } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  jar.take(res);
  const text = await res.text();
  let json: Record<string, unknown> = {}; try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, text, json };
}

async function main() {
  const email = `p6-http-${randomBytes(4).toString("hex")}@example.test`; const password = randomBytes(18).toString("base64url");
  const made = await serviceDb().auth.admin.createUser({ email, password, email_confirm: true });
  const userId = made.data.user!.id;
  const ws1 = (await serviceDb().from("workspaces").insert({ name: "http-check mine" }).select("id").single()).data as { id: string };
  const ws2 = (await serviceDb().from("workspaces").insert({ name: "http-check other" }).select("id").single()).data as { id: string };
  await serviceDb().from("workspace_members").insert({ workspace_id: ws1.id, user_id: userId, role: "owner" });
  try {
    const jar = new Jar();

    // before signing in
    const anon = await call(jar, "GET", "/api/runs");
    ok(anon.res.status === 401, "a request with no session is refused (401)");
    const noHeader = await call(jar, "POST", "/api/runs", { profileId: "x", domains: ["a.test"] }, { "content-type": "application/json" });
    ok(noHeader.res.status === 403, "a change request without the app's own header is refused (403), signed in or not");
    const wrong = await call(jar, "POST", "/api/auth/login", { email, password: "definitely-wrong-password" });
    ok(wrong.res.status === 401 && /Wrong email or password/.test(String(wrong.json.error)) && !jar.has("og_at"), "a wrong password gets a plain 401 and no cookie");
    const unknown = await call(jar, "POST", "/api/auth/login", { email: "nobody-" + randomBytes(3).toString("hex") + "@example.test", password: "whatever-password-1" });
    ok(unknown.res.status === 401 && unknown.json.error === wrong.json.error, "an unknown email gets the same answer as a wrong password");

    // sign in
    const login = await call(jar, "POST", "/api/auth/login", { email, password });
    const cookies = login.res.headers.getSetCookie();
    ok(login.res.status === 200 && jar.has("og_at") && jar.has("og_rt"), "the right password signs in and sets two cookies");
    ok(cookies.length >= 2 && cookies.every((c) => /HttpOnly/i.test(c) && /SameSite=lax/i.test(c)), "both cookies are HttpOnly and SameSite=Lax");
    ok(!login.text.includes("eyJ") && !/access_token|refresh_token/.test(login.text), "no token is in the response body, so page scripts can never read one");

    const session = await call(jar, "GET", "/api/session");
    const sj = session.json as { user?: { email: string }; workspaces?: { workspaceId: string }[]; current?: { id: string; role: string } };
    ok(session.res.status === 200 && sj.user?.email === email && sj.workspaces?.length === 1 && sj.current?.id === ws1.id && sj.current.role === "owner", "the session shows who you are and only your workspace");

    // workspace choice is checked, not trusted
    const pick = await call(jar, "POST", "/api/workspaces/select", { id: ws2.id });
    ok(pick.res.status === 403, "choosing a workspace you are not in is refused");
    jar.take(new Response(null, { headers: { "set-cookie": `og_ws=${ws2.id}; Path=/` } }));
    const forged = await call(jar, "GET", "/api/session");
    ok((forged.json as { current?: { id: string } }).current?.id === ws1.id, "a forged workspace cookie is ignored");
    const runs = await call(jar, "GET", "/api/runs");
    ok(runs.res.status === 200 && Array.isArray((runs.json as { runs: unknown[] }).runs), "signed in, the app's data endpoints answer");

    // keys
    const keysBefore = await call(jar, "GET", "/api/keys");
    ok(keysBefore.res.status === 200 && Array.isArray((keysBefore.json as { keys: unknown[] }).keys), "the keys endpoint lists status");
    const secret = `http-test-key-${randomBytes(6).toString("hex")}-4321`;
    const put = await call(jar, "PUT", "/api/keys", { name: "hunter", value: secret });
    ok(put.res.status === 200 && !put.text.includes(secret) && put.text.includes("••••4321"), "saving a key echoes only its last four characters");
    const again = await call(jar, "GET", "/api/keys");
    ok(!again.text.includes(secret) && !/ciphertext/i.test(again.text), "reading keys back never includes the value or the ciphertext");
    const status = await call(jar, "GET", "/api/status");
    ok(status.res.status === 200 && !status.text.includes(secret), "the status endpoint does not leak it either");
    const bad = await call(jar, "PUT", "/api/keys", { name: "hunter", value: "x" });
    ok(bad.res.status === 400 && !bad.text.includes("stack"), "a bad key gets a plain error");
    await call(jar, "DELETE", "/api/keys?name=hunter");

    // headers
    const page = await fetch(BASE + "/");
    const csp = page.headers.get("content-security-policy") ?? "";
    ok(/frame-ancestors 'none'/.test(csp) && /default-src 'self'/.test(csp) && page.headers.get("x-frame-options") === "DENY" && page.headers.get("x-content-type-options") === "nosniff" && page.headers.get("referrer-policy") === "no-referrer", "pages carry a content security policy, no-framing, no-sniff and no-referrer headers");
    ok(!page.headers.get("x-powered-by"), "the server does not announce its framework");
    ok((await call(jar, "GET", "/api/runs")).res.headers.get("cache-control")?.includes("no-store") === true, "API answers are marked no-store");

    // expired access token is refreshed, not fatal
    jar.drop("og_at");
    const expired = await call(jar, "GET", "/api/runs");
    ok(expired.res.status === 401, "without the short-lived cookie a request is refused");
    const refreshed = await call(jar, "POST", "/api/auth/refresh");
    ok(refreshed.res.status === 200 && jar.has("og_at") && (await call(jar, "GET", "/api/runs")).res.status === 200, "the refresh cookie gets a new one and the request then works");

    // sign out
    const out = await call(jar, "POST", "/api/auth/logout");
    ok(out.res.status === 200 && !jar.has("og_at") && !jar.has("og_rt"), "signing out clears both cookies");
    ok((await call(jar, "GET", "/api/runs")).res.status === 401 && (await call(jar, "POST", "/api/auth/refresh")).res.status === 401, "after sign-out neither a request nor a refresh works");

    // guessing is slowed
    let blocked = false;
    for (let i = 0; i < 9 && !blocked; i++) blocked = (await call(new Jar(), "POST", "/api/auth/login", { email, password: "guess-number-" + i })).res.status === 429;
    ok(blocked, "repeated wrong passwords are slowed down (429)");
  } finally {
    await serviceDb().from("workspaces").delete().in("id", [ws1.id, ws2.id]);
    await serviceDb().auth.admin.deleteUser(userId);
    console.log("cleaned up");
  }
}
main().catch((e) => { console.error("FAIL ", e instanceof Error ? e.message : e); process.exit(1); });
