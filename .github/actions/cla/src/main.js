const { parseContext } = require('./context');
const { collectCommitters, parseAllowlist, filterAllowlisted } = require('./committers');
const { loadSignatures, matchSignatures, appendSignature } = require('./signatures');
const { renderBody, upsertStatusComment } = require('./comment');
const { triggerPrHeadRerun } = require('./rerun');

async function run(deps) {
  const { core, context, repoOctokit, sigOctokit } = deps;
  const ctx = parseContext(context.eventName, context.payload);
  if (ctx.kind === 'noop') {
    core.info(`No-op: ${ctx.reason}`);
    return;
  }
  const { owner, repo } = context.repo;

  const [sigOwner, sigRepo] = (core.getInput('signatures-repo') || 'vyos/vyos-cla-signatures').split('/');
  const sigCfg = {
    owner: sigOwner,
    repo: sigRepo,
    path: core.getInput('signatures-path') || 'signatures/version1/cla.json',
    branch: core.getInput('signatures-branch') || 'production',
  };
  const documentUrl = core.getInput('document-url') || 'https://github.com/vyos/vyos-cla-signatures/blob/production/README.md';
  const allow = parseAllowlist(core.getInput('allowlist'));

  const { data: pr } = await repoOctokit.rest.pulls.get({ owner, repo, pull_number: ctx.prNumber });
  const { accounts, unlinked } = await collectCommitters(repoOctokit, { owner, repo, prNumber: ctx.prNumber });
  const required = filterAllowlisted(accounts, allow);

  let store = await loadSignatures(sigOctokit, sigCfg);
  let { signed, unsigned } = matchSignatures(required, store.entries);

  if (ctx.kind === 'sign' && unsigned.some((u) => u.id === ctx.commenter.id)) {
    const result = await appendSignature(sigOctokit, sigCfg, {
      name: ctx.commenter.login,
      id: ctx.commenter.id,
      comment_id: ctx.commentId,
      created_at: ctx.commentCreatedAt,
      repoId: pr.base.repo.id,
      pullRequestNo: ctx.prNumber,
    }, { owner, repo });
    core.info(result.written ? `Recorded signature for @${ctx.commenter.login}` : `Signature already present (${result.reason})`);
    store = await loadSignatures(sigOctokit, sigCfg);
    ({ signed, unsigned } = matchSignatures(required, store.entries));
  }

  const failing = unsigned.length > 0 || unlinked.length > 0;
  const body = renderBody({ signed, unsigned, unlinked, documentUrl });
  try {
    // Spec §4.3/§4.4: blocking states must surface instructions (create if absent);
    // all-signed only refreshes an existing bot comment — a clean PR gets no comment.
    await upsertStatusComment(repoOctokit, { owner, repo, prNumber: ctx.prNumber, warn: core.warning, createIfMissing: failing }, body);
  } catch (e) {
    core.warning(`CLA status comment update failed: ${e.message}`);
  }

  if (failing) {
    const parts = [];
    if (unsigned.length) parts.push(`unsigned: ${unsigned.map((u) => `@${u.login}`).join(', ')}`);
    if (unlinked.length) parts.push(`commits with unlinked identities: ${unlinked.map((u) => `${u.sha} (${u.role})`).join(', ')}`);
    core.setFailed(`CLA check failed — ${parts.join('; ')}`);
    return;
  }

  core.info('All contributors have signed the CLA');
  if (ctx.kind === 'sign' || ctx.kind === 'recheck') {
    const res = await triggerPrHeadRerun(repoOctokit, { owner, repo, currentRunId: context.runId, headSha: pr.head.sha });
    core.info(`PR-head unblock re-run: ${res.status}${res.detail ? ` (${res.detail})` : ''}${res.runId ? ` run=${res.runId}` : ''}`);
  }
}

module.exports = { run };

if (require.main === module) {
  const core = require('@actions/core');
  const github = require('@actions/github');
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    core.setFailed('GITHUB_TOKEN env var is required');
  } else {
    run({
      core,
      context: {
        eventName: github.context.eventName,
        payload: github.context.payload,
        repo: github.context.repo,
        runId: github.context.runId,
      },
      repoOctokit: github.getOctokit(ghToken),
      sigOctokit: github.getOctokit(core.getInput('signature-token', { required: true })),
    }).catch((e) => core.setFailed(e.message));
  }
}
