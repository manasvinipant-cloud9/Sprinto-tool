import { db, must } from "../db";
import { currentCtx, currentWorkspaceId } from "../ctx";
import { audit } from "../audit";
import { resolveKeys } from "./workspace";
import { maskEmail } from "../mask";
import { draftEmail } from "../email";
import { buildApprovedDraftsCsv, type ApprovedDraft } from "../export";
import { createLLM, type Deps } from "../pipeline";
import { profileSchema, type Profile } from "../profile-schema";
import { approvalBlocked, canMoveDraft, LIMITS, lintDraft, moveDraft, reviewTags, targetFor, type ReviewAction, type ReviewStatus } from "../review";
import type { DomainResult } from "../types";

export interface DraftView {
  id: string; version: number; subject: string; body: string; notes: string; tags: string[];
  lint: string[]; lintOverridden: boolean; reviewStatus: ReviewStatus;
  edited: boolean; editCount: number; editedAt: string | null; instruction: string | null; source: string;
  createdAt: string; reviewedAt: string | null; reviewedBy: string | null; approvedAt: string | null; approvedBy: string | null;
  versions: number;
}
export interface ReviewItem {
  accountId: string; domain: string; company: string; position: number; stage: string; score: number | null; flags: string[]; reason: string | null;
  contact: { name: string; title: string; email: string; tier: number | null } | null;
  draft: DraftView | null;
}
/** Who is acting, taken from the signed-in session, never from the request body. */
function actor() { const c = currentCtx(); return { id: c.userId, label: c.email || "worker" }; }

export class ReviewError extends Error { constructor(message: string, public status = 400) { super(message); } }

type DraftRow = {
  id: string; account_id: string; workspace_id: string; version: number; subject: string; body: string; notes: string | null; tags: string[] | null;
  instruction: string | null; lint: string[] | null; lint_overridden: boolean; review_status: ReviewStatus; is_current: boolean; created_at: string;
  reviewed_at: string | null; reviewed_by_label: string | null; approved_at: string | null; approved_by_label: string | null;
  generated_subject: string | null; generated_body: string | null; edited_at: string | null; edit_count: number; source: string;
};
const COLS = "id, account_id, workspace_id, version, subject, body, notes, tags, instruction, lint, lint_overridden, review_status, is_current, created_at, reviewed_at, reviewed_by_label, approved_at, approved_by_label, generated_subject, generated_body, edited_at, edit_count, source";

function view(d: DraftRow, versions: number): DraftView {
  return {
    id: d.id, version: d.version, subject: d.subject, body: d.body, notes: d.notes ?? "", tags: d.tags ?? [], lint: d.lint ?? [], lintOverridden: d.lint_overridden, reviewStatus: d.review_status,
    edited: d.subject !== (d.generated_subject ?? d.subject) || d.body !== (d.generated_body ?? d.body), editCount: d.edit_count, editedAt: d.edited_at, instruction: d.instruction, source: d.source,
    createdAt: d.created_at, reviewedAt: d.reviewed_at, reviewedBy: d.reviewed_by_label, approvedAt: d.approved_at, approvedBy: d.approved_by_label, versions,
  };
}

// ---------- reading ----------

/** Qualified accounts of a run with their current draft, for the review workspace. */
export async function listReview(runId: string): Promise<ReviewItem[]> {
  must(await db().from("runs").select("id").eq("id", runId).eq("workspace_id", currentWorkspaceId()).single(), "load run");
  const rows = must<Record<string, unknown>[]>(await db().from("run_accounts").select(`id, domain, position, stage, qualification, score, reason, result, drafts(${COLS})`).eq("run_id", runId).eq("workspace_id", currentWorkspaceId()).eq("qualification", "qualified").order("position"), "load review queue");
  return rows.map((r) => {
    const res = r.result as DomainResult | null;
    const all = ((r.drafts as DraftRow[] | null) ?? []);
    const cur = all.find((d) => d.is_current) ?? null;
    return {
      accountId: r.id as string, domain: r.domain as string, company: (res?.facts.company_name as string | null) || (r.domain as string), position: Number(r.position), stage: r.stage as string,
      score: (r.score as number | null) ?? null, flags: res?.flags ?? [], reason: (r.reason as string | null) ?? null,
      contact: res?.contact ? { name: res.contact.name, title: res.contact.title, email: currentCtx().demo ? maskEmail(res.contact.email) : res.contact.email, tier: res.contact.tier } : null,
      draft: cur ? view(cur, all.length) : null,
    };
  });
}

