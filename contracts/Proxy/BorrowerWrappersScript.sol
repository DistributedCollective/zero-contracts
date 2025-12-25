// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Dependencies/SafeMath.sol";
import "../Dependencies/LiquityMath.sol";
import "../Dependencies/IERC20.sol";
import "../Interfaces/IBorrowerOperations.sol";
import "../Interfaces/ITroveManager.sol";
import "../Interfaces/IStabilityPool.sol";
import "../Interfaces/IPriceFeed.sol";
import "../Interfaces/IZEROStaking.sol";
import "./BorrowerOperationsScript.sol";
import "./ETHTransferScript.sol";
import "./ZEROStakingScript.sol";
import "../Dependencies/console.sol";


contract BorrowerWrappersScript is BorrowerOperationsScript, ETHTransferScript, ZEROStakingScript {
    using SafeMath for uint;

    string constant public NAME = "BorrowerWrappersScript";

    ITroveManager immutable troveManager;
    IStabilityPool immutable stabilityPool;
    IPriceFeed immutable priceFeed;
    IERC20 immutable zusdToken;
    IERC20 immutable zeroToken;
    IZEROStaking immutable zeroStaking;

    constructor(
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _zeroStakingAddress,
        address _stabilityPoolAddress,
        address _priceFeedAddress,
        address _zusdTokenAddress,
        address _zeroTokenAddress
    )
        BorrowerOperationsScript(IBorrowerOperations(_borrowerOperationsAddress))
        ZEROStakingScript(_zeroStakingAddress)
        public
    {
        checkContract(_troveManagerAddress);
        ITroveManager troveManagerCached = ITroveManager(_troveManagerAddress);
        troveManager = troveManagerCached;

        IStabilityPool stabilityPoolCached = IStabilityPool(_stabilityPoolAddress);
        checkContract(_stabilityPoolAddress);
        stabilityPool = stabilityPoolCached;

        IPriceFeed priceFeedCached = IPriceFeed(_priceFeedAddress); 
        checkContract(_priceFeedAddress);
        priceFeed = priceFeedCached;

        checkContract(_zusdTokenAddress);
        zusdToken = IERC20(_zusdTokenAddress);

        checkContract(_zeroTokenAddress);
        zeroToken = IERC20(_zeroTokenAddress);

        IZEROStaking zeroStakingCached = IZEROStaking(_zeroStakingAddress);
        checkContract(_zeroStakingAddress);
        zeroStaking = zeroStakingCached;
    }

    function claimCollateralAndOpenTrove(uint _maxFee, uint _ZUSDAmount, address _upperHint, address _lowerHint) external payable {
        uint balanceBefore = address(this).balance;

        // Claim collateral
        borrowerOperations.claimCollateral();

        uint balanceAfter = address(this).balance;

        // already checked in CollSurplusPool
        assert(balanceAfter > balanceBefore);

        uint totalCollateral = balanceAfter.sub(balanceBefore).add(msg.value);

        // Open trove with obtained collateral, plus collateral sent by user
        borrowerOperations.openTrove{ value: totalCollateral }(_maxFee, _ZUSDAmount, _upperHint, _lowerHint);
    }

    function claimSPRewardsAndRecycle(
        uint _maxFee,
        address _upperHint,
        address _lowerHint
    ) external payable {
        uint collBalanceBefore = address(this).balance;
        uint zeroBalanceBefore = zeroToken.balanceOf(address(this));

        // Claim rewards (ETH gain + ZERO)
        stabilityPool.withdrawFromSP(0);

        uint collBalanceAfter = address(this).balance;
        uint zeroBalanceAfter = zeroToken.balanceOf(address(this));

        // IMPORTANT: this is only the ETH gain from SP (msg.value cancels out because it was already in balanceBefore)
        uint claimedCollateral = collBalanceAfter.sub(collBalanceBefore);

        if (claimedCollateral > 0) {
            _requireUserHasTrove(address(this));

            uint zusdAmount = _getNetZUSDAmount(claimedCollateral);

            // --- NEW: buffer fee on debt increase must be paid on top ---
            uint bufferFee = 0;
            if (zusdAmount > 0) {
                // Prefer WithPrice so we control the price input and avoid extra fetchPrice side effects.
                // getRedemptionBufferFeeRBTC(zusdAmount) would work as well.
                uint p = priceFeed.fetchPrice();
                bufferFee = borrowerOperations.getRedemptionBufferFeeRBTCWithPrice(zusdAmount, p);
            }

            require(msg.value >= bufferFee, "BorrowerWrappers: insufficient ETH for buffer fee");

            borrowerOperations.adjustTrove{ value: claimedCollateral.add(bufferFee) }(
                _maxFee,
                0,
                zusdAmount,
                true,
                _upperHint,
                _lowerHint
            );

            if (zusdAmount > 0) {
                stabilityPool.provideToSP(zusdAmount, address(0));
            }

            // Refund any extra ETH sent (keeps proxy ETH balance unchanged)
            uint refund = msg.value.sub(bufferFee);
            if (refund > 0) {
                (bool ok, ) = msg.sender.call{ value: refund }("");
                require(ok, "BorrowerWrappers: refund failed");
            }
        } else {
            // If no ETH gain, don't trap ETH in the proxy
            if (msg.value > 0) {
                (bool ok, ) = msg.sender.call{ value: msg.value }("");
                require(ok, "BorrowerWrappers: refund failed");
            }
        }

        // Stake claimed ZERO
        uint claimedZERO = zeroBalanceAfter.sub(zeroBalanceBefore);
        if (claimedZERO > 0) {
            zeroStaking.stake(claimedZERO);
        }
    }


    function claimStakingGainsAndRecycle(uint _maxFee, address _upperHint, address _lowerHint) external {
        uint collBalanceBefore = address(this).balance;
        uint zusdBalanceBefore = zusdToken.balanceOf(address(this));
        uint zeroBalanceBefore = zeroToken.balanceOf(address(this));

        // Claim gains
        zeroStaking.unstake(0);

        uint gainedCollateral = address(this).balance.sub(collBalanceBefore); // stack too deep issues :'(
        uint gainedZUSD = zusdToken.balanceOf(address(this)).sub(zusdBalanceBefore);

        uint netZUSDAmount;
        // Top up trove and get more ZUSD, keeping ICR constant
        if (gainedCollateral > 0) {
            _requireUserHasTrove(address(this));
            netZUSDAmount = _getNetZUSDAmount(gainedCollateral);
            borrowerOperations.adjustTrove{ value: gainedCollateral }(_maxFee, 0, netZUSDAmount, true, _upperHint, _lowerHint);
        }

        uint totalZUSD = gainedZUSD.add(netZUSDAmount);
        if (totalZUSD > 0) {
            stabilityPool.provideToSP(totalZUSD, address(0));

            // Providing to Stability Pool also triggers ZERO claim, so stake it if any
            uint zeroBalanceAfter = zeroToken.balanceOf(address(this));
            uint claimedZERO = zeroBalanceAfter.sub(zeroBalanceBefore);
            if (claimedZERO > 0) {
                zeroStaking.stake(claimedZERO);
            }
        }

    }

    function _getNetZUSDAmount(uint _collateral) internal returns (uint) {
        uint price = priceFeed.fetchPrice();
        uint ICR = troveManager.getCurrentICR(address(this), price);

        uint ZUSDAmount = _collateral.mul(price).div(ICR);
        uint borrowingRate = troveManager.getBorrowingRateWithDecay();
        uint netDebt = ZUSDAmount.mul(LiquityMath.DECIMAL_PRECISION).div(LiquityMath.DECIMAL_PRECISION.add(borrowingRate));

        return netDebt;
    }

    function _requireUserHasTrove(address _depositor) internal view {
        require(troveManager.getTroveStatus(_depositor) == 1, "BorrowerWrappersScript: caller must have an active trove");
    }
}
