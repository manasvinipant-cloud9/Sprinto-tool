import YAML from "yaml";
import { db, must, serviceDb } from "../db";
import { currentCtx, currentWorkspaceId } from "../ctx";
import { audit } from "../audit";
import { safeError } from "../scrub";
import { resolveKeys, type ResolvedKeys } from "./workspace";
import { overridesMap } from "./overrides";
import { maskEmail, maskResult } from "../mask";
import { createLLM, normalizeDomain, realDeps, runDomain, type Deps, type Stage } from "../pipeline";
import { estimateCostUsd } from "../pricing";
import type { Profile } from "../profile-schema";
import { profileHash } from "../profile-hash";
import { IN_FLIGHT, moveAccount, moveRun, qualificationFor, stageForResult, type AccountStage, type RunStatus } from "../state";
import type { DomainResult } from "../types";
import { dbPageCache } from "./pagecache";
import { buildShortlistCsv } from "../export";
import { reviewTags } from "../review";
import { diffResults, pairByDomain, summarizePairs, type CompareSummary, type ResultDiff } from "../compare";
import type { TraceStep } from "../trace";
import { evidenceUrls, matchedPersonas, summarizeEvidence } from "../evidence";
import { resolveProfileRow } from "./profiles";

const STALE_MS = 7 * 60 * 1000; // longer than the function limit, so a live account is never reclaimed

export interface AccountBrief {
  id: string; domain: string; position: number; stage: AccountStage; qualification: "qualified" | "disqualified" | "capped" | null;
  score: number | null; reason: string | null; loop_steps: number; fetches: number; searches: number; tokens_in: number; tokens_out: number; est_cost_usd: number;
  started_at: string | null; finished_at: string | null;
  brief: { status: string; flags: string[]; outcome: string | null; ms: number; company: string | null; contact: { name: string; title: string; email: string; tier: number | null; confidence: number } | null; capped: { reason: string; detail: string } | null; personas: { tiers: number[]; chosen: number | null }; evidence_summary: string; evidence_urls: number } | null;
  draft: { id: string; review_status: string } | null;
}
export interface RunTotals { accounts: number; done: number; capped: number; loop_steps: number; fetches: number; searches: number; tokens_in: number; tokens_out: number; est_cost_usd: number }
export interface RunDetail {
  id: string; status: RunStatus; note: string | null; created_at: string; started_at: string | null; finished_at: string | null; comparison_group: string | null;
  profile: { slug: string; version: number; name: string; hash: string };
  caps: Profile["limits"]; totals: RunTotals; accounts: AccountBrief[];
}

type RunRow = { comparison_group?: string | null; id: string; status: RunStatus; note: string | null; caps: Profile["limits"]; profile_id: string; profile_hash: string; created_at: string; started_at: string | null; finished_at: string | null; profiles?: { slug: string; version: number; name: string; spec?: unknown } };

const sum = (rows: Record<string, unknown>[], k: string) => rows.reduce((a, r) => a + Number(r[k] ?? 0), 0);

// ---------- creating a run ----------

export async function createRun(opts: { profileSlug: string; profileDbId?: string; domains: string[]; comparisonGroup?: string; maxAccounts?: number }): Promise<{ runId: string; queued: number; capped: number; cap: number }> {
  const ws = currentWorkspaceId();
  const prof = await resolveProfileRow(opts.profileSlug, opts.profileDbId);
  const domains = [...new Set(opts.domains.map((d) => normalizeDomain(d)).filter((d): d is string => Boolean(d)))];
  if (domains.length === 0) throw new Error("No valid domains.");
  const cap = Math.min(prof.spec.limits.max_accounts_per_run, opts.maxAccounts ?? Infinity);
  const run = must(await db().from("runs").insert({ workspace_id: ws, profile_id: prof.dbId, profile_hash: prof.hash, comparison_group: opts.comparisonGroup ?? null, status: "queued", caps: prof.spec.limits, created_by: currentCtx().userId, accounts_capped: Math.max(0, domains.length - cap) }).select("id").single(), "create run");
  const now = new Date().toISOString();
  const rows = domains.map((domain, i) => i < cap
    ? { run_id: run.id, workspace_id: ws, domain, position: i, stage: "queued" }
    : { run_id: run.id, workspace_id: ws, domain, position: i, stage: "capped", qualification: "capped", reason: `cap:max_accounts_per_run (limit ${cap})`, finished_at: now });
  must(await db().from("run_accounts").insert(rows).select("id"), "create accounts");
  await audit("run.created", { type: "run", id: run.id }, { profile: opts.profileSlug, accounts: domains.length, queued: Math.min(cap, domains.length), capped: Math.max(0, domains.length - cap), comparison: Boolean(opts.comparisonGroup) });
  return { runId: run.id, queued: Math.min(cap, domains.length), capped: Math.max(0, domains.length - cap), cap };
}

