const { CopilotClient, approveAll } = require("@github/copilot-sdk");

// Model can be overridden via env; "gpt-5" is a safe default available to
// standard Copilot subscriptions. See the SDK's listModels() if you want to
// confirm what's available on your account/plan.
const MODEL = process.env.COPILOT_MODEL || "gpt-5";

// The SDK spawns and manages the Copilot CLI as a subprocess. We keep a
// single client alive for the lifetime of the backend process rather than
// starting/stopping it per request, since starting it has real overhead.
let clientPromise = null;

function getClient() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new CopilotClient({
        // Passing gitHubToken directly (rather than relying on an
        // interactively logged-in user) is what makes this work headless
        // on a server like Render, with no browser available.
        gitHubToken: process.env.COPILOT_GITHUB_TOKEN,
      });

      // IMPORTANT: Node's EventEmitter throws and crashes the process if
      // an 'error' event fires with zero listeners attached. Without this,
      // any hiccup in the underlying Copilot CLI subprocess (crash, broken
      // pipe, etc.) takes down the entire backend, not just the current
      // request. This is what was silently killing the whole service.
      client.on("error", (err) => {
        console.error("CopilotClient emitted an error (subprocess-level):", err);
      });

      await client.start();
      return client;
    })();
  }
  return clientPromise;
}

/**
 * Sends a single prompt to Copilot and returns the assembled text response.
 * Opens a fresh session per call and disconnects it when done, so sessions
 * don't accumulate across changelog drafts / failure summaries.
 */
async function runPrompt(prompt, timeoutMs = 30000) {
  const client = await getClient();

  const session = await client.createSession({
    model: MODEL,
    onPermissionRequest: approveAll,
  });

  let output = "";
  let settled = false;

  const done = new Promise((resolve, reject) => {
    session.on("assistant.message", (event) => {
      output += event.data.content;
    });
    session.on("session.idle", () => {
      settled = true;
      resolve();
    });
    session.on("error", (err) => {
      settled = true;
      reject(err);
    });
  });

  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      if (!settled) reject(new Error(`Copilot session timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await session.send({ prompt });
    await Promise.race([done, timeout]);
  } finally {
    // Always attempt to disconnect, even on failure/timeout, so sessions
    // don't leak. Swallow disconnect errors — we already have the real
    // error (if any) from above.
    await session.disconnect().catch(() => {});
  }

  return output.trim();
}

async function draftChangelog(prs) {
  if (prs.length === 0) {
    return "_No merged PRs found since the last tag._";
  }

  const prList = prs
    .map((pr) => `- #${pr.number} ${pr.title} (${pr.author}) [labels: ${pr.labels.join(", ") || "none"}]`)
    .join("\n");

  const prompt = `You are drafting release notes for a software release. Given this list of merged pull requests, group them into "Features", "Fixes", and "Chores/Other" sections based on their titles and labels. Write clear, user-facing one-line summaries for each, not raw PR titles. Use markdown with headers. Be concise.

Pull requests:
${prList}`;

  return runPrompt(prompt);
}

async function summarizeFailure(logExcerpt) {
  const prompt = `Summarize this CI/deploy failure log in 2-3 plain-English sentences for a Slack message aimed at a release manager who isn't deep in the logs. Focus on what failed and the likely cause if apparent. Do not include the raw log.

Log:
${logExcerpt}`;

  return runPrompt(prompt);
}

/**
 * Call this once during a graceful shutdown (e.g. on SIGTERM) to stop the
 * underlying Copilot CLI process cleanly. Not required for normal operation.
 */
async function shutdown() {
  if (clientPromise) {
    const client = await clientPromise;
    await client.stop();
    clientPromise = null;
  }
}
module.exports = { draftChangelog, summarizeFailure, shutdown };
