// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "../Interfaces/IBorrowerOperations.sol";

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
        address _lowerHint
    ) public payable {
        borrowerOperations.openTrove{value: msg.value}(
            _maxFeePercentage,
            _ZUSDAmount,
            _upperHint,
            _lowerHint
        );

        // // should revert due to reentrancy violation
        borrowerOperations.closeTrove();
    }
}
