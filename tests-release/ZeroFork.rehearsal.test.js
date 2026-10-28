const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers, network, artifacts } = require("hardhat");
const { deployCore, requestFromReceipt, WITHDRAW, DELAY } = require("./helpers/core");
const { verifyZeroReleaseArtifacts } = require("./helpers/zero");

const CONTROLLER = "0x99994b4522483de17f31a5bc010c5901add3440e";
const WRBTC = "0x542fda317318ebf1d3deaf76e0b632741a7e677d";
const records = path.resolve(__dirname, "../deployment/deployments/rskSovrynMainnet");
const record = (name) => JSON.parse(fs.readFileSync(path.join(records, `${name}.json`), "utf8"));

async function attachProxy(name) {
    const implementation = await artifacts.readArtifact(name);
    const proxy = await artifacts.readArtifact("UpgradableProxy");
    return new ethers.Contract(
        record(`${name}_Proxy`).address,
        [...implementation.abi, ...proxy.abi],
        ethers.provider
    );
}

async function impersonate(address) {
    if (network.name !== "hardhat") throw new Error("Impersonation is local-only");
    await network.provider.send("hardhat_impersonateAccount", [address]);
    await network.provider.send("hardhat_setBalance", [address, "0x3635c9adc5dea00000"]);
    return ethers.getSigner(address);
}

async function slots(address, indexes) {
    const values = [];
    for (let offset = 0; offset < indexes.length; offset += 8) {
        values.push(
            ...(await Promise.all(
                indexes
                    .slice(offset, offset + 8)
                    .map((index) => ethers.provider.getStorage(address, index))
            ))
        );
    }
    return values;
}

