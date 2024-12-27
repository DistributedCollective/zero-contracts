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

    function testCrossReentrancyWithoutAffectingDebt(
        uint256 _maxFeePercentage,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint,
        address _priceFeed
    ) public payable {
        borrowerOperations.openTrove{value: msg.value / 2}(
            _maxFeePercentage,
            _ZUSDAmount,
            _upperHint,
            _lowerHint
        );

        // manipulate the price so that the recovery mode will be triggered
        IPriceFeedTestnet(_priceFeed).setPrice(1e8);

        // // should not revert because it's not affecting the debt
        borrowerOperations.addColl{value: msg.value / 2}(_upperHint, _lowerHint);
    }

    function testCrossReentrancyAffectingDebt(
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

        // manipulate the price so that the recovery mode will be triggered
        IPriceFeedTestnet(_priceFeed).setPrice(1e8);

        // repayZusd will affect(decrease) the debt, should revert due to reentrancy violation
        borrowerOperations.repayZUSD(_ZUSDAmount, _upperHint, _lowerHint);
    }
}
