// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

/// @notice ColFee test double simulating the LIVE (pre-upgrade) CollSurplusPool
///         implementation: `claimColl` exists but `claimCollWithFee` does NOT,
///         and there is no fallback — so the hook's pool call reverts on the
///         missing selector, reproducing the surface-activated-before-pool-
///         upgrade ordering hazard. Deliberately does not implement
///         ICollSurplusPool (which now declares claimCollWithFee).
contract LegacyCollSurplusPoolMock {
    address public borrowerOperationsAddress;
    uint256 internal ETH;
    mapping(address => uint256) internal balances;

    function setBO(address _bo) external {
        borrowerOperationsAddress = _bo;
    }

    /// Test-only funding shortcut (the real pool is fed via TroveManager/ActivePool).
    function setSurplus(address _account) external payable {
        balances[_account] = balances[_account] + msg.value;
        ETH = ETH + msg.value;
    }

    function getETH() external view returns (uint256) {
        return ETH;
    }

    function getCollateral(address _account) external view returns (uint256) {
        return balances[_account];
    }

    function claimColl(address _account) external {
        require(msg.sender == borrowerOperationsAddress, "Legacy: caller is not BO");
        uint256 claimableColl = balances[_account];
        require(claimableColl > 0, "CollSurplusPool: No collateral available to claim");
        balances[_account] = 0;
        ETH = ETH - claimableColl;
        (bool success, ) = _account.call{ value: claimableColl }("");
        require(success, "CollSurplusPool: sending ETH failed");
    }
}
