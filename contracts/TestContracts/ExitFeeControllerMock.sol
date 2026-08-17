// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "../Interfaces/colfee/IExitFeeController.sol";

/// @title  ExitFeeControllerMock
/// @notice Test double for the ColFee controller. NOT production code — lives in
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

    // --- Delay (security-perimeter) knobs ---
    bool public perimeterEnabled; // maps to securityPerimeterEnabled
    uint32 public delaySeconds; // returned as `d` when the perimeter charges a delay
    bool public delayRevert; // when true, quoteExitDelayFor reverts → exercises the hook's FAIL-CLOSED leg
    // Optional passthrough override so a test can force effOrig/effOwner != raw
    // (Zero has no passthrough in production, but the fail-closed identity
    // threading is still asserted).
    bool public overridePassthrough;
    address public forcedEffActor;

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

    // --- Delay configuration ---

    function configureDelay(bool _enabled, uint32 _delaySeconds) external {
        perimeterEnabled = _enabled;
        delaySeconds = _delaySeconds;
    }

    function setDelayRevert(bool _v) external {
        delayRevert = _v;
    }

    function setForcedPassthrough(bool _on, address _effActor) external {
        overridePassthrough = _on;
        forcedEffActor = _effActor;
    }

    /// @dev Single hook entry. Short-circuits the kill switch FIRST:
    ///      a disabled perimeter returns (0, raw, owner) — pay direct. Otherwise
    ///      returns the configured delay and (optionally forced) effective actors.
    function quoteExitDelayFor(
        address rawOriginator,
        address owner,
        address /* receiver */,
        bytes32 /* surfaceId */,
        address /* subProduct */
    ) external view returns (uint32 d, address effOrig, address effOwner) {
        require(!delayRevert, "EFCMock: forced delay revert");
        if (!perimeterEnabled) {
            return (0, rawOriginator, owner);
        }
        if (overridePassthrough) {
            return (delaySeconds, forcedEffActor, forcedEffActor);
        }
        return (delaySeconds, rawOriginator, owner);
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
