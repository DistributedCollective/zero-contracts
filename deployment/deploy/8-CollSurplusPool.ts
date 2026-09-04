import { DeployFunction } from "hardhat-deploy/types";
import { deployWithCustomProxy } from "../../scripts/helpers/helpers";
import { getContractNameFromScriptFileName } from "../../scripts/helpers/utils";
const path = require("path");
const deploymentName = getContractNameFromScriptFileName(path.basename(__filename));

const func: DeployFunction = async (hre) => {
    const { getNamedAccounts } = hre;
    const { deployer } = await getNamedAccounts();

    // CollSurplusPool has no constructor args: its wiring lives in proxy storage
    // (set once via setAddresses), so the implementation deploys bare and the
    // existing proxy keeps its state across the upgrade.
    await deployWithCustomProxy(hre, deployer, deploymentName, "UpgradableProxy");
};

func.tags = [deploymentName];
export default func;
