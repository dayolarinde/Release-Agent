const db = require("../db");
const { buildChecklistBlocks } = require("./commands");

function registerInteractions(app) {
  // Matches action_ids like checklist_qa_signoff, checklist_docs_updated, etc.
  app.action(/^checklist_/, async ({ ack, body, action, client }) => {
    await ack();
    try {
      const { releaseId, itemId } = JSON.parse(action.value);
      const doneBy = body.user.id;

      await db.markChecklistItem(releaseId, itemId, doneBy);
      const release = await db.getRelease(releaseId);

      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: "Approval checklist",
        blocks: buildChecklistBlocks(release),
      });

      if (await db.isChecklistComplete(releaseId)) {
        await db.setReleaseStatus(releaseId, "ready to deploy");
        await client.chat.postMessage({
          channel: release.slack_channel,
          text: `:white_check_mark: All checklist items complete for \`${release.branch}\`. Ready to deploy.`,
        });
      }
    } catch (error) {
      // ack() already told Slack "received" before this runs, so any
      // error here otherwise fails silently -- the button just appears
      // to do nothing, with no visible sign anything went wrong. Logging
      // and posting an ephemeral note makes the real failure visible
      // instead of looking like a dead button.
      console.error("Error handling checklist button click:", error);
      await client.chat
        .postEphemeral({
          channel: body.channel.id,
          user: body.user.id,
          text: `:warning: Something went wrong updating the checklist: ${error.message}. Check Render logs for details.`,
        })
        .catch(() => {});
    }
  });

  app.action("confirm_rollback", async ({ ack, body, action, client }) => {
    await ack();
    try {
      const releaseId = Number(action.value);
      const release = await db.setReleaseStatus(releaseId, "rolled back");
      await db.logDeployEvent(releaseId, "rolled back", `Confirmed by ${body.user.id}`);

      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `Rollback confirmed for \`${release.branch}\` by <@${body.user.id}>. Trigger your rollback pipeline now.`,
        blocks: [],
      });
    } catch (error) {
      console.error("Error handling confirm_rollback button click:", error);
      await client.chat
        .postEphemeral({
          channel: body.channel.id,
          user: body.user.id,
          text: `:warning: Something went wrong confirming the rollback: ${error.message}. Check Render logs for details.`,
        })
        .catch(() => {});
    }
  });

  app.action("cancel_rollback", async ({ ack, body, client }) => {
    await ack();
    try {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: "Rollback cancelled.",
        blocks: [],
      });
    } catch (error) {
      console.error("Error handling cancel_rollback button click:", error);
      await client.chat
        .postEphemeral({
          channel: body.channel.id,
          user: body.user.id,
          text: `:warning: Something went wrong cancelling the rollback: ${error.message}. Check Render logs for details.`,
        })
        .catch(() => {});
    }
  });
}

module.exports = { registerInteractions };
