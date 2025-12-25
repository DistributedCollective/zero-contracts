// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "../Dependencies/Mynt/IMassetManager.sol";
import "./IRedemptionBuffer.sol";
import { IPermit2, ISignatureTransfer } from "./IPermit2.sol";

/// @title IBorrowerOperations
/// @notice External interface for BorrowerOperations (opening/adjusting/closing troves).
/// @dev
///  Redemptions are handled by TroveManager/TroveManagerRedeemOps, but BorrowerOperations is
///  responsible for issuing debt and collecting:
///   - the normal ZUSD borrowing fee (paid in ZUSD and minted to FeeDistributor)
///   - the RedemptionBuffer fee (paid in RBTC and deposited into RedemptionBuffer)
interface IBorrowerOperations {
    // --- Events ---

    event FeeDistributorAddressChanged(address _feeDistributorAddress);
    event TroveManagerAddressChanged(address _newTroveManagerAddress);
    event ActivePoolAddressChanged(address _activePoolAddress);
    event DefaultPoolAddressChanged(address _defaultPoolAddress);
    event StabilityPoolAddressChanged(address _stabilityPoolAddress);
    event GasPoolAddressChanged(address _gasPoolAddress);
    event CollSurplusPoolAddressChanged(address _collSurplusPoolAddress);
    event PriceFeedAddressChanged(address _newPriceFeedAddress);
    event SortedTrovesAddressChanged(address _sortedTrovesAddress);
    event ZUSDTokenAddressChanged(address _zusdTokenAddress);
    event ZEROStakingAddressChanged(address _zeroStakingAddress);
    /// @notice Emitted when the Mynt/mAsset manager is configured.
    event MassetManagerAddressChanged(address _massetManagerAddress);
    /// @notice Emitted when the RedemptionBuffer contract address is updated.
    event RedemptionBufferAddressChanged(address _redemptionBufferAddress);
    /// @notice Emitted when the redemption buffer rate is updated.
    event RedemptionBufferRateChanged(uint256 _redemptionBufferRate);

    event TroveCreated(address indexed _borrower, uint256 arrayIndex);
    event TroveUpdated(
        address indexed _borrower,
        uint256 _debt,
        uint256 _coll,
        uint256 stake,
        uint8 operation
    );
    event ZUSDBorrowingFeePaid(address indexed _borrower, uint256 _ZUSDFee);

    // --- Functions ---

    /**
     * @notice Called only once on init, to set addresses of other Zero contracts. Callable only by owner
     * @dev initializer function, checks addresses are contracts
     * @param _feeDistributorAddress feeDistributor contract address
     * @param _liquityBaseParamsAddress LiquidityBaseParams contract address
     * @param _troveManagerAddress TroveManager contract address
     * @param _activePoolAddress ActivePool contract address
     * @param _defaultPoolAddress DefaultPool contract address
     * @param _stabilityPoolAddress StabilityPool contract address
     * @param _gasPoolAddress GasPool contract address
     * @param _collSurplusPoolAddress CollSurplusPool contract address
     * @param _priceFeedAddress PrideFeed contract address
     * @param _sortedTrovesAddress SortedTroves contract address
     * @param _zusdTokenAddress ZUSDToken contract address
     * @param _zeroStakingAddress ZEROStaking contract address
     */
    function setAddresses(
        address _feeDistributorAddress,
        address _liquityBaseParamsAddress,
        address _troveManagerAddress,
        address _activePoolAddress,
        address _defaultPoolAddress,
        address _stabilityPoolAddress,
        address _gasPoolAddress,
        address _collSurplusPoolAddress,
        address _priceFeedAddress,
        address _sortedTrovesAddress,
        address _zusdTokenAddress,
        address _zeroStakingAddress
    ) external;

    /// @notice Sets the Mynt/mAsset manager used for NUE/DLLR flows.
    /// @dev Owner/governance only in implementation.
    function setMassetManagerAddress(address _massetManagerAddress) external;
    
    // --- RedemptionBuffer configuration ---

    /// @notice Sets the RedemptionBuffer contract address.
    /// @dev Owner/governance only in implementation.
    function setRedemptionBufferAddress(address _buffer) external;

