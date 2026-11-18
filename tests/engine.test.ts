import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { profileSchema } from "@/lib/profile-schema";
import { loadProfile } from "@/lib/profiles";
import { runDomain, normalizeDomain } from "@/lib/pipeline";
import { pickContact } from "@/lib/poc";
import { lintEmail } from "@/lib/lint";
import { buildMime, sendTestEmail, recipient } from "@/lib/send";
import { robotsAllows, cleanHtml } from "@/lib/scrape";
import { parseNewsRss, Budget } from "@/lib/tools";
import { runGates, isResolved, type LoopState } from "@/lib/gates";
import { emptyFacts } from "@/lib/extract";
import { makeDeps, makeLLM, QUALIFYING, GOOD_BODY, type Scenario } from "./fakes";

const sprinto = () => loadProfile("sprinto");

describe("profile schema", () => {
  it("validates both shipped profiles", () => {
    expect(sprinto().gates.length).toBeGreaterThanOrEqual(2);
    expect(loadProfile("payroll-example").seller.name).toBe("PayLoop");
  });
  it("rejects weights that do not sum to 100", () => {
    const raw = YAML.parse(fs.readFileSync("config/profiles/sprinto.yaml", "utf8"));
    raw.signals[0].weight = 50;
    expect(profileSchema.safeParse(raw).success).toBe(false);
  });
  it("rejects an unknown page type and a gate with no required_fields", () => {
    const raw = YAML.parse(fs.readFileSync("config/profiles/sprinto.yaml", "utf8"));
    raw.gates[0].where_to_look = ["twitter"];
    expect(profileSchema.safeParse(raw).success).toBe(false);
    const raw2 = YAML.parse(fs.readFileSync("config/profiles/sprinto.yaml", "utf8"));
    raw2.gates[0].required_fields = [];
    expect(profileSchema.safeParse(raw2).success).toBe(false);
  });
});

describe("no seller words in the engine", () => {
  it("keeps the engine free of seller-specific terms", () => {
    const banned = /sprinto|soc ?2|iso ?27001|compliance/i;
    const bad: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (/\.(ts|tsx|css)$/.test(f.name) && banned.test(fs.readFileSync(p, "utf8"))) bad.push(p);
      }
    };
    ["lib", "app", "components"].forEach((d) => fs.existsSync(d) && walk(d));
    expect(bad).toEqual([]);
  });
});

function freshState(overrides: Partial<Scenario> = {}) {
  const profile = sprinto();
  const state: LoopState = {
    domain: "acme.test", profile, facts: emptyFacts(profile), evidence: {},
    budget: new Budget(profile.limits.fetch_calls, profile.limits.news_calls),
    toolCalls: [], fetched: new Set(["https://acme.test/"]), blocked: new Set(), gates: [], flags: [],
    softPass: false, outcome: null, dropReason: null,
  };
  const scenario: Scenario = { ...QUALIFYING, ...overrides };
  // The pipeline reads the homepage and extracts facts before the gates run; mirror that here.
  for (const [k, v] of Object.entries(scenario.fields)) if (v !== null) state.facts[k] = v as never;
  return { state, scenario };
}

