import type { Profile } from "./profile-schema";

export interface LintCtx {
  firstName: string;
  flagged: boolean;
  hookEvidence: string;
}

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function lintEmail(e: { subject: string; body: string }, profile: Profile, ctx: LintCtx): string[] {
  const errs: string[] = [];
  const rules = profile.email;
  const n = words(e.body);
  if (n < rules.min_words || n > rules.max_words) errs.push(`body has ${n} words, needs ${rules.min_words}-${rules.max_words}`);
  if (words(e.subject) > rules.subject_max_words || !e.subject.trim()) errs.push(`subject must be 1-${rules.subject_max_words} words`);
  const greeting = new RegExp(`^\\s*(hi|hello|hey|dear)\\s+${ctx.firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  if (!greeting.test(e.body)) errs.push(`must open by addressing ${ctx.firstName} by first name`);
  const hay = `${e.subject}\n${e.body}`.toLowerCase();
  for (const b of rules.banned_phrases) if (hay.includes(b.toLowerCase())) errs.push(`contains banned phrase "${b}"`);
  if (/https?:\/\/|www\./i.test(e.body)) errs.push("contains a link");
  if (/^\s*([-*\u2022]|\d+\.)\s+/m.test(e.body)) errs.push("contains bullets");
  const claimsText = profile.seller.allowed_claims.join(" ").toLowerCase();
  const stat = e.body.match(/\b\d+(\.\d+)?\s?(%|x\b|times faster)/gi) ?? [];
  for (const s of stat) if (!claimsText.includes(s.toLowerCase())) errs.push(`unsupported statistic "${s}"`);
  if (!e.body.toLowerCase().includes(profile.seller.sender_name.toLowerCase())) errs.push("missing sign-off with the sender name");
  const firstTwo = e.body.split(/(?<=[.?!])\s+/).slice(0, 3).join(" ");
  if (ctx.flagged && profile.email.question_hook_when_flagged && !firstTwo.includes("?")) errs.push("flagged lead: the hook must be phrased as a question");
  const overlap = new Set(ctx.hookEvidence.toLowerCase().match(/[a-z0-9]{5,}/g) ?? []);
  const bodyWords = new Set(e.body.toLowerCase().match(/[a-z0-9]{5,}/g) ?? []);
  const shared = [...overlap].filter((w) => bodyWords.has(w));
  if (overlap.size >= 2 && shared.length < 1) errs.push("hook does not reference the evidence");
  return errs;
}
