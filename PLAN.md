# PLAN: human-in-the-loop outreach workspace

Status: **All six phases done.** Remaining manual steps are in README Setup (disable public sign-ups, create your account). Decisions: Supabase Postgres, remove sending, Supabase Auth in Phase 6.

## 1. What exists today (read from the repo)

- **Core is TypeScript only** (no Python). `lib/pipeline.ts` `runDomain()` runs one domain: scrape homepage, `extractFacts`, `runGates` (agent loop), `scoreSignals`, contact (`overrides` then Hunter, `pickContact`), `findPains`, `draftEmail` + `lintEmail`, then `sendTestEmail`.
- **Profiles** are YAML in `config/profiles/`, validated by `lib/profile-schema.ts` (zod). Gates (2 to 4) are the hard filters with an `unknown_policy` (drop, qualify_and_flag, soft_pass_if). Signals (weights sum to 100) are the weighted score. `personas` are target titles by tier. `limits` today = `fetch_calls`, `news_calls`, `hunter_min_confidence`.
- **Caps** are enforced in code by `Budget` (`lib/tools.ts`); the model only chooses among code-supplied candidates. Max 25 domains is enforced only in the browser.
- **Trace today:** gates, score breakdown, tool calls, candidates, pains, email, token totals. Missing: per-LLM-call log, per-fact evidence URLs in the result, a "capped" state.
- **Persistence today:** none. Runs live in browser localStorage. One shared `APP_PASSWORD`, one sender.
- **UI** (built earlier this session): five tabs and a design system in `app/globals.css`. I will reuse the tokens and rebuild the screens on top of a real data layer.
- **Tests:** 30 vitest tests with a fake model (`tests/fakes.ts`), all passing.

## 2. Open questions (I need answers before Phase 1)

1. **Sending is going away.** Today the app sends a test email through Gmail. Your constraint says no sending endpoints at all. Plan: delete `lib/send.ts`, the Gmail env vars, the "sent" status, the preflight test email and the send-lock tests; replace with the export queue. You should also revoke the Gmail refresh token. **OK to remove?** (Recommended: yes.)
2. **Where do runs, profiles and drafts live?** Vercel functions have no durable disk and no background threads. Options: (a) **Postgres via Supabase** (recommended: durable, multi-user, row-level security gives workspace isolation, I have tooling for it); (b) local SQLite file (simplest, single machine, no Vercel deploy). Which?
3. **How do background runs execute?** On Vercel Hobby there is no long-running worker. Recommended design: a `run_accounts` table plus a `/api/runs/:id/tick` endpoint that processes one account per call (fits the function limit). The browser drives ticks while open, and `npm run worker` drives them for local use. True close-the-tab background needs a paid cron or queue. **Is "keeps going only while a tab or the worker is open" acceptable?**
4. **Who signs in?** Workspace isolation needs identities. Options: Supabase Auth (email magic link) with workspace membership, or a password per workspace. Recommended: Supabase Auth if you pick Supabase in Q2.
5. **Cost display.** Token counts are real; dollar cost needs a price per model. I will add a small editable price table in settings and label it "estimated". OK?

## 3. Architecture decisions

- **Keep the core, wrap it.** `runDomain` stays the domain logic. I add an optional `hooks` argument (`onStage`, `onLLMCall`, `onToolCall`) and a `RunCaps` argument; no rewrite. Existing behaviour and tests keep passing.
- **Service boundary:** `lib/services/{profiles,runs,accounts,drafts,export}.ts` own all DB access and call the core; route handlers and pages call only services. Secrets are read only in server code (`lib/*`, route handlers), never in client components, and never logged.
- **Profile schema v2 (backward compatible).** Load v1 as is. New sections map onto the request:
  - *Hard Disqualifiers*: structured rules (`region_in`, `headcount_between`, `industry_not_in`) that compile to exclusion gates, plus the existing free-form gates.
  - *Weighted Fit Criteria*: existing `signals`.
  - *Target Personas*: existing `personas`.
  - *Execution Caps*: `max_accounts_per_run`, `max_contacts_per_account`, `max_loop_steps`, `max_tokens_per_account`, plus the existing fetch and news caps.
