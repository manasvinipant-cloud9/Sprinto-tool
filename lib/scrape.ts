import * as cheerio from "cheerio";

export type PageStatus = "ok" | "blocked" | "empty" | "error" | "robots_disallowed" | "off_domain";
export interface PageResult {
  status: PageStatus;
  text: string;
  url: string;
  words: number;
  note?: string;
}

const UA = "OutreachEngineBot/0.1 (student project; single-page reads; respects robots.txt)";
const MAX_CHARS = 8000; // about 2000 tokens
const KEEP_SHORT = /enterprise|contact sales|per (month|year|seat|user)|\/mo|series [a-d]|raised|funding|careers|open (roles|positions)|certif|audit|gdpr|security|pricing|customers/i;

const lastHit = new Map<string, number>();
const robotsCache = new Map<string, string | null>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function politeWait(host: string) {
  const gap = 1000 - (Date.now() - (lastHit.get(host) ?? 0));
  if (gap > 0) await sleep(gap);
  lastHit.set(host, Date.now());
}

export function robotsAllows(robotsTxt: string, pathname: string): boolean {
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
  let applies = false;
  let sawAgent = false;
  const rules: { allow: boolean; path: string }[] = [];
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!sawAgent) applies = false;
      sawAgent = true;
      if (val === "*" || UA.toLowerCase().startsWith(val.toLowerCase())) applies = true;
    } else {
      sawAgent = false;
      if (!applies) continue;
      if (key === "disallow" && val) rules.push({ allow: false, path: val });
      if (key === "allow" && val) rules.push({ allow: true, path: val });
    }
  }
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    const endAnchor = pattern.endsWith("\\$");
    const re = new RegExp("^" + (endAnchor ? pattern.slice(0, -2) + "$" : pattern));
    if (re.test(pathname) && (!best || r.path.length > best.len)) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}

async function rawFetch(url: string, timeoutMs = 10000): Promise<{ status: number; body: string; headers: Headers }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    const body = (await res.text()).slice(0, 1_500_000);
    return { status: res.status, body, headers: res.headers };
  } finally {
    clearTimeout(t);
  }
}

async function robotsOk(u: URL): Promise<boolean> {
  if (!robotsCache.has(u.host)) {
    try {
      await politeWait(u.host);
      const r = await rawFetch(`${u.protocol}//${u.host}/robots.txt`, 6000);
      robotsCache.set(u.host, r.status === 200 ? r.body : null);
    } catch {
      robotsCache.set(u.host, null);
    }
  }
  const txt = robotsCache.get(u.host);
  return txt ? robotsAllows(txt, u.pathname + u.search) : true;
}

function looksBlocked(status: number, body: string, headers: Headers): boolean {
  if ([401, 403, 429, 503].includes(status)) {
    if (headers.get("cf-mitigated") || /just a moment|attention required|captcha|cf-chl|access denied/i.test(body)) return true;
    if (status !== 503) return true;
  }
  return /cf-browser-verification|g-recaptcha|hcaptcha|Verify you are human/i.test(body.slice(0, 20000));
}

export function cleanHtml(html: string): string {
  const $ = cheerio.load(html);
  $("script,style,noscript,svg,iframe,nav,footer,aside,form,select,[role=navigation],[aria-hidden=true]").remove();
  $("[class],[id]").each((_, el) => {
    const sig = `${$(el).attr("class") ?? ""} ${$(el).attr("id") ?? ""}`;
    if (/cookie|consent|gdpr-banner|popup|modal|newsletter|chat-widget/i.test(sig)) $(el).remove();
  });
  $("br").replaceWith("\n");
  $("p,div,li,h1,h2,h3,h4,h5,h6,section,tr,td,th,blockquote,dt,dd,button,a").each((_, el) => {
    $(el).append("\n");
  });
  const title = $("title").first().text().trim();
  const meta = $('meta[name="description"]').attr("content")?.trim() ?? "";
  const lines = [title, meta, ...$("body").text().split("\n")];
  return filterLines(lines);
}

export function filterLines(lines: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line) continue;
    const words = line.split(" ").length;
    if (words < 8 && !KEEP_SHORT.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out.join("\n").slice(0, MAX_CHARS);
}

const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export interface FetchCtx {
  baseDomain: string;
  cache: Map<string, PageResult>;
}

export async function fetchPage(url: string, ctx: FetchCtx): Promise<PageResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { status: "error", text: "", url, words: 0, note: "invalid_url" };
  }
  const host = u.hostname.replace(/^www\./, "");
  if (host !== ctx.baseDomain && !host.endsWith("." + ctx.baseDomain)) {
    return { status: "off_domain", text: "", url, words: 0, note: "only the prospect's own domain is allowed" };
  }
  const cached = ctx.cache.get(u.toString());
  if (cached) return cached;

  const done = (r: PageResult) => (ctx.cache.set(u.toString(), r), r);
  if (!(await robotsOk(u))) return done({ status: "robots_disallowed", text: "", url, words: 0, note: "robots_disallowed" });

  let attempt = 0;
  for (;;) {
    try {
      await politeWait(u.host);
      const r = await rawFetch(u.toString());
      if (looksBlocked(r.status, r.body, r.headers)) return done({ status: "blocked", text: "", url, words: 0, note: `blocked_${r.status}` });
      if (r.status >= 500 && attempt < 2) {
        attempt++;
        await sleep(800 * attempt);
        continue;
      }
      if (r.status >= 400) return done({ status: "error", text: "", url, words: 0, note: `http_${r.status}` });
      let text = cleanHtml(r.body);
      let note: string | undefined;
      if (wordCount(text) < 200) {
        try {
          await politeWait("r.jina.ai");
          const j = await rawFetch(`https://r.jina.ai/${u.toString()}`, 15000);
          if (j.status === 200) {
            const t2 = filterLines(j.body.split("\n"));
            if (wordCount(t2) > wordCount(text)) {
              text = t2;
              note = "fallback_jina";
            }
          }
        } catch {
          /* fallback is optional */
        }
      }
      const words = wordCount(text);
      return done({ status: words === 0 ? "empty" : "ok", text, url, words, note });
    } catch (e) {
      if (attempt < 2) {
        attempt++;
        await sleep(800 * attempt);
        continue;
      }
      return done({ status: "error", text: "", url, words: 0, note: (e as Error).name === "AbortError" ? "timeout" : "network_error" });
    }
  }
}
