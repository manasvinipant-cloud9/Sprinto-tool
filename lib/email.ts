import { z } from "zod";
import type { LLM } from "./llm";
import type { Profile } from "./profile-schema";
import { lintEmail } from "./lint";
import type { Candidate, Facts, Pain } from "./types";

const schema = z.object({ subject: z.string(), body: z.string() });

export async function draftEmail(
  llm: LLM,
  profile: Profile,
  contact: Candidate,
  facts: Facts,
  pains: Pain[],
  flagged: boolean,
  /** A reviewer's note such as "make it shorter". The profile's rules and the lint still apply. */
  instruction?: string,
): Promise<{ subject: string; body: string; lint: string[]; regenerations: number }> {
  const first = contact.name.split(" ")[0];
  const s = profile.seller;
  const cloud = typeof facts.cloud_provider === "string" && facts.cloud_provider ? facts.cloud_provider : null;
  let problems: string[] = [];
  let last = { subject: "", body: "" };
  for (let attempt = 0; attempt < 2; attempt++) {
    last = await llm.json({
      tier: "strong",
      system:
        "You write short, specific first-contact emails from a seller to one named person. Plain text, no links, no bullets, no hype. " +
        "Only make claims about the seller that appear in the allowed claims. Never invent statistics, customers or deadlines.",
      prompt:
        `Seller: ${s.name}. Offer: ${s.one_line_offer}\nAllowed claims about the seller:\n${s.allowed_claims.map((c) => `- ${c}`).join("\n")}\n` +
        `Tone: ${s.tone_notes ?? "plain and specific"}\nSingle soft ask to end with: ${s.ask}\n\n` +
        `Recipient: ${first} (${contact.title}) at ${(facts.company_name as string) || "the company"}.\n` +
        `Hook (strongest pain, must open the email, tied to this evidence): ${pains[0]?.pain} | evidence: ${pains[0]?.evidence_text}\n` +
        `Supporting pain (optional, one clause): ${pains[1]?.pain}\n` +
        (cloud ? `They use ${cloud}; you may mention it once.\n` : "") +
        (flagged ? "The situation is UNCONFIRMED: phrase the opening hook as a question and do not claim it is true.\n" : "State the situation plainly in the opening sentence.\n") +
        `Rules: ${profile.email.min_words}-${profile.email.max_words} words in the body; subject at most ${profile.email.subject_max_words} words; start with "Hi ${first},"; end with a sign-off line "${s.sender_name}, ${s.sender_title}". Avoid: ${profile.email.banned_phrases.join(", ")}.\n` +
        (instruction ? `A human reviewer asked for this change. Follow it where it does not break the rules above: ${instruction.slice(0, 300)}\n` : "") +
        (problems.length ? `Your previous draft failed these checks, fix them: ${problems.join("; ")}\n` : "") +
        `Return JSON: {"subject": "", "body": ""}`,
      schema,
    });
    problems = lintEmail(last, profile, { firstName: first, flagged, hookEvidence: pains[0]?.evidence_text ?? "" });
    if (problems.length === 0) return { ...last, lint: [], regenerations: attempt };
  }
  return { ...last, lint: problems, regenerations: 1 };
}
