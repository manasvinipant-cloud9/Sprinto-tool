"use client";
import { useMemo, useRef, useState } from "react";
import YAML from "yaml";
import { profileSchema, type Disqualifier, type Profile } from "@/lib/profile-schema";
import { checkYaml, type Problem } from "@/lib/profile-yaml";
import { CopyButton, download } from "./ui";
import { useWorkspace } from "./workspace";

const PAGE_TYPES = ["homepage", "security", "trust", "careers", "pricing", "customers", "about", "product", "integrations", "blog", "news_search"] as const;
const SECTIONS = ["Seller", "Hard disqualifiers", "Fit gates", "Weighted criteria", "Personas", "Execution caps", "Email"] as const;
type Section = (typeof SECTIONS)[number];

export const blankProfile = (): Profile => profileSchema.parse({
  id: "new-seller", version: 1,
  seller: { name: "New seller", domain: "example.com", one_line_offer: "What you sell in one line.", sender_name: "Your name", sender_title: "Your title", allowed_claims: ["A claim you can stand behind."], ask: "Would a short call this week be useful?", tone_notes: "Plain, specific, no hype." },
  icp_summary: "Who you sell to in one sentence.",
  disqualifiers: [{ id: "D1", type: "headcount_between", min: 20, max: 500, on_unknown: "flag" }],
  gates: [{ id: "G1", question: "Is it a B2B software company?", kind: "classification", pass_when: "Recurring pricing or a business buyer.", required_fields: ["company_type"], where_to_look: ["homepage"], unknown_policy: { type: "drop" } }],
  signals: [{ id: "S1", passes_when: "Headcount in the target range.", weight: 50, unanswered: "ignore" }, { id: "S2", passes_when: "Recognisable customers shown.", weight: 50, unanswered: "ignore" }],
  personas: [{ tier: 1, titles: ["Head of Operations"], exclude_titles: ["assistant", "intern", "former"], applies_when: "always", pain_lens: ["What this person tends to care about."] }],
  email: { min_words: 70, max_words: 120, subject_max_words: 7, banned_phrases: ["synergy", "touch base", "circle back"], question_hook_when_flagged: true },
  limits: { fetch_calls: 4, news_calls: 2, hunter_min_confidence: 70 },
});

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <div className="field"><label>{label}</label>{children}{hint && <p className="hint">{hint}</p>}</div>;
}
const lines = (v: string[]) => v.join("\n");
const unlines = (s: string) => s.split("\n").map((x) => x.trim());
const csvList = (s: string) => s.split(",").map((x) => x.trim());
const area = { minHeight: 80, fontFamily: "var(--font-body)" } as const;

