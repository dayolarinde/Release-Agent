const db = require("../db");
const { getMergedPRsSinceLastTag } = require("../github");
const { draftChangelog } = require("../ai");

function buildChecklistBlocks(release) {
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Release checklist* — tag \`${release.tag || "unreleased"}\`` },
    },
    { type: "divider" },
  ];

  for (const item of release.checklist) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${item.done ? "✅" : "⬜"} ${item.label}${item.done ? `  _(by <@${item.done_by}>)_` : ""}`,
      },
      accessory: item.done
        ? undefined
        : {
            type: "button",
            text: { type: "plain_text", text: "Mark done" },
            action_id: `checklist_${item.item_id}`,
            value: JSON.stringify({ releaseId: release.id, itemId: item.item_id }),
          },
    });
  }

  return blocks;
}

function registerCommands(app) {
  app.command("/release", async ({ command, ack, respond, client }) => {
    await ack();
    const [sub] = command.text.trim().split(/\s+/);

    try {
      if (sub === "cut" || command.text.trim() === "") {
        const prs = await getMergedPRsSinceLastTag();
        const changelog = await draftChangelog(prs);

        const posted = await client.chat.postMessage({
          channel: process.env.SLACK_RELEASE_CHANNEL,
          text: "New release cut",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: "*:rocket: New release draft*" } },
            { type: "divider" },
            { type: "section", text: { type: "mrkdwn", text: changelog.slice(0, 2900) } },
          ],
        });

        const release = await db.createRelease({
          slackChannel: posted.channel,
          slackThreadTs: posted.ts,
          changelog,
        });

        await client.chat.postMessage({
          channel: posted.channel,
          thread_ts: posted.ts,
          text: "Approval checklist",
          blocks: buildChecklistBlocks(release),
        });

        await respond(`Release #${release.id} drafted. Changelog and checklist posted to <#${process.env.SLACK_RELEASE_CHANNEL}>.`);
        return;
      }

      if (sub === "status") {
        const release = await db.getCurrentRelease();
        if (!release) {
          await respond("No release currently in progress.");
          return;
        }
        const done = release.checklist.filter((i) => i.done).length;
        await respond(
          `*Release #${release.id}* (${release.tag || "unreleased"}) — status: *${release.status}*\nChecklist: ${done}/${release.checklist.length} complete`
        );
        return;
      }

      if (sub === "rollback") {
        const release = await db.getCurrentRelease();
        if (!release) {
          await respond("No active release to roll back.");
          return;
        }
        await client.chat.postMessage({
          channel: release.slack_channel,
          thread_ts: release.slack_thread_ts,
          text: "Rollback requested",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: `:warning: Rollback requested for release #${release.id} by <@${command.user_id}>.` },
            },
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Confirm rollback" },
                  style: "danger",
                  action_id: "confirm_rollback",
                  value: String(release.id),
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "Cancel" },
                  action_id: "cancel_rollback",
                  value: String(release.id),
                },
              ],
            },
          ],
        });
        await respond("Rollback confirmation posted — nothing will happen until it's confirmed.");
        return;
      }

      await respond("Usage: `/release cut`, `/release status`, or `/release rollback`");
    } catch (error) {
      console.error("Error handling /release command:", error);
      await respond(`:warning: Something went wrong running that command: ${error.message}\nCheck the Render logs for the full error.`);
    }
  });
}

module.exports = { registerCommands, buildChecklistBlocks };
