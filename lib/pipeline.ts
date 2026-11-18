import { createLLM, type LLM } from "./llm";
import { fetchPage as realFetchPage, type FetchCtx, type PageResult } from "./scrape";
import { Budget, searchNews as realSearchNews, type NewsResult } from "./tools";
import { emptyFacts, extractFacts, type Evidence } from "./extract";
import { runGates, type LoopState } from "./gates";
import { scoreSignals } from "./score";
import { hunterSearch, pickContact, type RawContact } from "./poc";
import { findPains } from "./pains";
import { draftEmail } from "./email";
import { reviewBlock, sendTestEmail } from "./send";
import { loadOverrides } from "./profiles";
import { profileHash, type Profile } from "./profile-schema";
import type { DomainResult, Status } from "./types";

export interface Deps {
  llm: LLM;
  fetchPage(url: string): Promise<PageResult>;
  searchNews(q: string): Promise<NewsResult>;
  hunter(domain: string): Promise<RawContact[]>;
  overrides(): Record<string, { name: string; email: string; title: string }>;
  send(subject: string, body: string): Promise<{ ok: boolean; message: string }>;
}

export function normalizeDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : null;
}

export function realDeps(llm: LLM): Deps {
  const ctx = new Map<string, FetchCtx>();
  return {
    llm,
    fetchPage: (url) => {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const base = host.split(".").slice(-2).join(".");
      if (!ctx.has(base)) ctx.set(base, { baseDomain: base, cache: new Map() });
      return realFetchPage(url, ctx.get(base)!);
    },
    searchNews: realSearchNews,
    hunter: hunterSearch,
    overrides: loadOverrides,
    send: sendTestEmail,
  };
}

export async function runDomain(rawDomain: string, profile: Profile, opts: { send: boolean }, deps: Deps): Promise<DomainResult> {
  const t0 = Date.now();
  const domain = normalizeDomain(rawDomain) ?? rawDomain.trim();
  const facts = emptyFacts(profile);
  const evidence: Record<string, Evidence> = {};
  const state: LoopState = {
    domain, profile, facts, evidence,
    budget: new Budget(profile.limits.fetch_calls, profile.limits.news_calls),
    toolCalls: [], fetched: new Set(), blocked: new Set(), gates: [], flags: [],
    softPass: false, outcome: null, dropReason: null,
  };
  const result: DomainResult = {
    domain, status: "error", reason: "", outcome: null, score: null, score_breakdown: [], flags: [], facts, gates: [],
    tool_calls: state.toolCalls, contact: null, candidates: [], pains: [], email: null, send: null,
    profile: { id: profile.id, version: profile.version, hash: profileHash(profile) },
    tokens: { prompt: 0, output: 0, calls: 0 }, started_at: new Date().toISOString(), ms: 0,
  };
  const finish = (status: Status, reason: string): DomainResult => {
    result.status = status;
    result.reason = reason;
    result.flags = state.flags;
    result.gates = state.gates;
    result.outcome = state.outcome;
    result.tokens = { ...deps.llm.usage };
    result.ms = Date.now() - t0;
    return result;
  };

  try {
    if (!normalizeDomain(rawDomain)) return finish("error", "invalid_domain");

    // Homepage read is free (not counted against the call budget).
    const home = `https://${domain}/`;
    const t1 = Date.now();
    const page = await deps.fetchPage(home);
    state.fetched.add(home);
    state.toolCalls.push({ tool: "fetch_page", arg: home, status: page.status, ms: Date.now() - t1, words: page.words, note: page.note });
    if (page.status !== "ok") return finish("error", `homepage_${page.status}${page.note ? ":" + page.note : ""} (queue for human review)`);
    await extractFacts(deps.llm, profile, page.text, home, facts, evidence);

    await runGates(deps, state);
    if (state.outcome === "drop") return finish("dropped", state.dropReason ?? "dropped");

    const sc = await scoreSignals(deps.llm, profile, facts, evidence, state.softPass);
    result.score = sc.score;
    result.score_breakdown = sc.breakdown;
    state.flags.push(...sc.flags);

    // Contact: manual override wins, then Hunter.
    const headcount = typeof facts.headcount_max === "number" ? facts.headcount_max : typeof facts.headcount_min === "number" ? facts.headcount_min : null;
    const over = deps.overrides()[domain];
    let raw: RawContact[];
    if (over) {
      raw = [{ name: over.name, email: over.email, title: over.title, confidence: 100 }];
    } else {
      try {
        raw = await deps.hunter(domain);
      } catch (e) {
        const msg = (e as Error).message;
        const permanent = (e as { permanent?: boolean }).permanent;
        return finish("error", permanent ? `abort:${msg}` : `contact_lookup_failed:${msg}`);
      }
    }
    const { contact, considered } = pickContact(profile, raw, headcount);
    result.candidates = considered;
    if (!contact) return finish("qualified_no_poc", `no contact at a listed title with confidence of ${profile.limits.hunter_min_confidence} or more`);
    result.contact = contact;

    const { pains, generic } = await findPains(deps.llm, profile, contact, facts, evidence, state.gates);
    result.pains = pains;
    if (generic) state.flags.push("generic_pain");

    const flagged = state.outcome === "qualify_and_flag";
    const draft = await draftEmail(deps.llm, profile, contact, facts, pains, flagged);
    result.email = draft;
    if (draft.lint.length) return finish("held", `draft_failed_lint: ${draft.lint.join("; ")}`);

    if (!opts.send) return finish("drafted", "drafted, sending switched off");
    const company = (facts.company_name as string) || domain;
    const why = state.gates.map((g) => `${g.id} ${g.answer}`).join(", ");
    const subject = `[TEST for ${contact.name}, ${contact.title}, ${company}] ${draft.subject}`;
    const body =
      reviewBlock({ intended: contact.email, title: contact.title, company, tier: contact.tier, confidence: contact.confidence, score: result.score, outcome: state.outcome ?? "", flags: state.flags, why }) +
      draft.body;
    const s = await deps.send(subject, body);
    result.send = s;
    return finish(s.ok ? "sent" : "send_failed", s.ok ? "sent to your own inbox in test mode" : s.message);
  } catch (e) {
    const status = (e as { status?: number }).status;
    const auth = status === 401 || status === 403;
    return finish("error", auth ? `abort:llm_auth_${status}` : `error:${(e as Error).message}`);
  }
}

export { createLLM };
