// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./Interfaces/ICollSurplusPool.sol";
import "./Dependencies/SafeMath.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/console.sol";
import "./CollSurplusPoolStorage.sol";

contract CollSurplusPool is CollSurplusPoolStorage, CheckContract, ICollSurplusPool {
    using SafeMath for uint256;
    // --- Events ---

    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _newActivePoolAddress);

    event CollBalanceUpdated(address indexed _account, uint256 _newBalance);
    event EtherSent(address _to, uint256 _amount);

    // --- Contract setters ---

    function setAddresses(
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _activePoolAddress
    ) external override onlyOwner {
        checkContract(_borrowerOperationsAddress);
        checkContract(_troveManagerAddress);
        checkContract(_activePoolAddress);

        borrowerOperationsAddress = _borrowerOperationsAddress;
        troveManagerAddress = _troveManagerAddress;
        activePoolAddress = _activePoolAddress;

        emit BorrowerOperationsAddressChanged(_borrowerOperationsAddress);
        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);
    }

    /** Returns the ETH state variable at ActivePool address.
       Not necessarily equal to the raw ether balance - ether can be forcibly sent to contracts. */
    function getETH() external view override returns (uint256) {
        return ETH;
    }

    function getCollateral(address _account) external view override returns (uint256) {
        return balances[_account];
    }

    // --- Pool functionality ---

    function accountSurplus(address _account, uint256 _amount) external override {
        _requireCallerIsTroveManager();

        uint256 newAmount = balances[_account].add(_amount);
        balances[_account] = newAmount;

        emit CollBalanceUpdated(_account, newAmount);
    }

    function claimColl(address _account) external override {
        _requireCallerIsBorrowerOperations();
        uint256 claimableColl = balances[_account];
        require(claimableColl > 0, "CollSurplusPool: No collateral available to claim");

        balances[_account] = 0;
        emit CollBalanceUpdated(_account, 0);

        ETH = ETH.sub(claimableColl);
        emit EtherSent(_account, claimableColl);

        (bool success, ) = _account.call{ value: claimableColl }("");
        require(success, "CollSurplusPool: sending ETH failed");
    }

    /// @dev Gas forwarded to the fee receiver's receive hook. Ample for a receiver
    ///      that only accepts the transfer and logs, while guaranteeing a
    ///      gas-sinking receiver can never starve the claimant leg: a receiver
    ///      needing more gas makes the fee leg fail, which is fail-open — the
    ///      claimant then receives the full balance.
    uint256 private constant FEE_LEG_GAS_CAP = 100_000;

    /// @notice Two-leg claim: `_feeAmount` to `_feeReceiver`, remainder to `_account`.
    ///         Only callable by BorrowerOperations (the Perimeter surplus-claim hook);
    ///         `claimColl` remains the untouched non-charging path.
    ///         CEI: all effects (balance zeroing, ETH accounting) precede both external
    ///         calls, so a reentrant claim sees balances == 0 and reverts. The single
    ///         `ETH` decrement equals fee + net exactly. The fee leg is fail-open —
    ///         if it fails, the claimant receives the full balance; the user leg stays
    ///         fail-closed like `claimColl`.
    /// @return feePaid true iff the fee transfer succeeded (caller emits the matching event)
    function claimCollWithFee(
        address _account,
        address _feeReceiver,
        uint256 _feeAmount
    ) external override returns (bool feePaid) {
        _requireCallerIsBorrowerOperations();
        uint256 claimableColl = balances[_account];
        require(claimableColl > 0, "CollSurplusPool: No collateral available to claim");
        require(_feeAmount <= claimableColl, "CollSurplusPool: fee exceeds claimable");

        balances[_account] = 0;
        emit CollBalanceUpdated(_account, 0);

        ETH = ETH.sub(claimableColl);

        (feePaid, ) = _feeReceiver.call{ value: _feeAmount, gas: FEE_LEG_GAS_CAP }("");
        uint256 userAmount = feePaid ? claimableColl.sub(_feeAmount) : claimableColl;
        if (feePaid) {
            emit EtherSent(_feeReceiver, _feeAmount);
        }

        emit EtherSent(_account, userAmount);
        (bool success, ) = _account.call{ value: userAmount }("");
        require(success, "CollSurplusPool: sending ETH failed");
    }

    /// @notice Two-leg claim that sends the remainder to `_netRecipient`.
    ///         Same accounting and same CEI ordering as `claimCollWithFee`: the
    ///         claim is resolved against `_account`'s balance, which is zeroed
    ///         before either external call, and the single `ETH` decrement equals
    ///         fee + net exactly. Only the destination of the net leg differs, so
    ///         the perimeter can escrow it in the exit delay queue instead of
    ///         paying the claimant directly. The fee leg stays fail-open and the
    ///         net leg fail-closed.
    ///
    ///         `claimCollWithFee` is left exactly as deployed rather than
    ///         delegating here: it is the selector the shipped BorrowerOperations
    ///         calls, and it is the rollback target.
    function claimCollWithFeeTo(
        address _account,
        address _feeReceiver,
        uint256 _feeAmount,
        address _netRecipient
    ) external override returns (bool feePaid, uint256 netAmount) {
        _requireCallerIsBorrowerOperations();
        require(_netRecipient != address(0), "CollSurplusPool: zero net recipient");
        uint256 claimableColl = balances[_account];
        require(claimableColl > 0, "CollSurplusPool: No collateral available to claim");
        require(_feeAmount <= claimableColl, "CollSurplusPool: fee exceeds claimable");

        balances[_account] = 0;
        emit CollBalanceUpdated(_account, 0);

        ETH = ETH.sub(claimableColl);

        // A zero fee takes no leg at all: a zero-value call would report a fee
        // that was never charged, and an uncharged claim can still be delayed.
        if (_feeAmount > 0) {
            (feePaid, ) = _feeReceiver.call{ value: _feeAmount, gas: FEE_LEG_GAS_CAP }("");
            if (feePaid) {
                emit EtherSent(_feeReceiver, _feeAmount);
            }
        }
        netAmount = feePaid ? claimableColl.sub(_feeAmount) : claimableColl;

        emit EtherSent(_netRecipient, netAmount);
        (bool success, ) = _netRecipient.call{ value: netAmount }("");
        require(success, "CollSurplusPool: sending ETH failed");
    }

    // --- 'require' functions ---

    function _requireCallerIsBorrowerOperations() internal view {
        require(
            msg.sender == borrowerOperationsAddress,
            "CollSurplusPool: Caller is not Borrower Operations"
        );
    }

    function _requireCallerIsTroveManager() internal view {
        require(msg.sender == troveManagerAddress, "CollSurplusPool: Caller is not TroveManager");
    }

    function _requireCallerIsActivePool() internal view {
        require(msg.sender == activePoolAddress, "CollSurplusPool: Caller is not Active Pool");
    }

    // --- Fallback function ---

    receive() external payable {
        _requireCallerIsActivePool();
        ETH = ETH.add(msg.value);
    }
}
