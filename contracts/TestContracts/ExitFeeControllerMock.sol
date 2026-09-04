// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "../Interfaces/perimeter/IExitFeeController.sol";

/// @title  ExitFeeControllerMock
/// @notice Test double for the Perimeter controller. NOT production code — lives in
///         TestContracts/ only. The production controller is Solidity 0.8.20 and
///         cannot be compiled into the 0.6.11 zero-contracts workspace, so the
///         hooks are exercised against this configurable stand-in.
///
///         Only `quoteExitFee` is implemented (the single selector the product
///         hook calls). It deliberately does NOT inherit `IExitFeeController` so
///         we avoid stubbing the full admin/view surface; the selector + ABI of
///         `quoteExitFee` match, which is all `IExitFeeController(ctrl).quoteExitFee`
///         needs at the call site.
contract ExitFeeControllerMock {
    bool public doRevert; // when true, quoteExitFee reverts → exercises CONTROLLER_REVERT fail-open
    bool public activeFlag;
    uint16 public rateBps;
    address public feeReceiverAddr;
    uint8 public reasonCode;

    // Optional override so tests can return a deliberately malformed quote
    // (e.g. feeAmount > gross) to exercise the INVALID_QUOTE guard.
    bool public overrideAmounts;
    uint256 public forcedFeeAmount;
    uint256 public forcedNetAmount;

    function configure(
        bool _active,
        uint16 _rateBps,
        address _feeReceiver,
        uint8 _reason
    ) external {
        activeFlag = _active;
        rateBps = _rateBps;
        feeReceiverAddr = _feeReceiver;
        reasonCode = _reason;
    }

    function setRevert(bool _v) external {
        doRevert = _v;
    }

    /// @dev Simulate a controller that becomes code-less after being wired in
    ///      (e.g. a self-destructed/destroyed proxy) to exercise the product's
    ///      _safeQuote extcodesize fail-open guard.
    function destroy() external {
        selfdestruct(msg.sender);
    }

    function setForcedAmounts(bool _on, uint256 _fee, uint256 _net) external {
        overrideAmounts = _on;
        forcedFeeAmount = _fee;
        forcedNetAmount = _net;
    }

    function quoteExitFee(
        bytes32,
        address,
        address,
        uint256 gross
    ) external view returns (IExitFeeController.ExitFeeQuote memory q) {
        require(!doRevert, "EFCMock: forced revert");
        q.active = activeFlag;
        q.rateBps = rateBps;
        q.feeReceiver = feeReceiverAddr;
        q.reason = reasonCode;
        if (overrideAmounts) {
            q.feeAmount = forcedFeeAmount;
            q.netAmount = forcedNetAmount;
        } else if (activeFlag) {
            q.feeAmount = (gross * uint256(rateBps)) / 10000;
            q.netAmount = gross - q.feeAmount;
        } else {
            q.netAmount = gross;
        }
    }
}
