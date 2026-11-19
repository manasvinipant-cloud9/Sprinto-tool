import type { DomainResult, EvidenceRef, Facts } from "./types";

type Ev = Record<string, { text: string; url: string }>;

const isFilled = (v: unknown) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);

/** Evidence refs for the named facts. Only facts that were actually found are returned. */
export function refsFor(fields: string[], facts: Facts, evidence: Ev): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const f of fields) {
    const e = evidence[f];
    if (!e || seen.has(f) || (!isFilled(facts[f]) && facts[f] !== false)) continue;
    seen.add(f);
    out.push({ field: f, text: e.text, url: e.url });
  }
  return out;
}

/** True for a real web address; news searches are stored as "news:<query>" and are not links. */
export function isWebUrl(u: string | undefined): u is string { return typeof u === "string" && /^https?:\/\//i.test(u); }
export function describeSource(u: string): string { return u.startsWith("news:") ? `Google News search: ${u.slice(5)}` : u; }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** One or two plain sentences saying why this account is where it is. */
export function summarizeEvidence(r: DomainResult): string {
  if (r.capped) return `Stopped by a cap (${r.capped.reason.replace(/_/g, " ")}); ${r.gates.filter((g) => g.answer === "skipped_due_to_cap").length} check(s) not run.`;
  if (r.status === "dropped") {
    const g = r.gates.find((x) => x.answer === "fail") ?? r.gates.find((x) => x.policy_applied === "drop" || x.policy_applied === "hard_disqualifier");
    return g ? clip(`${g.id}: ${g.evidence}`, 220) : clip(r.reason, 220);
  }
  if (r.status === "error") return clip(r.reason, 220);
  const passed = r.score_breakdown.filter((s) => s.points > 0).sort((a, b) => b.points - a.points).slice(0, 2);
  const parts = passed.map((s) => `${s.id} +${s.points}: ${s.evidence}`);
  if (parts.length === 0) {
    const g = r.gates.find((x) => x.answer === "pass");
    if (g) parts.push(`${g.id}: ${g.evidence}`);
  }
  if (r.flags.length) parts.push(`flags: ${r.flags.join(", ")}`);
  return clip(parts.join(" · ") || r.reason, 220);
}

/** Persona tiers that matched at least one candidate, and the one chosen. */
export function matchedPersonas(r: DomainResult): { tiers: number[]; chosen: number | null } {
  const tiers = [...new Set(r.candidates.map((c) => c.tier).filter((t): t is number => t !== null))].sort((a, b) => a - b);
  return { tiers, chosen: r.contact?.tier ?? null };
}

/** Every distinct web address that backs a claim in this result. */
export function evidenceUrls(r: DomainResult): string[] {
  const urls = new Set<string>();
  const add = (u?: string) => { if (u) urls.add(u); };
  for (const g of r.gates) { add(g.source_url); g.refs?.forEach((x) => add(x.url)); }
  for (const s of r.score_breakdown) s.refs?.forEach((x) => add(x.url));
  for (const p of r.pains) add(p.url);
  return [...urls];
}

/** Ranking used by the table and the CSV: outcome first, then score. */
export function rankKey(stage: string, hasDraft: boolean, score: number | null): number {
  return (score ?? -1) + (stage === "ready_for_review" ? (hasDraft ? 1000 : 500) : 0);
}
