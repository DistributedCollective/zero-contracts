# Incomplete ICR Check in `redeemCollateral()`  

Submitted by @AhmedFarid (Whitehat) for Mynt and Zero  

## Brief/Intro  

The `redeemCollateral()` function in TroveManager.sol is intended to only redeem collateral from troves whose Individual Collateral Ratio (ICR) is greater than or equal to the Minimum Collateral Ratio (MCR). However, after the initial ICR check for the first trove, subsequent troves in the redemption loop are not checked for ICR >= MCR. This allows troves with ICR below MCR to be redeemed, which should instead be subject to liquidation.  

## Vulnerability Details  

Within the redeemCollateral() function, the code ensures that the first trove selected for redemption has ICR >= MCR. This is done either by validating the provided hint or by traversing the sorted troves list until a suitable trove is found:  

```javascript
function _redeemCollateral(
        uint256 _ZUSDamount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint256 _partialRedemptionHintNICR,
        uint256 _maxIterations,
        uint256 _maxFeePercentage
    ) internal {
        ContractsCache memory contractsCache = ContractsCache(
            activePool,
            defaultPool,
            _zusdToken,
            _zeroStaking,
            sortedTroves,
            collSurplusPool,
            gasPoolAddress
        );
        RedemptionTotals memory totals;

        _requireValidMaxFeePercentage(_maxFeePercentage);
        _requireAfterBootstrapPeriod();
        totals.price = priceFeed.fetchPrice();
        _requireTCRoverMCR(totals.price);
        _requireAmountGreaterThanZero(_ZUSDamount);
        _requireZUSDBalanceCoversRedemption(contractsCache.zusdToken, msg.sender, _ZUSDamount);

        totals.totalZUSDSupplyAtStart = getEntireSystemDebt();
        // Confirm redeemer's balance is less than total ZUSD supply
        assert(contractsCache.zusdToken.balanceOf(msg.sender) <= totals.totalZUSDSupplyAtStart);

        totals.remainingZUSD = _ZUSDamount;
        address currentBorrower;

        if (
            _isValidFirstRedemptionHint(
                contractsCache.sortedTroves,
                _firstRedemptionHint,
                totals.price
            )
        ) {
            currentBorrower = _firstRedemptionHint;
        } else {
            currentBorrower = contractsCache.sortedTroves.getLast();
            // Find the first trove with ICR >= MCR
            while (
                currentBorrower != address(0) &&
                _getCurrentICR(currentBorrower, totals.price) < liquityBaseParams.MCR()
            ) {
                currentBorrower = contractsCache.sortedTroves.getPrev(currentBorrower);
            }
        }
    }
```  

However, inside the main redemption loop, the next trove to check (nextUserToCheck) is simply set to the previous trove in the list, without verifying its ICR:  

```javascript
while (currentBorrower != address(0) && totals.remainingZUSD > 0 && _maxIterations > 0) {
            _maxIterations--;
            // Save the address of the Trove preceding the current one, before potentially modifying the list
            address nextUserToCheck = contractsCache.sortedTroves.getPrev(currentBorrower);

            _applyPendingRewards(
                contractsCache.activePool,
                contractsCache.defaultPool,
                currentBorrower
            );

            SingleRedemptionValues memory singleRedemption = _redeemCollateralFromTrove(
                contractsCache,
                currentBorrower,
                totals.remainingZUSD,
                totals.price,
                _upperPartialRedemptionHint,
                _lowerPartialRedemptionHint,
                _partialRedemptionHintNICR
            );

            if (singleRedemption.cancelledPartial) break; // Partial redemption was cancelled (out-of-date hint, or new net debt < minimum), therefore we could not redeem from the last Trove

            totals.totalZUSDToRedeem = totals.totalZUSDToRedeem.add(singleRedemption.ZUSDLot);
            totals.totalETHDrawn = totals.totalETHDrawn.add(singleRedemption.ETHLot);

            totals.remainingZUSD = totals.remainingZUSD.sub(singleRedemption.ZUSDLot);
            currentBorrower = nextUserToCheck;
        }
```  

This means that after the first iteration, the function may redeem collateral from troves whose ICR is below MCR, violating the intended protocol logic.  

## Impact Details  