- **Statuses** become the pipeline in the brief: `queued, researching, gate_evaluation, contact_lookup, drafting, ready_for_review, disqualified, capped, error`. Qualification status for the table: `Qualified / Disqualified / Capped`. Gate answers: `PASS / FAIL / SKIPPED_DUE_TO_CAP`.
- **Page cache per domain.** Fetched page text is stored once per workspace and domain. Re-runs and comparisons reuse it, so comparing two profiles shows differences caused by the profile, not by the site changing, and no extra fetches hit the prospect. Single-fetch, robots.txt and no-bypass rules are unchanged.
- **Editor:** canonical state is the parsed profile object. Visual edits serialize to YAML (comments are not preserved; I will say so in the UI). YAML edits parse with the `yaml` package and validate with zod; errors show line, path and message. While YAML is invalid the form is read-only and shows the error.
- **YAML editor component:** CodeMirror 6 (small, accessible). I will read its current docs before using it.
- **Audit fields** on drafts and runs: `created_at`, `reviewed_at`, `approved_by`, `approved_at`, `updated_at`.

## 4. Phases (each ends with: tests, typecheck, build, local 5-domain seed run)

The seed run uses a deterministic demo mode (fake model and fixture pages, five domains covering qualify, drop, capped, no contact, lint-held) so it needs no keys. A live run is added to the checklist whenever keys are present.

### Phase 0: baseline and safety
- [x] Create a git branch, commit the current tree as the baseline (nothing is committed in `~/sprinto-outreach` yet).
- [x] Remove sending: `lib/send.ts`, send path in `pipeline.ts`, `Deps.send`, Gmail env names, preflight email, `sent` and `send_failed` statuses, UI send checkbox.
- [x] Add a test that greps the repo for any Gmail or SMTP send call and fails if one appears.
- [x] Add DB layer and migrations (per Q2), env example updated.
- Verify: `npm test`, `npm run typecheck`, `npm run build`; the grep test passes; the app still runs a demo domain end to end and ends at "drafted".

### Phase 1: profiles and ICP gates
- [x] Schema v2 with v1 loader; new caps fields with safe defaults. Disqualifiers are evaluated in code (`lib/disqualifiers.ts`).
- [x] `profiles` table, workspace-scoped CRUD, YAML import and export.
- [x] Dual editor (YAML and form) with two-way sync and clear errors. Deviation: the YAML pane is a plain textarea with a line-number gutter, not CodeMirror, to avoid a heavy dependency; syntax and schema errors show line numbers.
- [x] Sections: Hard Disqualifiers, Weighted Fit Criteria, Target Personas, Execution Caps.
- [x] Clone profile; **Compare** view that takes a domain list, runs both profiles (reusing cached pages) and shows a qualification diff (status, score, gate answers that changed).
- Tests: YAML validation (good, bad weights, unknown page type, v1 loads), disqualifier compilation, form-to-YAML-to-form round trip is lossless.
- Verify: edit a profile in both modes and see the other update; clone, tweak a gate, compare on the 5 seed domains.

### Phase 2: run ingestion, execution, guardrails
- [x] New Run: pick profile, paste or CSV upload (column named `domain` or first column), normalise, de-dupe, show rejects.
- [x] `runs` and `run_accounts` tables; state machine with legal transitions only.
- [x] Tick endpoint and `npm run worker`; per-account stage updates via `onStage`; live UI via polling. Counters refresh when each account finishes, not mid-account.
- [x] Caps enforced at runtime: accounts per run (extra accounts are stored as `capped`, not silently dropped), contacts per account, loop steps, token budget. Gates left unresolved by a cap record `SKIPPED_DUE_TO_CAP`.
- [x] Live counters: loop steps, fetches, searches, tokens, and an estimated cost per run. Prices are unverified placeholders (see lib/pricing.ts); there is no billed-cost source for free tiers.
- Tests: state transitions, hard gate (drop stops all later work) versus cap (account marked capped, skipped gates recorded), caps cannot be exceeded even if the model keeps asking, resume after a stopped run.
- Verify: 5-domain seed run shows every state in order; a profile with `max_accounts_per_run: 3` shows 2 capped.

