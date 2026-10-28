const assert = require("assert");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const describeCase = typeof describe === "function" ? describe : require("node:test").describe;
const testCase = typeof it === "function" ? it : require("node:test").it;
const root =
    process.env.ZERO_RECORD_ROOT ||
    path.resolve(__dirname, "../deployment/deployments/rskSovrynMainnet");
const baselineRoot = path.resolve(
    __dirname,
    "../deployment/baselines/pre-record-refresh-rskSovrynMainnet"
);
const observations = JSON.parse(
    fs.readFileSync(
        path.resolve(__dirname, "../deployment/observations/rsk-mainnet-20261028.json"),
        "utf8"
    )
);
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
const lower = (x) => x.toLowerCase();
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const observedNames = [
    "ActivePool.json",
    "ActivePool_Proxy.json",
    "BorrowerOperations_Proxy.json",
    "CollSurplusPool_Proxy.json",
    "DefaultPool.json",
    "DefaultPool_Proxy.json",
    "FeeDistributor.json",
    "FeeDistributor_Proxy.json",
    "GasPool.json",
    "HintHelpers.json",
    "HintHelpers_Proxy.json",
    "LiquityBaseParams.json",
    "LiquityBaseParams_Proxy.json",
    "MultiTroveGetter.json",
    "MultiTroveGetter_Proxy.json",
    "PriceFeed_Proxy.json",
    "SortedTroves.json",
    "SortedTroves_Proxy.json",
    "StabilityPool.json",
    "StabilityPool_Implementation.json",
    "StabilityPool_Proxy.json",
    "TroveManagerRedeemOps.json",
    "TroveManager_Proxy.json",
    "ZEROStaking.json",
    "ZEROStaking_Proxy.json",
    "ZEROToken.json",
    "ZEROToken_Proxy.json",
    "ZUSDToken_Proxy.json",
];

describeCase("Current mainnet deployment records", () => {
    testCase(
        "preserves every address and ABI while recording current implementation pointers",
        () => {
            assert.strictEqual(observations.chainId, 30);
            assert.strictEqual(observations.records.length, 42);
            for (const item of observations.records) {
                const r = read(item.file);
                assert.strictEqual(lower(r.address), lower(item.address), item.file);
                assert.strictEqual(hash(JSON.stringify(r.abi)), item.abiSha256, item.file);
                if (item.implementation)
                    assert.strictEqual(
                        lower(r.implementation),
                        lower(item.implementation),
                        item.file
                    );
            }
            assert.strictEqual(
                lower(read("StabilityPool.json").implementation),
                lower(read("StabilityPool_Implementation.json").address)
            );
        }
    );

    testCase(
        "does not present borrowed creation or compiled templates as observed deployments",
        () => {
            for (const name of observedNames) {
                const r = read(name);
                const expected = observations.records.find((x) => x.file === name);
                assert.ok(r.linkedData?.recordKind.startsWith("observed-"), name);
                assert.strictEqual(r.linkedData.chainId, 30);
                assert.strictEqual(r.linkedData.blockNumber, observations.blockNumber);
                assert.strictEqual(r.linkedData.blockHash, observations.blockHash);
                assert.strictEqual(r.linkedData.runtimeCodeHash, expected.runtimeCodeHash, name);
                for (const field of [
                    "bytecode",
                    "receipt",
                    "transactionHash",
                    "metadata",
                    "solcInputHash",
                    "args",
                    "storageLayout",
                ])
                    assert.strictEqual(r[field], undefined, `${name}: unproven ${field}`);
                if (r.implementation) {
                    assert.strictEqual(r.deployedBytecode, undefined, name);
                    assert.strictEqual(
                        r.linkedData.implementationRuntimeCodeHash,
                        expected.implementationRuntimeCodeHash,
                        name
                    );
                } else {
                    assert.strictEqual(
                        ethers.keccak256(r.deployedBytecode),
                        expected.runtimeCodeHash,
                        name
                    );
                }
            }
        }
    );

    testCase(
        "preserves exact historical snapshots without treating them as rollback instructions",
        () => {
            const manifest = JSON.parse(
                fs.readFileSync(path.join(baselineRoot, "SHA256.json"), "utf8")
            );
            assert.strictEqual(Object.keys(manifest.files).length, observedNames.length);
            for (const [name, expected] of Object.entries(manifest.files))
                assert.strictEqual(
                    hash(fs.readFileSync(path.join(baselineRoot, name))),
                    expected,
                    name
                );
        }
    );

    testCase(
        "keeps complete creation-backed Perimeter implementations and composite bindings",
        () => {
            for (const name of ["BorrowerOperations", "CollSurplusPool", "TroveManager"]) {
                const r = read(`${name}.json`),
                    impl = read(`${name}_Implementation.json`);
                assert.strictEqual(lower(r.implementation), lower(impl.address));
                assert.strictEqual(lower(impl.receipt.contractAddress), lower(impl.address));
                assert.strictEqual(lower(r.receipt.contractAddress), lower(impl.address));
                assert.deepStrictEqual(r.abi, impl.abi);
                assert.strictEqual(r.bytecode, impl.bytecode);
                assert.ok(impl.bytecode.length > 1000);
                assert.ok(impl.metadata && impl.solcInputHash);
            }
        }
    );

    testCase("does not attribute creation receipts to unrelated addresses", () => {
        for (const item of observations.records) {
            const r = read(item.file);
            if (!r.receipt) continue;
            assert.strictEqual(
                lower(r.receipt.contractAddress),
                lower(r.implementation || r.address),
                item.file
            );
        }
    });

    testCase(
        "resolves all remaining compiler inputs and binds their source content to metadata",
        () => {
            for (const file of fs.readdirSync(root).filter((x) => x.endsWith(".json"))) {
                const r = read(file);
                if (!r.solcInputHash) continue;
                const input = JSON.parse(
                    fs.readFileSync(
                        path.join(root, "solcInputs", `${r.solcInputHash}.json`),
                        "utf8"
                    )
                );
                const metadata =
                    typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata;
                if (!metadata) continue;
                for (const [name, info] of Object.entries(metadata.sources))
                    assert.strictEqual(
                        ethers.keccak256(ethers.toUtf8Bytes(input.sources[name].content)),
                        info.keccak256,
                        `${file}: ${name}`
                    );
            }
        }
    );
});
