const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

// DATABASE_URL example: postgres://user:pass@host:5432/dbname
// Most managed providers (Render, Railway, Neon, Supabase) require SSL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
});

// Statuses that mean "this release is finished, no longer active." Note:
// this is the *overall release* status, only ever exactly "deployed" once
// the final environment stage (e.g. PROD) succeeds -- an intermediate
// stage succeeding produces a different string (see setStageStatus below),
// so it doesn't get mistaken for the whole release being done.
const TERMINAL_STATUSES = ["deployed", "rolled back"];

function loadEnvironmentConfig() {
  const raw = fs.readFileSync(
    path.join(__dirname, "..", "config", "environments.yaml"),
    "utf8"
  );
  return yaml.load(raw).stages;
}

/**
 * Slack member IDs to mention per environment stage. Optional -- returns
 * an empty object (no mentions for any stage) if the config file doesn't
 * exist yet, so this feature doesn't break setups that predate it.
 */
function loadApproversConfig() {
  const configPath = path.join(__dirname, "..", "config", "approvers.yaml");
  if (!fs.existsSync(configPath)) {
    return {};
  }
  const raw = fs.readFileSync(configPath, "utf8");
  return yaml.load(raw) || {};
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS releases (
      id SERIAL PRIMARY KEY,
      branch TEXT,
      tag TEXT,
      checklist_type TEXT DEFAULT 'default',
      status TEXT DEFAULT 'drafting',
      changelog TEXT,
      slack_channel TEXT,
      slack_thread_ts TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Safe for existing deployments: adds the column if this table
    -- already existed from before branch-scoped releases were introduced.
    ALTER TABLE releases ADD COLUMN IF NOT EXISTS branch TEXT;

    -- Backfill any pre-existing rows (from before this change) with a
    -- placeholder so the NOT NULL constraint below can be applied safely.
    -- Each pre-existing row gets its own unique placeholder (using its id)
    -- rather than one shared string -- a shared placeholder would collide
    -- with the partial unique index below if more than one old release
    -- was still in a non-terminal status when this migration ran.
    UPDATE releases SET branch = 'unspecified-legacy-' || id WHERE branch IS NULL;

    ALTER TABLE releases ALTER COLUMN branch SET NOT NULL;

    -- Convert any pre-existing rows from the old snake_case status values
    -- to natural English, so old test data stays consistent with the new
    -- terminal-status checks below (otherwise an old row like
    -- 'rolled_back' wouldn't match 'rolled back' and would incorrectly
    -- look "active" again, blocking new releases on that branch).
    UPDATE releases SET status = 'awaiting approval' WHERE status = 'awaiting_approval';
    UPDATE releases SET status = 'ready to deploy' WHERE status = 'ready_to_deploy';
    UPDATE releases SET status = 'rolled back' WHERE status = 'rolled_back';

    CREATE TABLE IF NOT EXISTS checklist_items (
      id SERIAL PRIMARY KEY,
      release_id INTEGER NOT NULL REFERENCES releases(id),
      item_id TEXT NOT NULL,
      label TEXT NOT NULL,
      done BOOLEAN DEFAULT FALSE,
      done_by TEXT,
      done_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS deploy_events (
      id SERIAL PRIMARY KEY,
      release_id INTEGER NOT NULL REFERENCES releases(id),
      event_type TEXT NOT NULL,
      detail TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- One row per release per environment stage (SIT, UAT, PROD, ...),
    -- tracked independently. stage_order comes from config/environments.yaml
    -- at the time the release was cut, so reordering the config later
    -- doesn't retroactively change releases already in flight.
    CREATE TABLE IF NOT EXISTS deploy_stages (
      id SERIAL PRIMARY KEY,
      release_id INTEGER NOT NULL REFERENCES releases(id),
      environment TEXT NOT NULL,
      stage_order INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      UNIQUE (release_id, environment)
    );

    -- Only one active (non-terminal) release per branch at a time. This is
    -- a partial unique index rather than a plain UNIQUE constraint, since
    -- the same branch name can have many *finished* releases over time --
    -- it just can't have more than one *active* one simultaneously.
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_release_per_branch
      ON releases (branch)
      WHERE status NOT IN ('deployed', 'rolled back');
  `);
}

function loadChecklistConfig() {
  const raw = fs.readFileSync(
    path.join(__dirname, "..", "config", "checklist.yaml"),
    "utf8"
  );
  return yaml.load(raw);
}

async function createRelease({ branch, tag, checklistType = "default", slackChannel, slackThreadTs, changelog }) {
  if (!branch) {
    throw new Error("createRelease requires a branch name");
  }

  let releaseId;
  try {
    const { rows } = await pool.query(
      `INSERT INTO releases (branch, tag, checklist_type, slack_channel, slack_thread_ts, changelog, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'awaiting approval')
       RETURNING id`,
      [branch, tag, checklistType, slackChannel, slackThreadTs, changelog]
    );
    releaseId = rows[0].id;
  } catch (err) {
    // Postgres unique_violation, thrown by the partial index above when a
    // branch already has an active release.
    if (err.code === "23505") {
      throw new Error(
        `Branch "${branch}" already has an active release in progress. Use /release status ${branch} to check it, or wait until it's deployed/rolled back before cutting a new one.`
      );
    }
    throw err;
  }

  const config = loadChecklistConfig();
  const items = config[checklistType] || config.default;

  for (const item of items) {
    await pool.query(
      `INSERT INTO checklist_items (release_id, item_id, label) VALUES ($1, $2, $3)`,
      [releaseId, item.id, item.label]
    );
  }

  const stages = loadEnvironmentConfig();
  for (let i = 0; i < stages.length; i++) {
    await pool.query(
      `INSERT INTO deploy_stages (release_id, environment, stage_order) VALUES ($1, $2, $3)`,
      [releaseId, stages[i], i]
    );
  }

  return getRelease(releaseId);
}

