const assert = require("assert").strict;
const fs = require("fs");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { SignatureTransfer } = require("@uniswap/permit2-sdk");
const { fixture } = require("./helpers/composition");
const { requestFromReceipt, WITHDRAW, DELAY } = require("./helpers/core");

const reportPath = process.env.ZERO_NUE_WRAPPER_REPORT;
const results = [];

async function setup(isClose) {
    const ctx = await fixture();
    const masset = await (await ethers.getContractFactory("MassetManagerTester")).deploy();
    await masset.waitForDeployment();
    const nue = await ethers.getContractAt("NueMockToken", await masset.getToken());
    const zusd = await ethers.getContractAt("ZUSDToken", ctx.contracts.zusdToken.address);
    const tm = await ethers.getContractAt("TroveManager", ctx.contracts.troveManager.address);
    const ap = await ethers.getContractAt("ActivePool", ctx.contracts.activePool.address);
    const permit2 = await ethers.getContractAt("Permit2", ctx.contracts.permit2.address);
    await (await ctx.borrower.setMassetManagerAddress(masset.target)).wait();
    await ctx.open(ctx.alice, ethers.parseEther("5"));
    await ctx.open(ctx.whale, ethers.parseEther("5"), ethers.parseEther("10000"));

    const reserve = BigInt(await ctx.borrower.ZUSD_GAS_COMPENSATION());
    const amount = isClose
        ? BigInt(await tm.getTroveDebt(ctx.alice.address)) - reserve
        : ethers.parseEther("50");
    if (isClose) await (await zusd.connect(ctx.whale).transfer(ctx.alice.address, amount)).wait();
    await (await zusd.connect(ctx.alice).approve(masset.target, amount)).wait();
    await (await masset.connect(ctx.alice).mintTo(zusd.target, amount, ctx.alice.address)).wait();
    assert.equal(await nue.balanceOf(ctx.alice.address), amount);
    return { ctx, masset, nue, zusd, tm, ap, permit2, amount };
}

async function signERC2612(ctx, nue, amount) {
    const nonce = BigInt(await nue.nonces(ctx.alice.address));
    const chainId = Number((await ethers.provider.getNetwork()).chainId);
    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const domain = {
        name: await nue.name(),
        version: "1",
        chainId,
        verifyingContract: nue.target,
    };
    const types = {
        Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
        ],
    };
    const signature = await ctx.alice.signTypedData(domain, types, {
        owner: ctx.alice.address,
        spender: ctx.borrower.target,
        value: amount,
        nonce,
        deadline,
    });
    const { v, r, s } = ethers.Signature.from(signature);
    return { params: { deadline, v, r, s }, nonce };
}

async function signPermit2(ctx, nue, permit2, amount, nonce) {
    await (await nue.connect(ctx.alice).approve(permit2.target, ethers.MaxUint256)).wait();
    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp + 3600);
    const typed = {
        permitted: { token: nue.target, amount },
        spender: ctx.borrower.target.toLowerCase(),
        nonce,
        deadline,
    };
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const { domain, types, values } = SignatureTransfer.getPermitData(
        typed,
        permit2.target,
        chainId
    );
    const signature = await ctx.alice.signTypedData(domain, types, values);
    return { permit: { permitted: typed.permitted, nonce, deadline }, signature, nonce };
}

async function state(env, nonce) {
    const { ctx, masset, nue, zusd, tm, ap, permit2 } = env;
    const word = nonce >> 8n;
    return {
        troveStatus: BigInt(await tm.getTroveStatus(ctx.alice.address)),
        troveColl: BigInt(await tm.getTroveColl(ctx.alice.address)),
        troveDebt: BigInt(await tm.getTroveDebt(ctx.alice.address)),
        troveStake: BigInt(await tm.getTroveStake(ctx.alice.address)),
        activeETH: BigInt(await ap.getETH()),
        activeRaw: await ethers.provider.getBalance(ap.target),
        activeDebt: BigInt(await ap.getZUSDDebt()),
        aliceNue: await nue.balanceOf(ctx.alice.address),
        aliceZusd: await zusd.balanceOf(ctx.alice.address),
        massetZusd: await zusd.balanceOf(masset.target),
        borrowerZusd: await zusd.balanceOf(ctx.borrower.target),
        eip2612Nonce: await nue.nonces(ctx.alice.address),
        permit2Bitmap: await permit2.nonceBitmap(ctx.alice.address, word),
        feeReceiverRBTC: await ethers.provider.getBalance(ctx.feeReceiver.address),
        queueRBTC: await ethers.provider.getBalance(ctx.queue.target),
        queueEscrow: await ctx.queue.totalEscrowed(ethers.ZeroAddress),
        lastRequestId: await ctx.queue.lastRequestId(),
    };
}

