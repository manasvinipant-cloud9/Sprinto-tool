export type GateAnswer = "pass" | "fail" | "unknown";

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

export interface GateResult {
  id: string;
  question: string;
  answer: GateAnswer;
  evidence: string;
  source_url?: string;
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

export interface Pain {
  pain: string;
  why_this_person: string;
  evidence_field: string;
  evidence_text: string;
  generic?: boolean;
}

export type Status =
  | "sent" | "drafted" | "dropped" | "qualified_no_poc" | "held" | "send_failed" | "error";

export interface DomainResult {
  domain: string;
  status: Status;
  reason: string;
  outcome: "qualify" | "qualify_and_flag" | "drop" | null;
  score: number | null;
  score_breakdown: { id: string; result: string; points: number; evidence: string }[];
  flags: string[];
  facts: Facts;
  gates: GateResult[];
  tool_calls: ToolCall[];
  contact: Candidate | null;
  candidates: Candidate[];
  pains: Pain[];
  email: { subject: string; body: string; lint: string[]; regenerations: number } | null;
  send: { ok: boolean; message: string } | null;
  profile: { id: string; version: number; hash: string };
  tokens: { prompt: number; output: number; calls: number };
  started_at: string;
  ms: number;
}
