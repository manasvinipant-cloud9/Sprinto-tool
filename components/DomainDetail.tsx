"use client";
import { useState } from "react";
import type { DomainResult } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { CopyButton } from "./ui";
import { TraceView } from "./TraceView";
import { describeSource, isWebUrl } from "@/lib/evidence";
import type { EvidenceRef } from "@/lib/types";

type Sub = "summary" | "fit" | "evidence" | "contact" | "email" | "trace";
const SUBS: { id: Sub; label: string }[] = [
  { id: "summary", label: "Summary" }, { id: "fit", label: "Fit" }, { id: "evidence", label: "Evidence" }, { id: "contact", label: "Contact" }, { id: "email", label: "Email" }, { id: "trace", label: "Decision trace" },
];

function Source({ url }: { url: string }) {
  return isWebUrl(url)
    ? <a href={url} target="_blank" rel="noopener noreferrer" className="mono" style={{ wordBreak: "break-all" }}>{url.replace(/^https?:\/\//, "")} ↗</a>
    : <span className="mono faint" style={{ wordBreak: "break-all" }}>{describeSource(url)}</span>;
}

/** The facts an answer rests on: the words, and the page they came from. Says so plainly when there are none. */
function Sources({ refs, show = true }: { refs?: EvidenceRef[]; show?: boolean }) {
  if (!show) return null;
  if (!refs || refs.length === 0) return <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>No source found for this answer.</div>;
  return (
    <ul className="sources">
      {refs.map((x) => (
        <li key={x.field}><span className="tag">{x.field}</span> “{x.text}” <Source url={x.url} /></li>
      ))}
    </ul>
  );
}
const gateCls = (a: string) => (a === "pass" ? "ok" : a === "fail" ? "bad" : "warn");
const gateLabel = (a: string) => (a === "skipped_due_to_cap" ? "SKIPPED_DUE_TO_CAP" : a.toUpperCase());

export function DomainDetail({ r }: { r: DomainResult }) {
  const [sub, setSub] = useState<Sub>("summary");
  const failedGate = r.gates.find((g) => g.answer === "fail");
  const flow = [
    { label: "Scraped", cls: r.tool_calls.some((t) => t.tool === "fetch_page" && t.status.startsWith("ok")) ? "done" : "fail" },
    { label: "Gates", cls: r.gates.length === 0 ? "skip" : failedGate ? "fail" : "done" },
    { label: "Contact", cls: r.contact ? "done" : r.outcome === "drop" || r.gates.length === 0 ? "skip" : "fail" },
    { label: "Pains", cls: r.pains.length ? "done" : "skip" },
    { label: "Email", cls: r.email ? (r.email.lint.length ? "fail" : "done") : "skip" },
  ];

  return (
    <div className="panel raised">
      <div className="panel-head" style={{ marginBottom: 6 }}>
        <h2 className="mono" style={{ fontFamily: "var(--font-mono)", fontSize: 18 }}>{r.domain}</h2>
        <StatusBadge status={r.status} />
      </div>
      <p className="muted">{r.reason}</p>
      {r.capped && <div className="banner warn"><span><strong>Stopped by a cap:</strong> {r.capped.reason.replace(/_/g, " ")} ({r.capped.detail}). Gates not reached are shown as SKIPPED_DUE_TO_CAP. Raise the cap in the profile and run again if you want more research.</span></div>}
      <div className="flow" aria-label="Pipeline">{flow.map((f) => <span key={f.label} className={`step ${f.cls}`}>{f.label}</span>)}</div>

      <div className="subtabs" role="tablist" aria-label="Domain detail">
        {SUBS.map((s) => <button key={s.id} role="tab" aria-selected={sub === s.id} className="subtab" onClick={() => setSub(s.id)}>{s.label}</button>)}
      </div>

      {sub === "summary" && (
        <>
          <div className="kv">
            <span>Outcome</span><span>{r.outcome ?? "n/a"}</span>
            <span>Rank score</span><span className="mono">{r.score ?? "n/a"}</span>
            <span>Flags</span><span>{r.flags.length ? r.flags.map((f, i) => <span key={`${f}-${i}`} className="tag">{f}</span>) : "none"}</span>
            <span>Contact</span><span>{r.contact ? `${r.contact.name}, ${r.contact.title}` : "none chosen"}</span>
            <span>Profile</span><span className="mono">{r.profile.id} v{r.profile.version} ({r.profile.hash})</span>
            <span>Agent loop</span><span className="mono">{r.loops.steps} of {r.loops.max_steps} steps · {r.loops.fetches} fetches · {r.loops.searches} searches</span>
            <span>Token budget</span><span className="mono">{(r.tokens.prompt + r.tokens.output).toLocaleString()} of {r.loops.max_tokens.toLocaleString()}</span>
            <span>Model use</span><span className="mono">{r.tokens.calls} calls · {r.tokens.prompt} in · {r.tokens.output} out · {(r.ms / 1000).toFixed(1)}s</span>
          </div>
          {r.pains.length > 0 && (<><h3>Two likely pain points</h3>{r.pains.map((p, i) => (
            <div className="card" key={i}><strong>{p.pain}</strong>{p.generic && <span className="badge warn plain" style={{ marginLeft: 8 }}>generic</span>}
              <p className="muted" style={{ margin: "4px 0 0" }}>{p.why_this_person}</p>
              <p className="hint">Evidence ({p.evidence_field}): {p.evidence_text}{p.url && <> · <Source url={p.url} /></>}</p></div>))}</>)}
        </>
      )}

      {sub === "fit" && (
        <>
          {r.gates.length === 0 ? <p className="muted">No gates were evaluated.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Gate</th><th>Answer</th><th>Evidence</th><th className="num">Fetches</th></tr></thead>
              <tbody>{r.gates.map((g, i) => (
                <tr key={`${g.id}-${i}`}>
                  <td><strong>{g.id}</strong><div className="muted">{g.question}</div></td>
                  <td><span className={`badge ${gateCls(g.answer)}`}>{gateLabel(g.answer)}</span>{g.policy_applied && <div className="faint mono">{g.policy_applied}</div>}</td>
                  <td>{g.evidence}<Sources refs={g.refs?.length ? g.refs : g.source_url ? [{ field: "source", text: "page or search used", url: g.source_url }] : []} show={g.answer !== "skipped_due_to_cap"} /></td>
                  <td className="num">{g.attempts}</td>
                </tr>))}</tbody>
            </table></div>
          )}
          {r.score_breakdown.length > 0 && (<><h3>Score breakdown</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Signal</th><th>Result</th><th>Evidence</th><th className="num">Pts</th></tr></thead>
              <tbody>{r.score_breakdown.map((s) => <tr key={s.id}><td>{s.id}</td><td>{s.result}</td><td>{s.evidence}<Sources refs={s.refs} show={s.result !== "unknown"} /></td><td className="num">{s.points}</td></tr>)}</tbody>
            </table></div></>)}
        </>
      )}

      {sub === "evidence" && (() => {
        const ev = r.evidence ?? {};
        const found = Object.entries(r.facts).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0));
        const missing = Object.entries(r.facts).filter(([, v]) => v === null).map(([k]) => k);
        return (
          <>
            <p className="muted">Everything the engine learned about this company, with the words it came from and where. Facts it could not find are never guessed.</p>
            {found.length === 0 ? <p className="muted">No facts were found.</p> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Fact</th><th>Value</th><th>Supporting words</th><th>Source</th></tr></thead>
                <tbody>{found.map(([k, v]) => (
                  <tr key={k}><td className="mono">{k}</td><td>{Array.isArray(v) ? v.join(", ") : String(v)}</td><td>{ev[k]?.text ? `“${ev[k].text}”` : <span className="faint">none recorded</span>}</td><td>{ev[k]?.url ? <Source url={ev[k].url} /> : <span className="faint">–</span>}</td></tr>))}</tbody>
              </table></div>
            )}
            {missing.length > 0 && <p className="hint" style={{ marginTop: 10 }}>Not found: {missing.map((m) => <span className="tag" key={m}>{m}</span>)}</p>}
          </>
        );
      })()}

      {sub === "contact" && (
        <>
          {r.contact ? (
            <div className="card">
              <strong>{r.contact.name}</strong> <span className="muted">{r.contact.title}</span>
              <div className="mono" style={{ margin: "4px 0" }}>{r.contact.email}</div>
              <span className="badge info plain">tier {r.contact.tier ?? "n/a"}</span> <span className="badge plain">confidence {r.contact.confidence}</span>
              <p className="hint">{r.contact.reason}</p>
            </div>
          ) : <p className="muted">No contact was chosen.</p>}
          {r.candidates.length > 0 && (<><h3>All candidates</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Candidate</th><th>Title</th><th className="num">Conf.</th><th>Why chosen or not</th></tr></thead>
              <tbody>{r.candidates.map((c) => <tr key={c.email}><td>{c.name}</td><td>{c.title || "unknown"}</td><td className="num">{c.confidence}</td><td>{c.reason}</td></tr>)}</tbody>
            </table></div></>)}
        </>
      )}

      {sub === "email" && (
        r.email ? (
          <>
            <div className="row tight" style={{ marginTop: 0 }}><strong>Subject:</strong> {r.email.subject} <span className="spacer" /><CopyButton text={r.email.subject} label="Copy subject" /><CopyButton text={r.email.body} label="Copy body" /></div>
            <pre className="email">{r.email.body}</pre>
            <p className="muted">{r.email.body.trim().split(/\s+/).length} words · {r.email.lint.length ? <span className="err">Lint failed: {r.email.lint.join("; ")}</span> : `lint passed (${r.email.regenerations} regenerations)`}</p>
          </>
        ) : <p className="muted">No email was drafted for this domain.</p>
      )}

      {sub === "trace" && <TraceView r={r} />}
    </div>
  );
}