describe("gate loop", () => {
  it("drops on an exclusion fail and makes no further tool calls", async () => {
    const { state, scenario } = freshState({ fields: { ...QUALIFYING.fields, certifications_held: "SOC 2 Type II" }, judge: (q) => (q.includes("free of") ? "fail" : "pass"), action: "first" });
    const calls: string[] = [];
    const deps = makeDeps(scenario, { calls });
    await runGates(deps, state);
    expect(state.outcome).toBe("drop");
    expect(state.dropReason).toBe("G0_fail");
    expect(calls).toEqual([]);
  });

  it("never exceeds the call caps even if the model keeps asking for more", async () => {
    const { state, scenario } = freshState({ fields: { company_name: "Acme" }, action: "first", judge: () => "unknown" });
    state.facts.certifications_held = null;
    const calls: string[] = [];
    await runGates(makeDeps(scenario, { calls }), state);
    const fetches = calls.filter((c) => !c.startsWith("news:")).length;
    const news = calls.filter((c) => c.startsWith("news:")).length;
    expect(fetches).toBeLessThanOrEqual(state.profile.limits.fetch_calls);
    expect(news).toBeLessThanOrEqual(state.profile.limits.news_calls);
    expect(fetches + news).toBeLessThanOrEqual(7);
    expect(state.outcome).toBe("drop");
    expect(state.dropReason).toBe("G1_unresolved");
  });

  it("soft-passes the stage gate on two proxies and flags it", async () => {
    const { state, scenario } = freshState({
      fields: { ...QUALIFYING.fields, funding_stage: null, funding_evidence: null, certifications_held: null },
      judge: (q) => (q.includes("Series A") ? "unknown" : "pass"),
    });
    await runGates(makeDeps(scenario), state);
    expect(state.outcome).not.toBe("drop");
    expect(state.softPass).toBe(true);
    expect(state.flags).toContain("stage_inferred");
  });

  it("drops when the stage is unknown and proxies do not hold", async () => {
    const { state, scenario } = freshState({
      fields: { ...QUALIFYING.fields, funding_stage: null, headcount_min: 10, open_roles_count: 1, has_enterprise_tier: false, enterprise_customers: [] },
      judge: (q) => (q.includes("Series A") ? "unknown" : "pass"),
    });
    await runGates(makeDeps(scenario), state);
    expect(state.outcome).toBe("drop");
    expect(state.dropReason).toBe("G2_unresolved");
  });

  it("code, not the model, decides whether a gate is resolved", () => {
    const profile = sprinto();
    const facts = emptyFacts(profile);
    expect(isResolved(profile.gates[0], facts)).toBe(false);
    facts.certifications_held = "ISO 27001";
    expect(isResolved(profile.gates[0], facts)).toBe(true);
  });
});

describe("contact selection", () => {
  const p = sprinto();
  it("prefers tier order and honours the confidence bar", () => {
    const r = pickContact(p, [
      { name: "A Sec", email: "a@x", title: "Head of Security", confidence: 65 },
      { name: "B Cto", email: "b@x", title: "CTO", confidence: 85 },
    ], 120);
    expect(r.contact?.name).toBe("B Cto");
  });
  it("returns no contact when nothing clears the bar", () => {
    expect(pickContact(p, [{ name: "C", email: "c@x", title: "CTO", confidence: 50 }], 120).contact).toBeNull();
  });
  it("allows a founder only below the headcount ceiling or when unknown", () => {
    const raw = [{ name: "F", email: "f@x", title: "Co-founder", confidence: 90 }];
    expect(pickContact(p, raw, 150).contact).toBeNull();
    expect(pickContact(p, raw, 40).contact?.name).toBe("F");
    expect(pickContact(p, raw, null).contact?.name).toBe("F");
  });
  it("matches Director of Engineering and excludes engineering managers", () => {
    expect(pickContact(p, [{ name: "K", email: "k@x", title: "Director of Engineering", confidence: 85 }], 100).contact?.name).toBe("K");
    expect(pickContact(p, [{ name: "M", email: "m@x", title: "Engineering Manager, Head of Engineering Ops", confidence: 90 }], 100).contact).toBeNull();
  });
});