describe("Zero mainnet-fork exact-release technical rehearsal", function () {
    let borrower;
    let manager;
    let surplusPool;
    let alice;
    let whale;
    let owner;
    let controller;
    let queue;
    let snapshot;
    let originalImplementations;
    const proof = {
        productionTransactions: 0,
        authorityMode: "local impersonation, not governance voting",
        steps: [],
    };

    before(async function () {
        proof.zeroBuild = await verifyZeroReleaseArtifacts();
        if (
            network.name !== "hardhat" ||
            !process.env.ZERO_RELEASE_FORK_RPC ||
            !process.env.ZERO_RELEASE_FORK_HASH
        ) {
            throw new Error(
                "Use the secret-free Hardhat config with explicit fork RPC, block and hash"
            );
        }
        const upstream = new ethers.JsonRpcProvider(process.env.ZERO_RELEASE_FORK_RPC);
        try {
            expect((await upstream.getNetwork()).chainId).to.equal(30n);
            const block = await upstream.getBlock(Number(process.env.ZERO_RELEASE_FORK_BLOCK));
            expect(block.hash.toLowerCase()).to.equal(
                process.env.ZERO_RELEASE_FORK_HASH.toLowerCase()
            );
            proof.fork = { number: block.number, hash: block.hash, chainId: 30 };
        } finally {
            upstream.destroy();
        }
        [alice, whale] = await ethers.getSigners();
        const priceFeed = await attachProxy("PriceFeed");
        proof.oracle = {
            pinnedTimestamp: (
                await ethers.provider.getBlock(Number(process.env.ZERO_RELEASE_FORK_BLOCK))
            ).timestamp,
            beforeUpgradeTimestamp: (await ethers.provider.getBlock("latest")).timestamp,
            price: (await priceFeed.fetchPrice.staticCall()).toString(),
        };
        borrower = await attachProxy("BorrowerOperations");
        manager = await attachProxy("TroveManager");
        surplusPool = await attachProxy("CollSurplusPool");
        owner = await impersonate(await borrower.getOwner());
        expect(await manager.getOwner()).to.equal(owner.address);
        expect(await surplusPool.getOwner()).to.equal(owner.address);

        const existingController = new ethers.Contract(
            CONTROLLER,
            ["function owner() view returns(address)"],
            ethers.provider
        );
        const coreOwner = await impersonate(await existingController.owner());
        const controllerSlots = Array.from({ length: 258 }, (_, index) => index);
        const controllerBefore = await slots(CONTROLLER, controllerSlots);
        ({ controller, queue } = await deployCore({
            owner: coreOwner,
            source: borrower.target,
            wrbtc: WRBTC,
            controllerAddress: CONTROLLER,
            configure: false,
        }));
        expect(await slots(CONTROLLER, controllerSlots)).to.deep.equal(controllerBefore);
        expect(await controller.owner()).to.equal(coreOwner.address);
        proof.controllerStoragePrefix = { wordsCompared: 258, unchanged: true };

        const layout = JSON.parse(
            fs.readFileSync(
                path.resolve(
                    __dirname,
                    "../tests-perimeter/baselines/storage-layout.sovryn-perimeter-fee.json"
                ),
                "utf8"
            )
        );
        const hosts = [
            ["BorrowerOperations", borrower],
            ["CollSurplusPool", surplusPool],
            ["TroveManager", manager],
        ];
        const ownerCount = await manager.getTroveOwnersCount();
        expect(ownerCount).to.be.greaterThan(0n);
        const liveTroves = [];
        for (let index = 0; index < Math.min(Number(ownerCount), 3); index += 1) {
            const actor = await manager.getTroveFromTroveOwnersArray(index);
            liveTroves.push({
                actor,
                trove: (await manager.Troves(actor)).map((value) => value.toString()),
                entireDebtAndColl: (await manager.getEntireDebtAndColl(actor)).map((value) =>
                    value.toString()
                ),
                surplus: (await surplusPool.getCollateral(actor)).toString(),
            });
        }
        const excluded = [];
        for (const name of [
            "StabilityPool",
            "TroveManagerRedeemOps",
            "ZUSDToken",
            "CommunityIssuance",
            "PriceFeed",
            "ActivePool",
            "DefaultPool",
        ]) {
            const deployed = record(name);
            const runtime = await ethers.provider.getCode(deployed.address);
            const entry = { name, address: deployed.address, codehash: ethers.keccak256(runtime) };
            if (fs.existsSync(path.join(records, `${name}_Proxy.json`))) {
                const proxy = await ethers.getContractAt("UpgradableProxy", deployed.address);
                entry.implementation = await proxy.getImplementation();
            }
            excluded.push(entry);
        }
        const preserved = [];
        for (const [name, host] of hosts) {
            const indexes = [
                ...new Set(
                    layout[`contracts/${name}.sol:${name}`].map((entry) => Number(entry.slot))
                ),
            ];
            preserved.push({
                name,
                host,
                indexes,
                storage: await slots(host.target, indexes),
                balance: await ethers.provider.getBalance(host.target),
                owner: await host.getOwner(),
                implementation: await host.getImplementation(),
            });
        }
        const immutablePermit2 = await manager.permit2();
        const bootstrap = await manager.BOOTSTRAP_PERIOD();
        expect(await borrower.permit2()).to.equal(immutablePermit2);
        const candidates = {
            BorrowerOperations: await (
                await ethers.getContractFactory("BorrowerOperations")
            ).deploy(immutablePermit2),
            CollSurplusPool: await (await ethers.getContractFactory("CollSurplusPool")).deploy(),
            TroveManager: await (
                await ethers.getContractFactory("TroveManager")
            ).deploy(bootstrap, immutablePermit2),
            BorrowerOperationsPerimeterOps: await (
                await ethers.getContractFactory("BorrowerOperationsPerimeterOps")
            ).deploy(),
        };
        for (const [name, candidate] of Object.entries(candidates)) {
            await candidate.waitForDeployment();
            const runtime = await ethers.provider.getCode(candidate.target);
            expect((runtime.length - 2) / 2).to.be.at.most(24576);
            proof.steps.push({
                candidate: name,
                address: candidate.target,
                codehash: ethers.keccak256(runtime),
            });
        }
        expect(await candidates.TroveManager.permit2()).to.equal(immutablePermit2);
        expect(await candidates.TroveManager.BOOTSTRAP_PERIOD()).to.equal(bootstrap);
        expect(await candidates.BorrowerOperations.permit2()).to.equal(immutablePermit2);
        const order = [
            [surplusPool.connect(owner), "setImplementation", candidates.CollSurplusPool.target],
            [borrower.connect(owner), "setImplementation", candidates.BorrowerOperations.target],
            [
                borrower.connect(owner),
                "setPerimeterOps",
                candidates.BorrowerOperationsPerimeterOps.target,
            ],
            [borrower.connect(owner), "setExitDelayQueue", queue.target],
            [manager.connect(owner), "setImplementation", candidates.TroveManager.target],
        ];
        for (const [host, method, argument] of order) {
            const receipt = await (await host[method](argument)).wait();
            proof.steps.push({
                target: host.target,
                method,
                argument,
                transactionHash: receipt.hash,
            });
        }
        for (const entry of preserved) {
            expect(await slots(entry.host.target, entry.indexes)).to.deep.equal(entry.storage);
            expect(await entry.host.getOwner()).to.equal(entry.owner);
            expect(await ethers.provider.getBalance(entry.host.target)).to.equal(entry.balance);
            expect(await entry.host.getImplementation()).to.equal(candidates[entry.name].target);
        }
        proof.zeroStoragePrefixes = preserved.map(({ name, indexes }) => ({
            name,
            wordsCompared: indexes.length,
            unchanged: true,
        }));
        expect(await manager.getTroveOwnersCount()).to.equal(ownerCount);
        for (const entry of liveTroves) {
            expect(
                (await manager.Troves(entry.actor)).map((value) => value.toString())
            ).to.deep.equal(entry.trove);
            expect(
                (await manager.getEntireDebtAndColl(entry.actor)).map((value) => value.toString())
            ).to.deep.equal(entry.entireDebtAndColl);
            expect((await surplusPool.getCollateral(entry.actor)).toString()).to.equal(
                entry.surplus
            );
        }
        proof.liveTroves = liveTroves.map((entry) => ({ ...entry, unchanged: true }));
        proof.liveTroveOwnerCount = ownerCount.toString();
        expect(await borrower.exitFeeController()).to.equal(ethers.getAddress(CONTROLLER));
        expect(await borrower.exitDelayQueue()).to.equal(queue.target);
        expect(await borrower.perimeterOps()).to.equal(
            candidates.BorrowerOperationsPerimeterOps.target
        );
        await (await controller.setGlobalDelaySeconds(DELAY)).wait();
        await (await controller.setSecurityPerimeterEnabled(true)).wait();
        proof.zeroOldImplementations = preserved.map(({ name, implementation }) => ({
            name,
            implementation,
        }));
        originalImplementations = Object.fromEntries(
            proof.zeroOldImplementations.map(({ name, implementation }) => [name, implementation])
        );
        proof.constructorInputs = {
            permit2: immutablePermit2,
            bootstrapPeriod: bootstrap.toString(),
        };
        proof.oracle.afterUpgradeTimestamp = (await ethers.provider.getBlock("latest")).timestamp;
        for (let index = 0; index < 2; index += 1) {
            const oracle = new ethers.Contract(
                await priceFeed.getPriceFeedAtIndex(index),
                ["function latestAnswer() view returns(uint256,bool)"],
                ethers.provider
            );
            proof.oracle[`feed${index}`] = (await oracle.latestAnswer()).map((value) =>
                typeof value === "bigint" ? value.toString() : value
            );
        }
        for (const entry of excluded) {
            expect(ethers.keccak256(await ethers.provider.getCode(entry.address))).to.equal(
                entry.codehash
            );
            if (entry.implementation) {
                const proxy = await ethers.getContractAt("UpgradableProxy", entry.address);
                expect(await proxy.getImplementation()).to.equal(entry.implementation);
            }
        }
        proof.excludedContracts = excluded.map((entry) => ({
            ...entry,
            unchangedDuringInstallation: true,
        }));
        proof.oracle.originalFeeds = await Promise.all(
            [0, 1].map((index) => priceFeed.getPriceFeedAtIndex(index))
        );
        proof.oracle.productionImplementation = await priceFeed.getImplementation();
        const testOracle = await (
            await ethers.getContractFactory("ExternalPriceFeedTester")
        ).deploy();
        await testOracle.waitForDeployment();
        await (await testOracle.setLatestAnswer(BigInt(proof.oracle.price), true)).wait();
        await (
            await priceFeed
                .connect(await impersonate(await priceFeed.getOwner()))
                .setAddress(0, testOracle.target)
        ).wait();
        expect(await priceFeed.getImplementation()).to.equal(
            proof.oracle.productionImplementation
        );
        proof.oracle.fixture = {
            address: testOracle.target,
            price: proof.oracle.price,
            scope: "test-only primary adapter, production Zero PriceFeed implementation unchanged",
        };
    });

    beforeEach(async function () {
        snapshot = await network.provider.send("evm_snapshot");
        await network.provider.send("evm_setNextBlockTimestamp", [
            (await ethers.provider.getBlock("latest")).timestamp + 1,
        ]);
    });

    afterEach(async function () {
        await network.provider.send("evm_revert", [snapshot]);
    });

    after(function () {
        const output = process.env.ZERO_RELEASE_FORK_REPORT;
        if (output) fs.writeFileSync(output, JSON.stringify(proof, null, 2));
    });

    async function open(actor) {
        await network.provider.send("evm_setNextBlockTimestamp", [
            (await ethers.provider.getBlock("latest")).timestamp + 1,
        ]);
        await (
            await borrower
                .connect(actor)
                .openTrove(
                    ethers.parseEther("1"),
                    ethers.parseEther("2000"),
                    ethers.ZeroAddress,
                    ethers.ZeroAddress,
                    { value: ethers.parseEther("10") }
                )
        ).wait();
    }

    it("live proxies preserve their state and constructor immutables through the five-action installation", function () {
        expect(proof.zeroStoragePrefixes).to.have.length(3);
        expect(proof.steps.filter((step) => step.method).map((step) => step.method)).to.deep.equal(
            [
                "setImplementation",
                "setImplementation",
                "setPerimeterOps",
                "setExitDelayQueue",
                "setImplementation",
            ]
        );
    });

    it("live withdrawal records the real fee quote and releases only after 24 hours", async function () {
        await open(alice);
        const gross = ethers.parseEther("1");
        const quote = await controller.quoteExitFee(
            WITHDRAW,
            ethers.ZeroAddress,
            alice.address,
            gross
        );
        const receipt = await (
            await borrower
                .connect(alice)
                .withdrawColl(gross, ethers.ZeroAddress, ethers.ZeroAddress)
        ).wait();
        const request = await requestFromReceipt(queue, receipt);
        expect(request.amount).to.equal(quote.netAmount);
        expect(request.unlockAt - request.createdAt).to.equal(BigInt(DELAY));
        expect(request.owner).to.equal(alice.address);
        await expect(queue.connect(alice).executeExit(1)).to.be.revertedWithCustomError(
            queue,
            "NotUnlocked"
        );
        await network.provider.send("evm_setNextBlockTimestamp", [Number(request.unlockAt)]);
        await network.provider.send("evm_mine");
        await (await queue.connect(alice).executeExit(1)).wait();
        expect((await queue.getRequest(1)).status).to.equal(2n);
        expect(await queue.totalEscrowed(ethers.ZeroAddress)).to.equal(0n);
        proof.withdrawal = {
            gross: gross.toString(),
            net: request.amount.toString(),
            fee: quote.feeAmount.toString(),
            released: true,
        };
    });

    it("live collateral adjustment uses the installed real queue", async function () {
        await open(alice);
        await (
            await borrower
                .connect(alice)
                .adjustTrove(
                    ethers.parseEther("1"),
                    ethers.parseEther("1"),
                    0,
                    false,
                    ethers.ZeroAddress,
                    ethers.ZeroAddress
                )
        ).wait();
        expect(await queue.lastRequestId()).to.equal(1n);
        proof.adjustment = { queued: true };
    });

    it("live close clears debt while holding the collateral in the real queue", async function () {
        await open(alice);
        await open(whale);
        const token = await ethers.getContractAt("ZUSDToken", record("ZUSDToken").address);
        const repayment =
            (await manager.getTroveDebt(alice.address)) - (await borrower.ZUSD_GAS_COMPENSATION());
        const shortfall = repayment - (await token.balanceOf(alice.address));
        expect(shortfall).to.be.greaterThan(0n);
        await (await token.connect(whale).transfer(alice.address, shortfall)).wait();
        await (await borrower.connect(alice).closeTrove()).wait();
        expect(await manager.getTroveStatus(alice.address)).to.equal(2n);
        expect(await queue.lastRequestId()).to.equal(1n);
        proof.close = {
            debtClosed: true,
            collateralHeld: true,
            repayment: repayment.toString(),
            fundedShortfall: shortfall.toString(),
        };
    });

    it("live queue rejection leaves the original collateral and balances intact and permits retry", async function () {
        await open(alice);
        await (await queue.removeAllowedSource(borrower.target)).wait();
        const collateral = await manager.getTroveColl(alice.address);
        const pool = await ethers.getContractAt("ActivePool", record("ActivePool").address);
        const poolBalance = await ethers.provider.getBalance(pool.target);
        await expect(
            borrower
                .connect(alice)
                .withdrawColl(ethers.parseEther("1"), ethers.ZeroAddress, ethers.ZeroAddress)
        ).to.be.revertedWithCustomError(queue, "UnregisteredSource");
        expect(await manager.getTroveColl(alice.address)).to.equal(collateral);
        expect(await ethers.provider.getBalance(pool.target)).to.equal(poolBalance);
        expect(await queue.lastRequestId()).to.equal(0n);
        await (await queue.addAllowedSource(borrower.target)).wait();
        await (
            await borrower
                .connect(alice)
                .withdrawColl(ethers.parseEther("1"), ethers.ZeroAddress, ethers.ZeroAddress)
        ).wait();
        expect(await queue.lastRequestId()).to.equal(1n);
        proof.rejectionRollback = { unchanged: true, retrySucceeded: true };
    });

    it("emergency disable leaves the live withdrawal usable without touching queue recording", async function () {
        await open(alice);
        await (await controller.setSecurityPerimeterEnabled(false)).wait();
        await (await queue.removeAllowedSource(borrower.target)).wait();
        await (
            await borrower
                .connect(alice)
                .withdrawColl(ethers.parseEther("1"), ethers.ZeroAddress, ethers.ZeroAddress)
        ).wait();
        expect(await queue.lastRequestId()).to.equal(0n);
        proof.disabled = { withdrawalSucceeded: true, queueUntouched: true };
    });

    it("funded live surplus settles fee-first into the real queue and rolls back rejected consumption", async function () {
        const gross = ethers.parseEther("1");
        const activePool = await borrower.activePool();
        await (
            await (
                await impersonate(activePool)
            ).sendTransaction({ to: surplusPool.target, value: gross })
        ).wait();
        await (
            await surplusPool
                .connect(await impersonate(manager.target))
                .accountSurplus(alice.address, gross)
        ).wait();
        const quote = await controller.quoteExitFee(
            ethers.id("PERIMETER_SURFACE_ZERO_CLAIM_SURPLUS"),
            ethers.ZeroAddress,
            alice.address,
            gross
        );
        const poolBefore = await ethers.provider.getBalance(surplusPool.target);
        const feeReceiver = await controller.feeReceiver();
        const feeBefore = await ethers.provider.getBalance(feeReceiver);
        await (await queue.removeAllowedSource(borrower.target)).wait();
        await expect(borrower.connect(alice).claimCollateral()).to.be.revertedWithCustomError(
            queue,
            "UnregisteredSource"
        );
        expect(await surplusPool.getCollateral(alice.address)).to.equal(gross);
        expect(await ethers.provider.getBalance(surplusPool.target)).to.equal(poolBefore);
        expect(await ethers.provider.getBalance(feeReceiver)).to.equal(feeBefore);
        await (await queue.addAllowedSource(borrower.target)).wait();
        const receipt = await (await borrower.connect(alice).claimCollateral()).wait();
        const request = await requestFromReceipt(queue, receipt);
        expect(request.amount).to.equal(quote.netAmount);
        expect(request.owner).to.equal(alice.address);
        expect(await surplusPool.getCollateral(alice.address)).to.equal(0n);
        expect(await ethers.provider.getBalance(surplusPool.target)).to.equal(poolBefore - gross);
        expect(await ethers.provider.getBalance(feeReceiver)).to.equal(
            feeBefore + quote.feeAmount
        );
        proof.surplus = {
            gross: gross.toString(),
            net: request.amount.toString(),
            fee: quote.feeAmount.toString(),
            rejectionRolledBack: true,
            fixture:
                "funding/accounting through impersonated authorised ActivePool and TroveManager; not a liquidation proof",
        };
    });

    it("host implementation rollback preserves an already queued claim and its eventual payout", async function () {
        await open(alice);
        const receipt = await (
            await borrower
                .connect(alice)
                .withdrawColl(ethers.parseEther("1"), ethers.ZeroAddress, ethers.ZeroAddress)
        ).wait();
        const request = await requestFromReceipt(queue, receipt);
        await (await controller.setSecurityPerimeterEnabled(false)).wait();
        for (const [name, host] of [
            ["BorrowerOperations", borrower],
            ["CollSurplusPool", surplusPool],
            ["TroveManager", manager],
        ]) {
            await (
                await host.connect(owner).setImplementation(originalImplementations[name])
            ).wait();
            expect(await host.getImplementation()).to.equal(originalImplementations[name]);
        }
        expect(await queue.totalEscrowed(ethers.ZeroAddress)).to.equal(request.amount);
        await network.provider.send("evm_setNextBlockTimestamp", [Number(request.unlockAt)]);
        await network.provider.send("evm_mine");
        const balance = await ethers.provider.getBalance(alice.address);
        const payout = await (await queue.connect(alice).executeExit(1)).wait();
        expect(await ethers.provider.getBalance(alice.address)).to.equal(
            balance + request.amount - payout.gasUsed * payout.gasPrice
        );
        expect(await queue.totalEscrowed(ethers.ZeroAddress)).to.equal(0n);
        proof.hostRollback = {
            originalImplementationsRestored: true,
            queuedFundsPreserved: true,
            payoutSucceeded: true,
        };
    });
});
