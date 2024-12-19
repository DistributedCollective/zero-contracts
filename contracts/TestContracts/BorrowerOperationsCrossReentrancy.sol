// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "../Interfaces/IBorrowerOperations.sol";

interface IPriceFeedTestnet {
    function setPrice(uint256 price) external returns (bool);
}

contract BorrowerOperationsCrossReentrancy {
    IBorrowerOperations public borrowerOperations;

    constructor(
        IBorrowerOperations _borrowerOperations
    ) public {
        borrowerOperations = _borrowerOperations;
    }

    fallback() external payable {}

    function testCrossReentrancy(
        uint256 _maxFeePercentage,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint,
        address _priceFeed
    ) public payable {
        borrowerOperations.openTrove{value: msg.value}(
            _maxFeePercentage,
            _ZUSDAmount,
            _upperHint,
            _lowerHint
        );

        // // should revert due to reentrancy violation
        borrowerOperations.addColl(_upperHint, _lowerHint);
    }
}
