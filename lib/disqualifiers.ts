import type { Disqualifier, Profile } from "./profile-schema";
import type { Evidence } from "./extract";
import type { Facts, GateResult } from "./types";
import { refsFor } from "./evidence";

const norm = (s: string) => s.toLowerCase().trim();
const has = (v: unknown) => v !== null && v !== undefined && v !== "";

export const DISQUALIFIER_FIELDS: Record<Disqualifier["type"], string[]> = {
  region_in: ["hq_region"],
  headcount_between: ["headcount_min", "headcount_max"],
  industry_not_in: ["industry"],
};

export function describeDisqualifier(d: Disqualifier): string {
  switch (d.type) {
    case "region_in": return `Headquartered in: ${d.regions.join(", ")}`;
    case "headcount_between": return `Headcount ${d.min ?? 0} to ${d.max ?? "any"}`;
    case "industry_not_in": return `Industry is not: ${d.industries.join(", ")}`;
  }
}

/** Returns pass, fail or unknown from facts alone. No model involved. */
export function judgeDisqualifier(d: Disqualifier, facts: Facts): { answer: "pass" | "fail" | "unknown"; evidence: string } {
  if (d.type === "region_in") {
    const v = facts.hq_region;
    if (!has(v)) return { answer: "unknown", evidence: "Headquarters region was not stated." };
    const ok = d.regions.some((r) => norm(String(v)).includes(norm(r)) || norm(r).includes(norm(String(v))));
    return { answer: ok ? "pass" : "fail", evidence: `Headquarters: ${v}. Allowed: ${d.regions.join(", ")}.` };
  }
  if (d.type === "industry_not_in") {
    const v = facts.industry;
    if (!has(v)) return { answer: "unknown", evidence: "Industry was not stated." };
    const hit = d.industries.find((i) => norm(String(v)).includes(norm(i)));
    return { answer: hit ? "fail" : "pass", evidence: hit ? `Industry "${v}" is excluded (${hit}).` : `Industry "${v}" is not excluded.` };
  }
  const lo = typeof facts.headcount_min === "number" ? facts.headcount_min : null;
  const hi = typeof facts.headcount_max === "number" ? facts.headcount_max : null;
  if (lo === null && hi === null) return { answer: "unknown", evidence: "Headcount was not stated." };
  const a = lo ?? hi!; const b = hi ?? lo!;
  const overlaps = (d.min === undefined || b >= d.min) && (d.max === undefined || a <= d.max);
  return { answer: overlaps ? "pass" : "fail", evidence: `Headcount ${a === b ? a : `${a} to ${b}`}; required ${d.min ?? 0} to ${d.max ?? "any"}.` };
}

export interface DisqualifierOutcome { results: GateResult[]; failed: GateResult | null; flags: string[] }

/**
 * Evaluate every rule. `final` is true after the gates ran: unknowns are then resolved by each rule's policy.
 * Before the gates only clear failures stop the run; unknowns wait for more evidence.
 */
export function checkDisqualifiers(profile: Profile, facts: Facts, evidence: Record<string, Evidence>, final: boolean): DisqualifierOutcome {
  const results: GateResult[] = []; const flags: string[] = []; let failed: GateResult | null = null;
  for (const d of profile.disqualifiers) {
    const j = judgeDisqualifier(d, facts);
    const field = DISQUALIFIER_FIELDS[d.type].find((f) => has(facts[f]));
    const r: GateResult = { id: d.id, question: describeDisqualifier(d), answer: j.answer, evidence: j.evidence, source_url: field ? evidence[field]?.url : undefined, attempts: 0, refs: refsFor(DISQUALIFIER_FIELDS[d.type], facts, evidence) };
    if (j.answer === "fail") { r.policy_applied = "hard_disqualifier"; failed ??= r; }
    if (j.answer === "unknown" && final) {
      if (d.on_unknown === "drop") { r.policy_applied = "drop"; failed ??= r; }
      else if (d.on_unknown === "flag") { r.policy_applied = `qualify_and_flag:${d.id.toLowerCase()}_unverified`; flags.push(`${d.id.toLowerCase()}_unverified`); }
      else r.policy_applied = "ignored";
    }
    results.push(r);
  }
  return { results, failed, flags };
}
