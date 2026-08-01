const express = require("express");
const crypto = require("crypto");
const db = require("./db");
const { summarizeFailure } = require("./ai");
const { getMergedPRsForBranch } = require("./github");

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
  // payload: { branch, environment, detail (optional log excerpt) }
  //
  // "environment" must match one of the stages configured in
  // config/environments.yaml (e.g. SIT, UAT, PROD). Each release tracks
  // these independently, in order -- see db.js's checkStageOrder().
  //
  // This expects whatever triggers your deploys to call this endpoint
  // directly with its own environment/branch context. An earlier version
  // relied on GitHub's workflow_run event instead, but that event doesn't
  // expose the original workflow's inputs (like which environment was
  // selected), so it couldn't support per-environment tracking. If your
  // real deploy pipeline is Copado (or anything else) rather than GitHub
  // Actions, point it at this same endpoint with the same payload shape --
  // see .github/workflows/deploy.yml for the reference pattern.
  router.post("/deploy-event", async (req, res) => {
    if (!verifySignature(req)) {
      return res.status(401).json({ error: "invalid signature" });
    }

    try {
      const { event_type, branch, environment, detail } = req.body;

      if (!branch) {
        return res.status(400).json({ error: "payload missing required 'branch' field" });
      }
      if (!environment) {
        return res.status(400).json({ error: "payload missing required 'environment' field" });
      }

      const release = await db.getActiveReleaseByBranch(branch);

      if (!release) {
        return res.status(404).json({ error: `no active release found for branch "${branch}"` });
      }

      await db.logDeployEvent(release.id, event_type, detail);

      if (event_type === "deploy_started") {
        const blocker = await db.checkStageOrder(release.id, environment);
        if (blocker) {
          return res.status(409).json({ error: blocker });
        }

        await db.setStageStatus(release.id, environment, "deploying");
        await db.updateReleaseStatusFromStage(release.id, environment, "deploying");

        // PR count: best-effort. A GitHub API hiccup here shouldn't block
        // the deploy-started notification itself from going out.
        let prCountText = "";
        try {
          const prs = await getMergedPRsForBranch(branch);
          prCountText = ` (${prs.length} PR${prs.length === 1 ? "" : "s"})`;
        } catch (err) {
          console.error("Failed to fetch PR count for deploy-started message:", err);
        }

        // Approver mentions: optional, from config/approvers.yaml. Silently
        // skipped (not an error) if that file doesn't exist or has no
        // entries for this environment.
        const approvers = db.loadApproversConfig();
        const mentionIds = approvers[environment] || [];
        const mentionText = mentionIds.length > 0
          ? `\ncc ${mentionIds.map((id) => `<@${id}>`).join(" ")}`
          : "";

        await slackClient.chat.postMessage({
          channel: release.slack_channel,
          thread_ts: release.slack_thread_ts,
          text: `:hourglass_flowing_sand: *${environment}* deploy started for \`${branch}\`${prCountText}.${mentionText}`,
        });
      } else if (event_type === "deploy_succeeded") {
        await db.setStageStatus(release.id, environment, "deployed");
        const updated = await db.updateReleaseStatusFromStage(release.id, environment, "deployed");
        const isFullyDone = updated.status === "deployed";

        await slackClient.chat.postMessage({
          channel: release.slack_channel,
          thread_ts: release.slack_thread_ts,
          text: isFullyDone
            ? `:tada: *${environment}* deploy succeeded for \`${branch}\` -- that was the last stage, release complete!`
            : `:white_check_mark: *${environment}* deploy succeeded for \`${branch}\`. Next stage is ready when you are.`,
        });
      } else if (event_type === "deploy_failed" || event_type === "health_check_failed") {
        await db.setStageStatus(release.id, environment, "failed");
        await db.updateReleaseStatusFromStage(release.id, environment, "failed");

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
                text: `:rotating_light: *${environment} deploy issue detected for \`${branch}\`*\n${summary}`,
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
