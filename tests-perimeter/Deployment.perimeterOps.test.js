const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");
const { Interface } = require("ethers");

const scriptPath = path.resolve(
    __dirname,
    "../deployment/deploy/9-BorrowerOperationsPerimeterOps.ts"
);

function loadModule(filename, imports, messages) {
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(compiled, {
        module,
        exports: module.exports,
        __filename: filename,
        URL,
        process: { env: {} },
        console: { log: (message) => messages.push(message) },
        require: (specifier) => {
            assert.ok(
                Object.hasOwn(imports, specifier),
                `Unexpected deployment import: ${specifier}`
            );
            return imports[specifier];
        },
    });
    return module.exports;
}

function deploymentFixture({
    name = "hardhat",
    tags = {},
    url,
    pointer = "0x0000000000000000000000000000000000000000",
    getterError,
    newlyDeployed = true,
} = {}) {
    const calls = [];
    const messages = [];
    const candidate = "0x0000000000000000000000000000000000000011";
    const proxy = "0x0000000000000000000000000000000000000022";
    const multisig = "0x0000000000000000000000000000000000000033";
    const deployer = "0x0000000000000000000000000000000000000044";
    const borrowerOperations = {
        target: proxy,
        interface: new Interface(["function setPerimeterOps(address)"]),
        getFunction: (name) => {
            assert.equal(name, "perimeterOps");
            return borrowerOperations.perimeterOps;
        },
        perimeterOps: async () => {
            calls.push("getter");
            if (getterError) throw getterError;
            return pointer;
        },
    };
    class TestLogs {
        showInConsole() {
            return this;
        }
        information(message) {
            messages.push(message);
        }
        info(message) {
            messages.push(message);
        }
    }
    const imports = {
        path,
        "node-logs": TestLogs,
        "../../scripts/helpers/utils": loadModule(
            path.resolve(__dirname, "../scripts/helpers/utils.ts"),
            {},
            messages
        ),
        "../../scripts/helpers/helpers": {
            sendWithMultisig: async (...args) => calls.push(["multisig", ...args.slice(1)]),
            deployWithCustomProxy: async () => calls.push(["borrowerUpgrade"]),
        },
    };
    const companionModule = loadModule(scriptPath, imports, messages);
    const borrowerModule = loadModule(
        path.resolve(__dirname, "../deployment/deploy/1-BorrowerOperations.ts"),
        imports,
        messages
    );
    const hre = {
        network: { name, tags, config: { url } },
        getNamedAccounts: async () => ({ deployer }),
        ethers: {
            getContract: async () => borrowerOperations,
            getContractAt: async () => ({ getImplementation: async () => candidate }),
            provider: { getCode: async () => "0x6000" },
        },
        deployments: {
            getOrNull: async () => ({ address: proxy }),
            get: async (deploymentName) => ({
                address: deploymentName === "MultiSigWallet" ? multisig : candidate,
            }),
            deploy: async (deploymentName, options) => {
                calls.push(["deploy", deploymentName, options.from]);
                return { address: candidate, newlyDeployed };
            },
            log: (message) => messages.push(message),
            execute: async (...args) => calls.push(["execute", ...args]),
        },
    };
    return {
        run: () => companionModule.default(hre),
        runWithDependency: async () => {
            await borrowerModule.default(hre);
            await companionModule.default(hre);
        },
        calls,
        messages,
        candidate,
        proxy,
        multisig,
    };
}

const missingGetter = () =>
    Object.assign(new Error("execution reverted"), {
        code: "CALL_EXCEPTION",
        data: "0x",
    });

