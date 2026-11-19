export type TraceKind = "llm" | "fetch_page" | "search_news" | "contact_lookup" | "gate" | "draft";

/** One recorded step of an account's run, in the order it happened. */
export interface TraceStep {
  seq: number; kind: TraceKind;
  phase: string;        // pipeline stage when it ran
  ctx?: string;         // the gate or check it served, when there is one
  label: string;        // what it was for
  input: string; output: string;
  status: string;       // ok, pass, fail, blocked, error, refused_cap ...
  ms: number; tokens_in: number; tokens_out: number;
}

export const clip = (s: string, n = 1500) => (s.length > n ? `${s.slice(0, n)}… [${s.length - n} more characters]` : s);

/** Collects the decision trace. Everything the engine spends or decides passes through add(). */
export class Tracer {
  steps: TraceStep[] = [];
  phase = "researching";
  ctx: string | undefined;
  add(s: Omit<TraceStep, "seq" | "phase" | "ctx"> & { ctx?: string }): TraceStep {
    const step: TraceStep = { ...s, seq: this.steps.length + 1, phase: this.phase, ctx: s.ctx ?? this.ctx };
    this.steps.push(step);
    return step;
  }
}

/** Names the purpose of a model call from its instructions. */
export function purposeOf(system: string): string {
  if (system.startsWith("You extract facts")) return "extract_facts";
  if (system.startsWith("You decide which single tool call")) return "choose_next_tool";
  if (system.startsWith("You judge one qualification gate")) return "judge_gate";
  if (system.startsWith("You mark supporting signals")) return "score_signals";
  if (system.startsWith("You identify the two")) return "find_pains";
  if (system.startsWith("You write short")) return "write_email";
  return "model_call";
}
