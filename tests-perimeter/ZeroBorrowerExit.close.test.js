// Perimeter — Zero borrower collateral-exit hook: closeTrove leg.
// Surface: PERIMETER_SURFACE_ZERO_WITHDRAW_COLL
//
// closeTrove() returns the trove's entire collateral to the borrower; this
// suite proves the exit fee is charged on that payout and that close invariants
// (trove removed, ActivePool drained by exactly the collateral) are preserved.
// The _sendCollWithExitFee branches themselves are covered in the adjust suite.

const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const testHelpers = require("../utils/js/testHelpers.js");
const { assertSurface, PERIMETER_SURFACE_ZERO_WITHDRAW_COLL } = require("./utils/assertions.js");
const timeMachine = require("ganache-time-traveler");

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const MassetManagerTester = artifacts.require("MassetManagerTester");
const ExitFeeControllerMock = artifacts.require("ExitFeeControllerMock");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;
const ZERO_ADDRESS = th.ZERO_ADDRESS;

const NONE = 0;
const CONTROLLER_REVERT = 4;
const GAS_PRICE = toBN(dec(1, 9));

contract("Perimeter — Zero borrower collateral exit (closeTrove)", async (accounts) => {
    const [owner, alice, dennis] = accounts;
    const feeReceiver = accounts[995];
    const multisig = accounts[999];

    let zusdToken;
    let troveManager;
    let activePool;
    let sortedTroves;
    let borrowerOperations;
    let controller;
    let contracts;

    const openTrove = async (params) => th.openTrove(contracts, params);
    const getTroveEntireColl = async (trove) => th.getTroveEntireColl(contracts, trove);
    const getEvent = (tx, name) => tx.logs.find((l) => l.event === name);

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

        zusdToken = contracts.zusdToken;
        troveManager = contracts.troveManager;
        activePool = contracts.activePool;
        sortedTroves = contracts.sortedTroves;
        borrowerOperations = contracts.borrowerOperations;

        await borrowerOperations.setMassetManagerAddress(contracts.massetManager.address);
    });

    let snapshotId;
    beforeEach(async () => {
        const snap = await timeMachine.takeSnapshot();
        snapshotId = snap["result"];
        controller = await ExitFeeControllerMock.new();
    });
    afterEach(async () => {
        await timeMachine.revertToSnapshot(snapshotId);
    });

    // Open a pair of troves; give `alice` enough ZUSD (from dennis) to repay her
    // debt + borrowing fee so closeTrove() succeeds.
    const setupCloseable = async () => {
        await openTrove({
            extraZUSDAmount: toBN(dec(10000, 18)),
            ICR: toBN(dec(2, 18)),
            extraParams: { from: dennis },
        });
        await openTrove({
            extraZUSDAmount: toBN(dec(10000, 18)),
            ICR: toBN(dec(2, 18)),
            extraParams: { from: alice },
        });
        await zusdToken.transfer(alice, await zusdToken.balanceOf(dennis), { from: dennis });
    };

    it("closeTrove (fee active): ActivePool -= coll, feeReceiver += fee, borrower += net; trove removed", async () => {
        await setupCloseable();
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE); // 50 bps

        const gross = await getTroveEntireColl(alice);
        const fee = gross.mul(toBN(50)).div(toBN(10000));
        const net = gross.sub(fee);

        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        const tx = await borrowerOperations.closeTrove({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            (await activePool.getETH()).eq(apEthBefore.sub(gross)),
            "ActivePool != -coll"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(fee)),
            "feeReceiver != +fee"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(net).sub(gasCost)),
            "borrower != +net (minus gas)"
        );
        assert.isFalse(await sortedTroves.contains(alice), "trove not removed from sorted list");
        assert.equal((await troveManager.Troves(alice))[3].toString(), "2"); // closedByOwner

        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev, "ExitFeeApplied not emitted");
        // closeTrove settles through the same borrower-exit surface as withdrawColl
        assertSurface(ev, PERIMETER_SURFACE_ZERO_WITHDRAW_COLL, "closeTrove ExitFeeApplied");
        assert.equal(ev.args.actor, alice);
        assert.equal(ev.args.recipient, alice);
        assert.equal(ev.args.asset, ZERO_ADDRESS);
        assert.isTrue(toBN(ev.args.grossAmount).eq(gross));
        assert.isTrue(toBN(ev.args.feeAmount).eq(fee));
        assert.isTrue(toBN(ev.args.netAmount).eq(net));
    });

    it("closeTrove: ActivePool drain + trove removal identical to baseline (fee vs no-fee)", async () => {
        await setupCloseable();
        const gross = await getTroveEntireColl(alice);
        const apEthBefore = await activePool.getETH();

        const inner = (await timeMachine.takeSnapshot())["result"];

        // baseline: no controller → full coll to borrower
        await borrowerOperations.closeTrove({ from: alice });
        const baseDrain = apEthBefore.sub(await activePool.getETH());
        const baseInList = await sortedTroves.contains(alice);
        const baseStatus = (await troveManager.Troves(alice))[3].toString();

        await timeMachine.revertToSnapshot(inner);

        // fee-active
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);
        await borrowerOperations.closeTrove({ from: alice });
        const feeDrain = apEthBefore.sub(await activePool.getETH());

        assert.isTrue(baseDrain.eq(gross), "baseline drain != coll");
        assert.isTrue(feeDrain.eq(baseDrain), "fee-path drain != baseline (residue!)");
        assert.equal(await sortedTroves.contains(alice), baseInList);
        assert.equal((await troveManager.Troves(alice))[3].toString(), baseStatus);
    });

    it("closeTrove (active but feeReceiver == 0): fee demoted, full coll to borrower, nothing burned", async () => {
        // A value call to a no-code address succeeds, so charging into
        // address(0) would burn the fee. The coll path must demote the same way
        // the surplus-claim path does, rather than send RBTC to 0x0.
        await setupCloseable();
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, ZERO_ADDRESS, NONE); // active, 50bps, receiver 0

        const gross = await getTroveEntireColl(alice);
        const apEthBefore = await activePool.getETH();
        const zeroBalBefore = toBN(await web3.eth.getBalance(ZERO_ADDRESS));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        const tx = await borrowerOperations.closeTrove({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            (await activePool.getETH()).eq(apEthBefore.sub(gross)),
            "ActivePool != -coll"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(ZERO_ADDRESS)).eq(zeroBalBefore),
            "fee was burned to 0x0"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "borrower != +gross (fee demoted, minus gas)"
        );
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev, "ExitFeeSkipped not emitted");
        assert.equal(toBN(ev.args.reason).toNumber(), 2, "reason != DISABLED");
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    it("closeTrove: controller unset → full coll to borrower, ExitFeeSkipped(CONTROLLER_REVERT)", async () => {
        await setupCloseable();
        const gross = await getTroveEntireColl(alice);

        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.closeTrove({ from: alice });

        assert.isTrue((await activePool.getETH()).eq(apEthBefore.sub(gross)));
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore),
            "feeReceiver should be untouched"
        );
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev, "ExitFeeSkipped not emitted");
        assert.equal(toBN(ev.args.reason).toNumber(), CONTROLLER_REVERT);
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });
});
