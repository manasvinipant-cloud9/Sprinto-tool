import type { Usage } from "./llm";

export type CapReason = "loop_steps" | "token_budget";

export class CapError extends Error {
  constructor(public reason: CapReason) { super(`cap:${reason}`); }
}

/**
 * Per-account spending limits enforced in code. The model cannot raise them.
 * A loop step is one agent-loop iteration: the agent chooses a tool call during gate research (the free homepage read is not a step).
 */
export class Governor {
  steps = 0;
  fetches = 0;
  searches = 0;
  hit: CapReason | null = null;
  constructor(public maxSteps: number, public maxTokens: number, private usage: Usage) {}

  get tokens() { return this.usage.prompt + this.usage.output; }
  canStep() { return this.steps < this.maxSteps; }
  step(kind: "fetch" | "search") { this.steps++; if (kind === "fetch") this.fetches++; else this.searches++; }
  /** Throws before a model call that would start past the token budget. */
  guardTokens() { if (this.tokens >= this.maxTokens) { this.hit = "token_budget"; throw new CapError("token_budget"); } }
  markStepCap() { this.hit = "loop_steps"; }
}
