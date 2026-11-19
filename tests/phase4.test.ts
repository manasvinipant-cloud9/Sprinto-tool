import { describe, expect, it } from "vitest";
import { profileSchema, type Profile } from "@/lib/profile-schema";
import { loadProfile } from "@/lib/profiles";
import { runDomain } from "@/lib/pipeline";
import { pickContact } from "@/lib/poc";
import { diffResults, pairByDomain, summarizePairs } from "@/lib/compare";
import { clip, purposeOf } from "@/lib/trace";
import { stepTokens } from "@/components/TraceView";
import { makeDeps, QUALIFYING, withTokens, type Scenario } from "./fakes";
import type { DomainResult } from "@/lib/types";

const sprinto = () => loadProfile("sprinto");
const withLimits = (limits: Partial<Profile["limits"]>): Profile => profileSchema.parse({ ...sprinto(), limits: { ...sprinto().limits, ...limits } });
const hungry: Scenario = { ...QUALIFYING, action: "first", fields: { company_name: "Acme", company_type: "b2b_saas", pricing_model: "recurring" } };

async function traced(p: Profile = sprinto(), s: Scenario = QUALIFYING, perCall = 700) {
  const deps = makeDeps(s);
  deps.llm = withTokens(deps.llm, perCall);
  return { r: await runDomain("acme.test", p, deps), deps };
}

describe("decision trace is complete and ordered", () => {
  it("numbers steps 1..n with no gaps, in the order they happened", async () => {
    const { r } = await traced();
    const steps = r.trace!;
    expect(steps.length).toBeGreaterThan(8);
    expect(steps.map((s) => s.seq)).toEqual(steps.map((_, i) => i + 1));
  });
  it("starts with the free homepage read, then the first fact extraction", async () => {
    const { r } = await traced();
    expect(r.trace![0]).toMatchObject({ kind: "fetch_page", status: "ok" });
    expect(r.trace![0].input).toBe("https://acme.test/");
    expect(r.trace![1]).toMatchObject({ kind: "llm", label: "extract_facts" });
  });
  it("records one model-call step per model call, and token totals equal the sum of steps", async () => {
    const { r, deps } = await traced();
    const llm = r.trace!.filter((s) => s.kind === "llm");
    expect(llm.length).toBe(deps.llm.usage.calls);
    expect(stepTokens(r.trace!)).toBe(r.tokens.prompt + r.tokens.output);
    expect(stepTokens(r.trace!)).toBeGreaterThan(0);
  });
  it("records one decision step per gate, tagged with the gate id", async () => {
    const { r } = await traced();
    const decided = r.trace!.filter((s) => s.kind === "gate" && s.label === "gate decision").map((s) => s.ctx);
    expect(decided).toEqual(r.gates.map((g) => g.id));
    for (const g of r.trace!.filter((s) => s.kind === "gate")) expect(g.output).toMatch(/^(PASS|FAIL|UNKNOWN|SKIPPED_DUE_TO_CAP)/);
  });
  it("walks the phases in pipeline order and records the contact lookup and the lint check", async () => {
    const { r } = await traced();
    const order = ["researching", "gate_evaluation", "contact_lookup", "drafting"];
    const idx = r.trace!.map((s) => order.indexOf(s.phase));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(r.trace!.some((s) => s.kind === "contact_lookup" && s.status === "ok")).toBe(true);
    expect(r.trace!.some((s) => s.kind === "draft" && s.status === "pass")).toBe(true);
  });
  it("lists every tool call the agent made, and nothing it did not", async () => {
    const { r } = await traced(withLimits({ max_loop_steps: 3 }), hungry);
    const tools = r.trace!.filter((s) => s.kind === "fetch_page" || s.kind === "search_news");
    expect(tools.length).toBe(r.tool_calls.length);
    expect(tools.map((t) => t.input)).toEqual(r.tool_calls.map((t) => t.arg));
  });
  it("model-call labels name their purpose", () => {
    expect(purposeOf("You extract facts about a company")).toBe("extract_facts");
    expect(purposeOf("You write short, specific")).toBe("write_email");
    expect(purposeOf("something else")).toBe("model_call");
  });
  it("clips very long inputs and says how much was cut", () => {
    const c = clip("x".repeat(5000), 1500);
    expect(c.length).toBeLessThan(1600);
    expect(c).toContain("3500 more characters");
    expect(clip("short")).toBe("short");
  });
});

