import type { DomainResult } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";

export function DomainDetail({ r }: { r: DomainResult }) {
  return (
    <div className="panel">
      <h2>{r.domain}</h2>
      <div className="row" style={{ marginTop: 0 }}>
        <StatusBadge status={r.status} />
        <span className="muted">{r.reason}</span>
      </div>
      <div className="kv" style={{ marginTop: 12 }}>
        <span className="muted">Outcome</span><span>{r.outcome ?? "n/a"}</span>
        <span className="muted">Rank score</span><span className="mono">{r.score ?? "n/a"}</span>
        <span className="muted">Flags</span><span>{r.flags.length ? r.flags.join(", ") : "none"}</span>
        <span className="muted">Profile</span><span className="mono">{r.profile.id} v{r.profile.version} ({r.profile.hash})</span>
        <span className="muted">Model use</span><span className="mono">{r.tokens.calls} calls, {r.tokens.prompt} in, {r.tokens.output} out, {(r.ms / 1000).toFixed(1)}s</span>
      </div>

      <h3>Why it qualified or dropped</h3>
      {r.gates.length === 0 ? <p className="muted">No gates were evaluated.</p> : (
        <table>
          <thead><tr><th>Gate</th><th>Answer</th><th>Evidence</th><th className="num">Fetches</th></tr></thead>
          <tbody>
            {r.gates.map((g) => (
              <tr key={g.id}>
                <td><strong>{g.id}</strong><br /><span className="muted">{g.question}</span></td>
                <td><span className={`badge ${g.answer === "pass" ? "ok" : g.answer === "fail" ? "bad" : "warn"}`}>{g.answer}</span>{g.policy_applied ? <div className="muted mono">{g.policy_applied}</div> : null}</td>
                <td>{g.evidence}{g.source_url ? <div className="muted mono">{g.source_url}</div> : null}</td>
                <td className="num">{g.attempts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {r.score_breakdown.length > 0 && (
        <>
          <h3>Score breakdown</h3>
          <table>
            <thead><tr><th>Signal</th><th>Result</th><th>Evidence</th><th className="num">Points</th></tr></thead>
            <tbody>{r.score_breakdown.map((s) => <tr key={s.id}><td>{s.id}</td><td>{s.result}</td><td>{s.evidence}</td><td className="num">{s.points}</td></tr>)}</tbody>
          </table>
        </>
      )}

      <h3>Why this person</h3>
      {r.contact ? (
        <p><strong>{r.contact.name}</strong>, {r.contact.title}, <span className="mono">{r.contact.email}</span>. Tier {r.contact.tier}, confidence {r.contact.confidence}. {r.contact.reason}.</p>
      ) : <p className="muted">No contact was chosen.</p>}
      {r.candidates.length > 0 && (
        <table>
          <thead><tr><th>Candidate</th><th>Title</th><th className="num">Conf.</th><th>Why not / why</th></tr></thead>
          <tbody>{r.candidates.map((c) => <tr key={c.email}><td>{c.name}</td><td>{c.title || "unknown"}</td><td className="num">{c.confidence}</td><td>{c.reason}</td></tr>)}</tbody>
        </table>
      )}

      {r.pains.length > 0 && (
        <>
          <h3>Two likely pain points</h3>
          <ol>{r.pains.map((p, i) => <li key={i}><strong>{p.pain}</strong>{p.generic ? " (generic, flagged)" : ""}<br /><span className="muted">{p.why_this_person} Evidence ({p.evidence_field}): {p.evidence_text}</span></li>)}</ol>
        </>
      )}

      {r.email && (
        <>
          <h3>The email</h3>
          <div><strong>Subject:</strong> {r.email.subject}</div>
          <pre className="email">{r.email.body}</pre>
          <div className="muted">{r.email.lint.length ? `Lint failed: ${r.email.lint.join("; ")}` : `Lint passed (${r.email.regenerations} regenerations)`}</div>
          {r.send && <div className={r.send.ok ? "" : "err"}>Send result: {r.send.message}</div>}
        </>
      )}

      <h3>Tool calls</h3>
      <table>
        <thead><tr><th>Tool</th><th>Argument</th><th>Status</th><th className="num">Words</th><th className="num">ms</th></tr></thead>
        <tbody>{r.tool_calls.map((t, i) => <tr key={i}><td>{t.tool}</td><td className="mono">{t.arg}</td><td>{t.status}{t.note ? ` (${t.note})` : ""}</td><td className="num">{t.words ?? ""}</td><td className="num">{t.ms}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
