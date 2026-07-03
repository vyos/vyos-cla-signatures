const { test } = require('node:test');
const assert = require('node:assert');
const { collectCommitters, parseAllowlist, filterAllowlisted } = require('../src/committers');

function fakeOctokit(pages) {
  return {
    rest: { pulls: { listCommits: 'listCommits' } },
    paginate: {
      async *iterator(fn, params) {
        assert.strictEqual(fn, 'listCommits');
        assert.strictEqual(params.per_page, 100);
        for (const page of pages) yield { data: page };
      },
    },
  };
}

const commit = ({ sha = 'a'.repeat(40), author, committer, rawAuthorEmail = 'a@x', rawCommitterEmail = 'c@x' } = {}) => ({
  sha,
  author,
  committer,
  commit: { author: { email: rawAuthorEmail }, committer: { email: rawCommitterEmail } },
});

test('collects author+committer logins keyed by id, ignores web-flow', async () => {
  const pages = [[
    commit({ author: { login: 'alice', id: 1 }, committer: { login: 'web-flow', id: 19864447 } }),
    commit({ author: { login: 'bob', id: 2 }, committer: { login: 'bob', id: 2 } }),
  ]];
  const { accounts, unlinked } = await collectCommitters(fakeOctokit(pages), { owner: 'o', repo: 'r', prNumber: 1 });
  assert.deepStrictEqual([...accounts.entries()].sort(), [[1, 'alice'], [2, 'bob']]);
  assert.deepStrictEqual(unlinked, []);
});

test('null author -> unlinked with role+short sha', async () => {
  const pages = [[commit({ sha: 'abcdef0123456789'.padEnd(40, '0'), author: null, committer: { login: 'bob', id: 2 } })]];
  const { unlinked } = await collectCommitters(fakeOctokit(pages), { owner: 'o', repo: 'r', prNumber: 1 });
  assert.deepStrictEqual(unlinked, [{ sha: 'abcdef0', role: 'author' }]);
});

test('null committer -> unlinked, EXCEPT raw noreply@github.com', async () => {
  const pages = [[
    commit({ sha: '1'.repeat(40), author: { login: 'a', id: 1 }, committer: null, rawCommitterEmail: 'noreply@github.com' }),
    commit({ sha: '2'.repeat(40), author: { login: 'a', id: 1 }, committer: null, rawCommitterEmail: 'someone@corp.example' }),
  ]];
  const { unlinked } = await collectCommitters(fakeOctokit(pages), { owner: 'o', repo: 'r', prNumber: 1 });
  assert.deepStrictEqual(unlinked, [{ sha: '2222222', role: 'committer' }]);
});

test('paginates past 100 commits', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => commit({ author: { login: `u${i}`, id: i + 1 }, committer: { login: `u${i}`, id: i + 1 } }));
  const page2 = [commit({ author: { login: 'last', id: 999 }, committer: { login: 'last', id: 999 } })];
  const { accounts } = await collectCommitters(fakeOctokit([page1, page2]), { owner: 'o', repo: 'r', prNumber: 1 });
  assert.strictEqual(accounts.size, 101);
});

test('parseAllowlist trims the live folded-YAML shape and drops empties', () => {
  const live = 'github-actions[bot],\n dependabot-preview[bot],\n insights-engineering-bot,\n dependabot[bot],\n copilot,\n github-copilot[bot],\n copilot[bot],\n Copilot,\n vyosbot,\n pre-commit-ci,\n pre-commit-ci[bot],\n codecov,\n codecov[bot],\n mergify,\n mergify[bot],\n netlify,\n netlify[bot],\n claude,\n claude[bot],\n coderabbitai,\n coderabbitai[bot]';
  const set = parseAllowlist(live);
  assert.strictEqual(set.size, 20); // copilot + Copilot collapse under case-insensitive matching
  assert.ok(set.has('dependabot[bot]'));
  assert.ok(set.has('coderabbitai[bot]'));
  assert.ok(!set.has(' dependabot[bot]'));
});

test('allowlist matching is case-insensitive', () => {
  const accounts = new Map([[1, 'Copilot'], [2, 'alice']]);
  const out = filterAllowlisted(accounts, parseAllowlist('copilot'));
  assert.deepStrictEqual([...out.entries()], [[2, 'alice']]);
});

test('filterAllowlisted removes exact-login matches only', () => {
  const accounts = new Map([[1, 'alice'], [2, 'mergify[bot]']]);
  const out = filterAllowlisted(accounts, new Set(['mergify[bot]']));
  assert.deepStrictEqual([...out.entries()], [[1, 'alice']]);
});
