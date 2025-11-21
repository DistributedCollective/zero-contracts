const chai = require("chai");
const { expect } = chai;

import {
    loadFixture,
    setBalance,
    reset,
    SnapshotRestorer,
    takeSnapshot,
} from "@nomicfoundation/hardhat-network-helpers";
import hre from "hardhat";

const {
    ethers,
    deployments,
    deployments: { createFixture },
} = hre;

import { BorrowerOperations, HintHelpers, LiquityBaseParams, PriceFeed, SortedTroves, TroveManager, ZUSDToken } from "types/generated";

const ONE_RBTC = ethers.parseEther("1.0");
const ZUSD_AMOUNT = ethers.parseEther("100000"); // 100,000 ZUSD
const RBTC_PRICE_USD = 90000; // rBTC price in USD
const MCR_BASIS = 110; // Minimum Collateralization Ratio = 110%

/**
 * ZUSD Redemption Test
 * 
 * Note: This test requires a forked network (rskForkedMainnet).
 * Make sure to start the hardhat node with sufficient timeout settings:
 * 
 * npx hardhat node --fork https://mainnet-dev.sovryn.app/rpc --no-deploy --fork-block-number <block> --gasprice 66000000
 * 
 * If you experience timeout errors, the network timeout has been increased to 600 seconds (10 minutes)
 * in hardhat.config.ts for the rskForkedMainnet network.
 */
