import { DeployFunction } from "hardhat-deploy/types";
const path = require("path");

const func: DeployFunction = async (hre) => {
    const { getNamedAccounts, deployments: { deploy, get } } = hre;
    const { deployer } = await getNamedAccounts();
    const backupPriceFeed = await get("FallbackOracle");
    await deploy("PriceFeedRevertOnStalePrice", {
        from: deployer,
        args: [
            "0x87d7fd2e0baac4ae61cc7e728647e2f6d80118a0",
            backupPriceFeed.address,
        ],
        log: true,
        skipIfAlreadyDeployed: true,
    });
};

func.tags = ["PriceFeedRevertOnStalePrice"];
export default func;
