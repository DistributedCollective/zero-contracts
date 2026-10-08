const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../scripts/helpers/utils.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const loaded = { exports: {} };
const environment = { env: {} };
vm.runInNewContext(compiled, {
    module: loaded,
    exports: loaded.exports,
    URL,
    process: environment,
});
const utils = loaded.exports;
const tags = [
    "BorrowerOperations",
    "CollSurplusPool",
    "TroveManager",
    "BorrowerOperationsPerimeterOps",
];
const release = { name: "rskSovrynMainnet", tags: { mainnet: true }, config: {} };

function loadScript(script, imports) {
    const filename = path.resolve(__dirname, "..", script);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const loaded = { exports: {} };
    vm.runInNewContext(compiled, {
        module: loaded,
        exports: loaded.exports,
        __filename: filename,
        URL,
        require: (specifier) => {
            assert.ok(Object.hasOwn(imports, specifier), `Unexpected import: ${specifier}`);
            return imports[specifier];
        },
        console: { log: () => {} },
        process: environment,
    });
    return loaded.exports;
}

class Logs {
    showInConsole() {
        return this;
    }
    information() {}
    info() {}
}

const helper = () =>
    loadScript("scripts/helpers/helpers.ts", {
        "node-logs": Logs,
        "./utils": utils,
    });

function fixture(missing, emptyCode) {
    const calls = [];
    const address = "0x0000000000000000000000000000000000000011";
    return {
        calls,
        network: release,
        deployments: {
            fixture: async () => {
                throw new Error("FIXTURE_ACTION_REACHED");
            },
            getOrNull: async (name) => {
                calls.push(name);
                return name === missing ? null : { address };
            },
        },
        ethers: {
            provider: { getCode: async () => (emptyCode ? "0x" : "0x6000") },
            getContractAt: async () => ({ getImplementation: async () => address }),
        },
    };
}