describe("the trace explains stops and failures", () => {
  it("shows the refused model call when the token budget stops an account", async () => {
    const { r } = await traced(withLimits({ max_tokens_per_account: 60000 }), QUALIFYING, 40000);
    expect(r.status).toBe("capped");
    const refused = r.trace!.find((s) => s.status === "refused_cap");
    expect(refused).toBeTruthy();
    expect(refused!.output).toMatch(/not made/);
    expect(stepTokens(r.trace!)).toBe(r.tokens.prompt + r.tokens.output);
  });
  it("shows skipped gates after a loop-step cap", async () => {
    const { r } = await traced(withLimits({ max_loop_steps: 1 }), hungry);
    expect(r.status).toBe("capped");
    const skipped = r.trace!.filter((s) => s.kind === "gate" && s.status === "skipped_due_to_cap");
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.length).toBe(r.gates.filter((g) => g.answer === "skipped_due_to_cap").length);
  });
  it("ends on the failing gate for a disqualified account and never reaches contacts", async () => {
    const { r } = await traced(sprinto(), { ...QUALIFYING, judge: (q) => (/B2B/i.test(q) ? "fail" : "pass") });
    expect(r.status).toBe("dropped");
    const last = r.trace![r.trace!.length - 1];
    expect(last).toMatchObject({ kind: "gate", status: "fail" });
    expect(r.trace!.some((s) => s.kind === "contact_lookup")).toBe(false);
    expect(r.contact_decision).toBeNull();
  });
  it("records a failing model call as an error step and keeps token sums honest", async () => {
    const deps = makeDeps(QUALIFYING);
    const inner = withTokens(deps.llm, 500);
    deps.llm = { usage: inner.usage, json: async (o) => { if (o.system.startsWith("You judge one")) throw new Error("model exploded"); return inner.json(o); } };
    const r = await runDomain("acme.test", sprinto(), deps);
    expect(r.status).toBe("error");
    const bad = r.trace!.find((s) => s.status === "error");
    expect(bad).toMatchObject({ kind: "llm", label: "judge_gate" });
    expect(bad!.output).toContain("model exploded");
    expect(stepTokens(r.trace!)).toBe(r.tokens.prompt + r.tokens.output);
  });
});

describe("contact selection reasoning", () => {
  const raw = [
    { name: "Asha", email: "asha@x.test", title: "Head of Security", confidence: 60 },
    { name: "Ben", email: "ben@x.test", title: "CTO", confidence: 90 },
    { name: "Cy", email: "cy@x.test", title: "Head of Security Intern", confidence: 95 },
    { name: "Di", email: "di@x.test", title: "Engineering Manager", confidence: 90 },
  ];
  it("logs how each persona tier was walked", () => {
    const { contact, tierLog } = pickContact(sprinto(), raw, 100);
    expect(contact?.name).toBe("Ben");
    const t1 = tierLog.find((t) => t.tier === 1)!;
    expect(t1).toMatchObject({ applies: true, title_matches: 2, excluded: 1, below_confidence: 1, qualified: 0 });
    const t2 = tierLog.find((t) => t.tier === 2)!;
    expect(t2).toMatchObject({ applies: true, qualified: 1 });
    expect(tierLog.find((t) => t.tier === 3)).toMatchObject({ not_reached: true });
  });
  it("says why a tier was skipped when the company is too big for it", () => {
    const none = [{ name: "Z", email: "z@x.test", title: "Marketing Lead", confidence: 99 }];
    const { contact, tierLog } = pickContact(sprinto(), none, 100);
    expect(contact).toBeNull();
    const t3 = tierLog.find((t) => t.tier === 3)!;
    expect(t3.applies).toBe(false);
    expect(t3.skipped_reason).toMatch(/100 people/);
    expect(tierLog).toHaveLength(sprinto().personas.length); // every tier accounted for when nobody was chosen
  });
  it("gives every candidate a reason, including why the others lost", () => {
    const { considered } = pickContact(sprinto(), raw, 100);
    expect(considered.every((c) => c.reason.length > 5)).toBe(true);
    expect(considered.find((c) => c.name === "Asha")!.reason).toMatch(/below 70/);
    expect(considered.find((c) => c.name === "Cy")!.reason).toMatch(/excluded/);
    expect(considered.find((c) => c.name === "Ben")!.reason).toMatch(/title match/);
  });
  it("is stored on the result with the source and the bar", async () => {
    const { r } = await traced();
    expect(r.contact_decision).toMatchObject({ source: "hunter", min_confidence: sprinto().limits.hunter_min_confidence });
    expect(r.contact_decision!.tiers.length).toBe(sprinto().personas.length); // later tiers are listed as not reached
  });
});

