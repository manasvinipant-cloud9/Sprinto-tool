import { z } from "zod";
import { createHash } from "node:crypto";

export const PAGE_TYPES = [
  "homepage", "security", "trust", "careers", "pricing", "customers",
  "about", "product", "integrations", "blog", "news_search",
] as const;
export type PageType = (typeof PAGE_TYPES)[number];

export const PAGE_PATHS: Record<Exclude<PageType, "news_search">, string[]> = {
  homepage: ["/"],
  security: ["/security"],
  trust: ["/trust", "/trust-center"],
  careers: ["/careers", "/jobs", "/company/careers"],
  pricing: ["/pricing", "/plans"],
  customers: ["/customers", "/case-studies"],
  about: ["/about", "/company", "/about-us"],
  product: ["/product", "/platform", "/features"],
  integrations: ["/integrations"],
  blog: ["/blog"],
};

const proxy = z.object({
  id: z.string(),
  field: z.string(),
  op: z.enum(["gte", "lte", "truthy", "count_gte"]),
  value: z.number().optional(),
});

const unknownPolicy = z.discriminatedUnion("type", [
  z.object({ type: z.literal("drop") }),
  z.object({ type: z.literal("qualify_and_flag"), flag: z.string() }),
  z.object({
    type: z.literal("soft_pass_if"),
    flag: z.string(),
    min: z.number().int().min(1),
    proxies: z.array(proxy).min(1),
  }),
]);

const gate = z.object({
  id: z.string(),
  question: z.string(),
  kind: z.enum(["classification", "stage", "exclusion", "signal_present"]),
  pass_when: z.string(),
  fail_when: z.string().optional(),
  required_fields: z.array(z.string()).min(1),
  where_to_look: z.array(z.enum(PAGE_TYPES)).min(1),
  unknown_policy: unknownPolicy,
});

const signal = z.object({
  id: z.string(),
  passes_when: z.string(),
  weight: z.number().min(0),
  tiers: z.record(z.string(), z.number()).optional(),
  unanswered: z.enum(["flag", "ignore"]).default("ignore"),
  hook_only: z.boolean().optional(),
});

const persona = z.object({
  tier: z.number().int(),
  titles: z.array(z.string()).min(1),
  exclude_titles: z.array(z.string()).default([]),
  applies_when: z.union([z.literal("always"), z.object({ headcount_below: z.number() })]),
  pain_lens: z.array(z.string()).min(1),
});

export const profileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().min(1),
    seller: z.object({
      name: z.string(),
      domain: z.string(),
      one_line_offer: z.string(),
      sender_name: z.string(),
      sender_title: z.string(),
      allowed_claims: z.array(z.string()).min(1),
      ask: z.string(),
      tone_notes: z.string().optional(),
    }),
    icp_summary: z.string(),
    custom_fields: z
      .array(
        z.object({
          name: z.string().regex(/^[a-z][a-z0-9_]*$/),
          type: z.enum(["string", "number", "bool", "enum"]),
          description: z.string(),
          values: z.array(z.string()).optional(),
        }),
      )
      .default([]),
    gates: z.array(gate).min(2).max(4),
    signals: z.array(signal).max(5),
    soft_pass_penalty: z.number().min(0).default(0),
    personas: z.array(persona).min(1),
    email: z.object({
      min_words: z.number().int(),
      max_words: z.number().int(),
      subject_max_words: z.number().int(),
      banned_phrases: z.array(z.string()),
      question_hook_when_flagged: z.boolean(),
    }),
    limits: z.object({
      fetch_calls: z.number().int().min(1).max(8),
      news_calls: z.number().int().min(0).max(5),
      hunter_min_confidence: z.number().min(0).max(100),
    }),
  })
  .superRefine((p, ctx) => {
    const total = p.signals.filter((s) => !s.hook_only).reduce((a, s) => a + s.weight, 0);
    if (total !== 100) {
      ctx.addIssue({ code: "custom", message: `Scoring signal weights must sum to 100 (got ${total})` });
    }
    const ids = new Set<string>();
    for (const g of p.gates) {
      if (ids.has(g.id)) ctx.addIssue({ code: "custom", message: `Duplicate gate id ${g.id}` });
      ids.add(g.id);
    }
  });

export type Profile = z.infer<typeof profileSchema>;
export type Gate = Profile["gates"][number];
export type Signal = Profile["signals"][number];
export type Persona = Profile["personas"][number];

export function profileHash(p: Profile): string {
  return createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 12);
}
