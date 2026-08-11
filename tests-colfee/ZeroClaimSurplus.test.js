// ColFee — Zero surplus-claim exit fee (SURFACE_ZERO_CLAIM_SURPLUS)
//
// Surplus enters CollSurplusPool on full redemption (TroveManagerRedeemOps) or
// recovery-mode liquidation with ICR > MCR; the ONLY outlet is
// BorrowerOperations.claimCollateral(). This suite proves the pool-side two-leg
// split (claimCollWithFee) charges the fee when the policy is active, fails
// open on every ColFee failure, and leaves the non-charging path
// state-equivalent to the untouched claimColl flow.

const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const testHelpers = require("../utils/js/testHelpers.js");
const {
    assertRevertWithReason,
    assertSurface,
    SURFACE_ZERO_CLAIM_SURPLUS,
} = require("./utils/assertions.js");
const timeMachine = require("ganache-time-traveler");

const BorrowerOperationsTester = artifacts.require("./BorrowerOperationsTester.sol");
const TroveManagerTester = artifacts.require("TroveManagerTester");
const MassetManagerTester = artifacts.require("MassetManagerTester");
const ExitFeeControllerMock = artifacts.require("ExitFeeControllerMock");
const NonPayable = artifacts.require("NonPayable");
const ReentrantSurplusClaimer = artifacts.require("ReentrantSurplusClaimer");
const GasSinkFeeReceiver = artifacts.require("GasSinkFeeReceiver");
const LegacyCollSurplusPoolMock = artifacts.require("LegacyCollSurplusPoolMock");

const th = testHelpers.TestHelper;
const dec = th.dec;
const toBN = th.toBN;
const timeValues = testHelpers.TimeValues;
const ZERO_ADDRESS = th.ZERO_ADDRESS;
const assertRevert = th.assertRevert;

const NONE = 0;
const INACTIVE = 1;
const DISABLED = 2;
const INVALID_QUOTE = 3;
const CONTROLLER_REVERT = 4;
const VAULT_REVERT = 5;
const GAS_PRICE = toBN(dec(1, 9));

