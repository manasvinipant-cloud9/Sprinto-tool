import { describe, expect, it } from "vitest";
import fs from "node:fs";
import YAML from "yaml";
import { profileSchema, type Disqualifier, type Profile } from "@/lib/profile-schema";
import { checkYaml } from "@/lib/profile-yaml";
import { loadProfile } from "@/lib/profiles";
import { checkDisqualifiers, judgeDisqualifier } from "@/lib/disqualifiers";
import { runDomain } from "@/lib/pipeline";
import { pickContact } from "@/lib/poc";
import { diffResults } from "@/lib/compare";
import { blankProfile } from "@/components/ProfileEditor";
import { makeDeps, QUALIFYING, type Scenario } from "./fakes";
import type { DomainResult } from "@/lib/types";

const base = (): Profile => loadProfile("sprinto");
const withDq = (dq: unknown[], extra: Partial<Profile> = {}): Profile => profileSchema.parse({ ...base(), disqualifiers: dq, ...extra });

describe("profile schema v2 and YAML validation", () => {
  it("loads v1 profiles unchanged and fills the new fields with safe defaults", () => {
    const raw = YAML.parse(fs.readFileSync("config/profiles/sprinto.yaml", "utf8"));
    expect(raw.disqualifiers).toBeUndefined();
    expect(raw.limits.max_accounts_per_run).toBeUndefined();
    const p = profileSchema.parse(raw);
    expect(p.disqualifiers).toEqual([]);
    expect(p.limits).toMatchObject({ max_accounts_per_run: 25, max_contacts_per_account: 10, max_loop_steps: 12, max_tokens_per_account: 60000 });
  });
  it("reports YAML syntax errors with a line number", () => {
    const r = checkYaml("id: x\nseller: [unclosed\n");
    expect(r.spec).toBeNull();
    expect(r.problems[0].where).toMatch(/line \d+/);
  });
  it("reports schema errors with the path and line", () => {
    const text = YAML.stringify({ ...base(), signals: base().signals.map((s, i) => (i === 0 ? { ...s, weight: 5 } : s)) });
    const r = checkYaml(text);
    expect(r.spec).toBeNull();
    expect(r.problems.some((p) => /weights must sum to 100/.test(p.message))).toBe(true);
  });
  it("rejects bad disqualifiers: duplicate id, min above max, empty size rule, too few checks", () => {
    expect(profileSchema.safeParse({ ...base(), disqualifiers: [{ id: "D1", type: "region_in", regions: ["India"] }, { id: "D1", type: "region_in", regions: ["US"] }] }).success).toBe(false);
    expect(profileSchema.safeParse({ ...base(), disqualifiers: [{ id: "D1", type: "headcount_between", min: 500, max: 20 }] }).success).toBe(false);
    expect(profileSchema.safeParse({ ...base(), disqualifiers: [{ id: "D1", type: "headcount_between" }] }).success).toBe(false);
    expect(profileSchema.safeParse({ ...base(), gates: [], disqualifiers: [{ id: "D1", type: "region_in", regions: ["India"] }] }).success).toBe(false);
  });
  it("round trips form -> YAML -> form without loss, for every shipped profile and a blank one", () => {
    const specs = [base(), loadProfile("payroll-example"), blankProfile(), withDq([{ id: "D1", type: "industry_not_in", industries: ["gambling"], on_unknown: "drop" }])];
    for (const spec of specs) {
      const back = checkYaml(YAML.stringify(spec));
      expect(back.problems).toEqual([]);
      expect(back.spec).toEqual(spec);
    }
  });
});

