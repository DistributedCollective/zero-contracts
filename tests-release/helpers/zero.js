const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { artifacts } = require("hardhat");

async function verifyZeroReleaseArtifacts() {
    const verifiedSources = new Set();
    const receipts = [];
    for (const name of [
        "BorrowerOperations",
        "CollSurplusPool",
        "TroveManager",
        "BorrowerOperationsPerimeterOps",
    ]) {
        const artifact = await artifacts.readArtifact(name);
        const qualified = `${artifact.sourceName}:${name}`;
        const build = await artifacts.getBuildInfo(qualified);
        if (
            !build ||
            build.solcVersion !== "0.6.11" ||
            !build.input.settings.optimizer.enabled ||
            build.input.settings.optimizer.runs !== 100
        ) {
            throw new Error(`Unexpected Zero release compiler/settings: ${name}`);
        }
        for (const [sourceName, source] of Object.entries(build.input.sources)) {
            if (verifiedSources.has(sourceName)) continue;
            const direct = path.resolve(__dirname, "../..", sourceName);
            const filename = fs.existsSync(direct)
                ? direct
                : path.resolve(__dirname, "../..", "node_modules", sourceName);
            if (fs.readFileSync(filename, "utf8") !== source.content) {
                throw new Error(`Stale Zero release artifact source: ${sourceName}`);
            }
            verifiedSources.add(sourceName);
        }
        const output = build.output.contracts[artifact.sourceName][name];
        if (
            artifact.bytecode !== `0x${output.evm.bytecode.object}` ||
            artifact.deployedBytecode !== `0x${output.evm.deployedBytecode.object}`
        ) {
            throw new Error(`Zero release artifact/build mismatch: ${name}`);
        }
        receipts.push({
            name,
            compiler: build.solcLongVersion,
            optimizerRuns: 100,
            compilerInputSha256: createHash("sha256")
                .update(JSON.stringify(build.input))
                .digest("hex"),
            artifactSha256: createHash("sha256").update(JSON.stringify(artifact)).digest("hex"),
        });
    }
    return { receipts, sourceFilesCompared: verifiedSources.size };
}

module.exports = { verifyZeroReleaseArtifacts };
