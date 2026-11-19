// Phase 4 check against the real database with a fake model: compare two profiles over the same 5 domains
// (paired runs driven in turn), verify pairing, diffs, and that decision traces are stored and add up.
// KEEP=1 leaves the data for the browser; CLEAN_ONLY=1 removes runs this script created (marked by their note).
import { serviceDb as db } from "../lib/db";
import { enterCtx } from "../lib/ctx";
import { serviceCtx } from "../lib/db";
import { workspaceByName } from "./_service";
import { createComparison, createRun, deleteRun, getAccountResult, getComparison, getRun, saveTrace, tickRun, type MakeDeps } from "../lib/services/runs";
import { makeDeps, makeLLM, QUALIFYING, withTokens, type Scenario } from "../tests/fakes";

const MARK = "phase4-check";
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) process.exitCode = 1; };

const scenarios: Record<string, Scenario> = {
  "good.test": QUALIFYING,
  "agency.test": { ...QUALIFYING, judge: (q) => (/B2B/i.test(q) ? "fail" : "pass") },
  "nocontact.test": { ...QUALIFYING, contacts: [] },
  "small.test": { ...QUALIFYING, fields: { ...QUALIFYING.fields, headcount_min: 30, headcount_max: 40 }, contacts: [{ name: "Maya Roy", email: "maya@small.test", title: "CEO", confidence: 90 }] },
  "india.test": { ...QUALIFYING, fields: { ...QUALIFYING.fields, india_presence: true, hiring_surge: true, open_roles_count: 12, headcount_min: 40, headcount_max: 60 }, contacts: [{ name: "Anita Rao", email: "anita@india.test", title: "Head of People", confidence: 90 }] },
};

const fakeMake: MakeDeps = (_p, onStage, _ws, domain) => {
  const sc = scenarios[domain] ?? QUALIFYING;
  const base = makeDeps(sc);
  return { ...base, llm: withTokens(makeLLM(sc), 500), overrides: () => ({}), async hunter() { return sc.contacts; }, onStage };
};

async function cleanMarked() {
  const rows = (await db().from("runs").select("id").eq("note", MARK)).data ?? [];
  for (const r of rows) await deleteRun((r as { id: string }).id);
  return rows.length;
}

async function main() {
  const ws = await workspaceByName();
  enterCtx(serviceCtx(ws, "script"));
  if (process.env.CLEAN_ONLY) { console.log(`removed ${await cleanMarked()} leftover runs`); return; }
  const keep = Boolean(process.env.KEEP);
  const ids: string[] = [];
  try {
    const domains = Object.keys(scenarios);
    const { groupId, runA, runB, queued, capped } = await createComparison({ a: { slug: "sprinto" }, b: { slug: "payroll-example" }, domains });
    ids.push(runA, runB);
    await db().from("runs").update({ note: MARK }).in("id", [runA, runB]);
    const [a0, b0] = await Promise.all([getRun(runA), getRun(runB)]);
    ok(a0.comparison_group === groupId && b0.comparison_group === groupId, "both runs share one comparison group");
    ok(queued === 5 && capped === 0 && a0.accounts.map((x) => x.domain).join() === b0.accounts.map((x) => x.domain).join(), "both runs hold the same 5 domains in the same order");
    ok(a0.profile.slug === "sprinto" && b0.profile.slug === "payroll-example", "runs point at the two profiles");

    // Drive both in turn, as the browser does
    const order: string[] = [];
    for (let i = 0, active = [runA, runB]; active.length && i < 40; i++) {
      for (const id of [...active]) {
        const t = await tickRun(id, fakeMake);
        if (t.state === "processed") order.push(`${id === runA ? "A" : "B"}:${t.domain}`);
        if (t.state === "finished" || t.state === "paused") active = active.filter((x) => x !== id);
      }
    }
    console.log("processing order:", order.join("  "));
    ok(order.length === 10 && order[0].startsWith("A:") && order[1].startsWith("B:") && order[0].slice(2) === order[1].slice(2), "accounts were processed in turn: A then B for each domain");

    const cmp = await getComparison(runA, runB);
    ok(cmp.rows.length === 5 && cmp.rows.every((r) => r.a && r.b && r.a.domain === r.b.domain), "5 rows paired by domain");
    ok(cmp.summary.compared === 5 && cmp.rows.every((r) => r.diff), "every pair has a computed difference");
    ok(cmp.summary.changed >= 1, `profiles disagree on ${cmp.summary.changed} of 5 domains`);
    for (const r of cmp.rows) console.log(`  ${r.domain.padEnd(15)} A:${(r.a!.stage + " " + (r.a!.score ?? "-")).padEnd(22)} B:${(r.b!.stage + " " + (r.b!.score ?? "-")).padEnd(22)} ${r.diff!.verdict}${r.diff!.gateChanges.length ? " gates:" + r.diff!.gateChanges.map((g) => g.id).join(",") : ""}`);
    console.log(`  summary: qualified ${cmp.summary.a.qualified}->${cmp.summary.b.qualified}, disqualified ${cmp.summary.a.disqualified}->${cmp.summary.b.disqualified}, avg ${cmp.summary.a.avgScore}->${cmp.summary.b.avgScore}`);

    // Run C: a different domain list, compared against A
    const c = await createRun({ profileSlug: "payroll-example", domains: ["good.test", "extra.test"] });
    ids.push(c.runId);
    await db().from("runs").update({ note: MARK }).eq("id", c.runId);
    const mixed = await getComparison(runA, c.runId);
    ok(mixed.summary.onlyA === 4 && mixed.summary.onlyB === 1 && mixed.rows.find((r) => r.domain === "extra.test")?.a === null, "comparing runs with different lists keeps one-sided rows");

    // Decision traces are stored, ordered, and add up
    const good = a0.accounts.find((x) => x.domain === "good.test")!;
    const full = await getAccountResult(good.id);
    const steps = full!.trace!;
    ok(steps.length > 8 && steps.every((s, i) => s.seq === i + 1), `trace stored with ${steps.length} ordered steps`);
    ok(steps.some((s) => s.kind === "contact_lookup") && steps.some((s) => s.kind === "draft") && steps.filter((s) => s.kind === "gate").length >= full!.gates.length, "trace includes tools, contact lookup, gates and the lint check");
    const row = (await db().from("run_accounts").select("tokens_in, tokens_out").eq("id", good.id).single()).data as { tokens_in: number; tokens_out: number };
    ok(steps.reduce((x, s) => x + s.tokens_in + s.tokens_out, 0) === row.tokens_in + row.tokens_out && row.tokens_in + row.tokens_out > 0, `step tokens equal the account total (${row.tokens_in + row.tokens_out})`);
    ok(full!.contact_decision?.tiers.length === 3 && full!.contact?.name === "Priya Rao", "contact decision stored with the tier ladder");
    await saveTrace(good.id, ws, steps.slice(0, 3));
    ok((await getAccountResult(good.id))!.trace!.length === 3, "saving a trace again replaces the old one (retries start fresh)");
  } finally {
    if (keep) console.log(`KEPT for inspection: run A ${ids[0]}, run B ${ids[1]}. Remove with: CLEAN_ONLY=1 npm run phase4-check`);
    else { for (const id of ids) await deleteRun(id).catch(() => undefined); console.log("cleaned up"); }
  }
}
main().catch((e) => { console.error("FAIL ", e); process.exit(1); });
