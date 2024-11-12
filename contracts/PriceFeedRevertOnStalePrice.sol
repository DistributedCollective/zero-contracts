// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./PriceFeed.sol";

/// @title The system price feed adapter
/// @notice The PriceFeed relies upon a main oracle and a secondary as a fallback in case of error
contract PriceFeedRevertOnStalePrice is PriceFeed {
    // --- Functions ---
    constructor(address _mainPriceFeed, address _backupPriceFeed) public {
        setAddresses(_mainPriceFeed, _backupPriceFeed);
    }

    /// @notice Returns the latest price obtained from the Oracle. Called by Zero functions that require a current price.
    ///         It uses the main price feed and fallback to the backup one in case of an error. If both fail return the last
    ///         good price seen.
    /// @dev It's also callable by anyone externally
    /// @return The price
    function fetchPrice() external override returns (uint256) {
        for (uint8 index = 0; index < 2; index++) {
            (uint256 price, bool success) = priceFeeds[index].latestAnswer();
            if (success) {
                _storePrice(price);
                return price;
            } else {
                emit PriceFeedBroken(index, address(priceFeeds[index]));
            }
        }

        revert("PriceFeed: Price feed price is stale");
    }
}
