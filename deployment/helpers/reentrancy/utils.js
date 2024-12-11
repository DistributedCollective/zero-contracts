const { ethers } = require("hardhat");
const testHelpers = require("../../../utils/js/testHelpers.js");
const { Transaction, Wallet, Provider, getCreateAddress } = require("ethers");

const th = testHelpers.TestHelper;
const toBN = th.toBN;

const SAVED_DEPLOY_DATA_ZERO = {
    serializedDeployTx:
        "0xf901f8808403ef14808302194d8080b901a6608060405234801561001057600080fd5b50610186806100206000396000f3fe608060405234801561001057600080fd5b50600436106100365760003560e01c80636981665b1461003b57806369b13ba014610073575b600080fd5b6100616004803603602081101561005157600080fd5b50356001600160a01b0316610094565b60408051918252519081900360200190f35b6100926004803603602081101561008957600080fd5b503515156100a6565b005b60006020819052908152604090205481565b80156100c35732600090815260208190526040902043905561014d565b326000908152602081905260409020541561014d573260009081526020819052604090205443141561013c576040805162461bcd60e51b815260206004820152601f60248201527f5a65726f50726f746f636f6c4d757465783a206d75746578206c6f636b656400604482015290519081900360640190fd5b326000908152602081905260408120555b5056fea26469706673582212208fa44190280703d199dee337f61f207770f627ddf810bdbd4a1c74fcb8b31e2664736f6c634300060b00331ba06d757465786d757465786d757465786d757465786d757465786d757465786d75a06d757465786d757465786d757465786d757465786d757465786d757465786d75",
    deployerAddress: "0xb339D675F5Fb2EEec8a13db76dD57C11F4Af3869",
    contractAddress: "0x42B023F998d7B9c127e9bDcDCE57ccd1f5e1d919",
    transactionCostWei: toBN(9078234000000),
};

const getOrDeployZeroProtocolMutex = async () => {
    const provider = ethers.provider;

    const { serializedDeployTx, deployerAddress, contractAddress, transactionCostWei } =
    SAVED_DEPLOY_DATA_ZERO;
    const ZeroProtocolMutex = await ethers.getContractAt("ZeroProtocolMutex", contractAddress);
    const deployedCode = await provider.getCode(contractAddress);
    if (deployedCode.replace(/0+$/) !== "0x") {
        // Contract is deployed
        // it's practically impossible to deploy to this address with malicious bytecode so we don't need to check
        return ZeroProtocolMutex;
    }

    // Not deployed, we need to deploy
    console.log("ZeroProtocolMutex has not been deployed, deploying...")

    // Fund the account
    const deployerBalance = await provider.getBalance(deployerAddress);
    const whale = (await ethers.getSigners())[0];
    if (deployerBalance < transactionCostWei) {
        const requiredBalance = toBN(transactionCostWei.toString()).sub(toBN(deployerBalance.toString()));
        const tx = await whale.sendTransaction({
            to: deployerAddress,
            value: requiredBalance.toString(),
        });
        await tx.wait();
    }

    const tx = await provider.broadcastTransaction(serializedDeployTx);
    await tx.wait();
    
    return ZeroProtocolMutex.attach(contractAddress);
};

async function createZeroProtocolMutexDeployTransaction() {
    const provider = ethers.provider;
    const ZeroProtocolMutex = await ethers.getContractFactory("ZeroProtocolMutex");
    const { data: bytecode } = await ZeroProtocolMutex.getDeployTransaction();
    console.log(bytecode)

    const signature = {
        v: 27, // must not be eip-155 to allow cross-chain deployments
        // "mutex" in hex: 6d75746578
        //  0xm u t e x m u t e x m u t e x m u t e x m u t e x m u t e x m u
        r: "0x6d757465786d757465786d757465786d757465786d757465786d757465786d75",
        s: "0x6d757465786d757465786d757465786d757465786d757465786d757465786d75",
    };

    const hardhatGasLimit = await provider.estimateGas({ data: bytecode });
    const gasLimit = toBN(137549);
    if (hardhatGasLimit > gasLimit) {
        throw new Error(
            `Hardhat estimates the gas limit as ${hardhatGasLimit.toString()}, ` +
                `which is higher than the hardcoded gas limit ${gasLimit.toString()}`
        );
    }

    // 10 gwei, should be enough to also mine on other chains. Could also be 100 like with erc1820
    const gasPrice = toBN(66000000);

    const transactionCostWei = gasLimit.mul(gasPrice);

    const deployTx = {
        data: bytecode, // We could hardcode this too
        nonce: 0,
        gasLimit: gasLimit.toString(),
        gasPrice: gasPrice.toString(),
        type: 0
    };

    const transaction = Transaction.from({...deployTx, signature});
    const serializedDeployTx = transaction.serialized;

    console.log(transactionCostWei.toString())

    const parsedDeployTx = Transaction.from(serializedDeployTx);
    const contractAddress = await getCreateAddress({
        from: parsedDeployTx.from,
        nonce: parsedDeployTx.nonce,
    });
    const deployerAddress = parsedDeployTx.from;

    return {
        serializedDeployTx,
        deployerAddress,
        contractAddress,
        transactionCostWei,
    };
}

module.exports = {
    getOrDeployZeroProtocolMutex,
    createZeroProtocolMutexDeployTransaction,
    SAVED_DEPLOY_DATA_ZERO
};
