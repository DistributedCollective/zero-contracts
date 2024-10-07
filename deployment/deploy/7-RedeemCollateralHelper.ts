import { DeployFunction } from "hardhat-deploy/types";
import { getContractNameFromScriptFileName } from "../../scripts/helpers/utils";
const path = require("path");
const deploymentName = getContractNameFromScriptFileName(path.basename(__filename));

const func: DeployFunction = async (hre) => {
    const {
        getNamedAccounts,
        deployments: { deploy, get, getOrNull },
    } = hre;
    const { deployer } = await getNamedAccounts();

    await deploy(deploymentName, {
        from: deployer,
        log: true,
    });
};

func.tags = [deploymentName];
export default func;
