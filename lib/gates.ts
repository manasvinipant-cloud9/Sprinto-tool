import { z } from "zod";
import type { LLM } from "./llm";
import { PAGE_PATHS, type Gate, type PageType, type Profile } from "./profile-schema";
import { extractFacts, isFilled, type Evidence } from "./extract";
import { Budget, summariseNews, TOOL_DESCRIPTIONS, type NewsResult } from "./tools";
import type { PageResult } from "./scrape";
import type { Facts, GateAnswer, GateResult, ToolCall } from "./types";

export interface LoopDeps {
  llm: LLM;
  fetchPage(url: string): Promise<PageResult>;
  searchNews(query: string): Promise<NewsResult>;
}

export interface LoopState {
  domain: string;
  profile: Profile;
  facts: Facts;
  evidence: Record<string, Evidence>;
  budget: Budget;
  toolCalls: ToolCall[];
  fetched: Set<string>;
  blocked: Set<string>;
  gates: GateResult[];
  flags: string[];
  softPass: boolean;
  outcome: "qualify" | "qualify_and_flag" | "drop" | null;
  dropReason: string | null;
}

/** Code (not the model) decides whether a gate has enough facts to be judged. */
export function isResolved(gate: Gate, facts: Facts): boolean {
  const vals = gate.required_fields.map((f) => facts[f]);
  if ((gate.kind === "signal_present" || gate.kind === "exclusion") && vals.some((v) => isFilled(v) && v !== false)) return true;
  return vals.every((v) => v !== null && v !== undefined);
}

export function anyFilled(gate: Gate, facts: Facts): boolean {
  return gate.required_fields.some((f) => facts[f] !== null && facts[f] !== undefined);
}

interface Candidate { kind: "fetch_page" | "search_news"; arg: string; pageType: PageType }

export function candidatesFor(gate: Gate, state: LoopState): Candidate[] {
  const out: Candidate[] = [];
  for (const pt of gate.where_to_look) {
    if (pt === "news_search") {
      if (state.budget.canNews()) {
        const name = (state.facts.company_name as string) || state.domain;
        out.push({ kind: "search_news", arg: `${name} funding round`, pageType: pt });
      }
      continue;
    }
    if (!state.budget.canFetch()) continue;
    for (const p of PAGE_PATHS[pt]) {
      const url = `https://${state.domain}${p}`;
      if (!state.fetched.has(url) && !state.blocked.has(url)) out.push({ kind: "fetch_page", arg: url, pageType: pt });
    }
  }
  return out;
}

const actionSchema = z.object({
  tool: z.enum(["fetch_page", "search_news", "stop"]),
  arg: z.string().optional(),
  reason: z.string().optional(),
});

async function chooseAction(deps: LoopDeps, gate: Gate, state: LoopState, cands: Candidate[]): Promise<Candidate | null> {
  if (cands.length === 0) return null;
  const missing = gate.required_fields.filter((f) => !isFilled(state.facts[f]));
  const system = "You decide which single tool call would best fill missing facts for one decision. " + TOOL_DESCRIPTIONS;
  const prompt =
    `Decision: ${gate.question}\nMissing fields: ${missing.join(", ")}\n` +
    `Budget left: ${state.budget.maxFetch - state.budget.fetches} page fetches, ${state.budget.maxNews - state.budget.news} news searches.\n` +
    `Allowed next calls (choose exactly one, or "stop" if none would help):\n` +
    cands.map((c) => `- ${c.kind}: ${c.arg}`).join("\n") +
    `\nReturn JSON: {"tool": "fetch_page"|"search_news"|"stop", "arg": "<exact url or query from the list>", "reason": "<one short line>"}`;
  try {
    const a = await deps.llm.json({ tier: "cheap", system, prompt, schema: actionSchema });
    if (a.tool === "stop") return null;
    const hit = cands.find((c) => c.kind === a.tool && (c.arg === a.arg || a.tool === "search_news"));
    if (hit) return a.tool === "search_news" && a.arg ? { ...hit, arg: a.arg.slice(0, 120) } : hit;
  } catch {
    /* fall through to the deterministic choice */
  }
  return cands[0];
}

