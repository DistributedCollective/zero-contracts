import { HardhatRuntimeEnvironment } from "hardhat/types";
import Logs from "node-logs";
import { TroveManager } from "types/generated";
const logger = new Logs().showInConsole(true);

export interface ISipArgument {
    args: {
        targets: string[];
        values: number[];
        signatures: string[];
        data: string[];
        description: string;
    };
    governorName: string;
}

const zeroMyntIntegrationSIP = async (hre: HardhatRuntimeEnvironment): Promise<ISipArgument> => {
    const {
        ethers,
        deployments: { get },
    } = hre;

    const targetContractsList = [
        "BorrowerOperations",
        "StabilityPool",
        "ZUSDToken",
        "TroveManager",
    ];
    const targetsContractProxies = await Promise.all(
        targetContractsList.map(async (val) => {
            return (await get(val)).address;
        })
    );

    const contractsImplementations = await Promise.all(
        targetContractsList.map(async (val) => {
            return (await get(val + "_Implementation")).address;
        })
    );

    const getImplementationAbi = ["function getImplementation() public view returns(address)"];
    // const getImplementationInterface = new ethers.Interface(getImplementationAbi);
    // validate deployments
    const errorLog: string[] = [];
    await Promise.all(
        targetsContractProxies.map(async (val, index) => {
            const proxy = await ethers.getContractAt(getImplementationAbi, val);
            if ((await proxy.getImplementation()) === contractsImplementations[index]) {
                errorLog.push(
                    `Implementation ${targetContractsList[index]} has not changed: ${contractsImplementations[index]}`
                );
            }
        })
    );
    if (errorLog.length > 0) {
        logger.error(errorLog);
        //throw Error();
    }

    const iSetImplementationInterface = new ethers.Interface([
        "function setImplementation(address _implementation)",
    ]);

    const datas = targetsContractProxies.map((val, index) => {
        return iSetImplementationInterface
            .getAbiCoder()
            .encode(["address"], [contractsImplementations[index]]);
    });
    const signatures = Array(targetsContractProxies.length).fill("setImplementation(address)");

    // replace troveManagerRedeepOps in TroveManager
    const iSetTroveManagerRedeemOps = new ethers.Interface([
        "function setTroveManagerRedeemOps(address _troveManagerRedeemOps)",
    ]);

    signatures.push("setTroveManagerRedeemOps(address)");
    const troveManagerDeployment = await get("TroveManager");
    const troveManagerRedeemOpsDeployment = await get("TroveManagerRedeemOps");
    targetsContractProxies.push(troveManagerDeployment.address);
    datas.push(
        iSetTroveManagerRedeemOps
            .getAbiCoder()
            .encode(["address"], [troveManagerRedeemOpsDeployment.address])
    );

    // validate TroveManagerRedeemOps
    const troveManager = (await ethers.getContract("TroveManager")) as unknown as TroveManager;
    if ((await troveManager.troveManagerRedeemOps()) === troveManagerRedeemOpsDeployment.address) {
        logger.error(
            `TroveManagerRedeemOps is not changed: ${troveManagerRedeemOpsDeployment.address}. Either deployment address is wrong or should be excluded from the SIP.`
        );
        throw Error();
    }

    // set MassetManager address in BorrowerOperations
    const iSetMassetManagerAddress = new ethers.Interface([
        "function setMassetManagerAddress(address _massetManagerAddress)",
    ]);
    signatures.push("setMassetManagerAddress(address)");
    const borrowerOperations = await ethers.getContract("BorrowerOperations");
    targetsContractProxies.push(borrowerOperations.target.toString());
    const massetManagerDeployment = await get("MassetManager");
    datas.push(
        iSetMassetManagerAddress
            .getAbiCoder()
            .encode(["address"], [massetManagerDeployment.address])
    );

    /*
    there is no IMassetManager yet
    if (
        ethers.getAddress(await borrowerOperations.massetManager()) ===
        massetManagerDeployment.address
    ) {
        logger.error(
            `MassetManager is not changed: ${troveManagerRedeemOpsDeployment.address}. Either deployment address is wrong or should be excluded from the SIP.`
        );
        throw Error();
    }*/

    const args: ISipArgument = {
        args: {
            targets: targetsContractProxies,
            values: Array(targetsContractProxies.length).fill(0),
            signatures: signatures,
            data: datas,
            description:
                "SIP-0054: Integrate Mynt with Zero, Details: https://github.com/DistributedCollective/SIPS/blob/98ef848/SIP-0054.md, sha256: f623ab973a6fa175cc2bd1ebc50cf79699de2f88b84d98535288dba150a4ff4b",
        },
        governorName: "GovernorOwner",
    };

    return args;
};

