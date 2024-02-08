import { task, types } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import Logs from "node-logs";
import * as helpers from "../scripts/helpers/helpers";
import { LiquityBaseParams } from "types/generated/artifacts/contracts/LiquityBaseParams";
import { BaseContract } from "ethers";
import { ISipArgument } from "./sips/args/sipArgs";
import { sendWithMultisig } from "../scripts/helpers/helpers";

const logger = new Logs().showInConsole(true);

task("params:setBorrowingFeeFloor", "Upgrade implementation of feesManager contract")
    .addPositionalParam(
        "value",
        "Set borrowing fee floor value - e.g. 0.13 is 0.13%",
        undefined,
        types.string,
        false
    )
    .addFlag("isMultisig", "flag if transaction needs to be intiated from the multisig contract")
    .addFlag("isSIP", "flag if transaction needs to be initiated from the SIP")
    .setAction(async ({ value, isMultisig, isSIP }, hre) => {
        const {
            ethers,
            deployments,
            deployments: { get },
            getNamedAccounts,
        } = hre;
        const zeroBaseParamsContract = (await ethers.getContract("LiquityBaseParams")) as any;
        const newBorrowingFeeFloor = ethers.parseEther(value);
        // const abi = ["function setBorrowingFeeFloor(uint256 BORROWING_FEE_FLOOR_)"];
        const data = zeroBaseParamsContract.interface.encodeFunctionData("setBorrowingFeeFloor", [
            newBorrowingFeeFloor,
        ]);
        const { deployer } = await getNamedAccounts();
        if (isMultisig) {
            const multisigAddress = (await get("MultiSigWallet")).address;
            await sendWithMultisig(
                hre,
                multisigAddress,
                zeroBaseParamsContract.target,
                data,
                deployer
            );
        } else if (isSIP) {
            const signatureUpgrade = "setBorrowingFeeFloor(uint256)";
            const sipArgs: ISipArgument["args"] = {
                targets: [zeroBaseParamsContract.target],
                values: [0],
                signatures: [signatureUpgrade],
                data: [data],
                description: "Set new borrowing fee floor",
            };
            logger.warn(">>> CREATE A SIP WITH THIS ARGS: <<<");
            logger.info(sipArgs);
            logger.warn("====================================");
        }
    });