import { toCsv } from "./csv";
import { evidenceUrls, matchedPersonas, rankKey, summarizeEvidence } from "./evidence";
import type { DomainResult } from "./types";

export const SHORTLIST_COLUMNS = ["rank", "company", "domain", "fit_score", "qualification", "stage", "matched_personas", "chosen_contact", "contact_title", "contact_email", "flags", "evidence_summary", "evidence_urls", "gate_results", "score_factors", "draft_status", "reason"];

export interface ShortlistItem {
  domain: string; position: number; stage: string; qualification: string | null; score: number | null; reason: string | null;
  result: DomainResult | null; draftStatus: string | null;
}

/** Ranked shortlist with evidence. Needs no drafts. scope "qualified" keeps only qualified accounts. */
export function buildShortlistCsv(items: ShortlistItem[], scope: "all" | "qualified" = "all"): string {
  const list = items
    .map((x) => ({ x, key: rankKey(x.stage, Boolean(x.draftStatus), x.score) }))
    .filter(({ x }) => scope === "all" || x.qualification === "qualified")
    .sort((a, b) => b.key - a.key || a.x.position - b.x.position);
  return toCsv(SHORTLIST_COLUMNS, list.map(({ x }, i) => {
    const res = x.result;
    const personas = res ? matchedPersonas(res) : null;
    return [
      i + 1, (res?.facts.company_name as string | null) ?? "", x.domain, x.score ?? "", x.qualification ?? "", x.stage,
      personas ? personas.tiers.map((t) => `Tier ${t}${personas.chosen === t ? " (chosen)" : ""}`).join("; ") : "",
      res?.contact?.name ?? "", res?.contact?.title ?? "", res?.contact?.email ?? "", res?.flags.join("; ") ?? "",
      res ? summarizeEvidence(res) : (x.reason ?? ""), res ? evidenceUrls(res).join(" | ") : "",
      res?.gates.map((g) => `${g.id}:${g.answer.toUpperCase()}`).join("|") ?? "",
      res?.score_breakdown.map((s) => `${s.id}:${s.result}:+${s.points}${s.no_evidence && s.result !== "unknown" ? ":no_evidence" : ""}`).join("|") ?? "",
      x.draftStatus ?? "no_draft", x.reason ?? "",
    ];
  }));
}

export interface ApprovedDraft {
  position: number; company: string; domain: string; score: number | null;
  contactName: string; contactTitle: string; contactEmail: string;
  subject: string; body: string; notes: string; tags: string[]; version: number; edited: boolean; lintOverridden: boolean;
  approvedBy: string; approvedAt: string; profile: string;
}

export const APPROVED_COLUMNS = ["company", "domain", "fit_score", "contact_name", "contact_title", "contact_email", "subject", "body", "reviewer_notes", "personalization", "draft_version", "edited_by_reviewer", "warnings_accepted", "approved_by", "approved_at", "profile"];

/** Approved drafts only, in queue order. The text is exactly what the reviewer approved, edits included. */
export function buildApprovedDraftsCsv(items: ApprovedDraft[]): string {
  return toCsv(APPROVED_COLUMNS, items.map((d) => [d.company, d.domain, d.score ?? "", d.contactName, d.contactTitle, d.contactEmail, d.subject, d.body, d.notes, d.tags.join("; "), d.version, d.edited ? "yes" : "no", d.lintOverridden ? "yes" : "no", d.approvedBy, d.approvedAt, d.profile]));
}

/** Plain text for pasting into a mail client. Nothing here sends anything. */
export function formatDraftsForCopy(items: ApprovedDraft[]): string {
  return items.map((d) => [`To: ${d.contactName}${d.contactEmail ? ` <${d.contactEmail}>` : ""} (${d.contactTitle}, ${d.company})`, `Subject: ${d.subject}`, "", d.body.trim()].join("\n")).join("\n\n----------------------------------------\n\n");
}