function serial(value) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, item.toString()]));
}

describe("Real-core Zero NUE collateral-out wrappers", function () {
    it("ZUSD-to-DLLR borrowing stays debt-only with fee and delay armed", async function () {
        const env = await setup(false);
        const { ctx, tm, nue } = env;
        await (await ctx.queue.removeAllowedSource(ctx.borrower.target)).wait();
        const before = await state(env, 0n);
        const borrowed = ethers.parseEther("100");
        await (
            await ctx.borrower
                .connect(ctx.alice)
                .withdrawZusdAndConvertToDLLR(
                    ethers.parseEther("1"),
                    borrowed,
                    ethers.ZeroAddress,
                    ethers.ZeroAddress
                )
        ).wait();
        const after = await state(env, 0n);
        assert.equal(after.lastRequestId, before.lastRequestId);
        assert.equal(after.queueEscrow, before.queueEscrow);
        assert.equal(after.queueRBTC, before.queueRBTC);
        assert.equal(after.feeReceiverRBTC, before.feeReceiverRBTC);
        assert.equal(after.activeETH, before.activeETH);
        assert.equal(after.troveColl, before.troveColl);
        assert(after.troveDebt > before.troveDebt + borrowed);
        assert.equal(after.activeDebt - before.activeDebt, after.troveDebt - before.troveDebt);
        assert.equal(await nue.balanceOf(ctx.alice.address), before.aliceNue + borrowed);
        assert.equal(await tm.getTroveStatus(ctx.alice.address), 1n);
        results.push({
            name: "withdrawZusdAndConvertToDLLR",
            before: serial(before),
            afterRetry: serial(after),
        });
        if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(results, null, 2) + "\n");
    });

    for (const usePermit2 of [false, true]) {
        const name = usePermit2 ? "repayZusdFromDLLRWithPermit2" : "repayZusdFromDLLR";
        it(`${name} stays debt-only with fee and delay armed`, async function () {
            const env = await setup(false);
            const { ctx, nue, permit2, amount } = env;
            const nonce = 765432n;
            const signed = usePermit2
                ? await signPermit2(ctx, nue, permit2, amount, nonce)
                : await signERC2612(ctx, nue, amount);
            await (await ctx.queue.removeAllowedSource(ctx.borrower.target)).wait();
            const before = await state(env, usePermit2 ? nonce : signed.nonce);
            await (
                await (usePermit2
                    ? ctx.borrower
                          .connect(ctx.alice)
                          .repayZusdFromDLLRWithPermit2(
                              amount,
                              ethers.ZeroAddress,
                              ethers.ZeroAddress,
                              signed.permit,
                              signed.signature
                          )
                    : ctx.borrower
                          .connect(ctx.alice)
                          .repayZusdFromDLLR(
                              amount,
                              ethers.ZeroAddress,
                              ethers.ZeroAddress,
                              signed.params
                          ))
            ).wait();
            const after = await state(env, usePermit2 ? nonce : signed.nonce);
            assert.equal(after.lastRequestId, before.lastRequestId);
            assert.equal(after.queueEscrow, before.queueEscrow);
            assert.equal(after.queueRBTC, before.queueRBTC);
            assert.equal(after.feeReceiverRBTC, before.feeReceiverRBTC);
            assert.equal(after.activeETH, before.activeETH);
            assert.equal(after.troveColl, before.troveColl);
            assert.equal(after.troveDebt, before.troveDebt - amount);
            assert.equal(after.activeDebt, before.activeDebt - amount);
            assert.equal(after.aliceNue, before.aliceNue - amount);
            assert.equal(after.massetZusd, before.massetZusd - amount);
            if (usePermit2) {
                const bit = 1n << (nonce & 255n);
                assert.equal((after.permit2Bitmap ^ before.permit2Bitmap) & bit, bit);
                assert.equal(after.eip2612Nonce, before.eip2612Nonce);
            } else {
                assert.equal(after.eip2612Nonce, before.eip2612Nonce + 1n);
                assert.equal(after.permit2Bitmap, before.permit2Bitmap);
            }
            results.push({ name, before: serial(before), afterRetry: serial(after) });
            if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(results, null, 2) + "\n");
        });
    }

    for (const isClose of [false, true]) {
        for (const usePermit2 of [false, true]) {
            const name = `${isClose ? "closeNueTrove" : "adjustNueTrove"}${
                usePermit2 ? "WithPermit2" : ""
            }`;
            it(`${name}: refusal rolls back conversion, nonce, trove and pools; same permit retries`, async function () {
                assert(!process.env.ZERO_RELEASE_FORK_RPC, "run without a fork");
                const env = await setup(isClose);
                const { ctx, nue, permit2, tm, ap, amount } = env;
                const nonce = 123456n + BigInt(isClose ? 100 : 0);
                const signed = usePermit2
                    ? await signPermit2(ctx, nue, permit2, amount, nonce)
                    : await signERC2612(ctx, nue, amount);
                const trackedNonce = usePermit2 ? nonce : signed.nonce;
                const gross = isClose
                    ? BigInt(await tm.getTroveColl(ctx.alice.address))
                    : ethers.parseEther("0.5");
                const call = () => {
                    if (isClose)
                        return usePermit2
                            ? ctx.borrower
                                  .connect(ctx.alice)
                                  .closeNueTroveWithPermit2(signed.permit, signed.signature)
                            : ctx.borrower.connect(ctx.alice).closeNueTrove(signed.params);
                    return usePermit2
                        ? ctx.borrower
                              .connect(ctx.alice)
                              .adjustNueTroveWithPermit2(
                                  ethers.parseEther("1"),
                                  gross,
                                  amount,
                                  false,
                                  ethers.ZeroAddress,
                                  ethers.ZeroAddress,
                                  signed.permit,
                                  signed.signature
                              )
                        : ctx.borrower
                              .connect(ctx.alice)
                              .adjustNueTrove(
                                  ethers.parseEther("1"),
                                  gross,
                                  amount,
                                  false,
                                  ethers.ZeroAddress,
                                  ethers.ZeroAddress,
                                  signed.params
                              );
                };

                await (await ctx.queue.removeAllowedSource(ctx.borrower.target)).wait();
                const before = await state(env, trackedNonce);
                await expect(call()).to.be.revertedWithCustomError(
                    ctx.queue,
                    "UnregisteredSource"
                );
                const failed = await state(env, trackedNonce);
                assert.deepEqual(
                    failed,
                    before,
                    "record refusal must roll back all token and pool effects"
                );
                await (await ctx.queue.addAllowedSource(ctx.borrower.target)).wait();
                const receipt = await (await call()).wait();
                const request = await requestFromReceipt(ctx.queue, receipt);
                const after = await state(env, trackedNonce);
                const fee = (gross * 50n) / 10000n;
                const net = gross - fee;
                assert.equal(request.amount, net);
                assert.equal(request.originator, ctx.alice.address);
                assert.equal(request.owner, ctx.alice.address);
                assert.equal(request.receiver, ctx.alice.address);
                assert.equal(request.surfaceId, WITHDRAW);
                assert.equal(request.unlockAt - request.createdAt, BigInt(DELAY));
                assert.equal(after.activeETH, before.activeETH - gross);
                assert.equal(after.activeRaw, before.activeRaw - gross);
                assert.equal(after.feeReceiverRBTC, before.feeReceiverRBTC + fee);
                assert.equal(after.queueRBTC, before.queueRBTC + net);
                assert.equal(after.queueEscrow, before.queueEscrow + net);
                assert.equal(after.lastRequestId, before.lastRequestId + 1n);
                assert.equal(after.aliceNue, before.aliceNue - amount);
                assert.equal(after.aliceZusd, before.aliceZusd);
                assert.equal(after.massetZusd, before.massetZusd - amount);
                assert.equal(after.borrowerZusd, before.borrowerZusd);
                if (isClose) {
                    assert.equal(after.troveStatus, 2n);
                    assert.equal(after.troveColl, 0n);
                    assert.equal(after.troveDebt, 0n);
                    assert.equal(after.troveStake, 0n);
                    assert.equal(after.activeDebt, before.activeDebt - before.troveDebt);
                } else {
                    assert.equal(after.troveStatus, 1n);
                    assert.equal(after.troveColl, before.troveColl - gross);
                    assert.equal(after.troveDebt, before.troveDebt - amount);
                    assert.equal(after.activeDebt, before.activeDebt - amount);
                }
                if (usePermit2) {
                    const bit = 1n << (nonce & 255n);
                    assert.equal((after.permit2Bitmap ^ before.permit2Bitmap) & bit, bit);
                    assert.equal(after.eip2612Nonce, before.eip2612Nonce);
                } else {
                    assert.equal(after.eip2612Nonce, before.eip2612Nonce + 1n);
                    assert.equal(after.permit2Bitmap, before.permit2Bitmap);
                }
                results.push({
                    name,
                    gross: gross.toString(),
                    amount: amount.toString(),
                    fee: fee.toString(),
                    net: net.toString(),
                    before: serial(before),
                    afterRefusal: serial(failed),
                    afterRetry: serial(after),
                });
                if (reportPath)
                    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2) + "\n");
            });
        }
    }
});
