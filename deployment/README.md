# Deployment records

The mainnet registry distinguishes creation-backed deployments from observed
interfaces and runtimes. Composite records use the stable proxy address with the
implementation ABI; when a creation receipt is present it belongs to the named
implementation, not to the proxy.

Records with `linkedData.recordKind: observed-*` bind the interface/address and
runtime hash to the stated chain block. Their unverified compiled creation
bytecode, receipts and compiler metadata are omitted. A proxy runtime observation
is distinct from its implementation runtime. These observations do not update
themselves and are not compiler-source verification.

Use reviewed build artifacts for new deployments, not observed-runtime records as
creation templates. Existing deployment guards continue to restrict release
staging to the four approved Perimeter candidates. The BO/CSP/TM implementation
records retain their complete verified creation artifacts and constructor data.
The staging helper first loads each existing proxy with `getOrNull` and does not
pass that proxy to `deploy` when present; only the unchanged implementation
creation records reach deployment comparison. Live/fork selection rejects legacy
noncandidate deployments such as StabilityPool and TroveManagerRedeemOps before
comparison. The deployment-scope regression replays the actual helper against
these records twice and refuses any proxy creation, upgrade or record write.

`baselines/pre-record-refresh-rskSovrynMainnet` preserves exact previous imports.
Some were already stale or merely compiled templates. They are not automatically
valid rollback targets; historical operations require a separately pinned
pre-upgrade chain capture. Compiler-input files retain their exact source bytes.

Offline consistency checks:

```sh
node --test tests-perimeter/DeploymentRecords.current.test.js
```

The dated observation manifest includes every recorded mainnet address and its
interface hash. Before an operation, verify the current network, pointers, code
and policy state separately. Testnet records are unchanged by this mainnet update.
