const { Octokit } = require("@octokit/rest");

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.GITHUB_OWNER;
const repo = process.env.GITHUB_REPO;

/**
 * Returns merged PRs whose base branch is the given release branch (e.g.
 * "release/2026-08-01"), each with title, number, author, and labels.
 *
 * Note: this intentionally does not filter by "since the last tag" the way
 * an earlier main-only version of this function did -- tags are usually
 * repo-wide, not branch-specific, so that filter doesn't map cleanly onto
 * a per-branch release flow. If you later want "since the last tag on
 * this branch specifically," that needs walking the branch's commit
 * history for reachable tags, which is a heavier API call than this POC
 * currently makes.
 */
async function getMergedPRsForBranch(branch) {
  if (!branch) {
    throw new Error("getMergedPRsForBranch requires a branch name");
  }

  const { data: prs } = await octokit.pulls.list({
    owner,
    repo,
    state: "closed",
    base: branch,
    sort: "updated",
    direction: "desc",
    per_page: 50,
  });

  return prs
    .filter((pr) => pr.merged_at)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.user.login,
      labels: pr.labels.map((l) => l.name),
      url: pr.html_url,
    }));
}

/**
 * Confirms a branch actually exists in the repo before we try to use it.
 * Useful for catching typos in /release cut <branch> early, with a clear
 * error, rather than silently returning an empty changelog.
 */
async function branchExists(branch) {
  try {
    await octokit.repos.getBranch({ owner, repo, branch });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

module.exports = { getMergedPRsForBranch, branchExists };
