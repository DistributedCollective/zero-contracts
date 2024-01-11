/* eslint-disable no-console */
import { task, types } from "hardhat/config";
import Logs from "node-logs";
import sipArgsList from "./sips/args/sipArgs";
import { logTimer, delay } from "scripts/helpers/utils";
import { parseEthersLogToValue, sendWithMultisig } from "scripts/helpers/helpers";
import { GovernorAlpha } from "types/generated";
import { Contract } from "ethers";

const logger = new Logs().showInConsole(true);

task("sips:create", "Create SIP to Sovryn Governance")
    .addParam(
        "argsFunc",
        "Function name from tasks/sips/args/sipArgs.ts which returns the sip arguments"
    )
    .setAction(async ({ argsFunc }, hre) => {
        const { governor: governorName, args: sipArgs } = await sipArgsList[argsFunc](hre);
        const {
            ethers,
            deployments: { get },
        } = hre;

        const governorDeployment = await get(governorName);
        const governor = (await ethers.getContract(governorName)) as GovernorAlpha;

        logger.info("=== Creating SIP ===");
        logger.info(`Governor Address:    ${governorDeployment.address}`);
        logger.info(`Targets:             ${sipArgs.targets}`);
        logger.info(`Values:              ${sipArgs.values}`);
        logger.info(`Signatures:          ${sipArgs.signatures}`);
        logger.info(`Data:                ${sipArgs.data}`);
        logger.info(`Description:         ${sipArgs.description}`);
        logger.info(`============================================================='`);

        const tx = await governor.propose(
            sipArgs.targets,
            sipArgs.values,
            sipArgs.signatures,
            sipArgs.data,
            sipArgs.description, 
            { gasLimit: 1_000_000 }
        );
        const receipt = await tx.wait();
        const log = receipt!.logs[0]! as unknown as { topics: string[]; data: string };

        const eventData = governor.interface.parseLog(log)!.args;

        logger.success("=== SIP has been created ===");
        logger.success(`Governor Address:     ${governor.target}`);
        logger.success(`Proposal ID:          ${eventData.id.toString()}`);
        logger.success(`Porposer:             ${eventData.proposer}`);
        logger.success(`Targets:              ${eventData.targets}`);
        logger.success(`Values:               ${eventData.values}`);
        logger.success(`Signatures:           ${eventData.signatures}`);
        logger.success(`Data:                 ${eventData.calldatas}`);
        logger.success(`Description:          ${eventData.description}`);
        logger.success(`Start Block:          ${eventData.startBlock}`);
        logger.success(`End Block:            ${eventData.endBlock}`);
        logger.success(`============================================================='`);
    });

task("sips:queue", "Queue proposal in the Governor Owner contract")
    .addParam("proposal", "Proposal Id", undefined, types.string)
    .addParam(
        "governor",
        "Governor deployment name: 'GovernorOwner' or 'GovernorAdmin'",
        undefined,
        types.string
    )
    .addOptionalParam("signer", "Signer name: 'signer' or 'deployer'", "deployer")
    .setAction(async ({ proposal, signer, governor }, hre) => {
        const { ethers } = hre;
        const signerAcc = (await hre.getNamedAccounts())[signer];
        const governorContract = (await ethers.getContract(
            governor,
            await ethers.getSigner(signerAcc)
        )) as GovernorAlpha;
        await (await governorContract.queue(proposal)).wait();
        if (Number(await governorContract.state(proposal)) === 5) {
            logger.info(`SIP ${proposal} queued`);
        } else {
            logger.error(`SIP ${proposal} is NOT queued`);
        }
    });

task("sips:execute", "Execute proposal in a Governor contract")
    .addParam("proposal", "Proposal Id", undefined, types.string)
    .addParam(
        "governor",
        "Governor deployment name: 'GovernorOwner' or 'GovernorAdmin'",
        undefined,
        types.string
    )
    .addOptionalParam("signer", "Signer name: 'signer' or 'deployer'", "deployer")
    .setAction(async ({ proposal, signer, governor }, hre) => {
        const { ethers } = hre;
        const signerAcc = (await hre.getNamedAccounts())[signer];
        const governorContract = (await ethers.getContract(
            governor,
            await ethers.getSigner(signerAcc)
        )) as GovernorAlpha;
        const gasEstimated = Number(await governorContract.execute.estimateGas(proposal));
        await (
            await governorContract.execute(proposal, { gasLimit: Math.round(gasEstimated * 2) })
        ).wait();
        if ((await governorContract.state(proposal)) === 7n) {
            logger.info(`SIP ${proposal} executed`);
        } else {
            logger.error(`SIP ${proposal} is NOT executed`);
        }
    });

