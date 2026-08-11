// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "./EchidnaTester.sol";
import "./ExitFeeControllerMock.sol";

/// @title  EchidnaColFeeTester
/// @notice Re-runs the full Zero Echidna campaign with the ColFee exit fee
///         ACTIVE, so every collateral exit driven by the actor proxies routes
///         through the fee hook (`_sendCollWithExitFee`) with a real fee leg.
///
///         The ColFee load-bearing invariant is the inherited
///         `echidna_ETH_balances`:
///           - `borrowerOperations` holds 0 ETH — the fee leg never strands ETH
///             in BorrowerOperations;
///           - each pool's real balance == its internal `getETH()` accounting —
///             the fee leg's `ActivePool.sendETH` keeps balance and accounting
///             in sync, so no ETH is created, destroyed, or double-counted by
///             the fee.
///         A fee-leg accounting bug breaks it. The two added invariants below
///         guard that the run is genuinely exercising ColFee (not vacuous) and
///         that ETH reaches the fee receiver only through the accounted leg.
///
///         Note: the inherited `echidna_canary_*` properties are Liquity's
///         coverage markers and are EXPECTED to be falsified once the actors
///         open troves / fund the pool — that is their purpose, not a ColFee
///         failure. The meaningful result is that `echidna_ETH_balances`,
///         `echidna_trove_properties`, `echidna_troves_order`,
///         `echidna_ZUSD_global_balances`, and the two `echidna_colfee_*`
///         invariants below HOLD with the fee active.
///
///         Run (from repo root, project/hardhat mode so the CryptoEnv-wrapped
///         compile resolves — the single-file form needs a bare `solc` on PATH):
///           __decryptionAlreadyDone__=TRUE echidna . \
///             --contract EchidnaColFeeTester \
///             --config fuzzTests/js/echidna_config.yaml
contract EchidnaColFeeTester is EchidnaTester {
    // Canonical deterministic Permit2 deployment address. Permit2 is not on any
    // ColFee path, so a fixed (codeless-in-VM) address is inert here; pinning it
    // lets Echidna deploy this tester with NO constructor arguments.
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    ExitFeeControllerMock public exitFeeCtrl;
    ColFeeEchidnaSink public feeSink;

    constructor() public payable EchidnaTester(PERMIT2) {
        feeSink = new ColFeeEchidnaSink();
        exitFeeCtrl = new ExitFeeControllerMock();
        // Active policy: 1% (100 bps) of the borrower's gross collateral, paid
        // to a sink that accepts ETH (so the fee leg settles, exercising the
        // ExitFeeApplied path rather than only the VAULT_REVERT fallback).
        exitFeeCtrl.configure(true, 100, address(feeSink), 0);
        // owner == this tester (Zero's setAddresses does not renounce).
        borrowerOperations.setExitFeeController(address(exitFeeCtrl));
    }

    /// Guards against a vacuous run: the controller stays pinned and active, so
    /// the inherited invariants are genuinely exercised WITH the fee in the loop.
    function echidna_colfee_controller_pinned() public view returns (bool) {
        return borrowerOperations.exitFeeController() == address(exitFeeCtrl);
    }

    /// ETH only reaches the fee receiver via the accounted fee leg: the sink's
    /// real balance equals the total it recorded receiving. (Combined with the
    /// inherited pool `balance == getETH()` invariant, this closes the loop on
    /// fee-leg value conservation.)
    function echidna_colfee_sink_synced() public view returns (bool) {
        return address(feeSink).balance == feeSink.totalReceived();
    }

    function exerciseColFeeExt() external {
        EchidnaProxy echidnaProxy = echidnaProxies[0];
        if (troveManager.getTroveDebt(address(echidnaProxy)) == 0) {
            openTroveExt(0, 1e23, 1e21);
        }

        uint amount = getAdjustedCollWithdrawal(address(echidnaProxy), 1e18);
        if (amount > 0) {
            echidnaProxy.withdrawCollPrx(amount, address(0), address(0));
        }
    }

    /// Canary: EXPECTED to be falsified once any exit charges a fee. If this
    /// stays passing, the campaign never exercised ColFee.
    function echidna_canary_colfee_charged() public view returns (bool) {
        return feeSink.totalReceived() == 0;
    }

    /// Fund a collateral surplus for an actor and claim it through the real
    /// BorrowerOperations hook with the fee ACTIVE. The tester owns the pool and
    /// Zero's setAddresses is re-callable, so it impersonates TroveManager and
    /// ActivePool for one atomic funding step (accountSurplus + backing ETH),
    /// restores the real wiring, then claims — exercising both the charging
    /// two-leg split (fee >= 1 wei at 100 bps needs amount >= 100) and, for dust
    /// amounts, the untouched claimColl fallback.
    function fundAndClaimSurplusExt(uint _i, uint _amount) external {
        EchidnaProxy echidnaProxy = echidnaProxies[_i % 100]; // 100 == NUMBER_OF_ACTORS (private in base)
        uint amount = 1 + (_amount % 1e21); // 1 wei .. 1000 ETH; tester balance is ample
        if (address(this).balance < amount) {
            return;
        }

        collSurplusPool.setAddresses(address(borrowerOperations), address(this), address(this));
        collSurplusPool.accountSurplus(address(echidnaProxy), amount);
        (bool funded, ) = address(collSurplusPool).call{ value: amount }("");
        require(funded);
        collSurplusPool.setAddresses(
            address(borrowerOperations),
            address(troveManager),
            address(activePool)
        );

        echidnaProxy.claimCollateralPrx();
    }

    /// CollSurplusPool conservation under the two-leg split: raw balance always
    /// equals the recorded ETH accounting (mirrors the inherited per-pool checks
    /// in echidna_ETH_balances, which predates ColFee and does not cover this pool).
    function echidna_colfee_surplus_pool_synced() public view returns (bool) {
        return address(collSurplusPool).balance == collSurplusPool.getETH();
    }
}

/// Minimal payable fee receiver that records what it is paid.
contract ColFeeEchidnaSink {
    uint256 public totalReceived;

    receive() external payable {
        totalReceived += msg.value;
    }
}
