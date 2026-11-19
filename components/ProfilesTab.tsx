"use client";
import { useState } from "react";
import { describeDisqualifier } from "@/lib/disqualifiers";
import { blankProfile, ProfileEditor } from "./ProfileEditor";
import { PageHead } from "./ui";
import { useWorkspace } from "./workspace";

type Mode = { kind: "view" } | { kind: "edit" } | { kind: "clone" } | { kind: "new" };

export function ProfilesTab() {
  const { profiles, refreshProfiles, setTab, api, current, notify, setError } = useWorkspace();
  const [openId, setOpenId] = useState<string | null>(profiles[0]?.id ?? null);
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const info = profiles.find((x) => x.id === openId) ?? profiles[0];
  const p = info?.detail;
  const readonly = profiles.length > 0 && profiles.every((x) => x.readonly);
  const close = () => setMode({ kind: "view" });
  const saved = async () => { await refreshProfiles(); close(); };

  return (
    <>
      <PageHead title="Seller profiles" lede="Who you sell as, who is a hard no, how leads are ranked, who to write to and how much the engine may spend. Saving never overwrites: every change is a new version, so old runs stay explainable.">
        <button onClick={() => setTab("compare")} disabled={profiles.length === 0}>Compare</button>
        <button className="primary" onClick={() => setMode({ kind: "new" })} disabled={readonly}>New profile</button>
      </PageHead>
      {readonly && <div className="banner warn"><span><strong>Read-only.</strong> The database is not set up on this server, so profiles load from files and cannot be saved here.</span></div>}

      {mode.kind === "new" && <ProfileEditor key="new" initial={blankProfile()} cloneOf={undefined} onClose={close} onSaved={saved} />}
      {mode.kind === "edit" && info && <ProfileEditor key={`edit-${info.dbId}`} initial={info.detail} onClose={close} onSaved={saved} />}
      {mode.kind === "clone" && info && <ProfileEditor key={`clone-${info.dbId}`} initial={info.detail} cloneOf={{ dbId: info.dbId, slug: info.id }} onClose={close} onSaved={saved} />}

      {mode.kind === "view" && profiles.length === 0 && (
        <div className="panel empty">
          <h2>No profiles in this workspace yet</h2>
          <p>A profile says who you sell as, who is a hard no, and who to write to. Start from the shipped examples, or build one from scratch.</p>
          <div className="row" style={{ justifyContent: "center" }}>
            {current?.role === "owner" && <button className="primary" onClick={async () => { try { await api("/api/profiles/examples", { method: "POST" }); await refreshProfiles(); notify("Example profiles added"); } catch (e) { setError((e as Error).message); } }}>Import example profiles</button>}
            <button onClick={() => setMode({ kind: "new" })}>Build one</button>
          </div>
        </div>
      )}
      {mode.kind === "view" && profiles.length > 0 && (
        <div className="grid-split">
          <div className="list">
            {profiles.map((x) => (
              <button key={x.id} className="item" aria-current={x.id === info?.id} onClick={() => setOpenId(x.id)}>
                <span className="title">{x.seller}</span><span className="badge plain">v{x.version}</span>
                <span className="sub">{x.detail.disqualifiers.length} disqualifiers · {x.gates.length} gates · {x.detail.signals.length} signals{x.clonedFrom ? ` · cloned from ${x.clonedFrom}` : ""}</span>
              </button>
            ))}
          </div>
          {p && info && (
            <div className="panel raised">
              <div className="panel-head">
                <div><h2>{p.seller.name}</h2><span className="faint mono">{p.id} · v{p.version} · {info.hash}</span></div>
                <div className="row tight" style={{ marginTop: 0 }}>
                  <button onClick={() => setMode({ kind: "edit" })} disabled={info.readonly}>Edit</button>
                  <button onClick={() => setMode({ kind: "clone" })} disabled={info.readonly}>Clone</button>
                  <button className="primary" onClick={() => setTab("run")}>Use in a run</button>
                </div>
              </div>
              <p className="muted">{p.icp_summary}</p>
              <h3>Offer</h3><p>{p.seller.one_line_offer}</p>

              <h3>Hard disqualifiers</h3>
              {p.disqualifiers.length === 0 ? <p className="muted">None set. Add region, size or industry rules in the editor.</p> : (
                <div className="cards">{p.disqualifiers.map((d) => (
                  <div className="card" key={d.id}><strong>{d.id}</strong><p style={{ margin: "4px 0 2px" }}>{describeDisqualifier(d)}</p><p className="hint">If unknown: {d.on_unknown}</p></div>
                ))}</div>
              )}

              <h3>Fit gates</h3>
              {p.gates.length === 0 ? <p className="muted">None.</p> : (
                <div className="cards">{p.gates.map((g) => (
                  <div className="card" key={g.id}><div className="row tight" style={{ marginTop: 0 }}><strong>{g.id}</strong><span className="badge plain info">{g.kind}</span></div>
                    <p style={{ margin: "6px 0 2px" }}>{g.question}</p>
                    <p className="hint">Unknown: {g.unknown_policy.type.replace(/_/g, " ")}{"flag" in g.unknown_policy ? ` (${g.unknown_policy.flag})` : ""}</p></div>
                ))}</div>
              )}

              <h3>Weighted fit criteria</h3>
              <div className="table-wrap"><table><thead><tr><th>Signal</th><th>Passes when</th><th className="num">Weight</th></tr></thead>
                <tbody>{p.signals.map((s) => <tr key={s.id}><td>{s.id}</td><td>{s.passes_when}{s.hook_only && <span className="badge plain" style={{ marginLeft: 6 }}>hook only</span>}</td><td className="num">{s.weight}</td></tr>)}</tbody></table></div>

              <h3>Target personas</h3>
              {p.personas.map((x) => <div className="card" key={x.tier}><strong>Tier {x.tier}</strong> <span className="faint">{x.applies_when === "always" ? "always" : `headcount below ${x.applies_when.headcount_below}`}</span><div style={{ marginTop: 6 }}>{x.titles.map((t) => <span className="tag" key={t}>{t}</span>)}</div></div>)}

              <h3>Execution caps</h3>
              <div className="kv">
                <span>Accounts per run</span><span className="mono">{p.limits.max_accounts_per_run}</span>
                <span>Contacts per account</span><span className="mono">{p.limits.max_contacts_per_account}</span>
                <span>Agent loop steps</span><span className="mono">{p.limits.max_loop_steps}</span>
                <span>Token budget per account</span><span className="mono">{p.limits.max_tokens_per_account.toLocaleString()}</span>
                <span>Fetches · news searches</span><span className="mono">{p.limits.fetch_calls} · {p.limits.news_calls}</span>
                <span>Hunter min confidence</span><span className="mono">{p.limits.hunter_min_confidence}</span>
              </div>

              <h3>Email rules</h3>
              <div className="kv">
                <span>Length</span><span>{p.email.min_words} to {p.email.max_words} words, subject up to {p.email.subject_max_words}</span>
                <span>Banned</span><span>{p.email.banned_phrases.map((b) => <span className="tag bad" key={b}>{b}</span>)}</span>
              </div>

              {info.versions.length > 0 && (<>
                <h3>Versions</h3>
                <div className="table-wrap"><table><thead><tr><th>Version</th><th>Hash</th><th>Saved</th></tr></thead>
                  <tbody>{info.versions.map((v) => <tr key={v.dbId}><td>v{v.version}</td><td className="mono">{v.hash}</td><td>{new Date(v.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</td></tr>)}</tbody></table></div>
              </>)}
            </div>
          )}
        </div>
      )}
    </>
  );
}
