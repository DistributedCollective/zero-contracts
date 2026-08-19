// Perimeter security perimeter — surplus-claim DELAY hook
// (surface PERIMETER_SURFACE_ZERO_CLAIM_SURPLUS).
//
// The surplus claim composes the fee leg and the delay leg the same way the
// voluntary collateral exit does, with one structural difference: the pool, not
// ActivePool, holds the funds, so the net leg is sent by
// `CollSurplusPool.claimCollWithFeeTo` and recorded by BorrowerOperations in the
// same transaction.
//
//   - d>0 ⇒ the claimant's leg (net on fee-ok, GROSS on the uncharged path) is
//     PUSHED to the queue by the pool and recorded via recordReceivedNativeExit
//     in the SAME tx; the claimant is NOT paid directly;
//   - d==0 (perimeter disabled / unwired controller) ⇒ the untouched claim, and
//     the queue is NEVER touched;
//   - the FEE leg stays fail-OPEN and the DELAY leg fail-CLOSED: an unwired
//     queue or a reverting record reverts the whole claim and the claimant keeps
//     their surplus balance to claim again;
//   - conservation: escrowed(net) + fee == gross, the pool drained by gross;
//   - executeExit pays the claimant after unlock.
//
// This supersedes the earlier exemption pinning: the surplus surface was
// initially delay-exempt by design, and that decision was reversed.

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
const DELAY = 3600; // 1h
const MIN_DELAY = 100;
const GAS_PRICE = toBN(dec(1, 9));
const SURFACE = web3.utils.keccak256("PERIMETER_SURFACE_ZERO_CLAIM_SURPLUS");

