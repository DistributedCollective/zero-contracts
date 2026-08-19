// Perimeter security perimeter — SR1 queue custom-error SELECTOR propagation.
//
// The real ExitDelayQueue is Solidity 0.8.20 and its onlyAllowedSource guard
// reverts with the DISTINCT custom error `UnregisteredSource(address)` — the
// primary fail-closed halt signal the off-chain watcher keys on. The 0.6.11
// BorrowerOperations delay hook calls `recordReceivedNativeExit` as a PLAIN
// external call (NOT wrapped in a try/catch or re-`require` with a PERIMETER:
// string), and BorrowerOperations re-emits the settlement hook's revert
// unchanged, so that selector must BUBBLE UP UNWRAPPED out of the reverting
// trove exit — across BOTH the pragma and the delegatecall boundary.
//
// This regression drives a real withdrawColl/closeTrove into a queue that
// reverts with the exact `UnregisteredSource(msg.sender)` payload and asserts
// the returndata's leading 4 bytes equal the queue's selector (and are NOT a
// PERIMETER:-prefixed host string). The COMPANION host-side pre-check strings
// (PERIMETER:queue-unset / PERIMETER:delay-quote-failed) are asserted in
// ZeroBorrowerExit.delay.test.js — those are the reverts that CANNOT bubble a
// queue selector because they fire before/around the queue call.
//
// The revert payload is read ON-CHAIN through `PerimeterRawCatcher`, which
// low-level-calls BorrowerOperations and RETURNS the raw returndata. That is
// the EVM's own answer, and it holds whether or not the node can decode a
// custom error or build a stack trace through the settlement delegatecall —
// which parsing the node's error object cannot.

const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const testHelpers = require("../utils/js/testHelpers.js");
const timeMachine = require("ganache-time-traveler");

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const MassetManagerTester = artifacts.require("MassetManagerTester");
const ExitFeeControllerMock = artifacts.require("ExitFeeControllerMock");
const SelectorRevertingExitDelayQueue = artifacts.require("SelectorRevertingExitDelayQueue");
const PerimeterRawCatcher = artifacts.require("PerimeterRawCatcher");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;

const DELAY = 3600;

// bytes4(keccak256("UnregisteredSource(address)")) — the queue's distinct halt selector.
const UNREGISTERED_SOURCE_SELECTOR = web3.utils
    .keccak256("UnregisteredSource(address)")
    .slice(0, 10);

contract("Perimeter delay — SR1 queue selector propagation", async (accounts) => {
    const [owner] = accounts;
    const multisig = accounts[999];

    let borrowerOperations;
    let controller;
    let queue;
    let catcher;
    let contracts;

    const openTrove = async (params) => th.openTrove(contracts, params);

    // withdrawColl/closeTrove act on msg.sender's trove, so the catcher opens its
    // own and drives the exit itself — the returndata it receives IS the payload
    // the reverting exit hands its caller.
    const catcherCall = (data) =>
        catcher.probe.call(borrowerOperations.address, data, { from: owner });

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
        catcher = await PerimeterRawCatcher.new();
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

    // A trove owned by the catcher: 100 RBTC of collateral against a small draw,
    // so it stays far above MCR and can also be closed within a test.
    const openCatcherTrove = async () => {
        const data = borrowerOperations.contract.methods
            .openTrove(
                toBN(dec(5, 16)).toString(), // maxFeePercentage 5%
                toBN(dec(2000, 18)).toString(),
                catcher.address,
                catcher.address
            )
            .encodeABI();
        await catcher.probe(borrowerOperations.address, data, {
            from: owner,
            value: toBN(dec(100, "ether")),
        });
        assert.equal(
            (await contracts.troveManager.getTroveStatus(catcher.address)).toString(),
            "1",
            "catcher trove was not opened"
        );
    };

    it("sanity: the mock reverts with the exact UnregisteredSource(address) selector", async () => {
        const sel = await queue.UNREGISTERED_SOURCE_SELECTOR();
        assert.equal(
            sel.toLowerCase(),
            UNREGISTERED_SOURCE_SELECTOR,
            "mock selector != keccak selector"
        );
    });

    it("withdrawColl (d>0): queue UnregisteredSource selector BUBBLES UP unwrapped (not a PERIMETER: string)", async () => {
        await openCatcherTrove();

        const data = borrowerOperations.contract.methods
            .withdrawColl(toBN(dec(1, "ether")).toString(), catcher.address, catcher.address)
            .encodeABI();
        const { ok, ret: revertData } = await catcherCall(data);

        assert.isFalse(ok, "expected the exit to revert");
        // Distinct 4-byte selector preserved cross-pragma (0.8.20 queue → 0.6.11
        // host) and across the settlement delegatecall.
        assert.equal(
            revertData.toLowerCase().slice(0, 10),
            UNREGISTERED_SOURCE_SELECTOR,
            `expected queue selector to bubble; got ${revertData}`
        );
        // The bubbled payload ABI-encodes the offending caller (the BO proxy), proving
        // the FULL custom-error data survived — not a truncated / re-wrapped revert.
        const encodedCaller = borrowerOperations.address.slice(2).toLowerCase().padStart(64, "0");
        assert.include(
            revertData.toLowerCase(),
            encodedCaller,
            "custom-error arg (caller) not preserved"
        );
    });

    it("closeTrove (d>0): queue selector bubbles out of a failing trove CLOSE (fail-closed)", async () => {
        // A second trove so the catcher can close its own (system keeps >1 trove).
        await openTrove({
            extraZUSDAmount: toBN(dec(20000, 18)),
            ICR: toBN(dec(3, 18)),
            extraParams: { from: owner },
        });
        await openCatcherTrove();
        // closeTrove burns ZUSD from the caller — fund the catcher to cover its debt.
        await contracts.zusdToken.transfer(
            catcher.address,
            await contracts.zusdToken.balanceOf(owner),
            { from: owner }
        );

        const data = borrowerOperations.contract.methods.closeTrove().encodeABI();
        const { ok, ret: revertData } = await catcherCall(data);

        assert.isFalse(ok, "expected the close to revert");
        assert.equal(
            revertData.toLowerCase().slice(0, 10),
            UNREGISTERED_SOURCE_SELECTOR,
            `expected queue selector to bubble out of closeTrove; got ${revertData}`
        );
    });
});