contract("ColFee — Zero surplus-claim exit fee", async (accounts) => {
    const [owner, alice, whale] = accounts;
    const feeReceiver = accounts[995];
    const multisig = accounts[999];

    let priceFeed;
    let zusdToken;
    let troveManager;
    let activePool;
    let collSurplusPool;
    let borrowerOperations;
    let controller;
    let contracts;
    let zeroStakingAddr;

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

        // Captured for the pre-upgrade-pool test, which re-calls setAddresses (the
        // 12-arg form) to rewire collSurplusPool to a legacy mock; zeroStaking is the
        // only address not exposed on `contracts`.
        zeroStakingAddr = ZEROContracts.zeroStaking.address;

        priceFeed = contracts.priceFeedTestnet;
        zusdToken = contracts.zusdToken;
        troveManager = contracts.troveManager;
        activePool = contracts.activePool;
        collSurplusPool = contracts.collSurplusPool;
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

    // Create a claimable surplus for `claimant` (an EOA) by fully redeeming their
    // ~200%-ICR trove at ETH:USD = 100 (mirrors tests/js/CollSurplusPool.js):
    // surplus == coll - netDebt/price stays in CollSurplusPool for the claimant.
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

    // --- claimCollWithFee access control (pool-side) ---

    it("claimCollWithFee: reverts when caller is not BorrowerOperations", async () => {
        // The surplus is funded FIRST and the reason string is checked, so the
        // caller gate is the only thing that can reject this call. Without both,
        // the test passes on the later `claimableColl > 0` require and would
        // survive deleting `_requireCallerIsBorrowerOperations()` entirely.
        const gross = await setupSurplus(alice);
        await assertRevertWithReason(
            collSurplusPool.claimCollWithFee(alice, feeReceiver, 0, { from: alice }),
            "CollSurplusPool: Caller is not Borrower Operations"
        );
        assert.isTrue(
            (await collSurplusPool.getCollateral(alice)).eq(gross),
            "surplus touched by a rejected call"
        );
    });

    // --- fee-active claim ---

    it("claimCollateral (fee active): feeReceiver += fee, claimant += net, pool getETH -= gross, ExitFeeApplied exact", async () => {
        const gross = await setupSurplus(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE); // 50 bps

        const fee = gross.mul(toBN(50)).div(toBN(10000));
        const net = gross.sub(fee);

        const poolEthBefore = await collSurplusPool.getETH();
        const poolRawBefore = toBN(await web3.eth.getBalance(collSurplusPool.address));
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            (await collSurplusPool.getETH()).eq(poolEthBefore.sub(gross)),
            "pool getETH != -gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(collSurplusPool.address)).eq(poolRawBefore.sub(gross)),
            "pool raw balance != -gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(collSurplusPool.address)).eq(
                await collSurplusPool.getETH()
            ),
            "pool raw balance drifted from getETH()"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(fee)),
            "feeReceiver != +fee"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(net).sub(gasCost)),
            "claimant != +net (minus gas)"
        );
        assert.isTrue(
            (await collSurplusPool.getCollateral(alice)).eq(toBN(0)),
            "claimable not zeroed"
        );

        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev, "ExitFeeApplied not emitted");
        // Pins the surplus claim to its OWN surface: the controller mock ignores
        // surfaceId, so a hook quoting SURFACE_ZERO_WITHDRAW_COLL here would charge
        // the borrower-exit policy on surplus claims and every other assertion in
        // this file would still pass.
        assertSurface(ev, SURFACE_ZERO_CLAIM_SURPLUS, "claimCollateral ExitFeeApplied");
        assert.equal(ev.args.actor, alice);
        assert.equal(ev.args.recipient, alice);
        assert.equal(ev.args.asset, ZERO_ADDRESS);
        assert.equal(ev.args.subProduct, ZERO_ADDRESS);
        assert.equal(ev.args.feeReceiver, feeReceiver);
        assert.isTrue(toBN(ev.args.grossAmount).eq(gross));
        assert.isTrue(toBN(ev.args.feeAmount).eq(fee));
        assert.isTrue(toBN(ev.args.netAmount).eq(net));
        assert.isUndefined(getEvent(tx, "ExitFeeSkipped"));
    });

    it("claimCollateral: controller unset → claimant receives FULL gross, ExitFeeSkipped(CONTROLLER_REVERT), state == baseline", async () => {
        const gross = await setupSurplus(alice);

        const poolEthBefore = await collSurplusPool.getETH();
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue((await collSurplusPool.getETH()).eq(poolEthBefore.sub(gross)));
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore),
            "feeReceiver must be untouched"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "claimant != +FULL gross"
        );
        assert.isTrue((await collSurplusPool.getCollateral(alice)).eq(toBN(0)));

        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev, "ExitFeeSkipped not emitted");
        assertSurface(ev, SURFACE_ZERO_CLAIM_SURPLUS, "claimCollateral ExitFeeSkipped");
        assert.equal(toBN(ev.args.reason).toNumber(), CONTROLLER_REVERT);
        assert.isTrue(toBN(ev.args.grossAmount).eq(gross));
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    it("claimCollateral: fee-path pool drain identical to baseline no-fee drain (no residue)", async () => {
        const gross = await setupSurplus(alice);
        const poolEthBefore = await collSurplusPool.getETH();

        const inner = (await timeMachine.takeSnapshot())["result"];

        // baseline: no controller → untouched claimColl path
        await borrowerOperations.claimCollateral({ from: alice });
        const baseDrain = poolEthBefore.sub(await collSurplusPool.getETH());
        const baseRaw = toBN(await web3.eth.getBalance(collSurplusPool.address));

        await timeMachine.revertToSnapshot(inner);

        // fee-active
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);
        await borrowerOperations.claimCollateral({ from: alice });
        const feeDrain = poolEthBefore.sub(await collSurplusPool.getETH());

        assert.isTrue(baseDrain.eq(gross), "baseline drain != gross");
        assert.isTrue(feeDrain.eq(baseDrain), "fee-path drain != baseline (residue!)");
        assert.isTrue(
            toBN(await web3.eth.getBalance(collSurplusPool.address)).eq(baseRaw),
            "fee-path raw pool balance != baseline"
        );
    });

    // --- fail-open matrix ---

    it("claimCollateral: controller inactive → full gross, ExitFeeSkipped(INACTIVE)", async () => {
        const gross = await setupSurplus(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(false, 50, feeReceiver, INACTIVE);

        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost))
        );
        assert.isTrue(toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore));
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev);
        assert.equal(toBN(ev.args.reason).toNumber(), INACTIVE);
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    it("claimCollateral: controller destroyed after set → full gross, ExitFeeSkipped(CONTROLLER_REVERT)", async () => {
        const gross = await setupSurplus(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);
        await controller.destroy(); // code-less controller → extcodesize fail-open path

        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost))
        );
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev);
        assert.equal(toBN(ev.args.reason).toNumber(), CONTROLLER_REVERT);
    });

    it("claimCollateral: controller reverts → full gross, ExitFeeSkipped(CONTROLLER_REVERT)", async () => {
        const gross = await setupSurplus(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.setRevert(true);

        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost))
        );
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev);
        assert.equal(toBN(ev.args.reason).toNumber(), CONTROLLER_REVERT);
    });

    it("claimCollateral: malformed quote (fee > gross) → full gross, ExitFeeSkipped(INVALID_QUOTE)", async () => {
        const gross = await setupSurplus(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);
        await controller.setForcedAmounts(true, gross.add(toBN(1)), 0);

        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost))
        );
        assert.isTrue(toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore));
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev);
        assert.equal(toBN(ev.args.reason).toNumber(), INVALID_QUOTE);
        assert.equal(
            toBN(ev.args.rateBps).toNumber(),
            50,
            "skip must preserve the controller's rateBps"
        );
    });

    it("claimCollateral: reverting feeReceiver → feePaid=false, full gross to claimant, ExitFeeSkipped(VAULT_REVERT)", async () => {
        const gross = await setupSurplus(alice);
        const badReceiver = await NonPayable.new(); // receive() reverts while isPayable=false
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, badReceiver.address, NONE);

        const poolEthBefore = await collSurplusPool.getETH();
        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            (await collSurplusPool.getETH()).eq(poolEthBefore.sub(gross)),
            "pool != -gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "claimant must receive FULL gross when the fee leg fails"
        );
        assert.isTrue(toBN(await web3.eth.getBalance(badReceiver.address)).eq(toBN(0)));
        assert.isTrue(
            toBN(await web3.eth.getBalance(collSurplusPool.address)).eq(
                await collSurplusPool.getETH()
            ),
            "pool raw balance drifted from getETH()"
        );

        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev);
        assert.equal(toBN(ev.args.reason).toNumber(), VAULT_REVERT);
        assert.equal(toBN(ev.args.rateBps).toNumber(), 50);
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    // --- edges ---

    it("claimCollateral: zero surplus reverts exactly as today (fee active and inactive)", async () => {
        // Reason-checked: the point of this test is that the fee hook does not
        // change WHICH revert a zero-surplus claim produces, so asserting merely
        // "it reverted" would not prove the claim.
        await assertRevertWithReason(
            borrowerOperations.claimCollateral({ from: alice }),
            "CollSurplusPool: No collateral available to claim"
        );
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);
        await assertRevertWithReason(
            borrowerOperations.claimCollateral({ from: alice }),
            "CollSurplusPool: No collateral available to claim"
        );
    });

    it("claimCollateral: 100% fee policy (fee == gross) → user leg sends 0 and succeeds, ExitFeeApplied(net=0)", async () => {
        const gross = await setupSurplus(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 0, feeReceiver, NONE);
        await controller.setForcedAmounts(true, gross, 0); // fee == gross (pool-safe)

        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(gross)),
            "feeReceiver != +gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.sub(gasCost)),
            "claimant should net 0"
        );
        assert.isTrue((await collSurplusPool.getCollateral(alice)).eq(toBN(0)));

        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev);
        assert.isTrue(toBN(ev.args.feeAmount).eq(gross));
        assert.isTrue(toBN(ev.args.netAmount).eq(toBN(0)));
    });

    // --- reentrancy ---

    it("claimCollateral: reentrant claimant gets 'No collateral' on the inner call; single net payout only", async () => {
        const price = toBN(dec(100, 18));
        await priceFeed.setPrice(price);

        const attacker = await ReentrantSurplusClaimer.new(borrowerOperations.address);
        // Attacker opens its own ~200%-ICR trove (mirrors the NonPayable pattern in
        // tests/js/CollSurplusPool.js), then whale fully redeems it → surplus parked
        // for the attacker contract.
        const zusdAmount = toBN(dec(3000, 18));
        const netDebt = await th.getAmountWithBorrowingFee(contracts, zusdAmount);
        await attacker.openTrove(
            toBN(dec(1, 18)),
            zusdAmount,
            attacker.address,
            attacker.address,
            {
                value: toBN(dec(60, 18)),
            }
        );
        await openTrove({
            extraZUSDAmount: netDebt,
            extraParams: { from: whale, value: dec(3000, "ether") },
        });
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);
        await th.redeemCollateralAndGetTxObject(whale, contracts, netDebt);

        const gross = await collSurplusPool.getCollateral(attacker.address);
        assert.isTrue(gross.gt(toBN(0)), "setup failed: no attacker surplus");

        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);
        const fee = gross.mul(toBN(50)).div(toBN(10000));
        const net = gross.sub(fee);

        await attacker.claim();

        assert.isTrue(await attacker.reentryAttempted(), "attacker never re-entered");
        assert.isFalse(await attacker.reentrySucceeded(), "reentrant inner claim MUST revert");
        assert.isTrue(
            toBN(await attacker.totalReceived()).eq(net),
            "attacker got more than one net payout"
        );
        assert.isTrue((await collSurplusPool.getCollateral(attacker.address)).eq(toBN(0)));
        assert.isTrue(
            toBN(await web3.eth.getBalance(collSurplusPool.address)).eq(
                await collSurplusPool.getETH()
            ),
            "pool raw balance drifted from getETH()"
        );
    });

    // --- hardening: fee-leg gas cap (gas-sink receiver cannot starve the claim) ---

    it("claimCollateral: gas-sink feeReceiver (success mode) → FEE_LEG_GAS_CAP bounds the burn, both legs settle, ExitFeeApplied", async () => {
        const gross = await setupSurplus(alice);
        const sink = await GasSinkFeeReceiver.new();
        await sink.setConsumeAll(false); // burn to floor, then RETURN SUCCESS
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, sink.address, NONE);

        const fee = gross.mul(toBN(50)).div(toBN(10000));
        const net = gross.sub(fee);

        const poolEthBefore = await collSurplusPool.getETH();
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        // Explicit generous gas limit: without the cap the sink would burn ~63/64 of
        // it (~1.4M). The gasUsed bound below is the actual cap regression guard: with
        // FEE_LEG_GAS_CAP the whole tx fits comfortably under 500k; delete the cap and
        // the sink's burn pushes gasUsed to ~1.45M, failing this test even though an
        // EOA claimant would still get paid.
        const tx = await borrowerOperations.claimCollateral({
            from: alice,
            gas: 1500000,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isBelow(tx.receipt.gasUsed, 500000, "fee-leg burn not confined by FEE_LEG_GAS_CAP");
        assert.isTrue(
            (await collSurplusPool.getETH()).eq(poolEthBefore.sub(gross)),
            "pool getETH != -gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(net).sub(gasCost)),
            "claimant != +net (minus gas)"
        );
        assert.isTrue(toBN(await sink.totalReceived()).eq(fee), "sink totalReceived != fee");
        assert.isTrue(
            (await collSurplusPool.getCollateral(alice)).eq(toBN(0)),
            "claimable not zeroed"
        );

        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev, "ExitFeeApplied not emitted");
        assert.isTrue(toBN(ev.args.feeAmount).eq(fee));
        assert.isTrue(toBN(ev.args.netAmount).eq(net));
        assert.equal(ev.args.feeReceiver, sink.address);
        assert.isUndefined(getEvent(tx, "ExitFeeSkipped"));
    });

    it("claimCollateral: gas-sink feeReceiver (OOG mode) → fee leg fails fail-open, FULL gross to claimant, ExitFeeSkipped(VAULT_REVERT)", async () => {
        const gross = await setupSurplus(alice);
        const sink = await GasSinkFeeReceiver.new();
        await sink.setConsumeAll(true); // burn until OOG → the fee-leg call fails
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, sink.address, NONE);

        const poolEthBefore = await collSurplusPool.getETH();
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        const tx = await borrowerOperations.claimCollateral({
            from: alice,
            gas: 1500000,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        // Cap regression guard (see success-mode test): an uncapped OOG-mode sink
        // burns its full 63/64 forwarded allowance (~1.4M) before failing.
        assert.isBelow(tx.receipt.gasUsed, 500000, "fee-leg burn not confined by FEE_LEG_GAS_CAP");
        assert.isTrue(
            (await collSurplusPool.getETH()).eq(poolEthBefore.sub(gross)),
            "pool != -gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "claimant must receive FULL gross when the fee leg OOGs"
        );
        assert.isTrue(
            toBN(await sink.totalReceived()).eq(toBN(0)),
            "sink received despite its receive reverting"
        );

        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev);
        assert.equal(toBN(ev.args.reason).toNumber(), VAULT_REVERT);
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    // --- hardening: zero-receiver demotion (fee-burn-to-0x0 hole) ---

    it("claimCollateral: feeReceiver == address(0) demoted → FULL gross to claimant, ExitFeeSkipped(DISABLED), no fee burned", async () => {
        const gross = await setupSurplus(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, ZERO_ADDRESS, NONE); // charging quote into 0x0

        const poolEthBefore = await collSurplusPool.getETH();
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            (await collSurplusPool.getETH()).eq(poolEthBefore.sub(gross)),
            "pool != -gross"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(aliceBefore.add(gross).sub(gasCost)),
            "claimant must receive FULL gross (no fee burned to 0x0)"
        );
        assert.isTrue((await collSurplusPool.getCollateral(alice)).eq(toBN(0)));

        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev, "ExitFeeSkipped not emitted");
        assert.equal(toBN(ev.args.reason).toNumber(), DISABLED);
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });

    // --- ordering precondition guard (activation-ordering hazard, documented) ---

    it("claimCollateral: pre-upgrade pool + active surface REVERTS — pool setImplementation MUST precede surface activation", async () => {
        // Simulate the LIVE pool implementation before the proxy is upgraded: it has
        // claimColl but NOT claimCollWithFee (no fallback). There is intentionally no
        // try/catch in the hook — a pool-side revert must surface loudly rather than
        // silently degrade a fee-active claim into an unfee'd one. This test PINS the
        // deployment ordering: the CollSurplusPool implementation upgrade must land
        // before SURFACE_ZERO_CLAIM_SURPLUS is activated (handled atomically in one SIP).
        const mock = await LegacyCollSurplusPoolMock.new();
        await mock.setBO(borrowerOperations.address);
        await mock.setSurplus(alice, { value: dec(1, "ether") });

        // Rewire BO to the legacy mock (setAddresses is re-callable, onlyOwner). Same
        // 12 addresses as the original wiring, only collSurplusPool swapped.
        await borrowerOperations.setAddresses(
            contracts.feeDistributor.address,
            contracts.liquityBaseParams.address,
            contracts.troveManager.address,
            contracts.activePool.address,
            contracts.defaultPool.address,
            contracts.stabilityPool.address,
            contracts.gasPool.address,
            mock.address, // collSurplusPool → legacy (pre-upgrade) mock
            contracts.priceFeedTestnet.address,
            contracts.sortedTroves.address,
            contracts.zusdToken.address,
            zeroStakingAddr,
            { from: owner }
        );

        // Active surface with feeAmount > 0 → the hook calls the missing selector.
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);

        await assertRevert(borrowerOperations.claimCollateral({ from: alice }));

        // Surplus untouched by the reverted claim.
        assert.isTrue(
            (await mock.getCollateral(alice)).eq(toBN(dec(1, "ether"))),
            "surplus consumed despite revert"
        );

        // Companion safe case: with the surface inactive the claim degrades to the
        // untouched claimColl path, which the legacy pool DOES implement — proving only
        // the active-fee path depends on the pool upgrade.
        await controller.configure(false, 50, feeReceiver, INACTIVE);

        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.claimCollateral({ from: alice, gasPrice: GAS_PRICE });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(
                aliceBefore.add(toBN(dec(1, "ether"))).sub(gasCost)
            ),
            "inactive-surface claim must succeed full-gross via legacy claimColl"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore),
            "feeReceiver must be untouched"
        );
        assert.isTrue(
            (await mock.getCollateral(alice)).eq(toBN(0)),
            "mock surplus not zeroed by claimColl"
        );

        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev, "ExitFeeSkipped not emitted");
        assert.equal(toBN(ev.args.reason).toNumber(), INACTIVE);
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    });
});
