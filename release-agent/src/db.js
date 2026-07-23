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

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS releases (
      id SERIAL PRIMARY KEY,
      tag TEXT,
      checklist_type TEXT DEFAULT 'default',
      status TEXT DEFAULT 'drafting',
      changelog TEXT,
      slack_channel TEXT,
      slack_thread_ts TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

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
  `);
}

function loadChecklistConfig() {
  const raw = fs.readFileSync(
    path.join(__dirname, "..", "config", "checklist.yaml"),
    "utf8"
  );
  return yaml.load(raw);
}

async function createRelease({ tag, checklistType = "default", slackChannel, slackThreadTs, changelog }) {
  const { rows } = await pool.query(
    `INSERT INTO releases (tag, checklist_type, slack_channel, slack_thread_ts, changelog, status)
     VALUES ($1, $2, $3, $4, $5, 'awaiting_approval')
     RETURNING id`,
    [tag, checklistType, slackChannel, slackThreadTs, changelog]
  );
  const releaseId = rows[0].id;

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

async function getCurrentRelease() {
  const { rows } = await pool.query(
    `SELECT * FROM releases WHERE status != 'deployed' AND status != 'rolled_back'
     ORDER BY created_at DESC LIMIT 1`
  );
  return rows.length > 0 ? getRelease(rows[0].id) : null;
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
  getCurrentRelease,
  markChecklistItem,
  isChecklistComplete,
  setReleaseStatus,
  logDeployEvent,
  loadChecklistConfig,
};
