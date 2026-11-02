// SPDX-License-Identifier: MIT
pragma solidity 0.5.17;

/// @notice Reverts every delegated request while native proxy administration remains available.
contract ZeroEmergencyHalt {
    function() external payable {
        revert("Zero: emergency shutdown");
    }
}
