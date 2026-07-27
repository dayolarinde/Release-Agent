require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { registerCommands } = require("./slack/commands");
const { registerInteractions } = require("./slack/interactions");
const { createWebhookRouter } = require("./webhooks");
const { initSchema } = require("./db");

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// Capture raw body for GitHub webhook HMAC verification (Slack's receiver
// already parses its own routes separately).
receiver.app.use("/webhooks", require("express").json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  },
}));

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

registerCommands(app);
registerInteractions(app);

// Bolt's default error wrapping can hide the real cause behind a generic
// "unhandled error after ack()" message. This logs the full error so it's
// visible in Render's Logs tab.
app.error(async (error) => {
  console.error("Bolt global error handler caught:", error);
});

receiver.app.use("/webhooks", createWebhookRouter(app.client));

receiver.app.get("/healthz", (req, res) => res.json({ ok: true }));

(async () => {
  await initSchema();
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ release-agent running on port ${port}`);
})();
