// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "./Dependencies/Ownable.sol";
import "./Dependencies/SafeMath.sol";
import "./Interfaces/IRedemptionBuffer.sol";
import "./Interfaces/IFeeDistributor.sol";

/**
 * @title RedemptionBuffer
 * @notice
 *  A simple RBTC/ETH holding contract used as a "buffer" liquidity source for redemptions.
 *
 *  Conceptually, this contract acts like a small collateral pool that can be tapped by TroveManager
 *  during redemptions (or used to forward collateral to FeeDistributor / stakers).
 *
 *  Important high-level roles:
 *   - borrowerOperations: allowed to deposit collateral into this buffer (system-controlled inflows)
 *   - troveManager: allowed to withdraw collateral from this buffer for redemptions (system-controlled outflows)
 *   - owner: allowed to configure addresses and optionally forward buffer collateral to stakers
 *
 * @dev
 *  - This contract tracks collateral using `totalBufferedColl`, not by reading `address(this).balance` each time.
 *    Under normal operation those should match, but they can diverge if ETH/RBTC is forced into this contract
 *    (e.g., via SELFDESTRUCT), which is why `syncBalance()` exists.
 *  - ETH here represents RBTC on Rootstock deployments, but the EVM semantics are identical.
 *  - Uses SafeMath because Solidity 0.6.x does not have built-in overflow/underflow checking.
 *
 *  SECURITY NOTES:
 *  - withdrawForRedemption() sends ETH via low-level call. State is updated *before* the call,
 *    which is the correct “checks-effects-interactions” order. However, the recipient `_to`
 *    could be a contract and could attempt re-entrancy *through TroveManager*.
 *    The onlyTroveManager gate prevents direct reentry into this contract, but it does not
 *    prevent the recipient from calling TroveManager again, which could call back here.
 *    The system is typically protected by TroveManager’s own nonReentrant / flow constraints.
 *  - setAddresses() can be called multiple times by the owner. This is powerful admin control.
 *    Many deployments prefer “one-time initialization” patterns; here it is intentionally mutable.
 */
