const assert = require("assert").strict,
    fs = require("fs");
const { ethers, network } = require("hardhat");
const dh = require("../utils/js/deploymentHelpers.js");
const { TestHelper: th } = require("../utils/js/testHelpers.js");
const { deployCore, SURPLUS } = require("./helpers/core.js");
const variants = ["plain", "charged", "queued"],
    modes = ["liquidate", "liquidateTroves", "batchLiquidateTroves"];
const results = [];
let c,
    owner,
    bob,
    carol,
    whale,
    other,
    fee,
    bo,
    tm,
    ap,
    dp,
    csp,
    receiver,
    core,
    baseline,
    gross,
    poolBefore;
const value = (x) => BigInt(x.toString());
async function state() {
    return {
        activeETH: value(await ap.getETH()),
        defaultETH: value(await dp.getETH()),
        activeDebt: value(await ap.getZUSDDebt()),
        defaultDebt: value(await dp.getZUSDDebt()),
        stakesSnapshot: value(await tm.totalStakesSnapshot()),
        collateralSnapshot: value(await tm.totalCollateralSnapshot()),
        bobStatus: value(await tm.getTroveStatus(bob.address)),
        carolColl: value(await tm.getTroveColl(carol.address)),
        carolDebt: value(await tm.getTroveDebt(carol.address)),
        carolStake: value(await tm.getTroveStake(carol.address)),
        carolPendingETH: value(await tm.getPendingETHReward(carol.address)),
        carolPendingDebt: value(await tm.getPendingZUSDDebtReward(carol.address)),
        surplusClaim: value(await csp.getCollateral(receiver.target)),
        surplusTracked: value(await csp.getETH()),
        surplusNative: value(await ethers.provider.getBalance(csp.target)),
        feeBalance: value(await ethers.provider.getBalance(fee.address)),
        receiverBalance: value(await ethers.provider.getBalance(receiver.target)),
        queueEscrow: value(await core.queue.totalEscrowed(ethers.ZeroAddress)),
        queueBalance: value(await ethers.provider.getBalance(core.queue.target)),
    };
}
const encode = (x) =>
    JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
