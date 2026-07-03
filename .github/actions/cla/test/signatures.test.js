const { test } = require('node:test');
const assert = require('node:assert');
const { loadSignatures, matchSignatures, appendSignature } = require('../src/signatures');

const CFG = { owner: 'vyos', repo: 'vyos-cla-signatures', path: 'signatures/version1/cla.json', branch: 'production' };
const b64 = (obj) => Buffer.from(JSON.stringify(obj, null, 2)).toString('base64');

function storeOctokit(state) {
  // state: {entries: [...]|null (null = 404), rev, failPuts, putLog: []}
  return {
    rest: {
      repos: {
        getContent: async () => {
          if (state.entries === null) { const e = new Error('nf'); e.status = 404; throw e; }
          return { data: { content: b64({ signedContributors: state.entries }), sha: `sha-${state.rev}` } };
        },
        createOrUpdateFileContents: async (params) => {
          if (state.failPuts > 0) {
            state.failPuts -= 1;
            state.rev += 1; // simulate a concurrent writer bumping the blob
            const e = new Error('conflict'); e.status = 409; throw e;
          }
          state.putLog.push(params);
          const written = JSON.parse(Buffer.from(params.content, 'base64').toString('utf8')).signedContributors;
          state.entries = written;
          return { data: {} };
        },
      },
    },
  };
}

const ENTRY = { name: 'alice', id: 1001, comment_id: 42, created_at: '2026-07-03T00:00:00Z', repoId: 555, pullRequestNo: 7 };

test('loadSignatures returns entries + sha; 404 -> bootstrap shape', async () => {
  const ok = await loadSignatures(storeOctokit({ entries: [ENTRY], rev: 1, failPuts: 0, putLog: [] }), CFG);
  assert.strictEqual(ok.exists, true);
  assert.strictEqual(ok.entries.length, 1);
  assert.strictEqual(ok.sha, 'sha-1');
  const missing = await loadSignatures(storeOctokit({ entries: null, rev: 1, failPuts: 0, putLog: [] }), CFG);
  assert.deepStrictEqual(missing, { entries: [], sha: null, exists: false });
});

test('matchSignatures splits by numeric id', () => {
  const accounts = new Map([[1001, 'alice'], [2002, 'bob']]);
  const { signed, unsigned } = matchSignatures(accounts, [ENTRY]);
  assert.deepStrictEqual(signed, [{ id: 1001, login: 'alice' }]);
  assert.deepStrictEqual(unsigned, [{ id: 2002, login: 'bob' }]);
});

test('appendSignature writes entry with exact commit message + sha, live serialization (no trailing newline)', async () => {
  const state = { entries: [], rev: 1, failPuts: 0, putLog: [] };
  const res = await appendSignature(storeOctokit(state), CFG, ENTRY, { owner: 'vyos', repo: 'vyos-1x' });
  assert.strictEqual(res.written, true);
  const put = state.putLog[0];
  assert.strictEqual(put.message, '@alice has signed the CLA in vyos/vyos-1x#7');
  assert.strictEqual(put.branch, 'production');
  assert.strictEqual(put.sha, 'sha-1');
  const raw = Buffer.from(put.content, 'base64').toString('utf8');
  assert.strictEqual(raw, JSON.stringify({ signedContributors: [ENTRY] }, null, 2));
  assert.ok(!raw.endsWith('\n'));
});

test('appendSignature bootstraps missing file with NO sha param', async () => {
  const state = { entries: null, rev: 1, failPuts: 0, putLog: [] };
  await appendSignature(storeOctokit(state), CFG, ENTRY, { owner: 'o', repo: 'r' });
  assert.ok(!('sha' in state.putLog[0]));
});

test('appendSignature is idempotent: already-signed id -> no write', async () => {
  const state = { entries: [ENTRY], rev: 1, failPuts: 0, putLog: [] };
  const res = await appendSignature(storeOctokit(state), CFG, ENTRY, { owner: 'o', repo: 'r' });
  assert.deepStrictEqual(res, { written: false, reason: 'already-signed' });
  assert.strictEqual(state.putLog.length, 0);
});

test('409 conflict retries with refetch and succeeds', async () => {
  const state = { entries: [], rev: 1, failPuts: 1, putLog: [] };
  const res = await appendSignature(storeOctokit(state), CFG, ENTRY, { owner: 'o', repo: 'r' });
  assert.strictEqual(res.written, true);
  assert.strictEqual(state.putLog[0].sha, 'sha-2'); // fresh sha after refetch
});

test('duplicate-sign race: entry appears between attempts -> skipped on retry', async () => {
  const state = { entries: [], rev: 1, failPuts: 1, putLog: [] };
  const inner = storeOctokit(state);
  const orig = inner.rest.repos.getContent;
  let calls = 0;
  inner.rest.repos.getContent = async (...a) => { calls += 1; if (calls === 2) state.entries = [ENTRY]; return orig(...a); };
  const res = await appendSignature(inner, CFG, ENTRY, { owner: 'o', repo: 'r' });
  assert.deepStrictEqual(res, { written: false, reason: 'already-signed' });
  assert.strictEqual(state.putLog.length, 0);
});

test('gives up after 3 attempts', async () => {
  const state = { entries: [], rev: 1, failPuts: 3, putLog: [] };
  await assert.rejects(() => appendSignature(storeOctokit(state), CFG, ENTRY, { owner: 'o', repo: 'r' }));
});
