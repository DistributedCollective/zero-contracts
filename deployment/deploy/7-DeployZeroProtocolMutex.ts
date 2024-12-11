const Logs = require("node-logs");
const logger = new Logs().showInConsole(true);
const { SAVED_DEPLOY_DATA_ZERO, getOrDeployZeroProtocolMutex, createZeroProtocolMutexDeployTransaction } = require("../helpers/reentrancy/utils");

const func = async function (hre) {
    const {
        deployments: { deploy, log, getOrNull },
        getNamedAccounts,
        network,
        ethers,
    } = hre;
    const { deployerAddress, contractAddress } = SAVED_DEPLOY_DATA_ZERO;
    logger.warn("Deploying Zero Protocol Mutex...");

    if (ethers.provider.getBalance(deployerAddress) === 0) {
        throw new Error("Deployer balance is zero");
    }

    console.log(await createZeroProtocolMutexDeployTransaction());

    const zeroProtocolMutex = await getOrDeployZeroProtocolMutex();
    if (zeroProtocolMutex.target !== contractAddress) {
        throw new Error(`Mutex address is ${zeroProtocolMutex.target}, expected ${contractAddress}`);
    }
    logger.warn("Zero Protocol Mutex deployed");
};
func.tags = ["ZeroProtocolMutex"];
module.exports = func;
