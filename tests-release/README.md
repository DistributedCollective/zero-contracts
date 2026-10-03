# Manual Zero release proof

These suites run locally, not in CI. They do not sign, stage, upgrade, or activate
anything on a production network. `hardhat.config.release.cjs` deliberately does not
load operator secrets and only defines an in-process Hardhat network. Contract-size
limits remain enforced.

## Exact shared-core artifacts

Supply the independently built core controller, queue, and ERC1967 proxy artifacts
and their manifest. The helper requires absolute paths, the full core source revision,
matching artifact SHA256 values, Solidity 0.8.20/Paris, and nonempty deployed runtime
within the 24,576-byte limit. Do not substitute historical lending fixtures.

```sh
export CORE_RELEASE_ARTIFACTS_DIR="/absolute/path/to/core-out"
export CORE_RELEASE_MANIFEST="/absolute/path/to/HANDOFF.json"
export CORE_RELEASE_REVISION="full-40-character-core-source-commit"
npx hardhat --config hardhat.config.release.cjs compile
npx hardhat --config hardhat.config.release.cjs test --no-compile \
  tests-perimeter/Deployment.perimeterOps.test.js \
  tests-perimeter/Deployment.releaseScope.test.js \
  tests-release/ArtifactProvenance.test.js \
  tests-release/ZeroCore.integration.test.js \
  tests-release/DeploymentMetadata.hazard.test.js
```

The metadata test invokes the exact cached native Solidity 0.6.11 compiler with an
in-memory comment mutation. It verifies the ABI and executable runtime stay equal
while the actual installed deployment comparator detects different creation data.
The compiler must already be available; this suite does not install a replacement.
Production safeguards exclude unrelated candidates rather than ignoring metadata.
Both integration suites also compare all four Zero candidate artifacts against their
Solidity 0.6.11 optimizer100 build outputs and every cached source/dependency input
against the current files. Stale local artifacts are rejected instead of being used
as evidence for newer source.

## Disposable mainnet fork

Choose and record a read-only Rootstock block/hash first. Do not use a production
wallet, a shared QA node, or `--network` to point these tests at a public broadcaster.

```sh
export ZERO_RELEASE_FORK_RPC="https://your-read-only-rootstock-rpc"
export ZERO_RELEASE_FORK_BLOCK="explicit-mainnet-block-number"
export ZERO_RELEASE_FORK_HASH="0xfull-block-hash"
export ZERO_RELEASE_FORK_REPORT="/absolute/path/to/fork-proof.json"
npx hardhat --config hardhat.config.release.cjs test --no-compile \
  tests-release/ZeroFork.rehearsal.test.js
```

The fork verifies upstream chain30 and the block hash, impersonates authorities
**locally**, stages exactly four Zero candidates, preserves live constructor inputs,
and installs them in the five-action release order. It checks old storage prefixes,
owners, balances, representative live troves, and excluded contract identities. It
then exercises fee-first withdrawals, adjustments, closes, funded surplus, failed
record rollback, 24-hour release, emergency disable, and host implementation rollback
without losing an already queued claim.

### Fixture boundaries

- The production oracle is read and retained during installation. Afterwards only
  its primary external adapter is replaced on the disposable fork with the existing
  `ExternalPriceFeedTester`, seeded from the pinned live price. The report identifies
  the original feed pointers and unchanged Zero PriceFeed implementation. Fork
  setup/time travel can expire the external oracle's publication; these exit tests
  therefore do **not** certify ongoing live-oracle updates.
- The fork surplus fixture is funded through locally impersonated, authorised
  ActivePool/TroveManager identities. It proves real pool/BO/controller/queue
  settlement and rollback, not the generation of surplus by a mainnet liquidation.
  The unforked integration suite generates actual redemption surplus using the
  production Zero hosts and surrounding local test assets.
- Queue floor60 is a test parameter, not a production decision. Global delay86400
  is tested. Existing queued claims remain independent of emergency ingress disable
  and host implementation rollback.
- These are Zero technical proofs. Full exact-artifact governance voting/queueing/
  execution, multisig threshold, lending integration, frontend approval, source
  freeze, production floor selection, and owner release approval remain separate
  gates in the private Perimeter Delay Runbook.

For production Zero deployment, use `zero:stage-delay` only after the runbook's
authorisation/preflight. Do not use this test configuration as a production
deployment configuration or run broad/reset deployments on a release network.
Existing `hh:fork-mainnet`/`hh:fork-testnet` commands retain no-deploy and now add
no-reset, preserving deployment records under the new fork-node guard.
