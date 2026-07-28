require("dotenv").config();
const { App, ExpressReceiver } = require("@slack/bolt");
const { registerCommands } = require("./slack/commands");
const { registerInteractions } = require("./slack/interactions");
const { createWebhookRouter } = require("./webhooks");
const { initSchema } = require("./db");

// Last line of defense: log instead of crashing the whole process. This is
// what was silently taking the service down before — an uncaught error
// somewhere (e.g. the Copilot SDK's subprocess) would otherwise kill the
// entire backend, dropping whatever request was in flight (and any others
// that land before Render finishes restarting it).
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (process kept alive):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (process kept alive):", err);
});

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

Adobe Acrobat


Summarize this


Ask AI Assistant
