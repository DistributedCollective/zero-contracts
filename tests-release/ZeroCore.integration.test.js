const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const deploymentHelper = require("../utils/js/deploymentHelpers.js");
const { TestHelper: th, TimeValues: timeValues } = require("../utils/js/testHelpers.js");
const { deployCore, requestFromReceipt, WITHDRAW, SURPLUS, DELAY } = require("./helpers/core");
const { verifyZeroReleaseArtifacts } = require("./helpers/zero");

describe("Zero exact-release integration with real Perimeter core", function () {
    let contracts;
    let owner;
    let alice;
    let whale;
    let outsider;
    let feeReceiver;
    let borrower;
    let controller;
    let queue;
    let snapshot;

    before(async function () {
        if (process.env.ZERO_RELEASE_FORK_RPC) throw new Error("Run this suite without a fork");
        await verifyZeroReleaseArtifacts();
        [owner, alice, whale, outsider, feeReceiver] = await ethers.getSigners();
        contracts = await deploymentHelper.deployLiquityCoreHardhat();
        const zero = await deploymentHelper.deployZEROTesterContractsHardhat(owner.address);
        await zero.zeroToken.unprotectedMint(owner.address, th.dec(20, 24));
        await deploymentHelper.connectZEROContracts(zero);
        await deploymentHelper.connectCoreContracts(contracts, zero);
        await deploymentHelper.connectZEROContractsToCore(zero, contracts);
        borrower = await ethers.getContractAt(
            "BorrowerOperations",
            contracts.borrowerOperations.address
        );
        ({ controller, queue } = await deployCore({
            owner,
            source: borrower.target,
            wrbtc: contracts.wrbtcTokenTester.address,
            feeReceiver: feeReceiver.address,
        }));
        await (await borrower.setExitFeeController(controller.target)).wait();
        await (await borrower.setExitDelayQueue(queue.target)).wait();
    });

    beforeEach(async function () {
        snapshot = await network.provider.send("evm_snapshot");
    });

    afterEach(async function () {
        await network.provider.send("evm_revert", [snapshot]);
    });

    async function open(actor, extra = {}) {
        const amount =
            ethers.parseEther("2000") + BigInt(extra.extraZUSDAmount?.toString() || "0");
        const fee = BigInt(
            (await contracts.troveManager.getBorrowingFeeWithDecay(amount.toString())).toString()
        );
        const reserve = await borrower.ZUSD_GAS_COMPENSATION();
        const price = BigInt((await contracts.priceFeedTestnet.getPrice()).toString());
        const ratio = BigInt(extra.ICR?.toString() || ethers.parseEther("3").toString());
        const value = extra.extraParams?.value || (ratio * (amount + fee + reserve)) / price;
        await (
            await borrower
                .connect(actor)
                .openTrove(
                    ethers.parseEther("1"),
                    amount,
                    ethers.ZeroAddress,
                    ethers.ZeroAddress,
                    { value }
                )
        ).wait();
        const debt = BigInt((await contracts.troveManager.getTroveDebt(actor.address)).toString());
        return { netDebt: th.toBN((debt - reserve).toString()) };
    }

    async function assertQueued(transaction, gross, surface) {
        const pool =
            surface === SURPLUS ? contracts.collSurplusPool.address : contracts.activePool.address;
        const poolBefore = await ethers.provider.getBalance(pool);
        const feeBefore = await ethers.provider.getBalance(feeReceiver.address);
        const queueBefore = await queue.totalEscrowed(ethers.ZeroAddress);
        const receipt = await (await transaction()).wait();
        const request = await requestFromReceipt(queue, receipt);
        const fee = (gross * 50n) / 10000n;
        expect(request.amount).to.equal(gross - fee);
        expect(request.originator).to.equal(alice.address);
        expect(request.owner).to.equal(alice.address);
        expect(request.receiver).to.equal(alice.address);
        expect(request.token).to.equal(ethers.ZeroAddress);
        expect(request.surfaceId).to.equal(surface);
        expect(request.subProduct).to.equal(ethers.ZeroAddress);
        expect(request.unlockAt - request.createdAt).to.equal(BigInt(DELAY));
        expect(await queue.totalEscrowed(ethers.ZeroAddress)).to.equal(queueBefore + gross - fee);
        expect(await ethers.provider.getBalance(feeReceiver.address)).to.equal(feeBefore + fee);
        expect(await ethers.provider.getBalance(pool)).to.equal(poolBefore - gross);
        return request;
    }

    it("withdrawal charges the fee first and records the exact net with immutable actors", async function () {
        await open(alice);
        await assertQueued(
            () =>
                borrower
                    .connect(alice)
                    .withdrawColl(ethers.parseEther("1"), alice.address, alice.address),
            ethers.parseEther("1"),
            WITHDRAW
        );
    });

    it("adjustTrove uses the same real-core measured native receipt", async function () {
        await open(alice);
        await assertQueued(
            () =>
                borrower
                    .connect(alice)
                    .adjustTrove(
                        ethers.parseEther("1"),
                        ethers.parseEther("1"),
                        0,
                        false,
                        alice.address,
                        alice.address
                    ),
            ethers.parseEther("1"),
            WITHDRAW
        );
    });

    it("closeTrove escrows all collateral and closes only after real queue recording succeeds", async function () {
        await open(alice);
        await open(whale);
        await contracts.zusdToken.transfer(alice.address, th.dec(100, 18), {
            from: whale.address,
        });
        const gross = BigInt(
            (await contracts.troveManager.getTroveColl(alice.address)).toString()
        );
        await assertQueued(() => borrower.connect(alice).closeTrove(), gross, WITHDRAW);
        expect((await contracts.troveManager.getTroveStatus(alice.address)).toString()).to.equal(
            "2"
        );
    });

    it("record rejection rolls back a positive fee, pool debit and trove collateral, then permits retry", async function () {
        await open(alice);
        await (await queue.removeAllowedSource(borrower.target)).wait();
        const collateral = await contracts.troveManager.getTroveColl(alice.address);
        const poolBefore = await ethers.provider.getBalance(contracts.activePool.address);
        const feeBefore = await ethers.provider.getBalance(feeReceiver.address);
        await expect(
            borrower
                .connect(alice)
                .withdrawColl(ethers.parseEther("1"), alice.address, alice.address)
        ).to.be.revertedWithCustomError(queue, "UnregisteredSource");
        expect((await contracts.troveManager.getTroveColl(alice.address)).toString()).to.equal(
            collateral.toString()
        );
        expect(await ethers.provider.getBalance(contracts.activePool.address)).to.equal(
            poolBefore
        );
        expect(await ethers.provider.getBalance(feeReceiver.address)).to.equal(feeBefore);
        expect(await queue.lastRequestId()).to.equal(0n);
        await (await queue.addAllowedSource(borrower.target)).wait();
        await assertQueued(
            () =>
                borrower
                    .connect(alice)
                    .withdrawColl(ethers.parseEther("1"), alice.address, alice.address),
            ethers.parseEther("1"),
            WITHDRAW
        );
    });

    it("fee-receiver failure escrows gross rather than bypassing the real delay", async function () {
        await open(alice);
        const nonPayable = await (await ethers.getContractFactory("NonPayable")).deploy();
        await (await controller.setFeeReceiver(nonPayable.target)).wait();
        const receipt = await (
            await borrower
                .connect(alice)
                .withdrawColl(ethers.parseEther("1"), alice.address, alice.address)
        ).wait();
        expect((await requestFromReceipt(queue, receipt)).amount).to.equal(ethers.parseEther("1"));
        expect(await ethers.provider.getBalance(nonPayable.target)).to.equal(0n);
    });

    it("disabled perimeter pays directly even when the queue source is unregistered", async function () {
        await open(alice);
        await (await controller.setSecurityPerimeterEnabled(false)).wait();
        await (await queue.removeAllowedSource(borrower.target)).wait();
        await (
            await borrower
                .connect(alice)
                .withdrawColl(ethers.parseEther("1"), alice.address, alice.address)
        ).wait();
        expect(await queue.lastRequestId()).to.equal(0n);
        expect(await queue.totalEscrowed(ethers.ZeroAddress)).to.equal(0n);
        expect(await ethers.provider.getBalance(queue.target)).to.equal(0n);
    });

    it("queue floor rejects an undersized delay atomically", async function () {
        await open(alice);
        await (await controller.setGlobalDelaySeconds(1)).wait();
        await expect(
            borrower
                .connect(alice)
                .withdrawColl(ethers.parseEther("1"), alice.address, alice.address)
        ).to.be.revertedWithCustomError(queue, "DelayBelowFloor");
        expect(await queue.lastRequestId()).to.equal(0n);
        expect(await ethers.provider.getBalance(queue.target)).to.equal(0n);
    });

    it("early, unauthorized, frozen and duplicate release fail; eligible release pays exactly once", async function () {
        await open(alice);
        const request = await assertQueued(
            () =>
                borrower
                    .connect(alice)
                    .withdrawColl(ethers.parseEther("1"), alice.address, alice.address),
            ethers.parseEther("1"),
            WITHDRAW
        );
        await expect(queue.connect(alice).executeExit(1)).to.be.revertedWithCustomError(
            queue,
            "NotUnlocked"
        );
        await network.provider.send("evm_setNextBlockTimestamp", [Number(request.unlockAt)]);
        await network.provider.send("evm_mine");
        await expect(queue.connect(outsider).executeExit(1)).to.be.revertedWithCustomError(
            queue,
            "NotExecutor"
        );
        await (
            await queue["freezeFromRequest(uint256,bool,bytes32)"](
                1,
                true,
                ethers.id("release-proof")
            )
        ).wait();
        await expect(queue.connect(alice).executeExit(1)).to.be.revertedWithCustomError(
            queue,
            "ActorBlocked"
        );
        await (await queue["unfreeze(address)"](alice.address)).wait();
        const balanceBefore = await ethers.provider.getBalance(alice.address);
        const receipt = await (await queue.connect(alice).executeExit(1)).wait();
        const gas = receipt.gasUsed * receipt.gasPrice;
        expect(await ethers.provider.getBalance(alice.address)).to.equal(
            balanceBefore + request.amount - gas
        );
        expect((await queue.getRequest(1)).status).to.equal(2n);
        expect(await queue.totalEscrowed(ethers.ZeroAddress)).to.equal(0n);
        await expect(queue.connect(alice).executeExit(1)).to.be.revertedWithCustomError(
            queue,
            "AlreadyTerminal"
        );
    });

    async function createSurplus() {
        await contracts.priceFeedTestnet.setPrice(th.dec(100, 18));
        const { netDebt } = await open(alice, { ICR: th.toBN(th.dec(200, 16)) });
        await open(whale, {
            extraZUSDAmount: netDebt,
            extraParams: { from: whale.address, value: th.dec(3000, "ether") },
        });
        await th.fastForwardTime(timeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);
        await th.redeemCollateralAndGetTxObject(whale.address, contracts, netDebt);
        const gross = BigInt(
            (await contracts.collSurplusPool.getCollateral(alice.address)).toString()
        );
        expect(gross).to.be.greaterThan(0n);
        return gross;
    }

    it("funded surplus charges a fee and escrows the exact net in the real queue", async function () {
        const gross = await createSurplus();
        await assertQueued(() => borrower.connect(alice).claimCollateral(), gross, SURPLUS);
        expect((await contracts.collSurplusPool.getCollateral(alice.address)).toString()).to.equal(
            "0"
        );
    });

    it("surplus record rejection restores the funded claim and positive fee before retry", async function () {
        const gross = await createSurplus();
        await (await queue.removeAllowedSource(borrower.target)).wait();
        const feeBefore = await ethers.provider.getBalance(feeReceiver.address);
        const poolBefore = await ethers.provider.getBalance(contracts.collSurplusPool.address);
        await expect(borrower.connect(alice).claimCollateral()).to.be.revertedWithCustomError(
            queue,
            "UnregisteredSource"
        );
        expect((await contracts.collSurplusPool.getCollateral(alice.address)).toString()).to.equal(
            gross.toString()
        );
        expect(await ethers.provider.getBalance(feeReceiver.address)).to.equal(feeBefore);
        expect(await ethers.provider.getBalance(contracts.collSurplusPool.address)).to.equal(
            poolBefore
        );
        await (await queue.addAllowedSource(borrower.target)).wait();
        await assertQueued(() => borrower.connect(alice).claimCollateral(), gross, SURPLUS);
    });
});
