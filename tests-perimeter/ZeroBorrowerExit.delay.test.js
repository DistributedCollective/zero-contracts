// Perimeter security perimeter — Zero borrower exit DELAY hook
// (surface PERIMETER_SURFACE_ZERO_WITHDRAW_COLL).
//
// Proves the delay reroute at the single voluntary collateral-out chokepoint
// `_sendCollWithExitFee` (reached by withdrawColl, collateral-decreasing
// adjustTrove, and closeTrove):
//   - d>0 ⇒ the borrower USER leg (net on fee-ok, GROSS on fee-fail) is
//     PUSHED to the queue via ActivePool.sendETH and recorded via
//     recordReceivedNativeExit in the SAME tx; the borrower is NOT paid directly;
//   - d==0 (perimeter disabled / unwired controller) ⇒ direct pay, byte-for-byte
//     baseline, and the queue is NEVER touched;
//   - fee + delay compose: fee leg to feeReceiver, delayed leg to the queue;
//   - FAIL-CLOSED: a controller-quote revert, an unwired queue at d>0, or a
//     record revert reverts the WHOLE exit atomically (trove state rolls back);
//   - executeExit pays the immutable receiver after unlock; a blocked actor
//     cannot execute (block-trap);
//   - conservation: escrowed(net) + fee == gross, ActivePool drained by gross.

const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const testHelpers = require("../utils/js/testHelpers.js");
const timeMachine = require("ganache-time-traveler");

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const MassetManagerTester = artifacts.require("MassetManagerTester");
const ExitFeeControllerMock = artifacts.require("ExitFeeControllerMock");
const MockExitDelayQueue = artifacts.require("MockExitDelayQueue");
const NonPayable = artifacts.require("NonPayable");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;
const ZERO_ADDRESS = th.ZERO_ADDRESS;

const GAS_PRICE = toBN(dec(1, 9));
const DELAY = 3600; // 1h
const MIN_DELAY = 100;
const SURFACE = web3.utils.keccak256("PERIMETER_SURFACE_ZERO_WITHDRAW_COLL");

