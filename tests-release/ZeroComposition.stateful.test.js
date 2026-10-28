const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { fixture, random, Model, WITHDRAW, SURPLUS, DELAY } = require("./helpers/composition");

const seeds = (process.env.ZERO_COMPOSITION_SEEDS || "20261003,20261004").split(",").map(Number);
const runs = Number(process.env.ZERO_COMPOSITION_RUNS || 2);
const steps = Number(process.env.ZERO_COMPOSITION_STEPS || 40);
for (const value of [...seeds, runs, steps])
    assert(
        Number.isSafeInteger(value) && value > 0,
        "Campaign settings must be positive integers"
    );
const reports = [];

describe("Zero stateful composition with the real controller and queue", function () {
    let ctx;
    let baseline;
    before(async function () {
        ctx = await fixture();
        baseline = await network.provider.send("evm_snapshot");
    });
    after(async function () {
        if (process.env.ZERO_COMPOSITION_REPORT) {
            const filename = process.env.ZERO_COMPOSITION_REPORT;
            assert(path.isAbsolute(filename), "Report must have an absolute path");
            fs.writeFileSync(
                filename,
                JSON.stringify(
                    {
                        configured: {
                            seeds,
                            runs,
                            generatedStepsPerRun: steps,
                            globalDelay: DELAY,
                            testFloor: 60,
                        },
                        coreRevision: process.env.CORE_RELEASE_REVISION,
                        mutation: process.env.ZERO_COMPOSITION_MUTANT_FILE || null,
                        provenance: ctx?.provenance,
                        campaigns: reports,
                    },
                    (_, value) => (typeof value === "bigint" ? value.toString() : value),
                    2
                ) + "\n"
            );
        }
    });

    for (const seed of seeds) {
        it(`conserves custody and state through repeated transitions with seed ${seed}`, async function () {
            for (let run = 0; run < runs; run++) {
                await network.provider.send("evm_revert", [baseline]);
                baseline = await network.provider.send("evm_snapshot");
                const model = new Model(ctx);
                const rng = random((seed + run * 104729) >>> 0);
                const report = { seed, run, configuredGeneratedSteps: steps, status: "running" };
                reports.push(report);
                try {
                    const surplus = await ctx.createSurplus(ctx.bob);
                    for (const actor of [ctx.alice, ctx.carol, ctx.contractActor])
                        await ctx.open(actor);
                    await model.control("remove-source", () =>
                        ctx.queue.removeAllowedSource(ctx.borrower.target)
                    );
                    await model.rejected(ctx.bob, "surplus", "UnregisteredSource");
                    await model.control("restore-source", () =>
                        ctx.queue.addAllowedSource(ctx.borrower.target)
                    );
                    await model.control("withdraw-surface-bypass", () =>
                        ctx.controller.setActorBypass(WITHDRAW, ctx.bob.address, [true, true])
                    );
                    await model.control("fee-receiver-failure", () =>
                        ctx.controller.setFeeReceiver(ctx.nonPayable.target)
                    );
                    await model.settle(ctx.bob, "surplus", surplus, true, true);
                    await model.control("fee-receiver-restore", () =>
                        ctx.controller.setFeeReceiver(ctx.feeReceiver.address)
                    );
                    const first = await model.settle(
                        ctx.alice,
                        "withdraw",
                        ethers.parseEther("0.01"),
                        true
                    );
                    await model.settle(ctx.alice, "adjust", ethers.parseEther("0.02"), true);
                    const contractId = await model.settle(
                        ctx.contractActor,
                        "withdraw",
                        ethers.parseEther("0.01"),
                        true
                    );
                    await model.release(contractId, ctx.outsider, "NotUnlocked");
                    await model.control("remove-source", () =>
                        ctx.queue.removeAllowedSource(ctx.borrower.target)
                    );
                    await model.rejected(ctx.alice, "withdraw", "UnregisteredSource");
                    await model.control("delay-disable", () =>
                        ctx.controller.setSecurityPerimeterEnabled(false)
                    );
                    await model.settle(ctx.alice, "withdraw", ethers.parseEther("0.01"), false);
                    await model.control("restore-source", () =>
                        ctx.queue.addAllowedSource(ctx.borrower.target)
                    );
                    await model.control("delay-enable", () =>
                        ctx.controller.setSecurityPerimeterEnabled(true)
                    );
                    await model.control("actor-bypass", () =>
                        ctx.controller.setActorBypass(WITHDRAW, ctx.alice.address, [true, true])
                    );
                    await model.settle(ctx.alice, "withdraw", ethers.parseEther("0.01"), false);
                    await model.control("actor-bypass-clear", () =>
                        ctx.controller.setActorBypass(WITHDRAW, ctx.alice.address, [false, false])
                    );
                    await model.settle(ctx.alice, "withdraw", ethers.parseEther("0.01"), true);
                    await model.control("below-floor", () =>
                        ctx.controller.setGlobalDelaySeconds(1)
                    );
                    await model.rejected(ctx.alice, "withdraw", "DelayBelowFloor");
                    await model.control("restore-delay", () =>
                        ctx.controller.setGlobalDelaySeconds(DELAY)
                    );
                    await model.mature(first);
                    await model.release(first, ctx.outsider, "NotExecutor");
                    await model.control("freeze-party", () =>
                        ctx.queue["freeze(address)"](ctx.alice.address)
                    );
                    await model.release(first, ctx.alice, "ActorBlocked");
                    await model.control("clear-party", () =>
                        ctx.queue["unfreeze(address)"](ctx.alice.address)
                    );
                    await model.control("pause", () => ctx.queue.setSecurityPerimeterPaused(true));
                    await model.release(first, ctx.alice, "QueuePaused");
                    await model.control("resume", () =>
                        ctx.queue.setSecurityPerimeterPaused(false)
                    );
                    await model.release(first, ctx.alice);
                    await model.release(first, ctx.alice, "AlreadyTerminal");
                    await model.mature(contractId);
                    await model.control("freeze-executor", () =>
                        ctx.queue["freeze(address)"](ctx.outsider.address)
                    );
                    await model.release(contractId, ctx.outsider, "ActorBlocked");
                    await model.control("clear-executor", () =>
                        ctx.queue["unfreeze(address)"](ctx.outsider.address)
                    );
                    await model.release(contractId, ctx.outsider);
                    model.mark("contract-owner-delivery");
                    await model.control("fee-disable", () =>
                        ctx.controller.setExitFeeEnabled(false)
                    );
                    await model.settle(
                        ctx.carol,
                        "withdraw",
                        ethers.parseEther("0.01"),
                        true,
                        true
                    );
                    await model.control("fee-enable", () =>
                        ctx.controller.setExitFeeEnabled(true)
                    );

                    const actors = [ctx.alice, ctx.carol, ctx.contractActor];
                    let enabled = true;
                    let feeFails = false;
                    let paused = false;
                    const bypassed = new Set();
                    const frozen = new Set();
                    for (let step = 0; step < steps; step++) {
                        const actor = actors[rng(actors.length)];
                        const choice = rng(9);
                        model.mark("generated-step", { step, choice });
                        if (choice < 2) {
                            const gross = BigInt(1 + rng(30)) * 10n ** 15n;
                            await model.settle(
                                actor,
                                choice === 0 ? "withdraw" : "adjust",
                                gross,
                                enabled && !bypassed.has(actor.address),
                                feeFails
                            );
                        } else if (choice === 2) {
                            feeFails = !feeFails;
                            await model.control("generated-fee", () =>
                                ctx.controller.setFeeReceiver(
                                    feeFails ? ctx.nonPayable.target : ctx.feeReceiver.address
                                )
                            );
                        } else if (choice === 3) {
                            if (bypassed.has(actor.address)) bypassed.delete(actor.address);
                            else bypassed.add(actor.address);
                            await model.control("generated-bypass", () =>
                                ctx.controller.setActorBypass(WITHDRAW, actor.address, [
                                    true,
                                    bypassed.has(actor.address),
                                ])
                            );
                        } else if (choice === 4) {
                            enabled = !enabled;
                            await model.control("generated-enable", () =>
                                ctx.controller.setSecurityPerimeterEnabled(enabled)
                            );
                        } else if (choice === 5) {
                            await model.control("generated-reject-enable", () =>
                                ctx.controller.setSecurityPerimeterEnabled(true)
                            );
                            await model.control("generated-reject-bypass-clear", () =>
                                ctx.controller.setActorBypass(WITHDRAW, ctx.alice.address, [
                                    false,
                                    false,
                                ])
                            );
                            await model.control("remove-source", () =>
                                ctx.queue.removeAllowedSource(ctx.borrower.target)
                            );
                            await model.rejected(ctx.alice, "withdraw", "UnregisteredSource");
                            await model.control("restore-source", () =>
                                ctx.queue.addAllowedSource(ctx.borrower.target)
                            );
                            await model.control("generated-reject-enable-restore", () =>
                                ctx.controller.setSecurityPerimeterEnabled(enabled)
                            );
                            await model.control("generated-reject-bypass-restore", () =>
                                ctx.controller.setActorBypass(WITHDRAW, ctx.alice.address, [
                                    true,
                                    bypassed.has(ctx.alice.address),
                                ])
                            );
                        } else if (choice === 6) {
                            paused = !paused;
                            await model.control("generated-pause", () =>
                                ctx.queue.setSecurityPerimeterPaused(paused)
                            );
                        } else if (choice === 7) {
                            const wasFrozen = frozen.has(actor.address);
                            if (wasFrozen) frozen.delete(actor.address);
                            else frozen.add(actor.address);
                            await model.control("generated-freeze", () =>
                                ctx.queue[wasFrozen ? "unfreeze(address)" : "freeze(address)"](
                                    actor.address
                                )
                            );
                        } else {
                            const entries = [...model.requests.entries()];
                            const [id, stored] = entries[rng(entries.length)];
                            await model.mature(id);
                            const owner =
                                actors.find((entry) => entry.address === stored.receiver) ||
                                ctx.bob;
                            const executor = owner.proxy ? ctx.outsider : owner;
                            const error = paused
                                ? "QueuePaused"
                                : stored.terminal
                                ? "AlreadyTerminal"
                                : frozen.has(stored.receiver)
                                ? "ActorBlocked"
                                : null;
                            await model.release(id, executor, error);
                        }
                    }
                    for (const required of [
                        "surplus",
                        "withdraw",
                        "adjust",
                        "record-reject",
                        "fee-receiver-failure",
                        "actor-bypass",
                        "delay-disable",
                        "NotUnlocked",
                        "NotExecutor",
                        "ActorBlocked",
                        "QueuePaused",
                        "AlreadyTerminal",
                        "release",
                        "contract-owner-delivery",
                        "fee-disable",
                        "below-floor",
                    ])
                        assert(model.counts[required] > 0, `Transition not reached: ${required}`);
                    assert.equal(
                        model.counts["generated-step"],
                        steps,
                        "Generated sequence must complete its configured budget"
                    );
                    report.status = "passed";
                    report.counts = model.counts;
                    report.contractCalls = model.contractCalls;
                    report.receipts = model.receipts;
                    report.evidence = model.evidence;
                    report.trace = model.trace;
                    report.requests = [...model.requests.entries()];
                    report.finalOutstandingRequests = [...model.requests.values()].filter(
                        (request) => !request.terminal
                    ).length;
                } catch (error) {
                    report.status = "failed";
                    report.error = error.message;
                    report.trace = model.trace;
                    report.counts = model.counts;
                    report.contractCalls = model.contractCalls;
                    report.evidence = model.evidence;
                    error.message += `\nComposition seed=${seed}, run=${run}, trace=${JSON.stringify(
                        model.trace
                    )}`;
                    throw error;
                }
            }
        });
    }
});
