# Analysis of functions that invoke sendETH
_Exported on 7/29/2025 at 22:10:31 GMT-4 from Cursor (1.2.4)_

---

**User**

Do an exhaustive analysis of the content of this project and list all functions - internal, private, external and public - that directly or indirectly invoke the `sendETH` function of the `ActivePool` contract.

For example, if the internal function `_redeemCollateral` of the `TroveManagerRedeemOps.sol` contract directly calls `sendETH`, I need you to continue upstream and determine all the functions that invoke `_redeemCollateral` and so on until reaching the highest level function that an EOA user has access to.

Do you understand the task?

---

**Cursor**

Yes, I understand perfectly.

1. We'll start from the `sendETH` function in the `ActivePool` contract.
2. We'll locate all direct invocations (e.g. `activePool.sendETH(...)`) throughout the project.
3. For each function that invokes it directly, we'll recursively track who calls it, distinguishing whether the call is internal/private or external/public.
4. We'll continue the "upward" traversal until reaching the highest level functions that an EOA can invoke (external/public functions without special restrictions other than normal modifiers).
5. We'll group the results by contract, indicating:
   • Visibility type of each function
   • File paths and line number (for quick reference)
   • Call sequence connecting each high-level function with `sendETH`.

I'll proceed to generate that call graph and present the complete list.

---

**User**

please proceed to make the complete list of functions as I have requested

---

**Cursor**

Here is the complete map of calls to `ActivePool.sendETH` throughout the project.
For each contract I show:

• The function where the call to `sendETH` appears (DIRECT).
• All functions that invoke it INDIRECTLY (in cascade).
• The paths to the highest layer accessible by an EOA.
In parentheses I indicate the visibility type and line number where the function begins.

────────────────────────────────────────────
CONTRACT: BorrowerOperations.sol
────────────────────────────────────────────
1.  _closeTrove --► sendETH               (internal)   728  
      EOA Routes → … → _closeTrove → sendETH  
      • closeTrove()                (external) 695  
      • closeNueTrove()             (external) 699  
      • closeNueTroveWithPermit2()  (external) 713  

2.  _moveTokensAndETHfromAdjustment --► sendETH  (internal) 838  
      Indirect:  
      • _adjustSenderTrove()        (internal) 572  
      • _adjustTrove()              (internal) 523  
      • _adjustNueTrove()           (internal) 444  
      • _adjustNueTroveWithPermit2()(internal) 507  
      • _withdrawZusdTo()           (internal) 545  

      Typical EOA routes → … → _adjustSenderTrove → _moveTokensAndETHfromAdjustment → sendETH  
      High-level functions that lead to the above chain:  
      • addColl()                                 (external) 285  
      • withdrawColl()                            (external) 300  
      • withdrawZUSD()                            (external) 308  
      • withdrawZusdAndConvertToDLLR()            (external) 321  
      • adjustTrove()                             (external) 380  
      • adjustNueTrove()                          (external) 401  
      • adjustNueTroveWithPermit2()               (external) 421  
      • repayZUSD()                               (external) 350  
      • repayZusdFromDLLR()                       (external) 359  
      • repayZusdFromDLLRWithPermit2()            (external) 370  
      • moveETHGainToTrove()  (external, StabilityPool only) 290  

────────────────────────────────────────────
CONTRACT: TroveManager.sol
────────────────────────────────────────────
DIRECT calls to sendETH
a) liquidateTroves()               (external) 394  
   --► contractsCache.activePool.sendETH(…)       443  
   --► _sendGasCompensation() → sendETH           464  
   --► _redistributeDebtAndColl() → sendETH       436  

b) batchLiquidateTroves()          (public) 597  
   --► activePoolCached.sendETH(…)                641  
   --► _sendGasCompensation() → sendETH           662  
   --► _redistributeDebtAndColl() → sendETH       634  

INTERNAL functions where sendETH is executed  
• _sendGasCompensation()           (internal) 823 → _activePool.sendETH  
• _redistributeDebtAndColl()       (internal) 893 → _activePool.sendETH  

