// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "../Interfaces/IBorrowerOperations.sol";

/// @notice Test attacker: attempts to re-enter BorrowerOperations.claimCollateral()
///         from its receive() while the surplus payout is in flight. CEI in
///         CollSurplusPool zeroes the balance before paying, so the reentrant
///         claim must hit "No collateral available to claim"; the attacker
///         swallows that revert (recording it) so the outer claim completes.
contract ReentrantSurplusClaimer {
    IBorrowerOperations public borrowerOperations;
    bool public reentryAttempted;
    bool public reentrySucceeded;
    uint256 public totalReceived;

    constructor(IBorrowerOperations _borrowerOperations) public {
        borrowerOperations = _borrowerOperations;
    }

    /// Open a trove owned by this contract (so a full redemption parks its
    /// surplus here and claimCollateral() pays out to this receive()).
    function openTrove(
        uint256 _maxFee,
        uint256 _zusdAmount,
        address _upperHint,
        address _lowerHint
    ) external payable {
        borrowerOperations.openTrove{ value: msg.value }(
            _maxFee,
            _zusdAmount,
            _upperHint,
            _lowerHint
        );
    }

    function claim() external {
        borrowerOperations.claimCollateral();
    }

    receive() external payable {
        totalReceived += msg.value;
        if (!reentryAttempted) {
            reentryAttempted = true;
            try borrowerOperations.claimCollateral() {
                reentrySucceeded = true;
            } catch {}
        }
    }
}
