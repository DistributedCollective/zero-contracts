import { DeployFunction } from "hardhat-deploy/types";
import {
    getContractNameFromScriptFileName,
    assertPerimeterDeploymentNetwork,
    assertZeroDelayDeploymentCandidate,
    resolveZeroDelayDeploymentNetwork,
    preflightZeroDelayDeployment,
} from "../../scripts/helpers/utils";
const path = require("path");
import Logs from "node-logs";
const logger = new Logs().showInConsole(true);
import * as helpers from "../../scripts/helpers/helpers";

const deploymentName = getContractNameFromScriptFileName(path.basename(__filename));

const func: DeployFunction = async (hre) => {
    assertPerimeterDeploymentNetwork(hre.network);
    assertZeroDelayDeploymentCandidate(
        await resolveZeroDelayDeploymentNetwork(hre),
        deploymentName
    );
    await preflightZeroDelayDeployment(hre);
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

    if (network.tags.mainnet) {
        log(
            `>>> Add BorrowerOperations.setPerimeterOps(${tx.address}) at ${borrowerOperations.target} to a SIP AFTER its implementation upgrade`
        );
        return;
    }

    let prevImpl: string;
    try {
        prevImpl = await borrowerOperations.getFunction("perimeterOps")();
    } catch (error) {
        const failure = error as { code?: string; data?: string; value?: string };
        if (
            network.tags.testnet &&
            ((failure?.code === "CALL_EXCEPTION" && failure.data === "0x") ||
                (failure?.code === "BAD_DATA" && failure.value === "0x"))
        ) {
            log(
                `>>> ${deploymentName} deployed at ${tx.address}; implementation upgrade is pending or the hook getter is unavailable. Execute the BorrowerOperations upgrade, then rerun this deployment to submit setPerimeterOps`
            );
            return;
        }
        throw error;
    }
    log(`Current ${deploymentName}: ${prevImpl}`);

    if (tx.address.toLowerCase() !== prevImpl.toLowerCase()) {
        if (!tx.newlyDeployed) {
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
