// Perimeter — Zero borrower collateral-exit hook: withdrawColl / adjustTrove legs.
// Surface: PERIMETER_SURFACE_ZERO_WITHDRAW_COLL
// Covers the `_moveTokensAndETHfromAdjustment` hook reached by:
//   - withdrawColl(amount, ...)
//   - adjustTrove(_collWithdrawal>0, _isDebtIncrease=false, msg.value=0)
//
// In-process full-system deployment (the zero-contracts test convention; the
// production controller is 0.8.20 so the hook is exercised against
// ExitFeeControllerMock, a 0.6.11 stand-in). _closeTrove has its own suite, as
// do the no-touch / failure-passthrough invariants.

const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const testHelpers = require("../utils/js/testHelpers.js");
const {
    assertRevertWithReason,
    assertSurface,
    PERIMETER_SURFACE_ZERO_WITHDRAW_COLL,
} = require("./utils/assertions.js");
const timeMachine = require("ganache-time-traveler");

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const MassetManagerTester = artifacts.require("MassetManagerTester");
const ExitFeeControllerMock = artifacts.require("ExitFeeControllerMock");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;
const ZERO_ADDRESS = th.ZERO_ADDRESS;

// SkipReason enum (mirrors IExitFeeController.SkipReason)
const NONE = 0;
const INACTIVE = 1;
const INVALID_QUOTE = 3;
const CONTROLLER_REVERT = 4;

const GAS_PRICE = toBN(dec(1, 9)); // 1 gwei — used to back out gas cost from the borrower's RBTC delta

