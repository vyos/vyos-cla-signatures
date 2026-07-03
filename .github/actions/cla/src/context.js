const { SIGN_PHRASE, RECHECK_PHRASE } = require('./constants');

function parseContext(eventName, payload) {
  if (eventName === 'pull_request_target') {
    if (payload.action === 'closed') return { kind: 'noop', reason: 'pr-closed' };
    return { kind: 'check', prNumber: payload.pull_request.number };
  }
  if (eventName === 'issue_comment') {
    if (payload.action !== 'created') return { kind: 'noop', reason: 'comment-not-created' };
    if (!payload.issue || !payload.issue.pull_request) return { kind: 'noop', reason: 'not-a-pr' };
    const body = payload.comment.body;
    if (body === SIGN_PHRASE) {
      return {
        kind: 'sign',
        prNumber: payload.issue.number,
        commentId: payload.comment.id,
        commentCreatedAt: payload.comment.created_at,
        commenter: { login: payload.comment.user.login, id: payload.comment.user.id },
      };
    }
    if (body === RECHECK_PHRASE) return { kind: 'recheck', prNumber: payload.issue.number };
    return { kind: 'noop', reason: 'comment-no-match' };
  }
  return { kind: 'noop', reason: `unsupported-event:${eventName}` };
}

module.exports = { parseContext };
