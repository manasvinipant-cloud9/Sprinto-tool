// After `npm run build`: confirm no secret value, and no server-only name, ended up in anything the browser downloads.
// Reads secret values from the environment (.env.local) and searches the client bundles and prerendered pages for them.
import fs from "node:fs";
import path from "node:path";

const SECRET_ENV = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "SECRETS_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "HUNTER_API_KEY", "SUPABASE_URL"];
const NAMES = ["SUPABASE_SERVICE_ROLE_KEY", "SECRETS_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "HUNTER_API_KEY", "SUPABASE_PUBLISHABLE_KEY"];
const PATTERNS = [/sb_secret_[A-Za-z0-9_-]{8,}/, /sb_publishable_[A-Za-z0-9_-]{8,}/, /service_role/, /AIza[0-9A-Za-z_-]{20,}/, /sk-ant-[A-Za-z0-9_-]{10,}/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/];

const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
const roots = [".next/static", ".next/server/app"];
const files = roots.flatMap(walk).filter((f) => /\.(js|css|html|json|txt|rsc|map)$/.test(f) && !f.endsWith(".nft.json"));
if (files.length === 0) { console.error("FAIL  no build output found. Run `npm run build` first."); process.exit(1); }
const clientFiles = files.filter((f) => f.startsWith(".next/static") || f.endsWith(".html"));

const problems: string[] = [];
const values = SECRET_ENV.map((n) => [n, process.env[n]] as const).filter(([, v]) => v && v.length >= 8) as [string, string][];
for (const f of clientFiles) {
  const text = fs.readFileSync(f, "utf8");
  for (const [n, v] of values) if (text.includes(v)) problems.push(`${f}: contains the value of ${n}`);
  for (const n of NAMES) if (text.includes(n)) problems.push(`${f}: mentions ${n}`);
  for (const re of PATTERNS) if (re.test(text)) problems.push(`${f}: matches ${re}`);
}
console.log(`scanned ${clientFiles.length} client files (${files.length} build files), checked ${values.length} secret values, ${NAMES.length} names, ${PATTERNS.length} patterns`);
if (problems.length) { for (const p of problems.slice(0, 20)) console.error("FAIL ", p); process.exit(1); }
console.log("PASS  no secret value, server-only name or key-shaped string is in anything the browser downloads");
