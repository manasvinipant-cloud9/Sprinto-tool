# Deploy checklist and change summary

Branch `feat/review-workspace`, 11 commits on top of the original import. Nothing has been pushed or deployed.

## What changed

| Phase | Result |
|---|---|
| 0 | All email sending removed (Gmail, `SEND_TO`, "sent" status). A test fails if any mail code returns. Supabase database added, schema in `supabase/migrations/`. |
| 1 | Versioned seller profiles in the database. YAML and form editor kept in sync. Hard disqualifiers (region, size, industry) and execution caps. Clone. |
| 2 | Saved runs, one-account-per-request queue, `npm run worker`, pause/resume/retry, CSV upload. Caps enforced in code (loop steps, tokens, accounts per run). |
| 3 | Ranked evidence table, sources on every gate and score factor, spreadsheet-safe CSV export. |
| 4 | Decision trace per account (every model and tool call, gates, contact reasoning). Compare tab: two profiles over the same domains. |
| 5 | Review tab: edit, approve, reject, regenerate with an instruction, version history, keyboard shortcuts, approved-only CSV or copy export. |
| 6 | Sign-in (Supabase Auth), workspace isolation by row-level security, owner and member roles, per-workspace encrypted API keys, append-only audit trail, scrubbed logs, security headers. |

Removed on purpose: the shared `APP_PASSWORD`, `lib/send.ts`, the Gmail variables, the shared `config/poc_overrides.json` (now per workspace), and the unauthenticated `/api/run-domain` route.

## Before you push

1. **Choose where this goes.** `~/sprinto-outreach` has no git remote. Your GitHub repo (`manasvinipant-cloud9/Sprinto-tool`) and Vercel project (`sprinto-tool`) were set up from `~/Downloads/outreach-engine`, which has a different history. Either add the GitHub repo as a remote here and push this branch, or copy this folder's changes into that repo. Pushing to `main` redeploys on Vercel, so push the branch and open a pull request first.
2. **Revoke the old Gmail refresh token** (Google Cloud project `outreach-engine`). The app no longer needs Gmail at all.
3. **Turn off public sign-ups** in Supabase: Authentication, Sign In / Providers, "Allow new users to sign up" off.
4. **Run the checks locally:**
   ```bash
   npm test && npm run typecheck && npm run build && npm run bundle-check
   npm run phase6-check          # needs .env.local, makes and removes temporary data
   ```

## Vercel environment variables (project `sprinto-tool`)

Add for Production (and Preview if you use it). Paste values in the Vercel dashboard, not into chat.

| Name | Notes |
|---|---|
| `SUPABASE_URL` | Project `zmdbzdozisuuburmoldl`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret. Server only. |
| `SUPABASE_PUBLISHABLE_KEY` | The `sb_publishable_` key. Kept server-side. |
| `SECRETS_KEY` | `openssl rand -base64 32`. Use a new one for production and keep a copy: losing it makes stored workspace keys unreadable. |
| `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`, `LLM_PROVIDER` | Shared default model key. Workspaces can override. |
| `HUNTER_API_KEY` | Shared default. Workspaces can override. |
| `LLM_MODEL_CHEAP`, `LLM_MODEL_STRONG`, `LLM_MIN_INTERVAL_MS` | Optional. |

Delete from Vercel if present: `APP_PASSWORD`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `SEND_TO`, `SENDER_NAME`.

Note: Vercel Deployment Protection (the Vercel login in front of the site) is separate from the app's own sign-in. Leave it on if you want two layers.

## After deploying

1. Create your account against production: put the production values in `.env.local`, then `npm run add-user -- you@example.com`.
2. Sign in. Open System: confirm Connections show the database and keys as set.
3. Run `npm run preflight` once real model and Hunter keys are in. It has never run against live services, so expect to fix a model name or a Hunter parameter.
4. Do one real run of 2 or 3 domains. Read the Decision trace for each, then review and export one draft.
5. Check the Vercel function time limit against `maxDuration = 300` in `app/api/runs/[id]/tick/route.ts`. If your plan allows less, lower it: one account per request may then not finish.
6. Add a teammate: create their account with `add-user`, then System, Members, Add member.

## Known limits

- Free-tier model pacing means about a minute or more per account.
- Runs only progress while a browser tab or `npm run worker` is working on them.
- The sign-in slowdown is in memory and resets when the server restarts.
- Cost figures use placeholder list prices (`lib/pricing.ts`). Check them.
- Live Gemini, Hunter and Google News have not been exercised yet.
