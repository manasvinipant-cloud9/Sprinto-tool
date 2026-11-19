/** Removes secrets from text before it is logged, stored or returned. Defence in depth: nothing should put a secret there in the first place. */
const SECRET_ENV = ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "SECRETS_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "HUNTER_API_KEY"];

const PATTERNS: [RegExp, string][] = [
  [/sb_(secret|publishable)_[A-Za-z0-9_-]{8,}/g, "[redacted-key]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-token]"],
  [/AIza[0-9A-Za-z_-]{20,}/g, "[redacted-key]"],
  [/sk-ant-[A-Za-z0-9_-]{10,}/g, "[redacted-key]"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer [redacted]"],
  [/((?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|password|secret|authorization|x-api-key)["']?\s*[:=]\s*["']?)([^"'&\s,;]{4,})/gi, "$1[redacted]"],
];

export function scrub(text: string): string {
  let out = text;
  for (const name of SECRET_ENV) {
    const v = process.env[name];
    if (v && v.length >= 8) out = out.split(v).join("[redacted]");
  }
  for (const [re, to] of PATTERNS) out = out.replace(re, to);
  return out;
}

/** A short, scrubbed message that is safe to show or store. */
export function safeError(e: unknown, max = 300): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "Unexpected error.";
  return scrub(m).slice(0, max);
}

/** Wrap console so anything printed on the server passes through scrub(). Called once at startup. */
export function installConsoleScrubber(): void {
  const mark = Symbol.for("outreach.scrubbed");
  const c = console as unknown as Record<string | symbol, unknown>;
  if (c[mark]) return;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => orig(...args.map((a) => (typeof a === "string" ? scrub(a) : a instanceof Error ? Object.assign(new Error(scrub(a.message)), { name: a.name, stack: a.stack ? scrub(a.stack) : undefined }) : a)));
  }
  c[mark] = true;
}
