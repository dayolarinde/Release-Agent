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

// Statuses that mean "this release is finished, no longer active."
const TERMINAL_STATUSES = ["deployed", "rolled_back"];

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
    UPDATE releases SET branch = 'unspecified-legacy' WHERE branch IS NULL;

    ALTER TABLE releases ALTER COLUMN branch SET NOT NULL;

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

    -- Only one active (non-terminal) release per branch at a time. This is
    -- a partial unique index rather than a plain UNIQUE constraint, since
    -- the same branch name can have many *finished* releases over time --
    -- it just can't have more than one *active* one simultaneously.
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_release_per_branch
      ON releases (branch)
      WHERE status NOT IN ('deployed', 'rolled_back');
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
       VALUES ($1, $2, $3, $4, $5, $6, 'awaiting_approval')
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
  return release;
}

/**
 * The active (non-terminal) release for a specific branch, or null if
 * that branch has no release currently in flight. This is the
 * branch-scoped replacement for the old singular getCurrentRelease().
 */
async function getActiveReleaseByBranch(branch) {
  const { rows } = await pool.query(
    `SELECT * FROM releases WHERE branch = $1 AND status NOT IN ('deployed', 'rolled_back')
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
    `SELECT * FROM releases WHERE status NOT IN ('deployed', 'rolled_back')
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
  TERMINAL_STATUSES,
};
