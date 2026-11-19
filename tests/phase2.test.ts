import { describe, expect, it } from "vitest";
import { profileSchema, type Profile } from "@/lib/profile-schema";
import { loadProfile } from "@/lib/profiles";
import { runDomain } from "@/lib/pipeline";
import { canMoveAccount, canMoveRun, moveAccount, moveRun, qualificationFor, stageForResult, ACCOUNT_STAGES, TERMINAL } from "@/lib/state";
import { estimateCostUsd } from "@/lib/pricing";
import { domainsFromCsv, parseDomains } from "@/components/workspace";
import { makeDeps, QUALIFYING, withTokens, type Scenario } from "./fakes";
import type { Status } from "@/lib/types";

const base = (): Profile => loadProfile("sprinto");
const withLimits = (limits: Partial<Profile["limits"]>, extra: Partial<Profile> = {}): Profile => profileSchema.parse({ ...base(), ...extra, limits: { ...base().limits, ...limits } });
/** Facts that leave every gate unresolved, so the agent keeps asking for more pages. */
const hungry: Scenario = { ...QUALIFYING, action: "first", fields: { company_name: "Acme", company_type: "b2b_saas", pricing_model: "recurring" } };

describe("run state machine", () => {
  it("allows the pipeline order and nothing else", () => {
    const path = ["queued", "researching", "gate_evaluation", "contact_lookup", "drafting", "ready_for_review"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canMoveAccount(path[i], path[i + 1])).toBe(true);
    expect(() => moveAccount("queued", "ready_for_review")).toThrow(/Illegal/);
    expect(() => moveAccount("queued", "drafting")).toThrow(/Illegal/);
    expect(() => moveAccount("researching", "drafting")).toThrow(/Illegal/);
  });
  it("terminal stages are final, except error which can be retried", () => {
    for (const t of TERMINAL) for (const to of ACCOUNT_STAGES) {
      if (t === "error" && to === "queued") expect(canMoveAccount(t, to)).toBe(true);
      else if (t !== to) expect(canMoveAccount(t, to)).toBe(false);
    }
  });
  it("any working stage can end capped, disqualified or error, or be reset to queued after a crash", () => {
    for (const s of ["researching", "gate_evaluation", "contact_lookup", "drafting"] as const) {
      for (const to of ["capped", "disqualified", "error", "queued"] as const) expect(canMoveAccount(s, to)).toBe(true);
    }
    expect(canMoveAccount("queued", "capped")).toBe(true); // accounts over max_accounts_per_run
  });
  it("run statuses: pause and resume work, and a finished run can reopen for retries", () => {
    expect(moveRun("queued", "running")).toBe("running");
    expect(moveRun("running", "paused")).toBe("paused");
    expect(moveRun("paused", "running")).toBe("running");
    expect(moveRun("running", "finished")).toBe("finished");
    expect(canMoveRun("finished", "running")).toBe(true);
    expect(canMoveRun("running", "queued")).toBe(false);
    expect(() => moveRun("finished", "paused")).toThrow(/Illegal/);
  });
  it("maps every engine status to a stage and a qualification", () => {
    const table: Record<Status, [string, string | null]> = {
      drafted: ["ready_for_review", "qualified"], held: ["ready_for_review", "qualified"], qualified_no_poc: ["ready_for_review", "qualified"],
      dropped: ["disqualified", "disqualified"], capped: ["capped", "capped"], error: ["error", null],
    };
    for (const [status, [stage, qual]] of Object.entries(table)) {
      expect(stageForResult(status as Status)).toBe(stage);
      expect(qualificationFor(status as Status)).toBe(qual);
    }
  });
});

