import { db } from "../db";
import type { PageResult } from "../scrape";

const TTL_MS = 24 * 3600 * 1000;

export interface PageCache {
  get(url: string): Promise<PageResult | null>;
  put(url: string, r: PageResult): Promise<void>;
}

/** Workspace-scoped page cache so re-runs and profile comparisons reuse one fetch of each page. */
export function dbPageCache(workspaceId: string): PageCache {
  return {
    async get(url) {
      const res = await db().from("page_cache").select("status, text, words, fetched_at").eq("workspace_id", workspaceId).eq("url", url).limit(1);
      const row = res.data?.[0] as { status: string; text: string; words: number; fetched_at: string } | undefined;
      if (!row || Date.now() - new Date(row.fetched_at).getTime() > TTL_MS) return null;
      return { status: row.status as PageResult["status"], text: row.text, words: row.words, url, note: "cached" };
    },
    async put(url, r) {
      if (r.status !== "ok" && r.status !== "empty") return; // never cache blocks or errors
      await db().from("page_cache").upsert({ workspace_id: workspaceId, url, domain: new URL(url).hostname, status: r.status, text: r.text, words: r.words ?? 0, fetched_at: new Date().toISOString() });
    },
  };
}
