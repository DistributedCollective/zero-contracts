import { DeployFunction } from "hardhat-deploy/types";
import { getContractNameFromScriptFileName } from "../../scripts/helpers/utils";
const path = require("path");
import Logs from "node-logs";
const logger = new Logs().showInConsole(true);
import * as helpers from "../../scripts/helpers/helpers";

const deploymentName = getContractNameFromScriptFileName(path.basename(__filename));

const func: DeployFunction = async (hre) => {
    const {
        getNamedAccounts,
        ethers,
        deployments: { get, deploy, log, execute },
        network,
    } = hre;

    const { deployer } = await getNamedAccounts();
    const borrowerOperations = await ethers.getContract("BorrowerOperations");

    const tx = await deploy(deploymentName, {
        from: deployer,
        args: [],
        log: true,
    });

    const prevImpl = await borrowerOperations.perimeterOps();
    log(`Current ${deploymentName}: ${prevImpl}`);

    if (tx.newlyDeployed || tx.address != prevImpl) {
        if (tx.address != prevImpl) {
            logger.information(
                `${deploymentName} is reused. However it was not set in the BorrowerOperations contract as perimeterOps yet.`
            );
        }
        if (network.tags.testnet) {
            console.log("testnet");
            logger.information(
                `Initiating multisig tx to set BorrowerOperationsPerimeterOps in BorrowerOperations....`
            );
            const deployment = await get(deploymentName);
            const multisigAddress = (await get("MultiSigWallet")).address;
            const data = borrowerOperations.interface.encodeFunctionData("setPerimeterOps", [
                deployment.address,
            ]);

            await helpers.sendWithMultisig(
                hre,
                multisigAddress,
                borrowerOperations.target.toString(),
                data,
                deployer
            );
        } else if (network.tags.mainnet) {
            // create SIP message
            console.log("mainnet");
            logger.info(`>>> Add ${deploymentName} address ${tx.address} update to a SIP`);
        } else {
            // just set the hook directly
            console.log("else!");
            await execute("BorrowerOperations", { from: deployer }, "setPerimeterOps", tx.address);
        }
    }
};

func.tags = [deploymentName];
func.dependencies = ["BorrowerOperations"];
export default func;
