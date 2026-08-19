// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

interface ICollSurplusPool {
    // --- Events ---

    event BorrowerOperationsAddressChanged(address _newBorrowerOperationsAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _newActivePoolAddress);

    event CollBalanceUpdated(address indexed _account, uint256 _newBalance);
    event EtherSent(address _to, uint256 _amount);

    // --- Contract setters ---

    /**
     * @notice Called only once on init, to set addresses of other Zero contracts. Callable only by owner
     * @dev initializer function, checks addresses are contracts
     * @param _borrowerOperationsAddress BorrowerOperations contract address
     * @param _troveManagerAddress TroveManager contract address
     * @param _activePoolAddress ActivePool contract address
     */
    function setAddresses(
        address _borrowerOperationsAddress,
        address _troveManagerAddress,
        address _activePoolAddress
    ) external;

    /// @notice Not necessarily equal to the raw ether balance - ether can be forcibly sent to contracts.
    /// @return ETH state variable
    function getETH() external view returns (uint256);

    /// @param _account account to retrieve collateral
    /// @return collateral
    function getCollateral(address _account) external view returns (uint256);

    /// @notice adds amount to current account balance. Only callable by TroveManager.
    /// @param _account account to add amount
    /// @param _amount amount to add
    function accountSurplus(address _account, uint256 _amount) external;

    /// @notice claims collateral for given account. Only callable by BorrowerOperations.
    /// @param _account account to send claimable collateral
    function claimColl(address _account) external;

    /// @notice Two-leg claim: `_feeAmount` to `_feeReceiver`, remainder to `_account`.
    ///         Only callable by BorrowerOperations (the Perimeter surplus-claim hook).
    ///         The fee leg is fail-open: if the fee transfer fails, `_account`
    ///         receives the full claimable balance.
    /// @param _account account whose claimable collateral is paid out
    /// @param _feeReceiver Perimeter fee destination for the fee leg
    /// @param _feeAmount fee in wei; must not exceed the account's claimable balance
    /// @return feePaid true iff the fee transfer succeeded (caller emits the matching event)
    function claimCollWithFee(
        address _account,
        address _feeReceiver,
        uint256 _feeAmount
    ) external returns (bool feePaid);
}
