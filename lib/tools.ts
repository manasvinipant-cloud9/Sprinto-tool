import * as cheerio from "cheerio";
import type { PageResult } from "./scrape";
import type { ToolCall } from "./types";

export const TOOL_DESCRIPTIONS = `Tools you may request (one per turn):

fetch_page(url)
- What it does: fetches one page from the prospect's own domain and returns cleaned text of at most 2000 tokens.
- When to use: a gate-critical field is null and the page most likely to hold it is known (use one of the candidate URLs offered).
- When not to use: for any other domain, for login-gated pages, for a URL already fetched in this run, or for a page that returned blocked or robots_disallowed.
- Returns: { status: ok | blocked | empty | error | robots_disallowed, text, url }.

search_news(query)
- What it does: searches Google News for press coverage of one company and returns up to 5 headlines with source, date and snippet.
- When to use: only to confirm a funding round or company stage that the website does not state.
- When not to use: to find people, emails or opinions, or more times than the budget allows.
- Returns: { status: ok | empty | error, results: [{ title, source, date, snippet }] }.`;

export interface NewsItem { title: string; source: string; date: string; snippet: string }
export interface NewsResult { status: "ok" | "empty" | "error"; results: NewsItem[]; note?: string }

export class Budget {
  fetches = 0;
  news = 0;
  constructor(public maxFetch: number, public maxNews: number) {}
  get total() { return this.fetches + this.news; }
  get maxTotal() { return this.maxFetch + this.maxNews; }
  canFetch() { return this.fetches < this.maxFetch && this.total < this.maxTotal; }
  canNews() { return this.news < this.maxNews && this.total < this.maxTotal; }
}

export async function searchNews(query: string): Promise<NewsResult> {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { "user-agent": "OutreachEngineBot/0.1" } });
      clearTimeout(t);
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return { status: "error", results: [], note: `http_${res.status}` };
      return parseNewsRss(await res.text());
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return { status: "error", results: [], note: "network_error" };
}

export function parseNewsRss(xml: string): NewsResult {
  const $ = cheerio.load(xml, { xmlMode: true });
  const results: NewsItem[] = [];
  $("item").slice(0, 5).each((_, el) => {
    const snippet = cheerio.load($(el).find("description").text()).text().replace(/\s+/g, " ").trim();
    results.push({
      title: $(el).find("title").first().text().trim(),
      source: $(el).find("source").first().text().trim(),
      date: $(el).find("pubDate").first().text().trim(),
      snippet: snippet.slice(0, 300),
    });
  });
  return { status: results.length ? "ok" : "empty", results };
}

export function summariseNews(n: NewsResult): string {
  return n.results.map((r) => `- ${r.date} | ${r.source} | ${r.title} | ${r.snippet}`).join("\n");
}

export function logCall(calls: ToolCall[], call: ToolCall) {
  calls.push(call);
}

export type { PageResult };
