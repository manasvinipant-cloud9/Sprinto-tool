import type { z } from "zod";
import type { LLM } from "@/lib/llm";
import type { Deps } from "@/lib/pipeline";
import type { PageResult } from "@/lib/scrape";

export interface Scenario {
  fields: Record<string, unknown>;
  judge: (question: string) => "pass" | "fail" | "unknown";
  action: "stop" | "first";
  contacts: { name: string; email: string; title: string; confidence: number }[];
  overrides?: Record<string, { name: string; email: string; title: string }>;
  hunterError?: { message: string; permanent: boolean };
}

export const HOOK = "an open Security Engineer role posted this month";
export const GOOD_BODY =
  "Hi Priya, I saw " + HOOK + " on your careers page, which usually means customers are asking for proof of security practices before they sign. " +
  "Sprinto automates evidence collection and audit readiness for SaaS teams, so engineers are not pulled off the roadmap to chase screenshots and tickets every quarter. " +
  "Teams at your stage often hit this when the first larger customer sends a security questionnaire and nobody owns the answer. " +
  "Would a short call this week be useful to see how it would work for you?\n\nGrowth Lead, Sprinto";

export const GOOD_BODY_Q =
  "Hi Priya, is the Security Engineer role you posted this month a sign that customers are asking for proof of your security practices before they sign? " +
  "Sprinto automates evidence collection and audit readiness for SaaS teams, so engineers are not pulled off the roadmap to chase screenshots and tickets every quarter. " +
  "Teams at your stage often hit this when the first larger customer sends a security questionnaire and nobody owns the answer. " +
  "Would a short call this week be useful to see how it would work for you?\n\nGrowth Lead, Sprinto";

export function makeLLM(s: Scenario, log: string[] = []): LLM {
  const usage = { prompt: 0, output: 0, calls: 0 };
  return {
    usage,
    async json<T>({ system, prompt, schema }: { tier: string; system: string; prompt: string; schema: z.ZodType<T> }): Promise<T> {
      usage.calls++;
      let out: unknown;
      if (system.startsWith("You extract facts")) {
        out = { fields: Object.fromEntries(Object.entries(s.fields).map(([k, v]) => [k, { value: v, evidence: `evidence for ${k}` }])) };
        log.push("extract");
      } else if (system.startsWith("You decide which single tool call")) {
        const m = prompt.match(/- (fetch_page|search_news): (.+)/);
        out = s.action === "first" && m ? { tool: m[1], arg: m[2], reason: "test" } : { tool: "stop" };
        log.push("action");
      } else if (system.startsWith("You judge one qualification gate")) {
        const q = prompt.match(/Gate: (.+)/)?.[1] ?? "";
        out = { answer: s.judge(q), evidence: `judged: ${q}` };
        log.push("judge");
      } else if (system.startsWith("You mark supporting signals")) {
        out = { signals: [
          { id: "S1", result: "pass", evidence: "headcount in range" },
          { id: "S2", result: "pass", evidence: "enterprise logos" },
          { id: "S3", result: "pass", tier: "fintech_or_healthtech", evidence: "fintech" },
          { id: "S4", result: "pass", evidence: "AWS named" },
        ] };
      } else if (system.startsWith("You identify the two most likely")) {
        out = { pains: [
          { pain: "Engineers pulled off roadmap for audit evidence", why_this_person: "CTO owns delivery", evidence_field: "security_or_compliance_roles_open", evidence_text: HOOK },
          { pain: "No named owner for the work", why_this_person: "no GRC team", evidence_field: "has_enterprise_tier", evidence_text: "enterprise tier on pricing page" },
        ] };
      } else if (system.startsWith("You write short")) {
        out = { subject: "Security hiring and audits", body: prompt.includes("UNCONFIRMED") ? GOOD_BODY_Q : GOOD_BODY };
        log.push("email");
      } else throw new Error("unexpected llm call: " + system.slice(0, 40));
      return schema.parse(out);
    },
  };
}

export function makeDeps(s: Scenario, opts: { sent?: { subject: string; body: string }[]; calls?: string[]; page?: Partial<PageResult> } = {}): Deps {
  const llm = makeLLM(s);
  return {
    llm,
    async fetchPage(url) {
      opts.calls?.push(url);
      return { status: "ok", text: "Acme builds software for banks. ".repeat(40), url, words: 240, ...opts.page };
    },
    async searchNews(q) {
      opts.calls?.push("news:" + q);
      return { status: "empty", results: [] };
    },
    async hunter() {
      if (s.hunterError) throw Object.assign(new Error(s.hunterError.message), { permanent: s.hunterError.permanent });
      return s.contacts;
    },
    overrides: () => s.overrides ?? {},
    async send(subject, body) {
      opts.sent?.push({ subject, body });
      return { ok: true, message: "sent" };
    },
  };
}

export const QUALIFYING: Scenario = {
  fields: {
    company_name: "Acme", company_type: "b2b_saas", pricing_model: "recurring", funding_stage: "series_b",
    funding_evidence: "Series B 2025", headcount_min: 80, headcount_max: 120, industry: "fintech", open_roles_count: 9,
    enterprise_customers: ["A", "B"], cloud_provider: "AWS", certifications_held: null,
    certification_in_progress: true, has_enterprise_tier: true, security_or_compliance_roles_open: true,
  },
  judge: () => "pass",
  action: "stop",
  contacts: [{ name: "Priya Rao", email: "priya@acme.test", title: "CTO", confidence: 88 }],
};