// ---------- reading ----------

function toBrief(r: Record<string, unknown>): AccountBrief {
  const res = r.result as DomainResult | null;
  const drafts = (r.drafts as { id: string; review_status: string; is_current: boolean }[] | null) ?? [];
  const cur = drafts.find((d) => d.is_current) ?? null;
  return {
    id: r.id as string, domain: r.domain as string, position: r.position as number, stage: r.stage as AccountStage, qualification: (r.qualification as AccountBrief["qualification"]) ?? null,
    score: (r.score as number | null) ?? null, reason: (r.reason as string | null) ?? null, loop_steps: Number(r.loop_steps), fetches: Number(r.fetches), searches: Number(r.searches),
    tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out), est_cost_usd: Number(r.est_cost_usd), started_at: (r.started_at as string | null) ?? null, finished_at: (r.finished_at as string | null) ?? null,
    brief: res ? { status: res.status, flags: res.flags, outcome: res.outcome, ms: res.ms, company: (res.facts.company_name as string | null) ?? null, contact: res.contact ? { name: res.contact.name, title: res.contact.title, email: res.contact.email, tier: res.contact.tier, confidence: res.contact.confidence } : null, capped: res.capped, personas: matchedPersonas(res), evidence_summary: summarizeEvidence(res), evidence_urls: evidenceUrls(res).length } : null,
    draft: cur ? { id: cur.id, review_status: cur.review_status } : null,
  };
}

export async function getRun(runId: string): Promise<RunDetail> {
  const run = must<RunRow>(await db().from("runs").select("id, status, note, caps, profile_id, profile_hash, comparison_group, created_at, started_at, finished_at, profiles(slug, version, name)").eq("id", runId).eq("workspace_id", currentWorkspaceId()).single(), "load run");
  const accts = must<Record<string, unknown>[]>(await db().from("run_accounts")
    .select("id, domain, position, stage, qualification, score, reason, loop_steps, fetches, searches, tokens_in, tokens_out, est_cost_usd, started_at, finished_at, result, drafts(id, review_status, is_current)")
    .eq("run_id", runId).eq("workspace_id", currentWorkspaceId()).order("position"), "load accounts");
  const accounts = accts.map(toBrief);
  if (currentCtx().demo) for (const a of accounts) if (a.brief?.contact) a.brief.contact = { ...a.brief.contact, email: maskEmail(a.brief.contact.email) };
  const done = accounts.filter((a) => !["queued", ...IN_FLIGHT].includes(a.stage)).length;
  return {
    id: run.id, status: run.status, note: run.note, created_at: run.created_at, started_at: run.started_at, finished_at: run.finished_at, comparison_group: run.comparison_group ?? null,
    profile: { slug: run.profiles!.slug, version: run.profiles!.version, name: run.profiles!.name, hash: run.profile_hash }, caps: run.caps,
    totals: { accounts: accounts.length, done, capped: accounts.filter((a) => a.stage === "capped").length, loop_steps: sum(accts, "loop_steps"), fetches: sum(accts, "fetches"), searches: sum(accts, "searches"), tokens_in: sum(accts, "tokens_in"), tokens_out: sum(accts, "tokens_out"), est_cost_usd: sum(accts, "est_cost_usd") },
    accounts,
  };
}

