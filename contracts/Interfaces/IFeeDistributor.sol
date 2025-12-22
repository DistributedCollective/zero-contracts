// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

/// @title IFeeDistributor
/// @notice FeeDistributor receives protocol fees (ZUSD and/or RBTC) and forwards them to
///         FeeSharingCollector / ZEROStaking according to protocol configuration.
/// @dev
///  - BorrowerOperations sends ZUSD borrowing fees here and then calls distributeFees().
///  - TroveManager sends RBTC redemption fees here and then calls distributeFees().
///  - With the RedemptionBuffer "swap" model, TroveManagerRedeemOps may:
///      * transfer ZUSD from redeemer -> FeeDistributor (ERC20 transferFrom)
///      * send RBTC redemption fee from RedemptionBuffer -> FeeDistributor
///    and then call distributeFees().
interface IFeeDistributor {
    // --- Events (mirrors FeeDistributor.sol) ---

    event FeeSharingCollectorAddressChanged(address _feeSharingCollectorAddress);
    event ZeroStakingAddressChanged(address _zeroStakingAddress);
    event BorrowerOperationsAddressChanged(address _borrowerOperationsAddress);
    event TroveManagerAddressChanged(address _troveManagerAddress);
    event WrbtcAddressChanged(address _wrbtcAddress);
    event ZUSDTokenAddressChanged(address _zusdTokenAddress);
    event ActivePoolAddressSet(address _activePoolAddress);

    /// @notice Emitted when ZUSD is distributed to collectors/stakers.
    event ZUSDDistributed(uint256 _zusdDistributedAmount);

    /// @notice Emitted when RBTC is distributed to collectors/stakers.
    /// @dev Note: name preserved (typo) for backwards compatibility with existing deployments/logs.
    event RBTCistributed(uint256 _rbtcDistributedAmount);

    /// @notice Emitted when the RedemptionBuffer address is configured.
    event RedemptionBufferAddressChanged(address _redemptionBufferAddress);

    // --- Admin/initializer functions ---

    /// @notice Called once on init to wire core contracts.
    function setAddresses(
        address _feeSharingCollectorAddress,
        address _zeroStakingAddress,
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _wrbtcAddress,
        address _zusdTokenAddress,
        address _activePoolAddress
    ) external;

    /// @notice Sets the RedemptionBuffer contract address.
    /// @dev Needed if FeeDistributor.receive() should accept RBTC directly from RedemptionBuffer
    ///      (e.g. when redemption fees on buffer-swaps are paid from the buffer).
    function setRedemptionBufferAddress(address _redemptionBufferAddress) external;

    // --- Core function ---

    /// @notice Distributes any ZUSD and/or RBTC currently held by FeeDistributor.
    /// @dev In your implementation this is permissioned (BO/TroveManager/(optional) RedemptionBuffer).
    function distributeFees() external;

    // --- Views / getters ---

    /// @notice Getter for the configured RedemptionBuffer address (public var in implementation).
    function redemptionBufferAddress() external view returns (address);
}
