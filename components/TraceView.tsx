"use client";
import { useMemo, useState } from "react";
import type { DomainResult, GateResult } from "@/lib/types";
import type { TraceKind, TraceStep } from "@/lib/trace";
import { describeSource, isWebUrl } from "@/lib/evidence";

const KIND_LABEL: Record<TraceKind, string> = { llm: "Model call", fetch_page: "Page read", search_news: "News search", contact_lookup: "Contact lookup", gate: "Decision", draft: "Draft check" };
type Group = "all" | "model" | "tools" | "decisions";
const GROUPS: Record<Group, { label: string; kinds: TraceKind[] | null }> = {
  all: { label: "All steps", kinds: null }, model: { label: "Model calls", kinds: ["llm"] },
  tools: { label: "Tools and sources", kinds: ["fetch_page", "search_news", "contact_lookup"] }, decisions: { label: "Decisions", kinds: ["gate", "draft"] },
};
const PHASE_LABEL: Record<string, string> = { researching: "Researching", gate_evaluation: "Gate evaluation", contact_lookup: "Contact lookup", drafting: "Drafting" };
const statusCls = (s: string) => (["ok", "pass"].includes(s) ? "ok" : ["fail", "error", "blocked", "robots_disallowed", "refused_cap"].includes(s) ? "bad" : ["unknown", "skipped_due_to_cap", "none_chosen", "empty"].includes(s) ? "warn" : "plain");
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

export const stepTokens = (steps: TraceStep[]) => steps.reduce((a, s) => a + s.tokens_in + s.tokens_out, 0);