export async function listRuns(limit = 20) {
  const runs = must<RunRow[]>(await db().from("runs").select("id, status, note, caps, profile_id, profile_hash, comparison_group, created_at, started_at, finished_at, profiles(slug, version, name)").eq("workspace_id", currentWorkspaceId()).order("created_at", { ascending: false }).limit(limit), "list runs");
  if (runs.length === 0) return [];
  const accts = must<{ run_id: string; stage: string }[]>(await db().from("run_accounts").select("run_id, stage").eq("workspace_id", currentWorkspaceId()).in("run_id", runs.map((r) => r.id)), "count accounts");
  return runs.map((r) => {
    const mine = accts.filter((a) => a.run_id === r.id);
    return { id: r.id, status: r.status, comparison_group: r.comparison_group ?? null, created_at: r.created_at, profile: r.profiles ? `${r.profiles.name} v${r.profiles.version}` : "", accounts: mine.length, ready: mine.filter((a) => a.stage === "ready_for_review").length, disqualified: mine.filter((a) => a.stage === "disqualified").length, capped: mine.filter((a) => a.stage === "capped").length, errors: mine.filter((a) => a.stage === "error").length };
  });
}

/** Replaces an account's recorded steps (a retried account starts a fresh trace). */
export async function saveTrace(accountId: string, workspaceId: string, steps: TraceStep[]): Promise<void> {
  await db().from("trace_steps").delete().eq("account_id", accountId);
  if (steps.length === 0) return;
  must(await db().from("trace_steps").insert(steps.map((t) => ({
    account_id: accountId, workspace_id: workspaceId, seq: t.seq, kind: t.kind, label: t.label, phase: t.phase, ctx: t.ctx ?? null,
    input: { text: t.input }, output: { text: t.output }, status: t.status, ms: t.ms, tokens_in: t.tokens_in, tokens_out: t.tokens_out,
  }))).select("id"), "save trace");
}

export async function getTrace(accountId: string): Promise<TraceStep[]> {
  const rows = must<Record<string, unknown>[]>(await db().from("trace_steps").select("seq, kind, label, phase, ctx, input, output, status, ms, tokens_in, tokens_out").eq("account_id", accountId).eq("workspace_id", currentWorkspaceId()).order("seq"), "load trace");
  return rows.map((r) => ({
    seq: Number(r.seq), kind: r.kind as TraceStep["kind"], label: (r.label as string) ?? "", phase: (r.phase as string) ?? "", ctx: (r.ctx as string | null) ?? undefined,
    input: ((r.input as { text?: string } | null)?.text) ?? "", output: ((r.output as { text?: string } | null)?.text) ?? "", status: (r.status as string) ?? "",
    ms: Number(r.ms ?? 0), tokens_in: Number(r.tokens_in ?? 0), tokens_out: Number(r.tokens_out ?? 0),
  }));
}

/** The stored result with its decision trace attached. */
export async function getAccountResult(accountId: string): Promise<DomainResult | null> {
  const row = must<{ result: DomainResult | null }>(await db().from("run_accounts").select("result").eq("id", accountId).eq("workspace_id", currentWorkspaceId()).single(), "load account");
  if (!row.result) return null;
  const full = { ...row.result, trace: await getTrace(accountId) };
  return currentCtx().demo ? maskResult(full) : full;
}

// ---------- executing ----------

async function recomputeTotals(runId: string) {
  const rows = must<Record<string, unknown>[]>(await db().from("run_accounts").select("tokens_in, tokens_out, loop_steps, fetches, searches, est_cost_usd").eq("run_id", runId), "totals");
  must(await db().from("runs").update({ tokens_in: sum(rows, "tokens_in"), tokens_out: sum(rows, "tokens_out"), loop_steps: sum(rows, "loop_steps"), fetches: sum(rows, "fetches"), searches: sum(rows, "searches"), est_cost_usd: Number(sum(rows, "est_cost_usd").toFixed(4)) }).eq("id", runId).select("id"), "update totals");
}

/** Accounts stuck in a working stage past the function limit (a crashed tick) go back to the queue. */
export async function resetStale(runId: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const stuck = must<{ id: string; stage: AccountStage }[]>(await db().from("run_accounts").select("id, stage").eq("run_id", runId).in("stage", IN_FLIGHT).lt("started_at", cutoff), "find stale");
  for (const s of stuck) {
    moveAccount(s.stage, "queued");
    await db().from("run_accounts").update({ stage: "queued", started_at: null }).eq("id", s.id).eq("stage", s.stage);
  }
  return stuck.length;
}

export type TickState = "processed" | "idle" | "paused" | "finished" | "busy";
export interface TickResult { state: TickState; domain?: string; stage?: AccountStage; note?: string }
export type MakeDeps = (profile: Profile, onStage: (s: Stage) => Promise<void>, workspaceId: string, domain: string, keys: ResolvedKeys) => Deps;

