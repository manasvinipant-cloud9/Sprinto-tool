import type { TraceStep } from "./trace";

export type GateAnswer = "pass" | "fail" | "unknown" | "skipped_due_to_cap";

export type FactValue = string | number | boolean | string[] | null;
export type Facts = Record<string, FactValue>;

export interface ToolCall {
  tool: "fetch_page" | "search_news";
  arg: string;
  status: string;
  ms: number;
  words?: number;
  note?: string;
}

/** A fact the engine relied on, with the words it came from and where it was found. */
export interface EvidenceRef { field: string; text: string; url: string }

export interface GateResult {
  id: string;
  question: string;
  answer: GateAnswer;
  evidence: string;
  source_url?: string;
  /** Every fact this answer rests on. Empty when nothing was found. */
  refs?: EvidenceRef[];
  attempts: number;
  policy_applied?: string;
}

export interface Candidate {
  name: string;
  email: string;
  title: string;
  confidence: number;
  tier: number | null;
  reason: string;
}

export interface TierLogEntry { tier: number; applies: boolean; not_reached?: boolean; skipped_reason?: string; title_matches: number; excluded: number; below_confidence: number; qualified: number }
export interface ContactDecision { source: "override" | "hunter" | "none"; min_confidence: number; headcount: number | null; found: number; considered: number; tiers: TierLogEntry[] }

export interface Pain {
  pain: string;
  why_this_person: string;
  evidence_field: string;
  evidence_text: string;
  generic?: boolean;
  url?: string;
}

export type Status =
  | "drafted" | "dropped" | "qualified_no_poc" | "held" | "capped" | "error";

export interface DomainResult {
  domain: string;
  status: Status;
  reason: string;
  outcome: "qualify" | "qualify_and_flag" | "drop" | null;
  score: number | null;
  score_breakdown: { id: string; result: string; points: number; evidence: string; refs: EvidenceRef[]; no_evidence: boolean }[];
  flags: string[];
  facts: Facts;
  /** Where each non-empty fact came from: the supporting words and the page or search. */
  evidence: Record<string, { text: string; url: string }>;
  gates: GateResult[];
  tool_calls: ToolCall[];
  contact: Candidate | null;
  candidates: Candidate[];
  pains: Pain[];
  email: { subject: string; body: string; lint: string[]; regenerations: number } | null;
  profile: { id: string; version: number; hash: string };
  tokens: { prompt: number; output: number; calls: number; by_tier?: Record<string, { prompt: number; output: number }> };
  loops: { steps: number; fetches: number; searches: number; max_steps: number; max_tokens: number };
  capped: { reason: string; detail: string } | null;
  /** Why this contact was chosen and how the persona ladder was walked. */
  contact_decision?: ContactDecision | null;
  /** Ordered step log. Stored in its own table; absent from older results. */
  trace?: TraceStep[];
  started_at: string;
  ms: number;
}
