// Perimeter — Zero borrower-exit hook: no-touch + invariant suite.
//
// Proves:
//  - Fee-receiver failure passthrough: a reverting feeReceiver is caught by the
//    try/catch fee leg; the borrower still receives the full gross and the exit
//    completes (ExitFeeSkipped(VAULT_REVERT)). Perimeter infra failure cannot brick
//    a borrower exit.
//  - No-touch: redemption, liquidation, and stability-pool ETH-gain withdrawals
//    route their collateral through TroveManager / StabilityPool — NOT through
//    BorrowerOperations._sendCollWithExitFee — so an ACTIVE controller charges
//    nothing on those paths (feeReceiver balance unchanged).

const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const testHelpers = require("../utils/js/testHelpers.js");
const { assertSurface, PERIMETER_SURFACE_ZERO_WITHDRAW_COLL } = require("./utils/assertions.js");
const timeMachine = require("ganache-time-traveler");

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const MassetManagerTester = artifacts.require("MassetManagerTester");
const ExitFeeControllerMock = artifacts.require("ExitFeeControllerMock");
const NonPayable = artifacts.require("NonPayable");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;
const timeValues = testHelpers.TimeValues;
const ZERO_ADDRESS = th.ZERO_ADDRESS;

const NONE = 0;
const VAULT_REVERT = 5;
const GAS_PRICE = toBN(dec(1, 9));

