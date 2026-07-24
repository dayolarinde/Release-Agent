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
5. In your repo, add the secrets `RELEASE_AGENT_URL` and `RELEASE_AGENT_WEBHOOK_SECRET`, then
   copy `.github/workflows/release-events.yml` into your target repo's `.github/workflows/`.

## Slack commands

- `/release cut` — cut a new release: fetches merged PRs since last tag, drafts a changelog,
  posts it to the release channel as a thread, and opens the approval checklist.
- `/release status` — shows current release state: checklist progress, deploy status.
- `/release rollback` — manually propose a rollback for the current release (posts a
  confirm button; nothing executes without a click).

## Customizing the checklist

Edit `config/checklist.yaml`. Each release type maps to a list of required checklist items.
No code changes needed to add/remove items.

## Design choices worth knowing

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

## Next steps beyond this starter

- Add a `/release approve <item>` shortcut for approving checklist items via text instead of buttons
- Wire real health-check polling into the deploy monitor (currently expects GitHub Actions to push results)
- Add per-release-type checklists (hotfix vs. minor vs. major)
- Consider a "release calendar" view once you have enough history in Postgres
