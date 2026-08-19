// Perimeter — Zero exit-fee preview helper.
// previewZeroCollWithdrawExitFee(borrower, grossColl): read-only policy lookup
// hard-wired to PERIMETER_SURFACE_ZERO_WITHDRAW_COLL / subProduct=address(0) / actor=borrower.
// Must agree wei-for-wei with the live _sendCollWithExitFee charge.

const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const testHelpers = require("../utils/js/testHelpers.js");
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
const GAS_PRICE = toBN(dec(1, 9)); // 1 gwei — used to back gas out of the borrower's RBTC delta

contract("Perimeter — Zero exit-fee preview", async (accounts) => {
    const [owner, alice, bob] = accounts;
    const feeReceiver = accounts[995];
    const multisig = accounts[999];

    let activePool;
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

        activePool = contracts.activePool;
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

    const openRoomyTrove = async (from) =>
        openTrove({
            ICR: toBN(dec(10, 18)),
            extraParams: { from, value: toBN(dec(100, "ether")) },
        });

    it("preview matches the live withdrawColl charge wei-for-wei (active fee)", async () => {
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 50, feeReceiver, NONE);

        const gross = toBN(dec(1, "ether"));
        const expectedFee = gross.mul(toBN(50)).div(toBN(10000));

        // preview (read-only, callable by anyone — here bob simulates for alice)
        const p = await borrowerOperations.previewZeroCollWithdrawExitFee(alice, gross, {
            from: bob,
        });
        assert.equal(p.active, true);
        assert.equal(toBN(p.rateBps).toNumber(), 50);
        assert.isTrue(toBN(p.feeAmount).eq(expectedFee));
        assert.isTrue(toBN(p.netAmount).eq(gross.sub(expectedFee)));
        assert.equal(p.feeReceiver, feeReceiver);
        assert.equal(toBN(p.reason).toNumber(), NONE);

        // execute and assert the live charge equals the preview wei-for-wei
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, { from: alice });
        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isTrue(
            toBN(ev.args.feeAmount).eq(toBN(p.feeAmount)),
            "feeAmount preview != execution"
        );
        assert.isTrue(
            toBN(ev.args.netAmount).eq(toBN(p.netAmount)),
            "netAmount preview != execution"
        );
        assert.equal(ev.args.feeReceiver, p.feeReceiver);
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(toBN(p.feeAmount))),
            "feeReceiver delta != preview feeAmount"
        );
    });

    // A preview is only useful if it agrees with EXECUTION. Each non-charging case
    // below therefore executes the same withdrawal and pins the live outcome to the
    // previewed numbers, rather than only asserting the preview's own shape.
    const assertLiveMatchesPreview = async (p, gross) => {
        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));

        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, {
            from: alice,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(
                aliceBefore.add(toBN(p.netAmount)).sub(gasCost)
            ),
            "borrower delta != previewed netAmount"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(toBN(p.feeAmount))),
            "feeReceiver delta != previewed feeAmount"
        );
        const ev = getEvent(tx, "ExitFeeSkipped");
        assert.isDefined(ev, "non-charging execution must emit ExitFeeSkipped");
        assert.equal(
            toBN(ev.args.reason).toNumber(),
            toBN(p.reason).toNumber(),
            "live SkipReason != previewed reason"
        );
        assert.equal(
            toBN(ev.args.rateBps).toNumber(),
            toBN(p.rateBps).toNumber(),
            "live rateBps != previewed rateBps"
        );
        assert.isUndefined(getEvent(tx, "ExitFeeApplied"));
    };

    it("preview reflects fail-open when controller is unset (active=false, CONTROLLER_REVERT, net==gross)", async () => {
        await openRoomyTrove(alice);
        const gross = toBN(dec(1, "ether"));

        const p = await borrowerOperations.previewZeroCollWithdrawExitFee(alice, gross);
        assert.equal(p.active, false);
        assert.isTrue(toBN(p.feeAmount).eq(toBN(0)));
        assert.isTrue(toBN(p.netAmount).eq(gross), "net must equal gross when not charging");
        assert.equal(toBN(p.reason).toNumber(), CONTROLLER_REVERT);

        await assertLiveMatchesPreview(p, gross);
    });

    it("preview distinguishes an active zero-rate (exemption) from a positive charge", async () => {
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 0, feeReceiver, NONE); // active, 0 bps
        const gross = toBN(dec(1, "ether"));

        const p = await borrowerOperations.previewZeroCollWithdrawExitFee(alice, gross);
        assert.equal(p.active, true, "exemption is active=true");
        assert.equal(toBN(p.rateBps).toNumber(), 0);
        assert.isTrue(toBN(p.feeAmount).eq(toBN(0)));
        assert.isTrue(toBN(p.netAmount).eq(gross));
        assert.equal(toBN(p.reason).toNumber(), NONE);

        await assertLiveMatchesPreview(p, gross);
    });

    it("preview agrees with execution on a non-round gross that truncates", async () => {
        // Round inputs (1 ether @ 50 bps) divide exactly, so they cannot show that
        // the preview shares the live truncation. 37 bps on a non-round gross does.
        await openRoomyTrove(alice);
        await borrowerOperations.setExitFeeController(controller.address, { from: owner });
        await controller.configure(true, 37, feeReceiver, NONE);

        const gross = toBN("1234567890123456789");
        const p = await borrowerOperations.previewZeroCollWithdrawExitFee(alice, gross);
        assert.equal(p.active, true);
        assert.isTrue(
            toBN(p.feeAmount)
                .mul(toBN(10000))
                .lt(gross.mul(toBN(37))),
            "chosen gross/rate must truncate, else this test proves nothing"
        );
        assert.isTrue(
            toBN(p.feeAmount).add(toBN(p.netAmount)).eq(gross),
            "previewed fee + net != gross"
        );

        const frBefore = toBN(await web3.eth.getBalance(feeReceiver));
        const aliceBefore = toBN(await web3.eth.getBalance(alice));
        const tx = await borrowerOperations.withdrawColl(gross, alice, alice, {
            from: alice,
            gasPrice: GAS_PRICE,
        });
        const gasCost = GAS_PRICE.mul(toBN(tx.receipt.gasUsed));

        assert.isTrue(
            toBN(await web3.eth.getBalance(feeReceiver)).eq(frBefore.add(toBN(p.feeAmount))),
            "feeReceiver delta != previewed feeAmount"
        );
        assert.isTrue(
            toBN(await web3.eth.getBalance(alice)).eq(
                aliceBefore.add(toBN(p.netAmount)).sub(gasCost)
            ),
            "borrower delta != previewed netAmount"
        );
        const ev = getEvent(tx, "ExitFeeApplied");
        assert.isDefined(ev, "ExitFeeApplied not emitted");
        assert.isTrue(toBN(ev.args.feeAmount).eq(toBN(p.feeAmount)));
        assert.isTrue(toBN(ev.args.netAmount).eq(toBN(p.netAmount)));
    });
});
