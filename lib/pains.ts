import { z } from "zod";
import type { LLM } from "./llm";
import type { Profile } from "./profile-schema";
import type { Evidence } from "./extract";
import type { Candidate, Facts, GateResult, Pain } from "./types";

const schema = z.object({
  pains: z.array(z.object({ pain: z.string(), why_this_person: z.string(), evidence_field: z.string(), evidence_text: z.string() })).length(2),
});

export function validatePains(pains: Pain[], facts: Facts, gates: GateResult[]): boolean {
  return pains.every((p) => {
    if (p.evidence_text.trim().length < 8) return false;
    if (p.evidence_field.startsWith("gate:")) return gates.some((g) => g.id === p.evidence_field.slice(5));
    const v = facts[p.evidence_field];
    return v !== null && v !== undefined && v !== "";
  });
}

export async function findPains(
  llm: LLM,
  profile: Profile,
  contact: Candidate,
  facts: Facts,
  evidence: Record<string, Evidence>,
  gates: GateResult[],
): Promise<{ pains: Pain[]; generic: boolean }> {
  const persona = profile.personas.find((p) => p.tier === contact.tier) ?? profile.personas[0];
  const known = Object.entries(facts)
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `- ${k} = ${JSON.stringify(v)} (evidence: ${evidence[k]?.text ?? "n/a"})`)
    .join("\n");
  const gateLines = gates.map((g) => `- gate:${g.id} ${g.answer}: ${g.evidence}`).join("\n");
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await llm.json({
      tier: "cheap",
      system:
        "You identify the two most likely problems a specific person at a specific company has that the seller can help with. " +
        "Every problem must be tied to a real fact from the lists provided: set evidence_field to a fact name or gate:<id>, and evidence_text to the supporting words. " +
        "Pain 1 must be the stronger one. Never invent facts.",
      prompt:
        `Seller offer: ${profile.seller.one_line_offer}\nPerson: ${contact.name}, ${contact.title} (persona tier ${persona.tier})\n` +
        `Lens for this persona: ${persona.pain_lens.join("; ")}\n\nKNOWN FACTS:\n${known}\n\nGATE EVIDENCE:\n${gateLines}\n` +
        (problem ? `\nYour previous answer was rejected: ${problem}\n` : "") +
        `\nReturn JSON: {"pains":[{"pain":"","why_this_person":"","evidence_field":"","evidence_text":""},{"pain":"","why_this_person":"","evidence_field":"","evidence_text":""}]}`,
      schema,
    });
    if (validatePains(out.pains, facts, gates)) return { pains: out.pains, generic: false };
    problem = "each pain needs a real evidence_field from the lists and evidence_text of at least a few words";
    if (attempt === 1) return { pains: out.pains.map((p) => ({ ...p, generic: true })), generic: true };
  }
  return { pains: [], generic: true };
}