const defaultDeps: MakeDeps = (_profile, onStage, ws, _domain, keys) => ({ ...realDeps(createLLM(keys.llm), dbPageCache(ws), { hunterKey: keys.hunter }), onStage });
/** Real runs read this workspace's hand-picked contacts. Tests and checks supply their own. */
const withWorkspaceOverrides = async (make: MakeDeps, map: Awaited<ReturnType<typeof overridesMap>>): Promise<MakeDeps> => (make === defaultDeps ? (p, o, w, d, k) => ({ ...make(p, o, w, d, k), overrides: () => map }) : make);

async function setRunStatus(run: { id: string; status: RunStatus }, to: RunStatus, extra: Record<string, unknown> = {}) {
  if (run.status === to) return;
  moveRun(run.status, to);
  must(await db().from("runs").update({ status: to, ...extra }).eq("id", run.id).select("id"), "update run");
  run.status = to;
}

/** Processes exactly one queued account. Safe to call from several clients: a claim only succeeds for one of them. */
export async function tickRun(runId: string, makeDeps: MakeDeps = defaultDeps): Promise<TickResult> {
  const ws = currentWorkspaceId();
  const run = must<RunRow>(await db().from("runs").select("id, status, note, caps, profile_id, profile_hash, created_at, started_at, finished_at, profiles(slug, version, name, spec)").eq("id", runId).eq("workspace_id", ws).single(), "load run");
  if (run.status === "paused") return { state: "paused" };
  if (run.status === "finished") return { state: "finished" };
  await resetStale(runId);
  if (run.status === "queued" || run.status === "failed") await setRunStatus(run, "running", { started_at: run.started_at ?? new Date().toISOString(), finished_at: null });

  let claimed: { id: string; domain: string; attempts: number } | null = null;
  for (let i = 0; i < 3 && !claimed; i++) {
    const next = await db().from("run_accounts").select("id, domain, attempts").eq("run_id", runId).eq("stage", "queued").order("position").limit(1);
    const cand = (next.data?.[0] as { id: string; domain: string; attempts: number } | undefined);
    if (!cand) break;
    const got = await db().from("run_accounts").update({ stage: "researching", started_at: new Date().toISOString(), attempts: cand.attempts + 1 }).eq("id", cand.id).eq("stage", "queued").select("id");
    if (got.data?.length) claimed = cand;
  }
  if (!claimed) {
    const live = await db().from("run_accounts").select("id").eq("run_id", runId).in("stage", IN_FLIGHT).limit(1);
    if (live.data?.length) return { state: "busy" };
    await recomputeTotals(runId);
    await setRunStatus(run, "finished", { finished_at: new Date().toISOString() });
    return { state: "finished" };
  }

  const profile = (await resolveProfileById(run.profile_id));
  const keys = await resolveKeys(ws);
  const makeWithOverrides = await withWorkspaceOverrides(makeDeps, makeDeps === defaultDeps ? await overridesMap() : {});
  let current: AccountStage = "researching";
  const onStage = async (s: Stage) => {
    if (s === current) return;
    moveAccount(current, s);
    current = s;
    await db().from("run_accounts").update({ stage: s }).eq("id", claimed!.id);
  };
  try {
    const result = await runDomain(claimed.domain, profile, makeWithOverrides(profile, onStage, ws, claimed.domain, keys));
    const final = stageForResult(result.status);
    moveAccount(current, final);
    must(await db().from("run_accounts").update({
      stage: final, qualification: qualificationFor(result.status), score: result.score, result: { ...result, trace: undefined }, reason: result.reason,
      loop_steps: result.loops.steps, fetches: result.loops.fetches, searches: result.loops.searches,
      tokens_in: result.tokens.prompt, tokens_out: result.tokens.output, est_cost_usd: Number(estimateCostUsd(result.tokens).toFixed(5)), finished_at: new Date().toISOString(),
    }).eq("id", claimed.id).select("id"), "save account");
    if (result.email) {
      must(await db().from("drafts").insert({ account_id: claimed.id, workspace_id: ws, subject: result.email.subject, body: result.email.body, generated_subject: result.email.subject, generated_body: result.email.body, tags: reviewTags(result), lint: result.email.lint, tokens_in: 0, tokens_out: 0 }).select("id"), "save draft");
    }
    await saveTrace(claimed.id, ws, result.trace ?? []);
    await recomputeTotals(runId);
    if (result.reason.startsWith("abort:")) {
      await setRunStatus(run, "paused", { note: `Paused: ${result.reason.slice(6)}. Fix the key or quota, then resume.` });
      return { state: "processed", domain: claimed.domain, stage: final, note: run.note ?? undefined };
    }
    return { state: "processed", domain: claimed.domain, stage: final };
  } catch (e) {
    await db().from("run_accounts").update({ stage: "error", reason: `error:${safeError(e)}`, finished_at: new Date().toISOString() }).eq("id", claimed.id);
    await recomputeTotals(runId);
    throw e;
  }
}

