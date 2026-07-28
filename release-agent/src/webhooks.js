const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const { summarizeFailure } = require("./ai");

function verifySignature(req) {
  const signature = req.headers["x-release-agent-signature"];
  if (!signature) return false;

  const expected = crypto
    .createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET)
    .update(req.rawBody || "")
    .digest("hex");

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function createWebhookRouter(slackClient) {
  const router = express.Router();

  // event_type: "deploy_started" | "deploy_succeeded" | "deploy_failed" | "health_check_failed"
  // payload: { tag, detail (optional log excerpt) }
  router.post("/deploy-event", async (req, res) => {
    if (!verifySignature(req)) {
      return res.status(401).json({ error: "invalid signature" });
    }

    try {
      const { event_type, tag, detail } = req.body;
      const release = await db.getCurrentRelease();

      if (!release) {
        return res.status(404).json({ error: "no active release found for this event" });
      }

      await db.logDeployEvent(release.id, event_type, detail);

      if (event_type === "deploy_started") {
        await db.setReleaseStatus(release.id, "deploying");
        await slackClient.chat.postMessage({
          channel: release.slack_channel,
          thread_ts: release.slack_thread_ts,
          text: `:hourglass_flowing_sand: Deploy started for release #${release.id} (${tag || "unreleased"}).`,
        });
      } else if (event_type === "deploy_succeeded") {
        await db.setReleaseStatus(release.id, "deployed");
        await slackClient.chat.postMessage({
          channel: release.slack_channel,
          thread_ts: release.slack_thread_ts,
          text: `:white_check_mark: Release #${release.id} deployed successfully.`,
        });
      } else if (event_type === "deploy_failed" || event_type === "health_check_failed") {
        await db.setReleaseStatus(release.id, "failed");

        // If Copilot fails to summarize (subprocess hiccup, timeout, etc.),
        // fall back to a plain message rather than losing the whole
        // notification — the rollback buttons matter more than the summary.
        let summary = "No details provided.";
        if (detail) {
          try {
            summary = await summarizeFailure(detail);
          } catch (err) {
            console.error("summarizeFailure failed, falling back to raw detail:", err);
            summary = `(AI summary unavailable) ${String(detail).slice(0, 300)}`;
          }
        }

        await slackClient.chat.postMessage({
          channel: release.slack_channel,
          thread_ts: release.slack_thread_ts,
          text: "Deploy failure detected",
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:rotating_light: *Deploy issue detected for release #${release.id}*\n${summary}`,
              },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Roll back now?" },
                  style: "danger",
                  action_id: "confirm_rollback",
                  value: String(release.id),
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "Not yet — investigating" },
                  action_id: "cancel_rollback",
                  value: String(release.id),
                },
              ],
            },
          ],
        });
      }

      res.json({ ok: true });
    } catch (error) {
      console.error("Error handling deploy-event webhook:", error);
      res.status(500).json({ error: "internal error, see server logs" });
    }
  });

  return router;
}

module.exports = { createWebhookRouter };
