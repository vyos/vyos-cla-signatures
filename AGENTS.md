# AGENTS.md

## Project purpose
Registry of signed VyOS Contributor License Agreements (CLAs). The `README.md` is the canonical CLA text; `signatures/version1/cla.json` holds all signer records. Hosts the reusable `cla-reusable.yml` workflow that gates contributions to all VyOS repositories.

## Tech stack
- Plain text + Markdown. No build system.
- `.github/workflows/cla-reusable.yml` — the reusable workflow consumed by every other VyOS repo's `cla-check.yml`.

## Build / test / run
N/A — additions land via PR. The CLA workflow inspects PR authors against `signatures/` and blocks merges when a signature is missing.

## Repository layout
- `README.md` — CLA text (the legal agreement).
- `signatures/version1/cla.json` — single JSON file containing all signer records (current schema).
- `.github/workflows/cla-reusable.yml` — the reusable CLA-check workflow.

## Cross-repo context
**Canonical CLA gate.** Every VyOS-org and the private side-org repo's `cla-check.yml` ultimately delegates to:
```
uses: vyos/vyos-cla-signatures/.github/workflows/cla-reusable.yml@current
```
This is the only path by which a contributor's signature is validated. The workflow is also referenced indirectly through `vyos/.github`'s `cla-check.yml` reusable.

## Conventions
- Commit/PR title: `component: T12345: description` (Phorge task ID at https://vyos.dev) where applicable. New-signature PRs typically reference the signing workflow rather than a feature task.
- Reusable workflow pin: floating `@current` — changes propagate immediately to every consumer.
- Public repo: contains real names/emails of signers. Do not redact existing entries; only append.

## Mirror relationship
No mirror twin. Canonical repo on the `vyos/*` side only.

## Notes for future contributors
- **Do not modify the CLA text in `README.md`** without legal review — it's a binding agreement between contributors and VyOS Networks.
- New signatures are merged by maintainers, not by the contributor. The workflow auto-detects who has signed.
- Schema is `signatures/version1/`; if a `version2/` is ever introduced, update the reusable workflow to scan both directories during the transition.
- This repo is referenced by floating `@current` from every consumer — any breaking workflow-input change is an org-wide outage.
