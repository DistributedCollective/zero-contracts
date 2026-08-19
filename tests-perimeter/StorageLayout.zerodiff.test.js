// Perimeter security perimeter — storage-layout upgrade-safety regression.
//
// The perimeter surfaces are storage-frugal by construction: the surface ids are
// constants and the exit-fee controller / ExitDelayQueue pointers live in
// EIP-1967-style unstructured slots (keccak256("sovryn.perimeter*") - 1), so they
// occupy no regular-storage slot. The one exception is BorrowerOperations, which
// holds the perimeter settlement hook address in a plain, APPENDED slot —
// mirroring TroveManager's `troveManagerRedeemOps`.
//
// This test guards both properties against a future edit that would silently
// corrupt every live trove's storage on the next upgrade. It compares the
// current, normalized solc `storageLayout` against a committed baseline under a
// per-target policy:
//
//   ZERO_DIFF   — any label/slot/offset/type difference fails (ActivePool,
//                 CollSurplusPool: hooked but stateless).
//   APPEND_ONLY — the baseline prefix must be byte-identical AND every added
//                 entry must occupy a slot strictly beyond the baseline's last
//                 slot; reordering, retyping, resizing or inserting fails
//                 (BorrowerOperations).
//
// SCOPE OF THE BASELINE: captured at `sovryn-perimeter-fee @ b6584a6`, a tree that
// ALREADY contains the borrower-exit fee hook. So this guard proves the
// surplus-claim hook and the exit-delay hooks appended nothing beyond the single
// declared settlement-hook slot. It does not independently re-prove the
// borrower-exit fee hook's zero-diff — that holds by construction and is
// reviewable in the contract source.
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

const ZERO_DIFF = "zero-diff";
const APPEND_ONLY = "append-only";

const TARGETS = [
    // Holds the perimeter settlement hook in one appended slot (`perimeterOps`).
    { fq: "contracts/BorrowerOperations.sol:BorrowerOperations", policy: APPEND_ONLY },
    // Native pusher — must stay untouched.
    { fq: "contracts/ActivePool.sol:ActivePool", policy: ZERO_DIFF },
    // Gains claimCollWithFee — functions only, no state.
    { fq: "contracts/CollSurplusPool.sol:CollSurplusPool", policy: ZERO_DIFF },
];

describe("Perimeter — storage-layout upgrade safety (surplus-claim fee hook + exit-delay reroute)", () => {
    let baseline;

    before(() => {
        baseline = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
    });

    it("baseline snapshot is present and non-empty for every target", () => {
        for (const { fq } of TARGETS) {
            assert.ok(Array.isArray(baseline[fq]), `baseline missing ${fq}`);
            assert.ok(
                baseline[fq].length > 0,
                `baseline for ${fq} is empty (would be a false pass)`
            );
        }
    });

    for (const { fq, policy } of TARGETS) {
        if (policy === ZERO_DIFF) {
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
        } else {
            it(`${fq}: baseline prefix unchanged, additions strictly appended`, async () => {
                const current = await normalizedLayout(fq);
                const base = baseline[fq];

                assert.ok(
                    current.length >= base.length,
                    `${fq}: ${base.length - current.length} baseline entr(ies) REMOVED — ` +
                        `every deployed slot must survive an upgrade.\n` +
                        `  current: ${JSON.stringify(current)}`
                );

                // The deployed prefix must be byte-identical: no reorder, retype,
                // resize or insertion anywhere inside the live layout.
                assert.deepStrictEqual(
                    current.slice(0, base.length),
                    base,
                    `STORAGE LAYOUT DIFF inside the deployed prefix of ${fq}:\n` +
                        `  current: ${JSON.stringify(current.slice(0, base.length))}`
                );

                // Additions must land beyond every baseline slot, so nothing can
                // pack into a slot the live contract already accounts for.
                const lastBaselineSlot = base.reduce((m, e) => Math.max(m, Number(e.slot)), -1);
                for (const added of current.slice(base.length)) {
                    assert.ok(
                        Number(added.slot) > lastBaselineSlot,
                        `${fq}: appended '${added.label}' sits at slot ${added.slot}, ` +
                            `inside the deployed range (last baseline slot ${lastBaselineSlot})`
                    );
                }
            });
        }
    }
});