export function ProfileEditor({ initial, cloneOf, onClose, onSaved }: { initial: Profile; cloneOf?: { dbId: string | null; slug: string }; onClose: () => void; onSaved: () => void }) {
  const { api, notify } = useWorkspace();
  const [spec, setSpec] = useState<Profile>(initial);
  const [text, setText] = useState(() => YAML.stringify(initial));
  const [problems, setProblems] = useState<Problem[]>([]);
  const [section, setSection] = useState<Section>("Seller");
  const [saving, setSaving] = useState(false);
  const gutter = useRef<HTMLDivElement>(null);
  const broken = problems.length > 0;

  // Form -> YAML. The form edits a copy of the canonical object, then YAML is regenerated from it.
  const set = (fn: (x: Profile) => void) => {
    const next = structuredClone(spec); fn(next);
    const res = profileSchema.safeParse(next);
    setSpec(next);
    setText(YAML.stringify(next));
    setProblems(res.success ? [] : res.error.issues.map((i) => ({ where: i.path.join(".") || "profile", message: i.message })));
  };
  // YAML -> form. Only a valid document replaces the canonical object; otherwise the form freezes with the errors shown.
  const onYaml = (t: string) => {
    setText(t);
    const r = checkYaml(t);
    setProblems(r.problems);
    if (r.spec) setSpec(r.spec);
  };

  const weightTotal = useMemo(() => spec.signals.filter((s) => !s.hook_only).reduce((a, s) => a + (Number(s.weight) || 0), 0), [spec.signals]);
  const lineCount = text.split("\n").length;

  async function save() {
    const r = checkYaml(text);
    if (!r.spec) { setProblems(r.problems); return; }
    setSaving(true);
    try {
      await api("/api/profiles", { method: "POST", body: JSON.stringify(cloneOf ? { spec: r.spec, cloneSlug: true, cloneOf: cloneOf.dbId ?? undefined } : { spec: r.spec }) });
      notify(cloneOf ? "Cloned as a new profile" : "Saved as a new version");
      onSaved();
    } catch (e) { setProblems([{ where: "save", message: (e as Error).message }]); }
    setSaving(false);
  }

  const dqDefault = (type: Disqualifier["type"], id: string): Disqualifier =>
    type === "region_in" ? { id, type, regions: ["India"], on_unknown: "flag" } : type === "industry_not_in" ? { id, type, industries: ["gambling"], on_unknown: "flag" } : { id, type: "headcount_between", min: 20, max: 500, on_unknown: "flag" };

  return (
    <div className="panel raised">
      <div className="panel-head">
        <div><h2>{cloneOf ? `Clone of ${cloneOf.slug}` : `Edit ${spec.seller.name}`}</h2><span className="faint mono">{spec.id} · saving creates {cloneOf ? "version 1 of a new profile" : "the next version"}</span></div>
        <div className="row tight" style={{ marginTop: 0 }}>
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={save} disabled={broken || saving}>{saving ? "Saving…" : cloneOf ? "Save clone" : "Save new version"}</button>
        </div>
      </div>

      {broken && (
        <div className="banner bad" role="alert">
          <div>
            <strong>{problems.length} problem{problems.length > 1 ? "s" : ""}. The form is read-only until the YAML is valid again.</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{problems.slice(0, 8).map((p, i) => <li key={i}><span className="mono">{p.where}</span>: {p.message}</li>)}</ul>
          </div>
        </div>
      )}

      <div className="editor-split">
        <div>
          <div className="subtabs" role="tablist" aria-label="Profile sections" style={{ marginTop: 0 }}>
            {SECTIONS.map((s) => <button key={s} role="tab" className="subtab" aria-selected={section === s} onClick={() => setSection(s)}>{s}</button>)}
          </div>
          <fieldset disabled={broken} style={{ border: 0, padding: 0, margin: 0, opacity: broken ? 0.55 : 1 }}>
            {section === "Seller" && (
              <>
                <div className="field-grid">
                  <Field label="Profile id" hint="Lowercase letters, numbers, dashes."><input type="text" value={spec.id} onChange={(e) => set((x) => { x.id = e.target.value; })} /></Field>
                  <Field label="Seller name"><input type="text" value={spec.seller.name} onChange={(e) => set((x) => { x.seller.name = e.target.value; })} /></Field>
                  <Field label="Seller domain"><input type="text" value={spec.seller.domain} onChange={(e) => set((x) => { x.seller.domain = e.target.value; })} /></Field>
                  <Field label="Sender name"><input type="text" value={spec.seller.sender_name} onChange={(e) => set((x) => { x.seller.sender_name = e.target.value; })} /></Field>
                  <Field label="Sender title"><input type="text" value={spec.seller.sender_title} onChange={(e) => set((x) => { x.seller.sender_title = e.target.value; })} /></Field>
                </div>
                <Field label="One-line offer"><input type="text" value={spec.seller.one_line_offer} onChange={(e) => set((x) => { x.seller.one_line_offer = e.target.value; })} /></Field>
                <Field label="Ideal customer"><textarea style={area} value={spec.icp_summary} onChange={(e) => set((x) => { x.icp_summary = e.target.value; })} /></Field>
                <Field label="Allowed claims (one per line)" hint="Drafts may only claim what is listed."><textarea style={area} value={lines(spec.seller.allowed_claims)} onChange={(e) => set((x) => { x.seller.allowed_claims = unlines(e.target.value); })} /></Field>
                <Field label="The ask"><input type="text" value={spec.seller.ask} onChange={(e) => set((x) => { x.seller.ask = e.target.value; })} /></Field>
                <Field label="Tone notes"><input type="text" value={spec.seller.tone_notes ?? ""} onChange={(e) => set((x) => { x.seller.tone_notes = e.target.value; })} /></Field>
              </>
            )}

            {section === "Hard disqualifiers" && (
              <>
                <p className="muted">Checked by code against facts read from the site. A clear fail stops the account before anything else is spent on it. No model is involved in the verdict.</p>
                {spec.disqualifiers.map((d, i) => (
                  <div className="repeat" key={i}>
                    <div className="repeat-head"><strong>{d.id}</strong><button className="ghost small danger" onClick={() => set((x) => { x.disqualifiers.splice(i, 1); })}>Remove</button></div>
                    <div className="field-grid">
                      <Field label="Id"><input type="text" value={d.id} onChange={(e) => set((x) => { x.disqualifiers[i].id = e.target.value; })} /></Field>
                      <Field label="Rule"><select value={d.type} onChange={(e) => set((x) => { x.disqualifiers[i] = dqDefault(e.target.value as Disqualifier["type"], d.id); })}>
                        <option value="region_in">Region must be one of</option><option value="headcount_between">Company size between</option><option value="industry_not_in">Industry must not be</option></select></Field>
                    </div>
                    {d.type === "region_in" && <Field label="Allowed regions (comma separated)"><input type="text" value={d.regions.join(", ")} onChange={(e) => set((x) => { (x.disqualifiers[i] as typeof d).regions = csvList(e.target.value); })} /></Field>}
                    {d.type === "industry_not_in" && <Field label="Excluded industries (comma separated)"><input type="text" value={d.industries.join(", ")} onChange={(e) => set((x) => { (x.disqualifiers[i] as typeof d).industries = csvList(e.target.value); })} /></Field>}
                    {d.type === "headcount_between" && (
                      <div className="field-grid">
                        <Field label="Minimum employees"><input type="number" min={0} value={d.min ?? ""} onChange={(e) => set((x) => { (x.disqualifiers[i] as typeof d).min = e.target.value === "" ? undefined : Number(e.target.value); })} /></Field>
                        <Field label="Maximum employees"><input type="number" min={1} value={d.max ?? ""} onChange={(e) => set((x) => { (x.disqualifiers[i] as typeof d).max = e.target.value === "" ? undefined : Number(e.target.value); })} /></Field>
                      </div>
                    )}
                    <Field label="When the site does not say" hint="Flag keeps the lead and shows a warning. Drop removes it. Ignore does nothing.">
                      <select value={d.on_unknown} onChange={(e) => set((x) => { x.disqualifiers[i].on_unknown = e.target.value as Disqualifier["on_unknown"]; })}><option value="flag">Keep and flag</option><option value="drop">Drop the lead</option><option value="ignore">Ignore</option></select>
                    </Field>
                  </div>
                ))}
                {spec.disqualifiers.length < 6 && <div className="row"><button onClick={() => set((x) => { x.disqualifiers.push(dqDefault("region_in", `D${x.disqualifiers.length + 1}`)); })}>Add disqualifier</button></div>}
              </>
            )}

            {section === "Fit gates" && (
              <>
                <p className="muted">Up to four judgement questions the engine may research (read a page, search news) within the caps. Code decides when enough facts are known.</p>
                {spec.gates.map((g, i) => (
                  <div className="repeat" key={i}>
                    <div className="repeat-head"><strong>Gate {i + 1}</strong><button className="ghost small danger" onClick={() => set((x) => { x.gates.splice(i, 1); })}>Remove</button></div>
                    <div className="field-grid">
                      <Field label="Id"><input type="text" value={g.id} onChange={(e) => set((x) => { x.gates[i].id = e.target.value; })} /></Field>
                      <Field label="Kind"><select value={g.kind} onChange={(e) => set((x) => { x.gates[i].kind = e.target.value as typeof g.kind; })}><option>classification</option><option>stage</option><option>exclusion</option><option>signal_present</option></select></Field>
                    </div>
                    <Field label="Question"><input type="text" value={g.question} onChange={(e) => set((x) => { x.gates[i].question = e.target.value; })} /></Field>
                    <Field label="Passes when"><input type="text" value={g.pass_when} onChange={(e) => set((x) => { x.gates[i].pass_when = e.target.value; })} /></Field>
                    <Field label="Fails when (optional)"><input type="text" value={g.fail_when ?? ""} onChange={(e) => set((x) => { x.gates[i].fail_when = e.target.value || undefined; })} /></Field>
                    <Field label="Facts needed (comma separated)"><input type="text" value={g.required_fields.join(", ")} onChange={(e) => set((x) => { x.gates[i].required_fields = csvList(e.target.value); })} /></Field>
                    <Field label="Where to look">
                      <div className="row tight" style={{ marginTop: 0 }}>{PAGE_TYPES.map((p) => <button key={p} className="chip" aria-pressed={g.where_to_look.includes(p)} onClick={() => set((x) => { const w = x.gates[i].where_to_look; x.gates[i].where_to_look = w.includes(p) ? w.filter((q) => q !== p) : [...w, p]; })}>{p}</button>)}</div>
                    </Field>
                    <Field label="When it stays unknown" hint={g.unknown_policy.type === "soft_pass_if" ? "Soft pass proxies are edited in the YAML pane." : undefined}>
                      <select value={g.unknown_policy.type} onChange={(e) => set((x) => { const t = e.target.value; if (t === "drop") x.gates[i].unknown_policy = { type: "drop" }; else if (t === "qualify_and_flag") x.gates[i].unknown_policy = { type: "qualify_and_flag", flag: "unconfirmed" }; })}>
                        <option value="drop">Drop the lead</option><option value="qualify_and_flag">Qualify and flag</option>{g.unknown_policy.type === "soft_pass_if" && <option value="soft_pass_if">Soft pass on proxies</option>}
                      </select>
                      {g.unknown_policy.type === "qualify_and_flag" && <input type="text" style={{ marginTop: 6 }} aria-label="Flag name" value={g.unknown_policy.flag} onChange={(e) => set((x) => { x.gates[i].unknown_policy = { type: "qualify_and_flag", flag: e.target.value }; })} />}
                    </Field>
                  </div>
                ))}
                {spec.gates.length < 4 && <div className="row"><button onClick={() => set((x) => { x.gates.push({ id: `G${x.gates.length + 1}`, question: "New question?", kind: "signal_present", pass_when: "Describe what a pass looks like.", required_fields: ["company_type"], where_to_look: ["homepage"], unknown_policy: { type: "qualify_and_flag", flag: "unconfirmed" } }); })}>Add gate</button></div>}
                <h3>Custom facts</h3>
                {spec.custom_fields.map((f, i) => (
                  <div className="repeat" key={i}>
                    <div className="repeat-head"><strong className="mono">{f.name || "new_fact"}</strong><button className="ghost small danger" onClick={() => set((x) => { x.custom_fields.splice(i, 1); })}>Remove</button></div>
                    <div className="field-grid">
                      <Field label="Name"><input type="text" value={f.name} onChange={(e) => set((x) => { x.custom_fields[i].name = e.target.value; })} /></Field>
                      <Field label="Type"><select value={f.type} onChange={(e) => set((x) => { x.custom_fields[i].type = e.target.value as typeof f.type; })}><option>string</option><option>number</option><option>bool</option><option>enum</option></select></Field>
                    </div>
                    <Field label="Description"><input type="text" value={f.description} onChange={(e) => set((x) => { x.custom_fields[i].description = e.target.value; })} /></Field>
                  </div>
                ))}
                <div className="row"><button onClick={() => set((x) => { x.custom_fields.push({ name: "new_fact", type: "string", description: "What to look for." }); })}>Add fact</button></div>
              </>
            )}

            {section === "Weighted criteria" && (
              <>
                <p className="muted">Up to five signals that rank qualified leads. Scoring weights add to 100. Hook-only signals add colour to the draft but no points.</p>
                <div className={`banner ${weightTotal === 100 ? "info" : "warn"}`}><span>Weights total <strong>{weightTotal}</strong> of 100.</span></div>
                {spec.signals.map((s, i) => (
                  <div className="repeat" key={i}>
                    <div className="repeat-head"><strong>Signal {i + 1}</strong><button className="ghost small danger" onClick={() => set((x) => { x.signals.splice(i, 1); })}>Remove</button></div>
                    <div className="field-grid">
                      <Field label="Id"><input type="text" value={s.id} onChange={(e) => set((x) => { x.signals[i].id = e.target.value; })} /></Field>
                      <Field label="Weight"><input type="number" min={0} max={100} value={s.weight} onChange={(e) => set((x) => { x.signals[i].weight = Number(e.target.value); })} /></Field>
                    </div>
                    <Field label="Passes when"><input type="text" value={s.passes_when} onChange={(e) => set((x) => { x.signals[i].passes_when = e.target.value; })} /></Field>
                    <label className="check"><input type="checkbox" checked={Boolean(s.hook_only)} onChange={(e) => set((x) => { x.signals[i].hook_only = e.target.checked || undefined; if (e.target.checked) x.signals[i].weight = 0; })} /> Hook only (no points)</label>
                  </div>
                ))}
                {spec.signals.length < 5 && <div className="row"><button onClick={() => set((x) => { x.signals.push({ id: `S${x.signals.length + 1}`, passes_when: "Describe the signal.", weight: 0, unanswered: "ignore" }); })}>Add signal</button></div>}
                <Field label="Soft-pass penalty (points)" hint="Deducted when a gate passed only on proxies."><input type="number" min={0} value={spec.soft_pass_penalty} onChange={(e) => set((x) => { x.soft_pass_penalty = Number(e.target.value); })} /></Field>
              </>
            )}

            {section === "Personas" && (
              <>
                <p className="muted">Who to write to, in order of preference. The first tier with a candidate above the confidence bar wins.</p>
                {spec.personas.map((p, i) => (
                  <div className="repeat" key={i}>
                    <div className="repeat-head"><strong>Tier {p.tier}</strong>{spec.personas.length > 1 && <button className="ghost small danger" onClick={() => set((x) => { x.personas.splice(i, 1); })}>Remove</button>}</div>
                    <div className="field-grid">
                      <Field label="Tier"><input type="number" min={1} value={p.tier} onChange={(e) => set((x) => { x.personas[i].tier = Number(e.target.value); })} /></Field>
                      <Field label="Applies when"><select value={p.applies_when === "always" ? "always" : "small"} onChange={(e) => set((x) => { x.personas[i].applies_when = e.target.value === "always" ? "always" : { headcount_below: 80 }; })}><option value="always">Always</option><option value="small">Only small companies</option></select></Field>
                    </div>
                    {p.applies_when !== "always" && <Field label="Headcount below"><input type="number" value={p.applies_when.headcount_below} onChange={(e) => set((x) => { x.personas[i].applies_when = { headcount_below: Number(e.target.value) }; })} /></Field>}
                    <Field label="Titles (one per line)"><textarea style={area} value={lines(p.titles)} onChange={(e) => set((x) => { x.personas[i].titles = unlines(e.target.value); })} /></Field>
                    <Field label="Exclude titles containing"><input type="text" value={p.exclude_titles.join(", ")} onChange={(e) => set((x) => { x.personas[i].exclude_titles = csvList(e.target.value); })} /></Field>
                    <Field label="Pain lenses (one per line)"><textarea style={area} value={lines(p.pain_lens)} onChange={(e) => set((x) => { x.personas[i].pain_lens = unlines(e.target.value); })} /></Field>
                  </div>
                ))}
                <div className="row"><button onClick={() => set((x) => { x.personas.push({ tier: x.personas.length + 1, titles: ["Job title"], exclude_titles: ["assistant", "intern", "former"], applies_when: "always", pain_lens: ["What they care about"] }); })}>Add tier</button></div>
              </>
            )}

            {section === "Execution caps" && (
              <>
                <p className="muted">Hard limits. The engine stops spending as soon as one is reached. Some caps take effect in the run engine (Phase 2); they are stored with the profile now.</p>
                <div className="field-grid">
                  <Field label="Max accounts per run (1 to 100)"><input type="number" min={1} max={100} value={spec.limits.max_accounts_per_run} onChange={(e) => set((x) => { x.limits.max_accounts_per_run = Number(e.target.value); })} /></Field>
                  <Field label="Max contacts per account (1 to 20)"><input type="number" min={1} max={20} value={spec.limits.max_contacts_per_account} onChange={(e) => set((x) => { x.limits.max_contacts_per_account = Number(e.target.value); })} /></Field>
                  <Field label="Max agent loop steps (1 to 40)"><input type="number" min={1} max={40} value={spec.limits.max_loop_steps} onChange={(e) => set((x) => { x.limits.max_loop_steps = Number(e.target.value); })} /></Field>
                  <Field label="Token budget per account"><input type="number" min={1000} step={1000} value={spec.limits.max_tokens_per_account} onChange={(e) => set((x) => { x.limits.max_tokens_per_account = Number(e.target.value); })} /></Field>
                  <Field label="Page fetches per account (1 to 8)"><input type="number" min={1} max={8} value={spec.limits.fetch_calls} onChange={(e) => set((x) => { x.limits.fetch_calls = Number(e.target.value); })} /></Field>
                  <Field label="News searches per account (0 to 5)"><input type="number" min={0} max={5} value={spec.limits.news_calls} onChange={(e) => set((x) => { x.limits.news_calls = Number(e.target.value); })} /></Field>
                  <Field label="Hunter min confidence (0 to 100)"><input type="number" min={0} max={100} value={spec.limits.hunter_min_confidence} onChange={(e) => set((x) => { x.limits.hunter_min_confidence = Number(e.target.value); })} /></Field>
                </div>
              </>
            )}

            {section === "Email" && (
              <>
                <div className="field-grid">
                  <Field label="Min words"><input type="number" value={spec.email.min_words} onChange={(e) => set((x) => { x.email.min_words = Number(e.target.value); })} /></Field>
                  <Field label="Max words"><input type="number" value={spec.email.max_words} onChange={(e) => set((x) => { x.email.max_words = Number(e.target.value); })} /></Field>
                  <Field label="Subject max words"><input type="number" value={spec.email.subject_max_words} onChange={(e) => set((x) => { x.email.subject_max_words = Number(e.target.value); })} /></Field>
                </div>
                <Field label="Banned phrases (comma separated)"><input type="text" value={spec.email.banned_phrases.join(", ")} onChange={(e) => set((x) => { x.email.banned_phrases = csvList(e.target.value); })} /></Field>
                <label className="check"><input type="checkbox" checked={spec.email.question_hook_when_flagged} onChange={(e) => set((x) => { x.email.question_hook_when_flagged = e.target.checked; })} /> Open with a question when the lead has an unconfirmed flag</label>
              </>
            )}
          </fieldset>
        </div>

        <div>
          <div className="panel-head" style={{ marginBottom: 6 }}>
            <strong>YAML</strong>
            <div className="row tight" style={{ marginTop: 0 }}>
              <CopyButton text={text} label="Copy" />
              <button className="small" onClick={() => download(`${spec.id}.yaml`, text, "text/yaml")}>Download</button>
            </div>
          </div>
          <div className={`yaml-editor${broken ? " has-error" : ""}`}>
            <div className="gutter mono" ref={gutter} aria-hidden>{Array.from({ length: lineCount }, (_, i) => i + 1).join("\n")}</div>
            <textarea className="mono" value={text} spellCheck={false} wrap="off" aria-label="Profile YAML" aria-invalid={broken}
              onChange={(e) => onYaml(e.target.value)} onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }} />
          </div>
          <p className="hint">Edits here update the form as soon as the YAML is valid. Comments are not kept when the form regenerates the YAML.</p>
        </div>
      </div>
    </div>
  );
}
