import { z } from "zod";

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

const onUnknown = z.enum(["drop", "flag", "ignore"]).default("flag");

/** Hard disqualifiers: checked by code against extracted facts, never by the model. */
export const disqualifierSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1), type: z.literal("region_in"), regions: z.array(z.string().min(1)).min(1), on_unknown: onUnknown }),
  z.object({ id: z.string().min(1), type: z.literal("headcount_between"), min: z.number().int().min(0).optional(), max: z.number().int().min(1).optional(), on_unknown: onUnknown }),
  z.object({ id: z.string().min(1), type: z.literal("industry_not_in"), industries: z.array(z.string().min(1)).min(1), on_unknown: onUnknown }),
]);
export type Disqualifier = z.infer<typeof disqualifierSchema>;

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
    disqualifiers: z.array(disqualifierSchema).max(6).default([]),
    gates: z.array(gate).max(4).default([]),
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
      max_accounts_per_run: z.number().int().min(1).max(100).default(25),
      max_contacts_per_account: z.number().int().min(1).max(20).default(10),
      max_loop_steps: z.number().int().min(1).max(40).default(12),
      max_tokens_per_account: z.number().int().min(1000).max(500000).default(60000),
    }),
  })
  .superRefine((p, ctx) => {
    if (p.gates.length + p.disqualifiers.length < 2) {
      ctx.addIssue({ code: "custom", path: ["gates"], message: "Add at least two checks in total (hard disqualifiers plus fit gates)" });
    }
    const dqIds = new Set<string>();
    for (const d of p.disqualifiers) {
      if (dqIds.has(d.id)) ctx.addIssue({ code: "custom", path: ["disqualifiers"], message: `Duplicate disqualifier id ${d.id}` });
      dqIds.add(d.id);
      if (d.type === "headcount_between" && d.min === undefined && d.max === undefined) ctx.addIssue({ code: "custom", path: ["disqualifiers"], message: `${d.id}: set a minimum, a maximum, or both` });
      if (d.type === "headcount_between" && d.min !== undefined && d.max !== undefined && d.min > d.max) ctx.addIssue({ code: "custom", path: ["disqualifiers"], message: `${d.id}: minimum is above maximum` });
    }
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

