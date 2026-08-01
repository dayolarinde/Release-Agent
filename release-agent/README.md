# Release Agent

A Slack-based release management bot for GitHub + GitHub Actions.

It helps you:
- Draft release notes/changelogs automatically (via GitHub Copilot) from merged PRs since the last tag
- Run a configurable approval checklist in Slack before a release ships
- Post live deploy status updates from GitHub Actions
- Propose (never auto-execute) rollbacks when a deploy fails or a health check fails

## Architecture

```
GitHub repo ──(push/tag/PR merge)──► GitHub Actions workflow
                                           │
                                           │ POST webhook (HMAC signed)
                                           ▼
                                   release-agent backend (Node/Express + Slack Bolt)
                                           │
                              ┌────────────┼─────────────┐
                              ▼            ▼             ▼
                         GitHub API    Copilot SDK    Postgres (state)
                              │            │             │
                              └────────────┴─────────────┘
                                           │
                                           ▼
                                      Slack channel
                              (threads, buttons, slash commands)
```

State (releases, checklist items, approvals) lives in Postgres, not just in Slack messages,
so you can query "what shipped last month" or rebuild if a message gets deleted. Postgres
(rather than SQLite) is used so this data survives restarts/redeploys on typical PaaS hosting,
where the local filesystem is usually wiped on each deploy.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in:
   - `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_APP_TOKEN` (from your Slack app config)
   - `GITHUB_TOKEN` (repo-scoped PAT or GitHub App token)
   - `GITHUB_WEBHOOK_SECRET` (shared secret, also set in the GitHub Actions workflow/secrets)
   - `COPILOT_GITHUB_TOKEN` (a GitHub token on an account with an active Copilot subscription)
   - `DATABASE_URL` (Postgres connection string — Render/Railway/Fly/Neon/Supabase all provide one)
   - `SLACK_RELEASE_CHANNEL` (channel ID to post updates to)
3. `npm install`
4. `npm start` — this also creates the required tables on first run via `initSchema()`.
4. In Slack, install the app with slash command `/release` and enable Interactivity pointing at
   `https://<your-host>/slack/events`.
5. In your target repo, add the secrets `RELEASE_AGENT_URL` and `RELEASE_AGENT_WEBHOOK_SECRET`, then
   copy `.github/workflows/deploy.yml` into that repo's `.github/workflows/`. This workflow triggers
   automatically when a pull request merges into a branch named `SIT`, `UAT`, or `PROD` (those branches
   must exist in the repo), and reports deploy status directly to the backend as part of its own run.

## Slack commands

Releases are scoped to a **branch name** (e.g. a release branch cut from `main`), so multiple releases
can be in flight at once without crossing wires. Every command below takes the branch name as an
argument, except `/release status` with no argument, which lists everything currently active.

Every command that targets a specific branch (`cut`, `status <branch>`, `rollback <branch>`) reposts
the live, clickable checklist into that release's thread -- not just a text summary. This is
deliberate repetition: it means the checklist (with working buttons) is always one command away,
without having to scroll back to find the original message. Running `/release status <branch>`
repeatedly will post a fresh checklist each time, so expect the thread to accumulate one per check --
that's the tradeoff for always having a current, clickable copy on hand.

- `/release cut <branch>` — cut a new release for that branch: fetches PRs merged into it, drafts a
  changelog, posts it to the release channel as a thread, and opens the approval checklist. Fails
  clearly if that branch doesn't exist, or if it already has an active release in progress.
- `/release status [branch]` — with a branch name, reposts that release's live checklist and shows a
  status/stage summary. Without one, lists every release currently active across all branches (no
  checklists reposted here, to avoid flooding the channel if several releases are in flight).
- `/release rollback <branch>` — reposts the checklist, then manually proposes a rollback for that
  branch's active release (posts a
  confirm button; nothing executes without a click).

## Customizing the checklist

Edit `config/checklist.yaml`. Each release type maps to a list of required checklist items.
No code changes needed to add/remove items.

## Customizing environment stages

Edit `config/environments.yaml` -- an ordered list of stage names (e.g. `SIT`, `UAT`, `PROD`). Every
release cut after a config change gets that stage list; releases already in flight keep whatever
stages were configured when they were created. Stages must complete in order -- deploying to a later
stage is refused with a clear message if an earlier one hasn't succeeded yet.

