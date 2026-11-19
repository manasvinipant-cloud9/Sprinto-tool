import { createLLM, type LLM } from "./llm";
import { fetchPage as realFetchPage, type FetchCtx, type PageResult } from "./scrape";
import { Budget, searchNews as realSearchNews, type NewsResult } from "./tools";
import { emptyFacts, extractFacts, type Evidence } from "./extract";
import { runGates, type LoopState } from "./gates";
import { checkDisqualifiers } from "./disqualifiers";
import { CapError, Governor } from "./governor";
import { clip, purposeOf, Tracer } from "./trace";
import { scoreSignals } from "./score";
import { hunterSearch, pickContact, type RawContact } from "./poc";
import { findPains } from "./pains";
import { draftEmail } from "./email";
import type { Profile } from "./profile-schema";
import { profileHash } from "./profile-hash";
import type { DomainResult, Status } from "./types";

export type Stage = "researching" | "gate_evaluation" | "contact_lookup" | "drafting";

export interface Deps {
  llm: LLM;
  fetchPage(url: string): Promise<PageResult>;
  searchNews(q: string): Promise<NewsResult>;
  hunter(domain: string): Promise<RawContact[]>;
  overrides(): Record<string, { name: string; email: string; title: string }>;
  /** Optional progress hook, awaited so stage writes stay in order. */
  onStage?(stage: Stage): void | Promise<void>;
}

export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : null;
}

export function realDeps(llm: LLM, pageCache?: { get(url: string): Promise<PageResult | null>; put(url: string, r: PageResult): Promise<void> }, opts: { hunterKey?: string } = {}): Deps {
  const ctx = new Map<string, FetchCtx>();
  return {
    llm,
    fetchPage: async (url) => {
      const hit = await pageCache?.get(url).catch(() => null);
      if (hit) return hit;
      const host = new URL(url).hostname.replace(/^www\./, "");
      const base = host.split(".").slice(-2).join(".");
      if (!ctx.has(base)) ctx.set(base, { baseDomain: base, cache: new Map() });
      const r = await realFetchPage(url, ctx.get(base)!);
      await pageCache?.put(url, r).catch(() => undefined);
      return r;
    },
    searchNews: realSearchNews,
    hunter: (domain) => hunterSearch(domain, opts.hunterKey),
    overrides: () => ({}),
  };
}