contract("Perimeter delay — Zero surplus claim reroute", async (accounts) => {
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
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configureDelay(true, DELAY);
    });
    afterEach(async () => {
        await timeMachine.revertToSnapshot(snapshotId);
    });

    // Fully redeem a ~200%-ICR trove at ETH:USD = 100; the surplus
    // (coll - netDebt/price) stays claimable by its owner.
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

    // The queue pointer rejects address(0) by design, so "unwired" can only be
    // expressed by never setting it — hence wiring is per-test, not shared setup.
    const wireQueue = () => borrowerOperations.setExitDelayQueue(queue.address, { from: owner });

    const assertQueueUntouched = async () => {
        assert.equal((await queue.lastRequestId()).toString(), "0", "queue recorded a request");
        assert.isTrue(
            toBN(await web3.eth.getBalance(queue.address)).eq(toBN(0)),
            "queue escrowed RBTC"
        );
        assert.isTrue((await queue.totalEscrowed(ZERO_ADDRESS)).eq(toBN(0)));
    };

    it("CONTROL (non-vacuous): the SAME arming reroutes a voluntary withdrawColl", async () => {
        await wireQueue();
        await priceFeed.setPrice(dec(200, 18));
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: dennis, value: toBN(dec(100, "ether")) },
        });
        const amount = toBN(dec(1, "ether"));
        await borrowerOperations.withdrawColl(amount, dennis, dennis, { from: dennis });

        assert.equal((await queue.lastRequestId()).toString(), "1");
        assert.isTrue((await queue.totalEscrowed(ZERO_ADDRESS)).eq(amount));
    });

    it("fee-OFF claim (d>0): FULL gross escrowed, claimant NOT paid, pool drained", async () => {
        await wireQueue();
        const gross = await setupSurplus(alice);

        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.sub(gasCost)),
            "claimant was paid directly despite the hold"
        );
        assert.isTrue(
            (await collSurplusPool.getCollateral(alice)).eq(toBN(0)),
            "claimable not zeroed"
        );
        assert.isTrue((await queue.totalEscrowed(ZERO_ADDRESS)).eq(gross), "escrowed != gross");
        assert.isDefined(
            getEvent(tx, "ExitFeeSkipped"),
            "uncharged path must emit ExitFeeSkipped"
        );

        const request = await queue.getRequest(1);
        assert.equal(request.receiver, alice, "receiver must be the claimant");
        assert.equal(request.originator, alice);
        assert.equal(request.owner, alice);
        assert.equal(request.surfaceId, SURFACE, "wrong surface recorded");
        assert.equal(request.token, ZERO_ADDRESS, "surplus is native RBTC");
    });

    it("fee-ON claim (50 bps, d>0): fee to the receiver, NET escrowed, sums to gross", async () => {
        await wireQueue();
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
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.sub(gasCost)),
            "claimant was paid directly despite the hold"
        );
        assert.isTrue((await queue.totalEscrowed(ZERO_ADDRESS)).eq(net), "escrowed != net");
        assert.isTrue(
            (await queue.totalEscrowed(ZERO_ADDRESS)).add(fee).eq(gross),
            "escrowed + fee != gross"
        );
        assert.isDefined(getEvent(tx, "ExitFeeApplied"), "charging path must emit ExitFeeApplied");
    });

    it("perimeter disabled (d==0): the untouched claim, queue NEVER touched", async () => {
        await wireQueue();
        const gross = await setupSurplus(alice);
        await controller.configureDelay(false, DELAY);

        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "claimant != +FULL gross instantly"
        );
        await assertQueueUntouched();
    });

    it("perimeter disabled (d==0), fee ON: fee and net both paid instantly", async () => {
        await wireQueue();
        const gross = await setupSurplus(alice);
        await controller.configureDelay(false, DELAY);
        await controller.configure(true, 50, feeReceiver, NONE);

        const fee = gross.mul(toBN(50)).div(toBN(10000));
        const net = gross.sub(fee);

        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(fee)));
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(net).sub(gasCost)),
            "claimant != +net instantly"
        );
        await assertQueueUntouched();
    });

    it("FAIL-CLOSED: d>0 but the queue is unwired ⇒ the whole claim reverts", async () => {
        // wireQueue() deliberately NOT called: the controller quotes a hold and
        // there is nowhere to escrow it.
        const gross = await setupSurplus(alice);

        await th.assertRevert(
            borrowerOperations.claimCollateral({ from: alice }),
            "PERIMETER:queue-unset"
        );
        assert.isTrue(
            (await collSurplusPool.getCollateral(alice)).eq(gross),
            "surplus must survive a refused claim"
        );
    });

    it("FAIL-CLOSED: a reverting delay quote reverts the whole claim", async () => {
        await wireQueue();
        const gross = await setupSurplus(alice);
        await controller.setDelayRevert(true);

        await th.assertRevert(
            borrowerOperations.claimCollateral({ from: alice }),
            "PERIMETER:delay-quote-failed"
        );
        assert.isTrue((await collSurplusPool.getCollateral(alice)).eq(gross));
    });

    it("FAIL-CLOSED: a bricked queue (record reverts) reverts the whole claim", async () => {
        await wireQueue();
        const gross = await setupSurplus(alice);
        await queue.setAllowedSource(borrowerOperations.address, false);

        await th.assertRevert(borrowerOperations.claimCollateral({ from: alice }));
        assert.isTrue(
            (await collSurplusPool.getCollateral(alice)).eq(gross),
            "surplus must survive a refused claim"
        );
        await assertQueueUntouched();
    });

    it("100% fee policy (d>0): nothing to escrow, the claim still settles", async () => {
        await wireQueue();
        const gross = await setupSurplus(alice);
        await controller.configure(true, 10000, feeReceiver, NONE);

        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.claimCollateral({ from: alice });

        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(gross)),
            "feeReceiver != +gross"
        );
        assert.isDefined(getEvent(tx, "ExitFeeApplied"));
        await assertQueueUntouched();
    });

    it("executeExit: reverts before unlock, pays the claimant after", async () => {
        await wireQueue();
        const gross = await setupSurplus(alice);
        await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });

        await th.assertRevert(queue.executeExit(1, { from: alice }), "MockQueue: not unlocked");

        await th.fastForwardTime(DELAY + 1, web3.currentProvider);
        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await queue.executeExit(1, { from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "claimant != +gross after unlock"
        );
        assert.isTrue((await queue.totalEscrowed(ZERO_ADDRESS)).eq(toBN(0)));
    });

    it("block-trap: a frozen claimant cannot execute the escrowed claim", async () => {
        await wireQueue();
        await setupSurplus(alice);
        await borrowerOperations.claimCollateral({ from: alice });
        await th.fastForwardTime(DELAY + 1, web3.currentProvider);
        await queue.freeze(alice);

        await th.assertRevert(queue.executeExit(1, { from: alice }), "MockQueue: actor blocked");
    });
});