## Auto-mentioning approvers per stage

Edit `config/approvers.yaml` -- maps each environment to a list of Slack member IDs to `@`-mention the
moment a deploy to that stage starts. Get a member ID from someone's Slack profile (`...` menu ->
"Copy member ID") -- it's not their `@handle`. Leave a stage's list empty (`[]`) if no one needs to be
pinged for it. This file is entirely optional -- if it doesn't exist, no mentions happen and nothing
breaks.

## Design choices worth knowing

- **Releases are scoped by branch, not global.** Each release is tied to a specific branch name, and
  a partial unique index in Postgres enforces at most one *active* release per branch at a time (past,
  finished releases on that same branch don't count against this). This is what allows multiple release
  branches to be worked on simultaneously without the bot mixing up their changelogs, checklists, or
  deploy events.
- **Migration note:** if you're updating from an earlier version of this project that didn't have
  branch-scoped releases, `initSchema()` in `src/db.js` will automatically add the new `branch` column
  to an existing `releases` table and backfill old rows with a placeholder value — but if more than one
  *old, still-active* release exists at deploy time, the new uniqueness constraint could fail to apply.
  If that happens, manually mark old test releases as `deployed` or `rolled_back` in the database first.

- **Rollback is always human-confirmed.** The agent will detect a failed deploy or health
  check and post a "Roll back now?" button, but will not execute a rollback on its own.
  This is deliberate — a wrong auto-rollback can become its own incident.
- **Changelog drafts are reviewed, not auto-published.** The agent posts a draft to Slack;
  a human edits/approves before it's used as the final release notes.
- **State lives in Postgres**, not Slack — Slack is the UI, not the database.
- **AI calls go through the GitHub Copilot SDK** (`src/ai.js`), not the Anthropic API. This SDK spawns
  the Copilot CLI as a subprocess and talks to it over JSON-RPC — heavier per-call than a plain HTTP
  request, but avoids needing separate API approval if your org has already approved Copilot. It's in
  public preview as of mid-2026, so treat this integration as POC-grade rather than production-hardened.
- **Environment stages deploy in order, tracked independently.** Each release gets its own SIT/UAT/PROD
  (or whatever `config/environments.yaml` defines) progress, enforced server-side -- attempting to
  deploy to a later stage before an earlier one has succeeded is refused rather than silently allowed.
  Deploy status is reported directly by whatever runs the deploy (see `.github/workflows/deploy.yml`),
  not inferred from a separate observer workflow.
- **Release identity and environment come from the merge itself, never inferred from a running branch's
  own git context.** `deploy.yml` triggers automatically when a pull request merges into `SIT`, `UAT`,
  or `PROD` -- the environment is that PR's base branch, and the release identity is the PR's *head*
  branch (whatever was merged in, e.g. `Release-Aug-2026`). This matters because once code lives on
  `SIT` itself, that branch's own name is just `"SIT"` -- useless for knowing which release a deploy
  belongs to. Reading both values off the PR's metadata, rather than off `github.ref_name`, keeps
  release identity and environment correctly separated no matter how many environments code passes
  through. This assumes promotions happen via merged pull requests, not direct pushes -- see the note
  at the top of `deploy.yml` if that assumption doesn't hold for your real pipeline.
- **Deploy success/failure is controlled by a PR label in this POC**, since nothing is manually
  triggering a run anymore to provide that input directly. Add a `simulate-failure` label to a PR
  before merging it to test the failure path; leave it off for a simulated success.
- **The PR count shown in deploy-started messages is a live GitHub API call**, not something cached
  from when the release was cut -- it reflects whatever's merged into the release branch at the moment
  each stage's deploy starts. If that call fails, the message still posts, just without the count,
  rather than blocking the notification entirely.

## Next steps beyond this starter

- Add a `/release approve <item>` shortcut for approving checklist items via text instead of buttons
- Wire real health-check polling into the deploy monitor (currently expects GitHub Actions to push results)
- Add per-release-type checklists (hotfix vs. minor vs. major)
- Consider a "release calendar" view once you have enough history in Postgres
