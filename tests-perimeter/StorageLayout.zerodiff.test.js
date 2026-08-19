// Perimeter security perimeter — storage-layout ZERO-DIFF regression.
//
// Neither the Zero surplus-claim exit-fee hook NOR the borrower exit-DELAY
// reroute adds storage to any deployed upgradeable contract: the surface ids
// are constants, the exit-fee controller pointer and the ExitDelayQueue
// pointer (keccak256("sovryn.exitDelayQueue") - 1) live in EIP-1967-style
// unstructured slots, and the hooks declare no new state variables on the
// BorrowerOperations or CollSurplusPool proxies. That is true BY CONSTRUCTION
// today — but nothing GUARDS a future edit from appending a `uint256` to the
// proxy and silently corrupting every live trove's storage on the next
// upgrade.
//
// This test is that guard. It compares the current, normalized solc
// `storageLayout` of BorrowerOperations, CollSurplusPool, and ActivePool
// against a committed baseline and FAILS on any label/slot/offset/type
// difference. The lending side carries an equivalent guard over its own
// upgradeable contracts.
//
// SCOPE OF THE BASELINE (be precise about what this proves): the committed
// baseline was captured at `sovryn-perimeter-fee @ b6584a6`, a tree that ALREADY
// contains the borrower-exit hook (`_sendCollWithExitFee`, the unstructured
// controller slot, the surface-id constants). So this guard proves the
// SURPLUS-CLAIM hook and the EXIT-DELAY hooks appended no state, and forbids
// any future append to all three contracts. It does NOT independently re-prove
// the borrower-exit hook's zero-diff — that holds by construction (constants
// plus EIP-1967-style slots for the controller and queue pointers, none of
// which occupies a regular-storage slot) and is reviewable in the contract
// source, but it is not what this baseline compares against.
//
// Requires `storageLayout` in the 0.6.11 compiler outputSelection
// (hardhat.config.ts) — the shared helper throws (never silently passes) if the
// layout is missing or empty, closing the "two empty layouts compare equal"
// false-PASS hole.
//
// REGENERATE BASELINE (only on an INTENTIONAL, reviewed layout change):
//   1. git worktree add <tmp> sovryn-perimeter-fee
//   2. overlay this repo's hardhat.config.ts (storageLayout output) into <tmp>
//   3. (cd <tmp> && npx hardhat compile --force)
//   4. extract the normalized layout for the three targets and overwrite
//      tests-perimeter/baselines/storage-layout.sovryn-perimeter-fee.json (keep _meta).

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { normalizedLayout } = require("./utils/storageLayout.js");

const BASELINE = path.join(__dirname, "baselines", "storage-layout.sovryn-perimeter-fee.json");

const TARGETS = [
    "contracts/BorrowerOperations.sol:BorrowerOperations", // hooked upgradeable proxy
    "contracts/ActivePool.sol:ActivePool", // native pusher — must stay untouched
    "contracts/CollSurplusPool.sol:CollSurplusPool", // gains claimCollWithFee — functions only, no state
];

describe("Perimeter — storage-layout zero-diff (surplus-claim fee hook + exit-delay reroute)", () => {
    let baseline;

    before(() => {
        baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    });

    it("baseline snapshot is present and non-empty for every target", () => {
        for (const fq of TARGETS) {
            assert.ok(Array.isArray(baseline[fq]), `baseline missing ${fq}`);
            assert.ok(
                baseline[fq].length > 0,
                `baseline for ${fq} is empty (would be a false pass)`
            );
        }
    });

    for (const fq of TARGETS) {
        it(`${fq}: current layout == sovryn-perimeter-fee baseline (no appended state)`, async () => {
            const current = await normalizedLayout(fq);
            const base = baseline[fq];
            // Exact structural equality: label/slot/offset/type per entry, in order.
            assert.deepStrictEqual(
                current,
                base,
                `STORAGE LAYOUT DIFF for ${fq} vs sovryn-perimeter-fee baseline:\n` +
                    `  baseline entries: ${base.length}\n  current entries : ${current.length}\n` +
                    `  current: ${JSON.stringify(current)}`
            );
        });
    }
});
