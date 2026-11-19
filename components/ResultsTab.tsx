"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AccountBrief } from "@/lib/services/runs";
import { rankKey } from "@/lib/evidence";
import { DomainDetail } from "./DomainDetail";
import { PageHead, Stat } from "./ui";
import { useWorkspace } from "./workspace";

type Qual = "all" | "qualified" | "disqualified" | "capped" | "error";
type DraftF = "all" | "pending_review" | "approved" | "rejected" | "no_draft";
type SortKey = "rank" | "company" | "score" | "qualification" | "draft";
type ColKey = "company" | "domain" | "score" | "qualification" | "personas" | "evidence" | "draft";

const COLS: { key: ColKey; label: string; sort?: SortKey }[] = [
  { key: "company", label: "Company", sort: "company" }, { key: "domain", label: "Domain" }, { key: "score", label: "Fit score", sort: "score" },
  { key: "qualification", label: "Qualification", sort: "qualification" }, { key: "personas", label: "Matched persona(s)" },
  { key: "evidence", label: "Evidence summary" }, { key: "draft", label: "Draft", sort: "draft" },
];
const QUAL_LABEL: Record<Qual, string> = { all: "All", qualified: "Qualified", disqualified: "Disqualified", capped: "Capped", error: "Errors" };
const DRAFT_LABEL: Record<DraftF, string> = { all: "Any draft", pending_review: "Pending review", approved: "Approved", rejected: "Rejected", no_draft: "No draft" };
const PREF_KEY = "outreach:table:v1";
const WORKING = ["queued", "researching", "gate_evaluation", "contact_lookup", "drafting"];

const qualOf = (a: AccountBrief): Exclude<Qual, "all"> => (a.stage === "error" ? "error" : a.qualification ?? (WORKING.includes(a.stage) ? "qualified" : "error"));
const draftOf = (a: AccountBrief): Exclude<DraftF, "all"> => (a.draft ? (a.draft.review_status as Exclude<DraftF, "all">) : "no_draft");
const company = (a: AccountBrief) => a.brief?.company || a.domain;

function QualBadge({ a }: { a: AccountBrief }) {
  if (WORKING.includes(a.stage)) return <span className="badge info">{a.stage === "queued" ? "Queued" : "Working"}</span>;
  const q = qualOf(a);
  return <span className={`badge ${q === "qualified" ? "ok" : q === "disqualified" ? "bad" : q === "capped" ? "warn" : "bad"}`}>{q === "error" ? "Error" : q[0].toUpperCase() + q.slice(1)}</span>;
}
function DraftBadge({ a }: { a: AccountBrief }) {
  const d = draftOf(a);
  return <span className={`badge ${d === "approved" ? "ok" : d === "pending_review" ? "info" : d === "rejected" ? "bad" : "plain"}`}>{d === "no_draft" ? "No draft" : d === "pending_review" ? "Pending review" : d[0].toUpperCase() + d.slice(1)}</span>;
}