    /// @notice Sets the redemption buffer rate used to compute the RBTC fee.
    /// @dev 1e18 precision; 1e18 == 100%. Owner/governance only in implementation.
    function setRedemptionBufferRate(uint256 _rate) external;

    /// @notice Returns the configured RedemptionBuffer contract address.
    function getRedemptionBufferAddress() external view returns (address);

    /// @notice Returns the configured redemption buffer rate (1e18 precision).
    function getRedemptionBufferRate() external view returns (uint256);

    // --- RedemptionBuffer fee quoting ---

    /// @notice Quotes the extra RBTC (wei) required on top of collateral when borrowing `_ZUSDAmount`.
    /// @dev NOT view in many Liquity forks because priceFeed.fetchPrice() is non-view.
    ///      Frontends should call via eth_call/staticcall.
    function getRedemptionBufferFeeRBTC(uint256 _ZUSDAmount) external returns (uint256);

    /// @notice View-only quote that uses a caller-supplied price.
    /// @dev Lets frontends avoid calling BorrowerOperations.getRedemptionBufferFeeRBTC()
    ///      if they already have a price from elsewhere. The implementation should mirror the
    ///      exact arithmetic (including rounding) used by openTrove/adjustTrove.
    /// @param _ZUSDAmount Amount of new ZUSD debt being minted (not including borrowing fee).
    /// @param _price Oracle price in 1e18 precision (RBTC/USD or RBTC/ZUSD face-value model).
    /// @return feeRBTC Extra RBTC (wei) required as the redemption buffer fee.
    function getRedemptionBufferFeeRBTCWithPrice(uint256 _ZUSDAmount, uint256 _price)
        external
        view
        returns (uint256 feeRBTC);

    /**
     * @notice payable function that creates a Trove for the caller with the requested debt, and the Ether received as collateral.
     * Successful execution is conditional mainly on the resulting collateralization ratio which must exceed the minimum (110% in Normal Mode, 150% in Recovery Mode).
     * In addition to the requested debt, extra debt is issued to pay the issuance fee, and cover the gas compensation.
     * The borrower has to provide a `_maxFeePercentage` that he/she is willing to accept in case of a fee slippage, i.e. when a redemption transaction is processed first, driving up the issuance fee.
     * @param _maxFee max fee percentage to acept in case of a fee slippage
     * @param _ZUSDAmount ZUSD requested debt
     * @param _upperHint upper trove id hint
     * @param _lowerHint lower trove id hint
     */
    function openTrove(
        uint256 _maxFee,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint
    ) external payable;

    /**
     * @notice payable function that creates a Trove for the caller with the requested debt, and the Ether received as collateral.
     * Successful execution is conditional mainly on the resulting collateralization ratio which must exceed the minimum (110% in Normal Mode, 150% in Recovery Mode).
     * In addition to the requested debt, extra debt is issued to pay the issuance fee, and cover the gas compensation.
     * The borrower has to provide a `_maxFeePercentage` that he/she is willing to accept in case of a fee slippage, i.e. when a redemption transaction is processed first, driving up the issuance fee.
     * This method is identical to `openTrove()`, but operates on NUE tokens instead of ZUSD.
     * @param _maxFee max fee percentage to acept in case of a fee slippage
     * @param _ZUSDAmount ZUSD requested debt
     * @param _upperHint upper trove id hint
     * @param _lowerHint lower trove id hint
     */
    function openNueTrove(
        uint256 _maxFee,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint
    ) external payable;

    /// @notice payable function that adds the received Ether to the caller's active Trove.
    /// @param _upperHint upper trove id hint
    /// @param _lowerHint lower trove id hint
    function addColl(address _upperHint, address _lowerHint) external payable;

    /// @notice send ETH as collateral to a trove. Called by only the Stability Pool.
    /// @param _user user trove address
    /// @param _upperHint upper trove id hint
    /// @param _lowerHint lower trove id hint
    function moveETHGainToTrove(
        address _user,
        address _upperHint,
        address _lowerHint
    ) external payable;

