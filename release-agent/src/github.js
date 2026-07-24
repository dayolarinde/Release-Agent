const { Octokit } = require("@octokit/rest");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;

/**
 * Returns merged PRs since the most recent tag (or all recent merged PRs
 * if no tags exist yet), each with title, number, author, and labels.
 */
async function getMergedPRsSinceLastTag() {
  const { data: tags } = await octokit.repos.listTags({ owner, repo, per_page: 1 });
  let sinceDate = null;

  if (tags.length > 0) {
    const { data: tagCommit } = await octokit.repos.getCommit({
      owner,
      repo,
      ref: tags[0].commit.sha,
    });
    sinceDate = tagCommit.commit.committer.date;
  }

  const { data: prs } = await octokit.pulls.list({
    owner,
    repo,
    state: "closed",
    base: "main",
    sort: "updated",
    direction: "desc",
    per_page: 50,
  });

  return prs
    .filter((pr) => pr.merged_at)
    .filter((pr) => !sinceDate || new Date(pr.merged_at) > new Date(sinceDate))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user.login,
      labels: pr.labels.map((l) => l.name),
      url: pr.html_url,
    }));
}

async function getLatestTag() {
  const { data: tags } = await octokit.repos.listTags({ owner, repo, per_page: 1 });
  return tags.length > 0 ? tags[0].name : null;
}

module.exports = { getMergedPRsSinceLastTag, getLatestTag };
