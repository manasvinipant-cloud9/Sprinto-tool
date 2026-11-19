/**
 * Estimated list prices in USD per million tokens. These are placeholders, not verified quotes:
 * check your provider's pricing page and override with LLM_PRICE_IN_PER_MTOK / LLM_PRICE_OUT_PER_MTOK.
 * On a free tier the real charge is zero; the figure shows what the same usage would cost on a paid plan.
 */
const TABLE: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
};
const FALLBACK = { in: 0.3, out: 2.5 };

export function priceFor(model: string) {
  const envIn = Number(process.env.LLM_PRICE_IN_PER_MTOK); const envOut = Number(process.env.LLM_PRICE_OUT_PER_MTOK);
  if (envIn > 0 && envOut > 0) return { in: envIn, out: envOut };
  return TABLE[model] ?? FALLBACK;
}

export function estimateCostUsd(tokens: { prompt: number; output: number; by_tier?: Record<string, { prompt: number; output: number }> }): number {
  if (tokens.by_tier && Object.keys(tokens.by_tier).length) {
    return Object.entries(tokens.by_tier).reduce((a, [model, t]) => a + (t.prompt * priceFor(model).in + t.output * priceFor(model).out) / 1e6, 0);
  }
  const p = priceFor("");
  return (tokens.prompt * p.in + tokens.output * p.out) / 1e6;
}
