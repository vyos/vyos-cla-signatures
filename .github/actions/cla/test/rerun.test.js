const { test } = require('node:test');
const assert = require('node:assert');
const { triggerPrHeadRerun } = require('../src/rerun');

function actionsOctokit(state) {
  return {
    rest: { actions: {
      getWorkflowRun: async ({ run_id }) => ({ data: state.runsById[run_id] }),
      listWorkflowRuns: async (params) => {
        state.listParams = params;
        return { data: { workflow_runs: state.candidates } };
      },
      reRunWorkflowFailedJobs: async ({ run_id }) => {
        if (state.failRerunFailedJobs) { const e = new Error('409'); e.status = 409; throw e; }
        state.rerunFailed.push(run_id);
      },
      reRunWorkflow: async ({ run_id }) => { state.rerunFull.push(run_id); },
    } },
  };
}

const base = () => ({
  runsById: { 100: { id: 100, workflow_id: 77 } },
  candidates: [],
  rerunFailed: [],
  rerunFull: [],
  failRerunFailedJobs: false,
});

test('workflow-scoped lookup: queries by workflow_id and reruns newest completed run', async () => {
  const state = base();
  state.candidates = [
    { id: 90, workflow_id: 77, status: 'completed', created_at: '2026-07-01T00:00:00Z' },
    { id: 95, workflow_id: 77, status: 'completed', created_at: '2026-07-02T00:00:00Z' },
  ];
  const res = await triggerPrHeadRerun(actionsOctokit(state), { owner: 'o', repo: 'r', currentRunId: 100, headSha: 'abc' });
  assert.strictEqual(state.listParams.workflow_id, 77);
  assert.strictEqual(state.listParams.event, 'pull_request_target');
  assert.strictEqual(state.listParams.head_sha, 'abc');
  assert.deepStrictEqual(res, { status: 'rerun', runId: 95 });
  assert.deepStrictEqual(state.rerunFailed, [95]);
});

test('candidates with wrong workflow_id are ignored', async () => {
  const state = base();
  state.candidates = [{ id: 91, workflow_id: 999, status: 'completed', created_at: '2026-07-02T00:00:00Z' }];
  const res = await triggerPrHeadRerun(actionsOctokit(state), { owner: 'o', repo: 'r', currentRunId: 100, headSha: 'abc' });
  assert.strictEqual(res.status, 'skipped');
});

test('current run id excluded from candidates', async () => {
  const state = base();
  state.candidates = [{ id: 100, workflow_id: 77, status: 'completed', created_at: '2026-07-02T00:00:00Z' }];
  const res = await triggerPrHeadRerun(actionsOctokit(state), { owner: 'o', repo: 'r', currentRunId: 100, headSha: 'abc' });
  assert.strictEqual(res.status, 'skipped');
});

test('in-progress candidate -> skipped with detail', async () => {
  const state = base();
  state.candidates = [{ id: 95, workflow_id: 77, status: 'in_progress', created_at: '2026-07-02T00:00:00Z' }];
  const res = await triggerPrHeadRerun(actionsOctokit(state), { owner: 'o', repo: 'r', currentRunId: 100, headSha: 'abc' });
  assert.deepStrictEqual(res, { status: 'skipped', detail: 'run-in-progress' });
});

test('rerun-failed-jobs failure falls back to full rerun', async () => {
  const state = base();
  state.failRerunFailedJobs = true;
  state.candidates = [{ id: 95, workflow_id: 77, status: 'completed', created_at: '2026-07-02T00:00:00Z' }];
  const res = await triggerPrHeadRerun(actionsOctokit(state), { owner: 'o', repo: 'r', currentRunId: 100, headSha: 'abc' });
  assert.strictEqual(res.status, 'rerun');
  assert.deepStrictEqual(state.rerunFull, [95]);
});

test('API explosion -> {status: failed}, never throws', async () => {
  const octo = { rest: { actions: { getWorkflowRun: async () => { throw new Error('boom'); } } } };
  const res = await triggerPrHeadRerun(octo, { owner: 'o', repo: 'r', currentRunId: 100, headSha: 'abc' });
  assert.strictEqual(res.status, 'failed');
});