* Troves with ICR < MCR are supposed to be liquidated, not redeemed. Allowing their collateral to be redeemed can result in under-collateralized positions being handled incorrectly.
* This could allow users to bypass liquidation penalties and redeem from unhealthy troves, potentially leading to losses for the protocol or unfair outcomes for other participants.

## Proof of Concept  

Use this file to run the test:  
<https://github.com/DistributedCollective/zero-contracts/blob/main/tests/js/TroveManagerTest.js>  

```javascript
it("POC", async () => {

      const { netDebt: A_debt } = await openTrove({ ICR: toBN(dec(13, 18)), extraParams: { from: alice } })
      const { thusdAmount: B_thusdAmount, totalDebt: B_totalDebt } = await openTrove({ ICR: toBN(dec(133, 16)), extraTHUSDAmount: A_debt, extraParams: { from: bob } })

      await thusdToken.transfer(carol, B_thusdAmount, { from: bob })

 

      await priceFeed.setPrice(dec(100, 18));
      const price = await priceFeed.getPrice()

      const bob_ICR = await troveManager.getCurrentICR(bob, price)
      assert.isTrue(bob_ICR.lte(mv._MCR))

      // Get redemption hints
      const { firstRedemptionHint, partialRedemptionHintNICR } =
        await contracts.hintHelpers.getRedemptionHints(
          A_debt,
          price,
          0,
        )

      const { 0: upperPartialRedemptionHint, 1: lowerPartialRedemptionHint } =
        await sortedTroves.findInsertPosition(
          partialRedemptionHintNICR,
          alice,
          bob,
        )

      await troveManager.redeemCollateral(
         A_debt,
         firstRedemptionHint,
         upperPartialRedemptionHint,
         lowerPartialRedemptionHint,
         partialRedemptionHintNICR,
         0, th._100pct,
         {
            from: carol,
            gasPrice: 0
         }
      )
    })
```  

## References  

<https://github.com/DistributedCollective/zero-contracts/blob/7816082d7f8e62090b714695f6181ff8937e68d5/contracts/Dependencies/TroveManagerRedeemOps.sol#L64>  


# EVALUATION OF THE REPORT  

The conclusion is that this is another careless IA-generated report.  

It assumes that `SortedTroves` storages orders troves from lower to higher NICR, which was one of the initiatives in liquity; but Zero in Sovryn orders them from the highest to the lowest NICR. So, for the 1st check, if ICR > MCR, we can be sure that the next troves to be redeemed will have higher ICRs and it is not possible to redeem unhealthy troves; so no need to check again if ICR is or not greater than MCR.
So the bug report can be closed.  

Proof using just hh console and the terminal:

```bash
ubuntu@ip-10-0-12-30:~/SOVRYN/ZCONTRACTS$ hh console --network rskSovrynMainnet

Compiled 147 Solidity files successfully
Welcome to Node.js v16.20.2.
Type ".help" for more information.
> const sortedTroves = await ethers.getContract("SortedTroves");
undefined
> sortedTroves.target
'0xdeEB95480B94f9395514Fe35CAF692A1C788DfE9'
> const lastTrove = await sortedTroves.getLast();
undefined
> lastTrove
'0x5AC8460294770D3AB50bD8947D86C2b7A5F1A9c3'
> const troveManager = await ethers.getContract("TroveManager");
undefined
> troveManager.target
'0x82B09695ee4F214f3A0803683C4AaEc332E4E0a3'
> const firstTrove = await sortedTroves.getFirst();
undefined
> firstTrove
'0xa9705aF5c5874ECb49Ff2488FB36D350cc1763c7'
> const pricefeed = await ethers.getContract("PriceFeed");
undefined
> pricefeed.target
'0x6D1d9574d67e04cf35Fa1d916F763eDDae03b75d'
> const lastPrice = await pricefeed.lastGoodPrice();
undefined
> lastPrice.toString()
'109760000000000000000000'
> const icr_first = await troveManager.getCurrentICR(firstTrove,lastPrice);
undefined
> icr_first.toString()
'167877390106105079899'
> const icr_last = await troveManager.getCurrentICR(lastTrove,lastPrice);
undefined
> icr_last.toString()
'1260226776579498861'
>  
```