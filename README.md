# Outreach engine

A general B2B outbound tool. Give it company domains and a seller profile; for each domain it checks fit with capped, evidence-backed gates, finds the right person, picks two likely pain points and drafts a first email.

**Test mode only.** Every email goes to `SEND_TO` (your own address). No code path accepts another recipient.

## How it works (7 steps)

1. Scrape the homepage (robots.txt respected, one URL at a time, cleaned to about 2,000 tokens).
2. Extract facts into named fields. Missing is `null`, never a guess.
3. Gates from the selected profile. Code checks which required fields are null; the model only picks the next tool (fetch a page on the prospect's own domain, or search news) from an allowed list, within hard budgets.
4. Contact: `config/poc_overrides.json` first, then Hunter.io. A tier ladder from the profile picks one person above the confidence bar, or the run reports "qualified, no contact".
5. Two pain points, each tied to a real fact.
6. Email, linted by code (length, first name, banned phrases, no links, no invented statistics, question hook when the lead is unconfirmed).
7. Send through the Gmail API.

Every decision is stored in a per-domain trace (gates, evidence, source URLs, tool calls, score breakdown, candidates, pains, lint results, profile id, version and hash). Download JSON or CSV from the results page.

## Seller profiles

Everything seller-specific lives in `config/profiles/<id>.yaml`, validated by `lib/profile-schema.ts`. Shipped: `sprinto` (the case) and `payroll-example` (proves the engine is not tied to one seller). Add a file to add a seller. A guided profile builder is not built yet.

## Boundaries

- One deployment has one sender (one Gmail account, one `SEND_TO`). Many profiles, one sender. No multi-user accounts.
- Free-tier model limits are real: calls are paced (`LLM_MIN_INTERVAL_MS`), so a domain takes a minute or more.
- Free-tier prompts may be used by Google to improve its products. Only public website text and a contact's name and title are sent to the model.
- Scraping is single-fetch only, never behind a login, never around a bot challenge. Blocked pages are logged and the domain is queued for human review.

## Setup

1. Copy `.env.example` to `.env.local` and fill every value. Never commit it.
2. `npm install`
3. `npm run preflight` (checks every key with one harmless call and sends one test email to you)
4. `npm run dev`, or deploy to Vercel and add the same variables there.
5. `npm test` runs the logic tests offline with a fake model.

## Gmail credentials (one time)

Google Cloud project, enable the Gmail API, configure the consent screen, create an OAuth client (Web application) with redirect URI `https://developers.google.com/oauthplayground`, then in OAuth Playground use your own client ID and secret, authorise only the `gmail.send` scope and exchange the code for a refresh token. Apps left in "Testing" status can have refresh tokens that expire after about a week; publish the consent screen to production for personal use or use an Internal user type on a Workspace account.