describe("caps are enforced in code", () => {
  it("max_loop_steps stops research and records the rest as SKIPPED_DUE_TO_CAP", async () => {
    const calls: string[] = [];
    const r = await runDomain("acme.test", withLimits({ max_loop_steps: 1 }), makeDeps(hungry, { calls }));
    expect(r.status).toBe("capped");
    expect(r.capped?.reason).toBe("loop_steps");
    expect(r.loops.steps).toBe(1);
    expect(calls.filter((c) => c !== "https://acme.test/")).toHaveLength(1); // one agent-chosen call beyond the homepage
    expect(r.gates.some((g) => g.answer === "skipped_due_to_cap")).toBe(true);
    expect(r.contact).toBeNull();
    expect(r.email).toBeNull();
  });
  it("the model cannot exceed the cap by asking for more", async () => {
    const calls: string[] = [];
    const r = await runDomain("acme.test", withLimits({ max_loop_steps: 2, fetch_calls: 8, news_calls: 5 }), makeDeps(hungry, { calls }));
    expect(r.loops.steps).toBeLessThanOrEqual(2);
    expect(calls.filter((c) => c !== "https://acme.test/").length).toBeLessThanOrEqual(2);
  });
  it("max_tokens_per_account stops before the next model call", async () => {
    const deps = makeDeps(QUALIFYING);
    deps.llm = withTokens(deps.llm, 40000);
    const r = await runDomain("acme.test", withLimits({ max_tokens_per_account: 60000 }), deps);
    expect(r.status).toBe("capped");
    expect(r.capped?.reason).toBe("token_budget");
    expect(r.tokens.calls).toBe(2); // the third call was refused, not made
    expect(r.contact).toBeNull();
  });
  it("a cap hit after the gates still ends capped and keeps the gate results", async () => {
    const deps = makeDeps(QUALIFYING);
    deps.llm = withTokens(deps.llm, 6000);
    const r = await runDomain("acme.test", withLimits({ max_tokens_per_account: 30000 }), deps);
    expect(r.status).toBe("capped");
    expect(r.gates.length).toBeGreaterThan(0);
    expect(r.gates.every((g) => g.answer !== "skipped_due_to_cap") || r.gates.some((g) => g.answer === "pass")).toBe(true);
  });
  it("a hard disqualifier is a drop, not a cap, even with a tiny budget", async () => {
    const p = withLimits({ max_tokens_per_account: 1000 }, { disqualifiers: [{ id: "D1", type: "region_in", regions: ["India"], on_unknown: "flag" }] });
    const scenario: Scenario = { ...QUALIFYING, fields: { ...QUALIFYING.fields, hq_region: "United States" } };
    const deps = makeDeps(scenario);
    deps.llm = withTokens(deps.llm, 500);
    const r = await runDomain("acme.test", p, deps);
    expect(r.status).toBe("dropped");
    expect(r.capped).toBeNull();
  });
  it("reports loop counters on every result and fetches equal tool calls", async () => {
    const r = await runDomain("acme.test", base(), makeDeps(QUALIFYING));
    expect(r.loops).toMatchObject({ steps: 0, max_steps: base().limits.max_loop_steps, max_tokens: base().limits.max_tokens_per_account });
    expect(r.status).toBe("drafted");
  });
  it("calls the stage hook in pipeline order", async () => {
    const seen: string[] = [];
    const deps = { ...makeDeps(QUALIFYING), onStage: (s: string) => { seen.push(s); } };
    await runDomain("acme.test", base(), deps);
    expect(seen).toEqual(["researching", "gate_evaluation", "contact_lookup", "drafting"]);
  });
});

describe("domain intake", () => {
  it("normalises, de-duplicates and rejects", () => {
    const r = parseDomains("https://www.Cal.com/pricing, cal.com\nnot a domain\nclay.com;warp.dev");
    expect(r.valid).toEqual(["cal.com", "clay.com", "warp.dev"]);
    expect(r.dupes).toBe(1);
    expect(r.invalid).toEqual(["not", "a", "domain"]);
  });
  it("reads the right CSV column", () => {
    expect(domainsFromCsv("Company,Website\nCal,https://cal.com\nClay,clay.com").split("\n")).toEqual(["https://cal.com", "clay.com"]);
    expect(domainsFromCsv("domain\ncal.com\nclay.com").split("\n")).toEqual(["cal.com", "clay.com"]);
    expect(domainsFromCsv("cal.com\nclay.com\nwarp.dev").split("\n")).toEqual(["cal.com", "clay.com", "warp.dev"]);
    expect(domainsFromCsv('"Name","URL"\n"Cal","cal.com"').split("\n")).toEqual(["cal.com"]);
    expect(domainsFromCsv("")).toBe("");
  });
});

describe("cost estimate", () => {
  it("prices each model's tokens separately and falls back for unknown models", () => {
    const a = estimateCostUsd({ prompt: 1_000_000, output: 1_000_000, by_tier: { "gemini-2.5-flash": { prompt: 1_000_000, output: 1_000_000 } } });
    expect(a).toBeCloseTo(2.8, 5);
    const b = estimateCostUsd({ prompt: 1_000_000, output: 0 });
    expect(b).toBeGreaterThan(0);
    expect(estimateCostUsd({ prompt: 0, output: 0 })).toBe(0);
  });
});
