// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

/// @title IRedemptionBuffer
/// @notice Minimal interface for the protocol RBTC "buffer" used during redemptions.
/// @dev
///  - BorrowerOperations deposits RBTC (collected as a fee when debt is issued).
///  - TroveManager withdraws RBTC to satisfy redemptions.
///  - Governance may send RBTC to FeeDistributor (or elsewhere) via distributeToStakers().
///
/// IMPORTANT DESIGN NOTE:
/// This interface does NOT prescribe whether redeemer ZUSD is burned or transferred (swap-style).
/// That policy lives in TroveManagerRedeemOps. The buffer just holds/sends RBTC.
interface IRedemptionBuffer {
    /// @notice Receive RBTC into the buffer.
    /// @dev Expected caller: BorrowerOperations (onlyBorrowerOps in implementation).
    function deposit() external payable;

    /// @notice Withdraw RBTC from the buffer.
    /// @dev Expected caller: TroveManager (onlyTroveManager in implementation).
    /// @param _to Destination to receive RBTC (redeemer, FeeDistributor, etc.).
    /// @param _amount Amount of RBTC (wei) to send.
    function withdrawForRedemption(address payable _to, uint256 _amount) external;

    /// @notice Governance-controlled distribution of RBTC held in the buffer.
    /// @dev Typically used to send RBTC to FeeDistributor so it gets split to stakers.
    /// @param _amount Amount of RBTC (wei) to distribute.
    function distributeToStakers(uint256 _amount) external;

    /// @notice Returns the RBTC balance tracked by the buffer.
    /// @dev Implementation usually tracks an internal accounting variable (e.g. totalBufferedColl).
    function getBalance() external view returns (uint256);
}
