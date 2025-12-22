// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "../Dependencies/Mynt/MyntLib.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "./TroveManagerBase.sol";
import "../Interfaces/IPermit2.sol";

/// This contract is designed to be used via delegatecall from the TroveManager contract
contract TroveManagerRedeemOps is TroveManagerBase {
    IPermit2 public immutable permit2;

    // Pack redemption hints/limits into one struct to reduce stack usage (Solidity 0.6.x stack-too-deep)
    struct RedeemParams {
        address firstRedemptionHint;
        address upperPartialRedemptionHint;
        address lowerPartialRedemptionHint;
        uint256 partialRedemptionHintNICR;
        uint256 maxIterations;
        uint256 maxFeePercentage;
    }

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

        _requireValidMaxFeePercentage(_params.maxFeePercentage);
        _requireAfterBootstrapPeriod();

        totals.price = priceFeed.fetchPrice();
        _requireTCRoverMCR(totals.price);
        _requireAmountGreaterThanZero(_ZUSDamount);
        _requireZUSDBalanceCoversRedemption(contractsCache.zusdToken, msg.sender, _ZUSDamount);

        totals.totalZUSDSupplyAtStart = getEntireSystemDebt();
        assert(contractsCache.zusdToken.balanceOf(msg.sender) <= totals.totalZUSDSupplyAtStart);

        // ------------------------------------------------------------
        // 1) Swap against RedemptionBuffer FIRST (ZUSD -> RBTC)
        //    - transfers ZUSD to FeeDistributor via transferFrom()
        //    - does NOT burn ZUSD
        //    - does NOT touch ActivePool debt
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
        //    Moved into helper to reduce stack usage.
        // ------------------------------------------------------------
        if (totals.remainingZUSD > 0) {
            _redeemFromTroves(contractsCache, totals, _params);
        }

        uint256 totalETHDrawnInclBuffer = totals.totalETHDrawn.add(ethFromBuffer);
        require(totalETHDrawnInclBuffer > 0, "TroveManager: Unable to redeem any amount");

        // ------------------------------------------------------------
        // 3) BaseRate update applies to buffer swaps too
        // ------------------------------------------------------------
        _updateBaseRateFromRedemption(totalETHDrawnInclBuffer, totals.price, totals.totalZUSDSupplyAtStart);

        // ------------------------------------------------------------
        // 4) Redemption fee applies to BOTH sources (same formula)
        // ------------------------------------------------------------
        uint256 ethFeeFromTroves = _getRedemptionFee(totals.totalETHDrawn);
        uint256 ethFeeFromBuffer = _getRedemptionFee(ethFromBuffer);
        totals.ETHFee = ethFeeFromTroves.add(ethFeeFromBuffer);

        _requireUserAcceptsFee(totals.ETHFee, totalETHDrawnInclBuffer, _params.maxFeePercentage);

        uint256 totalZUSDProcessed = _ZUSDamount.sub(totals.remainingZUSD);

        emit Redemption(_ZUSDamount, totalZUSDProcessed, totalETHDrawnInclBuffer, totals.ETHFee);

        // ------------------------------------------------------------
        // 5) Burn ONLY trove portion (buffer portion is a swap)
        // ------------------------------------------------------------
        if (totals.totalZUSDToRedeem > 0) {
            contractsCache.zusdToken.burn(msg.sender, totals.totalZUSDToRedeem);
            contractsCache.activePool.decreaseZUSDDebt(totals.totalZUSDToRedeem);
        }

        // ------------------------------------------------------------
        // 6) Pay RBTC fees into FeeDistributor
        //    - trove fee from ActivePool
        //    - buffer fee directly from RedemptionBuffer
        // ------------------------------------------------------------
        if (ethFeeFromTroves > 0) {
            contractsCache.activePool.sendETH(address(feeDistributor), ethFeeFromTroves);
        }

        if (ethFeeFromBuffer > 0) {
            // IMPORTANT: FeeDistributor.receive() must accept RBTC from RedemptionBuffer
            redemptionBuffer.withdrawForRedemption(payable(address(feeDistributor)), ethFeeFromBuffer);
        }

        // Distribute any ZUSD swapped into FeeDistributor + RBTC fees
        if (zusdSwappedToFeeDistributor > 0 || totals.ETHFee > 0) {
            feeDistributor.distributeFees();
        }

        // ------------------------------------------------------------
        // 7) Send net RBTC to redeemer from each source
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

    // Helper extracted from _redeemCollateral to reduce stack depth in Solidity 0.6.x
    function _redeemFromTroves(
        ContractsCache memory _contractsCache,
        RedemptionTotals memory _totals,
        RedeemParams memory _params
    ) internal {
        address currentBorrower = address(0);

        if (_isValidFirstRedemptionHint(_contractsCache.sortedTroves, _params.firstRedemptionHint, _totals.price)) {
            currentBorrower = _params.firstRedemptionHint;
        } else {
            currentBorrower = _contractsCache.sortedTroves.getLast();
            while (
                currentBorrower != address(0) &&
                _getCurrentICR(currentBorrower, _totals.price) < liquityBaseParams.MCR()
            ) {
                currentBorrower = _contractsCache.sortedTroves.getPrev(currentBorrower);
            }
        }

        uint256 maxIterations = _params.maxIterations;
        if (maxIterations == 0) {
            maxIterations = uint256(-1);
        }

        while (currentBorrower != address(0) && _totals.remainingZUSD > 0 && maxIterations > 0) {
            maxIterations--;

            address nextUserToCheck = _contractsCache.sortedTroves.getPrev(currentBorrower);

            _applyPendingRewards(_contractsCache.activePool, _contractsCache.defaultPool, currentBorrower);

            SingleRedemptionValues memory singleRedemption = _redeemCollateralFromTrove(
                _contractsCache,
                currentBorrower,
                _totals.remainingZUSD,
                _totals.price,
                _params
            );

            if (singleRedemption.cancelledPartial) break;

            _totals.totalZUSDToRedeem = _totals.totalZUSDToRedeem.add(singleRedemption.ZUSDLot);
            _totals.totalETHDrawn = _totals.totalETHDrawn.add(singleRedemption.ETHLot);

            _totals.remainingZUSD = _totals.remainingZUSD.sub(singleRedemption.ZUSDLot);
            currentBorrower = nextUserToCheck;
        }
    }

    // ----- DLLR helpers unchanged -----

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

    /**
     * Swap ZUSD against RedemptionBuffer at oracle price.
     * Uses transferFrom(redeemer -> FeeDistributor) (so redeemer must approve TroveManager).
     */
    function _swapFromBuffer(
        ContractsCache memory _contractsCache,
        uint256 _ZUSDAmount,
        uint256 _price,
        address _redeemer
    ) internal returns (uint256 remainingZUSD, uint256 ethFromBuffer, uint256 zusdSwappedToFeeDistributor) {
        remainingZUSD = _ZUSDAmount;

        if (address(redemptionBuffer) == address(0) || _ZUSDAmount == 0) {
            return (remainingZUSD, 0, 0);
        }

        uint256 bufferBal = redemptionBuffer.getBalance();
        if (bufferBal == 0) {
            return (remainingZUSD, 0, 0);
        }

        uint256 maxZusdFromBuffer = bufferBal.mul(_price).div(DECIMAL_PRECISION);
        zusdSwappedToFeeDistributor = LiquityMath._min(_ZUSDAmount, maxZusdFromBuffer);

        if (zusdSwappedToFeeDistributor == 0) {
            return (remainingZUSD, 0, 0);
        }

        ethFromBuffer = zusdSwappedToFeeDistributor.mul(DECIMAL_PRECISION).div(_price);

        // spender == TroveManager because this is delegatecall (address(this) is TroveManager)
        require(
            _contractsCache.zusdToken.allowance(_redeemer, address(this)) >= zusdSwappedToFeeDistributor,
            "TroveManager: approve ZUSD allowance for buffer swap"
        );

        require(
            _contractsCache.zusdToken.transferFrom(_redeemer, address(feeDistributor), zusdSwappedToFeeDistributor),
            "TroveManager: ZUSD transferFrom failed"
        );

        remainingZUSD = remainingZUSD.sub(zusdSwappedToFeeDistributor);
    }

    // ----- original trove redemption logic unchanged (signature adjusted to use params struct) -----

    function _redeemCollateralFromTrove(
        ContractsCache memory _contractsCache,
        address _borrower,
        uint256 _maxZUSDamount,
        uint256 _price,
        RedeemParams memory _params
    ) internal returns (SingleRedemptionValues memory singleRedemption) {
        singleRedemption.ZUSDLot = LiquityMath._min(
            _maxZUSDamount,
            Troves[_borrower].debt.sub(ZUSD_GAS_COMPENSATION)
        );

        singleRedemption.ETHLot = singleRedemption.ZUSDLot.mul(DECIMAL_PRECISION).div(_price);

        uint256 newDebt = (Troves[_borrower].debt).sub(singleRedemption.ZUSDLot);
        uint256 newColl = (Troves[_borrower].coll).sub(singleRedemption.ETHLot);

        if (newDebt == ZUSD_GAS_COMPENSATION) {
            _removeStake(_borrower);
            _closeTrove(_borrower, Status.closedByRedemption);
            _redeemCloseTrove(_contractsCache, _borrower, ZUSD_GAS_COMPENSATION, newColl);
            emit TroveUpdated(_borrower, 0, 0, 0, TroveManagerOperation.redeemCollateral);
        } else {
            uint256 newNICR = LiquityMath._computeNominalCR(newColl, newDebt);

            if (newNICR != _params.partialRedemptionHintNICR || _getNetDebt(newDebt) < MIN_NET_DEBT) {
                singleRedemption.cancelledPartial = true;
                return singleRedemption;
            }

            _contractsCache.sortedTroves.reInsert(
                _borrower,
                newNICR,
                _params.upperPartialRedemptionHint,
                _params.lowerPartialRedemptionHint
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

    function _updateBaseRateFromRedemption(
        uint256 _ETHDrawn,
        uint256 _price,
        uint256 _totalZUSDSupply
    ) internal returns (uint256) {
        uint256 decayedBaseRate = _calcDecayedBaseRate();

        uint256 redeemedZUSDFraction = _ETHDrawn.mul(_price).div(_totalZUSDSupply);

        uint256 newBaseRate = decayedBaseRate.add(redeemedZUSDFraction.div(BETA));
        newBaseRate = LiquityMath._min(newBaseRate, DECIMAL_PRECISION);
        assert(newBaseRate > 0);

        baseRate = newBaseRate;
        emit BaseRateUpdated(newBaseRate);

        _updateLastFeeOpTime();

        return newBaseRate;
    }

    function _redeemCloseTrove(
        ContractsCache memory _contractsCache,
        address _borrower,
        uint256 _ZUSD,
        uint256 _ETH
    ) internal {
        _contractsCache.zusdToken.burn(gasPoolAddress, _ZUSD);
        _contractsCache.activePool.decreaseZUSDDebt(_ZUSD);

        _contractsCache.collSurplusPool.accountSurplus(_borrower, _ETH);
        _contractsCache.activePool.sendETH(address(_contractsCache.collSurplusPool), _ETH);
    }
}
