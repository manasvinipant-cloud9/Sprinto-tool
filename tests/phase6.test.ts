import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { installConsoleScrubber, safeError, scrub } from "@/lib/scrub";
import { decryptSecret, encryptSecret, keyHint, secretsAvailable } from "@/lib/secrets";
import { csrfOk, demoBlocks, isDemoUser } from "@/lib/guard";
import { loginBlocked, loginFailed, loginOk } from "@/lib/session";
import { maskEmail } from "@/lib/mask";

const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" || e.name === ".next" ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const read = (f: string) => fs.readFileSync(f, "utf8");
const rel = (f: string) => path.relative(process.cwd(), f);
const src = (...dirs: string[]) => dirs.flatMap((d) => (fs.existsSync(d) ? walk(path.join(process.cwd(), d)) : [])).filter((f) => /\.(ts|tsx)$/.test(f));

describe("log scrubbing", () => {
  it("removes keys, tokens and credentials from text", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";
    const samples = [
      `failed with sb_secret_AbCdEf123456_xyz`, `token ${jwt}`, `url https://x.test/?api_key=abcd1234efgh5678&q=1`, `Authorization: Bearer abcdefghijklmnop123`,
      `key AIzaSyA-1234567890abcdefghijklmnopqrstu`, `sk-ant-api03-abcdefghijk`, `{"password":"hunter2hunter2"}`, `refresh_token=abc12345xyz`,
    ];
    for (const s of samples) {
      const out = scrub(s);
      expect(out).toMatch(/redacted/);
      expect(out).not.toMatch(/abcd1234efgh5678|AbCdEf123456|hunter2hunter2|abcdefghijklmnop123|1234567890abcdefghijklmnopqrstu|abc12345xyz/);
    }
    expect(scrub(jwt)).toBe("[redacted-token]");
  });
  it("removes the exact values of configured secrets, even in a shape no pattern knows", () => {
    const old = process.env.HUNTER_API_KEY;
    process.env.HUNTER_API_KEY = "plainvalue_without_a_known_prefix_9981";
    try { expect(scrub("hunter said no to plainvalue_without_a_known_prefix_9981 today")).toBe("hunter said no to [redacted] today"); }
    finally { if (old === undefined) delete process.env.HUNTER_API_KEY; else process.env.HUNTER_API_KEY = old; }
  });
  it("leaves ordinary text alone", () => {
    expect(scrub("Series B, 120 people, https://acme.test/security")).toBe("Series B, 120 people, https://acme.test/security");
  });
  it("makes error messages short and safe", () => {
    expect(safeError(new Error("boom api_key=supersecret123"))).toBe("boom api_key=[redacted]");
    expect(safeError("x".repeat(1000)).length).toBe(300);
    expect(safeError(undefined)).toBe("Unexpected error.");
  });
  it("scrubs what the server prints to the console", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    installConsoleScrubber();
    console.error("request failed: Bearer abcdefghijklmnop123 and sb_secret_ZZZZZZZZ12345678");
    const printed = String(spy.mock.calls.at(-1)?.[0] ?? "");
    // The wrapper sits on top of the spy, so what reached the spy is already clean.
    expect(printed).not.toMatch(/abcdefghijklmnop123|ZZZZZZZZ12345678/);
    spy.mockRestore();
  });
});

describe("workspace key encryption", () => {
  const old = process.env.SECRETS_KEY;
  beforeEach(() => { process.env.SECRETS_KEY = randomBytes(32).toString("base64"); });
  afterEach(() => { if (old === undefined) delete process.env.SECRETS_KEY; else process.env.SECRETS_KEY = old; });

  it("round-trips a key and never stores it readable", () => {
    const plain = "AIzaSyExampleKeyValue1234567890abcd";
    const stored = encryptSecret(plain, "ws1:gemini");
    expect(stored).not.toContain(plain);
    expect(stored.startsWith("v1.")).toBe(true);
    expect(decryptSecret(stored, "ws1:gemini")).toBe(plain);
  });
  it("uses a fresh nonce each time", () => {
    expect(encryptSecret("same-value-12345", "a")).not.toBe(encryptSecret("same-value-12345", "a"));
  });
  it("cannot be moved to another workspace or key name", () => {
    const stored = encryptSecret("value-for-workspace-one", "ws1:gemini");
    expect(() => decryptSecret(stored, "ws2:gemini")).toThrow();
    expect(() => decryptSecret(stored, "ws1:hunter")).toThrow();
  });
  it("detects tampering", () => {
    const parts = encryptSecret("value-to-protect-123", "ws1:hunter").split(".");
    const ct = Buffer.from(parts[3], "base64"); ct[0] ^= 1;
    expect(() => decryptSecret([parts[0], parts[1], parts[2], ct.toString("base64")].join("."), "ws1:hunter")).toThrow();
  });
  it("refuses to work without a proper server key", () => {
    delete process.env.SECRETS_KEY;
    expect(secretsAvailable()).toBe(false);
    expect(() => encryptSecret("value-12345678", "a")).toThrow(/SECRETS_KEY/);
    process.env.SECRETS_KEY = Buffer.from("too short").toString("base64");
    expect(secretsAvailable()).toBe(false);
  });
  it("shows only the last four characters", () => {
    expect(keyHint("sk-abcdefghijklmnop1234")).toBe("••••1234");
    expect(keyHint("short")).toBe("••••");
    expect(keyHint("sk-abcdefghijklmnop1234")).not.toContain("abcdefghijklmnop");
  });
});

