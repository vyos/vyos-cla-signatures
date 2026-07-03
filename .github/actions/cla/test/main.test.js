const { test } = require('node:test');
const assert = require('node:assert');
const { run } = require('../src/main');
const { SIGN_PHRASE, MARKER, BOT_LOGIN } = require('../src/constants');

function makeDeps({ eventName, payload, commits, sigEntries, comments = [] }) {
  const log = { failed: null, infos: [], warnings: [], sigPuts: [], reruns: [], comments };
  const repoOctokit = {
    rest: {
      pulls: {
        get: async () => ({ data: { number: 7, head: { sha: 'headsha' }, base: { repo: { id: 555 } } } }),
        listCommits: 'listCommits',
      },
      issues: {
        listComments: 'listComments',
        createComment: async ({ body }) => { const c = { id: 900 + log.comments.length, body, user: { login: BOT_LOGIN }, created_at: 'now' }; log.comments.push(c); return { data: c }; },
        updateComment: async ({ comment_id, body }) => {
          const c = log.comments.find((x) => x.id === comment_id); c.body = body; return { data: c };
        },
        deleteComment: async () => {},
      },
      actions: {
        getWorkflowRun: async () => ({ data: { id: 100, workflow_id: 77 } }),
        listWorkflowRuns: async () => ({ data: { workflow_runs: [{ id: 95, workflow_id: 77, status: 'completed', created_at: '2026-07-02T00:00:00Z' }] } }),
        reRunWorkflowFailedJobs: async ({ run_id }) => { log.reruns.push(run_id); },
        reRunWorkflow: async ({ run_id }) => { log.reruns.push(run_id); },
      },
    },
    paginate: Object.assign(async (fn) => { assert.strictEqual(fn, 'listComments'); return log.comments; }, {
      iterator: async function* (fn) { assert.strictEqual(fn, 'listCommits'); yield { data: commits }; },
    }),
  };
  const state = { entries: sigEntries };
  const sigOctokit = {
    rest: { repos: {
      getContent: async () => {
        if (state.entries === null) { const e = new Error('nf'); e.status = 404; throw e; }
        return { data: { content: Buffer.from(JSON.stringify({ signedContributors: state.entries }, null, 2)).toString('base64'), sha: 's1' } };
      },
      createOrUpdateFileContents: async (params) => {
        log.sigPuts.push(params);
        const written = JSON.parse(Buffer.from(params.content, 'base64').toString('utf8')).signedContributors;
        state.entries = written;
        return { data: {} };
      },
    } },
  };
  const core = {
    getInput: (name) => ({
      'signature-token': 'placeholder-token-input', 'signatures-repo': 'vyos/vyos-cla-signatures', 'signatures-branch': 'production',
      'signatures-path': 'signatures/version1/cla.json', 'document-url': 'https://doc', allowlist: 'mergify[bot]',
    })[name] || '',
    info: (m) => log.infos.push(m),
    warning: (m) => log.warnings.push(m),
    setFailed: (m) => { log.failed = m; },
  };
  const deps = {
    core,
    context: { eventName, payload, repo: { owner: 'vyos', repo: 'vyos-1x' }, runId: 100 },
    repoOctokit,
    sigOctokit,
  };
  return { deps, log, state };
}

const commitBy = (login, id) => ({ sha: 'c'.repeat(40), author: { login, id }, committer: { login, id }, commit: { author: { email: 'x@x' }, committer: { email: 'x@x' } } });

test('check event, all signed, NO existing comment -> passes, NO comment created (spec §4.3), no rerun', async () => {
  const { deps, log } = makeDeps({
    eventName: 'pull_request_target',
    payload: { action: 'opened', pull_request: { number: 7 } },
    commits: [commitBy('alice', 1001)],
    sigEntries: [{ name: 'alice', id: 1001 }],
  });
  await run(deps);
  assert.strictEqual(log.failed, null);
  assert.strictEqual(log.comments.length, 0);
  assert.deepStrictEqual(log.reruns, []);
});

test('check event, all signed, existing bot comment -> edited to all-signed', async () => {
  const { deps, log } = makeDeps({
    eventName: 'pull_request_target',
    payload: { action: 'opened', pull_request: { number: 7 } },
    commits: [commitBy('alice', 1001)],
    sigEntries: [{ name: 'alice', id: 1001 }],
    comments: [{ id: 5, body: `${MARKER}\nplease sign`, user: { login: BOT_LOGIN }, created_at: 'x' }],
  });
  await run(deps);
  assert.strictEqual(log.failed, null);
  assert.ok(log.comments[0].body.includes('All contributors have signed'));
});

test('check event, unsigned -> fails, comment lists unsigned', async () => {
  const { deps, log } = makeDeps({
    eventName: 'pull_request_target',
    payload: { action: 'opened', pull_request: { number: 7 } },
    commits: [commitBy('bob', 2002)],
    sigEntries: [],
  });
  await run(deps);
  assert.ok(log.failed && log.failed.includes('bob'));
  assert.ok(log.comments[0].body.includes('⬜ @bob'));
});

