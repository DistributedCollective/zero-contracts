import { task, types } from "hardhat/config";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import Logs from "node-logs";
import * as helpers from "../scripts/helpers/helpers";
import { ERC20, IERC20, LiquityBaseParams, ZUSDToken } from "types/generated";

//import { sendWithMultisig } from "../scripts/helpers/helpers";

const logger = new Logs().showInConsole(true);
task("getBalanceOfAccounts", "Get ERC20 or native token balance of account or address")
    .addPositionalParam(
        "accounts",
        "Address(es) or named account(s) contract name(s) to get balance of: 'deployer' or 'MultiSigWallet,deployer,0x542fda317318ebf1d3deaf76e0b632741a7e677d'"
    )
    .addOptionalParam(
        "tokens",
        "'RBTC' or ERC20 token name(s) or address(es) e.g. 'SOV' or 'SOV,RBTC,0x542fda317318ebf1d3deaf76e0b632741a7e677d', default: 'RBTC'",
        "RBTC"
    )
    .addOptionalParam("decimals", "Return decimal or int amount?", true, types.boolean)
    .setAction(async ({ accounts, decimals, tokens }, hre) => {
        const { ethers } = hre;

        const tokensArray = tokens.split(",");
        for (let token of tokensArray) {
            const accountsArray = accounts.split(",");
            for (let account of accountsArray) {
                const accountAddressLowerCase = account.toLowerCase();
                let accountAddress: string = ethers.isAddress(accountAddressLowerCase)
                    ? accountAddressLowerCase
                    : (await hre.getNamedAccounts())[account];

                accountAddress = ethers.isAddress(accountAddress)
                    ? accountAddress
                    : await (await ethers.getContract(account)).getAddress();

                if (!ethers.isAddress(accountAddress)) {
                    throw Error("Invalid account to get balance of!");
                }

                if (token === "RBTC") {
                    const balance = await ethers.provider.getBalance(accountAddress);
                    logger.success(
                        `RBTC balance of the account ${account} (${accountAddress}): 
                        ${balance / BigInt(decimals ? 1e18 : 1)}`
                    );
                } else {
                    const tokenContract = (
                        ethers.isAddress(token)
                            ? await ethers.getContractAt(
                                  "contracts/interfaces/IERC20.sol:IERC20",
                                  token
                              )
                            : await ethers.getContract(token)
                    ) as ERC20;
                    const tokenSymbol = await tokenContract.symbol();
                    const decimalsDivider =
                        ethers.toBigInt(decimals ? 10 : 1) ** (await tokenContract.decimals());
                    const balance = await tokenContract.balanceOf(accountAddress);
                    logger.success(
                        `${tokenSymbol} (${
                            tokenContract.target
                        }) balance of the account ${account} (${accountAddress}): 
                        ${balance / decimalsDivider}`
                    );
                }
            }
        }
    });
