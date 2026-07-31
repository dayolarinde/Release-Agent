const db = require("../db");
const { buildChecklistBlocks } = require("./commands");

function registerInteractions(app) {
  // Matches action_ids like checklist_qa_signoff, checklist_docs_updated, etc.
  app.action(/^checklist_/, async ({ ack, body, action, client }) => {
    await ack();
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
        thread_ts: release.slack_thread_ts,
        text: `:white_check_mark: All checklist items complete for \`${release.branch}\`. Ready to deploy.`,
      });
    }
  });

  app.action("confirm_rollback", async ({ ack, body, action, client }) => {
    await ack();
    const releaseId = Number(action.value);
    const release = await db.setReleaseStatus(releaseId, "rolled back");
    await db.logDeployEvent(releaseId, "rolled back", `Confirmed by ${body.user.id}`);

    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: `Rollback confirmed for \`${release.branch}\` by <@${body.user.id}>. Trigger your rollback pipeline now.`,
      blocks: [],
    });
  });

  app.action("cancel_rollback", async ({ ack, body, client }) => {
    await ack();
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: "Rollback cancelled.",
      blocks: [],
    });
  });
}

module.exports = { registerInteractions };
