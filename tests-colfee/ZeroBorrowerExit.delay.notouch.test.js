// ColFee security perimeter — Zero DELAY no-touch regression.
//
// With the perimeter ACTIVE (controller enabled, d>0) and the queue WIRED,
// proves the delay reroute fires ONLY on the voluntary collateral-out chokepoint
// and is EXEMPT on the involuntary/keeper paths — liquidation, redemption, and
// stability-pool ETH-gain withdrawal route their collateral through
// TroveManager / StabilityPool, NOT through BorrowerOperations._sendCollWithExitFee,
// so the queue is never touched (lastRequestId stays 0, no RBTC escrowed). A
// keeper/liquidator/redeemer payout must never be escrowed behind a delay.

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

const DELAY = 3600;
const MIN_DELAY = 100;
const GAS_PRICE = toBN(dec(1, 9));

contract(
    "ColFee delay — Zero no-touch (liquidation/redemption/SP-gain exempt)",
    async (accounts) => {
        const [owner, alice, whale, defaulter_1] = accounts;
        const feeReceiver = accounts[995];
        const multisig = accounts[999];

        let priceFeed;
        let zusdToken;
        let troveManager;
        let activePool;
        let stabilityPool;
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
            const ZEROContracts = await deploymentHelper.deployZEROTesterContractsHardhat(
                multisig
            );

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
            queue = await MockExitDelayQueue.new(MIN_DELAY);
            await queue.setAllowedSource(borrowerOperations.address, true);
            // Perimeter ACTIVE + queue WIRED — so a touched queue would be visible.
            await borrowerOperations.setExitFeeController(controller.address, { from: owner });
            await borrowerOperations.setExitDelayQueue(queue.address, { from: owner });
            await controller.configureDelay(true, DELAY);
        });
        afterEach(async () => {
            await timeMachine.revertToSnapshot(snapshotId);
        });

        const assertQueueUntouched = async () => {
            assert.equal(
                (await queue.lastRequestId()).toString(),
                "0",
                "queue recorded a request"
            );
            assert.isTrue(
                toBN(await web3.eth.getBalance(queue.address)).eq(toBN(0)),
                "queue escrowed RBTC"
            );
            assert.isTrue((await queue.totalEscrowed(ZERO_ADDRESS)).eq(toBN(0)));
        };

        it("liquidation: collateral routes via TroveManager — queue untouched", async () => {
            await priceFeed.setPrice(dec(200, 18));
            await openTrove({
                ICR: toBN(dec(10, 18)),
                extraParams: { from: whale, value: toBN(dec(1000, "ether")) },
            });
            await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });

            await priceFeed.setPrice(dec(100, 18));
            assert.isFalse(await th.checkRecoveryMode(contracts));
            await troveManager.liquidate(defaulter_1, { from: owner });

            assert.equal((await troveManager.Troves(defaulter_1))[3].toString(), "3"); // closedByLiquidation
            await assertQueueUntouched();
        });

        it("redemption: collateral routes via TroveManager — queue untouched", async () => {
            await priceFeed.setPrice(dec(200, 18));
            await openTrove({
                ICR: toBN(dec(20, 18)),
                extraZUSDAmount: toBN(dec(50000, 18)),
                extraParams: { from: whale, value: toBN(dec(1000, "ether")) },
            });
            await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: alice } });

            await th.fastForwardTime(
                timeValues.SECONDS_IN_ONE_WEEK * 2 + timeValues.SECONDS_IN_ONE_DAY,
                web3.currentProvider
            );

            const apEthBefore = await activePool.getETH();
            await th.redeemCollateral(whale, contracts, toBN(dec(1000, 18)));

            assert.isTrue(
                (await activePool.getETH()).lt(apEthBefore),
                "redemption moved no collateral (vacuous)"
            );
            await assertQueueUntouched();
        });

        it("stability-pool ETH-gain withdrawal: routes via StabilityPool — queue untouched", async () => {
            await priceFeed.setPrice(dec(200, 18));
            await openTrove({
                ICR: toBN(dec(10, 18)),
                extraParams: { from: whale, value: toBN(dec(1000, "ether")) },
            });
            await openTrove({
                ICR: toBN(dec(10, 18)),
                extraZUSDAmount: toBN(dec(20000, 18)),
                extraParams: { from: alice, value: toBN(dec(200, "ether")) },
            });
            await stabilityPool.provideToSP(toBN(dec(10000, 18)), ZERO_ADDRESS, { from: alice });

            await openTrove({ ICR: toBN(dec(2, 18)), extraParams: { from: defaulter_1 } });
            await priceFeed.setPrice(dec(100, 18));
            await troveManager.liquidate(defaulter_1, { from: owner });
            await priceFeed.setPrice(dec(200, 18));

            const gain = await stabilityPool.getDepositorETHGain(alice);
            assert.isTrue(gain.gt(toBN(0)), "no ETH gain accrued — setup invalid");

            await stabilityPool.withdrawFromSP(toBN(dec(10000, 18)), {
                from: alice,
                gasPrice: GAS_PRICE,
            });
            await assertQueueUntouched();
        });
    }
);
