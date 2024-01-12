import { DeployFunction } from "hardhat-deploy/types";
import { deployWithCustomProxy } from "../../scripts/helpers/helpers";
import { getContractNameFromScriptFileName } from "../../scripts/helpers/utils";
const path = require("path");
const deploymentName = getContractNameFromScriptFileName(path.basename(__filename));

const func: DeployFunction = async (hre) => {
    const { getNamedAccounts } = hre;
    const { deployer } = await getNamedAccounts();
    await deployWithCustomProxy(hre, deployer, deploymentName, "UpgradableProxy", false, "MultiSigWallet", "", [
        "1209600",
    ]);
};

func.tags = [deploymentName];
export default func;
