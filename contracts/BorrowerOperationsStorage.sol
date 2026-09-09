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

    /// @notice The perimeter settlement hook `_sendCollWithExitFee` delegates to.
    ///         Appended last so no existing slot moves; set by the owner via
    ///         setPerimeterOps and rotatable the same way, mirroring
    ///         `troveManagerRedeemOps`. Unset until that call lands, and the
    ///         settlement delegatecall reverts on a code-less hook, so an
    ///         implementation upgrade must be followed by setPerimeterOps in the
    ///         same governance execution or exits revert until it does.
    address public perimeterOps;
}