describe("Perimeter companion deployment safety", () => {
    it("mainnet can deploy against the legacy proxy without calling a new getter or wiring it", async () => {
        const fixture = deploymentFixture({
            name: "rskSovrynMainnet",
            tags: { mainnet: true },
            getterError: missingGetter(),
        });
        await fixture.run();
        assert.equal(fixture.calls.length, 1);
        assert.equal(fixture.calls[0][0], "deploy");
        assert.ok(fixture.messages.some((message) => message.includes("setPerimeterOps")));
        assert.ok(fixture.messages.some((message) => message.includes(fixture.candidate)));
    });

    it("mainnet can reuse a candidate while its implementation upgrade remains pending", async () => {
        const fixture = deploymentFixture({
            name: "rskSovrynMainnet",
            tags: { mainnet: true, forked: true },
            getterError: missingGetter(),
            newlyDeployed: false,
        });
        await fixture.run();
        assert.equal(fixture.calls.length, 1);
    });

    it("testnet defers wiring until the implementation exposes the hook getter", async () => {
        const fixture = deploymentFixture({
            name: "rskSovrynTestnet",
            tags: { testnet: true },
            getterError: missingGetter(),
        });
        await fixture.run();
        assert.equal(fixture.calls.length, 2);
        assert.equal(fixture.calls[1], "getter");
        assert.ok(fixture.messages.some((message) => message.includes("upgrade")));
    });

    it("testnet treats empty getter data as an unwired legacy implementation", async () => {
        const fixture = deploymentFixture({
            name: "rskSovrynTestnet",
            tags: { testnet: true },
            getterError: Object.assign(new Error("could not decode result data"), {
                code: "BAD_DATA",
                value: "0x",
            }),
        });
        await fixture.run();
        assert.equal(fixture.calls.length, 2);
    });

    it("upgraded testnet submits the setter to multisig with the proxy and candidate addresses", async () => {
        const fixture = deploymentFixture({ name: "rskSovrynTestnet", tags: { testnet: true } });
        await fixture.run();
        const submission = fixture.calls.find((call) => call[0] === "multisig");
        assert.ok(submission);
        assert.equal(submission[1], fixture.multisig);
        assert.equal(submission[2], fixture.proxy);
        const data = new Interface(["function setPerimeterOps(address)"]);
        assert.equal(
            data.decodeFunctionData("setPerimeterOps", submission[3])[0],
            fixture.candidate
        );
        assert.ok(!fixture.calls.some((call) => call[0] === "execute"));
    });

    it("an existing matching hook needs no setter transaction", async () => {
        const fixture = deploymentFixture({
            pointer: "0x0000000000000000000000000000000000000011",
            newlyDeployed: false,
        });
        await fixture.run();
        assert.equal(fixture.calls.length, 2);
    });

    it("the local Hardhat network still wires the new companion", async () => {
        const fixture = deploymentFixture();
        await fixture.run();
        const execution = fixture.calls.find((call) => call[0] === "execute");
        assert.ok(execution);
        assert.equal(execution[1], "BorrowerOperations");
        assert.equal(execution[3], "setPerimeterOps");
        assert.equal(execution[4], fixture.candidate);
    });

    it("rejects conflicting production tags before deploying anything", async () => {
        const fixture = deploymentFixture({ tags: { mainnet: true, testnet: true } });
        await assert.rejects(fixture.run, /conflicting/);
        assert.equal(fixture.calls.length, 0);
    });

    it("rejects an untagged remote network before deploying or setting a hook", async () => {
        const fixture = deploymentFixture({ name: "mainnet", url: "https://example.invalid" });
        await assert.rejects(fixture.run, /network tags/);
        assert.equal(fixture.calls.length, 0);
    });

    it("unexpected getter errors abort rather than submitting a setter", async () => {
        const error = Object.assign(new Error("RPC unavailable"), { code: "NETWORK_ERROR" });
        const fixture = deploymentFixture({
            name: "rskSovrynTestnet",
            tags: { testnet: true },
            getterError: error,
        });
        await assert.rejects(fixture.run, (observed) => observed === error);
        assert.equal(fixture.calls.length, 2);
    });

    it("a loopback Rootstock development node can wire directly", async () => {
        const fixture = deploymentFixture({ name: "rskdev", url: "http://localhost:4444" });
        await fixture.run();
        assert.ok(fixture.calls.some((call) => call[0] === "execute"));
    });

    it("a network named localhost cannot wire directly through a remote endpoint", async () => {
        const fixture = deploymentFixture({ name: "localhost", url: "https://example.invalid" });
        await assert.rejects(fixture.run, /network tags/);
        assert.equal(fixture.calls.length, 0);
    });

    it("a legacy local getter failure never falls back to a direct setter", async () => {
        const error = missingGetter();
        const fixture = deploymentFixture({ getterError: error });
        await assert.rejects(fixture.run, (observed) => observed === error);
        assert.equal(fixture.calls.length, 2);
    });

    it("a tagged testnet fork retains the multisig path", async () => {
        const fixture = deploymentFixture({
            name: "testnetFork",
            tags: { testnet: true, forked: true },
        });
        await fixture.run();
        assert.ok(fixture.calls.some((call) => call[0] === "multisig"));
        assert.ok(!fixture.calls.some((call) => call[0] === "execute"));
    });

    it("rejects an untagged remote network before the BorrowerOperations dependency can upgrade", async () => {
        const fixture = deploymentFixture({ name: "mainnet", url: "https://example.invalid" });
        await assert.rejects(fixture.runWithDependency, /network tags/);
        assert.equal(fixture.calls.length, 0);
    });

    it("rejects conflicting tags before the BorrowerOperations dependency can deploy", async () => {
        const fixture = deploymentFixture({ tags: { mainnet: true, testnet: true } });
        await assert.rejects(fixture.runWithDependency, /conflicting/);
        assert.equal(fixture.calls.length, 0);
    });
});