contract("Perimeter — Zero borrower collateral exit (adjust/withdraw)", async (accounts) => {
    const [owner, alice, bob] = accounts;
    const feeReceiver = accounts[995];
    const multisig = accounts[999];

    let priceFeed;
    let troveManager;
    let activePool;
    let sortedTroves;
    let borrowerOperations;
    let controller;
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

    // Open a roomy trove so a meaningful collateral withdrawal stays well above MCR.
    const openRoomyTrove = async (from) =>
        openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from, value: toBN(dec(100, "ether")) },
        });

    // --- setExitFeeController (rotatable, owner-gated) ---

    it("setExitFeeController: owner-gated, rejects zero, emits ExitFeeControllerSet", async () => {
        assert.equal(await borrowerOperations.exitFeeController(), ZERO_ADDRESS);

        await assertRevertWithReason(
            borrowerOperations.setExitFeeController(controller.address, { from: bob }),
            "Ownable:: access denied"
        );
        // Reason-checked on purpose: `checkContract(address(0))` would ALSO revert
        // here ("Account cannot be zero address"), so an unchecked assertRevert
        // would still pass with the explicit EFC:zero guard deleted.
        await assertRevertWithReason(
            borrowerOperations.setExitFeeController(ZERO_ADDRESS, { from: owner }),
            "EFC:zero"
        );

        const tx = await borrowerOperations.setExitFeeController(controller.address, {
            from: owner,
        });
        const ev = getEvent(tx, "ExitFeeControllerSet");
        assert.isDefined(ev, "ExitFeeControllerSet not emitted");
        assert.equal(ev.args.previous, ZERO_ADDRESS);
        assert.equal(ev.args.current, controller.address);
        assert.equal(await borrowerOperations.exitFeeController(), controller.address);
    });

    // --- withdrawColl charging path ---

    it("withdrawColl (fee active): ActivePool -= gross, feeReceiver += fee, borrower += net", async () => {
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE); // 50 bps

        const gross = toBN(dec(1, "ether"));
        const fee = gross.mul(toBN(50)).div(toBN(10000));
        const net = gross.sub(fee);

        const apEthBefore = await activePool.getETH();
        const apRawBefore = toBN(await web3.eth.getBalance(activePool.address));
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, {
            from: alice,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            (await activePool.getETH()).eq(apEthBefore.sub(gross)),
            "ActivePool ETH != -gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(activePool.address)).eq(apRawBefore.sub(gross)),
            "ActivePool raw ether != -gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(fee)),
            "feeReceiver != +fee"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(net).sub(gasCost)),
            "borrower != +net (minus gas)"
        );

        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev, "ExitFeeApplied not emitted");
        assertSurface(ev, PERIMETER_SURFACE_ZERO_WITHDRAW_COLL, "withdrawColl ExitFeeApplied");
        assert.equal(ev.args.actor, alice);
        assert.equal(ev.args.asset, ZERO_ADDRESS);
        assert.equal(ev.args.subProduct, ZERO_ADDRESS);
        assert.equal(ev.args.recipient, alice);
        assert.equal(ev.args.feeReceiver, feeReceiver);
        assert.isTrue(toBN(ev.args.grossAmount).eq(gross));
        assert.isTrue(toBN(ev.args.feeAmount).eq(fee));
        assert.isTrue(toBN(ev.args.netAmount).eq(net));
    });

    it("withdrawColl: trove accounting + ICR + TCR + sorted position are fee-independent (vs baseline)", async () => {
        await openRoomyTrove(alice);
        const gross = toBN(dec(1, "ether"));
        const collBefore = await troveManager.getTroveColl(alice);
        const price = await priceFeed.getPrice();

        // local snapshot so we can run the SAME withdrawal twice: baseline then fee-active
        const inner = (await timeMachine.takeSnapshot())["result"];

        // baseline: no controller set → full gross to borrower
        await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });
        const baseColl = await troveManager.getTroveColl(alice);
        const baseICR = await troveManager.getCurrentICR(alice, price);
        const baseTCR = await th.getTCR(contracts);
        const baseInList = await sortedTroves.contains(alice);

        await timeMachine.revertToSnapshot(inner);

        // fee-active path
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);
        await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });
        const feeColl = await troveManager.getTroveColl(alice);
        const feeICR = await troveManager.getCurrentICR(alice, price);
        const feeTCR = await th.getTCR(contracts);
        const feeInList = await sortedTroves.contains(alice);

        // trove collateral falls by full GROSS in both cases (fee comes out of the payout, not the trove)
        assert.isTrue(baseColl.eq(collBefore.sub(gross)), "baseline coll != before-gross");
        assert.isTrue(feeColl.eq(baseColl), "fee-path coll != baseline coll");
        assert.isTrue(feeICR.eq(baseICR), "ICR differs from baseline");
        assert.isTrue(toBN(feeTCR).eq(toBN(baseTCR)), "TCR differs from baseline");
        assert.equal(feeInList, baseInList);
    });

    it("adjustTrove (collWithdrawal>0, debt unchanged): same split as withdrawColl", async () => {
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);

        const gross = toBN(dec(1, "ether"));
        const fee = gross.mul(toBN(50)).div(toBN(10000));
        const net = gross.sub(fee);

        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        // _maxFeePercentage, _collWithdrawal, _ZUSDChange=0, _isDebtIncrease=false, no msg.value
        const tx = await borrowerOperations.adjustTrove(0, gross, 0, false, alice, alice, {
            from: alice,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            (await activePool.getETH()).eq(apEthBefore.sub(gross)),
            "ActivePool != -gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(fee)),
            "feeReceiver != +fee"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(net).sub(gasCost)),
            "borrower != +net (minus gas)"
        );
        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev, "ExitFeeApplied not emitted");
        assert.equal(ev.args.recipient, alice);
        assert.isTrue(toBN(ev.args.grossAmount).eq(gross));
        assert.isTrue(toBN(ev.args.feeAmount).eq(fee));
        assert.isTrue(toBN(ev.args.netAmount).eq(net));
    });

    // --- arithmetic edges: truncation and dust ---

    it("withdrawColl: non-round gross at a truncating rate — fee + net == gross exactly, remainder to the borrower", async () => {
        // The 1-ether/50-bps cases divide exactly, so they cannot catch a rounding
        // bug. Here gross * rateBps is NOT a multiple of 10000: the truncated wei
        // must land with the BORROWER (net = gross - fee), and the pool must still
        // drain by exactly gross with no residue.
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        const rateBps = toBN(37);
        await controller.configure(true, 37, feeReceiver, NONE);

        const gross = toBN("1234567890123456789"); // deliberately non-round
        const fee = gross.mul(rateBps).div(toBN(10000)); // floor division
        const net = gross.sub(fee);
        assert.isTrue(
            fee.mul(toBN(10000)).lt(gross.mul(rateBps)),
            "chosen gross/rate must truncate, else this test proves nothing"
        );

        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, {
            from: alice,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(fee.add(net).eq(gross), "fee + net != gross");
        assert.isTrue(
            (await activePool.getETH()).eq(apEthBefore.sub(gross)),
            "ActivePool != -gross"
        );
        const frDelta = toBN(await web3.eth.getBalance(feeReceiver)).sub(frBefore);
        const aliceDelta = toBN(await web3.eth.getBalance(alice))
            .sub(aliceBefore)
            .add(gasCost);
        assert.isTrue(frDelta.eq(fee), "feeReceiver delta != truncated fee");
        assert.isTrue(aliceDelta.eq(net), "borrower delta != gross - fee");
        assert.isTrue(frDelta.add(aliceDelta).eq(gross), "measured legs do not sum to gross");

        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev);
        assert.isTrue(toBN(ev.args.feeAmount).eq(fee));
        assert.isTrue(toBN(ev.args.netAmount).eq(net));
    });

    it("withdrawColl: dust gross where the fee truncates to 0 → ExitFeeSkipped(NONE), full gross, nothing charged", async () => {
        // 199 wei at 50 bps floors to 0. `q.active && q.feeAmount > 0` is false, so
        // the hook must take the non-charging path — not send a 0-value fee leg and
        // not emit ExitFeeApplied.
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);

        const gross = toBN(199); // 199 * 50 / 10000 == 0
        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, {
            from: alice,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue((await activePool.getETH()).eq(apEthBefore.sub(gross)));
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore),
            "dust fee must not be charged"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "borrower must receive the FULL dust gross"
        );
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev, "ExitFeeSkipped not emitted");
        assert.equal(toBN(ev.args.reason).toNumber(), NONE);
        assert.equal(toBN(ev.args.rateBps).toNumber(), 50, "resolved rate must survive the skip");
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    // --- fail-open branches ---

    it("withdrawColl: controller unset → full gross to borrower, ExitFeeSkipped(CONTROLLER_REVERT)", async () => {
        await openRoomyTrove(alice);
        const gross = toBN(dec(1, "ether"));

        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));

        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        assert.isTrue((await activePool.getETH()).eq(apEthBefore.sub(gross)));
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore),
            "feeReceiver should be untouched"
        );
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev, "ExitFeeSkipped not emitted");
        assertSurface(ev, PERIMETER_SURFACE_ZERO_WITHDRAW_COLL, "withdrawColl ExitFeeSkipped");
        assert.equal(toBN(ev.args.reason).toNumber(), CONTROLLER_REVERT);
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    it("setExitFeeController: rejects a no-code address (EOA / destroyed)", async () => {
        // Defense-in-depth: a no-code controller would make the high-level
        // quoteExitFee call revert with "function call to a non-contract account",
        // which 0.6.11 try/catch does NOT catch — so reject it at config time.
        await assertRevertWithReason(
            borrowerOperations.setExitFeeController(bob, { from: owner }), // bob = EOA, no code
            "Account code size cannot be zero"
        );
    });

    it("withdrawColl: controller becomes no-code after being set → fail open, ExitFeeSkipped(CONTROLLER_REVERT)", async () => {
        await openRoomyTrove(alice);
        // Controller has code when wired in (passes the setter check)...
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);
        // ...then becomes code-less (simulates a destroyed/self-destructed proxy).
        await controller.destroy();

        const gross = toBN(dec(1, "ether"));
        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));

        // Must NOT revert — the borrower exit must complete (fail open).
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        assert.isTrue(
            (await activePool.getETH()).eq(apEthBefore.sub(gross)),
            "ActivePool != -gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore),
            "feeReceiver should be untouched"
        );
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev, "ExitFeeSkipped not emitted");
        assert.equal(toBN(ev.args.reason).toNumber(), CONTROLLER_REVERT);
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    it("withdrawColl: controller reverts → full gross to borrower, ExitFeeSkipped(CONTROLLER_REVERT)", async () => {
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.setRevert(true);
        const gross = toBN(dec(1, "ether"));

        const apEthBefore = await activePool.getETH();
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        assert.isTrue((await activePool.getETH()).eq(apEthBefore.sub(gross)));
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev);
        assert.equal(toBN(ev.args.reason).toNumber(), CONTROLLER_REVERT);
    });

    it("withdrawColl: malformed quote (feeAmount > gross) → INVALID_QUOTE, full gross to borrower", async () => {
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        const gross = toBN(dec(1, "ether"));
        await controller.configure(true, 50, feeReceiver, NONE);
        await controller.setForcedAmounts(true, gross.add(toBN(1)), 0); // fee > gross

        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        assert.isTrue((await activePool.getETH()).eq(apEthBefore.sub(gross)));
        assert.isTrue(toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore));
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev);
        assert.equal(toBN(ev.args.reason).toNumber(), INVALID_QUOTE);
        // the resolved rate must survive onto the skip event (parity with VAULT_REVERT path)
        assert.equal(
            toBN(ev.args.rateBps).toNumber(),
            50,
            "INVALID_QUOTE skip must preserve the controller's rateBps"
        );
    });

    it("withdrawColl: consumer trusts the controller's feeAmount (no fee↔rate reconciliation), enforcing only pool safety", async () => {
        // SRP: the consumer does NOT reproduce the controller's fee-from-rate formula. A quote with
        // feeAmount == gross (<= gross, so pool-safe) is charged in full even though rateBps looks
        // inconsistent — fee↔rate correctness is the configured controller's job.
        // The consumer's guarantee is unchanged: ActivePool drains by exactly gross, no residue.
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        const gross = toBN(dec(1, "ether"));
        await controller.configure(true, 0, feeReceiver, NONE);
        await controller.setForcedAmounts(true, gross, 0); // fee == gross (pool-safe), rateBps == 0

        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        assert.isTrue(
            (await activePool.getETH()).eq(apEthBefore.sub(gross)),
            "pool must drain by exactly gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(gross)),
            "fee leg charges feeAmount"
        );
        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev);
        assert.isTrue(toBN(ev.args.feeAmount).eq(gross));
        assert.isTrue(toBN(ev.args.netAmount).eq(toBN(0)), "net = gross - fee recomputed");
    });

    it("withdrawColl: forced divergent netAmount is ignored — net recomputed as gross-fee", async () => {
        // Pins the defensive recompute: a controller returning a bogus netAmount must not
        // be trusted; the charged net is always gross - feeAmount.
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        const gross = toBN(dec(1, "ether"));
        const fee = gross.mul(toBN(50)).div(toBN(10000));
        await controller.configure(true, 50, feeReceiver, NONE);
        await controller.setForcedAmounts(true, fee, toBN(0)); // bogus net=0 (correct is gross-fee)

        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        assert.isTrue(
            (await activePool.getETH()).eq(apEthBefore.sub(gross)),
            "ActivePool != -gross"
        );
        assert.isTrue(toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(fee)));
        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev);
        assert.isTrue(
            toBN(ev.args.netAmount).eq(gross.sub(fee)),
            "net must be recomputed, not the bogus 0"
        );
    });

    it("withdrawColl: active policy with zero rate (feeAmount==0) → ExitFeeSkipped(NONE), full gross", async () => {
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 0, feeReceiver, NONE); // active, but 0 bps → fee 0
        const gross = toBN(dec(1, "ether"));

        const apEthBefore = await activePool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        assert.isTrue((await activePool.getETH()).eq(apEthBefore.sub(gross)));
        assert.isTrue(toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore));
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev);
        assert.equal(toBN(ev.args.reason).toNumber(), NONE);
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    it("withdrawColl: inactive policy propagates the controller's reason (INACTIVE) onto the skip event", async () => {
        // Distinct from the zero-rate (active, NONE) case above: proves a non-zero
        // SkipReason from the controller is plumbed through to ExitFeeSkipped.
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(false, 0, feeReceiver, INACTIVE);
        const gross = toBN(dec(1, "ether"));

        const apEthBefore = await activePool.getETH();
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });

        assert.isTrue((await activePool.getETH()).eq(apEthBefore.sub(gross)));
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev);
        assert.equal(toBN(ev.args.reason).toNumber(), INACTIVE);
    });

    it("debt-only adjustTrove (gross==0) emits no Perimeter event and skips the controller", async () => {
        // Repay / debt-only adjustments move no collateral → the hook must short-circuit
        // (no wasted quoteExitFee round-trip, no spurious ExitFeeSkipped).
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);

        const debtBefore = (await troveManager.Troves(alice))[0]; // [0] = debt
        // debt increase, no collateral change, no msg.value → gross == 0 at the hook
        const tx = await borrowerOperations.adjustTrove(
            dec(1, 18),
            0,
            toBN(dec(100, 18)),
            true,
            alice,
            alice,
            {
                from: alice,
            }
        );

        assert.isTrue(
            (await troveManager.Troves(alice))[0].gt(debtBefore),
            "debt did not increase — setup invalid"
        );
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"), "no Perimeter event on a debt-only op");
        assert.isUndefined(getEvent(tx, "ExitFeeSkipped"), "no Perimeter event on a debt-only op");
    });
});
