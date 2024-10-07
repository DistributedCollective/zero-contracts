import { task, types } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import Logs from "node-logs";
import * as helpers from "../scripts/helpers/helpers";
import { LiquityBaseParams, ZUSDToken } from "types/generated";

//import { sendWithMultisig } from "../scripts/helpers/helpers";

const logger = new Logs().showInConsole(true);

task("liquidation:redeemCollateralForMS", "Redeem colalteral from multisig")
    .addOptionalParam("signer", "Signer name: 'signer' or 'deployer'", "deployer")
    .addOptionalParam("multisig", "Multisig wallet address", undefined, types.string)
    .addOptionalParam("amount", "Amount to redeem in ETH", undefined, types.string)
    .addFlag("skipApproval", "Skip creating multisig tx for ZUSD amount approval")
    .addFlag("skipRedemption", "Skip creating multisig tx for redemption")
    .addFlag("redeemBalance", "Redeem balance")
    .setAction(
        async ({ skipRedemption, skipApproval, redeemBalance, amount, signer, multisig }, hre) => {
            if (!redeemBalance && (amount == undefined || amount == "" || amount == "0")) {
                throw new Error("No amount to redeem");
            }

            const {
                deployments: { get, getArtifact },
                ethers,
            } = hre;

            const signerAcc = ethers.isAddress(signer)
                ? signer
                : (await hre.getNamedAccounts())[signer];

            if (!ethers.isAddress(multisig)) {
                multisig = ethers.ZeroAddress;
            }
            const code = await ethers.provider.getCode(multisig);
            if (code === "0x") {
                multisig = ethers.ZeroAddress;
            }
            console.log("multisig", multisig);
            const ms =
                multisig === ethers.ZeroAddress
                    ? await ethers.getContract("MultiSigWallet")
                    : await ethers.getContractAt("MultiSigWallet", multisig);

            const redeemCollateralHelperAddress = (await get("RedeemCollateralHelper")).address;
            const redeemCollateralHelperAbi = (await get("RedeemCollateralHelper")).abi;
            const troveManagerAddress = (await get("TroveManager")).address;
            const hintHelpersAddress = (await get("HintHelpers")).address;
            const priceFeedAddress = (await get("PriceFeed")).address;
            const zusd = (await ethers.getContract("ZUSDToken")) as ZUSDToken;
            const zusdAddress = await zusd.getAddress();
            const lbp = (await ethers.getContract("LiquityBaseParams")) as LiquityBaseParams;
            const maxFee = (await lbp.REDEMPTION_FEE_FLOOR()) * BigInt(10);
            console.log("maxFee", maxFee);
            const msAddress = await ms.getAddress();
            console.log("msAddress", msAddress);
            if (redeemBalance) {
                amount = await zusd.balanceOf(msAddress);
            } else {
                amount = ethers.parseEther(amount);
            }
            let data;
            if (!skipApproval) {
                const zusdTokenInterface = new ethers.Interface(
                    (await getArtifact("ZUSDToken")).abi
                );
                data = zusdTokenInterface.encodeFunctionData("approve", [
                    redeemCollateralHelperAddress,
                    amount,
                ]);
                logger.info("Approving ZUSD amount for the TroveManager to redeem");
                await helpers.sendWithMultisig(
                    hre,
                    msAddress,
                    zusd.target as string,
                    data,
                    signerAcc
                );
            } else {
                logger.warn("Approval skipped by the --skip-approval parameter");
            }

            if (!skipRedemption) {
                const redeemCollateralHelperInterface = new ethers.Interface(
                    redeemCollateralHelperAbi
                );
                data = redeemCollateralHelperInterface.encodeFunctionData("redeemCollateral", [
                    troveManagerAddress,
                    hintHelpersAddress,
                    priceFeedAddress,
                    zusdAddress,
                    amount,
                    maxFee,
                ]);

                logger.info("Redeeming ZUSD from multisig");
                await helpers.sendWithMultisig(
                    hre,
                    msAddress,
                    redeemCollateralHelperAddress,
                    data,
                    signerAcc
                );
            } else {
                logger.warn("Redemption skipped by the --skip-redemption parameter");
            }
        }
    );
