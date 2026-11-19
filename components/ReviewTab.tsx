"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DraftView, ReviewItem } from "@/lib/services/drafts";
import type { DomainResult } from "@/lib/types";
import { evidenceUrls, isWebUrl, summarizeEvidence } from "@/lib/evidence";
import { formatDraftsForCopy, type ApprovedDraft } from "@/lib/export";
import { PageHead } from "./ui";
import { useWorkspace } from "./workspace";

type Filter = "pending" | "all" | "approved" | "rejected" | "nodraft";
const FILTERS: { key: Filter; label: string }[] = [{ key: "pending", label: "Pending review" }, { key: "approved", label: "Approved" }, { key: "rejected", label: "Rejected" }, { key: "all", label: "All" }, { key: "nodraft", label: "No draft" }];
const PRESETS = ["Make it shorter", "Make it more direct", "Lead with the strongest evidence", "Use a softer tone"];
const statusOf = (i: ReviewItem) => (i.draft ? i.draft.reviewStatus : "nodraft");
const wordCount = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");
const isField = (t: EventTarget | null) => t instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable);

function StatusPill({ s }: { s: string }) {
  const m: Record<string, [string, string]> = { pending_review: ["info", "Pending review"], approved: ["ok", "Approved"], rejected: ["bad", "Rejected"], nodraft: ["plain", "No draft"] };
  const [cls, label] = m[s] ?? ["plain", s];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function ReviewTab() {
  const { activeRun, runs, setActiveRunId, api, fetchRaw, profiles, setTab, setSelected, notify, user } = useWorkspace();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState<Filter>("pending");
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DomainResult | null>(null);
  const [form, setForm] = useState({ subject: "", body: "", notes: "" });
  const [instruction, setInstruction] = useState("");
  const [override, setOverride] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "regen" | "act">("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [history, setHistory] = useState<(DraftView & { isCurrent: boolean })[] | null>(null);
  const [help, setHelp] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const regenRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);


  const runId = activeRun?.id ?? null;
  const live = activeRun?.status === "running" || activeRun?.status === "queued";

  const load = useCallback(async () => {
    if (!runId) return;
    const r = await api<{ items: ReviewItem[] }>(`/api/runs/${runId}/review`);
    setItems(r.items); setLoaded(true);
  }, [api, runId]);
  useEffect(() => { setItems([]); setLoaded(false); setCurrentId(null); if (runId) void load().catch((e) => setMsg({ kind: "err", text: (e as Error).message })); }, [runId, load]);
  useEffect(() => { if (!live) return; const t = setInterval(() => { void load().catch(() => undefined); }, 5000); return () => clearInterval(t); }, [live, load]);

  const counts = useMemo(() => ({
    pending: items.filter((i) => statusOf(i) === "pending_review").length, approved: items.filter((i) => statusOf(i) === "approved").length,
    rejected: items.filter((i) => statusOf(i) === "rejected").length, nodraft: items.filter((i) => !i.draft).length, all: items.length,
  }), [items]);
  const withDraft = items.length - counts.nodraft;
  const visible = useMemo(() => items.filter((i) => (filter === "all" ? true : filter === "pending" ? statusOf(i) === "pending_review" : filter === "nodraft" ? !i.draft : statusOf(i) === filter)), [items, filter]);

  // Keep a valid current item.
  useEffect(() => {
    if (visible.length === 0) { if (currentId !== null && !items.some((i) => i.accountId === currentId)) setCurrentId(null); return; }
    if (!currentId || !items.some((i) => i.accountId === currentId)) setCurrentId(visible[0].accountId);
  }, [visible, items, currentId]);

  const cur = items.find((i) => i.accountId === currentId) ?? null;
  const draft = cur?.draft ?? null;
  const idx = cur ? visible.findIndex((i) => i.accountId === cur.accountId) : -1;
  const profile = profiles.find((p) => p.id === activeRun?.profile.slug)?.detail;

  // Bring the editor in line with the draft when the draft or its version changes (not on every save).
  useEffect(() => { setForm(draft ? { subject: draft.subject, body: draft.body, notes: draft.notes } : { subject: "", body: "", notes: "" }); setOverride(false); setHistory(null); setMsg(null); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft?.id]);

  useEffect(() => {
    setDetail(null);
    if (!cur) return;
    let cancelled = false;
    api<{ result: DomainResult | null }>(`/api/accounts/${cur.accountId}`).then((r) => { if (!cancelled) setDetail(r.result); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [cur?.accountId, api]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchItem = useCallback((d: DraftView) => setItems((xs) => xs.map((x) => (x.draft && x.draft.id === d.id ? { ...x, draft: d } : x))), []);
  const replaceDraft = useCallback((accountId: string, d: DraftView) => setItems((xs) => xs.map((x) => (x.accountId === accountId ? { ...x, draft: d } : x))), []);

  const dirty = !!draft && (form.subject !== draft.subject || form.body !== draft.body || form.notes !== draft.notes);

  const save = useCallback(async (f = form): Promise<boolean> => {
    if (!draft) return true;
    if (f.subject === draft.subject && f.body === draft.body && f.notes === draft.notes) return true;
    setBusy("save");
    try {
      const r = await api<{ draft: DraftView }>(`/api/drafts/${draft.id}`, { method: "PATCH", body: JSON.stringify(f) });
      patchItem(r.draft); setMsg(null); setBusy(""); return true;
    } catch (e) { setMsg({ kind: "err", text: (e as Error).message }); setBusy(""); return false; }
  }, [api, draft, form, patchItem]);

  // Save a moment after typing stops.
  useEffect(() => {
    if (!dirty) return;
    timer.current = setTimeout(() => { void save(); }, 900);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [form, dirty, save]);

  const flush = useCallback(async () => { if (timer.current) clearTimeout(timer.current); return save(); }, [save]);

  const go = useCallback(async (to: number) => {
    if (visible.length === 0) return;
    if (!(await flush())) return;
    const next = visible[Math.max(0, Math.min(visible.length - 1, to))];
    if (next) setCurrentId(next.accountId);
  }, [flush, visible]);

  /** Prefer the next item still waiting for review; otherwise the neighbour. */
  const nextAfter = useCallback((): string | null => {
    if (!cur) return null;
    const i = visible.findIndex((x) => x.accountId === cur.accountId);
    for (let k = 1; k < visible.length; k++) { const c = visible[(i + k) % visible.length]; if (c.accountId !== cur.accountId && statusOf(c) === "pending_review") return c.accountId; }
    return visible[i + 1]?.accountId ?? visible[i - 1]?.accountId ?? null;
  }, [cur, visible]);

  const act = useCallback(async (action: "approve" | "reject" | "reopen", advance = true) => {
    if (!draft) return;
    if (busy === "act") { notify("One moment, still saving the last decision."); return; }
    if (!(await flush())) return;
    const next = advance ? nextAfter() : null;
    setBusy("act");
    try {
      const r = await api<{ draft: DraftView }>(`/api/drafts/${draft.id}/review`, { method: "POST", body: JSON.stringify({ action, overrideLint: override }) });
      patchItem(r.draft); setMsg(null);
      if (next) setCurrentId(next);
      if (action === "approve") notify("Approved");
    } catch (e) { setMsg({ kind: "err", text: (e as Error).message }); }
    setBusy("");
  }, [api, busy, draft, flush, nextAfter, notify, override, patchItem]);

  async function regenerate(text = instruction) {
    if (!draft || !text.trim()) return;
    if (!(await flush())) return;
    setBusy("regen"); setMsg(null);
    try {
      const r = await api<{ draft: DraftView }>(`/api/drafts/${draft.id}/regenerate`, { method: "POST", body: JSON.stringify({ instruction: text }) });
      replaceDraft(cur!.accountId, r.draft); setInstruction(""); setHistory(null);
      notify(`Version ${r.draft.version} written. The earlier one is kept in the history.`);
    } catch (e) { setMsg({ kind: "err", text: (e as Error).message }); }
    setBusy("");
  }

  async function openHistory() {
    if (!draft) return;
    if (history) { setHistory(null); return; }
    try { setHistory((await api<{ versions: (DraftView & { isCurrent: boolean })[] }>(`/api/drafts/${draft.id}/versions`)).versions); } catch (e) { setMsg({ kind: "err", text: (e as Error).message }); }
  }
  async function restore(version: number) {
    if (!draft || !(await flush())) return;
    try {
      const r = await api<{ draft: DraftView }>(`/api/drafts/${draft.id}/restore`, { method: "POST", body: JSON.stringify({ fromVersion: version }) });
      replaceDraft(cur!.accountId, r.draft); setHistory(null); notify(`Restored as version ${r.draft.version}`);
    } catch (e) { setMsg({ kind: "err", text: (e as Error).message }); }
  }

  const approvedList = useMemo<ApprovedDraft[]>(() => items.filter((i) => i.draft?.reviewStatus === "approved").map((i, n) => ({
    position: n, company: i.company, domain: i.domain, score: i.score, contactName: i.contact?.name ?? "", contactTitle: i.contact?.title ?? "", contactEmail: i.contact?.email ?? "",
    subject: i.draft!.subject, body: i.draft!.body, notes: i.draft!.notes, tags: i.draft!.tags, version: i.draft!.version, edited: i.draft!.edited, lintOverridden: i.draft!.lintOverridden,
    approvedBy: i.draft!.approvedBy ?? "", approvedAt: i.draft!.approvedAt ?? "", profile: "",
  })), [items]);

  async function exportCsv() {
    if (!runId) return;
    await flush();
    const res = await fetchRaw(`/api/runs/${runId}/drafts-export`);
    if (!res.ok) { notify("Export failed"); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await res.blob()); a.download = `approved-drafts-${runId.slice(0, 8)}.csv`; a.click(); URL.revokeObjectURL(a.href);
    notify(`Exported ${approvedList.length} approved draft${approvedList.length === 1 ? "" : "s"}`);
  }
  async function copyApproved() {
    await flush();
    try { await navigator.clipboard.writeText(formatDraftsForCopy(approvedList)); notify(`Copied ${approvedList.length} approved draft${approvedList.length === 1 ? "" : "s"}`); } catch { notify("Copy failed. Use the CSV instead."); }
  }

  // Keyboard. The handler is kept in a ref so it always sees current state without re-binding.
  const key = useRef<(e: KeyboardEvent) => void>(() => undefined);
  key.current = (e) => {
    const inField = isField(e.target);
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void act("approve"); return; }
    if (e.key === "Escape" && inField) { (e.target as HTMLElement).blur(); return; }
    if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case "j": case "ArrowDown": e.preventDefault(); void go(idx + 1); break;
      case "k": case "ArrowUp": e.preventDefault(); void go(idx - 1); break;
      case "a": e.preventDefault(); void act("approve"); break;
      case "x": e.preventDefault(); void act("reject"); break;
      case "u": e.preventDefault(); void act("reopen", false); break;
      case "e": e.preventDefault(); bodyRef.current?.focus(); break;
      case "r": e.preventDefault(); regenRef.current?.focus(); break;
      case "h": e.preventDefault(); void openHistory(); break;
      case "?": e.preventDefault(); setHelp((v) => !v); break;
    }
  };
  useEffect(() => { const h = (e: KeyboardEvent) => key.current(e); window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, []);

  if (runs.length === 0 && !activeRun) {
    return (<><PageHead title="Review" /><div className="panel empty"><h2>Nothing to review yet</h2><p>Start a run. Qualified accounts with a draft appear here.</p><div className="row" style={{ justifyContent: "center" }}><button className="primary" onClick={() => setTab("run")}>Start a run</button></div></div></>);
  }

  const words = wordCount(form.body);
  const rules = profile?.email;
  const lint = draft?.lint ?? [];

  return (
    <>
      <PageHead title="Review" lede="Read, edit, approve or reject each draft. Nothing is sent from here: approved drafts are exported for you to send yourself.">
        <select aria-label="Run" value={runId ?? ""} onChange={(e) => setActiveRunId(e.target.value || null)} style={{ width: "auto", maxWidth: 320 }}>
          {!activeRun && <option value="">Choose a run</option>}
          {runs.map((r) => <option key={r.id} value={r.id}>{new Date(r.created_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · {r.profile}</option>)}
        </select>
        <button onClick={() => void exportCsv()} disabled={approvedList.length === 0}>Export approved (CSV)</button>
        <button onClick={() => void copyApproved()} disabled={approvedList.length === 0}>Copy approved</button>
      </PageHead>

      {!activeRun ? <div className="panel empty"><p>Choose a run above.</p></div> : (
        <>
          <div className="review-bar">
            <div className="progress" style={{ flex: 1, marginTop: 0 }} role="progressbar" aria-valuemin={0} aria-valuemax={withDraft} aria-valuenow={counts.approved + counts.rejected}>
              <div style={{ width: `${withDraft ? ((counts.approved + counts.rejected) / withDraft) * 100 : 0}%` }} />
            </div>
            <span className="muted"><strong>{counts.approved + counts.rejected}</strong> of {withDraft} reviewed · {counts.approved} approved · {counts.rejected} rejected</span>
            <span className="muted" title="Approvals are recorded under your sign-in">Reviewing as <strong>{user?.email}</strong></span>
            <button className="ghost small" onClick={() => setHelp((v) => !v)} aria-expanded={help}>Keys ?</button>
          </div>
          {help && (
            <div className="banner info" role="note"><span>
              <strong>Keyboard.</strong> <kbd>J</kbd>/<kbd>↓</kbd> next · <kbd>K</kbd>/<kbd>↑</kbd> previous · <kbd>A</kbd> or <kbd>⌘/Ctrl+Enter</kbd> approve and next · <kbd>X</kbd> reject and next · <kbd>U</kbd> reopen · <kbd>E</kbd> edit body · <kbd>R</kbd> regenerate · <kbd>H</kbd> history · <kbd>Esc</kbd> leave a field · <kbd>?</kbd> this help
            </span></div>
          )}
          <div className="row tight" style={{ marginTop: 0 }} role="group" aria-label="Filter drafts">
            {FILTERS.map((f) => <button key={f.key} className="chip" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label} <span className="n">{counts[f.key]}</span></button>)}
          </div>
          {counts.nodraft > 0 && filter !== "nodraft" && <p className="hint">{counts.nodraft} qualified account{counts.nodraft > 1 ? "s have" : " has"} no draft (usually no contact cleared the bar). They are listed under No draft.</p>}

          {!loaded ? <div className="panel empty" style={{ marginTop: 12 }}>Loading…</div> : items.length === 0 ? (
            <div className="panel empty" style={{ marginTop: 12 }}><h2>No qualified accounts yet</h2><p>{live ? "The run is still working. Qualified accounts appear here as they finish." : "This run has no qualified accounts."}</p></div>
          ) : (
            <div className="review-grid" style={{ marginTop: 12 }}>
              <nav className="review-queue" aria-label="Review queue">
                {visible.length === 0 && <div className="panel empty" style={{ padding: 16 }}>{filter === "pending" ? "All caught up." : "Nothing here."}</div>}
                {visible.map((i) => (
                  <button key={i.accountId} className="queue-item" aria-current={i.accountId === currentId} onClick={() => { void (async () => { if (await flush()) setCurrentId(i.accountId); })(); }}>
                    <span className="truncate"><strong>{i.company}</strong></span>
                    <span className="faint mono truncate" style={{ fontSize: 12 }}>{i.domain}</span>
                    <span className="row tight" style={{ margin: 0 }}><StatusPill s={statusOf(i)} />{i.draft && i.draft.versions > 1 && <span className="faint" style={{ fontSize: 12 }}>v{i.draft.version}</span>}{i.draft && i.draft.lint.length > 0 && i.draft.reviewStatus !== "approved" && <span title="Has warnings" aria-label="Has warnings">⚠</span>}</span>
                  </button>
                ))}
              </nav>

              {!cur ? <div className="panel empty" style={{ gridColumn: "2 / -1" }}>Pick an account.</div> : (
                <>
                  <section className="panel review-brief" aria-label="Company brief">
                    <div className="panel-head" style={{ marginBottom: 6 }}>
                      <div><h2 style={{ fontSize: 20 }}>{cur.company}</h2><span className="faint mono">{cur.domain}</span></div>
                      <span className="score" style={{ fontSize: 22 }}>{cur.score ?? "–"}<span className="faint" style={{ fontSize: 12 }}> / 100</span></span>
                    </div>
                    {cur.flags.length > 0 && <div style={{ marginBottom: 6 }}>{cur.flags.map((f, i) => <span className="tag" key={`${f}-${i}`}>{f}</span>)}</div>}
                    {detail ? (
                      <>
                        <p className="muted">{summarizeEvidence(detail)}</p>
                        <h3>Why it qualified</h3>
                        <ul className="brief-list">{detail.gates.map((g, i) => (
                          <li key={`${g.id}-${i}`}><span className={`badge ${g.answer === "pass" ? "ok" : g.answer === "fail" ? "bad" : "warn"}`}>{g.answer === "skipped_due_to_cap" ? "SKIPPED" : g.answer.toUpperCase()}</span> <strong>{g.id}</strong> {g.evidence}</li>
                        ))}</ul>
                        {evidenceUrls(detail).filter(isWebUrl).length > 0 && (
                          <p className="hint">Sources: {evidenceUrls(detail).filter(isWebUrl).slice(0, 4).map((u) => <span key={u}><a href={u} target="_blank" rel="noopener noreferrer">{u.replace(/^https?:\/\//, "")} ↗</a>{" "}</span>)}</p>
                        )}
                        {detail.pains.length > 0 && (<><h3>Likely pain points</h3>{detail.pains.map((p, i) => (
                          <div className="card" key={i}><strong>{p.pain}</strong><p className="hint" style={{ margin: "4px 0 0" }}>{p.why_this_person} Evidence: “{p.evidence_text}”{p.url && isWebUrl(p.url) && <> <a href={p.url} target="_blank" rel="noopener noreferrer">source ↗</a></>}</p></div>
                        ))}</>)}
                      </>
                    ) : <p className="muted">Loading the brief…</p>}
                    <h3>Contact</h3>
                    {cur.contact ? (
                      <div className="card">
                        <strong>{cur.contact.name}</strong> <span className="muted">{cur.contact.title}</span>
                        <div className="mono" style={{ margin: "4px 0" }}>{cur.contact.email}</div>
                        <span className="badge info plain">persona tier {cur.contact.tier ?? "–"}</span>
                        {detail?.contact && <p className="hint">{detail.contact.reason}</p>}
                      </div>
                    ) : <p className="muted">{cur.reason ?? "No contact was chosen."}</p>}
                    <div className="row"><button onClick={() => { setSelected(cur.accountId); setTab("results"); }}>Open decision trace</button></div>
                  </section>

                  <section className="panel review-editor" aria-label="Draft">
                    {!draft ? (
                      <div className="empty"><h2>No draft</h2><p className="muted">{cur.reason ?? "No draft was written for this account."}</p></div>
                    ) : (
                      <>
                        <div className="panel-head" style={{ marginBottom: 8 }}>
                          <div className="row tight" style={{ margin: 0 }}>
                            <StatusPill s={draft.reviewStatus} />
                            <span className="faint" style={{ fontSize: 12.5 }}>v{draft.version}{draft.source !== "generated" && ` · ${draft.source}`}{draft.edited && " · edited by you"}</span>
                          </div>
                          <span className="faint" style={{ fontSize: 12.5 }}>{idx >= 0 ? `${idx + 1} of ${visible.length}` : ""}{busy === "save" ? " · saving…" : dirty ? " · unsaved" : " · saved"}</span>
                        </div>
                        {draft.instruction && <p className="hint" style={{ marginTop: 0 }}>Instruction used: “{draft.instruction}”</p>}

                        <label htmlFor="rv-subject" style={{ marginTop: 0 }}>Subject</label>
                        <input id="rv-subject" type="text" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} maxLength={200} />
                        <label htmlFor="rv-body">Body <span className="faint" style={{ fontWeight: 400 }}>· {words} words{rules ? ` (${rules.min_words} to ${rules.max_words})` : ""}</span></label>
                        <textarea id="rv-body" ref={bodyRef} className="rv-body" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} maxLength={8000} spellCheck />

                        {lint.length > 0 && (
                          <div className="banner warn" role="alert" style={{ marginTop: 10, marginBottom: 0 }}>
                            <div><strong>{lint.length} warning{lint.length > 1 ? "s" : ""}</strong>
                              <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>{lint.map((l, i) => <li key={i}>{l}</li>)}</ul>
                              {draft.reviewStatus === "pending_review" && <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> I have read these and want to approve anyway</label>}
                            </div>
                          </div>
                        )}

                        {draft.tags.length > 0 && <div style={{ marginTop: 10 }}><span className="faint" style={{ fontSize: 12.5 }}>Personalised from: </span>{draft.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div>}
                        <label htmlFor="rv-notes">Your notes (not part of the email)</label>
                        <textarea id="rv-notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} maxLength={2000} style={{ minHeight: 60, fontFamily: "var(--font-body)" }} />

                        {msg && <div className={msg.kind === "err" ? "err" : "hint"} role="alert">{msg.text}</div>}

                        <div className="row">
                          <button onClick={() => void go(idx - 1)} disabled={idx <= 0} aria-label="Previous">← Prev</button>
                          <button onClick={() => void go(idx + 1)} disabled={idx < 0 || idx >= visible.length - 1} aria-label="Next">Next →</button>
                          <span className="spacer" />
                          {draft.reviewStatus === "pending_review" ? (
                            <>
                              <button className="danger" onClick={() => void act("reject")} disabled={busy === "act"}>Reject &amp; next</button>
                              <button className="primary" onClick={() => void act("approve")} disabled={busy === "act" || (lint.length > 0 && !override)}>Approve &amp; next</button>
                            </>
                          ) : <button onClick={() => void act("reopen", false)} disabled={busy === "act"}>Reopen for review</button>}
                        </div>
                        {draft.reviewedAt && <p className="hint">{draft.reviewStatus === "approved" ? `Approved by ${draft.approvedBy ?? "reviewer"}${draft.lintOverridden ? " with warnings accepted" : ""}` : `Rejected by ${draft.reviewedBy ?? "reviewer"}`} · {when(draft.reviewedAt)}</p>}

                        <h3>Regenerate with an instruction</h3>
                        <div className="row tight" style={{ marginTop: 0 }}>
                          {PRESETS.map((p) => <button key={p} className="chip" disabled={busy !== ""} onClick={() => void regenerate(p)}>{p}</button>)}
                        </div>
                        <div className="row tight">
                          <input ref={regenRef} type="text" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="For example: mention their hiring" maxLength={300} aria-label="Instruction for a new version" style={{ flex: 1, minWidth: 0 }} onKeyDown={(e) => { if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) { e.preventDefault(); void regenerate(); } }} />
                          <button onClick={() => void regenerate()} disabled={busy !== "" || !instruction.trim()}>{busy === "regen" ? "Writing…" : "Regenerate"}</button>
                        </div>
                        <p className="hint">Writes a new version. The profile's rules and the lint check still apply, and the earlier version stays in the history.</p>

                        <div className="row tight">
                          <button className="ghost small" onClick={() => void openHistory()} aria-expanded={history !== null}>{history ? "Hide history" : `History (${draft.versions})`}</button>
                        </div>
                        {history && (
                          <ol className="history">{history.map((v) => (
                            <li key={v.id} className={v.isCurrent ? "current" : ""}>
                              <div className="row tight" style={{ margin: 0 }}>
                                <strong>v{v.version}</strong><StatusPill s={v.reviewStatus} />
                                <span className="faint" style={{ fontSize: 12.5 }}>{v.source}{v.instruction ? `: ${v.instruction}` : ""} · {when(v.createdAt)}</span>
                                <span className="spacer" />
                                {v.isCurrent ? <span className="badge plain info">current</span> : <button className="small" onClick={() => void restore(v.version)}>Use this version</button>}
                              </div>
                              {!v.isCurrent && <details><summary className="faint" style={{ cursor: "pointer", fontSize: 12.5 }}>Show text</summary><div className="mono" style={{ whiteSpace: "pre-wrap", margin: "6px 0 0" }}><strong>{v.subject}</strong>{"\n\n"}{v.body}</div></details>}
                            </li>
                          ))}</ol>
                        )}
                      </>
                    )}
                  </section>
                </>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
