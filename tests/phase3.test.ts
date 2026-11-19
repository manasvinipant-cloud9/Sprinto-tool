import { describe, expect, it } from "vitest";
import { loadProfile } from "@/lib/profiles";
import { runDomain } from "@/lib/pipeline";
import { csvCell, toCsv } from "@/lib/csv";
import { buildShortlistCsv, SHORTLIST_COLUMNS, type ShortlistItem } from "@/lib/export";
import { evidenceUrls, isWebUrl, matchedPersonas, rankKey, refsFor, summarizeEvidence } from "@/lib/evidence";
import { makeDeps, makeLLM, QUALIFYING, type Scenario } from "./fakes";
import type { DomainResult } from "@/lib/types";

const sprinto = () => loadProfile("sprinto");
const run = (s: Scenario = QUALIFYING, deps = makeDeps(s)) => runDomain("acme.test", sprinto(), deps);

/** A model that also says which facts each score signal relied on. */
function depsWithSignalFields(fields: string[]) {
  const deps = makeDeps(QUALIFYING);
  const base = makeLLM(QUALIFYING);
  deps.llm = { usage: base.usage, json: async (o) => {
    const out = await base.json(o);
    if (o.system.startsWith("You mark supporting signals")) {
      const parsed = out as { signals: Record<string, unknown>[] };
      return o.schema.parse({ signals: parsed.signals.map((s) => ({ ...s, fields })) });
    }
    return out;
  } };
  return deps;
}

describe("CSV safety", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,b "c"\nd')).toBe('"a,b ""c""\nd"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(42)).toBe('"42"');
  });
  it("neutralises spreadsheet formulas copied from the web", () => {
    for (const evil of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\t=1", "\r=1"]) expect(csvCell(evil).startsWith(`"'`)).toBe(true);
    expect(csvCell("-5")).toBe('"-5"'); // plain negative numbers stay numbers
    expect(csvCell("Series B, 2025")).toBe('"Series B, 2025"');
  });
  it("writes a header and CRLF-terminated rows", () => {
    expect(toCsv(["a", "b"], [[1, "x"]])).toBe('"a","b"\r\n"1","x"\r\n');
  });
});

