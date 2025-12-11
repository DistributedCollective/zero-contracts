// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "../Dependencies/Mynt/MyntLib.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "./TroveManagerBase.sol";
import "../Interfaces/IPermit2.sol";

/// This contract is designed to be used via delegatecall from the TroveManager contract
/// TroveManagerBase constructor param is bootsrap period when redemptions are not allowed
contract TroveManagerRedeemOps is TroveManagerBase {
    /** CONSTANT / IMMUTABLE VARIABLE ONLY */
    IPermit2 public immutable permit2;

    /** Send _ZUSDamount ZUSD to the system and redeem the corresponding amount of collateral from as many Troves as are needed to fill the redemption
      request.  Applies pending rewards to a Trove before reducing its debt and coll.
     
      Note that if _amount is very large, this function can run out of gas, specially if traversed troves are small. This can be easily avoided by
      splitting the total _amount in appropriate chunks and calling the function multiple times.
     
      Param `_maxIterations` can also be provided, so the loop through Troves is capped (if it’s zero, it will be ignored).This makes it easier to
      avoid OOG for the frontend, as only knowing approximately the average cost of an iteration is enough, without needing to know the “topology”
      of the trove list. It also avoids the need to set the cap in stone in the contract, nor doing gas calculations, as both gas price and opcode
      costs can vary.
     
      All Troves that are redeemed from -- with the likely exception of the last one -- will end up with no debt left, therefore they will be closed.
      If the last Trove does have some remaining debt, it has a finite ICR, and the reinsertion could be anywhere in the list, therefore it requires a hint.
      A frontend should use getRedemptionHints() to calculate what the ICR of this Trove will be after redemption, and pass a hint for its position
      in the sortedTroves list along with the ICR value that the hint was found for.
     
      If another transaction modifies the list between calling getRedemptionHints() and passing the hints to redeemCollateral(), it
      is very likely that the last (partially) redeemed Trove would end up with a different ICR than what the hint is for. In this case the
      redemption will stop after the last completely redeemed Trove and the sender will keep the remaining ZUSD amount, which they can attempt
      to redeem later.
     */

    /** Constructor */
    constructor(uint256 _bootstrapPeriod, address _permit2) public TroveManagerBase(_bootstrapPeriod) {
        permit2 = IPermit2(_permit2);
    }

    function redeemCollateral(
        uint256 _ZUSDamount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint256 _partialRedemptionHintNICR,
        uint256 _maxIterations,
        uint256 _maxFeePercentage
    ) external {
        _redeemCollateral(
            _ZUSDamount,
            _firstRedemptionHint,
            _upperPartialRedemptionHint,
            _lowerPartialRedemptionHint,
            _partialRedemptionHintNICR,
            _maxIterations,
            _maxFeePercentage
        );
    }

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

        // --- Use RedemptionBuffer first, before touching troves ---
        uint256 ethFromBuffer;
        (totals.remainingZUSD, ethFromBuffer) = _redeemFromBuffer(
            contractsCache,
            _ZUSDamount,
            totals.price,
            msg.sender
        );

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

        // Loop through the Troves starting from the one with lowest collateral ratio until _amount of ZUSD is exchanged for collateral
        if (_maxIterations == 0) {
            _maxIterations = uint256(-1);
        }
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

            if (singleRedemption.cancelledPartial) break; // Partial redemption was cancelled

            totals.totalZUSDToRedeem = totals.totalZUSDToRedeem.add(singleRedemption.ZUSDLot);
            totals.totalETHDrawn = totals.totalETHDrawn.add(singleRedemption.ETHLot);

            totals.remainingZUSD = totals.remainingZUSD.sub(singleRedemption.ZUSDLot);
            currentBorrower = nextUserToCheck;
        }

        // total ETH redeemed = from buffer + from troves
        uint256 totalETHDrawnInclBuffer = totals.totalETHDrawn.add(ethFromBuffer);

        // Require that *some* redemption actually happened (buffer or troves)
        require(totalETHDrawnInclBuffer > 0, "TroveManager: Unable to redeem any amount");

        // Decay the baseRate and then increase it according to the size of this redemption.
        // Use the saved total ZUSD supply value, from before it was reduced by the redemption.
        _updateBaseRateFromRedemption(
            totalETHDrawnInclBuffer,
            totals.price,
            totals.totalZUSDSupplyAtStart
        );

        // Calculate the ETH fee - only on trove-sourced ETH (buffer part can be fee-free)
        totals.ETHFee = _getRedemptionFee(totals.totalETHDrawn);

        // User cares about total ETH they receive vs fee
        _requireUserAcceptsFee(totals.ETHFee, totalETHDrawnInclBuffer, _maxFeePercentage);

        // Send the ETH fee to the feeDistributorContract address
        if (totals.ETHFee > 0) {
            contractsCache.activePool.sendETH(address(feeDistributor), totals.ETHFee);
            feeDistributor.distributeFees();
        }

        // ETH from ActivePool (troves) that goes to redeemer, after fee
        totals.ETHToSendToRedeemer = totals.totalETHDrawn.sub(totals.ETHFee);

        // Total ZUSD cancelled (buffer + troves) = initial requested - remaining
        uint256 totalZUSDCancelled = _ZUSDamount.sub(totals.remainingZUSD);

        emit Redemption(
            _ZUSDamount,
            totalZUSDCancelled,
            totalETHDrawnInclBuffer,
            totals.ETHFee
        );

        // Burn the ZUSD that is cancelled with trove debt, and send the *trove* ETH to msg.sender
        if (totals.totalZUSDToRedeem > 0) {
            contractsCache.zusdToken.burn(msg.sender, totals.totalZUSDToRedeem);
            contractsCache.activePool.decreaseZUSDDebt(totals.totalZUSDToRedeem);
        }
        // ETH from ActivePool → redeemer (buffer ETH already sent earlier)
        if (totals.ETHToSendToRedeemer > 0) {
            contractsCache.activePool.sendETH(msg.sender, totals.ETHToSendToRedeemer);
        }
    }

    ///DLLR _owner can use Sovryn Mynt to convert DLLR to ZUSD, then use the Zero redemption mechanism to redeem ZUSD for RBTC, all in a single transaction
    function redeemCollateralViaDLLR(
        uint256 _dllrAmount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint256 _partialRedemptionHintNICR,
        uint256 _maxIterations,
        uint256 _maxFeePercentage,
        IMassetManager.PermitParams calldata _permitParams
    ) external {
        uint256 _zusdAmount = MyntLib.redeemZusdFromDllrWithPermit(
            IBorrowerOperations(borrowerOperationsAddress).getMassetManager(),
            _dllrAmount,
            address(_zusdToken),
            _permitParams
        );
        _redeemCollateral(
            _zusdAmount,
            _firstRedemptionHint,
            _upperPartialRedemptionHint,
            _lowerPartialRedemptionHint,
            _partialRedemptionHintNICR,
            _maxIterations,
            _maxFeePercentage
        );
    }

    ///DLLR _owner can use Sovryn Mynt to convert DLLR to ZUSD, then use the Zero redemption mechanism to redeem ZUSD for RBTC, all in a single transaction
    function redeemCollateralViaDllrWithPermit2(
        uint256 _dllrAmount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint256 _partialRedemptionHintNICR,
        uint256 _maxIterations,
        uint256 _maxFeePercentage,
        ISignatureTransfer.PermitTransferFrom memory _permit,
        bytes calldata _signature
    ) external {
        uint256 _zusdAmount = MyntLib.redeemZusdFromDllrWithPermit2(
            IBorrowerOperations(borrowerOperationsAddress).getMassetManager(),
            address(_zusdToken),
            _permit,
            permit2,
            _signature
        );

        _redeemCollateral(
            _zusdAmount,
            _firstRedemptionHint,
            _upperPartialRedemptionHint,
            _lowerPartialRedemptionHint,
            _partialRedemptionHintNICR,
            _maxIterations,
            _maxFeePercentage
        );
    }

    function _isValidFirstRedemptionHint(
        ISortedTroves _sortedTroves,
        address _firstRedemptionHint,
        uint256 _price
    ) internal view returns (bool) {
        if (
            _firstRedemptionHint == address(0) ||
            !_sortedTroves.contains(_firstRedemptionHint) ||
            _getCurrentICR(_firstRedemptionHint, _price) < liquityBaseParams.MCR()
        ) {
            return false;
        }

        address nextTrove = _sortedTroves.getNext(_firstRedemptionHint);
        return
            nextTrove == address(0) || _getCurrentICR(nextTrove, _price) < liquityBaseParams.MCR();
    }

    /**
     * @dev Try to satisfy part of a ZUSD redemption using the RedemptionBuffer.
     *      Burns ZUSD from the redeemer and decreases system ZUSD debt, while
     *      sending RBTC from the RedemptionBuffer to the redeemer.
     *
     * @param _contractsCache ActivePool + ZUSD token cache.
     * @param _ZUSDAmount     Total ZUSD the user requested to redeem.
     * @param _price          RBTC price (1e18 precision).
     * @param _redeemer       Address of the redeemer.
     *
     * @return remainingZUSD  ZUSD left to redeem via troves
     * @return ethFromBuffer  RBTC amount sent from buffer to redeemer
     */
    function _redeemFromBuffer(
        ContractsCache memory _contractsCache,
        uint256 _ZUSDAmount,
        uint256 _price,
        address _redeemer
    ) internal returns (uint256 remainingZUSD, uint256 ethFromBuffer) {
        remainingZUSD = _ZUSDAmount;

        // If buffer is not configured or amount is zero, do nothing
        if (address(redemptionBuffer) == address(0) || _ZUSDAmount == 0) {
            return (remainingZUSD, 0);
        }

        uint256 bufferBal = redemptionBuffer.getBalance();
        if (bufferBal == 0) {
            return (remainingZUSD, 0);
        }

        // RBTC needed if the *entire* ZUSD amount was redeemed from this buffer
        uint256 collNeededForFull = _ZUSDAmount.mul(DECIMAL_PRECISION).div(_price);

        uint256 collFromBuffer = collNeededForFull <= bufferBal
            ? collNeededForFull
            : bufferBal;

        // Corresponding ZUSD to burn, priced at the oracle price
        uint256 zusdToBurn = collFromBuffer.mul(_price).div(DECIMAL_PRECISION);
        if (zusdToBurn > remainingZUSD) {
            zusdToBurn = remainingZUSD;
        }

        if (zusdToBurn == 0) {
            return (remainingZUSD, 0);
        }

        // Burn ZUSD from redeemer and adjust system debt
        _contractsCache.activePool.decreaseZUSDDebt(zusdToBurn);
        _contractsCache.zusdToken.burn(_redeemer, zusdToBurn);

        // Send RBTC from buffer to redeemer
        redemptionBuffer.withdrawForRedemption(payable(_redeemer), collFromBuffer);

        remainingZUSD = remainingZUSD.sub(zusdToBurn);
        ethFromBuffer = collFromBuffer;
    }

    /// Redeem as much collateral as possible from _borrower's Trove in exchange for ZUSD up to _maxZUSDamount
    function _redeemCollateralFromTrove(
        ContractsCache memory _contractsCache,
        address _borrower,
        uint256 _maxZUSDamount,
        uint256 _price,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint256 _partialRedemptionHintNICR
    ) internal returns (SingleRedemptionValues memory singleRedemption) {
        // Determine the remaining amount (lot) to be redeemed, capped by the entire debt of the Trove minus the liquidation reserve
        singleRedemption.ZUSDLot = LiquityMath._min(
            _maxZUSDamount,
            Troves[_borrower].debt.sub(ZUSD_GAS_COMPENSATION)
        );

        // Get the ETHLot of equivalent value in USD
        singleRedemption.ETHLot = singleRedemption.ZUSDLot.mul(DECIMAL_PRECISION).div(_price);

        // Decrease the debt and collateral of the current Trove according to the ZUSD lot and corresponding ETH to send
        uint256 newDebt = (Troves[_borrower].debt).sub(singleRedemption.ZUSDLot);
        uint256 newColl = (Troves[_borrower].coll).sub(singleRedemption.ETHLot);

        if (newDebt == ZUSD_GAS_COMPENSATION) {
            // No debt left in the Trove (except for the liquidation reserve), therefore the trove gets closed
            _removeStake(_borrower);
            _closeTrove(_borrower, Status.closedByRedemption);
            _redeemCloseTrove(_contractsCache, _borrower, ZUSD_GAS_COMPENSATION, newColl);
            emit TroveUpdated(_borrower, 0, 0, 0, TroveManagerOperation.redeemCollateral);
        } else {
            uint256 newNICR = LiquityMath._computeNominalCR(newColl, newDebt);

            /*
             * If the provided hint is out of date, we bail since trying to reinsert without a good hint will almost
             * certainly result in running out of gas.
             *
             * If the resultant net debt of the partial is less than the minimum, net debt we bail.
             */
            if (newNICR != _partialRedemptionHintNICR || _getNetDebt(newDebt) < MIN_NET_DEBT) {
                singleRedemption.cancelledPartial = true;
                return singleRedemption;
            }

            _contractsCache.sortedTroves.reInsert(
                _borrower,
                newNICR,
                _upperPartialRedemptionHint,
                _lowerPartialRedemptionHint
            );

            Troves[_borrower].debt = newDebt;
            Troves[_borrower].coll = newColl;
            _updateStakeAndTotalStakes(_borrower);

            emit TroveUpdated(
                _borrower,
                newDebt,
                newColl,
                Troves[_borrower].stake,
                TroveManagerOperation.redeemCollateral
            );
        }

        return singleRedemption;
    }

    /**
      This function has two impacts on the baseRate state variable:
      1) decays the baseRate based on time passed since last redemption or ZUSD borrowing operation.
      then,
      2) increases the baseRate based on the amount redeemed, as a proportion of total supply
     */
    function _updateBaseRateFromRedemption(
        uint256 _ETHDrawn,
        uint256 _price,
        uint256 _totalZUSDSupply
    ) internal returns (uint256) {
        uint256 decayedBaseRate = _calcDecayedBaseRate();

        /* Convert the drawn ETH back to ZUSD at face value rate (1 ZUSD:1 USD), in order to get
         * the fraction of total supply that was redeemed at face value. */
        uint256 redeemedZUSDFraction = _ETHDrawn.mul(_price).div(_totalZUSDSupply);

        uint256 newBaseRate = decayedBaseRate.add(redeemedZUSDFraction.div(BETA));
        newBaseRate = LiquityMath._min(newBaseRate, DECIMAL_PRECISION); // cap baseRate at a maximum of 100%
        //assert(newBaseRate <= DECIMAL_PRECISION); // This is already enforced in the line above
        assert(newBaseRate > 0); // Base rate is always non-zero after redemption

        // Update the baseRate state variable
        baseRate = newBaseRate;
        emit BaseRateUpdated(newBaseRate);

        _updateLastFeeOpTime();

        return newBaseRate;
    }

    /**
      Called when a full redemption occurs, and closes the trove.
      The redeemer swaps (debt - liquidation reserve) ZUSD for (debt - liquidation reserve) worth of ETH, so the ZUSD liquidation reserve left corresponds to the remaining debt.
      In order to close the trove, the ZUSD liquidation reserve is burned, and the corresponding debt is removed from the active pool.
      The debt recorded on the trove's struct is zero'd elswhere, in _closeTrove.
      Any surplus ETH left in the trove, is sent to the Coll surplus pool, and can be later claimed by the borrower.
     */
    function _redeemCloseTrove(
        ContractsCache memory _contractsCache,
        address _borrower,
        uint256 _ZUSD,
        uint256 _ETH
    ) internal {
        _contractsCache.zusdToken.burn(gasPoolAddress, _ZUSD);
        // Update Active Pool ZUSD, and send ETH to account
        _contractsCache.activePool.decreaseZUSDDebt(_ZUSD);

        // send ETH from Active Pool to CollSurplus Pool
        _contractsCache.collSurplusPool.accountSurplus(_borrower, _ETH);
        _contractsCache.activePool.sendETH(address(_contractsCache.collSurplusPool), _ETH);
    }
}
