"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DomainResult } from "@/lib/types";
import type { Profile } from "@/lib/profile-schema";
import type { RunDetail } from "@/lib/services/runs";

export interface ProfileVersion { dbId: string; version: number; hash: string; created_at: string }
export interface ProfileInfo { id: string; dbId: string | null; version: number; seller: string; icp: string; hash: string; gates: { id: string; question: string }[]; detail: Profile; yaml: string; clonedFrom: string | null; versions: ProfileVersion[]; readonly: boolean }
export interface StatusInfo { configured: { llm: boolean; hunter: boolean; database: boolean }; hunter: { used: number | null; available: number | null } | null }
export interface RunSummary { id: string; status: string; comparison_group: string | null; created_at: string; profile: string; accounts: number; ready: number; disqualified: number; capped: number; errors: number }
export type { RunDetail };
export interface SessionUser { id: string; email: string }
export interface WorkspaceRef { id: string; name: string; role: "owner" | "member" }
export type TabId = "run" | "results" | "review" | "compare" | "profiles" | "contacts" | "system";

/** Strip protocol, www, path and port; return null when it does not look like a domain. */
export function normalizeDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#:]/)[0];
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : null;
}
export function parseDomains(text: string) {
  const tokens = text.split(/[\s,;]+/).filter(Boolean);
  const valid: string[] = []; const invalid: string[] = []; let dupes = 0;
  for (const t of tokens) {
    const n = normalizeDomain(t);
    if (!n) invalid.push(t); else if (valid.includes(n)) dupes++; else valid.push(n);
  }
  return { valid, invalid, dupes };
}

/** Read domains from CSV text: a column headed "domain" (or "website", "url"), otherwise the first column. */
export function domainsFromCsv(csv: string): string {
  const rows = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(",").map((c) => c.trim().replace(/^"|"$/g, "")));
  if (rows.length === 0) return "";
  const head = rows[0].map((h) => h.toLowerCase());
  const col = head.findIndex((h) => ["domain", "website", "url", "company domain"].includes(h));
  const hasHeader = col >= 0 || head.every((h) => !normalizeDomain(h));
  return (hasHeader ? rows.slice(1) : rows).map((r) => r[col >= 0 ? col : 0] ?? "").filter(Boolean).join("\n");
}

interface Ctx {
  authed: boolean; booting: boolean; error: string | null; setError: (e: string | null) => void;
  user: SessionUser | null; workspaces: WorkspaceRef[]; current: WorkspaceRef | null; noWorkspace: boolean;
  signIn: (email: string, password: string) => Promise<void>; signOut: () => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>; createWorkspace: (name: string) => Promise<void>; refreshSession: () => Promise<void>;
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  /** Like api, but returns the raw response (for file downloads). Sends the session cookie and the app header. */
  fetchRaw: (path: string, init?: RequestInit) => Promise<Response>;
  profiles: ProfileInfo[]; refreshProfiles: () => Promise<void>; status: StatusInfo | null; refreshStatus: () => void;
  tab: TabId; setTab: (t: TabId) => void;
  runs: RunSummary[]; refreshRuns: () => Promise<void>;
  activeRunId: string | null; setActiveRunId: (id: string | null) => void; activeRun: RunDetail | null;
  createRun: (profileId: string, domains: string[]) => Promise<void>;
  controlRun: (action: "pause" | "resume" | "retry_failed") => Promise<void>;
  deleteRun: (id: string) => Promise<void>;
  driving: boolean; drive: (runId?: string) => void; driveMany: (runIds: string[]) => void;
  selected: string | null; setSelected: (accountId: string | null) => void; detail: DomainResult | null; detailLoading: boolean;
  toast: string | null; notify: (m: string) => void;
  theme: "system" | "light" | "dark"; setTheme: (t: "system" | "light" | "dark") => void;
}
const WorkspaceCtx = createContext<Ctx | null>(null);
export function useWorkspace() { const c = useContext(WorkspaceCtx); if (!c) throw new Error("useWorkspace outside provider"); return c; }