describe("run comparison pairs rows by domain", () => {
  const acct = (domain: string, over: Partial<{ stage: string; qualification: string | null; score: number | null }> = {}) => ({ domain, position: 0, stage: "ready_for_review", qualification: "qualified", score: 50, tokens_in: 10, tokens_out: 5, ...over });
  it("pairs matching domains regardless of order", () => {
    const rows = pairByDomain([acct("a.test"), acct("b.test"), acct("c.test")], [acct("c.test"), acct("a.test"), acct("b.test")]);
    expect(rows.map((r) => r.domain)).toEqual(["a.test", "b.test", "c.test"]);
    expect(rows.every((r) => r.a && r.b && r.a.domain === r.b.domain)).toBe(true);
  });
  it("keeps domains that are only in one run, with the other side empty", () => {
    const rows = pairByDomain([acct("a.test"), acct("only-a.test")], [acct("a.test"), acct("only-b.test")]);
    expect(rows.map((r) => [r.domain, Boolean(r.a), Boolean(r.b)])).toEqual([["a.test", true, true], ["only-a.test", true, false], ["only-b.test", false, true]]);
  });
  it("ignores repeated domains rather than pairing one twice", () => {
    expect(pairByDomain([acct("a.test"), acct("a.test")], [acct("a.test")])).toHaveLength(1);
  });
  it("summarises both sides and the number of changed rows", async () => {
    const good = (await traced()).r;
    const dropped = (await traced(sprinto(), { ...QUALIFYING, judge: (q) => (/B2B/i.test(q) ? "fail" : "pass") })).r;
    const rows = [
      { ...pairByDomain([acct("x.test", { score: 80 })], [acct("x.test", { stage: "disqualified", qualification: "disqualified", score: null })])[0], diff: diffResults(good, dropped) },
      { ...pairByDomain([acct("y.test")], [acct("y.test")])[0], diff: diffResults(good, good) },
      { ...pairByDomain([acct("z.test")], [])[0], diff: null },
    ];
    const s = summarizePairs(rows);
    expect(s).toMatchObject({ domains: 3, compared: 2, changed: 1, statusChanged: 1, onlyA: 1, onlyB: 0 });
    expect(s.a.qualified).toBe(3);
    expect(s.b.disqualified).toBe(1);
  });
  it("two real profiles over the same domain give a diff that names the gate that moved", async () => {
    const payroll = loadProfile("payroll-example");
    const a = (await traced()).r;
    const b = await runDomain("acme.test", payroll, makeDeps(QUALIFYING));
    const d = diffResults(a as DomainResult, b);
    expect(d.verdict).toBe("changed");
    expect(d.gateChanges.length).toBeGreaterThan(0);
  });
  it("never treats the same gate id in two profiles as the same check unless the question matches", async () => {
    const a = (await traced()).r;
    const b = await runDomain("acme.test", loadProfile("payroll-example"), makeDeps(QUALIFYING));
    const d = diffResults(a as DomainResult, b);
    const g1 = d.gateChanges.filter((g) => g.id === "G1");
    expect(g1.length).toBe(2); // sprinto's G1 exists only in A, payroll's G1 only in B
    expect(g1.map((g) => g.question).sort()).not.toEqual([g1[0].question, g1[0].question]);
    expect(g1.some((g) => g.a === "not run") && g1.some((g) => g.b === "not run")).toBe(true);
  });
});
