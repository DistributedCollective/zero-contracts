// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

/// @notice Test helper that performs a low-level call and RETURNS the raw
///         returndata instead of bubbling it, so a test can read the exact
///         revert payload a reverting exit produces — independent of how the
///         node formats its error.
contract PerimeterRawCatcher {
    function probe(
        address target,
        bytes calldata data
    ) external payable returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call.value(msg.value)(data);
    }

    receive() external payable {}
}