export function ResultsTab() {
  const { runs, activeRun, setActiveRunId, selected, setSelected, detail, detailLoading, setTab, fetchRaw, notify } = useWorkspace();
  const [qual, setQual] = useState<Qual>("all");
  const [draftF, setDraftF] = useState<DraftF>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "rank", dir: 1 });
  const [cols, setCols] = useState<ColKey[]>(COLS.map((c) => c.key));
  const [colMenu, setColMenu] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Remember sort, filters and visible columns between visits.
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null") as { qual?: Qual; draftF?: DraftF; sort?: typeof sort; cols?: ColKey[] } | null;
      if (p?.qual) setQual(p.qual); if (p?.draftF) setDraftF(p.draftF); if (p?.sort) setSort(p.sort);
      if (p?.cols?.length) setCols(p.cols.filter((c) => COLS.some((x) => x.key === c)));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { try { localStorage.setItem(PREF_KEY, JSON.stringify({ qual, draftF, sort, cols })); } catch { /* ignore */ } }, [qual, draftF, sort, cols]);

  const accounts = useMemo(() => activeRun?.accounts ?? [], [activeRun]);
  const counts = useMemo(() => {
    const c: Record<Qual, number> = { all: accounts.length, qualified: 0, disqualified: 0, capped: 0, error: 0 };
    accounts.forEach((a) => { if (!WORKING.includes(a.stage)) c[qualOf(a)]++; });
    return c;
  }, [accounts]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const f = accounts.filter((a) =>
      (qual === "all" || (!WORKING.includes(a.stage) && qualOf(a) === qual)) && (draftF === "all" || draftOf(a) === draftF) &&
      (!needle || a.domain.includes(needle) || company(a).toLowerCase().includes(needle) || (a.brief?.contact?.name ?? "").toLowerCase().includes(needle) || (a.brief?.evidence_summary ?? "").toLowerCase().includes(needle)));
    const cmp: Record<SortKey, (a: AccountBrief, b: AccountBrief) => number> = {
      rank: (a, b) => rankKey(b.stage, Boolean(b.draft), b.score) - rankKey(a.stage, Boolean(a.draft), a.score),
      company: (a, b) => company(a).localeCompare(company(b)),
      score: (a, b) => (b.score ?? -1) - (a.score ?? -1),
      qualification: (a, b) => qualOf(a).localeCompare(qualOf(b)),
      draft: (a, b) => draftOf(a).localeCompare(draftOf(b)),
    };
    return [...f].sort((a, b) => sort.dir * (cmp[sort.key](a, b) || a.position - b.position));
  }, [accounts, qual, draftF, q, sort]);

  const sel = accounts.find((a) => a.id === selected) ?? null;
  const t = activeRun?.totals;
  const show = (k: ColKey) => cols.includes(k);
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: key === "company" || key === "qualification" || key === "draft" ? 1 : 1 }));

  // Drawer: Escape closes, focus moves in.
  useEffect(() => {
    if (!sel) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, setSelected]);

  async function exportCsv(scope: "all" | "qualified") {
    if (!activeRun) return;
    try {
      const res = await fetchRaw(`/api/runs/${activeRun.id}/export?scope=${scope}`);
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Export failed");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob());
      a.download = `shortlist-${activeRun.id.slice(0, 8)}-${scope}.csv`; a.click(); URL.revokeObjectURL(a.href);
      notify(scope === "qualified" ? "Exported qualified accounts" : "Exported full shortlist");
    } catch (e) { notify((e as Error).message); }
  }

  if (runs.length === 0 && !activeRun) {
    return (
      <>
        <PageHead title="Results" />
        <div className="panel empty">
          <h2>No runs yet</h2>
          <p>Start a run and a ranked, evidence-backed shortlist lands here.</p>
          <div className="row" style={{ justifyContent: "center" }}><button className="primary" onClick={() => setTab("run")}>Start a run</button></div>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHead title="Results" lede="A ranked shortlist you can use without sending anything. Every score and gate links to the words and page it came from. Open an account for the full story.">
        <select aria-label="Run" value={activeRun?.id ?? ""} onChange={(e) => setActiveRunId(e.target.value || null)} style={{ width: "auto", maxWidth: 340 }}>
          {!activeRun && <option value="">Choose a run</option>}
          {runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {r.profile} · {r.accounts} accounts{r.status !== "finished" ? ` (${r.status})` : ""}</option>)}
        </select>
        <button onClick={() => void exportCsv("all")} disabled={!activeRun}>Export CSV</button>
        <button onClick={() => void exportCsv("qualified")} disabled={!activeRun}>Qualified only</button>
      </PageHead>

      {!activeRun ? <div className="panel empty"><p>Choose a run above.</p></div> : (
        <>
          <div className="stats">
            <Stat k="Accounts" v={counts.all} s={activeRun.status === "running" ? "run in progress" : activeRun.status} />
            <Stat k="Qualified" v={counts.qualified} s={`${counts.all ? Math.round((counts.qualified / counts.all) * 100) : 0}% of run`} />
            <Stat k="Disqualified" v={counts.disqualified} />
            <Stat k="Capped" v={counts.capped} s="set aside by a cap" />
            <Stat k="Tokens" v={t ? (t.tokens_in + t.tokens_out).toLocaleString() : 0} s={t ? `est. $${t.est_cost_usd.toFixed(3)}` : undefined} />
          </div>

          <div className="row tight" style={{ marginTop: 0 }} role="group" aria-label="Filter by qualification">
            {(Object.keys(QUAL_LABEL) as Qual[]).map((f) => <button key={f} className="chip" aria-pressed={qual === f} onClick={() => setQual(f)}>{QUAL_LABEL[f]} <span className="n">{counts[f]}</span></button>)}
            <span className="spacer" />
            <select aria-label="Draft status" value={draftF} onChange={(e) => setDraftF(e.target.value as DraftF)} style={{ width: "auto" }}>
              {(Object.keys(DRAFT_LABEL) as DraftF[]).map((d) => <option key={d} value={d}>{DRAFT_LABEL[d]}</option>)}
            </select>
            <input type="text" placeholder="Search company, contact or evidence" aria-label="Search results" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 240 }} />
            <div style={{ position: "relative" }}>
              <button onClick={() => setColMenu((v) => !v)} aria-expanded={colMenu}>Columns</button>
              {colMenu && (
                <div className="menu" role="menu">
                  {COLS.map((c) => (
                    <label key={c.key} className="check" style={{ margin: 0, padding: "4px 0" }}>
                      <input type="checkbox" checked={show(c.key)} disabled={show(c.key) && cols.length === 1} onChange={() => setCols((cs) => (cs.includes(c.key) ? cs.filter((x) => x !== c.key) : COLS.map((x) => x.key).filter((k) => k === c.key || cs.includes(k))))} /> {c.label}
                    </label>
                  ))}
                  <button className="ghost small" onClick={() => setCols(COLS.map((c) => c.key))}>Show all</button>
                </div>
              )}
            </div>
          </div>

          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>{COLS.filter((c) => show(c.key)).map((c) => (
                  <th key={c.key} className={c.key === "score" ? "num" : ""} aria-sort={c.sort && sort.key === c.sort ? (sort.dir === 1 ? "ascending" : "descending") : undefined}>
                    {c.sort ? <button className="th-sort" onClick={() => toggleSort(c.sort!)}>{c.label}{sort.key === c.sort ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</button> : c.label}
                  </th>))}</tr>
              </thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={cols.length} className="muted" style={{ textAlign: "center", padding: 24 }}>{accounts.length === 0 ? "No accounts in this run." : "Nothing matches these filters."}</td></tr>}
                {rows.map((a) => (
                  <tr key={a.id} className="clickable" aria-selected={a.id === selected} tabIndex={0} onClick={() => setSelected(a.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(a.id); } }}>
                    {show("company") && <td><strong>{company(a)}</strong></td>}
                    {show("domain") && <td className="mono">{a.domain}</td>}
                    {show("score") && <td className="num">{a.score ?? "–"}{a.score != null && <span className="score-bar"><i style={{ width: `${Math.min(100, a.score)}%` }} /></span>}</td>}
                    {show("qualification") && <td><QualBadge a={a} /></td>}
                    {show("personas") && <td>{a.brief?.contact ? <>{a.brief.contact.title}{a.brief.personas.tiers.length > 0 && <div className="faint" style={{ fontSize: 12 }}>{a.brief.personas.tiers.map((x) => `Tier ${x}${x === a.brief!.personas.chosen ? " ✓" : ""}`).join(" · ")}</div>}</> : <span className="faint">–</span>}</td>}
                    {show("evidence") && <td style={{ maxWidth: 380 }}>{a.brief ? <>{a.brief.evidence_summary}{a.brief.evidence_urls > 0 && <span className="faint"> · {a.brief.evidence_urls} source{a.brief.evidence_urls > 1 ? "s" : ""}</span>}</> : <span className="faint">{a.reason ?? "Not finished"}</span>}</td>}
                    {show("draft") && <td><DraftBadge a={a} /></td>}
                  </tr>))}
              </tbody>
            </table>
          </div>
          <p className="hint">Showing {rows.length} of {accounts.length}. Click a column heading to sort. Sorting, filters and columns are remembered in this browser.</p>
        </>
      )}

      {sel && (
        <>
          <div className="scrim" onClick={() => setSelected(null)} aria-hidden />
          <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Details for ${sel.domain}`}>
            <div className="drawer-bar"><span className="muted">{company(sel)}</span><button ref={closeRef} className="ghost" onClick={() => setSelected(null)}>Close ✕</button></div>
            {detailLoading ? <div className="empty">Loading…</div>
              : detail ? <DomainDetail r={detail} />
              : <div className="panel empty"><h2 className="mono" style={{ fontFamily: "var(--font-mono)" }}>{sel.domain}</h2><p className="muted">{sel.reason ?? "Still working. The result appears here when the account finishes."}</p></div>}
          </aside>
        </>
      )}
    </>
  );
}
