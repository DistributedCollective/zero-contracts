const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { artifacts } = require("hardhat");
const { getCompilersDir } = require("hardhat/internal/util/global-dir");
const { CompilerDownloader } = require("hardhat/internal/solidity/compiler/downloader");
const { DeploymentFactory } = require("hardhat-deploy/dist/src/DeploymentFactory");

function executable(bytecode) {
    const metadataBytes = parseInt(bytecode.slice(-4), 16);
    return bytecode.slice(0, -(metadataBytes + 2) * 2);
}

describe("Installed deployment comparator formatting hazard", function () {
    it("a comment-only ZUSDToken change preserves ABI/runtime but triggers the real deployment comparator", async function () {
        const name = "contracts/ZUSDToken.sol:ZUSDToken";
        const build = await artifacts.getBuildInfo(name);
        assert.equal(build.solcVersion, "0.6.11");
        assert.equal(
            build.input.sources["contracts/ZUSDToken.sol"].content,
            fs.readFileSync(path.resolve(__dirname, "../contracts/ZUSDToken.sol"), "utf8")
        );
        const input = JSON.parse(JSON.stringify(build.input));
        input.sources["contracts/ZUSDToken.sol"].content =
            "// release metadata-only control\n" +
            input.sources["contracts/ZUSDToken.sol"].content;
        const downloader = CompilerDownloader.getConcurrencySafeDownloader(
            CompilerDownloader.getCompilerPlatform(),
            await getCompilersDir()
        );
        const compiler = await downloader.getCompiler(build.solcVersion);
        assert.ok(
            compiler && !compiler.isSolcJs,
            "Exact cached native Solidity compiler is required"
        );
        const processResult = spawnSync(compiler.compilerPath, ["--standard-json"], {
            input: JSON.stringify(input),
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        });
        assert.equal(processResult.status, 0, processResult.stderr);
        const output = JSON.parse(processResult.stdout);
        assert.deepEqual(
            (output.errors || []).filter((error) => error.severity === "error"),
            []
        );
        const before = build.output.contracts["contracts/ZUSDToken.sol"].ZUSDToken;
        const after = output.contracts["contracts/ZUSDToken.sol"].ZUSDToken;
        assert.deepEqual(after.abi, before.abi);
        assert.equal(
            executable(after.evm.deployedBytecode.object),
            executable(before.evm.deployedBytecode.object)
        );
        const artifact = await artifacts.readArtifact(name);
        const changed = { ...artifact, bytecode: `0x${after.evm.bytecode.object}` };
        const factory = new DeploymentFactory(async () => changed, changed, [], {});
        assert.equal(
            await factory.compareDeploymentTransaction({ data: artifact.bytecode }),
            true
        );
    });
});
