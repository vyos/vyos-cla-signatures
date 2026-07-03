const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { renderBody, upsertStatusComment } = require('../src/comment');
const { MARKER, SIGN_PHRASE, BOT_LOGIN } = require('../src/constants');

const LEGACY_BODY = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-comment.md'), 'utf8');

test('renderBody: all-signed contains success line + marker first', () => {
  const body = renderBody({ signed: [{ id: 1, login: 'alice' }], unsigned: [], unlinked: [], documentUrl: 'https://doc' });
  assert.ok(body.startsWith(MARKER));
  assert.ok(body.includes('All contributors have signed the CLA ✍️ ✅'));
});

test('renderBody: unsigned lists logins, sign phrase, doc link, unlinked lines', () => {
  const body = renderBody({
    signed: [{ id: 1, login: 'alice' }],
    unsigned: [{ id: 2, login: 'bob' }],
    unlinked: [{ sha: 'abc1234', role: 'committer' }],
    documentUrl: 'https://doc',
  });
  assert.ok(body.includes('@bob'));
  assert.ok(body.includes(SIGN_PHRASE));
  assert.ok(body.includes('https://doc'));
  const unlinkedLine = body.split('\n').find((l) => l.includes('abc1234'));
  assert.ok(unlinkedLine.includes('(committer)'));
  assert.ok(unlinkedLine.includes('link this email')); // spec §4.1: each failure line carries role + SHA + fix instruction
});

function commentsOctokit(state) {
  // state.comments: [{id, body, user:{login}, created_at}], state.failUpdate: status|null
  return {
    rest: { issues: {
      listComments: 'listComments',
      createComment: async ({ body }) => { const c = { id: state.nextId++, body, user: { login: BOT_LOGIN }, created_at: 'now' }; state.comments.push(c); state.created.push(c.id); return { data: c }; },
      updateComment: async ({ comment_id, body }) => {
        if (state.failUpdate) { const e = new Error('upd'); e.status = state.failUpdate; throw e; }
        const c = state.comments.find((x) => x.id === comment_id); c.body = body; state.updated.push(comment_id); return { data: c };
      },
      deleteComment: async ({ comment_id }) => {
        if (state.failDelete && state.failDelete.has(comment_id)) { const e = new Error('del'); e.status = state.failDelete.get(comment_id); throw e; }
        state.deleted.push(comment_id);
      },
    } },
    paginate: async (fn) => { assert.strictEqual(fn, 'listComments'); return state.comments; },
  };
}

const freshState = (comments) => ({ comments, nextId: 900, created: [], updated: [], deleted: [], failUpdate: null, failDelete: null });

test('createIfMissing:true + no existing comment -> creates one', async () => {
  const state = freshState([]);
  const res = await upsertStatusComment(commentsOctokit(state), { owner: 'o', repo: 'r', prNumber: 1, warn: () => {}, createIfMissing: true }, `${MARKER}\nhello`);
  assert.strictEqual(state.created.length, 1);
  assert.strictEqual(res.commentId, state.created[0]);
});

test('createIfMissing:false + no existing comment -> no comment created (spec §4.3)', async () => {
  const state = freshState([]);
  const res = await upsertStatusComment(commentsOctokit(state), { owner: 'o', repo: 'r', prNumber: 1, warn: () => {}, createIfMissing: false }, `${MARKER}\nall signed`);
  assert.strictEqual(state.created.length, 0);
  assert.strictEqual(res.commentId, null);
});

test('createIfMissing:false + existing marker comment -> edited in place', async () => {
  const state = freshState([{ id: 5, body: `${MARKER}\nplease sign`, user: { login: BOT_LOGIN }, created_at: '2026-01-01' }]);
  const res = await upsertStatusComment(commentsOctokit(state), { owner: 'o', repo: 'r', prNumber: 1, warn: () => {}, createIfMissing: false }, `${MARKER}\nall signed`);
  assert.deepStrictEqual(state.updated, [5]);
  assert.strictEqual(state.created.length, 0);
  assert.strictEqual(res.commentId, 5);
});

