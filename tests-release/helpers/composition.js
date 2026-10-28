const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const deploymentHelper = require("../../utils/js/deploymentHelpers.js");
const { TestHelper: th, TimeValues } = require("../../utils/js/testHelpers.js");
const { deployCore, requestFromReceipt, WITHDRAW, SURPLUS, DELAY } = require("./core");
const { verifyZeroReleaseArtifacts } = require("./zero");

function random(seed) {
    let state = seed >>> 0;
    assert(state !== 0, "Seed must be nonzero");
    return (maximum) => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % maximum;
    };
}

async function fixture() {
    assert(!process.env.ZERO_RELEASE_FORK_RPC, "Composition proof must run without a fork");
    const provenance = await verifyZeroReleaseArtifacts();
    const [owner, alice, bob, carol, whale, outsider, feeReceiver] = await ethers.getSigners();
    const contracts = await deploymentHelper.deployLiquityCoreHardhat();
    const zero = await deploymentHelper.deployZEROTesterContractsHardhat(owner.address);
    await zero.zeroToken.unprotectedMint(owner.address, th.dec(20, 24));
    await deploymentHelper.connectZEROContracts(zero);
    await deploymentHelper.connectCoreContracts(contracts, zero);
    await deploymentHelper.connectZEROContractsToCore(zero, contracts);
    const borrower = await ethers.getContractAt(
        "BorrowerOperations",
        contracts.borrowerOperations.address
    );
    const core = await deployCore({
        owner,
        source: borrower.target,
        wrbtc: contracts.wrbtcTokenTester.address,
        feeReceiver: feeReceiver.address,
    });
    await (await borrower.setExitFeeController(core.controller.target)).wait();
    await (await borrower.setExitDelayQueue(core.queue.target)).wait();
    const boScript = await (
        await ethers.getContractFactory("BorrowerOperationsScript")
    ).deploy(borrower.target);
    const wrapperScript = await (
        await ethers.getContractFactory("BorrowerWrappersScript")
    ).deploy(
        borrower.target,
        contracts.troveManager.address,
        zero.zeroStaking.address,
        contracts.stabilityPool.address,
        contracts.priceFeedTestnet.address,
        contracts.zusdToken.address,
        zero.zeroToken.address
    );
    const proxyFactory = await (await ethers.getContractFactory("DSProxyFactory")).deploy();
    const built = await (await proxyFactory.connect(alice)["build()"]()).wait();
    const created = built.logs
        .map((log) => {
            try {
                return proxyFactory.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((log) => log?.name === "Created");
    const proxy = await ethers.getContractAt("DSProxy", created.args.proxy, alice);
    const contractActor = { address: proxy.target, signer: alice, proxy };
    const nonPayable = await (await ethers.getContractFactory("NonPayable")).deploy();
    if (process.env.ZERO_COMPOSITION_MUTANT_FILE) {
        const filename = process.env.ZERO_COMPOSITION_MUTANT_FILE;
        assert(path.isAbsolute(filename), "Mutation artifact must have an absolute path");
        assert(
            !filename.startsWith(path.resolve(__dirname, "../..") + path.sep),
            "Mutation must stay outside the repository"
        );
        const artifact = JSON.parse(fs.readFileSync(filename, "utf8"));
        assert.equal(artifact.contractName, "BorrowerOperationsPerimeterOps");
        assert(artifact.mutation && artifact.originalInputSha256, "Mutation manifest is required");
        const mutated = await new ethers.ContractFactory(
            artifact.abi,
            artifact.bytecode,
            owner
        ).deploy();
        await (await borrower.setPerimeterOps(mutated.target)).wait();
    }
    const ctx = {
        contracts,
        zero,
        borrower,
        ...core,
        owner,
        alice,
        bob,
        carol,
        whale,
        outsider,
        feeReceiver,
        boScript,
        wrapperScript,
        contractActor,
        nonPayable,
        provenance,
    };
    ctx.invoke = async (actor, name, args = [], overrides = {}) => {
        if (actor.proxy)
            return actor.proxy["execute(address,bytes)"](
                boScript.target,
                boScript.interface.encodeFunctionData(name, args),
                overrides
            );
        return borrower.connect(actor)[name](...args, overrides);
    };
    ctx.open = async (
        actor,
        ratio = ethers.parseEther("3"),
        amount = ethers.parseEther("2000")
    ) => {
        const fee = BigInt(
            (await contracts.troveManager.getBorrowingFeeWithDecay(amount.toString())).toString()
        );
        const reserve = await borrower.ZUSD_GAS_COMPENSATION();
        const price = BigInt((await contracts.priceFeedTestnet.getPrice()).toString());
        await (
            await ctx.invoke(
                actor,
                "openTrove",
                [ethers.parseEther("1"), amount, ethers.ZeroAddress, ethers.ZeroAddress],
                { value: (ratio * (amount + fee + reserve)) / price }
            )
        ).wait();
        return (
            BigInt((await contracts.troveManager.getTroveDebt(actor.address)).toString()) - reserve
        );
    };
    ctx.createSurplus = async (actor) => {
        const netDebt = await ctx.open(actor, ethers.parseEther("2"));
        if (String(await contracts.troveManager.getTroveStatus(whale.address)) !== "1")
            await ctx.open(whale, ethers.parseEther("100"), ethers.parseEther("100000"));
        await th.fastForwardTime(TimeValues.SECONDS_IN_ONE_WEEK * 2, web3.currentProvider);
        await th.redeemCollateralAndGetTxObject(
            whale.address,
            contracts,
            th.toBN(netDebt.toString())
        );
        const gross = BigInt(
            (await contracts.collSurplusPool.getCollateral(actor.address)).toString()
        );
        assert(gross > 0n, "Real redemption must produce positive surplus");
        return gross;
    };
    return ctx;
}

function requestIdentity(request) {
    return [
        request.amount,
        request.surfaceId,
        request.token,
        request.subProduct,
        request.originator,
        request.owner,
        request.receiver,
        request.createdAt,
        request.unlockAt,
    ].map(String);
}

async function balances(ctx, actor, surface = WITHDRAW) {
    const pool = surface === SURPLUS ? ctx.contracts.collSurplusPool : ctx.contracts.activePool;
    return {
        pool: await ethers.provider.getBalance(pool.address),
        tracked: BigInt((await pool.getETH()).toString()),
        debt: BigInt((await ctx.contracts.activePool.getZUSDDebt()).toString()),
        collateral: BigInt(
            (await ctx.contracts.troveManager.getTroveColl(actor.address)).toString()
        ),
        troveDebt: BigInt(
            (await ctx.contracts.troveManager.getTroveDebt(actor.address)).toString()
        ),
        status: String(await ctx.contracts.troveManager.getTroveStatus(actor.address)),
        surplus: BigInt(
            (await ctx.contracts.collSurplusPool.getCollateral(actor.address)).toString()
        ),
        queue: await ethers.provider.getBalance(ctx.queue.target),
        liability: await ctx.queue.totalEscrowed(ethers.ZeroAddress),
        last: await ctx.queue.lastRequestId(),
        fee: await ethers.provider.getBalance(ctx.feeReceiver.address),
        actor: await ethers.provider.getBalance(actor.address),
    };
}

class Model {
    constructor(ctx) {
        this.ctx = ctx;
        this.requests = new Map();
        this.trace = [];
        this.counts = {};
        this.contractCalls = 0;
        this.receipts = [];
        this.evidence = [];
    }

    mark(name, details = {}) {
        this.trace.push({ command: name, ...details });
        this.counts[name] = (this.counts[name] || 0) + 1;
    }

    async settle(actor, operation, gross, held, feeFails = false) {
        const surface = operation === "surplus" ? SURPLUS : WITHDRAW;
        const before = await balances(this.ctx, actor, surface);
        const args =
            operation === "withdraw"
                ? [gross, ethers.ZeroAddress, ethers.ZeroAddress]
                : operation === "adjust"
                ? [ethers.parseEther("1"), gross, 0, false, ethers.ZeroAddress, ethers.ZeroAddress]
                : [];
        const method =
            operation === "withdraw"
                ? "withdrawColl"
                : operation === "adjust"
                ? "adjustTrove"
                : "claimCollateral";
        this.mark(operation, { actor: actor.address, gross: gross.toString(), held, feeFails });
        this.contractCalls++;
        const receipt = await (await this.ctx.invoke(actor, method, args)).wait();
        this.receipts.push(receipt.hash);
        const after = await balances(this.ctx, actor, surface);
        const fee = after.fee - before.fee;
        const gas =
            receipt.from.toLowerCase() === actor.address.toLowerCase()
                ? receipt.gasUsed * receipt.gasPrice
                : 0n;
        const paid = after.actor - before.actor + gas;
        this.evidence.push({
            operation,
            actor: actor.address,
            surface,
            gross,
            held,
            feeFails,
            before,
            after,
            receivedFee: fee,
            directPayment: paid,
            receipt: {
                hash: receipt.hash,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
                gasUsed: receipt.gasUsed,
                gasPrice: receipt.gasPrice,
            },
        });
        assert.equal(before.pool - after.pool, gross, "Pool must debit exactly gross");
        assert.equal(before.tracked - after.tracked, gross, "Tracked pool debit must equal gross");
        assert.equal(
            after.debt,
            before.debt,
            "Collateral-only operation must preserve system debt"
        );
        assert.equal(
            after.troveDebt,
            before.troveDebt,
            "Collateral-only operation must preserve trove debt"
        );
        if (surface === WITHDRAW)
            assert.equal(
                before.collateral - after.collateral,
                gross,
                "Trove collateral debit must equal gross"
            );
        else assert.equal(after.surplus, 0n, "Committed claim must consume its surplus");
        if (feeFails) assert.equal(fee, 0n, "Noncharging fee leg must not consume value");
        else
            assert.equal(
                fee,
                (gross * 50n) / 10000n,
                "Active configured fee must be received exactly"
            );
        if (held) {
            assert.equal(paid, 0n, "Resolved hold must never pay actor directly");
            assert.equal(
                after.last,
                before.last + 1n,
                "Held settlement must create exactly one request"
            );
            const request = await requestFromReceipt(this.ctx.queue, receipt);
            const identity = requestIdentity(request);
            assert.equal(
                request.amount,
                gross - fee,
                "Actual fee plus stored request must conserve gross"
            );
            for (const key of ["originator", "owner", "receiver"])
                assert.equal(
                    request[key],
                    actor.address,
                    "Recorded actors must be actual Zero caller"
                );
            assert.equal(request.surfaceId, surface, "Zero surface must be preserved");
            assert.equal(request.subProduct, ethers.ZeroAddress);
            assert.equal(request.token, ethers.ZeroAddress);
            assert.equal(request.unlockAt - request.createdAt, BigInt(DELAY));
            assert.equal(
                after.queue - before.queue,
                request.amount,
                "Native custody must equal recorded amount"
            );
            assert.equal(
                after.liability - before.liability,
                request.amount,
                "Liability must equal recorded amount"
            );
            this.requests.set(after.last.toString(), {
                identity,
                amount: request.amount,
                receiver: actor.address,
                terminal: false,
            });
        } else {
            assert.equal(after.last, before.last, "Direct settlement must not create requests");
            assert.equal(
                after.queue,
                before.queue,
                "Direct settlement must not touch queue custody"
            );
            assert.equal(after.liability, before.liability);
            assert.equal(fee + paid, gross, "Fee and direct user payout must conserve gross");
        }
        await this.invariants();
        return after.last;
    }

    async rejected(actor, operation, error) {
        const surface = operation === "surplus" ? SURPLUS : WITHDRAW;
        const before = await balances(this.ctx, actor, surface);
        const args =
            operation === "surplus"
                ? []
                : [ethers.parseEther("0.01"), ethers.ZeroAddress, ethers.ZeroAddress];
        const method = operation === "surplus" ? "claimCollateral" : "withdrawColl";
        this.mark("record-reject", { actor: actor.address, operation });
        this.contractCalls++;
        const { expect } = require("chai");
        let rejectedHash;
        const transaction = this.ctx
            .invoke(actor, method, args, { gasLimit: 8000000 })
            .catch((failure) => {
                rejectedHash = failure.transactionHash || failure.data?.transactionHash;
                throw failure;
            });
        await expect(transaction).to.be.revertedWithCustomError(this.ctx.queue, error);
        const after = await balances(this.ctx, actor, surface);
        delete before.actor;
        delete after.actor;
        assert.deepEqual(
            after,
            before,
            "Record rejection must roll back host, positive fee, pools and queue"
        );
        this.evidence.push({
            operation: "record-reject",
            actor: actor.address,
            surface,
            expectedError: error,
            rejectedHash: rejectedHash || null,
            before,
            after,
        });
        await this.invariants();
    }

    async release(id, executor, expectedError) {
        const stored = this.requests.get(id.toString());
        assert(stored, "Release must target a modeled request");
        const before = await ethers.provider.getBalance(stored.receiver);
        const liability = await this.ctx.queue.totalEscrowed(ethers.ZeroAddress);
        const raw = await ethers.provider.getBalance(this.ctx.queue.target);
        this.contractCalls++;
        if (expectedError) {
            this.mark(expectedError, { id: id.toString(), executor: executor.address });
            const { expect } = require("chai");
            await expect(
                this.ctx.queue.connect(executor).executeExit(id, { gasLimit: 8000000 })
            ).to.be.revertedWithCustomError(this.ctx.queue, expectedError);
            assert.equal(await this.ctx.queue.totalEscrowed(ethers.ZeroAddress), liability);
            assert.equal(await ethers.provider.getBalance(this.ctx.queue.target), raw);
        } else {
            this.mark("release", { id: id.toString(), executor: executor.address });
            const receipt = await (await this.ctx.queue.connect(executor).executeExit(id)).wait();
            this.receipts.push(receipt.hash);
            const gas =
                executor.address.toLowerCase() === stored.receiver.toLowerCase()
                    ? receipt.gasUsed * receipt.gasPrice
                    : 0n;
            assert.equal(
                await ethers.provider.getBalance(stored.receiver),
                before + stored.amount - gas,
                "Release must pay only immutable receiver exactly once"
            );
            assert.equal(
                await this.ctx.queue.totalEscrowed(ethers.ZeroAddress),
                liability - stored.amount
            );
            assert.equal(
                await ethers.provider.getBalance(this.ctx.queue.target),
                raw - stored.amount
            );
            this.evidence.push({
                operation: "release",
                id,
                executor: executor.address,
                receiver: stored.receiver,
                amount: stored.amount,
                receiverBefore: before,
                receiverAfter: await ethers.provider.getBalance(stored.receiver),
                liabilityBefore: liability,
                liabilityAfter: await this.ctx.queue.totalEscrowed(ethers.ZeroAddress),
                receipt: {
                    hash: receipt.hash,
                    blockNumber: receipt.blockNumber,
                    from: receipt.from,
                    to: receipt.to,
                    gasUsed: receipt.gasUsed,
                    gasPrice: receipt.gasPrice,
                },
            });
            stored.terminal = true;
        }
        await this.invariants();
    }

    async control(name, transaction) {
        this.mark(name);
        this.contractCalls++;
        const receipt = await (await transaction()).wait();
        this.receipts.push(receipt.hash);
        this.evidence.push({
            operation: name,
            receipt: {
                hash: receipt.hash,
                blockNumber: receipt.blockNumber,
                from: receipt.from,
                to: receipt.to,
            },
        });
        await this.invariants();
    }

    async mature(id) {
        const request = await this.ctx.queue.getRequest(id);
        const current = await ethers.provider.getBlock("latest");
        await network.provider.send("evm_setNextBlockTimestamp", [
            Number(
                request.unlockAt > BigInt(current.timestamp)
                    ? request.unlockAt
                    : BigInt(current.timestamp + 1)
            ),
        ]);
        await network.provider.send("evm_mine");
        this.mark("mature");
    }

    async invariants() {
        let liability = 0n;
        for (const [id, expected] of this.requests) {
            const request = await this.ctx.queue.getRequest(id);
            assert.deepEqual(
                requestIdentity(request),
                expected.identity,
                "Request metadata must remain immutable"
            );
            assert.equal(
                request.status,
                expected.terminal ? 2n : 1n,
                "Request status must match committed model transition"
            );
            if (!expected.terminal) liability += expected.amount;
        }
        assert.equal(
            await this.ctx.queue.lastRequestId(),
            BigInt(this.requests.size),
            "Every request must be accounted in model"
        );
        assert.equal(
            await this.ctx.queue.totalEscrowed(ethers.ZeroAddress),
            liability,
            "Queue liability must equal outstanding request sum"
        );
        assert.equal(
            await ethers.provider.getBalance(this.ctx.queue.target),
            liability,
            "Undonated native custody must exactly back requests"
        );
        for (const pool of [this.ctx.contracts.activePool, this.ctx.contracts.collSurplusPool])
            assert.equal(
                await ethers.provider.getBalance(pool.address),
                BigInt((await pool.getETH()).toString()),
                "Raw pool balance must match accounting"
            );
        assert.equal(
            await ethers.provider.getBalance(this.ctx.borrower.target),
            0n,
            "BorrowerOperations must not strand native collateral"
        );
    }
}

module.exports = { fixture, random, balances, Model, WITHDRAW, SURPLUS, DELAY };