async function getRelease(releaseId) {
  const { rows } = await pool.query(`SELECT * FROM releases WHERE id = $1`, [releaseId]);
  if (rows.length === 0) return null;
  const release = rows[0];

  const { rows: checklist } = await pool.query(
    `SELECT * FROM checklist_items WHERE release_id = $1 ORDER BY id`,
    [releaseId]
  );
  release.checklist = checklist;

  const { rows: stages } = await pool.query(
    `SELECT * FROM deploy_stages WHERE release_id = $1 ORDER BY stage_order`,
    [releaseId]
  );
  release.stages = stages;

  return release;
}

/**
 * The active (non-terminal) release for a specific branch, or null if
 * that branch has no release currently in flight. This is the
 * branch-scoped replacement for the old singular getCurrentRelease().
 */
async function getActiveReleaseByBranch(branch) {
  const { rows } = await pool.query(
    `SELECT * FROM releases WHERE branch = $1 AND status NOT IN ('deployed', 'rolled back')
     ORDER BY created_at DESC LIMIT 1`,
    [branch]
  );
  return rows.length > 0 ? getRelease(rows[0].id) : null;
}

/**
 * All active (non-terminal) releases across every branch -- useful for a
 * status overview when the person doesn't specify a branch.
 */
async function getAllActiveReleases() {
  const { rows } = await pool.query(
    `SELECT * FROM releases WHERE status NOT IN ('deployed', 'rolled back')
     ORDER BY created_at DESC`
  );
  return Promise.all(rows.map((r) => getRelease(r.id)));
}

async function markChecklistItem(releaseId, itemId, doneBy) {
  await pool.query(
    `UPDATE checklist_items SET done = TRUE, done_by = $1, done_at = NOW()
     WHERE release_id = $2 AND item_id = $3`,
    [doneBy, releaseId, itemId]
  );
  return getRelease(releaseId);
}

