"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DomainResult } from "@/lib/types";
import { StatusBadge } from "@/components/StatusBadge";
import { DomainDetail } from "@/components/DomainDetail";

interface ProfileInfo { id: string; version: number; seller: string; icp: string; gates: { id: string; question: string }[] }
interface StatusInfo { configured: { llm: boolean; hunter: boolean; gmail: boolean; send_to: boolean }; hunter: { used: number | null; available: number | null } | null }

const KEY = "outreach:last-run";
const rank = (r: DomainResult) => (r.score ?? -1) + (r.status === "sent" || r.status === "drafted" ? 1000 : r.status === "qualified_no_poc" || r.status === "held" || r.status === "send_failed" ? 500 : 0);

export default function Home() {
  const [pw, setPw] = useState("");
  const [authed, setAuthed] = useState(false);
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [profileId, setProfileId] = useState("sprinto");
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [domains, setDomains] = useState("");
  const [send, setSend] = useState(true);
  const [results, setResults] = useState<DomainResult[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const stop = useRef(false);

  useEffect(() => {
    const saved = sessionStorage.getItem("outreach:pw");
    if (saved) { setPw(saved); void connect(saved); }
    try { const last = localStorage.getItem(KEY); if (last) setResults(JSON.parse(last)); } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function api(path: string, password: string, init?: RequestInit) {
    const res = await fetch(path, { ...init, headers: { ...(init?.headers ?? {}), "content-type": "application/json", "x-app-password": password } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
    return body;
  }

  async function connect(password = pw) {
    setError(null);
    try {
      const p = (await api("/api/profiles", password)) as { profiles: ProfileInfo[] };
      setProfiles(p.profiles);
      sessionStorage.setItem("outreach:pw", password);
      setAuthed(true);
      api("/api/status", password).then((s) => setStatus(s as StatusInfo)).catch(() => undefined);
    } catch (e) { setAuthed(false); setError((e as Error).message); }
  }

  async function run() {
    const list = [...new Set(domains.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean))];
    if (list.length === 0) { setError("Add at least one domain."); return; }
    if (list.length > 25) { setError("Run at most 25 domains at a time."); return; }
    setError(null); setRunning(true); stop.current = false; setResults([]); setSelected(null); setDone(0); setTotal(list.length);
    const out: DomainResult[] = [];
    for (const d of list) {
      if (stop.current) break;
      setCurrent(d);
      try {
        const r = (await api("/api/run-domain", pw, { method: "POST", body: JSON.stringify({ domain: d, profileId, send }) })) as DomainResult;
        out.push(r);
        if (r.reason.startsWith("abort:")) { setError(`Run stopped: ${r.reason.slice(6)}. Fix the key or quota, then run again.`); break; }
      } catch (e) {
        setError((e as Error).message);
        break;
      }
      setResults([...out]); setDone(out.length);
      localStorage.setItem(KEY, JSON.stringify(out));
    }
    setResults([...out]); localStorage.setItem(KEY, JSON.stringify(out));
    setRunning(false); setCurrent(null);
    api("/api/status", pw).then((s) => setStatus(s as StatusInfo)).catch(() => undefined);
  }

  const sorted = useMemo(() => [...results].sort((a, b) => rank(b) - rank(a)), [results]);
  const sel = sorted.find((r) => r.domain === selected) ?? null;

  function download(name: string, text: string, type: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }
  const csv = () => {
    const head = ["domain", "status", "reason", "score", "flags", "contact", "title", "tier", "tokens_in", "tokens_out"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    return [head.join(","), ...sorted.map((r) => [r.domain, r.status, r.reason, r.score, r.flags.join("|"), r.contact?.name, r.contact?.title, r.contact?.tier, r.tokens.prompt, r.tokens.output].map(esc).join(","))].join("\n");
  };

  const profile = profiles.find((p) => p.id === profileId);

  return (
    <main className="shell">
      <h1>Outreach engine</h1>
      <p className="lede">Paste company domains. For each one the engine checks fit, finds the right person, picks two likely pain points and drafts a first email. Every email goes to your own inbox in test mode, never to the prospect.</p>

      {!authed ? (
        <div className="panel" style={{ maxWidth: 420 }}>
          <label htmlFor="pw">App password</label>
          <input id="pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && connect()} autoComplete="current-password" />
          <div className="row"><button className="primary" onClick={() => connect()} disabled={!pw}>Unlock</button></div>
          {error && <div className="err" role="alert">{error}</div>}
        </div>
      ) : (
        <div className="grid">
          <section className="panel" aria-label="Run settings">
            <h2>New run</h2>
            <label htmlFor="profile">Seller profile</label>
            <select id="profile" value={profileId} onChange={(e) => setProfileId(e.target.value)} disabled={running}>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.seller} (v{p.version})</option>)}
            </select>
            {profile && <p className="muted" style={{ fontSize: 13 }}>{profile.icp}</p>}
            <label htmlFor="domains">Domains (one per line, up to 25)</label>
            <textarea id="domains" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder={"cal.com\nclay.com\nwarp.dev"} disabled={running} />
            <div className="row">
              <label style={{ margin: 0, display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={send} onChange={(e) => setSend(e.target.checked)} disabled={running} /> Send test emails to my inbox
              </label>
            </div>
            <div className="row">
              <button className="primary" onClick={run} disabled={running}>{running ? "Running" : "Run"}</button>
              {running && <button onClick={() => { stop.current = true; }}>Stop after this domain</button>}
            </div>
            {running && (
              <>
                <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}><div style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
                <p className="muted mono">{done} of {total} done. Working on {current}. Model calls are paced to stay inside free-tier limits, so each domain takes a minute or more.</p>
              </>
            )}
            {error && <div className="err" role="alert">{error}</div>}
            {status && (
              <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
                Keys: model {status.configured.llm ? "set" : "missing"}, Hunter {status.configured.hunter ? "set" : "missing"}, Gmail {status.configured.gmail ? "set" : "missing"}, inbox {status.configured.send_to ? "set" : "missing"}.
                {status.hunter?.available != null && <> Hunter searches left: <span className="mono">{status.hunter.available}</span>.</>}
              </p>
            )}
          </section>

          <section aria-label="Results">
            {sorted.length === 0 ? (
              <div className="panel empty">{running ? "First result will appear here." : "No results yet. Add domains and press Run."}</div>
            ) : (
              <div className="grid" style={{ gridTemplateColumns: "minmax(0, 300px) minmax(0, 1fr)", marginTop: 0 }}>
                <div>
                  <div className="row" style={{ marginTop: 0, marginBottom: 8 }}>
                    <button onClick={() => download("outreach-run.json", JSON.stringify(sorted, null, 2), "application/json")}>Download JSON</button>
                    <button onClick={() => download("outreach-run.csv", csv(), "text/csv")}>Download CSV</button>
                  </div>
                  <div className="list">
                    {sorted.map((r) => (
                      <button key={r.domain} className="item" aria-current={r.domain === selected} onClick={() => setSelected(r.domain)}>
                        <span className="mono">{r.domain}</span>
                        <span className="num">{r.score ?? ""}</span>
                        <span className="sub"><StatusBadge status={r.status} /> {r.contact ? `${r.contact.name}, ${r.contact.title}` : r.reason.slice(0, 70)}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div>{sel ? <DomainDetail r={sel} /> : <div className="panel empty">Select a domain to see the full decision story.</div>}</div>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