describe("ZUSD Redemption Test", () => {
    const setupTest = createFixture(async ({ deployments, getNamedAccounts }) => {
        const { deployer } = await getNamedAccounts();
        const deployerSigner = await ethers.getSigner(deployer);
        
        // Set balance for deployer (borrower account)
        await setBalance(deployer, ONE_RBTC * 20n);

        // Get contract instances from deployment files (these point to actual on-chain contracts)
        // On a forked network, hardhat-deploy automatically loads from deployment/deployments/rskSovrynMainnet
        // No need to call deployments.fixture() - just get the contracts directly
        const borrowerOperations = (await ethers.getContract("BorrowerOperations", deployer)) as BorrowerOperations;
        const troveManager = (await ethers.getContract("TroveManager", deployer)) as TroveManager;
        const hintHelpers = (await ethers.getContract("HintHelpers", deployer)) as HintHelpers;
        const sortedTroves = (await ethers.getContract("SortedTroves", deployer)) as SortedTroves;
        const priceFeed = (await ethers.getContract("PriceFeed", deployer)) as PriceFeed;
        const zusdToken = (await ethers.getContract("ZUSDToken", deployer)) as ZUSDToken;
        const liquityBaseParams = (await ethers.getContract("LiquityBaseParams", deployer)) as LiquityBaseParams;

        // Verify we're using the actual on-chain contract addresses from deployment files
        const borrowerOpsAddr = await borrowerOperations.getAddress();
        const troveManagerAddr = await troveManager.getAddress();
        
        // Expected addresses from deployment/deployments/rskSovrynMainnet
        const expectedBorrowerOps = "0x5B9dB4B8bdeF3e57323187a9AC2639C5DEe5FD39";
        const expectedTroveManager = "0x82B09695ee4F214f3A0803683C4AaEc332E4E0a3";
        
        console.log("\n=== Verifying On-Chain Contract Addresses ===");
        console.log(`BorrowerOperations: ${borrowerOpsAddr}`);
        console.log(`  Expected (from deployment files): ${expectedBorrowerOps}`);
        console.log(`  Match: ${borrowerOpsAddr.toLowerCase() === expectedBorrowerOps.toLowerCase()}`);
        console.log(`TroveManager: ${troveManagerAddr}`);
        console.log(`  Expected (from deployment files): ${expectedTroveManager}`);
        console.log(`  Match: ${troveManagerAddr.toLowerCase() === expectedTroveManager.toLowerCase()}`);
        console.log(`HintHelpers: ${await hintHelpers.getAddress()}`);
        console.log(`SortedTroves: ${await sortedTroves.getAddress()}`);
        console.log(`PriceFeed: ${await priceFeed.getAddress()}`);
        console.log(`ZUSDToken: ${await zusdToken.getAddress()}`);
        console.log(`LiquityBaseParams: ${await liquityBaseParams.getAddress()}`);
        console.log("==============================================\n");
        
        // Verify addresses match expected on-chain addresses
        expect(borrowerOpsAddr.toLowerCase()).to.equal(expectedBorrowerOps.toLowerCase(), 
            "BorrowerOperations address should match deployment file");
        expect(troveManagerAddr.toLowerCase()).to.equal(expectedTroveManager.toLowerCase(), 
            "TroveManager address should match deployment file");

        // Create a second account for receiving ZUSD
        const accounts = await ethers.getSigners();
        const redeemerAccount = accounts[1];
        await setBalance(redeemerAccount.address, ONE_RBTC * 5n);

        return {
            deployer,
            deployerSigner,
            redeemerAccount,
            borrowerOperations,
            troveManager,
            hintHelpers,
            sortedTroves,
            priceFeed,
            zusdToken,
            liquityBaseParams,
        };
    });

    let snapshot: SnapshotRestorer;
    
    before(async () => {
        // Check if we're already on a forked network (rskForkedMainnet)
        const isForkedNetwork = hre.network.tags?.forked === true;
        
        if (isForkedNetwork) {
            // Already on a forked network via hardhat node
            // Just get the current block number - no need to reset
            const currentBlock = await ethers.provider.getBlockNumber();
            console.log(`Using existing forked network at block: ${currentBlock}`);
            console.log(`Note: Network is already forked. To fork 100 blocks before latest, restart hardhat node with: --fork-block-number <block>`);
        } else {
            // Not on a forked network, so we need to fork dynamically
            // Query the latest block from the RPC and fork 100 blocks before
            const rpcUrl = "https://mainnet-dev.sovryn.app/rpc";
            
            try {
                // Create provider with increased timeout for RPC calls
                const provider = new ethers.JsonRpcProvider(rpcUrl);
                // Note: Timeout is configured in hardhat.config.ts network settings
                
                const latestBlock = await provider.getBlockNumber();
                console.log(`Latest block number: ${latestBlock}`);
                
                // Fork 100 blocks before the latest block
                const forkBlock = latestBlock - 100;
                console.log(`Forking at block: ${forkBlock} (100 blocks before latest)`);
                
                await reset(rpcUrl, forkBlock);
            } catch (error) {
                console.error("Error querying latest block or forking:", error);
                throw error;
            }
        }
    });

    beforeEach(async () => {
        snapshot = await takeSnapshot();
    });

    afterEach(async () => {
        await snapshot.restore();
    });

    it("Should create a line of credit, transfer ZUSD, and redeem it for rBTC", async function () {
        // Note: This test uses reset() to dynamically fork, so it works with --network hardhat
        // The reset() call in before() hook forks the network from the RPC
        // Increased timeout for this test due to complex redemption operations
        this.timeout(600000); // 10 minutes timeout

        const {
            deployerSigner,
            redeemerAccount,
            borrowerOperations,
            troveManager,
            hintHelpers,
            sortedTroves,
            priceFeed,
            zusdToken,
            liquityBaseParams,
        } = await setupTest();

        // Step 1: Get current rBTC price
        // fetchPrice() is not marked as view, so we use staticCall to read the value
        const currentPrice = await priceFeed.fetchPrice.staticCall();
        
        // Validate price is not zero (currentPrice is a bigint)
        if (currentPrice === 0n) {
            throw new Error("Price feed returned zero price - check if price feed is properly configured");
        }
        
        // Convert bigint to number for display (price is in wei units, 1e18 = 1 USD)
        const priceInUSD = Number(currentPrice) / Number(ethers.parseEther("1"));
        console.log(`Current rBTC price: $${priceInUSD.toFixed(2)}`);
        console.log(`Current rBTC price (raw): ${currentPrice.toString()}`);
        
        // Check borrowing rate to understand fees
        const borrowingRate = await troveManager.getBorrowingRate();
        const borrowingRatePercent = Number(borrowingRate) / Number(ethers.parseEther("1")) * 100;
        console.log(`Current borrowing rate: ${borrowingRatePercent.toFixed(4)}%`);
        
        // Use the current price for calculations, but we'll get a fresh price for redemption

        // Step 2: Calculate required collateral
        // We need to account for:
        // - MCR (110%) minimum collateralization ratio
        // - Borrowing fees
        // - Gas compensation
        // For 100,000 ZUSD at 110% MCR, we need collateral worth at least 110,000 USD
        // At 90,000 USD per rBTC, that's approximately 1.222 rBTC
        // Adding buffer for fees, let's use 1.5 rBTC
        const collateralAmount = ethers.parseEther("1.5");
        console.log(`Using collateral: ${ethers.formatEther(collateralAmount)} rBTC`);
        
        // Get initial rBTC balance before opening trove
        const deployerRBTCBalanceBefore = await ethers.provider.getBalance(deployerSigner.address);
        console.log(`\n=== Line of Credit Setup ===`);
        console.log(`Deployer rBTC balance before opening trove: ${ethers.formatEther(deployerRBTCBalanceBefore)} rBTC`);

        // Step 3: Calculate the expected debt and ICR for hint calculation
        // We'll request 100,000 ZUSD, but the actual debt will be higher due to fees
        // For hint calculation, we need to estimate the composite debt
        // Let's use a conservative estimate: assume 1% borrowing fee
        const estimatedBorrowingFee = ZUSD_AMOUNT * BigInt(100) / BigInt(10000); // 1% estimate
        const estimatedNetDebt = ZUSD_AMOUNT + estimatedBorrowingFee;
        const ZUSD_GAS_COMPENSATION = ethers.parseEther("200"); // Standard gas compensation
        const estimatedCompositeDebt = estimatedNetDebt + ZUSD_GAS_COMPENSATION;

        // Calculate Nominal ICR (NICR) = (collateral * 1e20) / compositeDebt
        const NICR = (collateralAmount * BigInt(1e20)) / estimatedCompositeDebt;
        console.log(`Estimated NICR: ${NICR.toString()}`);

        // Step 4: Get hints for opening the trove
        const numTroves = await sortedTroves.getSize();
        const numTrials = numTroves > 0n ? numTroves * 15n : 15n;
        
        const approxHint = await hintHelpers.getApproxHint(NICR, numTrials, 42);
        const [upperHint, lowerHint] = await sortedTroves.findInsertPosition(
            NICR,
            approxHint.hintAddress,
            approxHint.hintAddress
        );

        console.log(`Opening trove with hints: upper=${upperHint}, lower=${lowerHint}`);

        // Step 5: Open the trove (line of credit)
        // Use 100% max fee to avoid "Fee exceeded provided maximum" error
        // The actual fee will be much lower, but this ensures we don't hit the limit
        const maxFeePercentage = ethers.parseEther("1"); // 100% max fee (1e18 = 100%)
        console.log(`Using max fee percentage: 100% (to avoid fee slippage issues)`);
        
        const openTroveTx = await borrowerOperations.connect(deployerSigner).openTrove(
            maxFeePercentage,
            ZUSD_AMOUNT,
            upperHint,
            lowerHint,
            { value: collateralAmount }
        );
        console.log("Waiting for openTrove transaction to be mined...");
        const openTroveReceipt = await openTroveTx.wait();
        console.log("Trove opened successfully");

        if (!openTroveReceipt) {
            throw new Error("openTrove transaction failed - no receipt");
        }

        // Step 6: Check balances after opening trove
        const deployerRBTCBalanceAfter = await ethers.provider.getBalance(deployerSigner.address);
        const zusdBalance = await zusdToken.balanceOf(deployerSigner.address);
        
        // Calculate gas cost for opening trove
        const openTroveGasCost = openTroveReceipt.gasUsed * openTroveReceipt.gasPrice;
        const rBTCUsedForCollateral = collateralAmount;
        const rBTCUsedForGas = openTroveGasCost;
        const totalRBTCSpent = rBTCUsedForCollateral + rBTCUsedForGas;
        
        console.log(`Deployer rBTC balance after opening trove: ${ethers.formatEther(deployerRBTCBalanceAfter)} rBTC`);
        console.log(`rBTC used as collateral: ${ethers.formatEther(rBTCUsedForCollateral)} rBTC`);
        console.log(`rBTC used for gas: ${ethers.formatEther(rBTCUsedForGas)} rBTC`);
        console.log(`Total rBTC spent: ${ethers.formatEther(totalRBTCSpent)} rBTC`);
        console.log(`ZUSD balance after opening trove: ${ethers.formatEther(zusdBalance)} ZUSD`);

        // Step 7: Transfer ZUSD to redeemer account
        const transferTx = await zusdToken.connect(deployerSigner).transfer(
            redeemerAccount.address,
            zusdBalance
        );
        console.log("Waiting for transfer transaction to be mined...");
        await transferTx.wait();
        console.log(`Transferred ${ethers.formatEther(zusdBalance)} ZUSD to redeemer account`);

        // Verify transfer
        const redeemerZUSDBalance = await zusdToken.balanceOf(redeemerAccount.address);
        expect(redeemerZUSDBalance).to.equal(zusdBalance);
        console.log(`Redeemer ZUSD balance: ${ethers.formatEther(redeemerZUSDBalance)} ZUSD`);

        // Step 8: Get redemption hints
        const redemptionPrice = await priceFeed.fetchPrice.staticCall();
        console.log(`Redemption price: ${redemptionPrice.toString()}`);

        // Get redemption hints - all parameters are already bigint
        const redemptionHints = await hintHelpers.getRedemptionHints(
            redeemerZUSDBalance, // already bigint
            redemptionPrice,     // already bigint from fetchPrice
            0n                    // maxIterations = 0 means unlimited
        );

        // Handle return values (ethers v6 returns array for tuples)
        const [firstRedemptionHint, partialRedemptionHintNICR, truncatedZUSDamount] = redemptionHints;

        console.log(`First redemption hint: ${firstRedemptionHint}`);
        console.log(`Partial redemption hint NICR: ${partialRedemptionHintNICR.toString()}`);
        console.log(`Truncated ZUSD amount: ${ethers.formatEther(truncatedZUSDamount)} ZUSD`);

        // If truncated amount is 0, redemption is not possible
        if (truncatedZUSDamount === 0n) {
            throw new Error("Redemption not possible: truncated amount is 0");
        }

        // Step 9: Get approximate hint for partial redemption
        const partialApproxHint = await hintHelpers.getApproxHint(
            partialRedemptionHintNICR,
            numTrials,
            42
        );

        // Handle return values for getApproxHint (returns tuple: hintAddress, diff, latestRandomSeed)
        const [approxHintAddress] = partialApproxHint;

        // Step 10: Get exact hints for partial redemption
        const [upperPartialHint, lowerPartialHint] = await sortedTroves.findInsertPosition(
            partialRedemptionHintNICR,
            approxHintAddress,
            approxHintAddress
        );

        console.log(`Partial redemption hints: upper=${upperPartialHint}, lower=${lowerPartialHint}`);

        // Step 11: Get redeemer's rBTC balance before redemption
        const redeemerRBTCBalanceBefore = await ethers.provider.getBalance(redeemerAccount.address);
        console.log(`Redeemer rBTC balance before: ${ethers.formatEther(redeemerRBTCBalanceBefore)} rBTC`);

        // Step 12: Perform redemption
        // Use 100% max fee to avoid "Fee exceeded provided maximum" error
        const maxRedemptionFee = ethers.parseEther("1"); // 100% max fee (1e18 = 100%)
        console.log(`Using max redemption fee: 100% (to avoid fee slippage issues)`);
        
        console.log("Initiating redemption transaction (this may take a while due to trove iterations)...");
        const redeemTx = await troveManager.connect(redeemerAccount).redeemCollateral(
            truncatedZUSDamount,
            firstRedemptionHint,
            upperPartialHint,
            lowerPartialHint,
            partialRedemptionHintNICR,
            0, // maxIterations = 0 means unlimited
            maxRedemptionFee
        );
        console.log("Redemption transaction sent, waiting for confirmation...");
        const redeemReceipt = await redeemTx.wait();
        console.log("Redemption transaction completed");

        if (!redeemReceipt) {
            throw new Error("Redemption transaction failed - no receipt");
        }

        // Step 13: Parse Redemption event and related events from transaction receipt
        console.log("\n=== Parsing Redemption Events ===");
        const troveManagerInterface = troveManager.interface;
        let redemptionEventParsed: { name: string; args: readonly unknown[] } | null = null;
        let baseRateUpdatedEventParsed: { name: string; args: readonly unknown[] } | null = null;
        
        // Parse all logs to find relevant events
        for (const log of redeemReceipt.logs) {
            try {
                const parsedLog = troveManagerInterface.parseLog({
                    topics: log.topics as string[],
                    data: log.data
                });
                
                if (parsedLog) {
                    if (parsedLog.name === "Redemption") {
                        redemptionEventParsed = parsedLog;
                    } else if (parsedLog.name === "BaseRateUpdated") {
                        baseRateUpdatedEventParsed = parsedLog;
                    }
                }
            } catch (error) {
                // Not a TroveManager event, continue
                continue;
            }
        }

        if (!redemptionEventParsed) {
            throw new Error("Redemption event not found in transaction logs");
        }

        // Extract Redemption event parameters
        const attemptedZUSDAmount = redemptionEventParsed.args[0] as bigint;
        const actualZUSDAmount = redemptionEventParsed.args[1] as bigint;
        const totalETHDrawn = redemptionEventParsed.args[2] as bigint; // Total rBTC drawn from system
        const ETHFee = redemptionEventParsed.args[3] as bigint; // Redemption fee in rBTC

        console.log("Redemption event parsed successfully:");
        console.log(`  Attempted ZUSD amount: ${ethers.formatEther(attemptedZUSDAmount)} ZUSD`);
        console.log(`  Actual ZUSD amount redeemed: ${ethers.formatEther(actualZUSDAmount)} ZUSD`);
        console.log(`  Total rBTC drawn from system: ${ethers.formatEther(totalETHDrawn)} rBTC`);
        console.log(`  Redemption fee (rBTC): ${ethers.formatEther(ETHFee)} rBTC`);

        // Extract BaseRateUpdated event if available
        if (baseRateUpdatedEventParsed) {
            const newBaseRate = baseRateUpdatedEventParsed.args[0] as bigint;
            const baseRatePercent = (Number(newBaseRate) / Number(ethers.parseEther("1"))) * 100;
            console.log(`\nBaseRateUpdated event parsed:`);
            console.log(`  New base rate: ${baseRatePercent.toFixed(6)}%`);
            console.log(`  (Base rate is used in redemption fee calculation)`);
        }

        // Calculate rBTC sent to redeemer (total drawn minus fee)
        const ETHToSendToRedeemer = totalETHDrawn - ETHFee;
        console.log(`\nFee Breakdown:`);
        console.log(`  rBTC sent to redeemer: ${ethers.formatEther(ETHToSendToRedeemer)} rBTC`);

        // Calculate redemption fee percentage
        const redemptionFeePercentage = (Number(ETHFee) / Number(totalETHDrawn)) * 100;
        console.log(`  Redemption fee percentage: ${redemptionFeePercentage.toFixed(4)}%`);

        // Step 14: Check final balances
        const redeemerZUSDBalanceAfter = await zusdToken.balanceOf(redeemerAccount.address);
        const redeemerRBTCBalanceAfter = await ethers.provider.getBalance(redeemerAccount.address);

        console.log("\n=== Balance Changes ===");
        console.log(`Redeemer ZUSD balance before: ${ethers.formatEther(redeemerZUSDBalance)} ZUSD`);
        console.log(`Redeemer ZUSD balance after: ${ethers.formatEther(redeemerZUSDBalanceAfter)} ZUSD`);
        console.log(`ZUSD burned: ${ethers.formatEther(redeemerZUSDBalance - redeemerZUSDBalanceAfter)} ZUSD`);
        console.log(`Redeemer rBTC balance before: ${ethers.formatEther(redeemerRBTCBalanceBefore)} rBTC`);
        console.log(`Redeemer rBTC balance after: ${ethers.formatEther(redeemerRBTCBalanceAfter)} rBTC`);

        // Calculate rBTC received (accounting for gas)
        const gasUsed = redeemReceipt.gasUsed * redeemReceipt.gasPrice;
        const rBTCReceived = redeemerRBTCBalanceAfter - redeemerRBTCBalanceBefore + gasUsed;
        console.log(`rBTC received from redemption (net, after gas): ${ethers.formatEther(rBTCReceived)} rBTC`);
        console.log(`Gas used (rBTC): ${ethers.formatEther(gasUsed)} rBTC`);

        // Verify ZUSD was burned
        expect(redeemerZUSDBalanceAfter).to.be.lt(redeemerZUSDBalance);
        
        // Verify rBTC was received
        expect(redeemerRBTCBalanceAfter).to.be.gt(redeemerRBTCBalanceBefore);

        // Verify event data matches actual balances
        expect(actualZUSDAmount).to.equal(redeemerZUSDBalance - redeemerZUSDBalanceAfter,
            "Actual ZUSD redeemed should match balance difference");
        
        // Allow small tolerance for gas costs when comparing rBTC received
        const tolerance = ethers.parseEther("0.0001"); // 0.0001 rBTC tolerance
        expect(rBTCReceived).to.be.closeTo(ETHToSendToRedeemer, tolerance,
            "rBTC received should match ETHToSendToRedeemer from event (accounting for gas)");

        console.log("\n=== Redemption Test Summary ===");
        console.log(`ZUSD attempted to redeem: ${ethers.formatEther(attemptedZUSDAmount)} ZUSD`);
        console.log(`ZUSD actually redeemed: ${ethers.formatEther(actualZUSDAmount)} ZUSD`);
        console.log(`Total rBTC drawn from system: ${ethers.formatEther(totalETHDrawn)} rBTC`);
        console.log(`Redemption fee paid (rBTC): ${ethers.formatEther(ETHFee)} rBTC`);
        console.log(`rBTC sent to redeemer: ${ethers.formatEther(ETHToSendToRedeemer)} rBTC`);
        console.log(`Redemption fee percentage: ${redemptionFeePercentage.toFixed(4)}%`);
        console.log(`Gas cost (rBTC): ${ethers.formatEther(gasUsed)} rBTC`);
        console.log(`Net rBTC received (after gas): ${ethers.formatEther(rBTCReceived)} rBTC`);
        
        if (actualZUSDAmount > 0n && rBTCReceived > 0n) {
            // Calculate effective exchange rate: how many ZUSD per rBTC
            const effectiveExchangeRate = (actualZUSDAmount * ethers.parseEther("1")) / rBTCReceived;
            console.log(`Effective exchange rate: ${ethers.formatEther(effectiveExchangeRate)} ZUSD per rBTC`);
            
            // Also show the inverse: rBTC per ZUSD
            const rBTCPerZUSD = (rBTCReceived * ethers.parseEther("1")) / actualZUSDAmount;
            console.log(`Effective exchange rate (inverse): ${ethers.formatEther(rBTCPerZUSD)} rBTC per ZUSD`);
        }
    });
});

