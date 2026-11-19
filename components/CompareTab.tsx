"use client";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Comparison, ComparisonRow } from "@/lib/services/runs";
import type { DomainResult } from "@/lib/types";
import { StageBadge } from "./StatusBadge";
import { PageHead, Stat, download } from "./ui";
import { csvCell } from "@/lib/csv";
import { gateKey } from "@/lib/compare";
import { domainsFromCsv, parseDomains, useWorkspace, type ProfileInfo, type ProfileVersion } from "./workspace";

interface Opt { key: string; text: string; p: ProfileInfo; v?: ProfileVersion }
type Show = "all" | "changed" | "same";
const PAIR_KEY = "outreach:compare-pair";
const WORKING = ["queued", "researching", "gate_evaluation", "contact_lookup", "drafting"];
const live = (s: string) => s === "running" || s === "queued";
const gateLabel = (a: string) => (a === "skipped_due_to_cap" ? "SKIPPED_DUE_TO_CAP" : a.toUpperCase());
const gateCls = (a: string) => (a === "pass" ? "ok" : a === "fail" ? "bad" : "warn");
const delta = (n: number | null) => (n === null ? "–" : n > 0 ? `+${n}` : String(n));

function Cell({ r, run }: { r: ComparisonRow["a"]; run: string }) {
  if (!r) return <span className="faint">not in this run</span>;
  return (
    <div title={run}>
      <StageBadge stage={r.stage} /> <span className="num">{r.score ?? "–"}</span>
      {r.brief?.contact && <div className="faint" style={{ fontSize: 12.5 }}>{r.brief.contact.name}, {r.brief.contact.title}</div>}
    </div>
  );
}