function Src({ url }: { url: string }) {
  return isWebUrl(url) ? <a href={url} target="_blank" rel="noopener noreferrer" className="mono" style={{ wordBreak: "break-all" }}>{url.replace(/^https?:\/\//, "")} ↗</a> : <span className="mono faint">{describeSource(url)}</span>;
}

function GateRow({ g }: { g: GateResult }) {
  const label = g.answer === "skipped_due_to_cap" ? "SKIPPED_DUE_TO_CAP" : g.answer.toUpperCase();
  return (
    <tr>
      <td><strong>{g.id}</strong><div className="muted">{g.question}</div></td>
      <td><span className={`badge ${g.answer === "pass" ? "ok" : g.answer === "fail" ? "bad" : "warn"}`}>{label}</span></td>
      <td>{g.evidence}{g.policy_applied && <div className="faint mono" style={{ fontSize: 12 }}>policy: {g.policy_applied}</div>}
        {g.refs && g.refs.length > 0 && <ul className="sources">{g.refs.map((x) => <li key={x.field}><span className="tag">{x.field}</span> “{x.text}” <Src url={x.url} /></li>)}</ul>}</td>
      <td className="num">{g.attempts}</td>
    </tr>
  );
}

export function TraceView({ r }: { r: DomainResult }) {
  const [group, setGroup] = useState<Group>("all");
  const steps = useMemo(() => r.trace ?? [], [r.trace]);
  const shown = steps.filter((s) => !GROUPS[group].kinds || GROUPS[group].kinds.includes(s.kind));
  const tokens = stepTokens(steps);
  const total = r.tokens.prompt + r.tokens.output;
  const ms = steps.reduce((a, s) => a + s.ms, 0);
  const d = r.contact_decision;

  return (
    <>
      <h3 style={{ marginTop: 0 }}>Agent loop</h3>
      {steps.length === 0 ? (
        <p className="muted">No step log was recorded for this account (it was run before tracing existed). Gates and contact reasoning are below.</p>
      ) : (
        <>
          <div className="kv" style={{ marginBottom: 8 }}>
            <span>Steps</span><span className="mono">{steps.length} ({steps.filter((s) => s.kind === "llm").length} model calls, {steps.filter((s) => s.kind === "fetch_page" || s.kind === "search_news").length} tool calls)</span>
            <span>Time in steps</span><span className="mono">{fmtMs(ms)} of {fmtMs(r.ms)} total</span>
            <span>Tokens</span><span className="mono">{tokens.toLocaleString()} across steps {tokens === total ? <span className="badge ok plain">matches account total</span> : <span className="badge warn plain">account total {total.toLocaleString()}</span>}</span>
          </div>
          <div className="row tight" style={{ marginTop: 0 }} role="group" aria-label="Filter steps">
            {(Object.keys(GROUPS) as Group[]).map((g) => <button key={g} className="chip" aria-pressed={group === g} onClick={() => setGroup(g)}>{GROUPS[g].label}</button>)}
          </div>
          <ol className="trace">
            {shown.map((s) => (
              <li key={s.seq}>
                <details>
                  <summary>
                    <span className="seq mono">{s.seq}</span>
                    <span className="trace-main"><strong>{s.label.replace(/_/g, " ")}</strong>{s.ctx && <span className="tag" style={{ marginLeft: 6 }}>{s.ctx}</span>}
                      <span className="faint trace-kind"> {KIND_LABEL[s.kind]} · {PHASE_LABEL[s.phase] ?? s.phase}</span></span>
                    <span className={`badge ${statusCls(s.status)}`}>{s.status.replace(/_/g, " ")}</span>
                    <span className="num trace-num">{fmtMs(s.ms)}</span>
                    <span className="num trace-num">{s.tokens_in + s.tokens_out ? `${(s.tokens_in + s.tokens_out).toLocaleString()} tok` : ""}</span>
                  </summary>
                  <div className="trace-body">
                    <div className="label" style={{ marginTop: 0 }}>Input</div>
                    <pre className="trace-pre">{s.input || "(none)"}</pre>
                    <div className="label">Output</div>
                    <pre className="trace-pre">{s.output || "(none)"}</pre>
                    {(s.tokens_in > 0 || s.tokens_out > 0) && <p className="hint">{s.tokens_in.toLocaleString()} tokens in · {s.tokens_out.toLocaleString()} out</p>}
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </>
      )}

      <h3>Gate by gate</h3>
      {r.gates.length === 0 ? <p className="muted">No gates were evaluated.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Check</th><th>Result</th><th>Exact reason</th><th className="num">Fetches</th></tr></thead>
          <tbody>{r.gates.map((g) => <GateRow key={g.id} g={g} />)}</tbody>
        </table></div>
      )}
      {r.capped && <p className="hint">Gates marked SKIPPED_DUE_TO_CAP were never judged: {r.capped.reason.replace(/_/g, " ")} ({r.capped.detail}).</p>}

      <h3>Contact selection</h3>
      {!d ? <p className="muted">{r.status === "dropped" || r.status === "capped" ? "Contact lookup was never reached for this account." : "No contact decision was recorded."}</p> : (
        <>
          <p>
            {d.source === "override" ? "A manual override supplied the contact." : `Hunter returned ${d.found} contact${d.found === 1 ? "" : "s"}; ${d.considered} considered.`}
            {" "}A candidate needs a listed title for a persona tier and confidence of at least <strong>{d.min_confidence}</strong>.
            {d.headcount !== null && <> Company size read as <strong>{d.headcount}</strong>.</>}
          </p>
          <div className="table-wrap"><table>
            <thead><tr><th>Tier</th><th>Applies</th><th className="num">Title matches</th><th className="num">Excluded</th><th className="num">Below bar</th><th className="num">Qualified</th></tr></thead>
            <tbody>{d.tiers.map((t) => (
              <tr key={t.tier}><td><strong>Tier {t.tier}</strong>{r.contact?.tier === t.tier && <span className="badge ok plain" style={{ marginLeft: 6 }}>chosen from</span>}</td>
                <td>{t.not_reached ? <span className="muted">not reached: a higher tier already had a match</span> : t.applies ? "yes" : <span className="muted">no: {t.skipped_reason}</span>}</td>
                <td className="num">{t.title_matches}</td><td className="num">{t.excluded}</td><td className="num">{t.below_confidence}</td><td className="num">{t.qualified}</td></tr>))}</tbody>
          </table></div>
          {r.candidates.length > 0 && (
            <>
              <h3>Why this person and not the others</h3>
              <div className="table-wrap"><table>
                <thead><tr><th>Candidate</th><th>Title</th><th className="num">Conf.</th><th>Outcome</th></tr></thead>
                <tbody>{r.candidates.map((c) => {
                  const chosen = r.contact?.email === c.email;
                  return <tr key={c.email} aria-selected={chosen}><td><strong>{c.name}</strong>{chosen && <span className="badge ok plain" style={{ marginLeft: 6 }}>chosen</span>}</td><td>{c.title || "unknown"}</td><td className="num">{c.confidence}</td><td>{chosen ? "Chosen: " : "Not chosen: "}{c.reason}</td></tr>;
                })}</tbody>
              </table></div>
            </>
          )}
          {!r.contact && <p className="hint">No candidate cleared the bar, so the account stops here as qualified with no contact. Nobody was guessed.</p>}
        </>
      )}
    </>
  );
}