describe("evidence on every claim", () => {
  it("returns only facts that were found, keeps stated false, and de-duplicates", () => {
    const ev = { a: { text: "t", url: "https://x/" }, b: { text: "t", url: "https://x/" }, c: { text: "t", url: "https://x/" } };
    const refs = refsFor(["a", "a", "b", "c", "missing"], { a: "yes", b: null, c: false }, ev);
    expect(refs.map((r) => r.field)).toEqual(["a", "c"]);
  });
  it("every gate that was answered carries sources, and the result stores the evidence map", async () => {
    const r = await run();
    expect(Object.keys(r.evidence).length).toBeGreaterThan(0);
    for (const g of r.gates.filter((x) => x.answer === "pass" || x.answer === "fail")) {
      expect((g.refs?.length ?? 0) > 0 || Boolean(g.source_url)).toBe(true);
      for (const ref of g.refs ?? []) { expect(ref.url).toMatch(/^https?:\/\//); expect(ref.text.length).toBeGreaterThan(0); }
    }
  });
  it("every score factor has an evidence reference or an explicit no_evidence flag", async () => {
    for (const deps of [makeDeps(QUALIFYING), depsWithSignalFields(["industry", "headcount_min"])]) {
      const r = await run(QUALIFYING, deps);
      expect(r.score_breakdown.length).toBeGreaterThan(0);
      for (const s of r.score_breakdown) expect(s.refs.length > 0 || s.no_evidence === true).toBe(true);
    }
  });
  it("links a factor to the page when the model names the facts it used", async () => {
    const r = await run(QUALIFYING, depsWithSignalFields(["industry", "headcount_min"]));
    const s1 = r.score_breakdown.find((s) => s.id === "S1")!;
    expect(s1.no_evidence).toBe(false);
    expect(s1.refs.map((x) => x.field).sort()).toEqual(["headcount_min", "industry"]);
    expect(s1.refs[0].url).toBe("https://acme.test/");
  });
  it("never invents a source: facts the model names but that do not exist are ignored and flagged", async () => {
    const r = await run(QUALIFYING, depsWithSignalFields(["made_up_field", "certifications_held"]));
    for (const s of r.score_breakdown) { expect(s.refs).toEqual([]); expect(s.no_evidence).toBe(true); }
  });
  it("pains carry the page their evidence came from", async () => {
    const r = await run();
    const p = r.pains.find((x) => !x.evidence_field.startsWith("gate:"));
    expect(p?.url).toMatch(/^https?:\/\//);
  });
  it("collects every distinct source address, and treats news searches as non-links", async () => {
    const r = await run(QUALIFYING, depsWithSignalFields(["industry"]));
    const urls = evidenceUrls(r);
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls).size).toBe(urls.length);
    expect(isWebUrl("https://acme.test/")).toBe(true);
    expect(isWebUrl("news:Acme funding round")).toBe(false);
    expect(isWebUrl(undefined)).toBe(false);
  });
});

describe("table helpers", () => {
  it("summarises why an account sits where it does", async () => {
    const good = await run();
    expect(summarizeEvidence(good).length).toBeGreaterThan(5);
    expect(summarizeEvidence(good).length).toBeLessThanOrEqual(220);
    const dropped = await run({ ...QUALIFYING, judge: (q) => (/B2B/i.test(q) ? "fail" : "pass") });
    expect(dropped.status).toBe("dropped");
    expect(summarizeEvidence(dropped)).toMatch(/^G\d/);
    const capped = { ...good, status: "capped", capped: { reason: "token_budget", detail: "x" }, gates: [{ id: "G1", question: "q", answer: "skipped_due_to_cap", evidence: "", attempts: 0 }] } as DomainResult;
    expect(summarizeEvidence(capped)).toMatch(/Stopped by a cap/);
  });
  it("lists matched persona tiers and the chosen one", async () => {
    const r = await run();
    const m = matchedPersonas(r);
    expect(m.chosen).toBe(r.contact?.tier);
    expect(m.tiers).toContain(m.chosen);
  });
  it("ranks drafted accounts above review-without-draft above the rest", () => {
    expect(rankKey("ready_for_review", true, 50)).toBeGreaterThan(rankKey("ready_for_review", false, 99));
    expect(rankKey("ready_for_review", false, 10)).toBeGreaterThan(rankKey("disqualified", false, 99));
    expect(rankKey("capped", false, null)).toBe(-1);
  });
});

describe("shortlist export", () => {
  const item = (domain: string, over: Partial<ShortlistItem>, result: DomainResult | null = null): ShortlistItem => ({ domain, position: 0, stage: "ready_for_review", qualification: "qualified", score: 50, reason: null, result, draftStatus: null, ...over });

  it("has the documented columns and ranks best first, needing no drafts", async () => {
    const r = await run();
    const csv = buildShortlistCsv([
      item("low.test", { score: 20, position: 1 }),
      item("best.test", { score: 90, position: 2 }, r),
      item("drop.test", { stage: "disqualified", qualification: "disqualified", score: null, position: 3, reason: "G1_fail" }),
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(SHORTLIST_COLUMNS.map((c) => `"${c}"`).join(","));
    expect(lines[1]).toContain("best.test");
    expect(lines[2]).toContain("low.test");
    expect(lines[3]).toContain("drop.test");
    expect(lines[1]).toContain("no_draft"); // exported with no draft at all
    expect(lines[1]).toMatch(/G1:PASS/);
    expect(lines[1]).toContain("https://acme.test/");
  });
  it("scope qualified drops everything else", () => {
    const csv = buildShortlistCsv([item("a.test", {}), item("b.test", { qualification: "capped", stage: "capped" })], "qualified");
    expect(csv).toContain("a.test");
    expect(csv).not.toContain("b.test");
  });
  it("is formula-safe even when evidence text starts with =", async () => {
    const r = await run();
    r.facts.company_name = "=cmd|' /C calc'!A0";
    const csv = buildShortlistCsv([item("evil.test", {}, r)]);
    expect(csv).toContain(`"'=cmd`);
    expect(csv).not.toMatch(/(^|,)"=/m);
  });
});
