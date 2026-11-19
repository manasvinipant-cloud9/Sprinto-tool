import type { DomainResult } from "./types";

export interface GateChange { id: string; question: string; a: string; b: string }
export interface ResultDiff {
  domain: string;
  statusChanged: boolean; a: { status: string; score: number | null; contact: string | null; flags: string[] }; b: { status: string; score: number | null; contact: string | null; flags: string[] };
  scoreDelta: number | null;
  gateChanges: GateChange[];
  contactChanged: boolean;
  flagsAdded: string[]; flagsRemoved: string[];
  verdict: "same" | "changed";
}

const side = (r: DomainResult) => ({ status: r.status, score: r.score, contact: r.contact ? r.contact.name : null, flags: r.flags });
/** Gates are matched on id and question together: the same id in two different profiles can be two different checks. */
export const gateKey = (g: { id: string; question: string }) => `${g.id}\u0000${g.question}`;
const gateMap = (r: DomainResult) => new Map(r.gates.map((g) => [gateKey(g), { answer: g.answer as string, id: g.id, question: g.question }]));

/** Qualification diff for one domain run under two profiles. Pure. */
export function diffResults(a: DomainResult, b: DomainResult): ResultDiff {
  const ga = gateMap(a); const gb = gateMap(b);
  const keys = [...new Set([...ga.keys(), ...gb.keys()])];
  const gateChanges = keys.map((k) => { const x = ga.get(k); const y = gb.get(k); const m = (x ?? y)!; return { id: m.id, question: m.question, a: x?.answer ?? "not run", b: y?.answer ?? "not run" }; }).filter((g) => g.a !== g.b);
  const flagsAdded = b.flags.filter((f) => !a.flags.includes(f));
  const flagsRemoved = a.flags.filter((f) => !b.flags.includes(f));
  const statusChanged = a.status !== b.status;
  const scoreDelta = a.score !== null && b.score !== null ? b.score - a.score : null;
  const contactChanged = (a.contact?.email ?? null) !== (b.contact?.email ?? null);
  const changed = statusChanged || gateChanges.length > 0 || (scoreDelta !== null && scoreDelta !== 0) || contactChanged || flagsAdded.length > 0 || flagsRemoved.length > 0;
  return { domain: a.domain, statusChanged, a: side(a), b: side(b), scoreDelta, gateChanges, contactChanged, flagsAdded, flagsRemoved, verdict: changed ? "changed" : "same" };
}

export interface PairRow<T> { domain: string; a: T | null; b: T | null }

/** Pairs two lists of accounts by domain. Order follows the first list, then any domains only in the second. */
export function pairByDomain<T extends { domain: string }>(a: T[], b: T[]): PairRow<T>[] {
  const bMap = new Map(b.map((x) => [x.domain, x]));
  const seen = new Set<string>();
  const rows: PairRow<T>[] = [];
  for (const x of a) { if (seen.has(x.domain)) continue; seen.add(x.domain); rows.push({ domain: x.domain, a: x, b: bMap.get(x.domain) ?? null }); }
  for (const y of b) { if (seen.has(y.domain)) continue; seen.add(y.domain); rows.push({ domain: y.domain, a: null, b: y }); }
  return rows;
}

export interface SideStats { qualified: number; disqualified: number; capped: number; errors: number; avgScore: number | null; tokens: number }
export interface CompareSummary { domains: number; compared: number; changed: number; statusChanged: number; onlyA: number; onlyB: number; a: SideStats; b: SideStats }

type Acct = { stage: string; qualification: string | null; score: number | null; tokens_in: number; tokens_out: number };
const stats = (xs: (Acct | null)[]): SideStats => {
  const l = xs.filter((x): x is Acct => x !== null);
  const scores = l.map((x) => x.score).filter((n): n is number => n !== null);
  return {
    qualified: l.filter((x) => x.qualification === "qualified").length, disqualified: l.filter((x) => x.qualification === "disqualified").length,
    capped: l.filter((x) => x.qualification === "capped").length, errors: l.filter((x) => x.stage === "error").length,
    avgScore: scores.length ? Math.round(scores.reduce((p, c) => p + c, 0) / scores.length) : null, tokens: l.reduce((p, c) => p + c.tokens_in + c.tokens_out, 0),
  };
};

export function summarizePairs(rows: (PairRow<Acct> & { diff: ResultDiff | null })[]): CompareSummary {
  return {
    domains: rows.length, compared: rows.filter((r) => r.diff).length, changed: rows.filter((r) => r.diff?.verdict === "changed").length,
    statusChanged: rows.filter((r) => r.diff?.statusChanged).length, onlyA: rows.filter((r) => r.a && !r.b).length, onlyB: rows.filter((r) => r.b && !r.a).length,
    a: stats(rows.map((r) => r.a)), b: stats(rows.map((r) => r.b)),
  };
}