describe("email lint", () => {
  const p = sprinto();
  const ctx = { firstName: "Priya", flagged: false, hookEvidence: "an open Security Engineer role posted this month" };
  it("accepts a good email", () => {
    expect(lintEmail({ subject: "Security hiring and audits", body: GOOD_BODY }, p, ctx)).toEqual([]);
  });
  it("rejects banned words, links, wrong name and bad length", () => {
    const errs = lintEmail({ subject: "Quick question about everything today please now", body: "Hello Bob, we leverage a seamless tool: https://x.com" }, p, ctx);
    expect(errs.join(" | ")).toMatch(/banned phrase/);
    expect(errs.join(" | ")).toMatch(/link/);
    expect(errs.join(" | ")).toMatch(/first name/);
    expect(errs.join(" | ")).toMatch(/words/);
  });
  it("requires a question hook on flagged leads", () => {
    const errs = lintEmail({ subject: "Security hiring and audits", body: GOOD_BODY.replace("?", ".") }, p, { ...ctx, flagged: true });
    expect(errs.join(" | ")).toMatch(/question/);
  });
  it("rejects invented statistics", () => {
    const body = GOOD_BODY.replace("every quarter", "and cut audit time by 70% every quarter");
    expect(lintEmail({ subject: "Security hiring and audits", body }, p, ctx).join(" | ")).toMatch(/statistic/);
  });
});

describe("send safety", () => {
  beforeEach(() => { process.env.SEND_TO = "me@example.test"; });
  it("always addresses the configured recipient and accepts no recipient argument", () => {
    expect(recipient()).toBe("me@example.test");
    expect(buildMime.length).toBe(2);
    expect(sendTestEmail.length).toBe(2);
    expect(buildMime("Subject é", "Body").startsWith("To: me@example.test\r\n")).toBe(true);
  });
});

describe("scraping helpers", () => {
  it("applies robots.txt rules", () => {
    const txt = "User-agent: *\nDisallow: /private\nAllow: /private/open\n";
    expect(robotsAllows(txt, "/private/x")).toBe(false);
    expect(robotsAllows(txt, "/private/open")).toBe(true);
    expect(robotsAllows(txt, "/pricing")).toBe(true);
    expect(robotsAllows("User-agent: *\nDisallow: /\n", "/careers")).toBe(false);
  });
  it("cleans navigation, footers, cookie banners and duplicates", () => {
    const html = `<html><head><title>Acme</title></head><body><nav>Home Pricing Login Docs</nav>
      <div class="cookie-banner">We use cookies to improve your experience on this website today</div>
      <h1>Acme builds payment software for banks and fintech teams worldwide</h1>
      <p>Acme builds payment software for banks and fintech teams worldwide</p>
      <p>Enterprise</p><p>Short</p><footer>Copyright Acme all rights reserved forever and ever</footer></body></html>`;
    const t = cleanHtml(html);
    expect(t).toContain("payment software");
    expect(t.match(/payment software/g)?.length).toBe(1);
    expect(t).toContain("Enterprise");
    expect(t).not.toMatch(/cookies|Copyright|Login/);
    expect(t).not.toContain("Short");
  });
  it("parses Google News RSS", () => {
    const xml = `<rss><channel><item><title>Acme raises $20M Series B</title><pubDate>Mon, 03 Nov 2025</pubDate><source>TechCrunch</source><description>&lt;a&gt;Acme raised a Series B&lt;/a&gt;</description></item></channel></rss>`;
    const r = parseNewsRss(xml);
    expect(r.status).toBe("ok");
    expect(r.results[0].source).toBe("TechCrunch");
    expect(r.results[0].snippet).toContain("Series B");
  });
});