async function loadDraft(draftId: string): Promise<{ draft: DraftRow; result: DomainResult; profile: Profile; runId: string }> {
  const d = await db().from("drafts").select(COLS).eq("id", draftId).eq("workspace_id", currentWorkspaceId()).limit(1);
  const draft = (d.data?.[0] as DraftRow | undefined);
  if (!draft) throw new ReviewError("Draft not found.", 404);
  const a = await db().from("run_accounts").select("run_id, result, runs(profile_id, profiles(spec))").eq("id", draft.account_id).eq("workspace_id", currentWorkspaceId()).limit(1);
  const acct = a.data?.[0] as { run_id: string; result: DomainResult | null; runs: { profiles: { spec: unknown } } } | undefined;
  if (!acct?.result) throw new ReviewError("The account for this draft has no result.", 409);
  return { draft, result: acct.result, profile: profileSchema.parse(acct.runs.profiles.spec), runId: acct.run_id };
}

async function countVersions(accountId: string): Promise<number> {
  const r = await db().from("drafts").select("id").eq("account_id", accountId).eq("workspace_id", currentWorkspaceId());
  return r.data?.length ?? 0;
}

export async function getVersions(draftId: string) {
  const { draft } = await loadDraft(draftId);
  const rows = must<DraftRow[]>(await db().from("drafts").select(COLS).eq("account_id", draft.account_id).eq("workspace_id", currentWorkspaceId()).order("version", { ascending: false }), "load versions");
  return rows.map((d) => ({ ...view(d, rows.length), isCurrent: d.is_current }));
}

// ---------- editing and review ----------

export interface EditPatch { subject?: string; body?: string; notes?: string }

/** Edits the current draft. Changing the wording sends it back to pending review: an approval applies to the exact text approved. */
export async function editDraft(draftId: string, patch: EditPatch): Promise<DraftView> {
  const me = actor();
  const { draft, result, profile } = await loadDraft(draftId);
  if (!draft.is_current) throw new ReviewError("Only the current version can be edited. Use this version first.", 409);
  const subject = patch.subject ?? draft.subject; const body = patch.body ?? draft.body; const notes = patch.notes ?? draft.notes ?? "";
  if (subject.length > LIMITS.subject || body.length > LIMITS.body || notes.length > LIMITS.notes) throw new ReviewError("That text is too long.");
  if (!subject.trim() || !body.trim()) throw new ReviewError("A draft needs a subject and a body.");
  const wordingChanged = subject !== draft.subject || body !== draft.body;
  const update: Record<string, unknown> = { subject, body, notes, updated_at: new Date().toISOString() };
  if (wordingChanged) {
    Object.assign(update, {
      lint: lintDraft(profile, result, subject, body), lint_overridden: false, edit_count: draft.edit_count + 1, edited_at: new Date().toISOString(),
      review_status: "pending_review", reviewed_at: null, reviewed_by_label: me.label, reviewed_by: me.id, approved_at: null, approved_by_label: null, approved_by: null,
    });
  }
  const saved = must<DraftRow>(await db().from("drafts").update(update).eq("id", draftId).eq("workspace_id", currentWorkspaceId()).eq("is_current", true).select(COLS).single(), "save draft");
  await audit(wordingChanged ? "draft.edited" : "draft.notes_edited", { type: "draft", id: draftId }, { version: draft.version, was: draft.review_status });
  return view(saved, await countVersions(draft.account_id));
}

