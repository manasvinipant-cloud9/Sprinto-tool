"use client";
import { useMemo, useRef, useState } from "react";
import { StageBadge } from "./StatusBadge";
import { PageHead, Stat } from "./ui";
import { domainsFromCsv, parseDomains, useWorkspace } from "./workspace";

const fmt = (n: number) => n.toLocaleString();
const usd = (n: number) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

export function RunTab() {
  const { profiles, status, error, setError, setTab, createRun, activeRun, driving, drive, controlRun, runs, setActiveRunId, setSelected, deleteRun } = useWorkspace();
  const [profileId, setProfileId] = useState(() => { try { return localStorage.getItem("outreach:profile") ?? ""; } catch { return ""; } });
  const [text, setText] = useState("");
  const [starting, setStarting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const profile = profiles.find((p) => p.id === profileId) ?? profiles.find((p) => !p.id.endsWith("-example")) ?? profiles[0];
  const parsed = useMemo(() => parseDomains(text), [text]);
  const cap = profile?.detail.limits.max_accounts_per_run ?? 25;
  const willRun = Math.min(parsed.valid.length, cap);
  const overCap = Math.max(0, parsed.valid.length - cap);
  const missing = status ? Object.entries(status.configured).filter(([, v]) => !v).map(([k]) => k) : [];
  const readonly = profiles.length > 0 && profiles.every((p) => p.readonly);
  const live = activeRun && (activeRun.status === "running" || activeRun.status === "queued");

  async function go() {
    if (!profile) return;
    if (parsed.valid.length === 0) { setError("Add at least one valid domain."); return; }
    setStarting(true);
    try { await createRun(profile.id, parsed.valid); setText(""); } catch (e) { setError((e as Error).message); }
    setStarting(false);
  }

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 1_000_000) { setError("That file is over 1 MB. Use a list of domains."); return; }
    const csv = domainsFromCsv(await f.text());
    setText((t) => (t.trim() ? `${t.trim()}\n${csv}` : csv));
    if (file.current) file.current.value = "";
  }

  const t = activeRun?.totals;
  return (
    <>
      <PageHead title="New run" lede="Pick a profile and paste domains or upload a CSV. Runs are saved, work through the queue one account at a time, and stop at a draft for you to review." />
      <div className="banner info" role="note">
        <span aria-hidden>🔒</span>
        <span><strong>Nothing is ever sent.</strong> The app stops at a draft for you to review. Copy or export what you approve.</span>
      </div>
      {readonly && <div className="banner bad" role="alert"><span><strong>Runs need the database.</strong> It is not set up on this server. Ask whoever runs the app to connect it.</span></div>}
      {missing.length > 0 && !readonly && (
        <div className="banner warn" role="alert"><span><strong>Not configured:</strong> {missing.join(", ")}. See the System tab.</span></div>
      )}

      <div className="grid-2">
        <section className="panel" aria-label="New run">
          <label htmlFor="profile">Seller profile</label>
          <select id="profile" value={profile?.id ?? ""} onChange={(e) => { setProfileId(e.target.value); try { localStorage.setItem("outreach:profile", e.target.value); } catch { /* ignore */ } }}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.seller} (v{p.version})</option>)}
          </select>
          {profile && <p className="hint">{profile.icp} <button className="ghost small" onClick={() => setTab("profiles")}>View profile</button></p>}

          <label htmlFor="domains">Domains</label>
          <textarea id="domains" value={text} onChange={(e) => setText(e.target.value)} placeholder={"cal.com\nclay.com\nwarp.dev"} spellCheck={false} aria-describedby="domhint" />
          <div className="row tight" id="domhint" style={{ marginTop: 6 }}>
            <span className={`badge plain ${parsed.valid.length ? "ok" : ""}`}>{parsed.valid.length} valid</span>
            {parsed.dupes > 0 && <span className="badge plain info">{parsed.dupes} duplicate{parsed.dupes > 1 ? "s" : ""} removed</span>}
            {parsed.invalid.length > 0 && <span className="badge plain bad" title={parsed.invalid.join(", ")}>{parsed.invalid.length} not a domain</span>}
            <span className="spacer" />
            <input ref={file} type="file" accept=".csv,.txt,text/csv,text/plain" className="sr-only" id="csv" onChange={(e) => void onFile(e.target.files?.[0])} />
            <label htmlFor="csv" className="btn small" style={{ margin: 0, cursor: "pointer" }}>Upload CSV</label>
            <button className="ghost small" onClick={() => setText("cal.com\nclay.com\nwarp.dev")}>Try sample</button>
            {text && <button className="ghost small" onClick={() => setText("")}>Clear</button>}
          </div>
          <p className="hint">One per line or comma separated. CSV: a column headed domain, website or url, otherwise the first column. Protocols, www and paths are stripped.</p>

          <div className={`banner ${overCap > 0 ? "warn" : ""}`} style={{ marginTop: 12, marginBottom: 0 }}>
            <span>This profile allows <strong>{cap}</strong> accounts per run.{overCap > 0 ? <> The first <strong>{willRun}</strong> will run and <strong>{overCap}</strong> will be listed as capped, not discarded.</> : parsed.valid.length ? <> All <strong>{willRun}</strong> will run.</> : null}</span>
          </div>

          <div className="row">
            <button className="primary" onClick={go} disabled={starting || readonly || parsed.valid.length === 0 || !profile}>{starting ? "Starting…" : willRun > 1 ? `Start run (${willRun} accounts)` : "Start run"}</button>
          </div>
          {error && <div className="err" role="alert">{error}</div>}
        </section>

        <section className="panel" aria-label="Live run" aria-live="polite">
          {!activeRun ? (
            <div className="empty"><h2>No run open</h2><p className="hint">Start a run, or open a recent one below.</p></div>
          ) : (
            <>
              <div className="panel-head">
                <div><h2>{activeRun.profile.name} <span className="faint mono" style={{ fontSize: 13 }}>v{activeRun.profile.version} · {activeRun.profile.hash}</span></h2>
                  <span className="muted">Started {new Date(activeRun.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span></div>
                <span className={`badge ${activeRun.status === "finished" ? "ok" : activeRun.status === "paused" ? "warn" : activeRun.status === "failed" ? "bad" : "info"}`}>{activeRun.status}</span>
              </div>
              {activeRun.note && <div className="banner warn"><span>{activeRun.note}</span></div>}
              {t && (
                <div className="stats">
                  <Stat k="Accounts" v={`${t.done}/${t.accounts}`} s={t.capped ? `${t.capped} capped` : undefined} />
                  <Stat k="Loop steps" v={fmt(t.loop_steps)} s={`${t.fetches} fetches · ${t.searches} searches`} />
                  <Stat k="Tokens" v={fmt(t.tokens_in + t.tokens_out)} s={`${fmt(t.tokens_in)} in · ${fmt(t.tokens_out)} out`} />
                  <Stat k="Est. cost" v={usd(t.est_cost_usd)} s="estimate, list prices" />
                </div>
              )}
              {t && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={t.accounts} aria-valuenow={t.done}><div style={{ width: `${t.accounts ? (t.done / t.accounts) * 100 : 0}%` }} /></div>}
              <div className="row">
                {activeRun.status === "paused" && <button className="primary" onClick={() => void controlRun("resume")}>Resume</button>}
                {live && driving && <button onClick={() => void controlRun("pause")}>Pause</button>}
                {live && !driving && <button className="primary" onClick={() => drive()}>Continue in this tab</button>}
                {activeRun.accounts.some((a) => a.stage === "error") && !driving && <button onClick={() => void controlRun("retry_failed")}>Retry {activeRun.accounts.filter((a) => a.stage === "error").length} failed</button>}
                <span className="spacer" />
                <button className="primary" onClick={() => setTab("results")}>Open results</button>
              </div>
              {live && !driving && <p className="hint">Nothing in this tab is working on the queue. Continue here, or run <code>npm run worker</code> in a terminal to process it without a browser.</p>}
              {live && driving && <p className="hint">Working through the queue. Keep this tab open, or pause and run <code>npm run worker</code> instead. Free-tier pacing means a minute or more per account.</p>}

              <div className="table-wrap" style={{ marginTop: 12 }}><table>
                <thead><tr><th>Account</th><th>Stage</th><th className="num">Score</th><th className="num">Steps</th><th className="num">Tokens</th></tr></thead>
                <tbody>{activeRun.accounts.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => { setSelected(a.id); setTab("results"); }}>
                    <td className="mono">{a.domain}{a.reason && (a.stage === "capped" || a.stage === "error") && <div className="faint" style={{ fontFamily: "var(--font-body)" }}>{a.reason}</div>}</td>
                    <td><StageBadge stage={a.stage} /></td>
                    <td className="num">{a.score ?? "–"}</td>
                    <td className="num">{a.loop_steps}/{activeRun.caps.max_loop_steps}</td>
                    <td className="num">{fmt(a.tokens_in + a.tokens_out)}</td>
                  </tr>))}</tbody>
              </table></div>
            </>
          )}
        </section>
      </div>

      {runs.length > 0 && (
        <section className="panel" style={{ marginTop: 16 }} aria-label="Recent runs">
          <div className="panel-head"><h2>Recent runs</h2></div>
          <div className="table-wrap"><table>
            <thead><tr><th>Started</th><th>Profile</th><th className="num">Accounts</th><th className="num">Ready</th><th className="num">Disqualified</th><th className="num">Capped</th><th className="num">Errors</th><th>Status</th><th /></tr></thead>
            <tbody>{runs.map((r) => (
              <tr key={r.id} className="clickable" aria-selected={r.id === activeRun?.id} onClick={() => setActiveRunId(r.id)}>
                <td>{new Date(r.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</td><td>{r.profile}</td>
                <td className="num">{r.accounts}</td><td className="num">{r.ready}</td><td className="num">{r.disqualified}</td><td className="num">{r.capped}</td><td className="num">{r.errors}</td>
                <td><span className="badge plain">{r.status}</span></td>
                <td><button className="ghost small danger" onClick={(e) => { e.stopPropagation(); if (confirm("Delete this run, its results and drafts? This cannot be undone.")) void deleteRun(r.id); }}>Delete</button></td>
              </tr>))}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}
