// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "../Interfaces/IBorrowerOperations.sol";
import "hardhat/console.sol";

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

    /**
    * @dev open trove and decrease the debt in the same block should revert due to reentrancy
    */
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

    /**
    * @dev increase the debt, then decrease the debt in the same block should revert due to reentrancy
    * @dev the trove will be opened in the past block
    */
    function testCrossReentrancyByIncreasingDebt(
        uint256 _maxFeePercentage,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint,
        address _priceFeed
    ) public payable {
        // manipulate the price so that the recovery mode will be triggered
        IPriceFeedTestnet(_priceFeed).setPrice(1e17);
        // add coll to the trove so that the TCR will be above CCR
        borrowerOperations.addColl{value: msg.value}(_upperHint, _lowerHint);

        // withdraw ZUSD to increase the debt
        borrowerOperations.withdrawZUSD(_maxFeePercentage, _ZUSDAmount, _upperHint, _lowerHint);

        // repayZusd will affect(decrease) the debt, should revert due to reentrancy violation
        borrowerOperations.repayZUSD(_ZUSDAmount, _upperHint, _lowerHint);
    }
}
