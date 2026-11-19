// Phase 5 check against the real database with a fake model: review rules, edit-resets-approval, lint override,
// regenerate with history, restore, a double-approve race, and the approved-only export.
// KEEP=1 leaves the run for the browser; CLEAN_ONLY=1 removes runs this script created (marked by their note).
import { serviceDb as db } from "../lib/db";
import { enterCtx } from "../lib/ctx";
import { serviceCtx } from "../lib/db";
import { workspaceByName } from "./_service";
import { createRun, deleteRun, tickRun, type MakeDeps } from "../lib/services/runs";
import { editDraft, exportApprovedCsv, getVersions, listReview, regenerateDraft, restoreVersion, reviewDraft, ReviewError } from "../lib/services/drafts";
import { makeDeps, makeLLM, QUALIFYING, withTokens } from "../tests/fakes";

const MARK = "phase5-check";
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) process.exitCode = 1; };
const fails = async (p: Promise<unknown>, re: RegExp) => { try { await p; return false; } catch (e) { return e instanceof ReviewError && re.test(e.message); } };

const fakeMake: MakeDeps = (_p, onStage) => ({ ...makeDeps(QUALIFYING), llm: withTokens(makeLLM(QUALIFYING), 500), overrides: () => ({}), async hunter() { return QUALIFYING.contacts; }, onStage });

async function cleanMarked() {
  const rows = (await db().from("runs").select("id").eq("note", MARK)).data ?? [];
  for (const r of rows) await deleteRun((r as { id: string }).id);
  return rows.length;
}

