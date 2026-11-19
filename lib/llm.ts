import { z } from "zod";

export type Tier = "cheap" | "strong";
/** Keys for one workspace. A missing key falls back to the server environment. */
export interface LlmKeys { provider?: "gemini" | "anthropic"; gemini?: string; anthropic?: string }

export interface Usage { prompt: number; output: number; calls: number; by_tier?: Record<string, { prompt: number; output: number }> }

export interface LLM {
  json<T>(opts: { tier: Tier; system: string; prompt: string; schema: z.ZodType<T> }): Promise<T>;
  usage: Usage;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCallAt = 0;

async function throttle() {
  const min = Number(process.env.LLM_MIN_INTERVAL_MS) || 4000;
  const wait = min - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
}

export function modelFor(tier: Tier, providerOverride?: string): string {
  const provider = providerOverride ?? (process.env.LLM_PROVIDER || "gemini");
  const fromEnv = tier === "cheap" ? process.env.LLM_MODEL_CHEAP : process.env.LLM_MODEL_STRONG;
  if (fromEnv) return fromEnv;
  if (provider === "anthropic") return tier === "cheap" ? "claude-haiku-5-5" : "claude-sonnet-5-5";
  // gemini-2.5-flash is retired. These are current stable models (checked against Google's model list); override with LLM_MODEL_CHEAP / LLM_MODEL_STRONG.
  return tier === "cheap" ? "gemini-3.5-flash-lite" : "gemini-3.8-flash";
}

async function callProvider(tier: Tier, system: string, prompt: string, keys?: LlmKeys): Promise<{ text: string; inTok: number; outTok: number }> {
  const provider = keys?.provider ?? (process.env.LLM_PROVIDER || "gemini");
  const model = modelFor(tier, provider);
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": keys?.anthropic ?? process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw Object.assign(new Error(`anthropic_${res.status}`), { status: res.status, retryAfter: res.headers.get("retry-after") });
    const j = (await res.json()) as { content: { text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
    return { text: j.content.map((c) => c.text ?? "").join(""), inTok: j.usage?.input_tokens ?? 0, outTok: j.usage?.output_tokens ?? 0 };
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": keys?.gemini ?? process.env.GEMINI_API_KEY ?? "" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.2 },
    }),
  });
  if (!res.ok) throw Object.assign(new Error(`gemini_${res.status}`), { status: res.status, retryAfter: res.headers.get("retry-after") });
  const j = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return { text, inTok: j.usageMetadata?.promptTokenCount ?? 0, outTok: j.usageMetadata?.candidatesTokenCount ?? 0 };
}

export function createLLM(keys?: LlmKeys, onWait?: (ms: number, why: string) => void): LLM {
  const usage: Usage = { prompt: 0, output: 0, calls: 0 };
  return {
    usage,
    async json({ tier, system, prompt, schema }) {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await throttle();
          const r = await callProvider(tier, system + "\nReturn valid JSON only, no commentary.", prompt, keys);
          usage.calls++;
          usage.prompt += r.inTok;
          usage.output += r.outTok;
          const bt = (usage.by_tier ??= {});
          const t = (bt[modelFor(tier)] ??= { prompt: 0, output: 0 });
          t.prompt += r.inTok; t.output += r.outTok;
          return schema.parse(JSON.parse(stripFences(r.text)));
        } catch (e) {
          lastErr = e;
          const status = (e as { status?: number }).status;
          const transient = status === 429 || (status !== undefined && status >= 500);
          const parseIssue = e instanceof SyntaxError || e instanceof z.ZodError;
          if (status === 401 || status === 403 || status === 400 || status === 404) throw e;
          if (!transient && !parseIssue) throw e;
          const ra = Number((e as { retryAfter?: string }).retryAfter);
          const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2000 * 2 ** attempt;
          onWait?.(wait, transient ? "rate limit" : "retrying invalid JSON");
          await sleep(Math.min(wait, 20000));
        }
      }
      throw lastErr;
    },
  };
}
