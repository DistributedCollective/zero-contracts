// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "../Dependencies/Mynt/MyntLib.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "./TroveManagerBase.sol";
import "../Interfaces/IPermit2.sol";

/// @notice Redemption operations module for TroveManager, intended to be executed via delegatecall.
/// @dev
///  - This contract is designed to be used via delegatecall from the TroveManager contract.
///    That means `address(this)` will be the TroveManager at runtime (important for allowance checks, etc).
///  - TroveManagerBase constructor param is the bootstrap period when redemptions are not allowed.
contract TroveManagerRedeemOps is TroveManagerBase {
    /** CONSTANT / IMMUTABLE VARIABLE ONLY */
    /// @notice Permit2 contract reference used by DLLR->ZUSD redemption path.
    IPermit2 public immutable permit2;

    // ---------------------------------------------------------------------
    // Stack-too-deep mitigation
    // ---------------------------------------------------------------------
    // Pack redemption hints/limits into one struct to reduce stack usage (Solidity 0.6.x stack-too-deep).
    // NOTE: Packing in a struct changes *only* internal plumbing (fewer stack vars),
    //       not the external API or redemption semantics.
    struct RedeemParams {
        /// @dev Hint for the first trove to start redeeming from (must be valid or ignored).
        address firstRedemptionHint;

        /// @dev Reinsert hints for the *last* (partially) redeemed trove, if any.
        ///      Only needed when we do a partial redemption that leaves the last trove with debt > gas compensation.
        address upperPartialRedemptionHint;
        address lowerPartialRedemptionHint;

        /// @dev The NICR the frontend calculated for the partially redeemed trove using getRedemptionHints().
        ///      If it no longer matches at execution time, we cancel the partial redemption to avoid OOG.
        uint256 partialRedemptionHintNICR;

        /// @dev Loop cap. If 0, treated as "no cap" (uint256(-1)).
        uint256 maxIterations;

        /// @dev Max fee percentage user is willing to accept for this redemption.
        uint256 maxFeePercentage;
    }

    /** Constructor */
    constructor(uint256 _bootstrapPeriod, address _permit2) public TroveManagerBase(_bootstrapPeriod) {
        permit2 = IPermit2(_permit2);
    }

    /**
      @notice
      Send `_ZUSDamount` ZUSD to the system and redeem the corresponding amount of collateral
      from as many Troves as are needed to fill the redemption request.

      @dev High level behavior (ORIGINAL semantics, now with an added "buffer-first" stage):
      -------------------------------------------------------------------------
      A) Apply pending rewards to a Trove before reducing its debt and collateral.
      B) Walk troves from the lowest collateral ratio upward (subject to MCR constraint),
         redeeming until the requested ZUSD amount is exhausted or we hit a stop condition.
      C) Most troves redeemed-from will end up closed (debt -> liquidation reserve only).
      D) The last trove may be partially redeemed; reinsertion requires correct sorted list hints.

      Gas & iteration notes (from original implementation):
      -------------------------------------------------------------------------
      - If `_ZUSDamount` is very large, this function can run out of gas, especially if traversed troves are small.
        This can be avoided by splitting the total amount into appropriate chunks and calling multiple times.
      - Param `_maxIterations` can cap the trove loop (if it’s zero, it will be ignored). This helps frontends
        avoid OOG without knowing the exact “topology” of the trove list, and avoids hard-coding a cap in the contract.

      Partial redemption / hint correctness (from original implementation):
      -------------------------------------------------------------------------
      - If the last trove does have some remaining debt, it has a finite ICR; reinsertion could be anywhere,
        therefore it requires a hint.
      - A frontend should use getRedemptionHints() to calculate the ICR/NICR after redemption and pass a hint.
      - If another transaction modifies the list between getRedemptionHints() and this call, it is likely
        that the partially redeemed trove’s NICR changes. In that case the partial redemption is cancelled:
        redemption stops after the last completely redeemed trove, and the sender keeps the remaining ZUSD.

      NEW addition in this version: RedemptionBuffer "buffer-first" swap stage
      -------------------------------------------------------------------------
      - Before redeeming from troves, we attempt to swap ZUSD for RBTC directly from `redemptionBuffer`
        at the oracle price (1 ZUSD = 1 USD face value, and ETH/RBTC valued by `_price`).
      - This stage:
          * transfers ZUSD to FeeDistributor via transferFrom (so user must approve TroveManager)
          * does NOT burn ZUSD
          * does NOT decrease ActivePool ZUSD debt
          * later withdraws RBTC from RedemptionBuffer to the user (minus fee)
      - Any remainder (if the buffer is insufficient) is redeemed from troves in the traditional manner.
      - Fees/baseRate are applied consistently across BOTH sources.
     */
    function redeemCollateral(
        uint256 _ZUSDamount,
        address _firstRedemptionHint,
        address _upperPartialRedemptionHint,
        address _lowerPartialRedemptionHint,
        uint256 _partialRedemptionHintNICR,
        uint256 _maxIterations,
        uint256 _maxFeePercentage
    ) external {
        RedeemParams memory params = RedeemParams({
            firstRedemptionHint: _firstRedemptionHint,
            upperPartialRedemptionHint: _upperPartialRedemptionHint,
            lowerPartialRedemptionHint: _lowerPartialRedemptionHint,
            partialRedemptionHintNICR: _partialRedemptionHintNICR,
            maxIterations: _maxIterations,
            maxFeePercentage: _maxFeePercentage
        });

        _redeemCollateral(_ZUSDamount, params);
    }

    /**
     * @dev Internal redemption entrypoint.
     *
     * The redemption flow is now split into clearly delineated stages:
     *  1) Validate inputs, system state, bootstrap period, and balances
     *  2) Swap against RedemptionBuffer first (ZUSD -> RBTC) at oracle price
     *  3) Redeem remainder from troves (classic redemption)
     *  4) Update baseRate from total RBTC drawn (troves + buffer)
     *  5) Compute and enforce redemption fee (troves + buffer)
     *  6) Apply burns/debt changes ONLY for trove portion (buffer is a swap)
     *  7) Pay fees to FeeDistributor, distribute fees, and send net RBTC to redeemer
     */
    function _redeemCollateral(uint256 _ZUSDamount, RedeemParams memory _params) internal {
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

        // --- Requirements / guards (same intent as original) ---
        _requireValidMaxFeePercentage(_params.maxFeePercentage);
        _requireAfterBootstrapPeriod();

        // Fetch oracle price once and use consistently across buffer and trove stages.
        totals.price = priceFeed.fetchPrice();

        // Redemption is only valid if system is healthy enough (TCR over MCR).
        _requireTCRoverMCR(totals.price);

        _requireAmountGreaterThanZero(_ZUSDamount);
        _requireZUSDBalanceCoversRedemption(contractsCache.zusdToken, msg.sender, _ZUSDamount);

        // Capture the total system debt at the start for baseRate math.
        totals.totalZUSDSupplyAtStart = getEntireSystemDebt();

        // Confirm redeemer's balance is <= total ZUSD supply (sanity check; mirrors original intent).
        assert(contractsCache.zusdToken.balanceOf(msg.sender) <= totals.totalZUSDSupplyAtStart);

        // ------------------------------------------------------------
        // 1) Swap against RedemptionBuffer FIRST (ZUSD -> RBTC)
        //    - transfers ZUSD to FeeDistributor via transferFrom()
        //    - does NOT burn ZUSD
        //    - does NOT touch ActivePool debt
        //
        // Rationale:
        //  - If the buffer has RBTC liquidity, we can satisfy redemptions without
        //    walking troves (cheaper gas; less list traversal).
        //  - Remaining amount (if any) continues through classic trove redemption.
        // ------------------------------------------------------------
        uint256 ethFromBuffer;
        uint256 zusdSwappedToFeeDistributor;
        (totals.remainingZUSD, ethFromBuffer, zusdSwappedToFeeDistributor) = _swapFromBuffer(
            contractsCache,
            _ZUSDamount,
            totals.price,
            msg.sender
        );

        // ------------------------------------------------------------
        // 2) Redeem remaining from troves (normal redemption path)
        //
        // Note:
        //  - Only the trove portion affects: ZUSD burn, ActivePool debt decrease,
        //    trove closures/updates, reward application, etc.
        // ------------------------------------------------------------
        if (totals.remainingZUSD > 0) {
            _redeemFromTroves(contractsCache, totals, _params);
        }

        // Total RBTC drawn from both sources.
        uint256 totalETHDrawnInclBuffer = totals.totalETHDrawn.add(ethFromBuffer);

        // If we got nothing from buffer and nothing from troves, revert (matches original spirit).
        require(totalETHDrawnInclBuffer > 0, "TroveManager: Unable to redeem any amount");

        // ------------------------------------------------------------
        // 3) BaseRate update applies to buffer swaps too
        //
        // The baseRate is used for redemption fee calculation, and historically
        // it responds to redemption demand. Buffer swaps are economically
        // equivalent demand, so they are included in the baseRate update.
        // ------------------------------------------------------------
        _updateBaseRateFromRedemption(
            totalETHDrawnInclBuffer,
            totals.price,
            totals.totalZUSDSupplyAtStart
        );

        // ------------------------------------------------------------
        // 4) Redemption fee applies to BOTH sources (same formula)
        //
        // NOTE:
        //  - We compute fee independently on each RBTC amount and sum.
        //  - Rounding will be consistent with the existing _getRedemptionFee() logic.
        // ------------------------------------------------------------
        uint256 ethFeeFromTroves = _getRedemptionFee(totals.totalETHDrawn);
        uint256 ethFeeFromBuffer = _getRedemptionFee(ethFromBuffer);
        totals.ETHFee = ethFeeFromTroves.add(ethFeeFromBuffer);

        _requireUserAcceptsFee(totals.ETHFee, totalETHDrawnInclBuffer, _params.maxFeePercentage);

        // Total ZUSD "processed" by this redemption attempt (buffer swap + trove redemption).
        // If we stop early (partial cancellation or iteration cap), some ZUSD remains with the user.
        uint256 totalZUSDProcessed = _ZUSDamount.sub(totals.remainingZUSD);

        emit Redemption(_ZUSDamount, totalZUSDProcessed, totalETHDrawnInclBuffer, totals.ETHFee);

        // ------------------------------------------------------------
        // 5) Burn ONLY trove portion (buffer portion is a swap)
        //
        // Original behavior:
        //  - burn the redeemed ZUSD
        //  - decrease ActivePool debt by same amount
        //
        // New behavior:
        //  - trove path: unchanged
        //  - buffer path: does not burn and does not change ActivePool debt
        // ------------------------------------------------------------
        if (totals.totalZUSDToRedeem > 0) {
            contractsCache.zusdToken.burn(msg.sender, totals.totalZUSDToRedeem);
            contractsCache.activePool.decreaseZUSDDebt(totals.totalZUSDToRedeem);
        }

        // ------------------------------------------------------------
        // 6) Pay RBTC fees into FeeDistributor
        //    - trove fee from ActivePool
        //    - buffer fee directly from RedemptionBuffer
        //
        // This split reflects where the RBTC originated:
        //  - Trove redemption draws collateral from ActivePool.
        //  - Buffer swap draws collateral from RedemptionBuffer.
        // ------------------------------------------------------------
        if (ethFeeFromTroves > 0) {
            contractsCache.activePool.sendETH(address(feeDistributor), ethFeeFromTroves);
        }

        if (ethFeeFromBuffer > 0) {
            // IMPORTANT:
            //  - FeeDistributor.receive() (or fallback) must accept RBTC from RedemptionBuffer.
            //  - withdrawForRedemption is expected to transfer RBTC out of the buffer.
            redemptionBuffer.withdrawForRedemption(payable(address(feeDistributor)), ethFeeFromBuffer);
        }

        // Distribute any ZUSD swapped into FeeDistributor + any RBTC fees paid in.
        // (If nothing was sent, skip to save gas.)
        if (zusdSwappedToFeeDistributor > 0 || totals.ETHFee > 0) {
            feeDistributor.distributeFees();
        }

        // ------------------------------------------------------------
        // 7) Send net RBTC to redeemer from each source
        //
        // IMPORTANT:
        //  - Trove portion comes from ActivePool
        //  - Buffer portion comes from RedemptionBuffer
        //
        // Net = drawn - fee, per source.
        // ------------------------------------------------------------
        uint256 ethToSendFromTroves = totals.totalETHDrawn.sub(ethFeeFromTroves);
        if (ethToSendFromTroves > 0) {
            contractsCache.activePool.sendETH(msg.sender, ethToSendFromTroves);
        }

        uint256 ethToSendFromBuffer = ethFromBuffer.sub(ethFeeFromBuffer);
        if (ethToSendFromBuffer > 0) {
            redemptionBuffer.withdrawForRedemption(payable(msg.sender), ethToSendFromBuffer);
        }
    }

    // ---------------------------------------------------------------------
    // Trove loop helper
    // ---------------------------------------------------------------------

    /**
     * @dev Helper extracted from _redeemCollateral to reduce stack depth in Solidity 0.6.x.
     *
     * Core responsibilities (classic redemption logic):
     *  - Determine a valid starting trove:
     *      * if hint is valid -> start there
     *      * else scan from the tail for first trove with ICR >= MCR
     *  - Iterate through troves, applying pending rewards then redeeming from each
     *  - Stop if:
     *      * remainingZUSD becomes 0, or
     *      * we run out of troves, or
     *      * we hit maxIterations, or
     *      * partial redemption must be cancelled due to stale hints/min net debt
     */
    function _redeemFromTroves(
        ContractsCache memory _contractsCache,
        RedemptionTotals memory _totals,
        RedeemParams memory _params
    ) internal {
        address currentBorrower = address(0);

        // Use the provided first hint iff it is still valid at current price.
        if (_isValidFirstRedemptionHint(_contractsCache.sortedTroves, _params.firstRedemptionHint, _totals.price)) {
            currentBorrower = _params.firstRedemptionHint;
        } else {
            // Otherwise start from the last trove and find first with ICR >= MCR.
            currentBorrower = _contractsCache.sortedTroves.getLast();
            while (
                currentBorrower != address(0) &&
                _getCurrentICR(currentBorrower, _totals.price) < liquityBaseParams.MCR()
            ) {
                currentBorrower = _contractsCache.sortedTroves.getPrev(currentBorrower);
            }
        }

        // Loop through the Troves starting from the one with lowest collateral ratio (that is still >= MCR)
        // until the requested ZUSD is exchanged for collateral or we hit the iteration cap.
        uint256 maxIterations = _params.maxIterations;
        if (maxIterations == 0) {
            // 0 means "uncapped" to preserve original UX.
            maxIterations = uint256(-1);
        }

        while (currentBorrower != address(0) && _totals.remainingZUSD > 0 && maxIterations > 0) {
            maxIterations--;

            // Save the address of the Trove preceding the current one, before potentially modifying the list.
            address nextUserToCheck = _contractsCache.sortedTroves.getPrev(currentBorrower);

            // Apply any pending redistribution rewards (affects debt/coll, thus affects ICR/NICR).
            _applyPendingRewards(_contractsCache.activePool, _contractsCache.defaultPool, currentBorrower);

            // Redeem from this trove (full close or partial).
            SingleRedemptionValues memory singleRedemption = _redeemCollateralFromTrove(
                _contractsCache,
                currentBorrower,
                _totals.remainingZUSD,
                _totals.price,
                _params
            );

            // Partial redemption was cancelled (out-of-date hint, or new net debt < minimum),
            // therefore we could not redeem from the last Trove.
            // We STOP here to avoid a likely OOG reinsertion attempt.
            if (singleRedemption.cancelledPartial) break;

            _totals.totalZUSDToRedeem = _totals.totalZUSDToRedeem.add(singleRedemption.ZUSDLot);
            _totals.totalETHDrawn = _totals.totalETHDrawn.add(singleRedemption.ETHLot);

            _totals.remainingZUSD = _totals.remainingZUSD.sub(singleRedemption.ZUSDLot);
            currentBorrower = nextUserToCheck;
        }
    }

    // ---------------------------------------------------------------------
    // DLLR redemption helpers
    // ---------------------------------------------------------------------

    /// @notice
    /// DLLR owner can use Sovryn Mynt to convert DLLR to ZUSD, then use the redemption mechanism
    /// to redeem ZUSD for RBTC, all in a single transaction.
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
        // Convert DLLR -> ZUSD (with permit), then proceed with standard redemption using the obtained ZUSD.
        uint256 _zusdAmount = MyntLib.redeemZusdFromDllrWithPermit(
            IBorrowerOperations(borrowerOperationsAddress).getMassetManager(),
            _dllrAmount,
            address(_zusdToken),
            _permitParams
        );

        RedeemParams memory params = RedeemParams({
            firstRedemptionHint: _firstRedemptionHint,
            upperPartialRedemptionHint: _upperPartialRedemptionHint,
            lowerPartialRedemptionHint: _lowerPartialRedemptionHint,
            partialRedemptionHintNICR: _partialRedemptionHintNICR,
            maxIterations: _maxIterations,
            maxFeePercentage: _maxFeePercentage
        });

        _redeemCollateral(_zusdAmount, params);
    }

    /// @notice
    /// DLLR owner can use Sovryn Mynt to convert DLLR to ZUSD, then redeem ZUSD for RBTC, all in one tx.
    /// This variant uses Permit2 for token authorization.
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
        // Convert DLLR -> ZUSD using Permit2, then proceed with standard redemption.
        uint256 _zusdAmount = MyntLib.redeemZusdFromDllrWithPermit2(
            IBorrowerOperations(borrowerOperationsAddress).getMassetManager(),
            address(_zusdToken),
            _permit,
            permit2,
            _signature
        );

        RedeemParams memory params = RedeemParams({
            firstRedemptionHint: _firstRedemptionHint,
            upperPartialRedemptionHint: _upperPartialRedemptionHint,
            lowerPartialRedemptionHint: _lowerPartialRedemptionHint,
            partialRedemptionHintNICR: _partialRedemptionHintNICR,
            maxIterations: _maxIterations,
            maxFeePercentage: _maxFeePercentage
        });

        _redeemCollateral(_zusdAmount, params);
    }

    // ---------------------------------------------------------------------
    // Hint validation
    // ---------------------------------------------------------------------

    /**
     * @dev Returns true if `_firstRedemptionHint` is still a valid first redemption point at `_price`.
     *
     * Validity conditions:
     *  - hint is non-zero
     *  - hint exists in the sorted list
     *  - hinted trove has ICR >= MCR
     *  - the next trove (higher ICR) is either non-existent or has ICR < MCR
     *    (i.e., hint is "the first redeemable trove" when scanning from low ICR upwards)
     */
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
        return nextTrove == address(0) || _getCurrentICR(nextTrove, _price) < liquityBaseParams.MCR();
    }

    // ---------------------------------------------------------------------
    // RedemptionBuffer swap stage
    // ---------------------------------------------------------------------

    /**
     * @notice Swap ZUSD against RedemptionBuffer at oracle price (ZUSD -> RBTC).
     * @dev
     *  - Uses transferFrom(redeemer -> FeeDistributor) (so redeemer must approve TroveManager).
     *  - Does not burn ZUSD (unlike trove redemption).
     *  - Does not update ActivePool ZUSD debt (unlike trove redemption).
     *
     * Accounting model:
     *  - The buffer holds RBTC. We compute how much ZUSD that RBTC can cover at the current oracle price.
     *  - We take min(requestedZUSD, maxZUSDFromBuffer), transfer that ZUSD to FeeDistributor,
     *    and "reserve" the corresponding RBTC amount to withdraw later in _redeemCollateral().
     *
     * Delegatecall nuance:
     *  - This contract is executed via delegatecall, so `address(this)` is the TroveManager.
     *    Therefore, the allowance required is allowance(redeemer, TroveManager).
     *
     * Rounding note:
     *  - Conversion uses integer division. Dust due to rounding is expected and should be consistent
     *    with existing fee and redemption math across the system.
     */
    function _swapFromBuffer(
        ContractsCache memory _contractsCache,
        uint256 _ZUSDAmount,
        uint256 _price,
        address _redeemer
    ) internal returns (uint256 remainingZUSD, uint256 ethFromBuffer, uint256 zusdSwappedToFeeDistributor) {
        remainingZUSD = _ZUSDAmount;

        // If buffer is not configured or nothing requested, do nothing.
        if (address(redemptionBuffer) == address(0) || _ZUSDAmount == 0) {
            return (remainingZUSD, 0, 0);
        }

        // Read current RBTC balance in buffer. If empty, do nothing.
        uint256 bufferBal = redemptionBuffer.getBalance();
        if (bufferBal == 0) {
            return (remainingZUSD, 0, 0);
        }

        // Maximum ZUSD that the buffer can satisfy at current price:
        //   bufferBal (RBTC) * price (USD/RBTC) / 1e18 => USD value in "ZUSD terms"
        uint256 maxZusdFromBuffer = bufferBal.mul(_price).div(DECIMAL_PRECISION);

        // We can only swap up to the requested amount.
        zusdSwappedToFeeDistributor = LiquityMath._min(_ZUSDAmount, maxZusdFromBuffer);

        if (zusdSwappedToFeeDistributor == 0) {
            return (remainingZUSD, 0, 0);
        }

        // Corresponding RBTC amount to withdraw later:
        //   ZUSD * 1e18 / price
        ethFromBuffer = zusdSwappedToFeeDistributor.mul(DECIMAL_PRECISION).div(_price);

        // spender == TroveManager because this is delegatecall (address(this) is TroveManager)
        // Require explicit allowance to make the UX failure mode clear.
        require(
            _contractsCache.zusdToken.allowance(_redeemer, address(this)) >= zusdSwappedToFeeDistributor,
            "TroveManager: approve ZUSD allowance for buffer swap"
        );

        // Transfer the swapped ZUSD directly into FeeDistributor.
        // This ZUSD is not burned; it is intended for distribution via the fee mechanism.
        require(
            _contractsCache.zusdToken.transferFrom(_redeemer, address(feeDistributor), zusdSwappedToFeeDistributor),
            "TroveManager: ZUSD transferFrom failed"
        );

        // Remaining amount proceeds to trove redemption.
        remainingZUSD = remainingZUSD.sub(zusdSwappedToFeeDistributor);
    }

    // ---------------------------------------------------------------------
    // Original trove redemption logic (signature adjusted to use params struct)
    // ---------------------------------------------------------------------

    /// @dev Redeem as much collateral as possible from `_borrower`'s Trove in exchange for ZUSD up to `_maxZUSDamount`.
    function _redeemCollateralFromTrove(
        ContractsCache memory _contractsCache,
        address _borrower,
        uint256 _maxZUSDamount,
        uint256 _price,
        RedeemParams memory _params
    ) internal returns (SingleRedemptionValues memory singleRedemption) {
        // Determine the remaining amount (lot) to be redeemed, capped by:
        //   (entire trove debt - liquidation reserve)
        singleRedemption.ZUSDLot = LiquityMath._min(
            _maxZUSDamount,
            Troves[_borrower].debt.sub(ZUSD_GAS_COMPENSATION)
        );

        // Get the ETHLot of equivalent value in USD (1 ZUSD : 1 USD face value).
        singleRedemption.ETHLot = singleRedemption.ZUSDLot.mul(DECIMAL_PRECISION).div(_price);

        // Decrease the debt and collateral of the current Trove according to the ZUSD lot and corresponding ETH to send.
        uint256 newDebt = (Troves[_borrower].debt).sub(singleRedemption.ZUSDLot);
        uint256 newColl = (Troves[_borrower].coll).sub(singleRedemption.ETHLot);

        if (newDebt == ZUSD_GAS_COMPENSATION) {
            // No debt left in the Trove (except for the liquidation reserve), therefore the trove gets closed.
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
             * If the resultant net debt of the partial is less than the minimum net debt, we bail.
             *
             * This “cancel partial redemption” behavior is intentional and mirrors the original design:
             * it protects users from OOG and makes frontends responsible for providing fresh hints.
             */
            if (newNICR != _params.partialRedemptionHintNICR || _getNetDebt(newDebt) < MIN_NET_DEBT) {
                singleRedemption.cancelledPartial = true;
                return singleRedemption;
            }

            // Reinsert into the sorted list at the correct newNICR position using user-provided hints.
            _contractsCache.sortedTroves.reInsert(
                _borrower,
                newNICR,
                _params.upperPartialRedemptionHint,
                _params.lowerPartialRedemptionHint
            );

            // Persist updated trove state.
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
      @dev
      This function has two impacts on the baseRate state variable:
        1) decays the baseRate based on time passed since last redemption or ZUSD borrowing operation.
        then,
        2) increases the baseRate based on the amount redeemed, as a proportion of total supply.

      @param _ETHDrawn Total RBTC drawn by this redemption (in this version: may include buffer + troves).
      @param _price Oracle price used to convert RBTC value back to ZUSD face value.
      @param _totalZUSDSupply Total system debt captured at the start of redemption.
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

        // Base rate is always non-zero after redemption
        assert(newBaseRate > 0);

        // Update the baseRate state variable
        baseRate = newBaseRate;
        emit BaseRateUpdated(newBaseRate);

        _updateLastFeeOpTime();

        return newBaseRate;
    }

    /**
      @dev
      Called when a full redemption occurs, and closes the trove.

      The redeemer swaps (debt - liquidation reserve) ZUSD for (debt - liquidation reserve) worth of ETH,
      so the ZUSD liquidation reserve left corresponds to the remaining debt.

      In order to close the trove:
        - the ZUSD liquidation reserve is burned (from gasPool),
        - the corresponding debt is removed from the Active Pool,
        - the trove’s debt/coll struct is zero'd elsewhere (in _closeTrove),
        - any surplus ETH left in the trove is sent to the CollSurplusPool and can later be claimed by the borrower.
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

        // Send ETH from Active Pool to CollSurplus Pool (tracked for borrower to claim).
        _contractsCache.collSurplusPool.accountSurplus(_borrower, _ETH);
        _contractsCache.activePool.sendETH(address(_contractsCache.collSurplusPool), _ETH);
    }
}
