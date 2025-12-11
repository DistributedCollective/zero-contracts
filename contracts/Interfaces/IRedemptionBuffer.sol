// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

interface IRedemptionBuffer {
    /// @notice Receive RBTC from BorrowerOperations when users open a Line of Credit
    function deposit() external payable;

    /// @notice Withdraw RBTC to satisfy a ZUSD redemption
    /// @dev Only callable by TroveManager
    function withdrawForRedemption(address payable _to, uint256 _amount) external;

    /// @notice Governance-controlled distribution of RBTC to SOV stakers
    /// @dev Only callable by the contract owner (timelock / Bitocracy executor)
    function distributeToStakers(address payable _stakingContract, uint256 _amount) external;

    /// @return Current RBTC balance tracked by the buffer
    function getBalance() external view returns (uint256);
}