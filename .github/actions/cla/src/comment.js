const { MARKER, BOT_LOGIN, LEGACY_NEEDLE, SIGN_PHRASE } = require('./constants');

function renderBody({ signed, unsigned, unlinked, documentUrl }) {
  const lines = [MARKER, ''];
  if (unsigned.length === 0 && unlinked.length === 0) {
    lines.push('All contributors have signed the CLA ✍️ ✅');
    lines.push('');
    lines.push(`Thank you! Signatures are recorded in [vyos/vyos-cla-signatures](${documentUrl}).`);
  } else {
    lines.push(`Thank you for your contribution! Before we can merge this pull request, every commit author and committer must sign the [VyOS Contribution License Agreement](${documentUrl}).`);
    lines.push('');
    for (const s of signed) lines.push(`- ✅ @${s.login}`);
    for (const u of unsigned) lines.push(`- ⬜ @${u.login}`);
    if (unsigned.length > 0) {
      lines.push('');
      lines.push('To sign, reply to this pull request with **exactly** this comment:');
      lines.push('');
      lines.push('```');
      lines.push(SIGN_PHRASE);
      lines.push('```');
      lines.push('');
      lines.push('Already signed? Comment `recheck` to re-run the check.');
    }
    if (unlinked.length > 0) {
      lines.push('');
      lines.push('Commits with an identity not linked to any GitHub account:');
      lines.push('');
      for (const u of unlinked) {
        lines.push(`- \`${u.sha}\` (${u.role}) — link this email to a GitHub account or rewrite the commit, then comment \`recheck\``);
      }
    }
  }
  return lines.join('\n');
}

async function upsertStatusComment(octokit, { owner, repo, prNumber, warn, createIfMissing }, body) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  const botOwned = comments.filter((c) => c.user && c.user.login === BOT_LOGIN && typeof c.body === 'string');
  const marked = botOwned
    .filter((c) => c.body.includes(MARKER))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  let target = null;
  let duplicates = [];
  if (marked.length > 0) {
    target = marked[marked.length - 1];
    duplicates = marked.slice(0, -1);
  } else {
    const legacy = botOwned
      .filter((c) => c.body.includes(LEGACY_NEEDLE))
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    if (legacy.length > 0) target = legacy[legacy.length - 1];
  }

  let commentId = null;
  if (target) {
    try {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: target.id, body });
      commentId = target.id;
    } catch (e) {
      if (e.status !== 404) throw e;
      if (createIfMissing) {
        const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
        commentId = data.id;
      }
      // createIfMissing:false + edit-404 -> nothing to refresh on a passing PR (spec §4.3)
    }
  } else if (createIfMissing) {
    const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    commentId = data.id;
  }

  for (const dup of duplicates) {
    try {
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: dup.id });
    } catch (e) {
      if (e.status !== 404) warn(`CLA status-comment cleanup failed for comment ${dup.id}: ${e.message}`);
    }
  }
  return { commentId };
}

module.exports = { renderBody, upsertStatusComment };
