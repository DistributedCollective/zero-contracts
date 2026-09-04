// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

/// @title  Echidna harness stubs
/// @notice Inert stand-ins for the peripheral contracts the core `setAddresses`
///         calls now `checkContract`, but which the fuzzed trove/SP lifecycle
///         only ever stores (zero token / staking) or calls in a way that is
///         value-neutral (fee distributor, community issuance). They exist so
///         the full system deploys; they deliberately do nothing so the
///         inherited Liquity invariants keep holding under the fuzzer.

/// Fee distributor: the borrowing-fee leg mints ZUSD here and the redemption
/// leg sends RBTC here (via `ActivePool.sendETH`, a `call` that requires
/// success) before invoking `distributeFees`. Leaving the value parked is
/// exactly what `echidna_ZUSD_global_balances` expects (ZUSD at external
/// addresses) and is invisible to `echidna_ETH_balances` (not a checked pool).
contract EchidnaFeeDistributorStub {
    function distributeFees() external {}

    receive() external payable {}
}

/// Community issuance: `StabilityPool` calls `issueSOV` on every
/// deposit/withdraw/offset and `sendSOV` to pay gains. Returning 0 issuance
/// makes `_updateG` early-return, so no SOV gain ever accrues — value-neutral
/// for the ZUSD/ETH invariants.
contract EchidnaCommunityIssuanceStub {
    function issueSOV(uint256) external returns (uint256) {
        return 0;
    }

    function sendSOV(address, uint256) external {}
}

/// ZERO token / staking: only `checkContract`-ed at wiring time and stored;
/// never called on the fuzzed path, so bytecode presence is all that is needed.
contract EchidnaInertStub {

}
