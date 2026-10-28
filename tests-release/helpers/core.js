const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { ethers } = require("hardhat");

const WITHDRAW = ethers.id("PERIMETER_SURFACE_ZERO_WITHDRAW_COLL");
const SURPLUS = ethers.id("PERIMETER_SURFACE_ZERO_CLAIM_SURPLUS");
const DELAY = 86400;

function coreArtifact(name) {
    const directory = process.env.CORE_RELEASE_ARTIFACTS_DIR;
    if (!directory || !path.isAbsolute(directory)) {
        throw new Error("CORE_RELEASE_ARTIFACTS_DIR must name the exact compiled core release");
    }
    const manifestPath = process.env.CORE_RELEASE_MANIFEST;
    const revision = process.env.CORE_RELEASE_REVISION;
    if (
        !manifestPath ||
        !path.isAbsolute(manifestPath) ||
        !/^[0-9a-f]{40}$/.test(revision || "")
    ) {
        throw new Error("CORE_RELEASE_MANIFEST and exact CORE_RELEASE_REVISION are required");
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.head !== revision)
        throw new Error("Core release revision does not match its manifest");
    const receipt = manifest.artifacts.find((artifact) => artifact.name === name);
    const bytes = fs.readFileSync(path.join(directory, `${name}.sol`, `${name}.json`));
    if (!receipt || createHash("sha256").update(bytes).digest("hex") !== receipt.artifact_sha256) {
        throw new Error(`Core release artifact hash mismatch: ${name}`);
    }
    if (receipt.compiler !== "0.8.20+commit.a1b79de6" || receipt.evm_version !== "paris") {
        throw new Error(`Unexpected production compiler/EVM: ${name}`);
    }
    const artifact = JSON.parse(bytes.toString("utf8"));
    if (!artifact.bytecode?.object || !artifact.deployedBytecode?.object) {
        throw new Error(`Missing compiled core bytecode: ${name}`);
    }
    return artifact;
}

async function deployCoreContract(name, signer, args = []) {
    const artifact = coreArtifact(name);
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer);
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    const runtime = await ethers.provider.getCode(contract.target);
    if (runtime === "0x" || (runtime.length - 2) / 2 > 24576) {
        throw new Error(`Invalid production runtime size: ${name}`);
    }
    return contract;
}

async function deployCore({
    owner,
    source,
    wrbtc,
    feeReceiver,
    controllerAddress,
    configure = true,
}) {
    const controllerImplementation = await deployCoreContract("ExitFeeController", owner);
    const controllerInterface = new ethers.Interface(coreArtifact("ExitFeeController").abi);
    let controller;
    if (controllerAddress) {
        controller = new ethers.Contract(controllerAddress, controllerInterface, owner);
        await (await controller.upgradeTo(controllerImplementation.target)).wait();
    } else {
        const proxy = await deployCoreContract("ERC1967Proxy", owner, [
            controllerImplementation.target,
            controllerInterface.encodeFunctionData("initialize", [owner.address]),
        ]);
        controller = new ethers.Contract(proxy.target, controllerInterface, owner);
    }
    const queueImplementation = await deployCoreContract("ExitDelayQueue", owner);
    const queueInterface = new ethers.Interface(coreArtifact("ExitDelayQueue").abi);
    const queueProxy = await deployCoreContract("ERC1967Proxy", owner, [
        queueImplementation.target,
        queueInterface.encodeFunctionData("initialize", [
            owner.address,
            owner.address,
            wrbtc,
            60,
            [source],
        ]),
    ]);
    const queue = new ethers.Contract(queueProxy.target, queueInterface, owner);
    if (configure) {
        await (await controller.setGlobalDelaySeconds(DELAY)).wait();
        await (await controller.setSurfacePolicy(WITHDRAW, [true, 50])).wait();
        await (await controller.setSurfacePolicy(SURPLUS, [true, 50])).wait();
        await (await controller.setFeeReceiver(feeReceiver)).wait();
        await (await controller.setExitFeeEnabled(true)).wait();
        await (await controller.setSecurityPerimeterEnabled(true)).wait();
    }
    return { controller, queue, controllerImplementation, queueImplementation };
}

async function requestFromReceipt(queue, receipt) {
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== queue.target.toLowerCase()) continue;
        const parsed = queue.interface.parseLog(log);
        if (parsed?.name === "ExitQueued") return queue.getRequest(parsed.args.id);
    }
    throw new Error("ExitQueued was not emitted by the real queue");
}

module.exports = {
    coreArtifact,
    deployCore,
    deployCoreContract,
    requestFromReceipt,
    WITHDRAW,
    SURPLUS,
    DELAY,
};
