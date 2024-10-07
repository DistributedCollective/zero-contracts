// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "../Interfaces/IHintHelpers.sol";
import "../Interfaces/IPriceFeed.sol";
import "../Dependencies/IERC20.sol";

/// @title Redeem collateral helper
/// @notice inspired by the LiquidationLib library
contract RedeemCollateralHelper {
    /// @dev Three hints returned from a helper contract function, aim to ease
    ///     the traversal of the troves, resulting in more eficient operaitons and less gas cost
    /// - `firstRedemptionHint` is the address of the first Trove with ICR >= MCR (i.e. the first Trove that will be redeemed).
    /// - `partialRedemptionHintNICR` is the final nominal ICR of the last Trove of the sequence after being hit
    ///      by partial redemption or zero in case of no partial redemption.
    /// - `truncatedZUSDamount` is the maximum amount that can be redeemed out of the the provided `_ZUSDamount`.
    ///     This can be lower than `_ZUSDamount` when redeeming the full amount would leave the last Trove of the redemption
    ///     sequence with less net debt than the minimum allowed value (i.e. MIN_NET_DEBT).
    struct RedemptionHints {
        address firstRedemptionHint;
        uint256 partialRedemptionHintNICR;
        uint256 truncatedZUSDamount;
    }

    modifier isContractAddress(address contractAddress) {
        uint256 size;
        assembly {
            size := extcodesize(contractAddress)
        }
        require(size > 0);
        _;
    }

    receive() external payable {}

    /// @notice Redeems the corresponding ZUSD amount into rBTC
    /// @param _troveManagerContractAddress address of TroveManager contract
    /// @param _hintHelpersAddress address of the HintHelpers contract
    /// @param _priceFeedAddress address of PriceFeed contract
    /// @param _ZUSDAmount amount of ZUSD to be redeemed
    /// @param _maxFeePercentage max fee percentage of the ZUSD amount. If above this percentage, transaction will revert
    function redeemCollateral(
        address _troveManagerContractAddress,
        address _hintHelpersAddress,
        address _priceFeedAddress,
        address _zusdTokenAddress,
        uint256 _ZUSDAmount,
        uint256 _maxFeePercentage
    ) external isContractAddress(_troveManagerContractAddress) {
        RedemptionHints memory redemptionHints;
        IHintHelpers hintHelpers = IHintHelpers(_hintHelpersAddress);
        IPriceFeed priceFeed = IPriceFeed(_priceFeedAddress);
        uint256 amount = _ZUSDAmount; // to avoid stack too deep
        uint256 latestPrice = priceFeed.fetchPrice();
        (
            redemptionHints.firstRedemptionHint,
            redemptionHints.partialRedemptionHintNICR,
            redemptionHints.truncatedZUSDamount
        ) = hintHelpers.getRedemptionHints(amount, latestPrice, 0);

        uint256 maxFeePercentage = _maxFeePercentage; // to avoid stack too deep
        address troveAddress = _troveManagerContractAddress; // to avoid stack too deep
        uint256 nativeTokenBalanceBefore = address(this).balance;
        IERC20 zusd = IERC20(_zusdTokenAddress);
        uint256 zusdBalanceBefore = zusd.balanceOf(address(this));
        zusd.transferFrom(msg.sender, address(this), amount);
        zusd.approve(troveAddress, amount);

        // Encoding the function call to troveManager.redeemCollateral
        bytes memory data = abi.encodeWithSignature(
            "redeemCollateral(uint256,address,address,address,uint256,uint256,uint256)",
            redemptionHints.truncatedZUSDamount,
            redemptionHints.firstRedemptionHint,
            msg.sender,
            msg.sender,
            redemptionHints.partialRedemptionHintNICR,
            0,
            maxFeePercentage
        );

        (bool success, bytes memory returnData) = troveAddress.call(data);
        require(success, string(returnData));

        uint256 nativeTokenBalanceAfter = address(this).balance;
        uint256 zusdBalanceAfter = zusd.balanceOf(address(this));
        uint256 nativeTokenBalanceDelta = nativeTokenBalanceAfter - nativeTokenBalanceBefore;
        uint256 zusdBalanceDelta = zusdBalanceAfter - zusdBalanceBefore;
        require(nativeTokenBalanceDelta > 0, "Native token balance delta must be positive");
        // require(zusdBalanceDelta > 0, "ZUSD balance delta must be positive");
        if (zusdBalanceDelta > 0) {
            //partial redemption
            require(
                zusd.transfer(msg.sender, zusdBalanceDelta),
                "Error sending ZUSD to msg.sender"
            );
        }
        (bool successTransfer, bytes memory returnTransferData) = msg.sender.call{
            value: nativeTokenBalanceDelta
        }("");
        require(successTransfer, string(returnTransferData));
    }
}