describe("Ordinary surplus claimant settlement with public liquidation callback", function () {
    before(async () => {
        assert(!process.env.ZERO_RELEASE_FORK_RPC);
        [owner, bob, carol, whale, other, fee] = await ethers.getSigners();
        c = await dh.deployLiquityCoreHardhat();
        const zero = await dh.deployZEROTesterContractsHardhat(owner.address);
        await zero.zeroToken.unprotectedMint(owner.address, th.dec(20, 24));
        await dh.connectZEROContracts(zero);
        await dh.connectCoreContracts(c, zero);
        await dh.connectZEROContractsToCore(zero, c);
        bo = await ethers.getContractAt("BorrowerOperations", c.borrowerOperations.address);
        tm = await ethers.getContractAt("TroveManager", c.troveManager.address);
        ap = await ethers.getContractAt("ActivePool", c.activePool.address);
        dp = await ethers.getContractAt("DefaultPool", c.defaultPool.address);
        csp = await ethers.getContractAt("CollSurplusPool", c.collSurplusPool.address);
        core = await deployCore({
            owner,
            source: bo.target,
            wrbtc: c.wrbtcTokenTester.address,
            feeReceiver: fee.address,
        });
        await (await core.queue.setMinimumDelaySeconds(86400)).wait();
        await (await bo.setExitFeeController(core.controller.target)).wait();
        await (await bo.setExitDelayQueue(core.queue.target)).wait();
        receiver = await (
            await ethers.getContractFactory("ClaimLiquidationObserver")
        ).deploy(bo.target, tm.target, csp.target);
        await receiver.waitForDeployment();
        async function open(a, ratio, amount = ethers.parseEther("2000")) {
            const borrowingFee = value(await tm.getBorrowingFeeWithDecay(amount));
            const reserve = await bo.ZUSD_GAS_COMPENSATION(),
                price = value(await c.priceFeedTestnet.getPrice());
            const collateral =
                (ethers.parseEther(ratio) * (amount + borrowingFee + reserve)) / price;
            if (a === receiver) await (await receiver.open(amount, { value: collateral })).wait();
            else
                await (
                    await bo
                        .connect(a)
                        .openTrove(
                            ethers.parseEther("1"),
                            amount,
                            ethers.ZeroAddress,
                            ethers.ZeroAddress,
                            { value: collateral }
                        )
                ).wait();
        }
        await open(receiver, "1.6");
        await open(bob, "2");
        await open(other, "2.1");
        await open(carol, "3");
        await open(whale, "10", ethers.parseEther("20000"));
        await network.provider.send("evm_increaseTime", [1209601]);
        await network.provider.send("evm_mine");
        const net =
            value(await tm.getTroveDebt(receiver.target)) -
            value(await bo.ZUSD_GAS_COMPENSATION());
        await th.redeemCollateralAndGetTxObject(whale.address, c, th.toBN(net.toString()));
        gross = value(await csp.getCollateral(receiver.target));
        poolBefore = value(await csp.getETH());
        assert(gross > 0n);
        assert.equal(value(await tm.getTroveStatus(receiver.target)), 4n);
        await c.priceFeedTestnet.setPrice(th.dec(100, 18));
        const price = ethers.parseEther("100");
        assert((await tm.getCurrentICR(bob.address, price)) < (await tm.MCR()));
        assert.equal(await tm.checkRecoveryMode(price), false);
        assert.equal(value(await core.queue.minimumDelaySeconds()), 86400n);
        baseline = await network.provider.send("evm_snapshot");
    });
    async function replay(variant, mode, callback) {
        await network.provider.send("evm_revert", [baseline]);
        baseline = await network.provider.send("evm_snapshot");
        await (await core.controller.setSurfacePolicy(SURPLUS, [variant !== "plain", 50])).wait();
        await (await core.controller.setSecurityPerimeterEnabled(variant === "queued")).wait();
        await (await receiver.configure(bob.address, mode, callback)).wait();
        const before = await state();
        const receipt = await (await receiver.claim()).wait();
        assert.equal(value(await csp.getCollateral(receiver.target)), 0n);
        assert.equal(value(await csp.getETH()), poolBefore - gross);
        const expectedFee = variant === "plain" ? 0n : (gross * 50n) / 10000n,
            net = gross - expectedFee;
        assert.equal((await state()).feeBalance - before.feeBalance, expectedFee);
        if (variant === "queued") {
            assert.equal(await receiver.observed(), false);
            assert.equal((await state()).receiverBalance, before.receiverBalance);
            assert.equal(value(await core.queue.totalEscrowed(ethers.ZeroAddress)), net);
            assert.equal(value(await ethers.provider.getBalance(core.queue.target)), net);
            const id = await core.queue.lastRequestId(),
                r = await core.queue.getRequest(id);
            assert.equal(r.owner, receiver.target);
            assert.equal(r.receiver, receiver.target);
            assert.equal(value(r.amount), net);
            assert.equal(value(r.unlockAt) - value(r.createdAt), 86400n);
            await network.provider.send("evm_increaseTime", [86401]);
            await network.provider.send("evm_mine");
            await (await core.queue.connect(other).executeExit(id)).wait();
            assert.equal(value((await core.queue.getRequest(id)).status), 2n);
        }
        if (!callback) await (await receiver.settleThenLiquidate()).wait();
        assert.equal(await receiver.succeeded(), true, "Real liquidation must succeed");
        assert.equal(await receiver.observed(), callback);
        if (callback) {
            assert.equal(
                value(await receiver.claimAtCallback()),
                0n,
                "Claim must be cleared at callback"
            );
            assert.equal(
                value(await receiver.trackedAtCallback()),
                poolBefore - gross,
                "Full gross tracked debit must precede callback"
            );
            assert.equal(value(await receiver.nativeAtCallback()), poolBefore - gross);
            assert.equal(value(await receiver.payoutAtCallback()), net);
        }
        const settled = await state();
        assert.equal(settled.bobStatus, 3n);
        assert.equal(settled.queueEscrow, 0n);
        assert.equal(settled.queueBalance, 0n);
        assert(settled.carolPendingETH > 0n && settled.carolPendingDebt > 0n);
        await (
            await bo.connect(carol).addColl(ethers.ZeroAddress, ethers.ZeroAddress, {
                value: ethers.parseEther("0.1"),
            })
        ).wait();
        const adjusted = await state();
        assert.equal(adjusted.carolPendingETH, 0n);
        assert.equal(adjusted.carolPendingDebt, 0n);
        await (await tm.connect(owner).liquidate(other.address)).wait();
        assert.equal(value(await tm.getTroveStatus(other.address)), 3n);
        const redistributed = await state();
        assert(redistributed.carolPendingETH > 0n && redistributed.carolPendingDebt > 0n);
        return { before, settled, adjusted, redistributed, gross, expectedFee, net };
    }
    for (const variant of variants)
        for (let mode = 0; mode < modes.length; mode++)
            it(`${variant} claim then ${modes[mode]} observes settled accounting`, async () => {
                const passive = await replay(variant, mode, false),
                    callback = await replay(variant, mode, true);
                assert.deepEqual(
                    callback,
                    passive,
                    "Callback and after-payout composition must have identical economic state"
                );
                results.push(encode({ variant, entry: modes[mode], passive, callback }));
                if (process.env.ZERO_CLAIM_COMPARISON_REPORT)
                    fs.writeFileSync(
                        process.env.ZERO_CLAIM_COMPARISON_REPORT,
                        JSON.stringify(results, null, 2) + "\n"
                    );
            });
});