    /**
     * @notice withdraws `_amount` of collateral from the caller’s Trove.
     * Executes only if the user has an active Trove, the withdrawal would not pull the user’s Trove below the minimum collateralization ratio,
     * and the resulting total collateralization ratio of the system is above 150%.
     * @param _amount collateral amount to withdraw
     * @param _upperHint upper trove id hint
     * @param _lowerHint lower trove id hint
     */
    function withdrawColl(uint256 _amount, address _upperHint, address _lowerHint) external;

    /**
     * @notice issues `_amount` of ZUSD from the caller’s Trove to the caller.
     * Executes only if the Trove's collateralization ratio would remain above the minimum, and the resulting total collateralization ratio is above 150%.
     * The borrower has to provide a `_maxFeePercentage` that he/she is willing to accept in case of a fee slippage, i.e. when a redemption transaction is processed first, driving up the issuance fee.
     * When increasing debt and redemptionBufferRate > 0, caller must send msg.value at least equal to the redemption buffer fee; quote via getRedemptionBufferFeeRBTC().
     * @param _maxFee max fee percentage to acept in case of a fee slippage
     * @param _amount ZUSD amount to withdraw
     * @param _upperHint upper trove id hint
     * @param _lowerHint lower trove id hint
     */
    function withdrawZUSD(
        uint256 _maxFee,
        uint256 _amount,
        address _upperHint,
        address _lowerHint
    ) external payable;

    /// Borrow (withdraw) ZUSD tokens from a trove: mint new ZUSD tokens to the owner and convert it to DLLR in one transaction
    /// When increasing debt and redemptionBufferRate > 0, caller must send msg.value at least equal to the redemption buffer fee; quote via getRedemptionBufferFeeRBTC().
    function withdrawZusdAndConvertToDLLR(
        uint256 _maxFeePercentage,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint
    ) external payable returns (uint256);

    /// @notice repay `_amount` of ZUSD to the caller’s Trove, subject to leaving 50 debt in the Trove (which corresponds to the 50 ZUSD gas compensation).
    /// @param _amount ZUSD amount to repay
    /// @param _upperHint upper trove id hint
    /// @param _lowerHint lower trove id hint
    function repayZUSD(uint256 _amount, address _upperHint, address _lowerHint) external;

    /// Repay ZUSD tokens to a Trove: Burn the repaid ZUSD tokens, and reduce the trove's debt accordingly
    function repayZusdFromDLLR(
        uint256 _dllrAmount,
        address _upperHint,
        address _lowerHint,
        IMassetManager.PermitParams calldata _permitParams
    ) external;

    /// Repay ZUSD tokens to a Trove: Burn the repaid ZUSD tokens, and reduce the trove's debt accordingly
    function repayZusdFromDLLRWithPermit2(
        uint256 _dllrAmount,
        address _upperHint,
        address _lowerHint,
        ISignatureTransfer.PermitTransferFrom memory _permit,
        bytes calldata _signature
    ) external;

    /**
     * @notice allows a borrower to repay all debt, withdraw all their collateral, and close their Trove.
     * Requires the borrower have a ZUSD balance sufficient to repay their trove's debt, excluding gas compensation - i.e. `(debt - 50)` ZUSD.
     */
    function closeTrove() external;

    /**
     * @notice allows a borrower to repay all debt, withdraw all their collateral, and close their Trove.
     * Requires the borrower have a NUE balance sufficient to repay their trove's debt, excluding gas compensation - i.e. `(debt - 50)` NUE.
     * This method is identical to `closeTrove()`, but operates on NUE tokens instead of ZUSD.
     */
    function closeNueTrove(IMassetManager.PermitParams calldata _permitParams) external;

    /**
     * @notice allows a borrower to repay all debt, withdraw all their collateral, and close their Trove.
     * Requires the borrower have a NUE balance sufficient to repay their trove's debt, excluding gas compensation - i.e. `(debt - 50)` NUE.
     * This method is identical to `closeTrove()`, but operates on NUE tokens instead of ZUSD.
     */
    function closeNueTroveWithPermit2(ISignatureTransfer.PermitTransferFrom memory _permit, bytes calldata _signature) external;