async function runTool(deps: LoopDeps, state: LoopState, c: Candidate, gate: Gate): Promise<void> {
  const t0 = Date.now();
  if (c.kind === "fetch_page") {
    state.budget.fetches++;
    state.fetched.add(c.arg);
    const r = await deps.fetchPage(c.arg);
    state.toolCalls.push({ tool: "fetch_page", arg: c.arg, status: r.status, ms: Date.now() - t0, words: r.words, note: r.note });
    if (r.status === "blocked" || r.status === "robots_disallowed") state.blocked.add(c.arg);
    if (r.status === "ok") {
      await extractFacts(deps.llm, state.profile, r.text, c.arg, state.facts, state.evidence);
    }
  } else {
    state.budget.news++;
    const r = await deps.searchNews(c.arg);
    state.toolCalls.push({ tool: "search_news", arg: c.arg, status: r.status, ms: Date.now() - t0, note: r.note });
    if (r.status === "ok") {
      await extractFacts(deps.llm, state.profile, "NEWS RESULTS\n" + summariseNews(r), "news:" + c.arg, state.facts, state.evidence);
    }
  }
  void gate;
}

const judgeSchema = z.object({ answer: z.enum(["pass", "fail", "unknown"]), evidence: z.string() });

async function judge(deps: LoopDeps, gate: Gate, state: LoopState): Promise<{ answer: GateAnswer; evidence: string }> {
  const ev = gate.required_fields
    .filter((f) => isFilled(state.facts[f]) || state.facts[f] === false)
    .map((f) => `- ${f} = ${JSON.stringify(state.facts[f])} (evidence: ${state.evidence[f]?.text ?? "n/a"})`)
    .join("\n");
  const system =
    "You judge one qualification gate from extracted facts. Use only the facts given. If they do not settle it, answer unknown. Never use outside knowledge.";
  const prompt =
    `Gate: ${gate.question}\nPasses when: ${gate.pass_when}\n${gate.fail_when ? `Fails when: ${gate.fail_when}\n` : ""}` +
    `Other known facts: ${JSON.stringify({ funding_stage: state.facts.funding_stage, company_type: state.facts.company_type })}\n\nFACTS:\n${ev}\n\n` +
    `Return JSON: {"answer": "pass"|"fail"|"unknown", "evidence": "<one sentence citing the facts>"}`;
  return deps.llm.json({ tier: "cheap", system, prompt, schema: judgeSchema });
}

export function proxyHolds(p: { field: string; op: string; value?: number }, facts: Facts): boolean {
  const v = facts[p.field];
  switch (p.op) {
    case "gte": return typeof v === "number" && v >= (p.value ?? 0);
    case "lte": return typeof v === "number" && v <= (p.value ?? 0);
    case "truthy": return v === true || (typeof v === "string" && v !== "");
    case "count_gte": return Array.isArray(v) && v.length >= (p.value ?? 0);
    default: return false;
  }
}

export async function runGates(deps: LoopDeps, state: LoopState): Promise<void> {
  for (const gate of state.profile.gates) {
    let attempts = 0;
    while (!isResolved(gate, state.facts)) {
      const cands = candidatesFor(gate, state);
      const choice = await chooseAction(deps, gate, state, cands);
      if (!choice) break;
      await runTool(deps, state, choice, gate);
      attempts++;
    }

    let answer: GateAnswer = "unknown";
    let evidence = "No required facts were found within the call budget.";
    if (anyFilled(gate, state.facts)) {
      const j = await judge(deps, gate, state);
      answer = j.answer;
      evidence = j.evidence;
    }
    const source = gate.required_fields.map((f) => state.evidence[f]?.url).find(Boolean);
    const result: GateResult = { id: gate.id, question: gate.question, answer, evidence, source_url: source, attempts };

    if (answer === "fail") {
      state.gates.push(result);
      state.outcome = "drop";
      state.dropReason = `${gate.id}_fail`;
      return;
    }
    if (answer === "unknown") {
      const pol = gate.unknown_policy;
      if (pol.type === "drop") {
        result.policy_applied = "drop";
        state.gates.push(result);
        state.outcome = "drop";
        state.dropReason = `${gate.id}_unresolved`;
        return;
      }
      if (pol.type === "qualify_and_flag") {
        result.policy_applied = `qualify_and_flag:${pol.flag}`;
        state.flags.push(pol.flag);
      } else {
        const held = pol.proxies.filter((p) => proxyHolds(p, state.facts));
        if (held.length >= pol.min) {
          result.policy_applied = `soft_pass:${held.map((p) => p.id).join("+")}`;
          result.evidence += ` Soft pass on proxies: ${held.map((p) => p.id).join(", ")}.`;
          state.flags.push(pol.flag);
          state.softPass = true;
        } else {
          result.policy_applied = "drop";
          state.gates.push(result);
          state.outcome = "drop";
          state.dropReason = `${gate.id}_unresolved`;
          return;
        }
      }
    }
    state.gates.push(result);
  }
  const unknownFlagged = state.gates.some((g) => g.answer === "unknown" && g.policy_applied?.startsWith("qualify_and_flag"));
  state.outcome = unknownFlagged ? "qualify_and_flag" : "qualify";
}