contract("Perimeter delay — Zero borrower exit reroute", async (accounts) => {
    const [owner, alice, dennis] = accounts;
    const feeReceiver = accounts[995];
    const multisig = accounts[999];

    let zusdToken;
    let troveManager;
    let activePool;
    let sortedTroves;
    let borrowerOperations;
    let controller;
    let queue;
    let contracts;

    const openTrove = async (params) => th.openTrove(contracts, params);
    const getTroveEntireColl = async (trove) => th.getTroveEntireColl(contracts, trove);
    const getEvent = (tx, name) => tx.logs.find((l) => l.event === name);
    const bal = async (a) => toBN(await web3.eth.getBalance(a));

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
        queue = await MockExitDelayQueue.new(MIN_DELAY);
        await queue.setAllowedSource(borrowerOperations.address, true);
    });
    afterEach(async () => {
        await timeMachine.revertToSnapshot(snapshotId);
    });

    // Wire the controller (+ optional queue pointer) and enable the perimeter with `d`.
    const wire = async ({
        delaySecs = DELAY,
        wireQueue = true,
        feeActive = false,
        rateBps = 0,
    } = {}) => {
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        if (wireQueue) await borrowerOperations.setExitDelayQueue(queue.address, { from: owner });
        await controller.configureDelay(true, delaySecs);
        if (feeActive) await controller.configure(true, rateBps, feeReceiver, 0);
    };

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

    // ── Pointer wiring ──────────────────────────────────────────────────────

    it("setExitDelayQueue: only owner, rejects zero + non-contract, rotatable, emits event", async () => {
        await th.assertRevert(
            borrowerOperations.setExitDelayQueue(queue.address, { from: alice })
        );
        await th.assertRevert(borrowerOperations.setExitDelayQueue(ZERO_ADDRESS, { from: owner }));
        await th.assertRevert(borrowerOperations.setExitDelayQueue(alice, { from: owner })); // EOA / no code

        const tx = await borrowerOperations.setExitDelayQueue(queue.address, { from: owner });
        assert.equal(await borrowerOperations.exitDelayQueue(), queue.address);
        const ev = getEvent(tx, "ExitDelayQueueSet");
        assert.isDefined(ev);
        assert.equal(ev.args.current, queue.address);

        const queue2 = await MockExitDelayQueue.new(MIN_DELAY);
        await borrowerOperations.setExitDelayQueue(queue2.address, { from: owner });
        assert.equal(await borrowerOperations.exitDelayQueue(), queue2.address);
    });

    // ── withdrawColl reroute (d>0, no fee) ──────────────────────────────────

    it("withdrawColl (d>0, fee inactive): GROSS escrowed to queue, borrower NOT paid, ActivePool -= gross", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });
        await wire();

        const gross = toBN(dec(1, "ether"));
        const apBefore = await activePool.getETH();
        const aliceBefore = await bal(alice);
        const collBefore = await getTroveEntireColl(alice);

        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, {
            from: alice,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        // ActivePool drained by exactly gross; the queue now custodies it.
        assert.isTrue((await activePool.getETH()).eq(apBefore.sub(gross)), "ActivePool != -gross");
        assert.isTrue(
            toBN(await web3.eth.getBalance(queue.address)).eq(gross),
            "queue balance != gross"
        );
        assert.isTrue(
            (await queue.totalEscrowed(ZERO_ADDRESS)).eq(gross),
            "totalEscrowed != gross"
        );
        // borrower received NOTHING directly (only lost gas) — the leg is escrowed.
        assert.isTrue(
            (await bal(alice)).eq(aliceBefore.sub(gasCost)),
            "borrower paid directly on a delayed exit"
        );
        assert.isTrue(
            (await getTroveEntireColl(alice)).eq(collBefore.sub(gross)),
            "trove coll not reduced"
        );

        // one request, immutable metadata: originator=owner=receiver=alice, token=native.
        assert.equal((await queue.lastRequestId()).toString(), "1");
        const r = await queue.getRequest(1);
        assert.equal(r.originator, alice);
        assert.equal(r.owner, alice);
        assert.equal(r.receiver, alice);
        assert.equal(r.token, ZERO_ADDRESS);
        assert.equal(r.surfaceId, SURFACE);
        assert.isTrue(toBN(r.amount).eq(gross));
        assert.equal(toBN(r.unlockAt).sub(toBN(r.createdAt)).toString(), String(DELAY));
    });

    // ── fee + delay compose (d>0, fee active) ───────────────────────────────

    it("withdrawColl (d>0, fee 50bps): fee→feeReceiver, NET→queue, ExitFeeApplied; sums to gross", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });
        await wire({ feeActive: true, rateBps: 50 });

        const gross = toBN(dec(1, "ether"));
        const fee = gross.mul(toBN(50)).div(toBN(10000));
        const net = gross.sub(fee);

        const apBefore = await activePool.getETH();
        const frBefore = await bal(feeReceiver);

        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        assert.isTrue((await activePool.getETH()).eq(apBefore.sub(gross)), "ActivePool != -gross");
        assert.isTrue((await bal(feeReceiver)).eq(frBefore.add(fee)), "feeReceiver != +fee");
        assert.isTrue(
            toBN(await web3.eth.getBalance(queue.address)).eq(net),
            "queue != +net (delayed leg)"
        );
        assert.isTrue((await queue.totalEscrowed(ZERO_ADDRESS)).eq(net));
        // conservation: fee + escrowed net == gross
        assert.isTrue(fee.add(net).eq(gross));

        const applied = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(applied, "ExitFeeApplied not emitted");
        assert.isTrue(toBN(applied.args.netAmount).eq(net));
        const r = await queue.getRequest(1);
        assert.isTrue(toBN(r.amount).eq(net), "escrowed amount != net");
    });

    // ── fee-vault failure still escrows GROSS behind the delay ──────────────

    it("withdrawColl (d>0, fee-vault reverts): GROSS escrowed behind the delay (cannot bypass), ExitFeeSkipped(VAULT_REVERT)", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });
        const badReceiver = await NonPayable.new();
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await borrowerOperations.setExitDelayQueue(queue.address, { from: owner });
        await controller.configureDelay(true, DELAY);
        await controller.configure(true, 50, badReceiver.address, 0); // fee active but receiver bounces

        const gross = toBN(dec(1, "ether"));
        const apBefore = await activePool.getETH();

        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        // fee leg bounced ⇒ full GROSS routed to the queue (NOT paid direct, NOT skimmed).
        assert.isTrue((await activePool.getETH()).eq(apBefore.sub(gross)), "ActivePool != -gross");
        assert.isTrue(
            toBN(await web3.eth.getBalance(queue.address)).eq(gross),
            "gross not escrowed on fee-fail"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(badReceiver.address)).eq(toBN(0)),
            "bad receiver got ETH"
        );
        assert.equal(toBN(getEvent(tx, "ExitFeeSkipped").args.reason).toNumber(), 5); // VAULT_REVERT
        const r = await queue.getRequest(1);
        assert.isTrue(toBN(r.amount).eq(gross));
    });

    // ── closeTrove + adjustTrove reroute ────────────────────────────────────

    it("closeTrove (d>0): entire collateral escrowed, trove removed, ActivePool -= coll", async () => {
        await setupCloseable();
        await wire();
        const gross = await getTroveEntireColl(alice);
        const apBefore = await activePool.getETH();

        await borrowerOperations.closeTrove({ from: alice });

        assert.isTrue((await activePool.getETH()).eq(apBefore.sub(gross)), "ActivePool != -coll");
        assert.isTrue(
            toBN(await web3.eth.getBalance(queue.address)).eq(gross),
            "coll not escrowed"
        );
        assert.isFalse(await sortedTroves.contains(alice), "trove not removed");
        const r = await queue.getRequest(1);
        assert.isTrue(toBN(r.amount).eq(gross));
        assert.equal(r.receiver, alice);
    });

    it("adjustTrove (coll-decreasing, d>0): withdrawal escrowed; debt-only adjust never touches the queue", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });
        await wire();

        // coll-decreasing adjust (withdraw 2 ETH, no debt change)
        const w = toBN(dec(2, "ether"));
        await borrowerOperations.adjustTrove(0, w, 0, false, alice, alice, { from: alice });
        assert.equal((await queue.lastRequestId()).toString(), "1");
        assert.isTrue(toBN(await web3.eth.getBalance(queue.address)).eq(w));

        // debt-increase-only adjust (no collateral out) ⇒ gross==0 ⇒ hook early-returns, queue untouched
        await borrowerOperations.adjustTrove(
            toBN(dec(1, 18)),
            0,
            toBN(dec(100, 18)),
            true,
            alice,
            alice,
            { from: alice }
        );
        assert.equal(
            (await queue.lastRequestId()).toString(),
            "1",
            "debt-only adjust touched the queue"
        );
    });

    // ── d==0 direct pay, queue never touched ────────────────────────────────

    it("perimeter disabled (d==0): direct pay to borrower, queue NEVER touched even when wired", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });
        // controller + queue wired, but perimeter OFF ⇒ quoteExitDelayFor returns d=0.
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await borrowerOperations.setExitDelayQueue(queue.address, { from: owner });
        await controller.configureDelay(false, DELAY);

        const gross = toBN(dec(1, "ether"));
        const aliceBefore = await bal(alice);
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, {
            from: alice,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        // borrower paid directly; queue untouched.
        assert.isTrue(
            (await bal(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "borrower not paid direct at d==0"
        );
        assert.equal((await queue.lastRequestId()).toString(), "0", "queue touched at d==0");
        assert.isTrue(toBN(await web3.eth.getBalance(queue.address)).eq(toBN(0)));
    });

    it("controller unwired (no pointer): fail-open direct pay at d==0 (perimeter unreachable)", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });
        // No controller set at all ⇒ _safeQuoteExitDelay short-circuits to (0, raw, raw).
        const gross = toBN(dec(1, "ether"));
        const aliceBefore = await bal(alice);
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, {
            from: alice,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));
        assert.isTrue((await bal(alice)).eq(aliceBefore.add(gross).sub(gasCost)));
        assert.equal((await queue.lastRequestId()).toString(), "0");
    });

    // ── FAIL-CLOSED legs ────────────────────────────────────────────────────

    it("FAIL-CLOSED: controller quote reverts ⇒ whole withdrawColl reverts, trove unchanged", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });
        await wire();
        await controller.setDelayRevert(true);

        const collBefore = await getTroveEntireColl(alice);
        await th.assertRevert(
            borrowerOperations.withdrawColl(toBN(dec(1, "ether")), alice, alice, { from: alice }),
            "PERIMETER:delay-quote-failed"
        );
        assert.isTrue(
            (await getTroveEntireColl(alice)).eq(collBefore),
            "trove mutated on a fail-closed revert"
        );
    });

    it("FAIL-CLOSED: d>0 but queue unwired ⇒ whole withdrawColl reverts (delay never silently bypassed)", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });
        // controller enabled with d>0, but the queue pointer is NEVER set.
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configureDelay(true, DELAY);

        const collBefore = await getTroveEntireColl(alice);
        await th.assertRevert(
            borrowerOperations.withdrawColl(toBN(dec(1, "ether")), alice, alice, { from: alice }),
            "PERIMETER:queue-unset"
        );
        assert.isTrue((await getTroveEntireColl(alice)).eq(collBefore));
    });

    it("FAIL-CLOSED: a bricked queue (record reverts) reverts the whole close atomically", async () => {
        await setupCloseable();
        await wire();
        // De-register BO as an allowed source ⇒ recordReceivedNativeExit reverts.
        await queue.setAllowedSource(borrowerOperations.address, false);

        const collBefore = await getTroveEntireColl(alice);
        const apBefore = await activePool.getETH();
        await th.assertRevert(borrowerOperations.closeTrove({ from: alice }));
        // trove + pool fully rolled back — no partial close, no orphaned push.
        assert.isTrue(
            (await getTroveEntireColl(alice)).eq(collBefore),
            "trove partially closed on fail-closed"
        );
        assert.isTrue(
            (await activePool.getETH()).eq(apBefore),
            "ActivePool drained on fail-closed"
        );
        assert.isTrue(await sortedTroves.contains(alice), "trove removed on fail-closed");
    });

    // ── executeExit after unlock + block-trap ───────────────────────────────

    it("executeExit: reverts before unlock, pays the receiver after unlock", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });
        await wire();
        const gross = toBN(dec(1, "ether"));
        await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        await th.assertRevert(queue.executeExit(1, { from: alice }), "not unlocked");

        await th.fastForwardTime(DELAY + 1, web3.currentProvider);
        const aliceBefore = await bal(alice);
        const tx = await queue.executeExit(1, { from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));
        assert.isTrue(
            (await bal(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "receiver not paid on execute"
        );
        assert.isTrue((await queue.totalEscrowed(ZERO_ADDRESS)).eq(toBN(0)));
    });

    it("block-trap: a frozen actor cannot execute the escrowed exit", async () => {
        await openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from: alice, value: toBN(dec(100, "ether")) },
        });
        await wire();
        await borrowerOperations.withdrawColl(toBN(dec(1, "ether")), alice, alice, {
            from: alice,
        });
        await th.fastForwardTime(DELAY + 1, web3.currentProvider);

        await queue.freeze(alice);
        await th.assertRevert(queue.executeExit(1, { from: alice }), "actor blocked");
        await queue.unfreeze(alice);
        await queue.executeExit(1, { from: alice }); // succeeds once unblocked
    });

    // ── property/fuzz: escrow == net and conservation over random amounts ────

    it("property (fuzz): over random withdrawals, escrowed == net and fee+net == gross", async () => {
        await openTrove({
            ICR: toBN(dec(50, 18)),
            extraParams: { from: alice, value: toBN(dec(500, "ether")) },
        });
        await wire({ feeActive: true, rateBps: 137 });

        for (let i = 0; i < 12; i++) {
            const inner = (await timeMachine.takeSnapshot())["result"];
            // random gross in [1, 10] ether, at 1e12-wei granularity
            const units = toBN(1 + Math.floor(Math.random() * 9)); // 1..9 ether
            const extra = toBN(String(Math.floor(Math.random() * 1e6))).mul(toBN(dec(1, 12)));
            const gross = units.mul(toBN(dec(1, 18))).add(extra);
            const fee = gross.mul(toBN(137)).div(toBN(10000));
            const net = gross.sub(fee);

            const apBefore = await activePool.getETH();
            await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

            const escrowed = await queue.totalEscrowed(ZERO_ADDRESS);
            assert.isTrue(escrowed.eq(net), `escrowed(${escrowed}) != net(${net})`);
            assert.isTrue(fee.add(net).eq(gross), "fee+net != gross");
            assert.isTrue(
                (await activePool.getETH()).eq(apBefore.sub(gross)),
                "ActivePool != -gross"
            );
            assert.isTrue(
                toBN(await web3.eth.getBalance(queue.address)).eq(net),
                "queue balance != net"
            );

            await timeMachine.revertToSnapshot(inner);
        }
    });
});