async function main() {
  enterCtx(serviceCtx(await workspaceByName(), "script"));
  if (process.env.CLEAN_ONLY) { console.log(`removed ${await cleanMarked()} leftover runs`); return; }
  const keep = Boolean(process.env.KEEP);
  let runId = "";
  try {
    const created = await createRun({ profileSlug: "sprinto", domains: ["one.test", "two.test", "three.test", "four.test", "five.test"] });
    runId = created.runId;
    await db().from("runs").update({ note: MARK }).eq("id", runId);
    for (let i = 0; i < 12; i++) if ((await tickRun(runId, fakeMake)).state === "finished") break;
    if (process.env.SEED_ONLY) { console.log(`SEEDED run ${runId} with pending drafts. Remove with: CLEAN_ONLY=1 npm run phase5-check`); return; }

    let items = await listReview(runId);
    ok(items.length === 5 && items.every((i) => i.draft?.reviewStatus === "pending_review"), "5 qualified accounts, each with a pending draft");
    ok(items.every((i) => i.draft!.tags.length > 0 && i.draft!.version === 1 && !i.draft!.edited), "drafts carry personalisation tags and start unedited at version 1");
    const [a, b, c, d, e] = items.map((i) => i.draft!);

    // approval
    const approved = await reviewDraft(a.id, "approve");
    ok(approved.reviewStatus === "approved" && approved.approvedBy === "script" && !!approved.approvedAt && !!approved.reviewedAt, "approve sets status and audit fields (approver from the session, approved_at, reviewed_at)");
    ok(await fails(reviewDraft(a.id, "approve"), /Already approved/), "approving an approved draft is refused");
    ok(await fails(reviewDraft(a.id, "reject"), /Reopen it first/), "rejecting an approved draft is refused until it is reopened");

    // editing resets approval; notes alone do not
    const notesOnly = await editDraft(a.id, { notes: "call after the board meeting" });
    ok(notesOnly.reviewStatus === "approved" && notesOnly.notes.includes("board meeting") && notesOnly.editCount === 0, "editing only notes keeps the approval");
    const reworded = await editDraft(a.id, { body: approved.body.replace("Would a short call", "Is a short call") });
    ok(reworded.reviewStatus === "pending_review" && reworded.approvedAt === null && reworded.approvedBy === null && reworded.edited && reworded.editCount === 1, "changing the wording sends an approved draft back to pending and clears the approval");
    ok(await fails(editDraft(a.id, { subject: "   " }), /needs a subject/), "an empty subject is refused");

    // lint override
    const withLink = await editDraft(b.id, { body: `${b.body}\nSee https://example.com/offer` });
    ok(withLink.lint.some((l) => /link/.test(l)), "an edit that adds a link is flagged by the same lint the engine uses");
    ok(await fails(reviewDraft(b.id, "approve"), /warning/), "approving with warnings is refused");
    const accepted = await reviewDraft(b.id, "approve", { overrideLint: true });
    ok(accepted.reviewStatus === "approved" && accepted.lintOverridden, "approving with the warnings accepted is recorded");

    // reject and reopen
    const rejected = await reviewDraft(c.id, "reject");
    ok(rejected.reviewStatus === "rejected" && rejected.approvedAt === null && !!rejected.reviewedAt, "reject records who and when");
    const reopened = await reviewDraft(c.id, "reopen");
    ok(reopened.reviewStatus === "pending_review" && reopened.reviewedAt === null, "reopen returns a draft to pending");
    await reviewDraft(c.id, "reject");

    // regenerate keeps history
    const llm = makeLLM(QUALIFYING);
    const regenLlm = { usage: llm.usage, json: async (o: Parameters<typeof llm.json>[0]) => (o.system.startsWith("You write short") ? o.schema.parse({ subject: "A shorter note", body: d.body }) : llm.json(o)) } as typeof llm;
    const v2 = await regenerateDraft(d.id, "Make it shorter", { llm: regenLlm });
    ok(v2.version === 2 && v2.instruction === "Make it shorter" && v2.source === "regenerated" && v2.reviewStatus === "pending_review" && v2.subject === "A shorter note", "regenerate writes version 2 with the instruction recorded");
    const versions = await getVersions(v2.id);
    ok(versions.length === 2 && versions.filter((v) => v.isCurrent).length === 1 && versions.find((v) => v.version === 1)!.subject === d.subject && !versions.find((v) => v.version === 1)!.isCurrent, "version 1 is kept in the history and is no longer current");
    ok(await fails(editDraft(d.id, { notes: "x" }), /current version/), "an old version cannot be edited");
    ok(await fails(regenerateDraft(v2.id, "   ", { llm: regenLlm }), /Say what to change/), "an empty instruction is refused");
    const v3 = await restoreVersion(v2.id, 1);
    ok(v3.version === 3 && v3.source === "restored" && v3.subject === d.subject && /restored from version 1/.test(v3.instruction ?? ""), "restoring copies an old version forward as version 3");
    ok((await getVersions(v3.id)).length === 3, "history now holds three versions");

    // a double approve: exactly one wins
    const race = await Promise.allSettled([reviewDraft(e.id, "approve"), reviewDraft(e.id, "approve")]);
    ok(race.filter((r) => r.status === "fulfilled").length === 1 && race.filter((r) => r.status === "rejected").length === 1, "two simultaneous approvals: one succeeds, one is refused");

    // export: approved only, exactly as approved
    await editDraft(b.id, { body: b.body.replace(/\n?See https?:\S+/, "") + "\nPS: my own closing line." });
    const accepted2 = await reviewDraft(b.id, "approve");
    const csv = await exportApprovedCsv(runId);
    const rows = csv.trim().split("\r\n").slice(1);
    items = await listReview(runId);
    const approvedNow = items.filter((i) => i.draft?.reviewStatus === "approved");
    ok(rows.length === approvedNow.length && rows.length === 2, `export has ${rows.length} rows, one per approved draft`);
    ok(rows.some((r) => r.includes("my own closing line")) && accepted2.reviewStatus === "approved", "the exported body is the reviewer's edited text");
    ok(!rows.some((r) => r.includes("one.test")) && !rows.some((r) => r.includes("three.test")) && !rows.some((r) => r.includes("four.test")), "pending, rejected and reopened-then-edited drafts are not in the export");
    ok(approvedNow.every((i) => i.draft!.approvedBy && i.draft!.approvedAt), "every approved draft has approved_by and approved_at");
  } finally {
    if (process.env.SEED_ONLY) { /* leave the seeded run in place */ }
    else if (keep) console.log(`KEPT for inspection: run ${runId}. Remove with: CLEAN_ONLY=1 npm run phase5-check`);
    else { if (runId) await deleteRun(runId).catch(() => undefined); console.log("cleaned up"); }
  }
}
main().catch((e) => { console.error("FAIL ", e); process.exit(1); });
