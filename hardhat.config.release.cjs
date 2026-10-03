require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomiclabs/hardhat-web3");
require("@nomiclabs/hardhat-truffle5");

const forkUrl = process.env.ZERO_RELEASE_FORK_RPC;
const forkBlock = Number(process.env.ZERO_RELEASE_FORK_BLOCK);
if (forkUrl && (!Number.isSafeInteger(forkBlock) || forkBlock <= 0)) {
  throw new Error("ZERO_RELEASE_FORK_BLOCK must explicitly pin the fork");
}
if (!forkUrl && process.env.ZERO_RELEASE_FORK_BLOCK) {
  throw new Error("ZERO_RELEASE_FORK_RPC is required with a fork block");
}

module.exports = {
  solidity: {
    compilers: ["0.4.23", "0.5.17", "0.6.11", "0.8.17"].map((version) => ({
      version,
      settings: {
        optimizer: { enabled: true, runs: 100 },
        outputSelection: { "*": { "*": ["storageLayout"] } },
      },
    })),
  },
  networks: {
    hardhat: {
      accounts: require(forkUrl
        ? "./hardhatAccountsList20.js"
        : "./hardhatAccountsList2k.js").accountsList,
      initialBaseFeePerGas: 0,
      ...(forkUrl ? { forking: { url: forkUrl, blockNumber: forkBlock } } : {}),
    },
  },
  paths: { tests: "./tests-release" },
  mocha: { timeout: 240000 },
};