async function resolveProfileById(profileId: string): Promise<Profile> {
  const { profileSchema } = await import("../profile-schema");
  const row = must<{ spec: unknown }>(await db().from("profiles").select("spec").eq("id", profileId).eq("workspace_id", currentWorkspaceId()).single(), "load profile");
  return profileSchema.parse(row.spec);
}

export async function controlRun(runId: string, action: "pause" | "resume" | "retry_failed"): Promise<RunStatus> {
  const run = must<{ id: string; status: RunStatus }>(await db().from("runs").select("id, status").eq("id", runId).eq("workspace_id", currentWorkspaceId()).single(), "load run");
  if (action === "pause") await setRunStatus(run, "paused", { note: null });
  else if (action === "resume") await setRunStatus(run, "running", { note: null, finished_at: null });
  else {
    const failed = must<{ id: string; stage: AccountStage }[]>(await db().from("run_accounts").select("id, stage").eq("run_id", runId).eq("stage", "error").eq("workspace_id", currentWorkspaceId()), "find failed");
    for (const f of failed) { moveAccount(f.stage, "queued"); await db().from("run_accounts").update({ stage: "queued", reason: null, started_at: null, finished_at: null }).eq("id", f.id); }
    if (failed.length) await setRunStatus(run, "running", { note: null, finished_at: null });
  }
  await audit(`run.${action}`, { type: "run", id: runId }, { status: run.status });
  return run.status;
}

// ---------- helpers kept for scripts ----------

export async function createWorkspace(name: string): Promise<string> {
  return must(await serviceDb().from("workspaces").insert({ name }).select("id").single(), "create workspace").id;
}

export async function saveProfile(workspaceId: string, profile: Profile): Promise<string> {
  const row = { workspace_id: workspaceId, slug: profile.id, version: profile.version, name: profile.seller.name, yaml: YAML.stringify(profile), spec: profile, hash: profileHash(profile) };
  return must(await serviceDb().from("profiles").insert(row).select("id").single(), "save profile").id;
}

/** Stores finished results under a new run. Used by scripts and tests; live runs go through createRun and tickRun. */
export async function saveRunWithResults(workspaceId: string, profileId: string, profile: Profile, results: DomainResult[]): Promise<string> {
  const run = must(await serviceDb().from("runs").insert({
    workspace_id: workspaceId, profile_id: profileId, profile_hash: profileHash(profile), status: "finished", caps: profile.limits,
    tokens_in: results.reduce((a, r) => a + r.tokens.prompt, 0), tokens_out: results.reduce((a, r) => a + r.tokens.output, 0),
    started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
  }).select("id").single(), "create run");
  for (const [i, r] of results.entries()) {
    const acct = must(await serviceDb().from("run_accounts").insert({
      run_id: run.id, workspace_id: workspaceId, domain: r.domain, position: i, stage: stageForResult(r.status), qualification: qualificationFor(r.status),
      score: r.score, result: r, reason: r.reason, tokens_in: r.tokens.prompt, tokens_out: r.tokens.output, loop_steps: r.loops.steps,
    }).select("id").single(), "save account");
    if (r.email) must(await serviceDb().from("drafts").insert({ account_id: acct.id, workspace_id: workspaceId, subject: r.email.subject, body: r.email.body, generated_subject: r.email.subject, generated_body: r.email.body, tags: reviewTags(r), lint: r.email.lint }).select("id"), "save draft");
  }
  return run.id;
}

export async function loadRun(runId: string) {
  return must<unknown[]>(await serviceDb().from("run_accounts").select("domain, stage, qualification, score, drafts(subject, review_status)").eq("run_id", runId).order("position"), "load run");
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  must(await serviceDb().from("workspaces").delete().eq("id", workspaceId).select("id"), "delete workspace");
}

