import { DeployFunction } from "hardhat-deploy/types";
import { deployWithCustomProxy } from "../../scripts/helpers/helpers";
import { getContractNameFromScriptFileName } from "../../scripts/helpers/utils";
const path = require("path");
const deploymentName = getContractNameFromScriptFileName(path.basename(__filename));

const func: DeployFunction = async (hre) => {
    const { 
        deployments: { get },
        getNamedAccounts
    } = hre;
    const { deployer } = await getNamedAccounts();

    const permit2Deployment = await get("Permit2");
    await deployWithCustomProxy(hre, deployer, deploymentName, "UpgradableProxy", false, "MultiSigWallet", "", [permit2Deployment.address]);
};

func.tags = [deploymentName];
export default func;