const zeroFeesUpdate = async (hre: HardhatRuntimeEnvironment): Promise<ISipArgument> => {
    const {
        ethers,
        deployments: { get },
    } = hre;
    const zeroBaseParams = await get("LiquityBaseParams");
    const newFeeValue = ethers.parseEther("0.025");
    const iSetFeesFloor = new ethers.Interface([
        "function setBorrowingFeeFloor(uint256)",
        "function setRedemptionFeeFloor(uint256)",
    ]);
    const args: ISipArgument = {
        args: {
            targets: [zeroBaseParams.address, zeroBaseParams.address],
            values: [0, 0],
            signatures: ["setBorrowingFeeFloor(uint256)", "setRedemptionFeeFloor(uint256)"],
            data: [
                iSetFeesFloor.getAbiCoder().encode(["uint256"], [newFeeValue]),
                iSetFeesFloor.getAbiCoder().encode(["uint256"], [newFeeValue]),
            ],
            description:
                "SIP-0055: Zero Fee Floor Update, Details: https://github.com/DistributedCollective/SIPS/blob/b7efe43/SIP-0055.md, sha256: 0f193ed8589e8ef0e8db3b66ef2c23a6b139245d3a9335b67851421cbd73d53c",
        },
        governorName: "GovernorOwner",
    };

    return args;
};

const sip0054And0055Combo = async (hre: HardhatRuntimeEnvironment): Promise<ISipArgument> => {
    const args0054: ISipArgument = await zeroMyntIntegrationSIP(hre);
    const args0055: ISipArgument = await zeroFeesUpdate(hre);
    let argsCombo: ISipArgument = {
        args: {
            targets: [],
            values: [],
            signatures: [],
            data: [],
            description: "",
        },
        governorName: "GovernorOwner",
    };
    for (const prop in args0054.args) {
        argsCombo.args[prop] =
            prop !== "description"
                ? args0054.args[prop].concat(args0055.args[prop])
                : `Unified SIP-0054 and SIP-0055. ${args0054.args[prop]}. ${args0055.args[prop]}`;
    }
    return argsCombo;
};

const sip0061 = async (hre: HardhatRuntimeEnvironment): Promise<ISipArgument> => {
    const {
        ethers,
        deployments: { get },
    } = hre;

    // @todo for the mainnet deployment first run `yarn deploy --tags 'StabilityPool,CommunityIssuance' --network rskSovrynMainnet`
    const newStabilityPoolImplementation = (await get("StabilityPool_Implementation")).address;

    const communityIssuanceAddress = (await get("CommunityIssuance_Proxy")).address;

    console.log(`New stability pool implementation: ${newStabilityPoolImplementation}`);
    console.log(`Community issuance address: ${communityIssuanceAddress}`);

    const stabilityPoolProxyAddress = (await get("StabilityPool_Proxy")).address;

    const args: ISipArgument = {
        args: {
            targets: [stabilityPoolProxyAddress, stabilityPoolProxyAddress],
            values: [0, 0],
            signatures: ["setImplementation(address)", "setCommunityIssuanceAddress(address)"],
            data: [
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["address"],
                    [newStabilityPoolImplementation]
                ),
                ethers.AbiCoder.defaultAbiCoder().encode(["address"], [communityIssuanceAddress]),
            ],
            description:
                "SIP-0061: Zero stability pool subsidies: https://github.com/DistributedCollective/SIPS/blob/cc1a368/SIP-0061.md, sha256: 9c38bb9e30855ef7fc2fba8a3a6b731182577ed8f5d5f5b18773ca528bde532b",
        },
        governorName: "GovernorOwner",
    };

    return args;
};

const zeroFeesUpdateSip0059 = async (hre: HardhatRuntimeEnvironment): Promise<ISipArgument> => {
    const {
        ethers,
        deployments: { get },
    } = hre;
    const zeroBaseParams = await get("LiquityBaseParams");
    const newBorrowingFeeFloorValue = ethers.parseEther("0.05");
    const newMaxBorrowingFee = ethers.parseEther("0.075");
    const newRedemptionFeeFloor = ethers.parseEther("0.019");
    const iSetFeesFloor = new ethers.Interface([
        "function setBorrowingFeeFloor(uint256)",
        "function setMaxBorrowingFee(uint256)",
        "function setRedemptionFeeFloor(uint256)",
    ]);
    const args: ISipArgument = {
        args: {
            targets: [zeroBaseParams.address, zeroBaseParams.address, zeroBaseParams.address],
            values: [0, 0, 0],
            signatures: [
                "setBorrowingFeeFloor(uint256)",
                "setMaxBorrowingFee(uint256)",
                "setRedemptionFeeFloor(uint256)",
            ],
            data: [
                iSetFeesFloor.getAbiCoder().encode(["uint256"], [newBorrowingFeeFloorValue]),
                iSetFeesFloor.getAbiCoder().encode(["uint256"], [newMaxBorrowingFee]),
                iSetFeesFloor.getAbiCoder().encode(["uint256"], [newRedemptionFeeFloor]),
            ],
            description:
                "SIP-0059: Zero Fee Floor Update: March 22, Details: https://github.com/DistributedCollective/SIPS/blob/b22933f/SIP-0059.md, sha256: cf432a01b302b0c21b35f55c423d36233cf2f536a96a4d6cc97b2c5b5bb1fbda",
        },
        governorName: "GovernorOwner",
    };

    return args;
};

