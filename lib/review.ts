import { lintEmail } from "./lint";
import type { Profile } from "./profile-schema";
import type { DomainResult } from "./types";

export type ReviewStatus = "pending_review" | "approved" | "rejected";
export type ReviewAction = "approve" | "reject" | "reopen";

/** Review moves only along these lines. Approving or rejecting needs a pending draft; anything else must be reopened first. */
const NEXT: Record<ReviewStatus, ReviewStatus[]> = {
  pending_review: ["approved", "rejected"],
  approved: ["pending_review"],
  rejected: ["pending_review"],
};

export function canMoveDraft(from: ReviewStatus, to: ReviewStatus): boolean { return NEXT[from].includes(to); }
export function moveDraft(from: ReviewStatus, to: ReviewStatus): ReviewStatus {
  if (!canMoveDraft(from, to)) throw new Error(from === to ? `Already ${to.replace(/_/g, " ")}.` : `A ${from.replace(/_/g, " ")} draft cannot become ${to.replace(/_/g, " ")}. Reopen it first.`);
  return to;
}
export const targetFor = (a: ReviewAction): ReviewStatus => (a === "approve" ? "approved" : a === "reject" ? "rejected" : "pending_review");

export const LIMITS = { subject: 200, body: 8000, notes: 2000, instruction: 300, reviewer: 80 } as const;

/** Names are labels, not identities, until sign-in exists. Strip control characters and cap the length. */
export function cleanReviewer(v: unknown): string {
  const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, LIMITS.reviewer) : "";
  return s || "Reviewer";
}

/** Same rules the engine used to write the draft, applied to the human's edited text. */
export function lintDraft(profile: Profile, result: DomainResult, subject: string, body: string): string[] {
  const first = (result.contact?.name ?? "").split(" ")[0] || "there";
  return lintEmail({ subject, body }, profile, { firstName: first, flagged: result.outcome === "qualify_and_flag", hookEvidence: result.pains[0]?.evidence_text ?? "" });
}

/** Approval needs a clean lint, or the reviewer saying out loud that they accept the warnings. */
export function approvalBlocked(lint: string[], override: boolean): string | null {
  return lint.length > 0 && !override ? `This draft has ${lint.length} warning${lint.length > 1 ? "s" : ""}: ${lint.join("; ")}. Fix them, or approve anyway to accept them.` : null;
}

/** Short labels for what the draft was personalised from. */
export function reviewTags(result: DomainResult): string[] {
  const tags: string[] = [];
  for (const p of result.pains.slice(0, 2)) if (p.evidence_field) tags.push(p.evidence_field.replace(/^gate:/, "gate "));
  if (result.outcome === "qualify_and_flag") tags.push("unconfirmed: phrased as a question");
  if (result.contact?.tier != null) tags.push(`persona tier ${result.contact.tier}`);
  if (typeof result.facts.cloud_provider === "string" && result.facts.cloud_provider) tags.push(`mentions ${result.facts.cloud_provider}`);
  return [...new Set(tags)];
}