export async function deleteRun(runId: string): Promise<void> {
  must(await db().from("runs").delete().eq("id", runId).eq("workspace_id", currentWorkspaceId()).select("id"), "delete run");
  await audit("run.deleted", { type: "run", id: runId });
}

// ---------- export ----------

export async function exportRunCsv(runId: string, scope: "all" | "qualified" = "all"): Promise<string> {
  must(await db().from("runs").select("id").eq("id", runId).eq("workspace_id", currentWorkspaceId()).single(), "load run"); // a run from another workspace is not found, not an empty file
  const rows = must<Record<string, unknown>[]>(await db().from("run_accounts").select("id, domain, position, stage, qualification, score, reason, result, drafts(review_status, is_current)").eq("run_id", runId).eq("workspace_id", currentWorkspaceId()), "load accounts");
  await audit("export.shortlist", { type: "run", id: runId }, { scope });
  return buildShortlistCsv(rows.map((r) => ({
    domain: r.domain as string, position: Number(r.position), stage: r.stage as string, qualification: (r.qualification as string | null) ?? null,
    score: (r.score as number | null) ?? null, reason: (r.reason as string | null) ?? null, result: r.result ? (currentCtx().demo ? maskResult(r.result as DomainResult) : (r.result as DomainResult)) : null,
    draftStatus: ((r.drafts as { review_status: string; is_current: boolean }[] | null) ?? []).find((d) => d.is_current)?.review_status ?? null,
  })), scope);
}

// ---------- comparison ----------

/** Creates two runs over the same domain list, one per profile, linked by a comparison group. */
export async function createComparison(opts: { a: { slug: string; dbId?: string }; b: { slug: string; dbId?: string }; domains: string[] }) {
  const [pa, pb] = await Promise.all([resolveProfileRow(opts.a.slug, opts.a.dbId), resolveProfileRow(opts.b.slug, opts.b.dbId)]);
  if (pa.dbId === pb.dbId) throw new Error("Pick two different profiles or versions.");
  const cap = Math.min(pa.spec.limits.max_accounts_per_run, pb.spec.limits.max_accounts_per_run);
  const group = crypto.randomUUID();
  const ra = await createRun({ profileSlug: opts.a.slug, profileDbId: pa.dbId, domains: opts.domains, comparisonGroup: group, maxAccounts: cap });
  const rb = await createRun({ profileSlug: opts.b.slug, profileDbId: pb.dbId, domains: opts.domains, comparisonGroup: group, maxAccounts: cap });
  return { groupId: group, runA: ra.runId, runB: rb.runId, queued: ra.queued, capped: ra.capped, cap };
}

export interface ComparisonRow { domain: string; a: AccountBrief | null; b: AccountBrief | null; diff: ResultDiff | null }
export interface Comparison {
  a: { id: string; status: RunStatus; profile: RunDetail["profile"]; totals: RunTotals }; b: { id: string; status: RunStatus; profile: RunDetail["profile"]; totals: RunTotals };
  rows: ComparisonRow[]; summary: CompareSummary;
}

/** Side-by-side of two runs, paired by domain. Works for any two runs, comparison group or not. */
export async function getComparison(runA: string, runB: string): Promise<Comparison> {
  const [a, b] = await Promise.all([getRun(runA), getRun(runB)]);
  const results = async (id: string) => {
    const rows = must<{ domain: string; result: DomainResult | null }[]>(await db().from("run_accounts").select("domain, result").eq("run_id", id).eq("workspace_id", currentWorkspaceId()), "load results");
    return new Map(rows.map((r) => [r.domain, r.result]));
  };
  const [ra, rb] = await Promise.all([results(runA), results(runB)]);
  const rows: ComparisonRow[] = pairByDomain(a.accounts, b.accounts).map((p) => {
    const x = ra.get(p.domain); const y = rb.get(p.domain);
    return { domain: p.domain, a: p.a, b: p.b, diff: x && y ? diffResults(x, y) : null };
  });
  return {
    a: { id: a.id, status: a.status, profile: a.profile, totals: a.totals }, b: { id: b.id, status: b.status, profile: b.profile, totals: b.totals },
    rows, summary: summarizePairs(rows),
  };
}