test('allowlisted bot alone -> passes without signature', async () => {
  const { deps, log } = makeDeps({
    eventName: 'pull_request_target',
    payload: { action: 'opened', pull_request: { number: 7 } },
    commits: [commitBy('mergify[bot]', 3)],
    sigEntries: [],
  });
  await run(deps);
  assert.strictEqual(log.failed, null);
});

test('sign flow: unsigned commenter -> entry written, check green, comment edited, PR-head rerun fired', async () => {
  const payload = {
    action: 'created',
    issue: { number: 7, pull_request: { url: 'x' } },
    comment: { id: 42, body: SIGN_PHRASE, created_at: '2026-07-03T00:00:00Z', user: { login: 'bob', id: 2002 } },
  };
  const { deps, log } = makeDeps({
    eventName: 'issue_comment', payload, commits: [commitBy('bob', 2002)], sigEntries: [],
    comments: [{ id: 5, body: `${MARKER}\nplease sign`, user: { login: BOT_LOGIN }, created_at: 'x' }], // the earlier unsigned run posted it
  });
  await run(deps);
  assert.strictEqual(log.sigPuts.length, 1);
  assert.strictEqual(log.sigPuts[0].message, '@bob has signed the CLA in vyos/vyos-1x#7');
  const entry = JSON.parse(Buffer.from(log.sigPuts[0].content, 'base64').toString('utf8')).signedContributors[0];
  assert.deepStrictEqual(entry, { name: 'bob', id: 2002, comment_id: 42, created_at: '2026-07-03T00:00:00Z', repoId: 555, pullRequestNo: 7 });
  assert.strictEqual(log.failed, null);
  assert.ok(log.comments[0].body.includes('All contributors have signed')); // existing comment edited, not duplicated
  assert.deepStrictEqual(log.reruns, [95]);
});

test('sign comment by non-committer -> no write, outcome unchanged', async () => {
  const payload = {
    action: 'created',
    issue: { number: 7, pull_request: { url: 'x' } },
    comment: { id: 42, body: SIGN_PHRASE, created_at: 'now', user: { login: 'stranger', id: 9999 } },
  };
  const { deps, log } = makeDeps({ eventName: 'issue_comment', payload, commits: [commitBy('bob', 2002)], sigEntries: [] });
  await run(deps);
  assert.strictEqual(log.sigPuts.length, 0);
  assert.ok(log.failed);
});

test('recheck when all signed -> passes + rerun fired', async () => {
  const payload = { action: 'created', issue: { number: 7, pull_request: { url: 'x' } }, comment: { id: 1, body: 'recheck', created_at: 'now', user: { login: 'x', id: 1 } } };
  const { deps, log } = makeDeps({ eventName: 'issue_comment', payload, commits: [commitBy('alice', 1001)], sigEntries: [{ name: 'alice', id: 1001 }] });
  await run(deps);
  assert.strictEqual(log.failed, null);
  assert.deepStrictEqual(log.reruns, [95]);
});

test('closed PR event -> noop (no API calls, no failure)', async () => {
  const { deps, log } = makeDeps({ eventName: 'pull_request_target', payload: { action: 'closed', pull_request: { number: 7 } }, commits: [], sigEntries: [] });
  await run(deps);
  assert.strictEqual(log.failed, null);
  assert.strictEqual(log.comments.length, 0);
});

test('comment on plain issue -> noop', async () => {
  const payload = { action: 'created', issue: { number: 7 }, comment: { id: 1, body: SIGN_PHRASE, created_at: 'now', user: { login: 'x', id: 1 } } };
  const { deps, log } = makeDeps({ eventName: 'issue_comment', payload, commits: [], sigEntries: [] });
  await run(deps);
  assert.strictEqual(log.failed, null);
  assert.strictEqual(log.comments.length, 0);
});

test('unsigned + comment post fails -> job still fails with warning', async () => {
  const { deps, log } = makeDeps({
    eventName: 'pull_request_target',
    payload: { action: 'opened', pull_request: { number: 7 } },
    commits: [commitBy('bob', 2002)],
    sigEntries: [],
  });
  deps.repoOctokit.rest.issues.createComment = async () => { const e = new Error('403'); e.status = 403; throw e; };
  await run(deps);
  assert.ok(log.failed);
  assert.strictEqual(log.warnings.length, 1);
});

test('all-signed + comment edit fails -> passes with warning', async () => {
  const { deps, log } = makeDeps({
    eventName: 'pull_request_target',
    payload: { action: 'opened', pull_request: { number: 7 } },
    commits: [commitBy('alice', 1001)],
    sigEntries: [{ name: 'alice', id: 1001 }],
    comments: [{ id: 5, body: `${MARKER}\nold`, user: { login: BOT_LOGIN }, created_at: 'x' }],
  });
  deps.repoOctokit.rest.issues.updateComment = async () => { const e = new Error('500'); e.status = 500; throw e; };
  await run(deps);
  assert.strictEqual(log.failed, null);
  assert.strictEqual(log.warnings.length, 1);
});
