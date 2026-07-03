async function collectCommitters(octokit, { owner, repo, prNumber }) {
  const accounts = new Map();
  const unlinked = [];
  const iterator = octokit.paginate.iterator(octokit.rest.pulls.listCommits, {
    owner, repo, pull_number: prNumber, per_page: 100,
  });
  for await (const { data } of iterator) {
    for (const c of data) {
      for (const role of ['author', 'committer']) {
        const account = c[role];
        if (account && account.login) {
          if (account.login === 'web-flow') continue;
          accounts.set(account.id, account.login);
        } else {
          const rawEmail = (c.commit && c.commit[role] && c.commit[role].email) || '';
          if (role === 'committer' && rawEmail === 'noreply@github.com') continue;
          unlinked.push({ sha: c.sha.slice(0, 7), role });
        }
      }
    }
  }
  return { accounts, unlinked };
}

function parseAllowlist(raw) {
  return new Set(String(raw || '').split(',').map((s) => s.trim()).filter(Boolean));
}

function filterAllowlisted(accounts, allow) {
  const out = new Map();
  for (const [id, login] of accounts) {
    if (!allow.has(login)) out.set(id, login);
  }
  return out;
}

module.exports = { collectCommitters, parseAllowlist, filterAllowlisted };