describe("pipeline", () => {
  beforeEach(() => { process.env.SEND_TO = "me@example.test"; });

  it("normalises domains", () => {
    expect(normalizeDomain("https://www.Cal.com/pricing")).toBe("cal.com");
    expect(normalizeDomain("not a domain")).toBeNull();
  });

  it("runs end to end and sends one test email with a review block", async () => {
    const sent: { subject: string; body: string }[] = [];
    const r = await runDomain("acme.test", sprinto(), { send: true }, makeDeps(QUALIFYING, { sent }));
    expect(r.status).toBe("sent");
    expect(r.contact?.name).toBe("Priya Rao");
    expect(r.score).toBeGreaterThan(0);
    expect(r.pains).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("[TEST for Priya Rao, CTO, Acme]");
    expect(sent[0].body).toContain("Would go to: priya@acme.test");
    expect(r.profile.id).toBe("sprinto");
    expect(r.profile.hash).toHaveLength(12);
  });

  it("drafts without sending when sending is off", async () => {
    const sent: { subject: string; body: string }[] = [];
    const r = await runDomain("acme.test", sprinto(), { send: false }, makeDeps(QUALIFYING, { sent }));
    expect(r.status).toBe("drafted");
    expect(sent).toHaveLength(0);
  });

  it("reports qualified_no_poc instead of guessing a contact", async () => {
    const r = await runDomain("acme.test", sprinto(), { send: true }, makeDeps({ ...QUALIFYING, contacts: [{ name: "X", email: "x@a", title: "CTO", confidence: 40 }] }));
    expect(r.status).toBe("qualified_no_poc");
  });

  it("uses a manual override before Hunter", async () => {
    const r = await runDomain("acme.test", sprinto(), { send: false }, makeDeps({ ...QUALIFYING, contacts: [], overrides: { "acme.test": { name: "Priya Rao", email: "p@acme.test", title: "CTO" } } }));
    expect(r.status).toBe("drafted");
  });

  it("aborts the run on a permanent Hunter failure", async () => {
    const r = await runDomain("acme.test", sprinto(), { send: true }, makeDeps({ ...QUALIFYING, hunterError: { message: "hunter_quota", permanent: true } }));
    expect(r.status).toBe("error");
    expect(r.reason.startsWith("abort:")).toBe(true);
  });

  it("degrades gracefully when the homepage is blocked", async () => {
    const r = await runDomain("acme.test", sprinto(), { send: true }, makeDeps(QUALIFYING, { page: { status: "blocked", text: "", words: 0 } }));
    expect(r.status).toBe("error");
    expect(r.reason).toContain("homepage_blocked");
  });

  it("holds a draft that fails lint", async () => {
    const deps = makeDeps(QUALIFYING);
    const bad = makeLLM(QUALIFYING);
    deps.llm = { usage: bad.usage, json: async (o) => (o.system.startsWith("You write short") ? o.schema.parse({ subject: "Hi", body: "Too short" }) : bad.json(o)) };
    const r = await runDomain("acme.test", sprinto(), { send: true }, deps);
    expect(r.status).toBe("held");
  });

  it("works with a second, non-security profile and no code change", async () => {
    const payroll = loadProfile("payroll-example");
    const scenario: Scenario = {
      ...QUALIFYING,
      fields: { company_name: "Zeta", company_type: "b2b_saas", headcount_min: 40, headcount_max: 60, india_presence: true, hiring_surge: true, open_roles_count: 12 },
      contacts: [{ name: "Anita Rao", email: "anita@zeta.test", title: "Head of People", confidence: 90 }],
    };
    const deps = makeDeps(scenario);
    const base = makeLLM(scenario);
    deps.llm = {
      usage: base.usage,
      json: async (o) => {
        if (o.system.startsWith("You write short")) return o.schema.parse({ subject: "Payroll as you hire", body: GOOD_BODY.replace("Priya", "Anita").replace("Sprinto automates evidence collection and audit readiness for SaaS teams", "PayLoop runs payroll and statutory filings for Indian startups").replace("Growth Lead, Sprinto", "Growth Lead, PayLoop") });
        if (o.system.startsWith("You identify the two")) return o.schema.parse({ pains: [
          { pain: "Monthly payroll takes days", why_this_person: "owns people ops", evidence_field: "hiring_surge", evidence_text: "an open Security Engineer role posted this month" },
          { pain: "Filing deadlines", why_this_person: "statutory risk", evidence_field: "open_roles_count", evidence_text: "twelve open roles on the careers page" },
        ] });
        return base.json(o);
      },
    };
    const r = await runDomain("zeta.test", payroll, { send: false }, deps);
    expect(r.status).toBe("drafted");
    expect(r.contact?.tier).toBe(1);
  });
});
