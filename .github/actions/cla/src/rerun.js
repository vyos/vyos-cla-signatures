async function triggerPrHeadRerun(octokit, { owner, repo, currentRunId, headSha }) {
  try {
    const { data: current } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: currentRunId });
    const { data } = await octokit.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: current.workflow_id, event: 'pull_request_target', head_sha: headSha, per_page: 10,
    });
    const candidate = (data.workflow_runs || [])
      .filter((r) => r.workflow_id === current.workflow_id && r.id !== currentRunId)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (!candidate) return { status: 'skipped', detail: 'no-prior-run' };
    if (candidate.status === 'queued' || candidate.status === 'in_progress') {
      return { status: 'skipped', detail: 'run-in-progress' };
    }
    try {
      await octokit.rest.actions.reRunWorkflowFailedJobs({ owner, repo, run_id: candidate.id });
    } catch {
      await octokit.rest.actions.reRunWorkflow({ owner, repo, run_id: candidate.id });
    }
    return { status: 'rerun', runId: candidate.id };
  } catch (e) {
    return { status: 'failed', detail: e.message };
  }
}

module.exports = { triggerPrHeadRerun };