const POLL_MS = 2500;
const WORKING = ["queued", "researching", "gate_evaluation", "contact_lookup", "drafting"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState(false);
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceRef[]>([]);
  const [current, setCurrent] = useState<WorkspaceRef | null>(null);
  const [noWorkspace, setNoWorkspace] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [tab, setTabState] = useState<TabId>("run");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [activeRunId, setActiveRunIdState] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<RunDetail | null>(null);
  const [driving, setDriving] = useState(false);
  const [selected, setSelectedState] = useState<string | null>(null);
  const [detail, setDetail] = useState<DomainResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [theme, setThemeState] = useState<"system" | "light" | "dark">("system");
  const driveToken = useRef(0);
  const currentRef = useRef<string | null>(null);
  currentRef.current = current?.id ?? null;

  const notify = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(null), 2600); }, []);
  const setTab = useCallback((t: TabId) => { setTabState(t); try { history.replaceState(null, "", `#${t}`); } catch { /* ignore */ } }, []);
  const setTheme = useCallback((t: "system" | "light" | "dark") => {
    setThemeState(t);
    try { localStorage.setItem("outreach:theme", t); } catch { /* ignore */ }
    if (t === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
  }, []);

  const HEADERS = { "content-type": "application/json", "x-requested-with": "outreach" };
  /** Sends the session cookie. If the short-lived cookie has expired, trades the refresh cookie for a new one and retries once. */
  const fetchRaw = useCallback(async (path: string, init?: RequestInit): Promise<Response> => {
    const go = () => fetch(path, { ...init, credentials: "same-origin", headers: { ...HEADERS, ...(init?.headers ?? {}) } });
    let res = await go();
    if (res.status === 401 && !path.startsWith("/api/auth/")) {
      const r = await fetch("/api/auth/refresh", { method: "POST", credentials: "same-origin", headers: HEADERS });
      if (r.ok) res = await go();
      if (res.status === 401) { setAuthed(false); setUser(null); }
    }
    return res;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const api = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetchRaw(path, init);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
    return body as T;
  }, [fetchRaw]);

  const refreshProfiles = useCallback(async () => { const r = await api<{ profiles: ProfileInfo[] }>("/api/profiles"); setProfiles(r.profiles); }, [api]);
  const refreshStatus = useCallback(() => { api<StatusInfo>("/api/status").then(setStatus).catch(() => undefined); }, [api]);
  const refreshRuns = useCallback(async () => { try { const r = await api<{ runs: RunSummary[] }>("/api/runs"); setRuns(r.runs); } catch { /* database may be unconfigured */ } }, [api]);
  const loadRun = useCallback(async (id: string) => { const r = await api<{ run: RunDetail }>(`/api/runs/${id}`); setActiveRun(r.run); return r.run; }, [api]);

  const resetWorkspaceState = useCallback(() => {
    driveToken.current++; setDriving(false);
    setProfiles([]); setStatus(null); setRuns([]); setActiveRun(null); setActiveRunIdState(null); setSelectedState(null); setDetail(null);
  }, []);

  /** Reads who is signed in and which workspace is active. Returns false when there is no session. */
  const refreshSession = useCallback(async () => {
    try {
      const res = await fetchRaw("/api/session");
      if (!res.ok) { setAuthed(false); setUser(null); setWorkspaces([]); setCurrent(null); return; }
      const b = (await res.json()) as { user: SessionUser; workspaces: { workspaceId: string; name: string; role: "owner" | "member" }[]; current: WorkspaceRef | null };
      setUser(b.user); setWorkspaces(b.workspaces.map((w) => ({ id: w.workspaceId, name: w.name, role: w.role })));
      setCurrent(b.current); setNoWorkspace(!b.current); setAuthed(true);
      if (b.current) {
        try { const last = localStorage.getItem(`outreach:active-run:${b.current.id}`); if (last) setActiveRunIdState(last); } catch { /* ignore */ }
        const p = await fetchRaw("/api/profiles"); if (p.ok) setProfiles(((await p.json()) as { profiles: ProfileInfo[] }).profiles);
        fetchRaw("/api/status").then((r) => r.json()).then(setStatus).catch(() => undefined);
      }
    } finally { setBooting(false); }
  }, [fetchRaw]);

  const signIn = useCallback(async (email: string, password: string) => {
    setError(null);
    const res = await fetchRaw("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) { setError((b as { error?: string }).error ?? "Could not sign in."); return; }
    await refreshSession();
  }, [fetchRaw, refreshSession]);

  const signOut = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin", headers: HEADERS }).catch(() => undefined);
    resetWorkspaceState(); setAuthed(false); setUser(null); setWorkspaces([]); setCurrent(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetWorkspaceState]);

  const switchWorkspace = useCallback(async (id: string) => {
    const res = await fetchRaw("/api/workspaces/select", { method: "POST", body: JSON.stringify({ id }) });
    if (!res.ok) { setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not switch workspace."); return; }
    resetWorkspaceState(); setBooting(true); await refreshSession();
  }, [fetchRaw, refreshSession, resetWorkspaceState]);

  const createWorkspace = useCallback(async (name: string) => {
    const res = await fetchRaw("/api/workspaces", { method: "POST", body: JSON.stringify({ name }) });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((b as { error?: string }).error ?? "Could not create the workspace.");
    resetWorkspaceState(); setBooting(true); await refreshSession();
  }, [fetchRaw, refreshSession, resetWorkspaceState]);

  useEffect(() => {
    try {
      const t = localStorage.getItem("outreach:theme") as "system" | "light" | "dark" | null;
      if (t) { setThemeState(t); if (t !== "system") document.documentElement.setAttribute("data-theme", t); }
      const h = window.location.hash.replace("#", "") as TabId;
      if (["run", "results", "review", "compare", "profiles", "contacts", "system"].includes(h)) setTabState(h);
    } catch { /* storage unavailable */ }
    void refreshSession();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (authed) void refreshRuns(); }, [authed, refreshRuns]);

  const setActiveRunId = useCallback((id: string | null) => {
    setActiveRunIdState(id); setSelectedState(null); setDetail(null);
    try { const k = `outreach:active-run:${currentRef.current}`; if (id) localStorage.setItem(k, id); else localStorage.removeItem(k); } catch { /* ignore */ }
    if (!id) setActiveRun(null);
  }, []);

  // Load the active run, and keep it fresh while it is still moving.
  useEffect(() => {
    if (!authed || !activeRunId) return;
    let cancelled = false;
    void (async () => {
      for (;;) {
        try {
          const r = await loadRun(activeRunId);
          if (cancelled) return;
          if (r.status !== "running" && r.status !== "queued") { void refreshRuns(); return; }
        } catch { if (!cancelled) { setActiveRunIdState(null); setActiveRun(null); } return; }
        await sleep(POLL_MS);
        if (cancelled) return;
      }
    })();
    return () => { cancelled = true; };
  }, [authed, activeRunId, loadRun, refreshRuns, driving, activeRun?.status]);

  const setSelected = useCallback((accountId: string | null) => { setSelectedState(accountId); setDetail(null); }, []);
  const selectedStage = activeRun?.accounts.find((a) => a.id === selected)?.stage;
  useEffect(() => {
    if (!selected || !authed || !selectedStage || WORKING.includes(selectedStage)) return;
    let cancelled = false;
    setDetailLoading(true);
    api<{ result: DomainResult | null }>(`/api/accounts/${selected}`).then((r) => { if (!cancelled) setDetail(r.result); }).catch(() => undefined).finally(() => { if (!cancelled) setDetailLoading(false); });
    return () => { cancelled = true; };
  }, [selected, selectedStage, authed, api]);

  /** The browser drives the queue one account at a time while this tab is open. `npm run worker` does the same with no browser. */
  const drive = useCallback((runId?: string) => {
    const id = runId ?? activeRunId;
    if (!id) return;
    const token = ++driveToken.current;
    setDriving(true);
    void (async () => {
      try {
        for (;;) {
          if (driveToken.current !== token) return;
          const t = await api<{ state: string }>(`/api/runs/${id}/tick`, { method: "POST" });
          if (t.state === "finished" || t.state === "paused") break;
          if (t.state === "busy" || t.state === "idle") await sleep(3000);
        }
      } catch (e) { setError((e as Error).message); }
      finally { if (driveToken.current === token) setDriving(false); void loadRun(id).catch(() => undefined); void refreshRuns(); refreshStatus(); }
    })();
  }, [activeRunId, api, loadRun, refreshRuns, refreshStatus]);

  /** Works on several runs in turn, one account each, so paired runs advance together and the second reuses the first's page fetches. */
  const driveMany = useCallback((runIds: string[]) => {
    const token = ++driveToken.current;
    setDriving(true);
    void (async () => {
      let active = [...runIds];
      try {
        while (active.length && driveToken.current === token) {
          let idle = true;
          for (const id of [...active]) {
            if (driveToken.current !== token) return;
            const t = await api<{ state: string }>(`/api/runs/${id}/tick`, { method: "POST" });
            if (t.state === "finished" || t.state === "paused") active = active.filter((x) => x !== id);
            else if (t.state === "processed") idle = false;
          }
          if (idle && active.length) await sleep(3000);
        }
      } catch (e) { setError((e as Error).message); }
      finally { if (driveToken.current === token) setDriving(false); void refreshRuns(); refreshStatus(); }
    })();
  }, [api, refreshRuns, refreshStatus]);

  const createRun = useCallback(async (profileId: string, domains: string[]) => {
    setError(null);
    const prof = profiles.find((p) => p.id === profileId);
    const r = await api<{ runId: string; queued: number; capped: number; cap: number }>("/api/runs", { method: "POST", body: JSON.stringify({ profileId, profileRef: prof?.dbId ?? undefined, domains }) });
    setActiveRunId(r.runId);
    if (r.capped > 0) notify(`${r.capped} domain${r.capped > 1 ? "s" : ""} over the cap of ${r.cap} set aside as capped`);
    await loadRun(r.runId); void refreshRuns();
    drive(r.runId);
  }, [api, drive, loadRun, notify, profiles, refreshRuns, setActiveRunId]);

  const controlRun = useCallback(async (action: "pause" | "resume" | "retry_failed") => {
    if (!activeRunId) return;
    if (action === "pause") { driveToken.current++; setDriving(false); }
    await api(`/api/runs/${activeRunId}/control`, { method: "POST", body: JSON.stringify({ action }) });
    await loadRun(activeRunId); void refreshRuns();
    if (action !== "pause") drive(activeRunId);
  }, [activeRunId, api, drive, loadRun, refreshRuns]);

  const deleteRun = useCallback(async (id: string) => {
    await api(`/api/runs/${id}`, { method: "DELETE" });
    if (id === activeRunId) setActiveRunId(null);
    void refreshRuns();
  }, [activeRunId, api, refreshRuns, setActiveRunId]);

  const value = useMemo<Ctx>(() => ({ authed, booting, error, setError, user, workspaces, current, noWorkspace, signIn, signOut, switchWorkspace, createWorkspace, refreshSession, api, fetchRaw, profiles, refreshProfiles, status, refreshStatus, tab, setTab, runs, refreshRuns, activeRunId, setActiveRunId, activeRun, createRun, controlRun, deleteRun, driving, drive, driveMany, selected, setSelected, detail, detailLoading, toast, notify, theme, setTheme }),
    [authed, booting, error, user, workspaces, current, noWorkspace, signIn, signOut, switchWorkspace, createWorkspace, refreshSession, api, fetchRaw, profiles, refreshProfiles, status, refreshStatus, tab, setTab, runs, refreshRuns, activeRunId, setActiveRunId, activeRun, createRun, controlRun, deleteRun, driving, drive, driveMany, selected, setSelected, detail, detailLoading, toast, notify, theme, setTheme]);
  return <WorkspaceCtx.Provider value={value}>{children}{toast && <div className="toast" role="status">{toast}</div>}</WorkspaceCtx.Provider>;
}
