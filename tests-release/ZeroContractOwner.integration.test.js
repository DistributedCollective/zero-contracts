const assert = require("assert").strict;
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { fixture, balances, Model, SURPLUS } = require("./helpers/composition");

describe("Zero genuine contract-owner and composite wrapper settlement", function () {
    let ctx;
    let baseline;
    before(async function () {
        ctx = await fixture();
        baseline = await network.provider.send("evm_snapshot");
    });
    beforeEach(async function () {
        await network.provider.send("evm_revert", [baseline]);
        baseline = await network.provider.send("evm_snapshot");
    });

    it("records the DSProxy withdrawal identity and lets a clean outsider pay only that contract", async function () {
        const actor = ctx.contractActor;
        await ctx.open(actor);
        const model = new Model(ctx);
        const id = await model.settle(actor, "withdraw", ethers.parseEther("0.01"), true);
        assert.notEqual(await ethers.provider.getCode(actor.address), "0x");
        await model.release(id, ctx.outsider, "NotUnlocked");
        await model.mature(id);
        await model.control("freeze-executor", () =>
            ctx.queue["freeze(address)"](ctx.outsider.address)
        );
        await model.release(id, ctx.outsider, "ActorBlocked");
        await model.control("clear-executor", () =>
            ctx.queue["unfreeze(address)"](ctx.outsider.address)
        );
        const outsiderBefore = await ethers.provider.getBalance(ctx.outsider.address);
        await model.release(id, ctx.outsider);
        assert(
            (await ethers.provider.getBalance(ctx.outsider.address)) < outsiderBefore,
            "Outsider pays gas and receives no collateral"
        );
        await model.release(id, ctx.outsider, "AlreadyTerminal");
    });

    it("rolls back a held surplus-to-new-trove composite, then permits plain claim, outsider delivery and separate opening", async function () {
        const actor = ctx.contractActor;
        const gross = await ctx.createSurplus(actor);
        const before = await balances(ctx, actor, SURPLUS);
        assert.equal(before.status, "4", "Redemption must close the actual contract-owned trove");
        const payload = ctx.wrapperScript.interface.encodeFunctionData(
            "claimCollateralAndOpenTrove",
            [
                ethers.parseEther("1"),
                ethers.parseEther("200"),
                ethers.ZeroAddress,
                ethers.ZeroAddress,
            ]
        );
        await expect(
            actor.proxy["execute(address,bytes)"](ctx.wrapperScript.target, payload, {
                gasLimit: 8000000,
            })
        ).to.be.revertedWithoutReason();
        assert.deepEqual(
            await balances(ctx, actor, SURPLUS),
            before,
            "Composite revert must restore funded claim, fee, queue, pool and proxy state"
        );
        const model = new Model(ctx);
        const id = await model.settle(actor, "surplus", gross, true);
        await model.mature(id);
        await model.release(id, ctx.outsider);
        const delivered = await ethers.provider.getBalance(actor.address);
        assert(delivered > 0n, "Delivered surplus must be actual native collateral at DSProxy");
        const transfer = ctx.wrapperScript.interface.encodeFunctionData("transferETH", [
            ctx.alice.address,
            delivered,
        ]);
        const ownerBefore = await ethers.provider.getBalance(ctx.alice.address);
        const transferReceipt = await (
            await actor.proxy["execute(address,bytes)"](ctx.wrapperScript.target, transfer)
        ).wait();
        assert.equal(
            await ethers.provider.getBalance(ctx.alice.address),
            ownerBefore + delivered - transferReceipt.gasUsed * transferReceipt.gasPrice,
            "The owner must actually receive the delivered collateral before forwarding it"
        );
        assert.equal(await ethers.provider.getBalance(actor.address), 0n);
        const script = ctx.boScript.interface;
        const open = script.encodeFunctionData("openTrove", [
            ethers.parseEther("1"),
            ethers.parseEther("200"),
            ethers.ZeroAddress,
            ethers.ZeroAddress,
        ]);
        await (
            await actor.proxy["execute(address,bytes)"](ctx.boScript.target, open, {
                value: delivered,
            })
        ).wait();
        assert.equal(String(await ctx.contracts.troveManager.getTroveStatus(actor.address)), "1");
        await model.invariants();
    });

    it("completes the same genuine composite with positive fee when delay is disabled", async function () {
        const actor = ctx.contractActor;
        const gross = await ctx.createSurplus(actor);
        await (await ctx.controller.setSecurityPerimeterEnabled(false)).wait();
        const feeBefore = await ethers.provider.getBalance(ctx.feeReceiver.address);
        const payload = ctx.wrapperScript.interface.encodeFunctionData(
            "claimCollateralAndOpenTrove",
            [
                ethers.parseEther("1"),
                ethers.parseEther("200"),
                ethers.ZeroAddress,
                ethers.ZeroAddress,
            ]
        );
        await (
            await actor.proxy["execute(address,bytes)"](ctx.wrapperScript.target, payload)
        ).wait();
        assert.equal(
            await ethers.provider.getBalance(ctx.feeReceiver.address),
            feeBefore + (gross * 50n) / 10000n
        );
        assert.equal(String(await ctx.contracts.troveManager.getTroveStatus(actor.address)), "1");
        assert.equal(
            String(await ctx.contracts.collSurplusPool.getCollateral(actor.address)),
            "0"
        );
        assert.equal(await ctx.queue.lastRequestId(), 0n);
        assert.equal(await ctx.queue.totalEscrowed(ethers.ZeroAddress), 0n);
        assert.equal(await ethers.provider.getBalance(ctx.queue.target), 0n);
    });
});
