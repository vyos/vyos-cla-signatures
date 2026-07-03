async function loadSignatures(octokit, { owner, repo, path, branch }) {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path, ref: branch });
    // The contents API stops inlining base64 for files past its size threshold
    // (~1 MB). The signatures file is ~16 KB today; fail loudly long before a
    // silent bad parse if that ever changes.
    if (res.data.encoding !== 'base64' || typeof res.data.content !== 'string' || res.data.content === '') {
      throw new Error(`unexpected contents-API response for ${path}: encoding=${res.data.encoding} — file too large for inline content?`);
    }
    const json = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf8'));
    return { entries: json.signedContributors || [], sha: res.data.sha, exists: true };
  } catch (e) {
    if (e.status === 404) return { entries: [], sha: null, exists: false };
    throw e;
  }
}

function matchSignatures(accounts, entries) {
  const signedIds = new Set(entries.map((e) => e.id));
  const signed = [];
  const unsigned = [];
  for (const [id, login] of accounts) {
    (signedIds.has(id) ? signed : unsigned).push({ id, login });
  }
  return { signed, unsigned };
}

async function appendSignature(octokit, cfg, entry, calling) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const cur = await loadSignatures(octokit, cfg);
    if (cur.entries.some((e) => e.id === entry.id)) return { written: false, reason: 'already-signed' };
    const next = { signedContributors: [...cur.entries, entry] };
    const params = {
      owner: cfg.owner,
      repo: cfg.repo,
      path: cfg.path,
      branch: cfg.branch,
      message: `@${entry.name} has signed the CLA in ${calling.owner}/${calling.repo}#${entry.pullRequestNo}`,
      // Serialization mirrors the live file byte-for-byte: 2-space indent, no trailing newline.
      content: Buffer.from(JSON.stringify(next, null, 2)).toString('base64'),
    };
    if (cur.sha) params.sha = cur.sha;
    try {
      await octokit.rest.repos.createOrUpdateFileContents(params);
      return { written: true };
    } catch (e) {
      // last attempt (or non-conflict error) throws here — the loop never exits normally
      if ((e.status === 409 || e.status === 422) && attempt < 3) continue;
      throw e;
    }
  }
}

module.exports = { loadSignatures, matchSignatures, appendSignature };
