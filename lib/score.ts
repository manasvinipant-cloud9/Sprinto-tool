import { z } from "zod";
import type { LLM } from "./llm";
import type { Profile } from "./profile-schema";
import type { Evidence } from "./extract";
import type { Facts } from "./types";

const schema = z.object({
  signals: z.array(z.object({ id: z.string(), result: z.enum(["pass", "fail", "unknown"]), tier: z.string().optional(), evidence: z.string() })),
});

export async function scoreSignals(
  llm: LLM,
  profile: Profile,
  facts: Facts,
  evidence: Record<string, Evidence>,
  softPass: boolean,
) {
  const known = Object.entries(facts)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `- ${k} = ${JSON.stringify(v)} (evidence: ${evidence[k]?.text ?? "n/a"})`)
    .join("\n");
  const sigs = profile.signals
    .map((s) => `- ${s.id}: passes when ${s.passes_when}${s.tiers ? ` Tiers: ${Object.keys(s.tiers).join(", ")}.` : ""}`)
    .join("\n");
  const out = await llm.json({
    tier: "cheap",
    system: "You mark supporting signals from known facts only. If facts do not settle a signal answer unknown. For tiered signals set tier to one of the listed tier names.",
    prompt: `KNOWN FACTS:\n${known}\n\nSIGNALS:\n${sigs}\n\nReturn JSON: {"signals":[{"id":"S1","result":"pass"|"fail"|"unknown","tier":"<tier or omit>","evidence":"<one sentence>"}]}`,
    schema,
  });
  const flags: string[] = [];
  let score = 0;
  const breakdown = profile.signals.map((s) => {
    const r = out.signals.find((x) => x.id === s.id);
    const result = r?.result ?? "unknown";
    let points = 0;
    if (!s.hook_only) {
      if (s.tiers) points = result === "unknown" ? 0 : (r?.tier && s.tiers[r.tier]) || 0;
      else points = result === "pass" ? s.weight : 0;
    }
    if (result === "unknown" && s.unanswered === "flag") flags.push(`${s.id.toLowerCase()}_unknown`);
    score += points;
    return { id: s.id, result, points, evidence: r?.evidence ?? "" };
  });
  if (softPass) score -= profile.soft_pass_penalty;
  return { score: Math.max(0, Math.min(100, score)), breakdown, flags };
}
