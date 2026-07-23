const fetch = require("node-fetch");

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";

async function callClaude(prompt, maxTokens = 1000) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Claude API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
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

  return callClaude(prompt, 1200);
}

async function summarizeFailure(logExcerpt) {
  const prompt = `Summarize this CI/deploy failure log in 2-3 plain-English sentences for a Slack message aimed at a release manager who isn't deep in the logs. Focus on what failed and the likely cause if apparent. Do not include the raw log.

Log:
${logExcerpt}`;

  return callClaude(prompt, 300);
}

module.exports = { draftChangelog, summarizeFailure };