describe("Zero delay deployment frozen scope", function () {
    for (const networkTags of [
        { mainnet: true },
        { testnet: true },
        { mainnet: true, forked: true },
    ]) {
        it(`rejects broad, forbidden, reset and require-all selection for ${JSON.stringify(
            networkTags
        )}`, function () {
            const network = { ...release, tags: networkTags };
            for (const options of [
                {},
                { tags: "ZUSDToken" },
                { tags: tags.join(","), reset: true },
                { tags: tags.join(","), tagsRequireAll: true },
            ]) {
                assert.throws(
                    () => utils.assertZeroDelayDeploymentSelection(network, options),
                    /Zero delay release/
                );
            }
            utils.assertZeroDelayDeploymentSelection(network, { tags: tags.join(",") });
        });
    }

    for (const name of [
        "StabilityPool",
        "TroveManagerRedeemOps",
        "ZUSDToken",
        "CommunityIssuance",
        "PriceFeed",
    ]) {
        it(`rejects programmatic deployment of excluded ${name} before artifact comparison`, function () {
            assert.throws(
                () => utils.assertZeroDelayDeploymentCandidate(release, name),
                /not an approved candidate/
            );
        });
    }

    for (const name of tags.slice(0, 3)) {
        it(`rejects missing ${name} proxy during the all-candidate preflight`, async function () {
            await assert.rejects(
                utils.preflightZeroDelayDeployment(fixture(`${name}_Proxy`)),
                /existing proxy/
            );
        });
    }

    it("rejects missing live proxy code", async function () {
        await assert.rejects(utils.preflightZeroDelayDeployment(fixture(undefined, true)), /code/);
    });

    it("preflights all three existing proxies without creating or upgrading them", async function () {
        const hre = fixture();
        await utils.preflightZeroDelayDeployment(hre);
        assert.deepEqual(
            hre.calls,
            tags.slice(0, 3).map((name) => `${name}_Proxy`)
        );
    });

    it("keeps genuinely fresh internal local deployment available", async function () {
        const local = { name: "hardhat", tags: {}, config: {} };
        utils.assertZeroDelayDeploymentSelection(local, { reset: true });
        utils.assertZeroDelayDeploymentCandidate(local, "ZUSDToken");
        const hre = fixture("BorrowerOperations_Proxy");
        hre.network = local;
        await utils.preflightZeroDelayDeployment(hre);
        assert.deepEqual(hre.calls, []);
    });

    it("rejects excluded deployment on an untagged configured Hardhat fork", async function () {
        const hre = fixture();
        hre.network = {
            name: "hardhat",
            tags: {},
            config: { forking: { url: "https://example.invalid" } },
        };
        hre.deployments.deploy = async () => {
            throw new Error("DEPLOY_ACTION_REACHED");
        };
        await assert.rejects(
            helper().deployWithCustomProxy(hre, "deployer", "ZUSDToken", "UpgradableProxy"),
            /not an approved candidate/
        );
        assert.deepEqual(hre.calls, []);
    });

    it("rejects excluded deployment on an untagged runtime-reset Hardhat fork", async function () {
        const hre = fixture();
        hre.deployments.deploy = async () => {
            throw new Error("DEPLOY_ACTION_REACHED");
        };
        hre.network = {
            name: "hardhat",
            tags: {},
            config: {},
            provider: {
                send: async () => ({ forkedNetwork: { chainId: 30, forkBlockNumber: 9293098 } }),
            },
        };
        await assert.rejects(
            helper().deployWithCustomProxy(hre, "deployer", "ZUSDToken", "UpgradableProxy"),
            /not an approved candidate/
        );
        assert.deepEqual(hre.calls, []);
    });

    it("the proxy helper cannot create a proxy for the non-proxy companion", async function () {
        const hre = fixture();
        hre.deployments.deploy = async () => {
            throw new Error("DEPLOY_ACTION_REACHED");
        };
        await assert.rejects(
            helper().deployWithCustomProxy(
                hre,
                "deployer",
                "BorrowerOperationsPerimeterOps",
                "UpgradableProxy"
            ),
            /not an approved proxy candidate/
        );
    });

    it("recognizes a Hardhat fork reached through an allowed localhost RPC", async function () {
        const hre = fixture();
        hre.network = {
            name: "localhost",
            tags: {},
            config: { url: "http://127.0.0.1:8545" },
            provider: { send: async () => ({ forkedNetwork: { chainId: 30 } }) },
        };
        hre.deployments.deploy = async () => {
            throw new Error("DEPLOY_ACTION_REACHED");
        };
        await assert.rejects(
            helper().deployWithCustomProxy(hre, "deployer", "ZUSDToken", "UpgradableProxy"),
            /not an approved candidate/
        );
        assert.deepEqual(hre.calls, []);
    });

    it("rejects implicit global fixture mode before any deployment lookup", async function () {
        environment.env.HARDHAT_DEPLOY_FIXTURE = "1";
        const hre = fixture();
        try {
            await assert.rejects(
                utils.preflightZeroDelayDeployment(hre),
                /implicit deployment fixtures/
            );
            assert.deepEqual(hre.calls, []);
        } finally {
            delete environment.env.HARDHAT_DEPLOY_FIXTURE;
        }
    });

    it("preserves a genuine local non-Hardhat node that has no metadata method", async function () {
        const hre = fixture();
        hre.network = {
            name: "rskdev",
            tags: {},
            config: { url: "http://127.0.0.1:4444" },
            provider: {
                send: async () => {
                    throw Object.assign(new Error("Method not found"), { code: -32601 });
                },
            },
        };
        await utils.preflightZeroDelayDeployment(hre);
        assert.deepEqual(hre.calls, []);
    });

    it("fails closed on a loopback metadata read failure, not mistaken for a fresh node", async function () {
        const hre = fixture();
        hre.network = {
            name: "localhost",
            tags: {},
            config: { url: "http://127.0.0.1:8545" },
            provider: {
                send: async () => {
                    throw new Error("RPC_READ_FAILED");
                },
            },
        };
        await assert.rejects(utils.preflightZeroDelayDeployment(hre), /RPC_READ_FAILED/);
        assert.deepEqual(hre.calls, []);
    });

    it("direct BO invocation rejects implicit fixtures before Permit2 lookup", async function () {
        const script = loadScript("deployment/deploy/1-BorrowerOperations.ts", {
            "../../scripts/helpers/utils": utils,
            "../../scripts/helpers/helpers": helper(),
            path,
        });
        const hre = fixture();
        hre.getNamedAccounts = async () => ({ deployer: "deployer" });
        hre.deployments.get = async () => {
            throw new Error("IMPLICIT_FIXTURE_LOOKUP_REACHED");
        };
        environment.env.HARDHAT_DEPLOY_FIXTURE = "1";
        try {
            await assert.rejects(script.default(hre), /implicit deployment fixtures/);
            assert.deepEqual(hre.calls, []);
        } finally {
            delete environment.env.HARDHAT_DEPLOY_FIXTURE;
        }
    });

    it("the companion preflights the entire release before deploying", async function () {
        const script = loadScript("deployment/deploy/9-BorrowerOperationsPerimeterOps.ts", {
            "../../scripts/helpers/utils": utils,
            "../../scripts/helpers/helpers": {},
            path,
            "node-logs": Logs,
        });
        const hre = fixture("CollSurplusPool_Proxy");
        hre.getNamedAccounts = async () => {
            throw new Error("DEPLOY_ACTION_REACHED");
        };
        await assert.rejects(script.default(hre), /existing proxy/);
    });

    it("the real proxy helper refuses excluded candidates before any deploy or record save", async function () {
        const hre = fixture();
        hre.deployments.deploy = async () => {
            throw new Error("DEPLOY_ACTION_REACHED");
        };
        for (const name of ["StabilityPool", "ZUSDToken", "CommunityIssuance", "PriceFeed"]) {
            await assert.rejects(
                helper().deployWithCustomProxy(hre, "deployer", name, "UpgradableProxy"),
                /not an approved candidate/
            );
        }
        assert.deepEqual(hre.calls, []);
    });

    it("the real proxy helper rejects an incomplete release packet before staging its first candidate", async function () {
        const hre = fixture("CollSurplusPool_Proxy");
        hre.deployments.deploy = async () => {
            throw new Error("DEPLOY_ACTION_REACHED");
        };
        await assert.rejects(
            helper().deployWithCustomProxy(
                hre,
                "deployer",
                "BorrowerOperations",
                "UpgradableProxy"
            ),
            /existing proxy/
        );
    });

    it("the direct redemption-companion script rejects production before deploying or rewiring", async function () {
        const script = loadScript("deployment/deploy/4-TroveManagerRedeemOps.ts", {
            "../../scripts/helpers/utils": utils,
            "../../scripts/helpers/helpers": {},
            path,
            "node-logs": Logs,
        });
        const hre = fixture();
        await assert.rejects(script.default(hre), /not an approved candidate/);
        assert.deepEqual(hre.calls, []);
    });

    it("the deploy task rejects broad selection before running the deployment scheduler", async function () {
        const actions = new Map();
        loadScript("tasks/zeroDelayRelease.ts", {
            "../scripts/helpers/utils": utils,
            "hardhat/config": {
                task: (name) => ({ setAction: (action) => actions.set(name, action) }),
                subtask: (name) => ({ setAction: (action) => actions.set(name, action) }),
                extendEnvironment: () => {},
            },
        });
        const hre = fixture();
        let schedulerCalls = 0;
        const scheduler = async () => {
            schedulerCalls += 1;
        };
        await assert.rejects(actions.get("deploy")({}, hre, scheduler), /explicit candidate tags/);
        assert.equal(schedulerCalls, 0);
        await actions.get("deploy")({ tags: tags.join(",") }, hre, scheduler);
        assert.equal(schedulerCalls, 1);
        for (const name of ["deploy:main", "deploy:runDeploy"]) {
            await assert.rejects(actions.get(name)({}, hre, scheduler), /explicit candidate tags/);
        }
        assert.equal(schedulerCalls, 1);
    });

    it("the manual staging task always supplies exactly the frozen four-candidate selection", async function () {
        const actions = new Map();
        loadScript("tasks/zeroDelayRelease.ts", {
            "../scripts/helpers/utils": utils,
            "hardhat/config": {
                task: (name) => ({ setAction: (action) => actions.set(name, action) }),
                subtask: (name) => ({ setAction: (action) => actions.set(name, action) }),
                extendEnvironment: () => {},
            },
        });
        let selection;
        await actions.get("zero:stage-delay")(
            {},
            {
                run: async (name, args) => {
                    selection = { name, ...args };
                },
            }
        );
        assert.equal(selection.name, "deploy");
        assert.equal(selection.tags, tags.join(","));
    });

    it("programmatic deployments.run rejects broad and destructive selection before scheduling", async function () {
        let extend;
        let scheduled = 0;
        loadScript("tasks/zeroDelayRelease.ts", {
            "../scripts/helpers/utils": utils,
            "hardhat/config": {
                task: () => ({ setAction: () => {} }),
                subtask: () => ({ setAction: () => {} }),
                extendEnvironment: (callback) => {
                    extend = callback;
                },
            },
        });
        const hre = fixture();
        let received;
        hre.deployments.run = async (selected, options) => {
            received = { selected, options };
            scheduled += 1;
        };
        extend(hre);
        await assert.rejects(hre.deployments.run(), /explicit candidate tags/);
        await assert.rejects(
            hre.deployments.run(tags, { deletePreviousDeployments: true }),
            /explicit candidate tags/
        );
        assert.equal(scheduled, 0);
        await hre.deployments.run(tags);
        assert.equal(scheduled, 1);
        assert.equal(received.options.resetMemory, false);
        assert.deepEqual(Array.from(received.selected), tags);
        await hre.deployments.run(tags.join(","));
        assert.equal(scheduled, 2);
        assert.deepEqual(Array.from(received.selected), tags);
        await assert.rejects(hre.deployments.run(tags, { resetMemory: true }), /memory reset/);
        await assert.rejects(hre.deployments.fixture(tags), /fixtures are not permitted/);
        assert.equal(scheduled, 2);
    });

    it("fork node rejects deletion and broad scheduling before its provider task runs", async function () {
        const actions = new Map();
        loadScript("tasks/zeroDelayRelease.ts", {
            "../scripts/helpers/utils": utils,
            "hardhat/config": {
                task: (name) => ({ setAction: (action) => actions.set(name, action) }),
                subtask: (name) => ({ setAction: (action) => actions.set(name, action) }),
                extendEnvironment: () => {},
            },
        });
        let reached = 0;
        const underlying = async () => {
            reached += 1;
        };
        const hre = fixture();
        hre.network = { name: "hardhat", tags: {}, config: {} };
        await assert.rejects(
            actions.get("node")(
                { fork: "https://example.invalid", noDeploy: true },
                hre,
                underlying
            ),
            /requires no-reset/
        );
        await assert.rejects(
            actions.get("node")(
                { fork: "https://example.invalid", noReset: true },
                hre,
                underlying
            ),
            /explicit candidate tags/
        );
        assert.equal(reached, 0);
        await actions.get("node")(
            { fork: "https://example.invalid", noDeploy: true, noReset: true },
            hre,
            underlying
        );
        assert.equal(reached, 1);
    });
});