export async function runDomain(rawDomain: string, profile: Profile, baseDeps: Deps): Promise<DomainResult> {
  const t0 = Date.now();
  // Spending limits are enforced here in code: every model call is checked against the token budget first.
  const gov = new Governor(profile.limits.max_loop_steps, profile.limits.max_tokens_per_account, baseDeps.llm.usage);
  const tracer = new Tracer();
  const u = baseDeps.llm.usage;
  const deps: Deps = {
    ...baseDeps,
    llm: {
      usage: u,
      json: async (o) => {
        const label = purposeOf(o.system);
        try { gov.guardTokens(); } catch (e) {
          tracer.add({ kind: "llm", label, input: clip(o.prompt, 300), output: `Refused: token budget reached (${gov.tokens} of ${gov.maxTokens}). The call was not made.`, status: "refused_cap", ms: 0, tokens_in: 0, tokens_out: 0 });
          throw e;
        }
        const t = Date.now(); const p0 = u.prompt; const o0 = u.output;
        try {
          const out = await baseDeps.llm.json(o);
          tracer.add({ kind: "llm", label, input: clip(o.prompt), output: clip(JSON.stringify(out)), status: "ok", ms: Date.now() - t, tokens_in: u.prompt - p0, tokens_out: u.output - o0 });
          return out;
        } catch (e) {
          tracer.add({ kind: "llm", label, input: clip(o.prompt), output: clip((e as Error).message, 300), status: "error", ms: Date.now() - t, tokens_in: u.prompt - p0, tokens_out: u.output - o0 });
          throw e;
        }
      },
    },
  };
  const stage = async (s: Stage) => { tracer.phase = s; await deps.onStage?.(s); };
  const domain = normalizeDomain(rawDomain) ?? rawDomain.trim();
  const facts = emptyFacts(profile);
  const evidence: Record<string, Evidence> = {};
  const state: LoopState = {
    domain, profile, facts, evidence,
    budget: new Budget(profile.limits.fetch_calls, profile.limits.news_calls),
    toolCalls: [], fetched: new Set(), blocked: new Set(), gates: [], flags: [],
    softPass: false, outcome: null, dropReason: null, gov, cap: null, tracer,
  };
  const result: DomainResult = {
    domain, status: "error", reason: "", outcome: null, score: null, score_breakdown: [], flags: [], facts, evidence: {}, gates: [],
    tool_calls: state.toolCalls, contact: null, candidates: [], pains: [], email: null,
    profile: { id: profile.id, version: profile.version, hash: profileHash(profile) },
    tokens: { prompt: 0, output: 0, calls: 0 }, loops: { steps: 0, fetches: 0, searches: 0, max_steps: profile.limits.max_loop_steps, max_tokens: profile.limits.max_tokens_per_account }, capped: null, contact_decision: null, trace: [], started_at: new Date().toISOString(), ms: 0,
  };
  const finish = (status: Status, reason: string): DomainResult => {
    result.status = status;
    result.reason = reason;
    result.flags = state.flags;
    result.evidence = Object.fromEntries(Object.entries(evidence).map(([k, v]) => [k, { text: v.text, url: v.url }]));
    result.gates = state.gates;
    result.outcome = state.outcome;
    result.tokens = { ...deps.llm.usage };
    result.loops = { ...result.loops, steps: gov.steps, fetches: gov.fetches, searches: gov.searches };
    if (state.cap) result.capped = { reason: state.cap.reason, detail: state.cap.detail };
    result.trace = tracer.steps;
    result.ms = Date.now() - t0;
    return result;
  };

  try {
    if (!normalizeDomain(rawDomain)) return finish("error", "invalid_domain");

    await stage("researching");
    // Homepage read is free (not counted against the call budget).
    const home = `https://${domain}/`;
    const t1 = Date.now();
    const page = await deps.fetchPage(home);
    state.fetched.add(home);
    state.toolCalls.push({ tool: "fetch_page", arg: home, status: page.status, ms: Date.now() - t1, words: page.words, note: page.note });
    tracer.add({ kind: "fetch_page", label: "read homepage (free, not a loop step)", input: home, output: `${page.status}${page.note ? ` (${page.note})` : ""}, ${page.words ?? 0} words`, status: page.status, ms: Date.now() - t1, tokens_in: 0, tokens_out: 0 });
    if (page.status !== "ok") return finish("error", `homepage_${page.status}${page.note ? ":" + page.note : ""} (queue for human review)`);
    await extractFacts(deps.llm, profile, page.text, home, facts, evidence);

    // Hard disqualifiers run in code. First pass stops on clear failures; second pass (after the gates) applies the unknown policy.
    const dq1 = checkDisqualifiers(profile, facts, evidence, false);
    if (dq1.failed) {
      state.gates.push(...dq1.results.filter((r) => r.answer !== "unknown" || r === dq1.failed));
      for (const r of dq1.results.filter((x) => x.answer !== "unknown" || x === dq1.failed)) tracer.add({ kind: "gate", ctx: r.id, label: "hard disqualifier (code)", input: r.question, output: `${r.answer.toUpperCase()}: ${r.evidence}`, status: r.answer, ms: 0, tokens_in: 0, tokens_out: 0 });
      state.outcome = "drop";
      return finish("dropped", `${dq1.failed.id}_fail: ${dq1.failed.evidence}`);
    }

    await stage("gate_evaluation");
    await runGates(deps, state);
    if (state.cap) return finish("capped", `cap:${state.cap.reason} (${state.cap.detail})`);
    if (state.outcome === "drop") return finish("dropped", state.dropReason ?? "dropped");

    const dq2 = checkDisqualifiers(profile, facts, evidence, true);
    state.gates.unshift(...dq2.results);
    for (const r of dq2.results) tracer.add({ kind: "gate", ctx: r.id, label: "hard disqualifier (code), final pass", input: r.question, output: `${r.answer.toUpperCase()}: ${r.evidence}${r.policy_applied ? ` [${r.policy_applied}]` : ""}`, status: r.answer, ms: 0, tokens_in: 0, tokens_out: 0 });
    state.flags.push(...dq2.flags);
    if (dq2.failed) {
      state.outcome = "drop";
      return finish("dropped", `${dq2.failed.id}_${dq2.failed.answer === "fail" ? "fail" : "unresolved"}: ${dq2.failed.evidence}`);
    }
    if (dq2.flags.length && state.outcome === "qualify") state.outcome = "qualify_and_flag";

    const sc = await scoreSignals(deps.llm, profile, facts, evidence, state.softPass);
    result.score = sc.score;
    result.score_breakdown = sc.breakdown;
    state.flags.push(...sc.flags);

    await stage("contact_lookup");
    // Contact: manual override wins, then Hunter.
    const headcount = typeof facts.headcount_max === "number" ? facts.headcount_max : typeof facts.headcount_min === "number" ? facts.headcount_min : null;
    const over = deps.overrides()[domain];
    const tc = Date.now();
    let raw: RawContact[];
    if (over) {
      raw = [{ name: over.name, email: over.email, title: over.title, confidence: 100 }];
    } else {
      try {
        raw = await deps.hunter(domain);
      } catch (e) {
        const msg = (e as Error).message;
        const permanent = (e as { permanent?: boolean }).permanent;
        tracer.add({ kind: "contact_lookup", label: "Hunter domain search", input: domain, output: msg, status: "error", ms: Date.now() - tc, tokens_in: 0, tokens_out: 0 });
        return finish("error", permanent ? `abort:${msg}` : `contact_lookup_failed:${msg}`);
      }
    }
    const { contact, considered, tierLog } = pickContact(profile, raw, headcount);
    result.candidates = considered;
    result.contact_decision = { source: over ? "override" : "hunter", min_confidence: profile.limits.hunter_min_confidence, headcount, found: raw.length, considered: considered.length, tiers: tierLog };
    tracer.add({
      kind: "contact_lookup", label: over ? "manual override" : "Hunter domain search", input: domain,
      output: `${raw.length} found, ${considered.length} considered (cap ${profile.limits.max_contacts_per_account}). ${contact ? `Chose ${contact.name}, ${contact.title}: ${contact.reason}.` : "No one cleared the persona titles and confidence bar."}`,
      status: contact ? "ok" : "none_chosen", ms: Date.now() - tc, tokens_in: 0, tokens_out: 0,
    });
    if (!contact) return finish("qualified_no_poc", `no contact at a listed title with confidence of ${profile.limits.hunter_min_confidence} or more`);
    result.contact = contact;

    await stage("drafting");
    const { pains, generic } = await findPains(deps.llm, profile, contact, facts, evidence, state.gates);
    result.pains = pains.map((p) => ({ ...p, url: p.evidence_field.startsWith("gate:") ? state.gates.find((g) => g.id === p.evidence_field.slice(5))?.source_url : evidence[p.evidence_field]?.url }));
    if (generic) state.flags.push("generic_pain");

    const flagged = state.outcome === "qualify_and_flag";
    const draft = await draftEmail(deps.llm, profile, contact, facts, pains, flagged);
    result.email = draft;
    tracer.add({ kind: "draft", label: "lint check (code)", input: `${draft.body.trim().split(/\s+/).length} words, subject "${draft.subject}"`, output: draft.lint.length ? `Failed: ${draft.lint.join("; ")}` : `Passed after ${draft.regenerations} regeneration(s)`, status: draft.lint.length ? "fail" : "pass", ms: 0, tokens_in: 0, tokens_out: 0 });
    if (draft.lint.length) return finish("held", `draft_failed_lint: ${draft.lint.join("; ")}`);

    // The engine stops at a reviewed draft. There is no send path by design.
    return finish("drafted", "draft ready for human review");
  } catch (e) {
    if (e instanceof CapError) {
      state.cap = { reason: e.reason, detail: e.reason === "token_budget" ? `used ${gov.tokens} of ${gov.maxTokens} tokens` : `used ${gov.steps} of ${gov.maxSteps} loop steps` };
      return finish("capped", `cap:${e.reason} (${state.cap.detail})`);
    }
    const status = (e as { status?: number }).status;
    const auth = status === 401 || status === 403;
    return finish("error", auth ? `abort:llm_auth_${status}` : `error:${(e as Error).message}`);
  }
}

export { createLLM };