### Phase 3: ranked evidence table
- [x] Table: Company, Domain, Fit Score, Qualification Status, Matched Persona(s), Evidence Summary, Draft Status. Filter, sort, search, column persistence.
- [x] Expose per-fact evidence (text and URL) in the result; every gate answer and score factor links to its snippet and URL, or says "no source found". Score factors are linked through the facts the model names; names that are not real facts are ignored, so a source is never invented.
- [x] CSV export of the ranked shortlist with evidence columns (works with no drafts).
- Tests: CSV escaping and column set, every score factor has an evidence reference or an explicit "none found".
- Verify: open the CSV from the seed run and check each claim resolves to a URL.

### Phase 4: decision trace inspector and run comparison
- [x] Record every LLM call (purpose, input summary, output, latency, tokens), tool call, gate decision, contact lookup and lint check into `trace_steps`. Inputs and outputs are clipped at 1,500 characters.
- [x] Slide-over drawer per account: loop log, gate breakdown with exact reasons, contact reasoning (candidates ranked with why each was or was not picked).
- [x] Run Comparison View (Compare tab): same domain list across two profiles or any two existing runs, paired by domain, with gate-by-gate and factor-by-factor detail. Gates are matched on id and question together, since the same id in two profiles can be two different checks.
- Tests: trace is complete and ordered, token totals equal the sum of steps, comparison pairs rows by domain.
- Verify: compare the sprinto and payroll profiles on the seed list.

### Phase 5: review workspace and export queue
- [x] Split pane: left = brief, evidence, contact, link to trace; right = editable subject, body, personalization notes, status `Pending Review / Approved / Rejected`.
- [x] Keyboard: J/K or arrows next and previous, A or Cmd/Ctrl+Enter approve and next, X reject and next, U reopen, E edit, R regenerate, H history, Esc leave a field, ? help.
- [x] **Regenerate with instruction** (adds an `instruction` argument to `draftEmail`; lint still runs; previous versions kept).
- [x] Inline edits autosave and re-lint with the profile rules. Changing the wording sends an approved draft back to pending review, because approval applies to the exact text. Approving with warnings needs an explicit "approve anyway", which is recorded.
- [x] Export approved drafts: CSV and copy to clipboard. Nothing is ever transmitted.
- Tests: approval only from `Pending Review`, export contains only approved drafts, edited text is what is exported, regenerate keeps history, audit fields set.
- Verify: review all seed drafts by keyboard only, approve some, reject one, export.

### Phase 6: workspace isolation and security
- [x] Workspaces; every table row carries `workspace_id`; row-level security for signed-in users (queries run with the user's own token) plus an app-level filter on the active workspace.
- [x] Keys: server environment by default, optional per-workspace keys stored encrypted server-side, never returned to the client; log scrubbing test.
- [x] Audit trail on drafts and runs.
- Tests: cross-workspace access denied at the service layer and at the DB, no secret appears in API responses or bundle (grep of `.next/static`), log scrubber.
- Verify: two workspaces, confirm neither sees the other; run the secret-in-bundle check on a production build.

## 5. Risks and how I handle them

- **Free-tier pacing** (about a minute per domain) makes a 25-domain run take 25+ minutes; the progress UI and resumable ticks cover this.
- **Live services are still unproven** (Gemini model name, Hunter response shape, Google News RSS). I will run `npm run preflight` once you add keys and fix real failures before Phase 2 is called done.
- **Contact data is personal data.** It is stored per workspace, shown only to members, and a "delete run" removes it.
- **Profile v2** must not break existing v1 profiles; covered by tests in Phase 1.

## 6. What I will not do without asking
- Add any send, SMTP or Gmail call.
- Raise call caps in code.
- Commit, push, deploy or touch Vercel settings.
