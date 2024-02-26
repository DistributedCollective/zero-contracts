import { DeployFunction } from "hardhat-deploy/types";
import { deployWithCustomProxy } from "../../scripts/helpers/helpers";
import { getContractNameFromScriptFileName } from "../../scripts/helpers/utils";
const path = require("path");
const deploymentName = getContractNameFromScriptFileName(path.basename(__filename));

/** IMPORTANT NOTE: The TroveManager deployment from this script will result the failure of code verfication in explorers (tenderly & rsk explorer) */
/** The work around is to deploy from remix, and then replace the deployment data manually to the deployment file */
const func: DeployFunction = async (hre) => {
    const { 
    deployments: { get },
        getNamedAccounts
    } = hre;
    const { deployer } = await getNamedAccounts();

    const permit2Deployment = await get("Permit2");
    await deployWithCustomProxy(hre, deployer, deploymentName, "UpgradableProxy", false, "MultiSigWallet", "", [
        "1209600",
        permit2Deployment.address
    ]);
};

func.tags = [deploymentName];
export default func;
