// Phase 2 check against the real database with a fake model: a 5-domain run that shows every stage and outcome,
// then a second run proving max_accounts_per_run. Cleans up everything it creates.
import { serviceDb as db } from "../lib/db";
import { enterCtx } from "../lib/ctx";
import { serviceCtx } from "../lib/db";
import { workspaceByName } from "./_service";
import { createRun, deleteRun, getRun, tickRun, type MakeDeps } from "../lib/services/runs";
import { listProfiles, saveProfileVersion } from "../lib/services/profiles";
import { makeDeps, makeLLM, QUALIFYING, withTokens, type Scenario } from "../tests/fakes";

const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) process.exitCode = 1; };

const scenarios: Record<string, { s: Scenario; perCall: number; badDraft?: boolean }> = {
  "good.test": { s: QUALIFYING, perCall: 500 },
  "agency.test": { s: { ...QUALIFYING, judge: (q) => (/B2B/i.test(q) ? "fail" : "pass") }, perCall: 500 },
  "nocontact.test": { s: { ...QUALIFYING, contacts: [] }, perCall: 500 },
  "toolong.test": { s: QUALIFYING, perCall: 500, badDraft: true },
  "heavy.test": { s: QUALIFYING, perCall: 30000 },
};

const fakeMake = (timeline: Record<string, string[]>): MakeDeps => (_p, onStage, _ws, domainOfRun) => {
  const base = makeDeps(QUALIFYING);
  const pick = () => scenarios[domainOfRun] ?? scenarios["good.test"];
  let llm: ReturnType<typeof withTokens> | null = null;
  return {
    ...base,
    get llm() {
      if (llm) return llm;
      const sc = pick();
      const inner = withTokens(makeLLM(sc.s), sc.perCall);
      llm = sc.badDraft ? { usage: inner.usage, json: async (o) => (o.system.startsWith("You write short") ? o.schema.parse({ subject: "Hi", body: "Too short" }) : inner.json(o)) } : inner;
      return llm;
    },
    overrides: () => ({}),
    async hunter() { return pick().s.contacts; },
    onStage: async (st) => { (timeline[domainOfRun] ??= []).push(st); await onStage(st); },
  };
};

async function drain(runId: string, make: MakeDeps) {
  for (let i = 0; i < 20; i++) { const t = await tickRun(runId, make); if (t.state === "finished") return; }
  throw new Error("run did not finish");
}

async function cleanLeftovers(ws: string) {
  const ids = (await db().from("profiles").select("id").eq("workspace_id", ws).eq("slug", "phase2-check")).data ?? [];
  for (const p of ids) await db().from("runs").delete().eq("profile_id", (p as { id: string }).id);
  await db().from("profiles").delete().eq("workspace_id", ws).eq("slug", "phase2-check");
}

async function main() {
  const ws = await workspaceByName();
  enterCtx(serviceCtx(ws, "script"));
  if (process.env.CLEAN_ONLY) { await cleanLeftovers(ws); console.log("removed leftover demo data"); return; }
  const keep = Boolean(process.env.KEEP);
  const base = (await listProfiles()).find((p) => p.id === "sprinto")!.detail;
  const created: string[] = [];
  try {
    const spec = { ...structuredClone(base), id: "phase2-check" };
    await saveProfileVersion(spec);
    const { runId, queued, capped } = await createRun({ profileSlug: "phase2-check", domains: Object.keys(scenarios) });
    created.push(runId);
    ok(queued === 5 && capped === 0, `created run with ${queued} queued, ${capped} capped`);
    const timeline: Record<string, string[]> = {};
    await drain(runId, fakeMake(timeline));
    const r = await getRun(runId);
    const by = Object.fromEntries(r.accounts.map((a) => [a.domain, a]));
    console.log("stage timeline:");
    for (const [d, t] of Object.entries(timeline)) console.log(`  ${d}: queued > ${t.join(" > ")} > ${by[d].stage}`);
    ok(by["good.test"].stage === "ready_for_review" && by["good.test"].draft?.review_status === "pending_review", "good.test -> ready_for_review with a pending draft");
    ok(by["agency.test"].stage === "disqualified" && by["agency.test"].qualification === "disqualified", "agency.test -> disqualified (hard gate)");
    ok(by["nocontact.test"].stage === "ready_for_review" && !by["nocontact.test"].draft, "nocontact.test -> ready_for_review, no draft");
    ok(by["toolong.test"].stage === "ready_for_review" && by["toolong.test"].brief?.status === "held", "toolong.test -> held for failed lint");
    ok(by["heavy.test"].stage === "capped" && by["heavy.test"].qualification === "capped" && /token_budget/.test(by["heavy.test"].reason ?? ""), `heavy.test -> capped (${by["heavy.test"].reason})`);
    ok(r.status === "finished" && r.totals.done === 5, "run finished with 5 of 5 done");
    ok(r.totals.tokens_in + r.totals.tokens_out > 0 && r.totals.est_cost_usd > 0, `counters: ${r.totals.tokens_in + r.totals.tokens_out} tokens, est $${r.totals.est_cost_usd}`);
    const g = (await db().from("run_accounts").select("result").eq("id", by["heavy.test"].id).single()).data as { result: { gates: { answer: string }[] } };
    ok(g.result.gates.some((x) => x.answer === "skipped_due_to_cap"), "capped account records SKIPPED_DUE_TO_CAP gates");

    const spec2 = { ...structuredClone(base), id: "phase2-check" };
    spec2.limits.max_accounts_per_run = 3;
    const prof2 = await saveProfileVersion(spec2);
    const two = await createRun({ profileSlug: "phase2-check", domains: ["a1.test", "a2.test", "a3.test", "a4.test", "a5.test"] });
    created.push(two.runId);
    ok(two.queued === 3 && two.capped === 2 && prof2.version === 2, `max_accounts_per_run=3: ${two.queued} queued, ${two.capped} capped`);
    const t2: Record<string, string[]> = {};
    await drain(two.runId, fakeMake(t2));
    const r2 = await getRun(two.runId);
    ok(r2.accounts.filter((a) => a.stage === "capped").length === 2 && r2.accounts.filter((a) => a.stage === "ready_for_review").length === 3, "run 2: 3 reviewed, 2 capped, none silently dropped");
    ok(Object.keys(t2).length === 3, "run 2: capped accounts were never researched");
  } finally {
    if (keep) console.log(`KEPT demo data for inspection (run ${created[0]}). Remove with: CLEAN_ONLY=1 npm run phase2-check`);
    else { for (const id of created) await deleteRun(id); await cleanLeftovers(ws); console.log("cleaned up"); }
  }
}
main().catch((e) => { console.error("FAIL ", e); process.exit(1); });
