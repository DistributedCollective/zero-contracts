// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "../Interfaces/colfee/IExitDelayQueueHook.sol";

/// @title  SelectorRevertingExitDelayQueue
/// @notice Test double for the SR1 selector-propagation regression. The
///         REAL `ExitDelayQueue` is Solidity 0.8.20 and its `onlyAllowedSource`
///         guard reverts with the CUSTOM ERROR `UnregisteredSource(address)` — a
///         distinct 4-byte selector the off-chain halt watcher keys on. This
///         mock reproduces that exact revert payload at 0.6.11
///         (which cannot declare `error` types) by reverting with the raw
///         ABI-encoding `abi.encodeWithSelector(UnregisteredSource.selector,
///         msg.sender)` via inline assembly.
///
///         The point of the regression: the 0.6.11 `BorrowerOperations` delay
///         hook calls `recordReceivedNativeExit` as a PLAIN external call (it does
///         NOT wrap it in a try/catch or re-`require` with a string reason), so
///         the queue's custom-error selector must BUBBLE UP UNCHANGED out of the
///         reverting trove exit. A test asserts the returndata's leading 4 bytes
///         equal `bytes4(keccak256("UnregisteredSource(address)"))` — proving the
///         distinct halt selector survives the cross-pragma boundary and is not
///         masked by a host-side wrapper.
contract SelectorRevertingExitDelayQueue is IExitDelayQueueHook {
    /// bytes4(keccak256("UnregisteredSource(address)")) — evaluated at compile time.
    bytes4 public constant UNREGISTERED_SOURCE_SELECTOR =
        bytes4(keccak256("UnregisteredSource(address)"));

    /// @dev Unconditional native receive() — the ActivePool push lands here
    ///      BEFORE the record call, exactly as against the real queue, so the revert
    ///      under test is the record leg (not a failed push).
    receive() external payable {}

    /// @dev Reverts with the raw `UnregisteredSource(msg.sender)` custom-error bytes,
    ///      byte-identical to what the 0.8.20 queue emits. No string wrapping.
    function recordReceivedNativeExit(
        uint128,
        uint32,
        bytes32,
        address,
        address,
        address,
        address
    ) external override returns (uint256) {
        bytes memory err = abi.encodeWithSelector(UNREGISTERED_SOURCE_SELECTOR, msg.sender);
        assembly {
            revert(add(err, 0x20), mload(err))
        }
    }

    // ── Interface completeness (unused by the Zero native path) ───────────────

    function recordERC20Exit(
        address,
        uint128,
        uint32,
        bytes32,
        address,
        address,
        address,
        address,
        bool
    ) external override returns (uint256) {
        revert("unsupported");
    }

    function recordReceivedERC20Exit(
        address,
        uint128,
        uint32,
        bytes32,
        address,
        address,
        address,
        address
    ) external override returns (uint256) {
        revert("unsupported");
    }

    function recordNativeExit(
        uint128,
        uint32,
        bytes32,
        address,
        address,
        address,
        address
    ) external payable override returns (uint256) {
        revert("unsupported");
    }
}
