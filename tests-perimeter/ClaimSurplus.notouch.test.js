// Perimeter security perimeter — surplus-claim DELAY exemption pinning test.
//
// PERIMETER_SURFACE_ZERO_CLAIM_SURPLUS is exempt by design from the exit-delay
// perimeter: surplus is involuntary in origin (full redemption or
// recovery-mode liquidation), is not attacker-creatable without capital, and
// rerouting it would widen the custody pool for thin marginal protection. So
// with the perimeter ACTIVE (controller enabled, d>0) and the queue WIRED,
// claimCollateral() still pays the claimant INSTANTLY — fee-ON (pool-side
// two-leg split) and fee-OFF (untouched claimColl path) alike — and the queue
// is never touched. The control test proves the SAME arming reroutes a
// voluntary withdrawColl, so the no-touch assertions are non-vacuous.
//
// This exemption is a deliberate, reviewable choice, not an oversight. If a
// delay leg is ever added to the surplus claim, retire this suite together
// with that change rather than deleting it on its own.

const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const testHelpers = require("../utils/js/testHelpers.js");
const timeMachine = require("ganache-time-traveler");

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const MassetManagerTester = artifacts.require("MassetManagerTester");
const ExitFeeControllerMock = artifacts.require("ExitFeeControllerMock");
const MockExitDelayQueue = artifacts.require("MockExitDelayQueue");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;
const timeValues = testHelpers.TimeValues;
const ZERO_ADDRESS = th.ZERO_ADDRESS;

const NONE = 0;
const DELAY = 3600;
const MIN_DELAY = 100;
const GAS_PRICE = toBN(dec(1, 9));

contract("Perimeter delay — surplus claim EXEMPT (no-touch pinning)", async (accounts) => {
    const [owner, alice, whale, dennis] = accounts;
    const feeReceiver = accounts[995];
    const multisig = accounts[999];

    let priceFeed;
    let collSurplusPool;
    let borrowerOperations;
    let controller;
    let queue;
    let contracts;

    const openTrove = async (params) => th.openTrove(contracts, params);
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

        priceFeed = contracts.priceFeedTestnet;
        collSurplusPool = contracts.collSurplusPool;
        borrowerOperations = contracts.borrowerOperations;

        await borrowerOperations.setMassetManagerAddress(contracts.massetManager.address);
    });

    let snapshotId;
    beforeEach(async () => {
        const snap = await timeMachine.takeSnapshot();
        snapshotId = snap["result"];
        controller = await ExitFeeControllerMock.new();
        queue = await MockExitDelayQueue.new(MIN_DELAY);
        await queue.setAllowedSource(borrowerOperations.address, true);
        // Perimeter ACTIVE + queue WIRED — identical arming to the reroute suites,
        // so a delay leg on the surplus claim WOULD fire here if one existed.
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await borrowerOperations.setExitDelayQueue(queue.address, { from: owner });
        await controller.configureDelay(true, DELAY);
    });
    afterEach(async () => {
        await timeMachine.revertToSnapshot(snapshotId);
    });

    // Same surplus fixture as ZeroClaimSurplus.test.js: fully redeem a ~200%-ICR
    // trove at ETH:USD = 100; surplus == coll - netDebt/price stays for claimant.
    const setupSurplus = async (claimant) => {
        const price = toBN(dec(100, 18));
        await priceFeed.setPrice(price);
        const { netDebt } = await openTrove({
            ICR: toBN(dec(200, 16)),
            extraParams: { from: claimant },
        });
        await openTrove({
            extraZUSDAmount: netDebt,
            extraParams: { from: whale, value: dec(3000, "ether") },
        });
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);
        await th.redeemCollateralAndGetTxObject(whale, contracts, netDebt);
        const gross = await collSurplusPool.getCollateral(claimant);
        assert.isTrue(gross.gt(toBN(0)), "setup failed: no surplus created");
        return gross;
    };

    const assertQueueUntouched = async () => {
        assert.equal((await queue.lastRequestId()).toString(), "0", "queue recorded a request");
        assert.isTrue(
            toBN(await web3.eth.getBalance(queue.address)).eq(toBN(0)),
            "queue escrowed RBTC"
        );
        assert.isTrue((await queue.totalEscrowed(ZERO_ADDRESS)).eq(toBN(0)));
    };

    it("CONTROL (non-vacuous): the SAME arming reroutes a voluntary withdrawColl into the queue", async () => {
        await priceFeed.setPrice(dec(200, 18));
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: dennis, value: toBN(dec(100, "ether")) },
        });
        const amount = toBN(dec(1, "ether"));
        await borrowerOperations.withdrawColl(amount, dennis, dennis, { from: dennis });

        assert.equal(
            (await queue.lastRequestId()).toString(),
            "1",
            "arming is vacuous: withdrawColl did not reroute"
        );
        assert.isTrue(
            (await queue.totalEscrowed(ZERO_ADDRESS)).eq(amount),
            "escrowed != withdrawn gross"
        );
    });

    it("fee-OFF claim: claimant paid FULL gross instantly, queue untouched", async () => {
        const gross = await setupSurplus(alice);

        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "claimant != +FULL gross instantly"
        );
        assert.isTrue(
            (await collSurplusPool.getCollateral(alice)).eq(toBN(0)),
            "claimable not zeroed"
        );
        assert.isDefined(getEvent(tx, "ExitFeeSkipped"), "fee-off path must emit ExitFeeSkipped");
        await assertQueueUntouched();
    });

    it("fee-ON claim (50 bps): fee→feeReceiver + net→claimant instantly, queue untouched", async () => {
        const gross = await setupSurplus(alice);
        await controller.configure(true, 50, feeReceiver, NONE);

        const fee = gross.mul(toBN(50)).div(toBN(10000));
        const net = gross.sub(fee);

        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(fee)),
            "feeReceiver != +fee"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(net).sub(gasCost)),
            "claimant != +net instantly"
        );
        assert.isTrue(
            (await collSurplusPool.getCollateral(alice)).eq(toBN(0)),
            "claimable not zeroed"
        );
        assert.isDefined(getEvent(tx, "ExitFeeApplied"), "charging path must emit ExitFeeApplied");
        await assertQueueUntouched();
    });
});
