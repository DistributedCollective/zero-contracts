// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "../BorrowerOperationsStorage.sol";
import "../Interfaces/IActivePool.sol";
import "../Interfaces/perimeter/IExitFeeController.sol";
import "../Interfaces/perimeter/IExitDelayQueueHook.sol";

/// @title  BorrowerOperationsPerimeterOps
/// @notice Settles a Zero borrower collateral payout through the security
///         perimeter: the exit fee leg, then the delay leg.
///
/// @dev    Used via `delegatecall` from BorrowerOperations, the same way
///         TroveManagerRedeemOps is used from TroveManager. It shares
///         BorrowerOperationsStorage, so storage, `address(this)` and
///         `msg.sender` are the caller\'s, the pointer slots it reads are the
///         caller\'s, and the events it emits carry the caller\'s address. It
///         declares no storage of its own.
contract BorrowerOperationsPerimeterOps is BorrowerOperationsStorage {
    bytes32 private constant EXIT_FEE_CONTROLLER_SLOT =
        bytes32(uint256(keccak256("sovryn.perimeterExitFeeController")) - 1);
    bytes32 private constant EXIT_DELAY_QUEUE_SLOT =
        bytes32(uint256(keccak256("sovryn.perimeterExitDelayQueue")) - 1);
    bytes32 private constant PERIMETER_SURFACE_ZERO_WITHDRAW_COLL =
        keccak256("PERIMETER_SURFACE_ZERO_WITHDRAW_COLL");

    event ExitFeeApplied(
        bytes32 indexed surfaceId,
        address indexed actor,
        address indexed asset,
        address subProduct,
        address recipient,
        uint256 grossAmount,
        uint256 feeAmount,
        uint256 netAmount,
        address feeReceiver
    );
    event ExitFeeSkipped(
        bytes32 indexed surfaceId,
        address indexed actor,
        address indexed asset,
        uint256 grossAmount,
        uint16 rateBps,
        uint8 reason
    );

    /// @dev Reads the caller\'s pinned controller from the shared slot.
    function exitFeeController() internal view returns (address ctrl) {
        bytes32 slot = EXIT_FEE_CONTROLLER_SLOT;
        assembly {
            ctrl := sload(slot)
        }
    }

    /// @dev Reads the caller\'s pinned queue from the shared slot.
    function exitDelayQueue() internal view returns (address queue) {
        bytes32 slot = EXIT_DELAY_QUEUE_SLOT;
        assembly {
            queue := sload(slot)
        }
    }

    /// @dev Settle a borrower collateral payout, charging the Perimeter exit fee
    ///      when the resolved policy is active. The fee leg uses `try/catch`
    ///      (0.6.11 native) so a fee-receiver failure never bricks the exit; on
    ///      any non-charging path the full `gross` is sent to the borrower via
    ///      the existing fail-closed `sendETH`. ActivePool's recorded ETH
    ///      decrements by exactly `gross` either way (the reverted fee-leg
    ///      subcall rolls back its `ETH.sub`).
    function sendCollWithExitFee(
        IActivePool _activePool,
        address borrower,
        uint256 gross
    ) external {
        // Debt-only adjustments (repay / debt-decrease) reach here with gross == 0:
        // no collateral leaves the pool, so there is nothing to settle. Skip the
        // controller round-trip and the Perimeter event. (Baseline called
        // sendETH(borrower, 0) here — a value-less no-op that only emitted
        // EtherSent(_, 0) / ActivePoolETHBalanceUpdated; we drop that redundant
        // transfer, so debt-only ops emit fewer events than pre-Perimeter.)
        if (gross == 0) {
            return;
        }

        // Security-perimeter delay quote — computed ONCE up-front so a single `d`
        // governs the WHOLE exit: a fee-vault failure still escrows GROSS
        // behind the delay and cannot bypass it. FAIL-CLOSED (except the
        // kill-switch / unwired short-circuit): a controller revert reverts the
        // exit. Zero has no passthrough, so originator == owner == receiver
        // == borrower (== msg.sender on every collateral-out path). The queue is
        // NEVER touched here — only inside the `d > 0` branch of `_payUserColl`
        //.
        DelayLeg memory dl;
        (dl.d, dl.effOrig, dl.effOwner) = _safeQuoteExitDelay(borrower, borrower, borrower);

        // Single Zero deployment: subProduct = address(0). Asset is native RBTC.
        IExitFeeController.ExitFeeQuote memory q = _safeQuote(
            PERIMETER_SURFACE_ZERO_WITHDRAW_COLL,
            address(0),
            borrower,
            gross
        );

        if (q.active && q.feeAmount > 0) {
            try _activePool.sendETH(q.feeReceiver, q.feeAmount) {
                // user leg (net): direct-pay OR reroute to the delay queue when d>0
                _payUserColl(_activePool, borrower, q.netAmount, dl);
                // Emit only after BOTH legs settle, so an ExitFeeApplied event always
                // implies a completed borrower payout (truthful by construction).
                emit ExitFeeApplied(
                    PERIMETER_SURFACE_ZERO_WITHDRAW_COLL,
                    borrower,
                    address(0),
                    address(0),
                    borrower,
                    gross,
                    q.feeAmount,
                    q.netAmount,
                    q.feeReceiver
                );
                return;
            } catch {
                emit ExitFeeSkipped(
                    PERIMETER_SURFACE_ZERO_WITHDRAW_COLL,
                    borrower,
                    address(0),
                    gross,
                    q.rateBps,
                    uint8(IExitFeeController.SkipReason.VAULT_REVERT)
                );
            }
        } else {
            // !active (INACTIVE / DISABLED / INVALID_QUOTE / CONTROLLER_REVERT)
            // OR active-but-zero-fee (dust / zero-rate policy → q.reason == NONE).
            emit ExitFeeSkipped(
                PERIMETER_SURFACE_ZERO_WITHDRAW_COLL,
                borrower,
                address(0),
                gross,
                q.rateBps,
                q.reason
            );
        }
        // full-gross fallback (any non-charging path): direct-pay OR reroute to the
        // delay queue when d>0 — the same up-front `d` governs both legs.
        _payUserColl(_activePool, borrower, gross, dl);
    }

    /// @dev Settle the (post-fee) borrower USER leg of a voluntary collateral-out.
    ///      When the perimeter quotes no delay (`d == 0`) this is the EXISTING
    ///      native payout, byte-for-byte unchanged (`sendETH(receiver, amount)`).
    ///      When `d > 0` the leg is rerouted into the ExitDelayQueue: ActivePool
    ///      PUSHES the native RBTC to the queue, immediately followed by
    ///      `recordReceivedNativeExit` in the SAME outer tx — both INSIDE this
    ///      `d > 0` branch so the queue is never touched until a delay is
    ///      established off-queue, and a record revert rolls back the push
    ///      (fail-CLOSED: after the trove state already mutated, the whole
    ///      close/adjust reverts atomically — a bricked queue blocks Zero closes
    ///      until the kill switch is flipped). The queue's `receive()` is
    ///      unconditional and, via measured-receipt, credits EXACTLY `amount` when
    ///      its surplus `>= amount` — a donation cannot brick the record.
    function _payUserColl(
        IActivePool _activePool,
        address receiver,
        uint256 amount,
        DelayLeg memory dl
    ) private {
        // A net leg can be 0 on a full-fee edge; nothing to pay or escrow.
        if (amount == 0) {
            return;
        }

        if (dl.d > 0) {
            address queue = exitDelayQueue();
            // FAIL-CLOSED: once the perimeter quotes d>0 the user leg MUST escrow.
            // An unwired queue reverts the exit with a DISTINCT selector (halt
            // monitoring) — a delay can never be silently bypassed by a missing
            // pointer.
            require(queue != address(0), "PERIMETER:queue-unset");
            require(amount <= uint256(uint128(-1)), "PERIMETER:amount-too-large");

            // PUSH native to the queue (reuses the existing fail-closed sendETH
            // primitive — ActivePool.ETH decrements by exactly `amount`, identical
            // to the direct payout), then measured-record in the SAME outer tx.
            _activePool.sendETH(queue, amount);
            IExitDelayQueueHook(queue).recordReceivedNativeExit(
                uint128(amount),
                dl.d,
                PERIMETER_SURFACE_ZERO_WITHDRAW_COLL,
                address(0),
                dl.effOrig,
                dl.effOwner,
                receiver
            );
        } else {
            _activePool.sendETH(receiver, amount); // EXISTING native payout, unchanged
        }
    }

    /// @dev Fail-open quote wrapper. On a missing/reverting controller or a
    ///      semantically invalid quote, returns a non-charging quote with
    ///      `netAmount == gross`. The validity gate uses subtraction only
    ///      (`feeAmount > gross`), never an unchecked addition, and recomputes
    ///      `netAmount = gross - feeAmount` so the fee + user legs always sum to
    ///      exactly `gross` — protecting ActivePool liquidity from a bad or
    ///      upgraded controller.
    function _safeQuote(
        bytes32 surfaceId,
        address subProduct,
        address actor,
        uint256 gross
    ) private view returns (IExitFeeController.ExitFeeQuote memory q) {
        address ctrl = exitFeeController();
        // Fail open on a missing OR code-less controller. The address(0) check
        // alone is not enough: a high-level call to any no-code address (EOA,
        // or a controller that self-destructed after being set) reverts with
        // "function call to a non-contract account", which 0.6.11 try/catch
        // does NOT catch — so guard on extcodesize before the call.
        uint256 ctrlSize;
        assembly {
            ctrlSize := extcodesize(ctrl)
        }
        if (ctrl == address(0) || ctrlSize == 0) {
            q.netAmount = gross;
            q.reason = uint8(IExitFeeController.SkipReason.CONTROLLER_REVERT);
            return q;
        }
        try IExitFeeController(ctrl).quoteExitFee(surfaceId, subProduct, actor, gross) returns (
            IExitFeeController.ExitFeeQuote memory got
        ) {
            // Pool conservation is the consumer's own concern: it holds exactly `gross`
            // wei to distribute, so it must never be asked to pay out more. A
            // feeAmount > gross would underflow the net recompute below (bricking the
            // exit) and a fee leg > gross could draw OTHER troves' collateral out of
            // ActivePool. Rate, receiver, and fee policy are the configured
            // controller's responsibility — not re-validated here.
            if (got.feeAmount > gross) {
                // Override only the verdict; leave the controller's raw feeAmount /
                // rateBps / feeReceiver intact (active=false gates charging downstream).
                got.active = false;
                got.netAmount = gross; // non-charging shape: net == gross
                got.reason = uint8(IExitFeeController.SkipReason.INVALID_QUOTE);
                return got;
            }
            got.netAmount = gross - got.feeAmount; // fee + net == gross (no residue)
            return got;
        } catch {
            q.netAmount = gross;
            q.reason = uint8(IExitFeeController.SkipReason.CONTROLLER_REVERT);
        }
    }

    /// @dev Fail-CLOSED delay quote wrapper. Resolves the single hook
    ///      entry `quoteExitDelayFor` on the shared Perimeter controller and returns
    ///      `(d, effOrig, effOwner)`. Two levels, deliberately distinct:
    ///        1. controller-POINTER lookup is FAIL-OPEN — a missing OR code-less
    ///           controller ⇒ perimeter unwired ⇒ `(0, raw, raw)` ⇒ pay direct
    ///           (mirrors the fee path; also, 0.6.11 try/catch does NOT catch a
    ///           call to a no-code address, so the extcodesize guard is required);
    ///        2. once a controller is resolved, the `quoteExitDelayFor` CALL is
    ///           FAIL-CLOSED — a revert reverts the whole exit and MUST NOT be
    ///           interpreted as `d = 0`-direct (that would silently disable the
    ///           perimeter — the hazard this guards against). Uses a DISTINCT revert selector for
    ///           halt monitoring.
    ///      The `!securityPerimeterEnabled` short-circuit is the FIRST statement
    ///      inside `quoteExitDelayFor`, so a healthy-but-disabled perimeter returns
    ///      `(0, raw, owner)` normally (liveness escape). The hook ignores
    ///      `effOrig`/`effOwner` whenever `d == 0`.
    function _safeQuoteExitDelay(
        address rawOriginator,
        address owner,
        address receiver
    ) private view returns (uint32 d, address effOrig, address effOwner) {
        address ctrl = exitFeeController();
        uint256 ctrlSize;
        assembly {
            ctrlSize := extcodesize(ctrl)
        }
        // Level 1 — FAIL-OPEN pointer lookup: unwired/unreachable ⇒ direct pay.
        // Raw identities are returned but the caller ignores them when d == 0.
        if (ctrl == address(0) || ctrlSize == 0) {
            return (0, rawOriginator, owner);
        }
        // Level 2 — FAIL-CLOSED quote: a controller revert reverts the exit.
        try
            IExitFeeController(ctrl).quoteExitDelayFor(
                rawOriginator,
                owner,
                receiver,
                PERIMETER_SURFACE_ZERO_WITHDRAW_COLL,
                address(0)
            )
        returns (uint32 d_, address effOrig_, address effOwner_) {
            return (d_, effOrig_, effOwner_);
        } catch {
            revert("PERIMETER:delay-quote-failed");
        }
    }

    /// @dev Bundles the resolved delay-leg fields so `_payUserColl` stays a
    ///      single-slot call and `_sendCollWithExitFee` does not run into the
    ///      0.6.11 stack-depth limit. `d == 0` ⇒ perimeter off / bypassed /
    ///      unwired ⇒ pay direct. Zero surface has no passthrough, so
    ///      `effOrig`/`effOwner` are the raw identities.
    struct DelayLeg {
        uint32 d;
        address effOrig;
        address effOwner;
    }
}