contract RedemptionBuffer is Ownable, IRedemptionBuffer {
    using SafeMath for uint256;

    // ---------------------------------------------------------------------
    // System wiring (privileged counterpart contracts)
    // ---------------------------------------------------------------------

    /// @notice Contract allowed to deposit collateral into the buffer.
    /// @dev Typically a core system module (BorrowerOperations) that accumulates collateral destined for the buffer.
    address public borrowerOperations;

    /// @notice Contract allowed to withdraw collateral from the buffer for redemption execution.
    /// @dev Typically TroveManager (or TroveManager via delegatecall modules) pulls collateral out to pay redeemers/fees.
    address public troveManager;

    /// @notice FeeDistributor that can receive RBTC/ETH and distribute it (and potentially paired ZUSD flows).
    /// @dev This is an interface reference to the current configured FeeDistributor.
    IFeeDistributor public feeDistributor;

    // ---------------------------------------------------------------------
    // Accounting
    // ---------------------------------------------------------------------

    /**
     * @notice Total amount of collateral (RBTC/ETH) that this buffer considers “available”.
     *
     * @dev
     *  - This is updated on:
     *      * deposit() (restricted inflow)
     *      * receive() (unrestricted inflow, e.g. direct transfers)
     *      * withdrawForRedemption() (restricted outflow)
     *      * distributeToStakers() (restricted outflow)
     *      * syncBalance() (admin repair)
     *
     *  - Ideally: totalBufferedColl == address(this).balance
     *    But the EVM allows ETH to be forcibly sent to a contract without calling receive()
     *    (e.g., via selfdestruct), so syncBalance() exists to reconcile.
     */
    uint256 public totalBufferedColl;

    // ---------------------------------------------------------------------
    // Access control modifiers
    // ---------------------------------------------------------------------

    /// @dev Restricts function access to BorrowerOperations only.
    modifier onlyBorrowerOps() {
        require(msg.sender == borrowerOperations, "RB: caller is not BorrowerOperations");
        _;
    }

    /// @dev Restricts function access to TroveManager only.
    modifier onlyTroveManager() {
        require(msg.sender == troveManager, "RB: caller is not TroveManager");
        _;
    }

    // ---------------------------------------------------------------------
    // Admin configuration
    // ---------------------------------------------------------------------

    /**
     * @notice Configure core counterpart addresses.
     * @dev onlyOwner — typically the deployer / governance multisig.
     *
     * Requirements:
     *  - none of the addresses may be zero
     *
     * Operational note:
     *  - This function does not emit an event (by design in your snippet).
     *    In many deployments, emitting an event is useful for indexers/audits.
     *  - This function can be called multiple times. This implies the owner can
     *    rotate system contracts (upgrades/migrations).
     */
    function setAddresses(
        address _borrowerOps,
        address _troveManager,
        address _feeDistributor
    ) external onlyOwner {
        require(_borrowerOps != address(0), "RB: zero borrowerOps");
        require(_troveManager != address(0), "RB: zero troveManager");
        require(_feeDistributor != address(0), "RB: zero feeDistributor");

        borrowerOperations = _borrowerOps;
        troveManager = _troveManager;
        feeDistributor = IFeeDistributor(_feeDistributor);
    }

    // ---------------------------------------------------------------------
    // Inflows
    // ---------------------------------------------------------------------

    /**
     * @notice Deposit collateral into the buffer.
     * @dev
     *  - Only BorrowerOperations may call this. This prevents arbitrary users
     *    from “pretending” to be part of system inflows. (Though allowing public
     *    deposits would not steal funds — it would only add buffer liquidity.)
     *  - Payable: msg.value is the RBTC/ETH amount deposited.
     *
     * Accounting:
     *  - Increments totalBufferedColl by msg.value.
     */
    function deposit() external payable override onlyBorrowerOps {
        require(msg.value > 0, "RB: no value");
        totalBufferedColl = totalBufferedColl.add(msg.value);
    }

    // ---------------------------------------------------------------------
    // Outflows used during redemption execution
    // ---------------------------------------------------------------------

    /**
     * @notice Withdraw collateral from the buffer to fulfill a redemption payment or fee payment.
     *
     * @dev
     *  - Only TroveManager may call this. In your updated TroveManagerRedeemOps flow,
     *    this is used to:
     *      * send net RBTC to redeemers for the "buffer portion" of a redemption, and/or
     *      * send the "buffer fee" portion to FeeDistributor.
     *  - Uses low-level call to forward ETH/RBTC and bubble success/failure.
     *
     * Security / correctness:
     *  - Checks buffer sufficiency first.
     *  - Updates state (totalBufferedColl) before external call (CEI pattern).
     *  - Reentrancy considerations:
     *      * Direct reentry into this function is blocked unless msg.sender == troveManager.
     *      * However, the recipient `_to` could be a contract and could call TroveManager again,
     *        potentially causing another withdraw call. The system generally relies on TroveManager’s
     *        own execution invariants / reentrancy protections to make this safe.
     */
    function withdrawForRedemption(address payable _to, uint256 _amount)
        external
        override
        onlyTroveManager
    {
        require(_amount <= totalBufferedColl, "RB: insufficient buffer");

        // Effects: decrement internal accounting first.
        totalBufferedColl = totalBufferedColl.sub(_amount);

        // Interaction: send RBTC/ETH out.
        (bool success, ) = _to.call{ value: _amount }("");
        require(success, "RB: send failed");
    }

    // ---------------------------------------------------------------------
    // Optional outflow to stakers / FeeDistributor
    // ---------------------------------------------------------------------

    /**
     * @notice Push a portion of the buffer collateral into FeeDistributor, then trigger distribution.
     *
     * @dev
     *  - onlyOwner: this is an admin/governance action, not a redemption action.
     *  - This function is useful if the system wants to periodically route buffer collateral
     *    to stakers (or other fee recipients) without waiting for redemptions.
     *
     * Requirements:
     *  - feeDistributor must be configured
     *  - `_amount` must be available in the buffer
     *
     * Flow:
     *  1) decrement buffer accounting
     *  2) send ETH/RBTC to feeDistributor (low-level call)
     *  3) call feeDistributor.distributeFees()
     *
     * NOTE:
     *  - The low-level call sends plain ETH. FeeDistributor must have a receive/fallback
     *    that accepts ETH; otherwise this reverts.
     *  - The comment “With the FeeDistributor patch above, this can now succeed.”
     *    indicates FeeDistributor was modified to properly accept ETH and/or distribution semantics.
     */
    function distributeToStakers(uint256 _amount) external override onlyOwner {
        require(address(feeDistributor) != address(0), "RB: feeDistributor not set");
        require(_amount <= totalBufferedColl, "RB: insufficient buffer");

        // Effects: decrement internal accounting first.
        totalBufferedColl = totalBufferedColl.sub(_amount);

        // Interaction: transfer RBTC/ETH to FeeDistributor.
        (bool success, ) = address(feeDistributor).call{ value: _amount }("");
        require(success, "RB: send to feeDistributor failed");

        // With the FeeDistributor patch above, this can now succeed.
        feeDistributor.distributeFees();
    }

    // ---------------------------------------------------------------------
    // Admin maintenance / accounting reconciliation
    // ---------------------------------------------------------------------

    /**
     * @notice Force internal accounting to match actual on-chain balance.
     * @dev onlyOwner.
     *
     * Why this exists:
     *  - ETH can be forced into a contract without triggering receive()
     *    (e.g. via SELFDESTRUCT). In such a case, address(this).balance increases
     *    but totalBufferedColl does not, causing getBalance() to underreport.
     *
     * When to use:
     *  - Typically only during migrations, after unexpected forced transfers,
     *    or as part of operational “sanity repair” procedures.
     */
    function syncBalance() external onlyOwner {
        totalBufferedColl = address(this).balance;
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice Returns the buffer’s tracked collateral balance.
     * @dev This returns totalBufferedColl, not necessarily address(this).balance (see syncBalance()).
     */
    function getBalance() external view override returns (uint256) {
        return totalBufferedColl;
    }

    // ---------------------------------------------------------------------
    // Fallback receive hook
    // ---------------------------------------------------------------------

    /**
     * @notice Accept direct ETH/RBTC transfers.
     *
     * @dev
     *  - This is intentionally NOT restricted. Anyone can top up the buffer,
     *    which can only help the system (it increases available redemption liquidity).
     *  - The accounting variable is incremented by msg.value.
     *  - If ETH is forced in (SELFDESTRUCT), this function is not executed; use syncBalance().
     */
    receive() external payable {
        totalBufferedColl = totalBufferedColl.add(msg.value);
    }
}