contract("Perimeter — Zero borrower exit: no-touch + invariants", async (accounts) => {
    const [owner, alice, bob, whale, defaulter_1] = accounts;
    const feeReceiver = accounts[995];
    const multisig = accounts[999];

    let priceFeed;
    let zusdToken;
    let troveManager;
    let activePool;
    let stabilityPool;
    let borrowerOperations;
    let controller;
    let contracts;

    const openTrove = async (params) => th.openTrove(contracts, params);
    const getOpenTroveZUSDAmount = async (totalDebt) =>
        th.getOpenTroveZUSDAmount(contracts, totalDebt);
    const getTroveEntireColl = async (trove) => th.getTroveEntireColl(contracts, trove);
    const getEvent = (tx, name) => tx.logs.find((l) => l.event === name);

    // POSITIVE CONTROL for every no-touch case below.
    //
    // "feeReceiver balance unchanged" is only evidence of an exemption if the fee
    // system would otherwise have charged. Run under the SAME controller wiring and
    // rate the no-touch assertion relied on, this drives a genuinely chargeable
    // borrower exit and requires the fee to land. Without it, deleting
    // `_sendCollWithExitFee` outright — or a fixture where `setExitFeeController`
    // silently did nothing — would leave the no-touch tests passing and vacuous.
    const assertChargeableTwinDoesCharge = async (borrower, rateBps) => {
        const gross = toBN(dec(1, "ether"));
        const expectedFee = gross.mul(toBN(rateBps)).div(toBN(10000));
        assert.isTrue(expectedFee.gt(toBN(0)), "positive control needs a non-zero fee");

        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.withdrawColl(gross, borrower, borrower, {
            from: borrower,
        });

        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(expectedFee)),
            "POSITIVE CONTROL FAILED: a chargeable exit charged nothing under this same " +
                "controller config — the no-touch assertion above proves nothing"
        );
        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev, "positive control: ExitFeeApplied not emitted");
        assertSurface(ev, PERIMETER_SURFACE_ZERO_WITHDRAW_COLL, "positive control ExitFeeApplied");
        assert.isTrue(toBN(ev.args.feeAmount).eq(expectedFee));
    };

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

        priceFeed = contracts.priceFeedTestnet;
        zusdToken = contracts.zusdToken;
        troveManager = contracts.troveManager;
        activePool = contracts.activePool;
        stabilityPool = contracts.stabilityPool;
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

    // --- fee-receiver failure passthrough ---

    it("withdrawColl: reverting feeReceiver → full gross to borrower, ExitFeeSkipped(VAULT_REVERT), exit completes", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });

        const badReceiver = await NonPayable.new(); // receive() reverts while isPayable=false
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, badReceiver.address, NONE);

        const gross = toBN(dec(1, "ether"));
        const apEthBefore = await activePool.getETH();
        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const collBefore = await getTroveEntireColl(alice);

        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, {
            from: alice,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        // ActivePool drained by exactly gross (the reverted fee-leg subcall rolled back its ETH.sub)
        assert.isTrue(
            (await activePool.getETH()).eq(apEthBefore.sub(gross)),
            "ActivePool != -gross"
        );
        // borrower received the FULL gross (no fee skimmed) minus gas
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "borrower != +gross"
        );
        // fee receiver got nothing
        assert.isTrue(
            toBN(await web3.eth.getBalance(badReceiver.address)).eq(toBN(0)),
            "bad receiver got ETH"
        );
        // trove accounting still correct (coll reduced by gross) → exit completed
        assert.isTrue((await getTroveEntireColl(alice)).eq(collBefore.sub(gross)));

        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev, "ExitFeeSkipped not emitted");
        assertSurface(ev, PERIMETER_SURFACE_ZERO_WITHDRAW_COLL, "VAULT_REVERT ExitFeeSkipped");
        assert.equal(toBN(ev.args.reason).toNumber(), VAULT_REVERT);
        assert.equal(
            toBN(ev.args.rateBps).toNumber(),
            50,
            "rateBps should be the rate the controller used"
        );
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    // --- no-touch: liquidation ---

    it("liquidation: charges no exit fee (collateral routes via TroveManager, not the BO hook)", async () => {
        await priceFeed.setPrice(dec(200, 18));
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: whale, value: toBN(dec(1000, "ether")) },
        });
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 500, feeReceiver, NONE); // 5% — would be very visible if it fired

        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));

        await priceFeed.setPrice(dec(100, 18)); // defaulter_1 now under MCR
        assert.isFalse(await th.checkRecoveryMode(contracts));
        await troveManager.liquidate(defaulter_1, { from: owner });

        assert.equal((await troveManager.Troves(defaulter_1))[3].toString(), "3"); // closedByLiquidation
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore),
            "feeReceiver charged on a liquidation"
        );

        await assertChargeableTwinDoesCharge(whale, 500);
    });

    // --- no-touch: redemption ---

    it("redemption: charges no exit fee (collateral routes via TroveManager, not the BO hook)", async () => {
        await priceFeed.setPrice(dec(200, 18));
        // whale holds plenty of ZUSD to redeem with
        await openTrove({
            ICR: toBN(dec(20, 18)),
            extraZUSDAmount: toBN(dec(50000, 18)),
            extraParams: { from: whale, value: toBN(dec(1000, "ether")) },
        });
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });

        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 500, feeReceiver, NONE);

        // pass the redemption bootstrap window
        await th.fastForwardTime(
            timeValues.SECONDS_IN_ONE_WEEK * 2 + timeValues.SECONDS_IN_ONE_DAY,
            web3.currentProvider
        );

        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const apEthBefore = await activePool.getETH();
        await th.redeemCollateral(whale, contracts, toBN(dec(1000, 18)));

        // the redemption must actually move collateral, else the no-touch claim is vacuous
        assert.isTrue(
            (await activePool.getETH()).lt(apEthBefore),
            "redemption moved no collateral — no-touch assertion would be vacuous"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore),
            "feeReceiver charged on a redemption"
        );

        await assertChargeableTwinDoesCharge(whale, 500);
    });

    // --- no-touch: stability pool ETH-gain withdrawal ---

    it("stability-pool ETH-gain withdrawal: charges no exit fee", async () => {
        await priceFeed.setPrice(dec(200, 18));
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: whale, value: toBN(dec(1000, "ether")) },
        });
        // alice deposits to the Stability Pool
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraZUSDAmount: toBN(dec(20000, 18)),
            extraParams: { from: alice, value: toBN(dec(200, "ether")) },
        });
        await stabilityPool.provideToSP(toBN(dec(10000, 18)), ZERO_ADDRESS, { from: alice });

        // a defaulter is liquidated and offset against the SP → alice accrues an ETH gain
        await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 500, feeReceiver, NONE);

        await priceFeed.setPrice(dec(100, 18));
        await troveManager.liquidate(defaulter_1, { from: owner });
        await priceFeed.setPrice(dec(200, 18));

        const gain = await stabilityPool.getDepositorETHGain(alice);
        assert.isTrue(gain.gt(toBN(0)), "no ETH gain accrued — setup invalid");

        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        await stabilityPool.withdrawFromSP(toBN(dec(10000, 18)), { from: alice });

        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore),
            "feeReceiver charged on an SP ETH-gain withdrawal"
        );

        await assertChargeableTwinDoesCharge(alice, 500);
    });
});
