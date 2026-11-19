import type { Status } from "@/lib/types";
import type { AccountStage } from "@/lib/state";

const MAP: Record<Status, { label: string; cls: string }> = {
  drafted: { label: "Draft ready", cls: "ok" },
  dropped: { label: "Disqualified", cls: "bad" },
  qualified_no_poc: { label: "Qualified, no contact", cls: "warn" },
  held: { label: "Held for review", cls: "warn" },
  capped: { label: "Capped", cls: "warn" },
  error: { label: "Error", cls: "bad" },
};

export function StatusBadge({ status }: { status: Status }) {
  const m = MAP[status];
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

const STAGES: Record<AccountStage, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "" },
  researching: { label: "Researching", cls: "info" },
  gate_evaluation: { label: "Gate evaluation", cls: "info" },
  contact_lookup: { label: "Contact lookup", cls: "info" },
  drafting: { label: "Drafting", cls: "info" },
  ready_for_review: { label: "Ready for review", cls: "ok" },
  disqualified: { label: "Disqualified", cls: "bad" },
  capped: { label: "Capped", cls: "warn" },
  error: { label: "Error", cls: "bad" },
};

export function StageBadge({ stage }: { stage: AccountStage }) {
  const m = STAGES[stage];
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}
export const stageLabel = (s: AccountStage) => STAGES[s].label;