Internal functions that call the above two (don't use sendETH themselves, but lead to it)  
• none additional: both are only invoked from liquidateTroves / batchLiquidateTroves.

EOA Routes:  
EOA → liquidateTroves()   → (direct & via internals) → sendETH  
EOA → batchLiquidateTroves() → (direct & via internals) → sendETH  

────────────────────────────────────────────
CONTRACT: TroveManagerRedeemOps.sol
(Used via delegatecall from TroveManager)
────────────────────────────────────────────
1. _redeemCollateral() --► sendETH                              (internal) 64  
2. _redeemCloseTrove() --► sendETH                              (internal) 366  

Internal functions that lead to them:  
• _redeemCollateralFromTrove() (internal) 262 → can call _redeemCloseTrove.  

EXTERNAL functions (EOA) that reach sendETH:  
• redeemCollateral()                       (external) 44 → _redeemCollateral → sendETH  
• redeemCollateralViaDLLR()                (external) 185 → _redeemCollateral → sendETH  
• redeemCollateralViaDllrWithPermit2()     (external) 213 → _redeemCollateral → sendETH  

────────────────────────────────────────────
CONTRACT: StabilityPool.sol
────────────────────────────────────────────
• _moveOffsetCollAndDebt() --► sendETH        (internal) 636  
   invoked by: offset() (external) 519 – only TroveManager can call it.  

Chain to EOA:  
EOA → TroveManager.liquidateTroves / batchLiquidateTroves  
     → StabilityPool.offset() (from TroveManager)  
        → _moveOffsetCollAndDebt() → sendETH  

────────────────────────────────────────────
SUMMARY OF FUNCTIONS THAT (DIRECTLY OR INDIRECTLY) TRIGGER sendETH
────────────────────────────────────────────
BorrowerOperations.sol (17)  
  External/Public: addColl, withdrawColl, withdrawZUSD, withdrawZusdAndConvertToDLLR,  
    adjustTrove, adjustNueTrove, adjustNueTroveWithPermit2, repayZUSD, repayZusdFromDLLR,  
    repayZusdFromDLLRWithPermit2, closeTrove, closeNueTrove, closeNueTroveWithPermit2,  
    moveETHGainToTrove.  
  Internal: _closeTrove, _moveTokensAndETHfromAdjustment, _adjustSenderTrove,  
    _adjustTrove, _adjustNueTrove, _adjustNueTroveWithPermit2, _withdrawZusdTo.  

TroveManager.sol (4 direct + 2 external)  
  Direct internal: _sendGasCompensation, _redistributeDebtAndColl  
  External/Public: liquidateTroves, batchLiquidateTroves  

TroveManagerRedeemOps.sol (3 external + 3 internal)  
  External: redeemCollateral, redeemCollateralViaDLLR, redeemCollateralViaDllrWithPermit2  
  Internal: _redeemCollateral, _redeemCloseTrove, _redeemCollateralFromTrove  

StabilityPool.sol  
  Internal: _moveOffsetCollAndDebt  
  External: offset (not EOA; only TroveManager)  

With this you have the exhaustive overview of all functions —of any visibility— that end up executing `ActivePool.sendETH`, along with the routes that connect them up to the level where an EOA can initiate them.

---

**User**

carefully review each of the functions you just listed and analyze which of these cases might need to leave open the possibility of sending native currency (ETH) to the zero address

---

**Cursor**

Analysis of whether `ActivePool.sendETH()` should accept `address(0)`
(an explicit "burn" of RBTC/ETH) in each of the detected routes:

───────────────────────────────
1. BorrowerOperations.sol
───────────────────────────────
a) _closeTrove → sendETH(msg.sender, coll)  
   • `msg.sender` can never be `address(0)` (neither EOAs nor contracts can emit txs from 0x0).  
   • Purpose: return collateral to user.  --> Burning makes no sense.

b) _moveTokensAndETHfromAdjustment → sendETH(_borrower, _collChange)  
   • `_borrower` always comes from:
     – msg.sender in normal operations  
     – Explicit parameter passed by StabilityPool in `moveETHGainToTrove`,  
       but trove must be active (`_requireTroveisActive`).  
   • A trove with owner 0x0 cannot exist, so the route to 0x0 is closed.  
   • This is not about burning funds, but withdrawing them to the borrower.  

BorrowerOperations Conclusion: In NO FLOW is 0x0 desirable/possible.

───────────────────────────────
2. TroveManager.sol
───────────────────────────────
Direct routes:

• liquidateTroves / batchLiquidateTroves  
  – sendETH(address(collSurplusPool), …)  
  – sendETH(_liquidator, …)  
  – _redistributeDebtAndColl → sendETH(address(_defaultPool), …)  

• Verifications:
  – `collSurplusPool` and `defaultPool` are set via `setAddresses` with `checkContract`,  
    which rejects 0x0 (size == 0).  
  – `_liquidator` is `msg.sender`, never 0x0.

Edge case: if **owner doesn't call `setAddresses`** before first liquidation,  
`collSurplusPool` or `defaultPool` would remain zero and ETH would be sent to 0x0.  
This would be a configuration failure, not a functional requirement.

TroveManager Conclusion: only a *mis-setup* could lead to 0x0; it's not desired.

───────────────────────────────
3. TroveManagerRedeemOps.sol  (delegatecall from TroveManager)
───────────────────────────────
• sendETH(address(feeDistributor), fee)  
• sendETH(msg.sender, ETHToSendToRedeemer)  
• sendETH(address(collSurplusPool), ETH)  

`feeDistributor` and `collSurplusPool` are validated with `checkContract` in TroveManager,  
and `msg.sender` cannot be 0x0.  
No burning logic exists.  

───────────────────────────────
4. StabilityPool.sol
───────────────────────────────
• _moveOffsetCollAndDebt → sendETH(address(this), _collToAdd)  
  – `address(this)` is always different from 0x0.  
  – Purpose: move collateral from ActivePool to StabilityPool.  

───────────────────────────────
Final Summary
───────────────────────────────
1. None of the contemplated business flows **requires** or **desires** to send ETH to `address(0)`.  
2. The only way it could happen is through **incorrect configuration** (omitted setter) that leaves some dependent addresses at zero before the first real operation.  
3. If the project policy is "prohibit accidental burns", it would be convenient to:
   • Add `require(_account != address(0), "ActivePool: zero address")` in `sendETH`, **or**  
   • Add `require(address(collSurplusPool) != address(0))`, etc., before each critical use.  

If these safeguards are not implemented, the system will continue to allow involuntary burning, but **there is no legitimate use case where burning ETH is necessary** according to the current contract logic.