export async function reviewDraft(draftId: string, action: ReviewAction, opts: { overrideLint?: boolean } = {}): Promise<DraftView> {
  const me = actor();
  const { draft } = await loadDraft(draftId);
  if (!draft.is_current) throw new ReviewError("Only the current version can be reviewed.", 409);
  const to = targetFor(action);
  try { moveDraft(draft.review_status, to); } catch (e) { throw new ReviewError((e as Error).message, 409); }
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { review_status: to, updated_at: now };
  if (to === "approved") {
    const blocked = approvalBlocked(draft.lint ?? [], Boolean(opts.overrideLint));
    if (blocked) throw new ReviewError(blocked, 409);
    Object.assign(update, { reviewed_at: now, reviewed_by_label: me.label, reviewed_by: me.id, approved_at: now, approved_by_label: me.label, approved_by: me.id, lint_overridden: (draft.lint ?? []).length > 0 });
  } else if (to === "rejected") {
    Object.assign(update, { reviewed_at: now, reviewed_by_label: me.label, reviewed_by: me.id, approved_at: null, approved_by_label: null, approved_by: null });
  } else {
    Object.assign(update, { reviewed_at: null, reviewed_by: null, approved_at: null, approved_by_label: null, approved_by: null, lint_overridden: false });
  }
  // The status filter makes a double click or a second reviewer fail cleanly instead of overwriting.
  const res = await db().from("drafts").update(update).eq("id", draftId).eq("workspace_id", currentWorkspaceId()).eq("review_status", draft.review_status).eq("is_current", true).select(COLS);
  if (res.error) throw new ReviewError(res.error.message, 500);
  if (!res.data?.length) throw new ReviewError("This draft changed while you were reviewing it. Reload and try again.", 409);
  await audit(`draft.${to === "approved" ? "approved" : to === "rejected" ? "rejected" : "reopened"}`, { type: "draft", id: draftId }, { version: draft.version, warnings_accepted: to === "approved" && (draft.lint ?? []).length > 0 });
  return view(res.data[0] as DraftRow, await countVersions(draft.account_id));
}

// ---------- regenerate, history ----------

async function newVersion(draft: DraftRow, fields: { subject: string; body: string; notes?: string; lint: string[]; tags: string[]; instruction: string | null; source: "regenerated" | "restored"; tokens_in?: number; tokens_out?: number }): Promise<DraftRow> {
  const me = actor();
  const maxV = must<{ version: number }[]>(await db().from("drafts").select("version").eq("account_id", draft.account_id).eq("workspace_id", currentWorkspaceId()).order("version", { ascending: false }).limit(1), "latest version")[0].version;
  // Retire the old current version first (a unique index allows one current draft per account), then add the new one.
  must(await db().from("drafts").update({ is_current: false }).eq("id", draft.id).select("id"), "retire version");
  const ins = await db().from("drafts").insert({
    account_id: draft.account_id, workspace_id: draft.workspace_id, version: maxV + 1, subject: fields.subject, body: fields.body, notes: fields.notes ?? draft.notes ?? "",
    generated_subject: fields.subject, generated_body: fields.body, instruction: fields.instruction, source: fields.source, tags: fields.tags, lint: fields.lint, lint_overridden: false,
    review_status: "pending_review", is_current: true, reviewed_by_label: me.label, reviewed_by: me.id, tokens_in: fields.tokens_in ?? 0, tokens_out: fields.tokens_out ?? 0,
  }).select(COLS).single();
  if (ins.error || !ins.data) {
    await db().from("drafts").update({ is_current: true }).eq("id", draft.id); // put the old one back
    throw new ReviewError(`Could not save the new version: ${ins.error?.message ?? "unknown"}`, 500);
  }
  return ins.data as DraftRow;
}

