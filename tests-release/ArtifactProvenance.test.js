const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const { artifacts } = require("hardhat");

function verifier({ filesystem = fs, artifactReader = artifacts } = {}) {
    const filename = path.resolve(__dirname, "helpers/zero.js");
    const loaded = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
        module: loaded,
        exports: loaded.exports,
        __dirname: path.dirname(filename),
        require: (name) =>
            ({ fs: filesystem, path, crypto, hardhat: { artifacts: artifactReader } }[name]),
    });
    return loaded.exports.verifyZeroReleaseArtifacts;
}

describe("Zero release artifact provenance controls", function () {
    it("rejects a changed source input without modifying repository files", async function () {
        const filesystem = {
            ...fs,
            readFileSync: (filename, options) => fs.readFileSync(filename, options) + "\n",
        };
        await assert.rejects(verifier({ filesystem })(), /Stale Zero release artifact source/);
    });

    it("rejects an artifact built with the wrong compiler", async function () {
        const artifactReader = {
            readArtifact: (...args) => artifacts.readArtifact(...args),
            getBuildInfo: async (...args) => ({
                ...(await artifacts.getBuildInfo(...args)),
                solcVersion: "0.6.12",
            }),
        };
        await assert.rejects(verifier({ artifactReader })(), /Unexpected Zero release compiler/);
    });

    it("rejects a bytecode/build-output mismatch", async function () {
        const artifactReader = {
            readArtifact: async (...args) => ({
                ...(await artifacts.readArtifact(...args)),
                bytecode: "0x6000",
            }),
            getBuildInfo: (...args) => artifacts.getBuildInfo(...args),
        };
        await assert.rejects(
            verifier({ artifactReader })(),
            /Zero release artifact\/build mismatch/
        );
    });
});