describe("request guards", () => {
  const req = (method: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/x", { method, headers });
  it("lets reads through and requires the app header on anything that changes data", () => {
    expect(csrfOk(req("GET"))).toBe(true);
    expect(csrfOk(req("POST"))).toBe(false);
    expect(csrfOk(req("DELETE", { "x-requested-with": "somebody-else" }))).toBe(false);
    for (const m of ["POST", "PATCH", "PUT", "DELETE"]) expect(csrfOk(req(m, { "x-requested-with": "outreach" }))).toBe(true);
  });
  it("slows password guessing and forgives a good sign-in", () => {
    const id = `t:${Math.random()}`;
    for (let i = 0; i < 5; i++) loginFailed(id);
    expect(loginBlocked(id)).toBe(false);
    loginFailed(id);
    expect(loginBlocked(id)).toBe(true);
    loginOk(id);
    expect(loginBlocked(id)).toBe(false);
  });
});

describe("the read-only demo", () => {
  it("refuses every change, and closes pages that list people, keys or the audit trail", () => {
    for (const m of ["POST", "PATCH", "PUT", "DELETE"]) expect(demoBlocks(m, "/api/runs")).toMatch(/read-only/);
    expect(demoBlocks("POST", "/api/runs/abc/tick")).toMatch(/read-only/); // no model or contact calls can be started
    expect(demoBlocks("GET", "/api/members")).toMatch(/Not available/);
    expect(demoBlocks("GET", "/api/audit")).toMatch(/Not available/);
    expect(demoBlocks("GET", "/api/keys")).toMatch(/Not available/);
  });
  it("lets the demo look at everything else", () => {
    for (const p of ["/api/runs", "/api/runs/abc", "/api/accounts/abc", "/api/profiles", "/api/compare", "/api/runs/abc/review", "/api/runs/abc/export"]) expect(demoBlocks("GET", p)).toBeNull();
  });
  it("only the configured demo user is treated as the demo", () => {
    const old = process.env.DEMO_USER_ID;
    try {
      delete process.env.DEMO_USER_ID; expect(isDemoUser("anything")).toBe(false);
      process.env.DEMO_USER_ID = "u-1"; expect(isDemoUser("u-1")).toBe(true); expect(isDemoUser("u-2")).toBe(false);
    } finally { if (old === undefined) delete process.env.DEMO_USER_ID; else process.env.DEMO_USER_ID = old; }
  });
  it("is checked before any workspace work, in the shared guard", () => {
    const text = read("lib/guard.ts");
    expect(text.indexOf("isDemoUser(user.id)")).toBeGreaterThan(0);
    expect(text.indexOf("isDemoUser(user.id)")).toBeLessThan(text.indexOf("membershipsFor(user.id, s.at);\n  if (ms.length === 0)"));
  });
  it("hides real people's email addresses from demo visitors", () => {
    expect(maskEmail("priya.rao@acme.com")).toBe("p***@acme.com");
    expect(maskEmail("not an email")).toBe("***");
    expect(maskEmail("a@b.co")).toBe("a***@b.co");
    const services = ["lib/services/runs.ts", "lib/services/drafts.ts"].map(read).join("\n");
    expect((services.match(/Ctx\(\)\.demo/g) ?? []).length).toBeGreaterThanOrEqual(5); // briefs, full result, shortlist export, review queue, approved export
  });
  it("never puts the demo password anywhere the browser can see", () => {
    expect(src("components", "app").filter((f) => /DEMO_PASSWORD/.test(read(f)) && !f.endsWith("auth/demo/route.ts")).map(rel)).toEqual([]);
  });
});

describe("the code keeps its boundaries", () => {
  it("every API route checks the session, except the sign-in ones", () => {
    const open = new Set(["app/api/auth/login/route.ts", "app/api/auth/demo/route.ts", "app/api/auth/logout/route.ts", "app/api/auth/refresh/route.ts", "app/api/session/route.ts", "app/api/workspaces/select/route.ts"]);
    const routes = walk(path.join(process.cwd(), "app/api")).filter((f) => f.endsWith("route.ts"));
    expect(routes.length).toBeGreaterThan(20);
    const unguarded = routes.filter((f) => !open.has(rel(f)) && !/withAuth\(/.test(read(f))).map(rel);
    expect(unguarded).toEqual([]);
    for (const f of open) expect(read(f)).toMatch(/csrfOk|readSession/); // the open ones still check something
  });
  it("owner-only actions are marked owner-only", () => {
    for (const [f, methods] of [["app/api/members/route.ts", ["POST", "DELETE"]], ["app/api/keys/route.ts", ["PUT", "DELETE"]], ["app/api/profiles/examples/route.ts", ["POST"]], ["app/api/workspaces/route.ts", ["PATCH"]]] as const) {
      const text = read(f);
      for (const m of methods) {
        const body = text.slice(text.indexOf(`export async function ${m}`));
        const end = body.indexOf("\nexport async function", 10);
        expect((end > 0 ? body.slice(0, end) : body)).toMatch(/\{ owner: true \}/);
      }
    }
  });
  it("the old shared password is gone", () => {
    const all = src("app", "lib", "components", "scripts");
    expect(all.filter((f) => /APP_PASSWORD|x-app-password|checkAuth/.test(read(f))).map(rel)).toEqual([]);
    expect(fs.existsSync("lib/auth.ts")).toBe(false);
  });
  it("browser code never imports server code or reads the environment", () => {
    const client = [...src("components"), path.join(process.cwd(), "app/page.tsx"), path.join(process.cwd(), "app/layout.tsx")];
    const bad: string[] = [];
    for (const f of client) {
      const text = read(f);
      for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*from\s+["']([^"']+)["']/gm)) {
        if (/@\/lib\/(db|ctx|session|guard|secrets|scrub|audit|services\/|pipeline|llm|poc|scrape|tools|gates|extract|email|pains|score|profiles|auth)/.test(m[1]) || /node:/.test(m[1])) bad.push(`${rel(f)} imports ${m[1]}`);
      }
      if (/process\.env/.test(text)) bad.push(`${rel(f)} reads process.env`);
    }
    expect(bad).toEqual([]);
  });
  it("no variable is exposed to the browser", () => {
    expect(src("app", "lib", "components", "scripts").filter((f) => /NEXT_PUBLIC_/.test(read(f))).map(rel)).toEqual([]);
    expect(read(".env.example")).not.toMatch(/NEXT_PUBLIC_/);
  });
  it("the all-powerful database client is used only where it is meant to be", () => {
    const allowed = new Set(["lib/db.ts", "lib/services/workspace.ts", "lib/services/runs.ts"]);
    const users = src("app", "lib", "components").filter((f) => /serviceDb\(|serviceCtx\(/.test(read(f))).map(rel).filter((f) => !allowed.has(f));
    expect(users).toEqual([]);
  });
  it("nothing logs a secret on purpose", () => {
    const hits = src("app", "lib").filter((f) => /console\.(log|info|debug|warn|error)\([^)]*(process\.env\.(SUPABASE_SERVICE|SECRETS|GEMINI|ANTHROPIC|HUNTER)|accessToken|refresh_token|ciphertext)/.test(read(f))).map(rel);
    expect(hits).toEqual([]);
  });
  it("sessions live in httpOnly cookies, not in storage the page can read", () => {
    const text = read("lib/session.ts");
    expect(text).toMatch(/httpOnly: true/);
    expect(text).toMatch(/sameSite: "lax"/);
    expect(src("components", "app").filter((f) => /(local|session)Storage\.[sg]etItem\([^)]*(token|password|session)/i.test(read(f))).map(rel)).toEqual([]);
  });
  it("the audit trail has no update or delete path in code", () => {
    expect(src("app", "lib").filter((f) => /from\("audit_log"\)\.(update|delete|upsert)/.test(read(f))).map(rel)).toEqual([]);
  });
});