/** Writes a new version following the reviewer's instruction. The old version stays in the history. */
export async function regenerateDraft(draftId: string, instructionRaw: unknown, opts: { llm?: Deps["llm"] } = {}): Promise<DraftView> {
  const instruction = typeof instructionRaw === "string" ? instructionRaw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  if (!instruction) throw new ReviewError("Say what to change, for example: make it shorter.");
  if (instruction.length > LIMITS.instruction) throw new ReviewError(`Keep the instruction under ${LIMITS.instruction} characters.`);
  const { draft, result, profile } = await loadDraft(draftId);
  if (!draft.is_current) throw new ReviewError("Only the current version can be regenerated.", 409);
  if (!result.contact) throw new ReviewError("This account has no contact, so there is nothing to write to.", 409);
  const llm = opts.llm ?? createLLM((await resolveKeys()).llm);
  const before = { p: llm.usage.prompt, o: llm.usage.output };
  const out = await draftEmail(llm, profile, result.contact, result.facts, result.pains, result.outcome === "qualify_and_flag", instruction);
  const saved = await newVersion(draft, { subject: out.subject, body: out.body, lint: out.lint, tags: reviewTags(result), instruction, source: "regenerated", tokens_in: llm.usage.prompt - before.p, tokens_out: llm.usage.output - before.o });
  await audit("draft.regenerated", { type: "draft", id: saved.id }, { version: saved.version, instruction });
  return view(saved, await countVersions(draft.account_id));
}

/** Makes an older version the current one by copying it forward as a new version. History is never rewritten. */
export async function restoreVersion(currentDraftId: string, fromVersion: number): Promise<DraftView> {
  const { draft, result, profile } = await loadDraft(currentDraftId);
  const src = must<DraftRow[]>(await db().from("drafts").select(COLS).eq("account_id", draft.account_id).eq("workspace_id", currentWorkspaceId()).eq("version", fromVersion).limit(1), "load version")[0];
  if (!src) throw new ReviewError("That version does not exist.", 404);
  if (src.id === draft.id) throw new ReviewError("That is already the current version.", 409);
  const saved = await newVersion(draft, { subject: src.subject, body: src.body, notes: src.notes ?? "", lint: lintDraft(profile, result, src.subject, src.body), tags: src.tags ?? [], instruction: `restored from version ${src.version}`, source: "restored" });
  await audit("draft.restored", { type: "draft", id: saved.id }, { version: saved.version, from_version: src.version });
  return view(saved, await countVersions(draft.account_id));
}

// ---------- export ----------

export async function approvedDrafts(runId: string): Promise<ApprovedDraft[]> {
  const run = must<{ created_at: string; profiles: { name: string; slug: string; version: number } }>(await db().from("runs").select("created_at, profiles(name, slug, version)").eq("id", runId).eq("workspace_id", currentWorkspaceId()).single(), "load run");
  const rows = must<Record<string, unknown>[]>(await db().from("run_accounts").select(`domain, position, score, result, drafts(${COLS})`).eq("run_id", runId).eq("workspace_id", currentWorkspaceId()), "load drafts");
  const out: ApprovedDraft[] = [];
  for (const r of rows) {
    const d = ((r.drafts as DraftRow[] | null) ?? []).find((x) => x.is_current && x.review_status === "approved");
    if (!d) continue;
    const res = r.result as DomainResult | null;
    out.push({
      position: Number(r.position), company: (res?.facts.company_name as string | null) || (r.domain as string), domain: r.domain as string, score: (r.score as number | null) ?? null,
      contactName: res?.contact?.name ?? "", contactTitle: res?.contact?.title ?? "", contactEmail: res?.contact?.email ? (currentCtx().demo ? maskEmail(res.contact.email) : res.contact.email) : "",
      subject: d.subject, body: d.body, notes: d.notes ?? "", tags: d.tags ?? [], version: d.version, edited: d.subject !== (d.generated_subject ?? d.subject) || d.body !== (d.generated_body ?? d.body),
      lintOverridden: d.lint_overridden, approvedBy: d.approved_by_label ?? "", approvedAt: d.approved_at ?? "", profile: `${run.profiles.name} v${run.profiles.version}`,
    });
  }
  return out.sort((a, b) => a.position - b.position);
}

export async function exportApprovedCsv(runId: string): Promise<string> {
  const items = await approvedDrafts(runId);
  await audit("export.approved_drafts", { type: "run", id: runId }, { count: items.length });
  return buildApprovedDraftsCsv(items);
}

export { canMoveDraft };
