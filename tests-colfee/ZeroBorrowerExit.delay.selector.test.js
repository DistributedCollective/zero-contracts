// ColFee security perimeter — SR1 queue custom-error SELECTOR propagation.
//
// The real ExitDelayQueue is Solidity 0.8.20 and its onlyAllowedSource guard
// reverts with the DISTINCT custom error `UnregisteredSource(address)` — the
// primary fail-closed halt signal the off-chain watcher keys on. The 0.6.11
// BorrowerOperations delay hook calls
// `recordReceivedNativeExit` as a PLAIN external call (NOT wrapped in a
// try/catch or re-`require` with a COLFEE: string), so that selector must
// BUBBLE UP UNCHANGED out of the reverting trove exit — it is neither swallowed
// nor re-wrapped by the host.
//
// This regression drives a real withdrawColl/closeTrove into a queue that
// reverts with the exact `UnregisteredSource(msg.sender)` payload and asserts
// the returndata's leading 4 bytes equal the queue's selector (and are NOT a
// COLFEE:-prefixed host string). The COMPANION host-side pre-check strings
// (COLFEE:queue-unset / COLFEE:delay-quote-failed) are asserted in
// ZeroBorrowerExit.delay.test.js — those are the reverts that CANNOT bubble a
// queue selector because they fire before/around the queue call.

const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const testHelpers = require("../utils/js/testHelpers.js");
const timeMachine = require("ganache-time-traveler");

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const MassetManagerTester = artifacts.require("MassetManagerTester");
const ExitFeeControllerMock = artifacts.require("ExitFeeControllerMock");
const SelectorRevertingExitDelayQueue = artifacts.require("SelectorRevertingExitDelayQueue");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;

const DELAY = 3600;

// bytes4(keccak256("UnregisteredSource(address)")) — the queue's distinct halt selector.
const UNREGISTERED_SOURCE_SELECTOR = web3.utils
    .keccak256("UnregisteredSource(address)")
    .slice(0, 10);

// Pull the raw revert returndata out of a reverting call. eth_call is used so the
// FULL custom-error payload (selector + args) is returned verbatim by the node,
// independent of receipt/tx error formatting. Handles the hardhat error shapes
// (top-level `data` hex, nested `data.data`, or a 0x-hex substring in `message`).
const rawRevertData = async (from, to, data) =>
    new Promise((resolve) => {
        web3.currentProvider.send(
            {
                jsonrpc: "2.0",
                id: Date.now(),
                method: "eth_call",
                params: [{ from, to, data }, "latest"],
            },
            (err, res) => {
                const e = err || (res && res.error);
                assert.isOk(e, "expected the call to revert but it succeeded");
                let d = e.data;
                if (d && typeof d === "object") d = d.data || d.result || d.value;
                if (typeof d !== "string" || !d.startsWith("0x")) {
                    const m = (e.message || "") + " " + JSON.stringify(e);
                    const found = m.match(/0x[0-9a-fA-F]{8,}/);
                    d = found ? found[0] : "";
                }
                resolve(d.toLowerCase());
            }
        );
    });

contract("ColFee delay — SR1 queue selector propagation", async (accounts) => {
    const [owner, alice] = accounts;
    const multisig = accounts[999];

    let borrowerOperations;
    let controller;
    let queue;
    let contracts;

    const openTrove = async (params) => th.openTrove(contracts, params);

    before(async () => {
        contracts = await deploymentHelper.deployLiquityCore();
        const permit2 = contracts.permit2;

        contracts.borrowerOperations = await BorrowerOperationsTester.new(permit2.address);
        contracts.massetManager = await MassetManagerTester.new();
        contracts.troveManager = await TroveManagerTester.new(permit2.address);
        contracts = await deploymentHelper.deployZUSDTokenTester(contracts);
        const ZEROContracts = await deploymentHelper.deployZEROTesterContractsHardhat(multisig);

        await ZEROContracts.zeroToken.unprotectedMint(multisig, toBN(dec(20, 24)));
        await deploymentHelper.connectZEROContracts(ZEROContracts);
        await deploymentHelper.connectCoreContracts(contracts, ZEROContracts);
        await deploymentHelper.connectZEROContractsToCore(ZEROContracts, contracts);

        borrowerOperations = contracts.borrowerOperations;
        await borrowerOperations.setMassetManagerAddress(contracts.massetManager.address);
    });

    let snapshotId;
    beforeEach(async () => {
        const snap = await timeMachine.takeSnapshot();
        snapshotId = snap["result"];
        controller = await ExitFeeControllerMock.new();
        queue = await SelectorRevertingExitDelayQueue.new();
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await borrowerOperations.setExitDelayQueue(queue.address, { from: owner });
        await controller.configureDelay(true, DELAY); // d>0 ⇒ the reroute engages the queue
    });
    afterEach(async () => {
        await timeMachine.revertToSnapshot(snapshotId);
    });

    it("sanity: the mock reverts with the exact UnregisteredSource(address) selector", async () => {
        const sel = await queue.UNREGISTERED_SOURCE_SELECTOR();
        assert.equal(
            sel.toLowerCase(),
            UNREGISTERED_SOURCE_SELECTOR,
            "mock selector != keccak selector"
        );
    });

    it("withdrawColl (d>0): queue UnregisteredSource selector BUBBLES UP unwrapped (not a COLFEE: string)", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });

        const data = borrowerOperations.contract.methods
            .withdrawColl(toBN(dec(1, "ether")).toString(), alice, alice)
            .encodeABI();
        const revertData = await rawRevertData(alice, borrowerOperations.address, data);

        // Distinct 4-byte selector preserved cross-pragma (0.8.20 queue → 0.6.11 host).
        assert.equal(
            revertData.slice(0, 10),
            UNREGISTERED_SOURCE_SELECTOR,
            `expected queue selector to bubble; got ${revertData}`
        );
        // The bubbled payload ABI-encodes the offending caller (the BO proxy), proving
        // the FULL custom-error data survived — not a truncated / re-wrapped revert.
        const encodedCaller = borrowerOperations.address.slice(2).toLowerCase().padStart(64, "0");
        assert.include(revertData, encodedCaller, "custom-error arg (caller) not preserved");
    });

    it("closeTrove (d>0): queue selector bubbles out of a failing trove CLOSE (fail-closed)", async () => {
        // A second trove so alice can close hers (system keeps >1 trove / TCR ok).
        await openTrove({
            extraZUSDAmount: toBN(dec(20000, 18)),
            ICR: toBN(dec(3, 18)),
            extraParams: { from: owner },
        });
        await openTrove({
            extraZUSDAmount: toBN(dec(10000, 18)),
            ICR: toBN(dec(2, 18)),
            extraParams: { from: alice },
        });
        // alice already holds enough ZUSD from her own draw to repay; top up from owner.
        await contracts.zusdToken.transfer(alice, await contracts.zusdToken.balanceOf(owner), {
            from: owner,
        });

        const data = borrowerOperations.contract.methods.closeTrove().encodeABI();
        const revertData = await rawRevertData(alice, borrowerOperations.address, data);

        assert.equal(
            revertData.slice(0, 10),
            UNREGISTERED_SOURCE_SELECTOR,
            `expected queue selector to bubble out of closeTrove; got ${revertData}`
        );
    });
});