async function isChecklistComplete(releaseId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM checklist_items WHERE release_id = $1 AND done = FALSE`,
    [releaseId]
  );
  return rows[0].c === 0;
}

async function setReleaseStatus(releaseId, status) {
  await pool.query(`UPDATE releases SET status = $1 WHERE id = $2`, [status, releaseId]);
  return getRelease(releaseId);
}

async function logDeployEvent(releaseId, eventType, detail) {
  await pool.query(
    `INSERT INTO deploy_events (release_id, event_type, detail) VALUES ($1, $2, $3)`,
    [releaseId, eventType, detail || ""]
  );
}

/**
 * Fetches a single environment stage row for a release, or null if that
 * environment isn't a configured stage for this release.
 */
async function getStage(releaseId, environment) {
  const { rows } = await pool.query(
    `SELECT * FROM deploy_stages WHERE release_id = $1 AND environment = $2`,
    [releaseId, environment]
  );
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Enforces that stages complete in order: a stage can only start if every
 * earlier stage (by stage_order) has already succeeded. Returns null if
 * starting is fine, or a string explaining why it's blocked.
 */
async function checkStageOrder(releaseId, environment) {
  const stage = await getStage(releaseId, environment);
  if (!stage) {
    return `"${environment}" isn't a configured environment for this release. Check config/environments.yaml.`;
  }

  const { rows: earlierStages } = await pool.query(
    `SELECT * FROM deploy_stages WHERE release_id = $1 AND stage_order < $2 ORDER BY stage_order`,
    [releaseId, stage.stage_order]
  );

  const incomplete = earlierStages.find((s) => s.status !== "deployed");
  if (incomplete) {
    return `Can't deploy to ${environment} yet -- ${incomplete.environment} hasn't succeeded (currently: ${incomplete.status}).`;
  }

  return null;
}

async function setStageStatus(releaseId, environment, status) {
  const timestampColumn =
    status === "deploying" ? "started_at" : status === "deployed" || status === "failed" ? "completed_at" : null;

  const setClause = timestampColumn
    ? `status = $1, ${timestampColumn} = NOW()`
    : `status = $1`;

  await pool.query(
    `UPDATE deploy_stages SET ${setClause} WHERE release_id = $2 AND environment = $3`,
    [status, releaseId, environment]
  );

  return getStage(releaseId, environment);
}

/**
 * Builds the overall release.status string from a single stage event,
 * e.g. "deploying (UAT)", "deployed to UAT", "failed (SIT)", or the
 * terminal "deployed" once the last configured stage succeeds.
 */
async function updateReleaseStatusFromStage(releaseId, environment, stageStatus) {
  if (stageStatus === "deploying") {
    return setReleaseStatus(releaseId, `deploying (${environment})`);
  }

  if (stageStatus === "failed") {
    return setReleaseStatus(releaseId, `failed (${environment})`);
  }

  if (stageStatus === "deployed") {
    const stage = await getStage(releaseId, environment);
    const { rows: laterStages } = await pool.query(
      `SELECT COUNT(*)::int AS c FROM deploy_stages WHERE release_id = $1 AND stage_order > $2`,
      [releaseId, stage.stage_order]
    );
    const isLastStage = laterStages[0].c === 0;
    return setReleaseStatus(releaseId, isLastStage ? "deployed" : `deployed to ${environment}`);
  }

  return getRelease(releaseId);
}

module.exports = {
  pool,
  initSchema,
  createRelease,
  getRelease,
  getActiveReleaseByBranch,
  getAllActiveReleases,
  markChecklistItem,
  isChecklistComplete,
  setReleaseStatus,
  logDeployEvent,
  loadChecklistConfig,
  loadEnvironmentConfig,
  loadApproversConfig,
  getStage,
  checkStageOrder,
  setStageStatus,
  updateReleaseStatusFromStage,
  TERMINAL_STATUSES,
};