task("sips:cancel", "Queue proposal in the Governor Owner contract")
    .addParam("proposal", "Proposal Id", undefined, types.string)
    .addParam(
        "governor",
        "Governor deployment name: 'GovernorOwner' or 'GovernorAdmin'",
        undefined,
        types.string
    )
    .addOptionalParam("signer", "Signer name: 'signer' or 'deployer'", "deployer")
    .setAction(async ({ proposal, signer, governor }, hre) => {
        const {
            deployments: { get },
            ethers,
        } = hre;
        const governorContract = (await ethers.getContract(governor)) as GovernorAlpha;
        const guardian = await governorContract.guardian();
        const msAddress = (await get("MultiSigWallet")).address;
        if (guardian !== msAddress) {
            throw new Error(
                `Governor contract's (${governorContract.target}) guardian (${guardian}) is not multisig (${msAddress})`
            );
        }
        const governorInterface = new ethers.Interface((await get(governor)).abi);
        const data = governorInterface.encodeFunctionData("cancel", [proposal]);
        await sendWithMultisig(hre, msAddress, governorContract.target as string, data, signer);
    });

task("sips:vote-for", "Vote for or against a proposal in the Governor Owner contract")
    .addParam("proposal", "Proposal Id", undefined, types.string)
    .addParam(
        "governor",
        "Governor deployment name: 'GovernorOwner' or 'GovernorAdmin'",
        undefined,
        types.string
    )
    .addOptionalParam("signer", "Signer name: 'signer' or 'deployer'", "deployer")
    .setAction(async ({ proposal, signer, governor }, hre) => {
        const { ethers } = hre;
        const signerAcc = ethers.isAddress(signer)
            ? signer
            : (await hre.getNamedAccounts())[signer];

        const governorContract = (await ethers.getContract(
            governor,
            await ethers.getSigner(signerAcc)
        )) as GovernorAlpha;
        const tx = await (await governorContract.castVote(proposal, true)).wait();
        console.log("Voted for");
        console.log("tx:", tx!.hash);
        console.log("{ to:", tx!.to, "from:", tx!.from, "}");
        console.log(
            "log:\n",
            tx!.logs.map((log) =>
                parseEthersLogToValue(
                    governorContract.interface.parseLog(
                        log as unknown as { topics: string[]; data: string }
                    )
                )
            )
        );
    });

task("sips:queue-timer", "Queue SIP for execution with timer")
    .addParam("proposal", "Proposal Id", undefined, types.string)
    .addParam(
        "governor",
        "Governor deployment name: 'GovernorOwner' or 'GovernorAdmin'",
        undefined,
        types.string
    )
    .addOptionalParam("signer", "Signer name: 'signer' or 'deployer'", "deployer")
    .setAction(async ({ proposal: proposalId, signer, governor }, hre) => {
        const { ethers } = hre;
        const signerAcc = ethers.isAddress(signer)
            ? signer
            : (await hre.getNamedAccounts())[signer];

        const governorContract = (await ethers.getContract(
            governor,
            await ethers.getSigner(signerAcc)
        )) as GovernorAlpha;
        let proposal = await governorContract.proposals(proposalId);
        let currentBlockNumber = await ethers.provider.getBlockNumber();
        let passedTime = 0;
        let delayTime;
        let intervalId;
        const logTime = () => {
            logTimer(delayTime, passedTime);
            passedTime++;
        };
        while (currentBlockNumber <= proposal.endBlock) {
            delayTime = (Number(proposal.endBlock) - currentBlockNumber) * 30000;
            logger.warn(
                `${new Date().toUTCString()}, current block ${currentBlockNumber}, target block ${
                    proposal.endBlock
                }:  pausing for ${delayTime / 1000} secs (${delayTime / 30000} blocks)`
            );
            intervalId = setInterval(logTime, 1000);
            await delay(delayTime);
            currentBlockNumber = await ethers.provider.getBlockNumber();
        }
        clearInterval(intervalId);
        const proposalState = await governorContract.state(proposalId);
        if (Number(proposalState) !== 4) {
            throw new Error("Proposal NOT Succeeded");
        }
        (await governorContract.queue(proposalId)).wait();
        proposal = await governorContract.proposals(proposalId);
        console.log("");
        logger.success(`Proposal ${proposalId} queued. Execution ETA: ${proposal.eta}.`);
    });

