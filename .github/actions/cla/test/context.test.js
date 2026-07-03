const { test } = require('node:test');
const assert = require('node:assert');
const { parseContext } = require('../src/context');
const { SIGN_PHRASE } = require('../src/constants');

const prPayload = (action) => ({ action, pull_request: { number: 7 } });
const commentPayload = (body, extra = {}) => ({
  action: 'created',
  issue: { number: 7, pull_request: { url: 'x' }, ...extra.issue },
  comment: { id: 42, body, created_at: '2026-07-03T00:00:00Z', user: { login: 'alice', id: 1001 } },
});

test('pull_request_target opened/synchronize -> check', () => {
  for (const a of ['opened', 'synchronize']) {
    assert.deepStrictEqual(parseContext('pull_request_target', prPayload(a)), { kind: 'check', prNumber: 7 });
  }
});

test('pull_request_target closed -> noop', () => {
  assert.strictEqual(parseContext('pull_request_target', prPayload('closed')).kind, 'noop');
});

test('sign comment -> sign with commenter identity', () => {
  const ctx = parseContext('issue_comment', commentPayload(SIGN_PHRASE));
  assert.deepStrictEqual(ctx, {
    kind: 'sign', prNumber: 7, commentId: 42,
    commentCreatedAt: '2026-07-03T00:00:00Z', commenter: { login: 'alice', id: 1001 },
  });
});

test('sign phrase is byte-exact: trailing space -> noop', () => {
  assert.strictEqual(parseContext('issue_comment', commentPayload(SIGN_PHRASE + ' ')).kind, 'noop');
});

test('recheck comment -> recheck', () => {
  assert.deepStrictEqual(parseContext('issue_comment', commentPayload('recheck')), { kind: 'recheck', prNumber: 7 });
});

test('comment on a plain issue (no issue.pull_request) -> noop', () => {
  const p = commentPayload(SIGN_PHRASE);
  delete p.issue.pull_request;
  const ctx = parseContext('issue_comment', p);
  assert.strictEqual(ctx.kind, 'noop');
  assert.strictEqual(ctx.reason, 'not-a-pr');
});

test('unrelated comment body -> noop', () => {
  assert.strictEqual(parseContext('issue_comment', commentPayload('lgtm')).kind, 'noop');
});

test('unsupported event -> noop', () => {
  assert.strictEqual(parseContext('push', {}).kind, 'noop');
});
