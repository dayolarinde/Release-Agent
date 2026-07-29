const db = require("../db");
const { getMergedPRsForBranch, branchExists } = require("../github");
const { draftChangelog } = require("../ai");

function buildChecklistBlocks(release) {
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Release checklist* — branch \`${release.branch}\`` },
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

function formatReleaseSummary(release) {
  const done = release.checklist.filter((i) => i.done).length;
  return `*Release #${release.id}* (branch \`${release.branch}\`) — status: *${release.status}*\nChecklist: ${done}/${release.checklist.length} complete`;
}

function registerCommands(app) {
  app.command("/release", async ({ command, ack, respond, client }) => {
    await ack();
    const args = command.text.trim().split(/\s+/).filter(Boolean);
    const sub = args[0];
    const branch = args[1];

    try {
      if (sub === "cut") {
        if (!branch) {
          await respond("Usage: `/release cut <branch-name>` — e.g. `/release cut release/2026-08-01`");
          return;
        }

        const exists = await branchExists(branch);
        if (!exists) {
          await respond(`:warning: Branch \`${branch}\` doesn't exist in the repo. Double-check the name and try again.`);
          return;
        }

        const prs = await getMergedPRsForBranch(branch);
        const changelog = await draftChangelog(prs);

        const posted = await client.chat.postMessage({
          channel: process.env.SLACK_RELEASE_CHANNEL,
          text: "New release cut",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `*:rocket: New release draft — \`${branch}\`*` } },
            { type: "divider" },
            { type: "section", text: { type: "mrkdwn", text: changelog.slice(0, 2900) } },
          ],
        });

        let release;
        try {
          release = await db.createRelease({
            branch,
            slackChannel: posted.channel,
            slackThreadTs: posted.ts,
            changelog,
          });
        } catch (err) {
          // Thrown by db.createRelease when this branch already has an
          // active release (see the partial unique index in db.js).
          await respond(`:warning: ${err.message}`);
          return;
        }

        await client.chat.postMessage({
          channel: posted.channel,
          thread_ts: posted.ts,
          text: "Approval checklist",
          blocks: buildChecklistBlocks(release),
        });

        await respond(`Release #${release.id} drafted for \`${branch}\`. Changelog and checklist posted to <#${process.env.SLACK_RELEASE_CHANNEL}>.`);
        return;
      }

      if (sub === "status") {
        if (!branch) {
          // No branch given -- show every release currently in flight.
          const releases = await db.getAllActiveReleases();
          if (releases.length === 0) {
            await respond("No releases currently in progress.");
            return;
          }
          const summary = releases.map(formatReleaseSummary).join("\n\n");
          await respond(summary);
          return;
        }

        const release = await db.getActiveReleaseByBranch(branch);
        if (!release) {
          await respond(`No active release in progress for \`${branch}\`.`);
          return;
        }
        await respond(formatReleaseSummary(release));
        return;
      }

      if (sub === "rollback") {
        if (!branch) {
          await respond("Usage: `/release rollback <branch-name>`");
          return;
        }

        const release = await db.getActiveReleaseByBranch(branch);
        if (!release) {
          await respond(`No active release for \`${branch}\` to roll back.`);
          return;
        }
        await client.chat.postMessage({
          channel: release.slack_channel,
          thread_ts: release.slack_thread_ts,
          text: "Rollback requested",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: `:warning: Rollback requested for release #${release.id} (\`${release.branch}\`) by <@${command.user_id}>.` },
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

      await respond("Usage: `/release cut <branch>`, `/release status [branch]`, or `/release rollback <branch>`");
    } catch (error) {
      console.error("Error handling /release command:", error);
      await respond(`:warning: Something went wrong running that command: ${error.message}\nCheck the Render logs for the full error.`);
    }
  });
}

module.exports = { registerCommands, buildChecklistBlocks };
