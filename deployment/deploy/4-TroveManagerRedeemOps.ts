import { DeployFunction } from "hardhat-deploy/types";
import { getContractNameFromScriptFileName } from "../../scripts/helpers/utils";
const path = require("path");
import Logs from "node-logs";
import { TroveManager } from "types/generated";
const logger = new Logs().showInConsole(true);
import * as helpers from "../../scripts/helpers/helpers";

const deploymentName = getContractNameFromScriptFileName(path.basename(__filename));

const func: DeployFunction = async (hre) => {
    const {
        getNamedAccounts,
        ethers,
        deployments: { get, deploy, log, execute },
        network
    } = hre;

    const permit2Deployment = await get("Permit2");
    const { deployer } = await getNamedAccounts();
    const troveManager: TroveManager = (await ethers.getContract(
        "TroveManager"
    )) as unknown as TroveManager;
    const tx = await deploy(deploymentName, {
        from: deployer,
        args: [(await troveManager.BOOTSTRAP_PERIOD()).toString(), permit2Deployment.address],
        log: true,
    });

    const prevImpl = await troveManager.troveManagerRedeemOps();
    log(`Current ${deploymentName}: ${prevImpl}`);

    if (tx.newlyDeployed || tx.address != prevImpl) {
        if (tx.address != prevImpl) {
            logger.information(
                `${deploymentName} is reused. However it was not set in the TroveManager contract as troveManagerRedeemOps yet.`
            );
        }
        if (network.tags.testnet) {
            console.log("testnet");
            logger.information(`Initiating multisig tx to set TroveManagerRedeemOps in TroveManager....`)
            // multisig tx
            const deployment = await get(deploymentName);
            const { deployer } = await getNamedAccounts();
            const multisigAddress = (await get("MultiSigWallet")).address;
            const data = troveManager.interface.encodeFunctionData("setTroveManagerRedeemOps", [deployment.address]);

            await helpers.sendWithMultisig(hre, multisigAddress, troveManager.target.toString(), data, deployer);
        } else if (network.tags.mainnet) {
            // create SIP message
            console.log("mainnet");
            logger.info(`>>> Add ${deploymentName} address ${tx.address} update to a SIP`);
        } else {
            // just replace logic directly
            console.log("else!");
            await execute(
                "TroveManager",
                { from: deployer },
                "setTroveManagerRedeemOps",
                tx.address
            );
        }
    }
};

func.tags = [deploymentName];
func.dependencies = ["TroveManager"];
export default func;
