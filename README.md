# Outreach engine

A general B2B outbound tool. Give it company domains and a seller profile; for each domain it checks fit with capped, evidence-backed gates, finds the right person, picks two likely pain points and drafts a first email.

**Nothing is ever sent.** The app stops at a draft for human review. There is no send, SMTP or Gmail code, and a test fails if one appears.

## How it works (7 steps)

1. Scrape the homepage (robots.txt respected, one URL at a time, cleaned to about 2,000 tokens).
2. Extract facts into named fields. Missing is `null`, never a guess.
3. Gates from the selected profile. Code checks which required fields are null; the model only picks the next tool (fetch a page on the prospect's own domain, or search news) from an allowed list, within hard budgets.
4. Contact: a hand-picked contact for that workspace first (Contacts tab), then Hunter.io. A tier ladder from the profile picks one person above the confidence bar, or the run reports "qualified, no contact".
5. Two pain points, each tied to a real fact.
6. Email, linted by code (length, first name, banned phrases, no links, no invented statistics, question hook when the lead is unconfirmed).
7. Stop at a draft. A human reviews, edits and exports it.

Every decision is stored in a per-domain trace (gates, evidence, source URLs, tool calls, score breakdown, candidates, pains, lint results, profile id, version and hash). Download JSON or CSV from the results page.

## Seller profiles

Everything seller-specific lives in `config/profiles/<id>.yaml`, validated by `lib/profile-schema.ts`. Shipped: `sprinto` (the case) and `payroll-example` (proves the engine is not tied to one seller). Add a file to add a seller. The Profiles tab has a guided builder that validates a draft against the real schema and gives you the YAML to commit (the deployed app never writes files).

## Running without a browser

Runs are stored in the database. `npm run worker` processes every queued or running run (or `npm run worker -- <runId>`) with no browser open. The browser does the same one account at a time while the Run tab is open.

## Screens

Run (paste domains, live queue, retry), Review (split-pane draft review: edit, approve, reject, regenerate with an instruction, version history, keyboard shortcuts, approved-only CSV or copy export), Compare (two profiles over the same domains, paired by domain, with gate-level differences), Results (ranked evidence table with filters, sort, column choice and CSV export; slide-over per account with Summary / Fit / Evidence / Contact / Email / Decision trace), Profiles (viewer and builder), Contacts (chosen contacts and manual overrides), System (connections, Hunter quota, guard rails, theme).

## Boundaries

- Free-tier model limits are real: calls are paced (`LLM_MIN_INTERVAL_MS`), so a domain takes a minute or more.
- Free-tier prompts may be used by Google to improve its products. Only public website text and a contact's name and title are sent to the model.
- Scraping is single-fetch only, never behind a login, never around a bot challenge. Blocked pages are logged and the domain is queued for human review.

## Setup

1. Copy `.env.example` to `.env.local` and fill every value. Never commit it. `SECRETS_KEY` is 32 random bytes: `openssl rand -base64 32`.
2. `npm install`
3. In the Supabase dashboard, turn **off** "Allow new users to sign up" (Authentication, Sign In / Providers). Accounts are created by you, not by visitors.
4. Create your account and workspace: `npm run add-user -- you@example.com` (asks for a password with hidden input; the first user of the "Default workspace" becomes its owner). Add `--workspace "Client A" --owner` for another workspace.
5. `npm run preflight` (checks every key with one harmless call)
6. `npm run dev`, or deploy to Vercel and add the same variables there (including `SUPABASE_PUBLISHABLE_KEY` and `SECRETS_KEY`).
7. `npm test` runs the logic tests offline with a fake model.

Checks against the real database (each makes temporary data and removes it): `npm run phase6-check` (workspace isolation, members, keys, audit), `npm run phase6-http-check` (sign-in, cookies, headers; needs the dev server running), and after `npm run build`, `npm run bundle-check` (no secret in anything the browser downloads).

## Security model

- **Sign-in.** Supabase Auth, email and password. Tokens live only in HttpOnly, SameSite=Lax cookies; page scripts never see them. Every request that changes data must carry the app's own header, so another site cannot make your browser act.
- **Workspaces.** Every row belongs to a workspace. Signed-in users talk to Postgres with their own token, so row-level security stops them reading or writing another workspace's rows even if the app had a bug. The app also filters by the active workspace, so someone in two workspaces (an agency) sees one client at a time.
- **Roles.** Owners manage members, keys and new workspaces. Members review and run. A new sign-up with no workspace gets nothing, and cannot create one.
- **Keys.** The server's keys are the default. A workspace can store its own: encrypted with AES-256-GCM using `SECRETS_KEY`, bound to that workspace, readable only by the server, never returned (only the last four characters). Losing `SECRETS_KEY` makes stored workspace keys unreadable; re-enter them.
- **Secrets in logs.** Messages and audit details pass through a scrubber that removes key-shaped strings and the exact values of configured secrets.
- **Audit trail.** Append-only per workspace: runs, profile changes, approvals and edits, exports, members, keys (never their values). Approvals record the approver's account.
- **Browser.** A content security policy, no framing, no referrer, no sniffing; API answers are never cached.
- **Known limits.** The sign-in throttle is in memory (it resets when the server restarts; Supabase also rate limits). Adding someone needs them to have an account first. Removing someone ends access immediately for database access and within about 10 seconds for the app's own checks.
