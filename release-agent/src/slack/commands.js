const db = require("../db");
const { getMergedPRsForBranch, branchExists } = require("../github");
const { draftChangelog } = require("../ai");
const { buildReleaseNotesDocx } = require("../release-notes-docx");

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

function buildChangelogBlocks(branch, changelog) {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*:rocket: New release draft — \`${branch}\`*` } },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: changelog.slice(0, 2900) } },
  ];
}

function formatReleaseSummary(release) {
  const done = release.checklist.filter((i) => i.done).length;
  const stageIcons = { pending: "⬜", deploying: "⏳", deployed: "✅", failed: "🔴" };
  const stageLine = release.stages
    .map((s) => `${stageIcons[s.status] || "⬜"} ${s.environment}`)
    .join("  →  ");

  const startedStages = release.stages.filter((s) => s.started_at);
  let lastMergeLine = "\nLast merge: none yet";
  if (startedStages.length > 0) {
    const latest = startedStages.reduce((a, b) =>
      new Date(a.started_at) > new Date(b.started_at) ? a : b
    );
    const when = new Date(latest.started_at).toISOString().slice(0, 16).replace("T", " ");
    lastMergeLine = `\nLast merge: \`${latest.environment}\` at ${when} UTC`;
  }

  return `*Release for \`${release.branch}\`* — status: *${release.status}*\nChecklist: ${done}/${release.checklist.length} complete\nStages: ${stageLine}${lastMergeLine}`;
}

/**
 * Posts the live, clickable checklist as a top-level message in the
 * release channel -- deliberately NOT threaded under the original
 * changelog message. A threaded reply gets collapsed in the channel view
 * (shows as "N replies", requiring a click to expand), which defeats the
 * point of wanting the checklist immediately visible. This does mean
 * checklists for different releases will appear as separate messages
 * interleaved in the channel rather than nested under their own thread --
 * each one's header still names its branch, so they stay identifiable.
 *
 * Still has to be a real posted message rather than an ephemeral
 * slash-command reply -- Slack ephemeral messages can't be updated via
 * chat.update the way the checklist button handler in interactions.js
 * expects, only regular channel messages can.
 */
async function postChecklistToThread(client, release) {
  await client.chat.postMessage({
    channel: release.slack_channel,
    text: "Approval checklist",
    blocks: buildChecklistBlocks(release),
  });
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
          blocks: buildChangelogBlocks(branch, changelog),
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

        await postChecklistToThread(client, release);

        await respond(`Release drafted for \`${branch}\`. Changelog and checklist posted to <#${process.env.SLACK_RELEASE_CHANNEL}>.`);
        return;
      }

      if (sub === "notes") {
        if (!branch) {
          await respond("Usage: `/release notes <branch-name>` — regenerates release notes from PRs merged since the release was cut, and attaches a Word doc copy");
          return;
        }

        const release = await db.getActiveReleaseByBranch(branch);
        if (!release) {
          await respond(`No active release in progress for \`${branch}\`.`);
          return;
        }

        const prs = await getMergedPRsForBranch(branch);
        const changelog = await draftChangelog(prs);
        await db.updateChangelog(release.id, changelog);

        // Updates the original changelog message in place, rather than
        // posting a new one -- slack_thread_ts is that original message's
        // own ts (it's the thread parent), so this is a safe, real
        // chat.update on a regular posted message, same as the checklist
        // button handler relies on elsewhere.
        await client.chat.update({
          channel: release.slack_channel,
          ts: release.slack_thread_ts,
          text: "New release cut",
          blocks: buildChangelogBlocks(branch, changelog),
        });

        // Word doc attachment, best-effort: if doc generation or the
        // Slack upload fails, the text changelog above has already been
        // updated successfully, so this shouldn't block on that failure --
        // just note it happened rather than losing the whole command.
        try {
          const docxBuffer = await buildReleaseNotesDocx(branch, changelog);
          await client.files.uploadV2({
            channel_id: release.slack_channel,
            file: docxBuffer,
            filename: `${branch}-release-notes.docx`,
            title: `Release notes — ${branch}`,
          });
        } catch (err) {
          console.error("Failed to generate/upload release notes docx:", err);
          await client.chat.postMessage({
            channel: release.slack_channel,
            text: ":warning: Release notes updated above, but the Word doc attachment failed to generate. Check Render logs for details.",
          });
        }

        await respond(`Release notes refreshed for \`${branch}\`.`);
        return;
      }

      if (sub === "status") {
        if (!branch) {
          // No branch given -- show every release currently in flight.
          // Skips posting individual checklists here since there could be
          // several releases active at once; that would get noisy fast.
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
        await postChecklistToThread(client, release);

        // Live PR list, best-effort: a GitHub API hiccup here shouldn't
        // block the rest of the status response from going out.
        let prSection;
        try {
          const prs = await getMergedPRsForBranch(branch);
          if (prs.length === 0) {
            prSection = "\n\n*Merged PRs:* none yet";
          } else {
            const prLines = prs
              .map((pr) => `• <${pr.url}|#${pr.number}> ${pr.title} (${pr.author})`)
              .join("\n");
            prSection = `\n\n*Merged PRs (${prs.length}):*\n${prLines}`;
          }
        } catch (err) {
          console.error("Failed to fetch merged PRs for status command:", err);
          prSection = "\n\n_(Couldn't fetch the merged PR list just now -- check Render logs)_";
        }

        await respond(formatReleaseSummary(release) + prSection);
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
        await postChecklistToThread(client, release);
        await client.chat.postMessage({
          channel: release.slack_channel,
          text: "Rollback requested",
          blocks: [
            {
              type: "section",
              text: { type: "mrkdwn", text: `:warning: Rollback requested for release \`${release.branch}\` by <@${command.user_id}>.` },
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

      await respond("Usage: `/release cut <branch>`, `/release notes <branch>`, `/release status [branch]`, or `/release rollback <branch>`");
    } catch (error) {
      console.error("Error handling /release command:", error);
      await respond(`:warning: Something went wrong running that command: ${error.message}\nCheck the Render logs for the full error.`);
    }
  });
}

module.exports = { registerCommands, buildChecklistBlocks };
