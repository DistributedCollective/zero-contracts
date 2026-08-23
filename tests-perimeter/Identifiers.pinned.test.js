/**
 * Perimeter — Zero's copies of the shared identifiers are pinned.
 *
 * Zero declares the controller pointer slot and two surface ids independently
 * of the lending repo. They are `keccak256` of a name, so a one-character drift
 * between the two repos does not fail loudly: Zero would resolve no policy and
 * silently stop charging. These literals are the same 32 bytes the lending repo
 * pins, and they must stay that way.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");

const keccak = (s) => ethers.id(s);
const minusOne = (h) => "0x" + (BigInt(h) - 1n).toString(16).padStart(64, "0");

const SLOT_NAME = "sovryn.perimeterExitFeeController";
const SLOT_VALUE = "0x3d5704dffa26c356d6b67639c4ccefa7798677b7f52196eb2d0a71d1837fe77e";

const SURFACES = [
    {
        name: "PERIMETER_SURFACE_ZERO_WITHDRAW_COLL",
        id: "0xfb3234ca0cf70fe9c90b73939f36a37fadcfdef4628afc42dd57d1f26dfd8fb5",
    },
    {
        name: "PERIMETER_SURFACE_ZERO_CLAIM_SURPLUS",
        id: "0x44224716871939619faf861b30e39bac8861d4f76b5dd0468d31bf4b7dc684be",
    },
];

describe("Perimeter — pinned identifiers (Zero)", () => {
    it("the controller pointer slot hashes to its pinned value", () => {
        expect(minusOne(keccak(SLOT_NAME))).to.equal(SLOT_VALUE);
    });

    SURFACES.forEach(({ name, id }) => {
        it(`surface ${name} hashes to its pinned value`, () => {
            expect(keccak(name)).to.equal(id);
        });
    });

    it("the source declares these names and no stale ones", () => {
        const sources = ["contracts/BorrowerOperations.sol", "contracts/CollSurplusPool.sol"]
            .filter((p) => fs.existsSync(p))
            .map((p) => fs.readFileSync(p, "utf8"))
            .join("\n");

        expect(sources, "the pointer slot preimage must appear in the source").to.contain(
            SLOT_NAME
        );
        SURFACES.forEach(({ name }) => expect(sources).to.contain(name));

        /// A surviving Phase-1 name is a live pointer at a slot nothing writes.
        expect(sources, "stale controller slot preimage").to.not.contain(
            '"sovryn.exitFeeController"'
        );
        expect(sources, "stale ColFee identifier").to.not.contain("ColFee");
        /// Unprefixed surface names only ever appear as the tail of the
        /// prefixed ones -- any other occurrence is a leftover.
        const unprefixed = sources.match(/(?<!PERIMETER_)SURFACE_ZERO_[A-Z_]+/g) || [];
        expect(unprefixed, "unprefixed surface name left in the source").to.deep.equal([]);
    });
});
