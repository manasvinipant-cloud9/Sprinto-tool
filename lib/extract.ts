import { z } from "zod";
import type { LLM } from "./llm";
import type { Profile } from "./profile-schema";
import type { Facts, FactValue } from "./types";

export const BASE_FIELDS: { name: string; type: string; description: string }[] = [
  { name: "company_name", type: "string", description: "The company's name." },
  { name: "company_type", type: "enum: b2b_saas | consumer | agency_or_services | hardware | marketplace | other", description: "What kind of business it is." },
  { name: "pricing_model", type: "enum: recurring | usage | one_time | none_seen", description: "How it charges, if any pricing is shown." },
  { name: "funding_stage", type: "enum: pre_seed | seed | series_a | series_b | series_c | series_d_plus | public | acquired | bootstrapped", description: "Latest funding stage, only if stated or reported." },
  { name: "funding_evidence", type: "string", description: "The exact fact that shows the funding stage (round, amount, date)." },
  { name: "headcount_min", type: "number", description: "Lower bound of employee count if stated." },
  { name: "headcount_max", type: "number", description: "Upper bound of employee count if stated." },
  { name: "industry", type: "string", description: "Industry in a few words (for example fintech, healthtech, devtools, hrtech, other)." },
  { name: "open_roles_count", type: "number", description: "Number of open roles if a careers page lists them." },
  { name: "enterprise_customers", type: "array of strings", description: "Names of recognisable enterprise customers shown." },
  { name: "cloud_provider", type: "string", description: "AWS, GCP or Azure if named." },
];

const responseSchema = z.object({
  fields: z.record(z.string(), z.object({ value: z.unknown(), evidence: z.string().optional() })),
});

export interface Evidence { text: string; url: string }

export function allFieldDefs(profile: Profile) {
  return [
    ...BASE_FIELDS,
    ...profile.custom_fields.map((f) => ({
      name: f.name,
      type: f.type === "enum" && f.values ? `enum: ${f.values.join(" | ")}` : f.type === "bool" ? "boolean" : f.type,
      description: f.description,
    })),
  ];
}

export function isFilled(v: FactValue | undefined): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function coerce(v: unknown): FactValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map(String);
  return null;
}

export function emptyFacts(profile: Profile): Facts {
  return Object.fromEntries(allFieldDefs(profile).map((f) => [f.name, null]));
}

export async function extractFacts(
  llm: LLM,
  profile: Profile,
  pageText: string,
  url: string,
  facts: Facts,
  evidence: Record<string, Evidence>,
): Promise<string[]> {
  const defs = allFieldDefs(profile);
  const system =
    "You extract facts about a company from website text into fixed named fields. " +
    "Use ONLY what the text states. Never guess or infer from general knowledge. " +
    "If the text does not state a field, return null for it. For boolean fields return true only if the text states it, false only if the text clearly says the opposite, otherwise null.";
  const prompt =
    `Fields (name | type | meaning):\n${defs.map((d) => `- ${d.name} | ${d.type} | ${d.description}`).join("\n")}\n\n` +
    `Page URL: ${url}\n\nPAGE TEXT:\n${pageText || "(empty)"}\n\n` +
    `Return JSON: {"fields": {"<field name>": {"value": <value or null>, "evidence": "<short exact phrase from the text, or empty>"}}} with every field name above.`;
  const out = await llm.json({ tier: "cheap", system, prompt, schema: responseSchema });
  const filled: string[] = [];
  for (const d of defs) {
    const got = out.fields[d.name];
    if (!got) continue;
    const v = coerce(got.value);
    if (!isFilled(v) && v !== false) continue;
    const existing = facts[d.name];
    // a later page may upgrade null or false to a stated true; never overwrite a stated value with a weaker one
    if (isFilled(existing) && existing !== false) continue;
    if (existing === false && v === false) continue;
    facts[d.name] = v;
    evidence[d.name] = { text: got.evidence?.slice(0, 240) || String(v), url };
    filled.push(d.name);
  }
  return filled;
}
