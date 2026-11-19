export const ACCOUNT_STAGES = ["queued", "researching", "gate_evaluation", "contact_lookup", "drafting", "ready_for_review", "disqualified", "capped", "error"] as const;
export type AccountStage = (typeof ACCOUNT_STAGES)[number];
export const TERMINAL: AccountStage[] = ["ready_for_review", "disqualified", "capped", "error"];
export const IN_FLIGHT: AccountStage[] = ["researching", "gate_evaluation", "contact_lookup", "drafting"];

const OUT_OF_FLIGHT: AccountStage[] = ["disqualified", "capped", "error", "queued"]; // queued = reset after a crash
/** The only legal moves. Anything else is a bug and throws. */
const ACCOUNT_NEXT: Record<AccountStage, AccountStage[]> = {
  queued: ["researching", "capped"],
  researching: ["gate_evaluation", ...OUT_OF_FLIGHT],
  gate_evaluation: ["contact_lookup", ...OUT_OF_FLIGHT],
  contact_lookup: ["drafting", "ready_for_review", ...OUT_OF_FLIGHT],
  drafting: ["ready_for_review", ...OUT_OF_FLIGHT],
  ready_for_review: [],
  disqualified: [],
  capped: [],
  error: ["queued"], // retry
};

export const RUN_STATUSES = ["queued", "running", "paused", "finished", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
const RUN_NEXT: Record<RunStatus, RunStatus[]> = {
  queued: ["running", "paused", "finished"],
  running: ["paused", "finished", "failed"],
  paused: ["running", "finished"],
  finished: ["running"], // retry of failed accounts reopens a finished run
  failed: ["running"],
};

export function canMoveAccount(from: AccountStage, to: AccountStage): boolean { return from === to || ACCOUNT_NEXT[from].includes(to); }
export function moveAccount(from: AccountStage, to: AccountStage): AccountStage {
  if (!canMoveAccount(from, to)) throw new Error(`Illegal account transition ${from} -> ${to}`);
  return to;
}
export function canMoveRun(from: RunStatus, to: RunStatus): boolean { return from === to || RUN_NEXT[from].includes(to); }
export function moveRun(from: RunStatus, to: RunStatus): RunStatus {
  if (!canMoveRun(from, to)) throw new Error(`Illegal run transition ${from} -> ${to}`);
  return to;
}

import type { Status } from "./types";
/** Final stage for an engine result. */
export function stageForResult(status: Status): AccountStage {
  switch (status) {
    case "drafted": case "held": case "qualified_no_poc": return "ready_for_review";
    case "dropped": return "disqualified";
    case "capped": return "capped";
    default: return "error";
  }
}
export function qualificationFor(status: Status): "qualified" | "disqualified" | "capped" | null {
  switch (status) {
    case "drafted": case "held": case "qualified_no_poc": return "qualified";
    case "dropped": return "disqualified";
    case "capped": return "capped";
    default: return null;
  }
}
