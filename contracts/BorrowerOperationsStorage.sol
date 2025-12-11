// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/IActivePool.sol";
import "./Interfaces/IBorrowerOperations.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IZUSDToken.sol";
import "./Interfaces/ICollSurplusPool.sol";
import "./Interfaces/ISortedTroves.sol";
import "./Interfaces/IZEROStaking.sol";
import "./Interfaces/IFeeDistributor.sol";
import "./Dependencies/Ownable.sol";
import "./Dependencies/Mynt/IMassetManager.sol";
import "./Interfaces/IRedemptionBuffer.sol";

contract BorrowerOperationsStorage is Ownable {
    string public constant NAME = "BorrowerOperations";

    // --- Connected contract declarations ---

    ITroveManager public troveManager;

    address stabilityPoolAddress;

    address gasPoolAddress;

    ICollSurplusPool collSurplusPool;

    IZEROStaking public zeroStaking;
    address public zeroStakingAddress;

    IZUSDToken public zusdToken;

    // A doubly linked list of Troves, sorted by their collateral ratios
    ISortedTroves public sortedTroves;

    IMassetManager public massetManager;
    IFeeDistributor public feeDistributor;

    // --- Redemption buffer config ---

    // Redemption buffer contract used to hold protocol RBTC
    IRedemptionBuffer internal redemptionBuffer;

    // Fraction of incoming RBTC sent to the buffer on openTrove.
    // 1e18 == 100%, e.g. 1e17 == 10%.
    uint256 internal redemptionBufferRate;
}