describe("hard disqualifiers (code decides, not the model)", () => {
  it("judges region, size and industry from facts", () => {
    const region: Disqualifier = { id: "D1", type: "region_in", regions: ["India", "Singapore"], on_unknown: "flag" };
    expect(judgeDisqualifier(region, { hq_region: "Bengaluru, India" }).answer).toBe("pass");
    expect(judgeDisqualifier(region, { hq_region: "Germany" }).answer).toBe("fail");
    expect(judgeDisqualifier(region, { hq_region: null }).answer).toBe("unknown");
    const size: Disqualifier = { id: "D2", type: "headcount_between", min: 50, max: 200, on_unknown: "flag" };
    expect(judgeDisqualifier(size, { headcount_min: 80, headcount_max: 120 }).answer).toBe("pass");
    expect(judgeDisqualifier(size, { headcount_min: 500, headcount_max: 900 }).answer).toBe("fail");
    expect(judgeDisqualifier(size, { headcount_min: 150, headcount_max: 400 }).answer).toBe("pass"); // overlaps the band
    const ind: Disqualifier = { id: "D3", type: "industry_not_in", industries: ["gambling", "crypto"], on_unknown: "flag" };
    expect(judgeDisqualifier(ind, { industry: "online Gambling" }).answer).toBe("fail");
    expect(judgeDisqualifier(ind, { industry: "fintech" }).answer).toBe("pass");
  });
  it("applies each rule's unknown policy only on the final pass", () => {
    const p = withDq([{ id: "D1", type: "region_in", regions: ["India"], on_unknown: "drop" }, { id: "D2", type: "industry_not_in", industries: ["x"], on_unknown: "flag" }, { id: "D3", type: "headcount_between", min: 1, on_unknown: "ignore" }]);
    const early = checkDisqualifiers(p, {}, {}, false);
    expect(early.failed).toBeNull();
    const final = checkDisqualifiers(p, {}, {}, true);
    expect(final.failed?.id).toBe("D1");
    expect(final.flags).toEqual(["d2_unverified"]);
    expect(final.results.find((r) => r.id === "D3")?.policy_applied).toBe("ignored");
  });
  it("a hard fail drops the account before any gate or tool call runs", async () => {
    const calls: string[] = [];
    const p = withDq([{ id: "D1", type: "region_in", regions: ["India"], on_unknown: "flag" }]);
    const scenario: Scenario = { ...QUALIFYING, fields: { ...QUALIFYING.fields, hq_region: "United States" }, action: "first" };
    const r = await runDomain("acme.test", p, makeDeps(scenario, { calls }));
    expect(r.status).toBe("dropped");
    expect(r.reason).toContain("D1_fail");
    expect(r.gates.map((g) => g.id)).toEqual(["D1"]);
    expect(calls).toEqual(["https://acme.test/"]); // homepage only, nothing else fetched
    expect(r.contact).toBeNull();
  });
  it("an unresolved rule with policy drop removes the lead after the gates; flag keeps it and marks the draft", async () => {
    const drop = await runDomain("acme.test", withDq([{ id: "D1", type: "region_in", regions: ["India"], on_unknown: "drop" }]), makeDeps(QUALIFYING));
    expect(drop.status).toBe("dropped");
    expect(drop.reason).toContain("D1_unresolved");
    const flag = await runDomain("acme.test", withDq([{ id: "D1", type: "region_in", regions: ["India"], on_unknown: "flag" }]), makeDeps(QUALIFYING));
    expect(flag.status).toBe("drafted");
    expect(flag.flags).toContain("d1_unverified");
    expect(flag.outcome).toBe("qualify_and_flag");
  });
});

describe("execution caps in the profile", () => {
  it("max_contacts_per_account limits the candidates considered", () => {
    const p = withDq([], { limits: { ...base().limits, max_contacts_per_account: 2 } });
    const raw = ["a", "b", "c", "d"].map((n) => ({ name: n, email: `${n}@x.test`, title: "Intern", confidence: 90 }));
    expect(pickContact(p, raw, null).considered).toHaveLength(2);
  });
  it("rejects caps outside their allowed ranges", () => {
    for (const bad of [{ max_accounts_per_run: 0 }, { max_accounts_per_run: 101 }, { max_loop_steps: 41 }, { max_tokens_per_account: 10 }, { max_contacts_per_account: 21 }]) {
      expect(profileSchema.safeParse({ ...base(), limits: { ...base().limits, ...bad } }).success).toBe(false);
    }
  });
});

describe("compare", () => {
  const run = async (profile: Profile, s: Scenario = QUALIFYING): Promise<DomainResult> => runDomain("acme.test", profile, makeDeps(s));
  it("reports no difference for the same profile", async () => {
    const a = await run(base());
    expect(diffResults(a, await run(base())).verdict).toBe("same");
  });
  it("shows a status, gate and flag change when a disqualifier is added", async () => {
    const a = await run(base());
    const b = await run(withDq([{ id: "D1", type: "industry_not_in", industries: ["fintech"], on_unknown: "drop" }]));
    const d = diffResults(a, b);
    expect(d.verdict).toBe("changed");
    expect(d.statusChanged).toBe(true);
    expect(d.a.status).toBe("drafted");
    expect(d.b.status).toBe("dropped");
    expect(d.gateChanges.some((g) => g.id === "D1" && g.a === "not run")).toBe(true);
  });
  it("shows a score delta when weights change", async () => {
    const heavy = withDq([], { signals: base().signals.map((s) => (s.id === "S1" ? { ...s, weight: 40 } : s.id === "S2" ? { ...s, weight: 27 } : s)) });
    const d = diffResults(await run(base()), await run(heavy));
    expect(d.scoreDelta).not.toBeNull();
  });
});