/** Gate by gate, factor by factor, for one domain under both profiles. */
function PairDetail({ row, runA, runB, onOpen }: { row: ComparisonRow; runA: string; runB: string; onOpen: (runId: string, accountId: string) => void }) {
  const { api } = useWorkspace();
  const [res, setRes] = useState<{ a: DomainResult | null; b: DomainResult | null } | null>(null);
  const aId = row.a?.id; const aStage = row.a?.stage; const bId = row.b?.id; const bStage = row.b?.stage;
  useEffect(() => {
    let cancelled = false;
    const load = async (id: string | undefined, stage: string | undefined) => (id && stage && !WORKING.includes(stage) ? (await api<{ result: DomainResult | null }>(`/api/accounts/${id}`)).result : null);
    void Promise.all([load(aId, aStage), load(bId, bStage)]).then(([a, b]) => { if (!cancelled) setRes({ a, b }); }).catch(() => { if (!cancelled) setRes({ a: null, b: null }); });
    return () => { cancelled = true; };
  }, [api, aId, aStage, bId, bStage]);

  if (!res) return <p className="muted">Loading…</p>;
  const { a, b } = res;
  const gateIds = [...new Set([...(a?.gates ?? []).map(gateKey), ...(b?.gates ?? []).map(gateKey)])];
  const ga = new Map((a?.gates ?? []).map((g) => [gateKey(g), g])); const gb = new Map((b?.gates ?? []).map((g) => [gateKey(g), g]));
  const sigIds = [...new Set([...(a?.score_breakdown ?? []).map((s) => s.id), ...(b?.score_breakdown ?? []).map((s) => s.id)])];
  const sa = new Map((a?.score_breakdown ?? []).map((s) => [s.id, s])); const sb = new Map((b?.score_breakdown ?? []).map((s) => [s.id, s]));

  return (
    <div className="pair-detail">
      <div className="row tight" style={{ marginTop: 0 }}>
        {row.a && <button className="small" onClick={() => onOpen(runA, row.a!.id)}>Open A in Results</button>}
        {row.b && <button className="small" onClick={() => onOpen(runB, row.b!.id)}>Open B in Results</button>}
      </div>
      {a && b && (
        <div className="stats" style={{ marginTop: 12 }}>
          <Stat k="Outcome" v={<>{a.status.replace(/_/g, " ")} → {b.status.replace(/_/g, " ")}</>} />
          <Stat k="Score" v={`${a.score ?? "–"} → ${b.score ?? "–"}`} />
          <Stat k="Contact" v={<span style={{ fontSize: 16 }}>{a.contact?.name ?? "none"} → {b.contact?.name ?? "none"}</span>} />
        </div>
      )}
      <h3>Gates, side by side</h3>
      {gateIds.length === 0 ? <p className="muted">No gates were evaluated by either profile.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Check</th><th>Profile A</th><th>Profile B</th></tr></thead>
          <tbody>{gateIds.map((id) => {
            const x = ga.get(id); const y = gb.get(id); const differs = (x?.answer ?? "not run") !== (y?.answer ?? "not run");
            return (
              <tr key={id} className={differs ? "diff-row" : ""}>
                <td><strong>{(x ?? y)!.id}</strong><div className="muted">{(x ?? y)!.question}</div></td>
                {[x, y].map((g, i) => <td key={i}>{g ? <><span className={`badge ${gateCls(g.answer)}`}>{gateLabel(g.answer)}</span><div className="muted" style={{ marginTop: 4 }}>{g.evidence}</div></> : <span className="faint">not evaluated</span>}</td>)}
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
      {sigIds.length > 0 && (
        <>
          <h3>Score factors</h3>
          <div className="table-wrap"><table>
            <thead><tr><th>Signal</th><th className="num">A points</th><th className="num">B points</th><th>A reason</th><th>B reason</th></tr></thead>
            <tbody>{sigIds.map((id) => (
              <tr key={id} className={(sa.get(id)?.points ?? 0) !== (sb.get(id)?.points ?? 0) ? "diff-row" : ""}>
                <td>{id}</td><td className="num">{sa.get(id)?.points ?? "–"}</td><td className="num">{sb.get(id)?.points ?? "–"}</td>
                <td>{sa.get(id)?.evidence ?? <span className="faint">–</span>}</td><td>{sb.get(id)?.evidence ?? <span className="faint">–</span>}</td>
              </tr>))}</tbody>
          </table></div>
        </>
      )}
      {(a?.contact || b?.contact) && (
        <>
          <h3>Contact choice</h3>
          <div className="field-grid">
            {[a, b].map((r, i) => (
              <div className="card" key={i}><strong>{i === 0 ? "A" : "B"}:</strong> {r?.contact ? <>{r.contact.name}, {r.contact.title} <span className="badge plain info">tier {r.contact.tier ?? "–"}</span><p className="hint">{r.contact.reason}</p></> : <span className="muted">no contact chosen</span>}</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function CompareTab() {
  const { profiles, runs, api, driveMany, driving, setActiveRunId, setSelected, setTab, refreshRuns, error, setError, notify, current } = useWorkspace();
  const pairKey = `${PAIR_KEY}:${current?.id ?? ""}`;
  const options = useMemo<Opt[]>(() => profiles.flatMap<Opt>((p) => (p.versions.length ? p.versions.map((v) => ({ key: v.dbId, text: `${p.seller} (${p.id}) v${v.version}`, p, v })) : [{ key: p.id, text: `${p.seller} (${p.id}) v${p.version}`, p }])), [profiles]);
  const [mode, setMode] = useState<"new" | "runs">("new");
  const [a, setA] = useState(options[0]?.key ?? "");
  const [b, setB] = useState(options.find((o) => o.key !== options[0]?.key)?.key ?? "");
  const [text, setText] = useState("");
  const [runA, setRunA] = useState(""); const [runB, setRunB] = useState("");
  const [pair, setPair] = useState<{ a: string; b: string } | null>(null);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [show, setShow] = useState<Show>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const parsed = useMemo(() => parseDomains(text), [text]);
  const oa = options.find((o) => o.key === a); const ob = options.find((o) => o.key === b);
  const cap = Math.min(oa?.p.detail.limits.max_accounts_per_run ?? 25, ob?.p.detail.limits.max_accounts_per_run ?? 25);

  useEffect(() => { try { const p = JSON.parse(localStorage.getItem(pairKey) ?? "null") as { a: string; b: string } | null; if (p?.a && p?.b) setPair(p); } catch { /* ignore */ } }, [pairKey]);
  useEffect(() => { try { if (pair) localStorage.setItem(pairKey, JSON.stringify(pair)); else localStorage.removeItem(pairKey); } catch { /* ignore */ } }, [pair, pairKey]);

  // Keep the comparison fresh while either run is still moving.
  useEffect(() => {
    if (!pair) { setCmp(null); return; }
    let cancelled = false;
    void (async () => {
      for (;;) {
        try {
          const r = await api<{ comparison: Comparison }>(`/api/compare?a=${pair.a}&b=${pair.b}`);
          if (cancelled) return;
          setCmp(r.comparison);
          if (!live(r.comparison.a.status) && !live(r.comparison.b.status)) { void refreshRuns(); return; }
        } catch (e) { if (!cancelled) { setError((e as Error).message); setPair(null); } return; }
        await new Promise((r) => setTimeout(r, 3000));
        if (cancelled) return;
      }
    })();
    return () => { cancelled = true; };
  }, [pair, api, refreshRuns, setError, driving]);

  const groups = useMemo(() => {
    const m = new Map<string, typeof runs>();
    for (const r of runs) if (r.comparison_group) m.set(r.comparison_group, [...(m.get(r.comparison_group) ?? []), r]);
    return [...m.values()].filter((g) => g.length === 2).map((g) => [...g].sort((x, y) => x.id.localeCompare(y.id)));
  }, [runs]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    const csv = domainsFromCsv(await f.text());
    setText((t) => (t.trim() ? `${t.trim()}\n${csv}` : csv));
    if (file.current) file.current.value = "";
  }

  async function start() {
    if (!oa || !ob) return;
    setStarting(true); setError(null);
    try {
      const r = await api<{ runA: string; runB: string; queued: number; capped: number; cap: number }>("/api/comparisons", {
        method: "POST", body: JSON.stringify({ a: { profileId: oa.p.id, profileRef: oa.v?.dbId }, b: { profileId: ob.p.id, profileRef: ob.v?.dbId }, domains: parsed.valid }),
      });
      if (r.capped > 0) notify(`${r.capped} domain${r.capped > 1 ? "s" : ""} over the cap of ${r.cap} were set aside in both runs`);
      setPair({ a: r.runA, b: r.runB }); setText(""); void refreshRuns();
      driveMany([r.runA, r.runB]);
    } catch (e) { setError((e as Error).message); }
    setStarting(false);
  }

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (cmp?.rows ?? []).filter((r) => (show === "all" || (show === "changed" ? r.diff?.verdict === "changed" : r.diff?.verdict === "same")) && (!needle || r.domain.includes(needle)));
  }, [cmp, show, q]);

  const csv = () => {
    const head = ["domain", "a_stage", "b_stage", "a_score", "b_score", "score_delta", "gate_changes", "contact_a", "contact_b", "verdict"];
    return [head.map(csvCell).join(","), ...(cmp?.rows ?? []).map((r) => [r.domain, r.a?.stage, r.b?.stage, r.a?.score, r.b?.score, r.diff?.scoreDelta, r.diff?.gateChanges.map((g) => `${g.id}:${g.a}>${g.b}`).join("|"), r.a?.brief?.contact?.name, r.b?.brief?.contact?.name, r.diff?.verdict ?? "incomplete"].map(csvCell).join(","))].join("\r\n") + "\r\n";
  };

  function openIn(runId: string, accountId: string) { setActiveRunId(runId); setTimeout(() => { setSelected(accountId); setTab("results"); }, 0); }
  const s = cmp?.summary;
  const anyLive = cmp ? live(cmp.a.status) || live(cmp.b.status) : false;
  const runLabel = (r: (typeof runs)[number]) => `${new Date(r.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${r.profile} · ${r.accounts} accounts`;

  return (
    <>
      <PageHead title="Compare profiles" lede="Run the same domains under two profiles and see exactly where the answers differ: which gate, which score factor, which contact. Both runs are saved." />
      <div className="panel">
        <div className="subtabs" role="tablist" style={{ marginTop: 0 }}>
          <button role="tab" className="subtab" aria-selected={mode === "new"} onClick={() => setMode("new")}>New comparison</button>
          <button role="tab" className="subtab" aria-selected={mode === "runs"} onClick={() => setMode("runs")}>Compare existing runs</button>
        </div>

        {mode === "new" ? (
          <>
            <div className="field-grid">
              <div><label htmlFor="pa">Profile A (baseline)</label><select id="pa" value={a} onChange={(e) => setA(e.target.value)}>{options.map((o) => <option key={o.key} value={o.key}>{o.text}</option>)}</select></div>
              <div><label htmlFor="pb">Profile B (changed)</label><select id="pb" value={b} onChange={(e) => setB(e.target.value)}>{options.map((o) => <option key={o.key} value={o.key}>{o.text}</option>)}</select></div>
            </div>
            <label htmlFor="cd">Domains</label>
            <textarea id="cd" value={text} onChange={(e) => setText(e.target.value)} placeholder={"cal.com\nclay.com\nwarp.dev"} spellCheck={false} style={{ minHeight: 90 }} />
            <div className="row tight">
              <span className={`badge plain ${parsed.valid.length ? "ok" : ""}`}>{parsed.valid.length} valid</span>
              {parsed.dupes > 0 && <span className="badge plain info">{parsed.dupes} duplicate{parsed.dupes > 1 ? "s" : ""} removed</span>}
              {parsed.invalid.length > 0 && <span className="badge plain bad">{parsed.invalid.length} not a domain</span>}
              <span className="spacer" />
              <input ref={file} type="file" accept=".csv,.txt" className="sr-only" id="ccsv" onChange={(e) => void onFile(e.target.files?.[0])} />
              <label htmlFor="ccsv" className="btn small">Upload CSV</label>
            </div>
            <p className="hint">Both runs use the lower of the two profiles' caps ({cap} accounts){parsed.valid.length > cap ? `, so ${parsed.valid.length - cap} will be set aside in both` : ""}. Accounts are processed in turn, A then B, so B reuses the pages A fetched and the profiles are the only difference.</p>
            {a === b && <p className="err">Pick two different profiles or versions.</p>}
            <div className="row"><button className="primary" onClick={start} disabled={starting || a === b || parsed.valid.length === 0 || !oa || !ob}>{starting ? "Starting…" : "Start comparison"}</button></div>
          </>
        ) : (
          <>
            <div className="field-grid">
              <div><label htmlFor="ra">Run A</label><select id="ra" value={runA} onChange={(e) => setRunA(e.target.value)}><option value="">Choose a run</option>{runs.map((r) => <option key={r.id} value={r.id}>{runLabel(r)}</option>)}</select></div>
              <div><label htmlFor="rb">Run B</label><select id="rb" value={runB} onChange={(e) => setRunB(e.target.value)}><option value="">Choose a run</option>{runs.map((r) => <option key={r.id} value={r.id}>{runLabel(r)}</option>)}</select></div>
            </div>
            <p className="hint">Rows are paired by domain. Domains that are in only one run are shown with the other side empty.</p>
            <div className="row"><button className="primary" disabled={!runA || !runB || runA === runB} onClick={() => setPair({ a: runA, b: runB })}>Compare</button></div>
          </>
        )}
        {error && <div className="err" role="alert">{error}</div>}
      </div>

      {groups.length > 0 && (
        <div className="row tight" style={{ marginTop: 12 }} aria-label="Recent comparisons">
          <span className="muted">Recent:</span>
          {groups.slice(0, 5).map((g) => <button key={g[0].comparison_group} className="chip" aria-pressed={pair?.a === g[0].id && pair?.b === g[1].id} onClick={() => setPair({ a: g[0].id, b: g[1].id })}>{g[0].profile} vs {g[1].profile}</button>)}
        </div>
      )}

      {pair && cmp && s && (
        <section style={{ marginTop: 16 }} aria-label="Comparison" aria-live="polite">
          <div className="panel-head">
            <h2>{cmp.a.profile.name} v{cmp.a.profile.version} <span className="muted">vs</span> {cmp.b.profile.name} v{cmp.b.profile.version}</h2>
            <div className="row tight" style={{ marginTop: 0 }}>
              {anyLive && !driving && <button className="primary" onClick={() => driveMany([cmp.a, cmp.b].filter((x) => live(x.status)).map((x) => x.id))}>Continue in this tab</button>}
              <button onClick={() => download("profile-comparison.csv", csv(), "text/csv")}>Export CSV</button>
              <button className="ghost" onClick={() => { setPair(null); setOpen(null); }}>Close</button>
            </div>
          </div>
          {anyLive && <div className="banner info"><span>{driving ? "Working through both runs in turn. Keep this tab open, or run `npm run worker` in a terminal." : "Not finished. Continue here, or run `npm run worker` in a terminal."} A: {cmp.a.totals.done}/{cmp.a.totals.accounts} done · B: {cmp.b.totals.done}/{cmp.b.totals.accounts} done.</span></div>}

          <div className="stats">
            <Stat k="Domains" v={s.domains} s={`${s.compared} compared${s.onlyA || s.onlyB ? ` · ${s.onlyA} only in A · ${s.onlyB} only in B` : ""}`} />
            <Stat k="Changed" v={s.changed} s={`${s.statusChanged} changed outcome`} />
            <Stat k="Qualified" v={`${s.a.qualified} → ${s.b.qualified}`} s="A → B" />
            <Stat k="Disqualified" v={`${s.a.disqualified} → ${s.b.disqualified}`} s="A → B" />
            <Stat k="Avg score" v={`${s.a.avgScore ?? "–"} → ${s.b.avgScore ?? "–"}`} s={`tokens ${s.a.tokens.toLocaleString()} → ${s.b.tokens.toLocaleString()}`} />
          </div>

          <div className="row tight" style={{ marginTop: 0 }}>
            {(["all", "changed", "same"] as Show[]).map((f) => <button key={f} className="chip" aria-pressed={show === f} onClick={() => setShow(f)}>{f === "all" ? "All" : f === "changed" ? "Changed" : "Same"} <span className="n">{f === "all" ? cmp.rows.length : cmp.rows.filter((r) => r.diff?.verdict === f).length}</span></button>)}
            <span className="spacer" />
            <input type="text" placeholder="Search domain" aria-label="Search domains" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
          </div>

          <div className="table-wrap" style={{ marginTop: 12 }}><table>
            <thead><tr><th>Domain</th><th>A · {cmp.a.profile.slug} v{cmp.a.profile.version}</th><th>B · {cmp.b.profile.slug} v{cmp.b.profile.version}</th><th className="num">Score Δ</th><th>What changed</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 24 }}>Nothing here yet.</td></tr>}
              {rows.map((r) => (
                <Fragment key={r.domain}>
                  <tr className="clickable" aria-selected={open === r.domain} tabIndex={0} onClick={() => setOpen(open === r.domain ? null : r.domain)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(open === r.domain ? null : r.domain); } }}>
                    <td className="mono">{r.domain}</td>
                    <td><Cell r={r.a} run={cmp.a.id} /></td><td><Cell r={r.b} run={cmp.b.id} /></td>
                    <td className="num">{delta(r.diff?.scoreDelta ?? null)}</td>
                    <td>{!r.diff ? <span className="faint">{r.a && r.b ? "waiting for both" : "one side only"}</span> : r.diff.verdict === "same" ? <span className="muted">no difference</span> : <>{r.diff.statusChanged && <span className="tag">outcome</span>}{r.diff.gateChanges.map((g) => <span className="tag" key={g.id + g.question} title={g.question}>{g.id}</span>)}{r.diff.contactChanged && <span className="tag">contact</span>}{(r.diff.scoreDelta ?? 0) !== 0 && <span className="tag">score</span>}{r.diff.flagsAdded.length + r.diff.flagsRemoved.length > 0 && <span className="tag">flags</span>}</>}</td>
                  </tr>
                  {open === r.domain && <tr><td colSpan={5}><PairDetail row={r} runA={cmp.a.id} runB={cmp.b.id} onOpen={openIn} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table></div>
          <p className="hint">Click a row for the gate-by-gate and factor-by-factor comparison.</p>
        </section>
      )}
    </>
  );
}