test('createIfMissing:false + edit 404 -> no fresh comment, null id', async () => {
  const state = freshState([{ id: 5, body: `${MARKER}\nold`, user: { login: BOT_LOGIN }, created_at: '2026-01-01' }]);
  state.failUpdate = 404;
  const res = await upsertStatusComment(commentsOctokit(state), { owner: 'o', repo: 'r', prNumber: 1, warn: () => {}, createIfMissing: false }, `${MARKER}\nnew`);
  assert.strictEqual(state.created.length, 0);
  assert.strictEqual(res.commentId, null);
});

test('existing marker comment (bot author) -> edited in place, not duplicated', async () => {
  const state = freshState([{ id: 5, body: `${MARKER}\nold`, user: { login: BOT_LOGIN }, created_at: '2026-01-01' }]);
  await upsertStatusComment(commentsOctokit(state), { owner: 'o', repo: 'r', prNumber: 1, warn: () => {}, createIfMissing: true }, `${MARKER}\nnew`);
  assert.deepStrictEqual(state.updated, [5]);
  assert.strictEqual(state.created.length, 0);
});

test('spoofed marker from non-bot author is ignored', async () => {
  const state = freshState([{ id: 6, body: `${MARKER}\nspoof`, user: { login: 'attacker' }, created_at: '2026-01-01' }]);
  await upsertStatusComment(commentsOctokit(state), { owner: 'o', repo: 'r', prNumber: 1, warn: () => {}, createIfMissing: true }, `${MARKER}\nreal`);
  assert.strictEqual(state.created.length, 1);
  assert.deepStrictEqual(state.updated, []);
});

test('duplicate bot marker comments -> newest edited, older deleted (non-blocking)', async () => {
  const state = freshState([
    { id: 1, body: `${MARKER}\na`, user: { login: BOT_LOGIN }, created_at: '2026-01-01T00:00:00Z' },
    { id: 2, body: `${MARKER}\nb`, user: { login: BOT_LOGIN }, created_at: '2026-01-02T00:00:00Z' },
  ]);
  await upsertStatusComment(commentsOctokit(state), { owner: 'o', repo: 'r', prNumber: 1, warn: () => {}, createIfMissing: true }, `${MARKER}\nnew`);
  assert.deepStrictEqual(state.updated, [2]);
  assert.deepStrictEqual(state.deleted, [1]);
});

test('duplicate delete failure: 404 ignored, 403 warns, outcome unchanged', async () => {
  const warns = [];
  const state = freshState([
    { id: 1, body: `${MARKER}\na`, user: { login: BOT_LOGIN }, created_at: '2026-01-01T00:00:00Z' },
    { id: 2, body: `${MARKER}\nb`, user: { login: BOT_LOGIN }, created_at: '2026-01-02T00:00:00Z' },
    { id: 3, body: `${MARKER}\nc`, user: { login: BOT_LOGIN }, created_at: '2026-01-03T00:00:00Z' },
  ]);
  state.failDelete = new Map([[1, 404], [2, 403]]);
  const res = await upsertStatusComment(commentsOctokit(state), { owner: 'o', repo: 'r', prNumber: 1, warn: (m) => warns.push(m), createIfMissing: true }, `${MARKER}\nnew`);
  assert.strictEqual(res.commentId, 3);
  assert.strictEqual(warns.length, 1); // only the 403
});

test('legacy contributor-assistant comment adopted when no marker comment exists', async () => {
  const state = freshState([{ id: 8, body: LEGACY_BODY, user: { login: BOT_LOGIN }, created_at: '2026-01-01' }]);
  await upsertStatusComment(commentsOctokit(state), { owner: 'o', repo: 'r', prNumber: 1, warn: () => {}, createIfMissing: true }, `${MARKER}\nadopted`);
  assert.deepStrictEqual(state.updated, [8]);
  assert.strictEqual(state.created.length, 0);
});

test('edit 404 -> fresh comment created', async () => {
  const state = freshState([{ id: 5, body: `${MARKER}\nold`, user: { login: BOT_LOGIN }, created_at: '2026-01-01' }]);
  state.failUpdate = 404;
  const res = await upsertStatusComment(commentsOctokit(state), { owner: 'o', repo: 'r', prNumber: 1, warn: () => {}, createIfMissing: true }, `${MARKER}\nnew`);
  assert.strictEqual(state.created.length, 1);
  assert.strictEqual(res.commentId, state.created[0]);
});