task("sips:execute-timer", "Execute SIP with countdown")
    .addParam("proposal", "Proposal Id", undefined, types.string)
    .addParam(
        "governor",
        "Governor deployment name: 'GovernorOwner' or 'GovernorAdmin'",
        undefined,
        types.string
    )
    .addOptionalParam("signer", "Signer name: 'signer' or 'deployer'", "deployer")
    .setAction(async ({ proposal: proposalId, signer, governor }, hre) => {
        const { getNamedAccounts, ethers } = hre;

        const signerAcc = ethers.isAddress(signer) ? signer : (await getNamedAccounts())[signer];
        const governorContract = (await ethers.getContract(
            governor,
            await ethers.getSigner(signerAcc)
        )) as GovernorAlpha;

        if (Number(await governorContract.state(proposalId)) !== 5) {
            throw new Error("Proposal must be queued for execution");
        }
        let proposal = await governorContract.proposals(proposalId);
        //Math.floor(Date.now() / 1000)
        const currentBlockTimestamp = (await ethers.provider.getBlock("latest"))!.timestamp;
        let passedTime = 0;
        let logDelayTime;
        const logTime = () => {
            logTimer(logDelayTime, passedTime);
            passedTime++;
        };
        if (proposal.eta > currentBlockTimestamp) {
            const delayTime = Number(proposal.eta) - currentBlockTimestamp + 120; // add 2 minutes
            logDelayTime = delayTime * 1000;
            logger.info(`Delaying proposal ${proposalId} execution for ${delayTime} sec`);
            const intervalId = setInterval(logTime, 1000);
            await delay(delayTime * 1000);
            clearInterval(intervalId);
        }
        await (await governorContract.execute(proposalId)).wait();
        console.log("");
        if (Number(await governorContract.state(proposalId)) === 7) {
            logger.success(`Proposal ${proposalId} executed`);
        } else {
            logger.error(`Proposal ${proposalId} is NOT executed`);
        }
    });

task("sips:populate", "Create SIP tx object to Propose to Sovryn Governance")
    .addParam(
        "argsFunc",
        "Function name from tasks/sips/args/sipArgs.ts which returns the sip arguments"
    )
    .setAction(async ({ argsFunc }, hre) => {
        console.log(await sipArgsList[argsFunc](hre));
        const { governor: governorName, args: sipArgs } = await sipArgsList[argsFunc](hre);
        const {
            ethers,
            deployments: { get },
        } = hre;

        const governorDeployment = await get(governorName);
        const governor = (await ethers.getContract(governorName)) as Contract;

        logger.info("=== Creating SIP ===");
        logger.info(`Governor Address:    ${governorDeployment.address}`);
        logger.info(`Targets:             ${sipArgs.targets}`);
        logger.info(`Values:              ${sipArgs.values}`);
        logger.info(`Signatures:          ${sipArgs.signatures}`);
        logger.info(`Data:                ${sipArgs.data}`);
        logger.info(`Description:         ${sipArgs.description}`);
        logger.info(`=============================================================`);

        let tx = await governor.propose.populateTransaction(
            sipArgs.targets,
            sipArgs.values,
            sipArgs.signatures,
            sipArgs.data,
            sipArgs.description,
            { gasLimit: 6500000, gasPrice: 66e6 }
        );

        delete tx.from;
        logger.warning("==================== populated tx data start ====================");
        logger.info(`${tx.data}`);
        logger.warning("==================== populated tx data end   =================");
        return tx;
    });
task("sips:decode-sip-data", "Decodes SIP data and writes it to a file")
    .addParam("data", "The ABI-encoded data to decode")
    .setAction(async (taskArgs, hre) => {
        const {
            ethers,
            deployments: { get },
        } = hre;

        // Retrieve the data from the task arguments
        const dataToDecode = `0x${taskArgs.data.toString().substring(10)}`;

        // Define the ABI components you want to decode
        const types = ["address[]", "uint256[]", "string[]", "bytes[]", "string"];

        const jsonStringify = (
            value: any,
            replacer?: (string | number)[] | null | undefined,
            space?: string | number | undefined
        ): any => {
            return JSON.stringify(
                value,
                (key, value) => (typeof value === "bigint" ? value.toString() : value),
                space
            );
        };

        // Decode the data using ethers.js
        const obj = ethers.AbiCoder.defaultAbiCoder().decode(types, dataToDecode);

        // Write the decoded data to a file
        console.log(jsonStringify(obj, null, 2));
    });