    /**
     * @notice enables a borrower to simultaneously change both their collateral and debt, subject to all the restrictions that apply to individual increases/decreases of each quantity with the following particularity:
     * if the adjustment reduces the collateralization ratio of the Trove, the function only executes if the resulting total collateralization ratio is above 150%.
     * The borrower has to provide a `_maxFeePercentage` that he/she is willing to accept in case of a fee slippage, i.e. when a redemption transaction is processed first, driving up the issuance fee.
     * The parameter is ignored if the debt is not increased with the transaction.
     * @param _maxFee max fee percentage to acept in case of a fee slippage
     * @param _collWithdrawal collateral amount to withdraw
     * @param _debtChange ZUSD amount to change
     * @param isDebtIncrease indicates if increases debt
     * @param _upperHint upper trove id hint
     * @param _lowerHint lower trove id hint
     */
    function adjustTrove(
        uint256 _maxFee,
        uint256 _collWithdrawal,
        uint256 _debtChange,
        bool isDebtIncrease,
        address _upperHint,
        address _lowerHint
    ) external payable;

    /**
     * @notice enables a borrower to simultaneously change both their collateral and debt, subject to all the restrictions that apply to individual increases/decreases of each quantity with the following particularity:
     * if the adjustment reduces the collateralization ratio of the Trove, the function only executes if the resulting total collateralization ratio is above 150%.
     * The borrower has to provide a `_maxFeePercentage` that he/she is willing to accept in case of a fee slippage, i.e. when a redemption transaction is processed first, driving up the issuance fee.
     * The parameter is ignored if the debt is not increased with the transaction.
     * This method is identical to `adjustTrove()`, but operates on NUE tokens instead of ZUSD.
     * @param _maxFee max fee percentage to acept in case of a fee slippage
     * @param _collWithdrawal collateral amount to withdraw
     * @param _debtChange ZUSD amount to change
     * @param isDebtIncrease indicates if increases debt
     * @param _upperHint upper trove id hint
     * @param _lowerHint lower trove id hint
     */
    function adjustNueTrove(
        uint256 _maxFee,
        uint256 _collWithdrawal,
        uint256 _debtChange,
        bool isDebtIncrease,
        address _upperHint,
        address _lowerHint,
        IMassetManager.PermitParams calldata _permitParams
    ) external payable;

    /**
     * @notice enables a borrower to simultaneously change both their collateral and debt, subject to all the restrictions that apply to individual increases/decreases of each quantity with the following particularity:
     * if the adjustment reduces the collateralization ratio of the Trove, the function only executes if the resulting total collateralization ratio is above 150%.
     * The borrower has to provide a `_maxFeePercentage` that he/she is willing to accept in case of a fee slippage, i.e. when a redemption transaction is processed first, driving up the issuance fee.
     * The parameter is ignored if the debt is not increased with the transaction.
     * This method is identical to `adjustTrove()`, but operates on NUE tokens instead of ZUSD.
     * @param _maxFee max fee percentage to acept in case of a fee slippage
     * @param _collWithdrawal collateral amount to withdraw
     * @param _debtChange ZUSD amount to change
     * @param isDebtIncrease indicates if increases debt
     * @param _upperHint upper trove id hint
     * @param _lowerHint lower trove id hint
     */
    function adjustNueTroveWithPermit2(
        uint256 _maxFee,
        uint256 _collWithdrawal,
        uint256 _debtChange,
        bool isDebtIncrease,
        address _upperHint,
        address _lowerHint,
        ISignatureTransfer.PermitTransferFrom memory _permit,
        bytes calldata _signature
    ) external payable;

    /**
     * @notice when a borrower’s Trove has been fully redeemed from and closed, or liquidated in Recovery Mode with a collateralization ratio above 110%,
     * this function allows the borrower to claim their ETH collateral surplus that remains in the system (collateral - debt upon redemption; collateral - 110% of the debt upon liquidation).
     */
    function claimCollateral() external;

    function getCompositeDebt(uint256 _debt) external view returns (uint256);

    function BORROWING_FEE_FLOOR() external view returns (uint256);

    function getMassetManager() external view returns (IMassetManager);
}