const sip0062 = async (hre: HardhatRuntimeEnvironment): Promise<ISipArgument> => {
    // Updating REDEMPTION_FEE_FLOOR from 1.9% to 1%
    const {
        ethers,
        deployments: { get },
    } = hre;
    const zeroBaseParams = await get("LiquityBaseParams");
    const newRedemptionFeeFloor = ethers.parseEther("0.01");
    const iSetFeesFloor = new ethers.Interface(["function setRedemptionFeeFloor(uint256)"]);
    const args: ISipArgument = {
        args: {
            targets: [zeroBaseParams.address],
            values: [0],
            signatures: ["setRedemptionFeeFloor(uint256)"],
            data: [iSetFeesFloor.getAbiCoder().encode(["uint256"], [newRedemptionFeeFloor])],
            description:
                "SIP-0062: Zero Fee Floor Update, May 12, Details: https://github.com/DistributedCollective/SIPS/blob/4fed4b8/SIP-0062.md, sha256: 566e57c2e98c848395b1b6b2d3718175ed592014a33e81c305947e5017b5925e",
        },
        governorName: "GovernorOwner",
    };

    return args;
};

const zeroFeesUpdateSip0066 = async (hre: HardhatRuntimeEnvironment): Promise<ISipArgument> => {
    const {
        ethers,
        deployments: { get },
    } = hre;
    const zeroBaseParams = await get("LiquityBaseParams");
    const newBorrowingFeeFloorValue = ethers.parseEther("0.99");
    const newMaxBorrowingFee = ethers.parseEther("1.00");
    const args: ISipArgument = {
        args: {
            targets: [zeroBaseParams.address, zeroBaseParams.address],
            values: [0, 0],
            signatures: ["setBorrowingFeeFloor(uint256)", "setMaxBorrowingFee(uint256)"],
            data: [
                ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newBorrowingFeeFloorValue]),
                ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [newMaxBorrowingFee]),
            ],
            description:
                "SIP-0066: Curtailing Zero borrowing, Details: https://github.com/DistributedCollective/SIPS/blob/54fe297/SIP-0066.md, sha256: b6aacd47eb5121f4b3c0c835157d3963e4c75354ee008ba717621a32bf9fa745",
        },
        governorName: "GovernorOwner",
    };

    return args;
};

const sipSOV3564 = async (hre: HardhatRuntimeEnvironment): Promise<ISipArgument> => {
    const {
        ethers,
        deployments: { get },
    } = hre;

    // @todo for the mainnet deployment first run `yarn deploy --tags 'StabilityPool,BorrowerOperations,TroveManager' --network rskSovrynMainnet`
    const newStabilityPoolImplementation = (await get("StabilityPool_Implementation")).address;
    const newBorrowerOperationsImplementation = (await get("BorrowerOperations_Implementation")).address;
    const newTroveManagerImplementation = (await get("TroveManager_Implementation")).address;

    console.log(`New stability pool implementation: ${newStabilityPoolImplementation}`);
    console.log(`New borrower operations implementation: ${newBorrowerOperationsImplementation}`);
    console.log(`New trove manager implementation: ${newTroveManagerImplementation}`);

    const stabilityPoolProxyAddress = (await get("StabilityPool_Proxy")).address;
    const borrowerOperationsAddress = (await get("BorrowerOperations_Proxy")).address;
    const troveManagerAddress = (await get("TroveManager_Proxy")).address;

    const args: ISipArgument = {
        args: {
            targets: [stabilityPoolProxyAddress, borrowerOperationsAddress, troveManagerAddress],
            values: [0, 0],
            signatures: ["setImplementation(address)", "setImplementation(address)", "setImplementation(address)"],
            data: [
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ["address"],
                    [newStabilityPoolImplementation]
                ),
                ethers.AbiCoder.defaultAbiCoder().encode(["address"], [borrowerOperationsAddress]),
                ethers.AbiCoder.defaultAbiCoder().encode(["address"], [troveManagerAddress]),
            ],
            // @todo update sip description
            description:
                "SIP-SOV3564: upgrade stabilityPool, borrowerOperations, troveManager",
        },
        governorName: "GovernorOwner",
    };

    return args;
};

const sipArgs = {
    zeroMyntIntegrationSIP,
    zeroFeesUpdate,
    sip0054And0055Combo,
    sip0061,
    zeroFeesUpdateSip0059,
    sip0062,
    zeroFeesUpdateSip0066,
    sipSOV3564,
};

export default sipArgs;
