// Shared assertion helpers for the Perimeter Zero test suites.
//
// `TestHelper.assertRevert(txPromise, message)` accepts an expected revert
// string but NEVER checks it (the comparison is commented out upstream), so a
// test written against it passes when the call reverts for a completely
// different reason — e.g. an access-control check can be deleted and the test
// still passes because a later `require` fires. `assertRevertWithReason` below
// asserts the reason string, so these suites prove WHICH guard rejected the
// call, not merely that something did.

const { assert } = require("chai");

const NOT_REVERTED = "COLFEE_ASSERT_NOT_REVERTED";

/// Assert `txPromise` reverts AND that the revert reason contains `expected`.
async function assertRevertWithReason(txPromise, expected) {
    assert.isString(expected, "assertRevertWithReason requires an expected reason string");
    try {
        await txPromise;
    } catch (err) {
        assert.include(err.message, "revert", `expected a revert, got: ${err.message}`);
        assert.include(
            err.message,
            expected,
            `revert reason mismatch — expected to contain "${expected}", got: ${err.message}`
        );
        return;
    }
    throw new Error(`${NOT_REVERTED}: expected revert containing "${expected}", but tx succeeded`);
}

/// Perimeter surface ids as the hooks compute them on-chain
/// (`keccak256("PERIMETER_SURFACE_...")`). Asserting these on the emitted events
/// pins each hook to its OWN surface: the controller mock ignores `surfaceId`,
/// so without this a hook quoting the wrong surface would charge the wrong
/// policy in production and every test would still pass.
/// Computed lazily — `web3` is a test-runtime global, not available at require time.
const surfaceId = (name) => web3.utils.keccak256(name);
const PERIMETER_SURFACE_ZERO_WITHDRAW_COLL = () =>
    surfaceId("PERIMETER_SURFACE_ZERO_WITHDRAW_COLL");
const PERIMETER_SURFACE_ZERO_CLAIM_SURPLUS = () =>
    surfaceId("PERIMETER_SURFACE_ZERO_CLAIM_SURPLUS");

/// Assert a Perimeter event carries the expected surface id.
/// `expected` is one of the SURFACE_* thunks above.
function assertSurface(ev, expected, label) {
    assert.equal(
        ev.args.surfaceId,
        expected(),
        `${label || "Perimeter event"} carries the wrong surfaceId`
    );
}

module.exports = {
    assertRevertWithReason,
    assertSurface,
    PERIMETER_SURFACE_ZERO_WITHDRAW_COLL,
    PERIMETER_SURFACE_ZERO_CLAIM_SURPLUS,
};
