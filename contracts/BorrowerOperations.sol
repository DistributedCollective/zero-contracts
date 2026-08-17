// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "./Interfaces/IBorrowerOperations.sol";
import "./Interfaces/ITroveManager.sol";
import "./Interfaces/IZUSDToken.sol";
import "./Interfaces/ICollSurplusPool.sol";
import "./Interfaces/ISortedTroves.sol";
import "./Interfaces/IZEROStaking.sol";
import "./Interfaces/IFeeDistributor.sol";
import "./Dependencies/LiquityBase.sol";
import "./Dependencies/CheckContract.sol";
import "./Dependencies/console.sol";
import "./BorrowerOperationsStorage.sol";
import "./Dependencies/Mynt/MyntLib.sol";
import "./Interfaces/IPermit2.sol";
import "./Interfaces/colfee/IExitFeeController.sol";
import "./Interfaces/colfee/IExitDelayQueueHook.sol";

contract BorrowerOperations is
    LiquityBase,
    BorrowerOperationsStorage,
    CheckContract,
    IBorrowerOperations
{
    /** CONSTANT / IMMUTABLE VARIABLE ONLY */
    IPermit2 public immutable permit2;

    // --- ColFee (exit-fee) hook ---
    // No new regular storage: the controller pointer lives in an EIP-1967-style
    // unstructured slot so `BorrowerOperations` storage-layout is unchanged.
    bytes32 private constant EXIT_FEE_CONTROLLER_SLOT =
        bytes32(uint256(keccak256("sovryn.exitFeeController")) - 1);
    bytes32 private constant SURFACE_ZERO_WITHDRAW_COLL =
        keccak256("COLFEE:SURFACE_ZERO_WITHDRAW_COLL");
    bytes32 private constant SURFACE_ZERO_CLAIM_SURPLUS =
        keccak256("COLFEE:SURFACE_ZERO_CLAIM_SURPLUS");

    // --- Security-perimeter exit-delay hook ---
    // The delay queue pointer also lives in an EIP-1967-style unstructured
    // slot, so `BorrowerOperations` storage-layout is unchanged (zero-diff). It is
    // rotated with `setExitDelayQueue` under the SAME owner as the controller
    // pointer. Because the pointer redirects ESCROW it is more sensitive than the
    // controller pointer — rotation is an Owner/SIP action.
    bytes32 private constant EXIT_DELAY_QUEUE_SLOT =
        bytes32(uint256(keccak256("sovryn.exitDelayQueue")) - 1);

    event ExitFeeControllerSet(address indexed previous, address indexed current);
    event ExitDelayQueueSet(address indexed previous, address indexed current);
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

    /* --- Variable container structs  ---

    Used to hold, return and assign variables inside a function, in order to avoid the error:
    "CompilerError: Stack too deep". */

    struct LocalVariables_adjustTrove {
        uint256 price;
        uint256 collChange;
        uint256 netDebtChange;
        bool isCollIncrease;
        uint256 debt;
        uint256 coll;
        uint256 oldICR;
        uint256 newICR;
        uint256 newTCR;
        uint256 ZUSDFee;
        uint256 newDebt;
        uint256 newColl;
        uint256 stake;
        uint256 newNICR;
        bool isRecoveryMode;
    }

    struct LocalVariables_openTrove {
        uint256 price;
        uint256 ZUSDFee;
        uint256 netDebt;
        uint256 compositeDebt;
        uint256 ICR;
        uint256 NICR;
        uint256 stake;
        uint256 arrayIndex;
    }

    struct ContractsCache {
        ITroveManager troveManager;
        IActivePool activePool;
        IZUSDToken zusdToken;
    }

    enum BorrowerOperation {
        openTrove,
        closeTrove,
        adjustTrove
    }

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
    event MassetManagerAddressChanged(address _massetManagerAddress);

    event TroveCreated(address indexed _borrower, uint256 arrayIndex);
    event TroveUpdated(
        address indexed _borrower,
        uint256 _debt,
        uint256 _coll,
        uint256 stake,
        BorrowerOperation operation
    );
    event ZUSDBorrowingFeePaid(address indexed _borrower, uint256 _ZUSDFee);

    /** Constructor */
    constructor(address _permit2) public {
        permit2 = IPermit2(_permit2);
    }

    // --- Dependency setters ---

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
    ) external override onlyOwner {
        // This makes impossible to open a trove with zero withdrawn ZUSD
        assert(MIN_NET_DEBT > 0);

        checkContract(_feeDistributorAddress);
        checkContract(_liquityBaseParamsAddress);
        checkContract(_troveManagerAddress);
        checkContract(_activePoolAddress);
        checkContract(_defaultPoolAddress);
        checkContract(_stabilityPoolAddress);
        checkContract(_gasPoolAddress);
        checkContract(_collSurplusPoolAddress);
        checkContract(_priceFeedAddress);
        checkContract(_sortedTrovesAddress);
        checkContract(_zusdTokenAddress);
        checkContract(_zeroStakingAddress);

        feeDistributor = IFeeDistributor(_feeDistributorAddress);
        liquityBaseParams = ILiquityBaseParams(_liquityBaseParamsAddress);
        troveManager = ITroveManager(_troveManagerAddress);
        activePool = IActivePool(_activePoolAddress);
        defaultPool = IDefaultPool(_defaultPoolAddress);
        stabilityPoolAddress = _stabilityPoolAddress;
        gasPoolAddress = _gasPoolAddress;
        collSurplusPool = ICollSurplusPool(_collSurplusPoolAddress);
        priceFeed = IPriceFeed(_priceFeedAddress);
        sortedTroves = ISortedTroves(_sortedTrovesAddress);
        zusdToken = IZUSDToken(_zusdTokenAddress);
        zeroStakingAddress = _zeroStakingAddress;
        zeroStaking = IZEROStaking(_zeroStakingAddress);

        emit FeeDistributorAddressChanged(_feeDistributorAddress);
        emit TroveManagerAddressChanged(_troveManagerAddress);
        emit ActivePoolAddressChanged(_activePoolAddress);
        emit DefaultPoolAddressChanged(_defaultPoolAddress);
        emit StabilityPoolAddressChanged(_stabilityPoolAddress);
        emit GasPoolAddressChanged(_gasPoolAddress);
        emit CollSurplusPoolAddressChanged(_collSurplusPoolAddress);
        emit PriceFeedAddressChanged(_priceFeedAddress);
        emit SortedTrovesAddressChanged(_sortedTrovesAddress);
        emit ZUSDTokenAddressChanged(_zusdTokenAddress);
        emit ZEROStakingAddressChanged(_zeroStakingAddress);
    }

    function setMassetManagerAddress(address _massetManagerAddress) external onlyOwner {
        massetManager = IMassetManager(_massetManagerAddress);
        emit MassetManagerAddressChanged(_massetManagerAddress);
    }

    function openTrove(
        uint256 _maxFeePercentage,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint
    ) external payable override {
        _openTrove(_maxFeePercentage, _ZUSDAmount, _upperHint, _lowerHint, msg.sender);
    }

    function openNueTrove(
        uint256 _maxFeePercentage,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint
    ) external payable override {
        require(address(massetManager) != address(0), "Masset address not set");

        _openTrove(_maxFeePercentage, _ZUSDAmount, _upperHint, _lowerHint, address(this));
        require(
            zusdToken.approve(address(massetManager), _ZUSDAmount),
            "Failed to approve ZUSD amount for Mynt mAsset to redeem"
        );
        massetManager.mintTo(address(zusdToken), _ZUSDAmount, msg.sender);
    }

    // --- Borrower Trove Operations ---
    function _openTrove(
        uint256 _maxFeePercentage,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint,
        address _tokensRecipient
    ) internal {
        ContractsCache memory contractsCache = ContractsCache(troveManager, activePool, zusdToken);
        LocalVariables_openTrove memory vars;

        vars.price = priceFeed.fetchPrice();
        bool isRecoveryMode = _checkRecoveryMode(vars.price);

        _requireValidMaxFeePercentage(_maxFeePercentage, isRecoveryMode);
        _requireTroveisNotActive(contractsCache.troveManager, msg.sender);

        vars.ZUSDFee;
        vars.netDebt = _ZUSDAmount;

        if (!isRecoveryMode) {
            vars.ZUSDFee = _triggerBorrowingFee(
                contractsCache.troveManager,
                contractsCache.zusdToken,
                _ZUSDAmount,
                _maxFeePercentage
            );
            vars.netDebt = vars.netDebt.add(vars.ZUSDFee);
        }
        _requireAtLeastMinNetDebt(vars.netDebt);

        // ICR is based on the composite debt, i.e. the requested ZUSD amount + ZUSD borrowing fee + ZUSD gas comp.
        vars.compositeDebt = _getCompositeDebt(vars.netDebt);
        assert(vars.compositeDebt > 0);

        vars.ICR = LiquityMath._computeCR(msg.value, vars.compositeDebt, vars.price);
        vars.NICR = LiquityMath._computeNominalCR(msg.value, vars.compositeDebt);

        if (isRecoveryMode) {
            _requireICRisAboveCCR(vars.ICR);
        } else {
            _requireICRisAboveMCR(vars.ICR);
            uint256 newTCR = _getNewTCRFromTroveChange(
                msg.value,
                true,
                vars.compositeDebt,
                true,
                vars.price
            ); // bools: coll increase, debt increase
            _requireNewTCRisAboveCCR(newTCR);
        }

        // Set the trove struct's properties
        contractsCache.troveManager.setTroveStatus(msg.sender, 1);
        contractsCache.troveManager.increaseTroveColl(msg.sender, msg.value);
        contractsCache.troveManager.increaseTroveDebt(msg.sender, vars.compositeDebt);

        contractsCache.troveManager.updateTroveRewardSnapshots(msg.sender);
        vars.stake = contractsCache.troveManager.updateStakeAndTotalStakes(msg.sender);

        sortedTroves.insert(msg.sender, vars.NICR, _upperHint, _lowerHint);
        vars.arrayIndex = contractsCache.troveManager.addTroveOwnerToArray(msg.sender);
        emit TroveCreated(msg.sender, vars.arrayIndex);

        // Move the ether to the Active Pool, and mint the ZUSDAmount to the borrower
        _activePoolAddColl(contractsCache.activePool, msg.value);
        _mintZusdAndIncreaseActivePoolDebt(
            contractsCache.activePool,
            contractsCache.zusdToken,
            _tokensRecipient,
            _ZUSDAmount,
            vars.netDebt
        );
        // Move the ZUSD gas compensation to the Gas Pool
        _mintZusdAndIncreaseActivePoolDebt(
            contractsCache.activePool,
            contractsCache.zusdToken,
            gasPoolAddress,
            ZUSD_GAS_COMPENSATION,
            ZUSD_GAS_COMPENSATION
        );

        emit TroveUpdated(
            msg.sender,
            vars.compositeDebt,
            msg.value,
            vars.stake,
            BorrowerOperation.openTrove
        );
        emit ZUSDBorrowingFeePaid(msg.sender, vars.ZUSDFee);
    }

    /// Send ETH as collateral to a trove
    function addColl(address _upperHint, address _lowerHint) external payable override {
        _adjustTrove(msg.sender, 0, 0, false, _upperHint, _lowerHint, 0);
    }

    /// Send ETH as collateral to a trove. Called by only the Stability Pool.
    function moveETHGainToTrove(
        address _borrower,
        address _upperHint,
        address _lowerHint
    ) external payable override {
        _requireCallerIsStabilityPool();
        _adjustTrove(_borrower, 0, 0, false, _upperHint, _lowerHint, 0);
    }

    /// Withdraw ETH collateral from a trove
    function withdrawColl(
        uint256 _collWithdrawal,
        address _upperHint,
        address _lowerHint
    ) external override {
        _adjustTrove(msg.sender, _collWithdrawal, 0, false, _upperHint, _lowerHint, 0);
    }

    /// Withdraw ZUSD tokens from a trove: mint new ZUSD tokens to the owner, and increase the trove's debt accordingly
    function withdrawZUSD(
        uint256 _maxFeePercentage,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint
    ) external override {
        _adjustTrove(msg.sender, 0, _ZUSDAmount, true, _upperHint, _lowerHint, _maxFeePercentage);
    }

    /// Borrow (withdraw) ZUSD tokens from a trove: mint new ZUSD tokens to the owner and convert it to DLLR in one transaction
    /// Zero Line of Credit owner can borrow a specified amount of ZUSD and convert it to DLLR via Sovryn Mynt
    ///@return DLLR amount minted
    function withdrawZusdAndConvertToDLLR(
        uint256 _maxFeePercentage,
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint
    ) external override returns (uint256) {
        address thisAddress = address(this);
        uint256 balanceBefore = zusdToken.balanceOf(thisAddress);

        _withdrawZusdTo(
            msg.sender,
            thisAddress,
            _ZUSDAmount,
            _upperHint,
            _lowerHint,
            _maxFeePercentage
        );

        require(
            zusdToken.balanceOf(thisAddress) == balanceBefore.add(_ZUSDAmount),
            "ZUSD is not borrowed correctly"
        );
        require(
            zusdToken.approve(address(massetManager), _ZUSDAmount),
            "Failed to approve ZUSD amount for Mynt mAsset to redeem"
        );
        return massetManager.mintTo(address(zusdToken), _ZUSDAmount, msg.sender);
    }

    /// Repay ZUSD tokens to a Trove: Burn the repaid ZUSD tokens, and reduce the trove's debt accordingly
    function repayZUSD(
        uint256 _ZUSDAmount,
        address _upperHint,
        address _lowerHint
    ) external override {
        _adjustTrove(msg.sender, 0, _ZUSDAmount, false, _upperHint, _lowerHint, 0);
    }

    /// Repay ZUSD tokens to a Trove by DLLR: convert DLLR to ZUSD tokens, and then reduce the trove's debt accordingly
    function repayZusdFromDLLR(
        uint256 _dllrAmount,
        address _upperHint,
        address _lowerHint,
        IMassetManager.PermitParams calldata _permitParams
    ) external override {
        _adjustNueTrove(0, 0, _dllrAmount, false, _upperHint, _lowerHint, _permitParams);
    }

    /// Repay ZUSD tokens to a Trove by DLLR: convert DLLR to ZUSD tokens, and then reduce the trove's debt accordingly
    function repayZusdFromDLLRWithPermit2(
        uint256 _dllrAmount,
        address _upperHint,
        address _lowerHint,
        ISignatureTransfer.PermitTransferFrom memory _permit,
        bytes calldata _signature
    ) external override {
        _adjustNueTroveWithPermit2(
            0,
            0,
            _dllrAmount,
            false,
            _upperHint,
            _lowerHint,
            _permit,
            _signature
        );
    }

    function adjustTrove(
        uint256 _maxFeePercentage,
        uint256 _collWithdrawal,
        uint256 _ZUSDChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint
    ) external payable override {
        _adjustTrove(
            msg.sender,
            _collWithdrawal,
            _ZUSDChange,
            _isDebtIncrease,
            _upperHint,
            _lowerHint,
            _maxFeePercentage
        );
    }

    // in case of _isDebtIncrease = false MassetManager contract must have an approval of NUE tokens
    function adjustNueTrove(
        uint256 _maxFeePercentage,
        uint256 _collWithdrawal,
        uint256 _ZUSDChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint,
        IMassetManager.PermitParams calldata _permitParams
    ) external payable override {
        _adjustNueTrove(
            _maxFeePercentage,
            _collWithdrawal,
            _ZUSDChange,
            _isDebtIncrease,
            _upperHint,
            _lowerHint,
            _permitParams
        );
    }

    // in case of _isDebtIncrease = false MassetManager contract must have an approval of NUE tokens
    function adjustNueTroveWithPermit2(
        uint256 _maxFeePercentage,
        uint256 _collWithdrawal,
        uint256 _ZUSDChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint,
        ISignatureTransfer.PermitTransferFrom memory _permit,
        bytes calldata _signature
    ) external payable override {
        _adjustNueTroveWithPermit2(
            _maxFeePercentage,
            _collWithdrawal,
            _ZUSDChange,
            _isDebtIncrease,
            _upperHint,
            _lowerHint,
            _permit,
            _signature
        );
    }

    // in case of _isDebtIncrease = false Masset Manager contract must have an approval of NUE tokens
    function _adjustNueTrove(
        uint256 _maxFeePercentage,
        uint256 _collWithdrawal,
        uint256 _ZUSDChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint,
        IMassetManager.PermitParams calldata _permitParams
    ) internal {
        require(address(massetManager) != address(0), "Masset address not set");

        if (!_isDebtIncrease && _ZUSDChange > 0) {
            MyntLib.redeemZusdFromDllrWithPermit(
                massetManager,
                _ZUSDChange,
                address(zusdToken),
                _permitParams
            );
        }
        _adjustSenderTrove(
            msg.sender,
            _collWithdrawal,
            _ZUSDChange,
            _isDebtIncrease,
            _upperHint,
            _lowerHint,
            _maxFeePercentage,
            address(this)
        );
        if (_isDebtIncrease && _ZUSDChange > 0) {
            require(
                zusdToken.approve(address(massetManager), _ZUSDChange),
                "Failed to approve ZUSD amount for Mynt mAsset to redeem"
            );
            massetManager.mintTo(address(zusdToken), _ZUSDChange, msg.sender);
        }
    }

    // in case of _isDebtIncrease = false Masset Manager contract must have an approval of NUE tokens
    function _adjustNueTroveWithPermit2(
        uint256 _maxFeePercentage,
        uint256 _collWithdrawal,
        uint256 _ZUSDChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint,
        ISignatureTransfer.PermitTransferFrom memory _permit,
        bytes calldata _signature
    ) internal {
        require(address(massetManager) != address(0), "Masset address not set");

        if (!_isDebtIncrease && _ZUSDChange > 0) {
            MyntLib.redeemZusdFromDllrWithPermit2(
                massetManager,
                address(zusdToken),
                _permit,
                permit2,
                _signature
            );
        }
        _adjustSenderTrove(
            msg.sender,
            _collWithdrawal,
            _ZUSDChange,
            _isDebtIncrease,
            _upperHint,
            _lowerHint,
            _maxFeePercentage,
            address(this)
        );
        if (_isDebtIncrease && _ZUSDChange > 0) {
            require(
                zusdToken.approve(address(massetManager), _ZUSDChange),
                "Failed to approve ZUSD amount for Mynt mAsset to redeem"
            );
            massetManager.mintTo(address(zusdToken), _ZUSDChange, msg.sender);
        }
    }

    function _adjustTrove(
        address _borrower,
        uint256 _collWithdrawal,
        uint256 _ZUSDChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint,
        uint256 _maxFeePercentage
    ) internal {
        _adjustSenderTrove(
            _borrower,
            _collWithdrawal,
            _ZUSDChange,
            _isDebtIncrease,
            _upperHint,
            _lowerHint,
            _maxFeePercentage,
            msg.sender
        );
    }

    // _withdrawZusd: _adjustTrove(msg.sender, 0, _ZUSDAmount, true, _upperHint, _lowerHint, _maxFeePercentage);
    function _withdrawZusdTo(
        address _borrower,
        address _receiver,
        uint256 _ZUSDChange,
        address _upperHint,
        address _lowerHint,
        uint256 _maxFeePercentage
    ) internal {
        _adjustSenderTrove(
            _borrower,
            0,
            _ZUSDChange,
            true,
            _upperHint,
            _lowerHint,
            _maxFeePercentage,
            _receiver
        );
    }

    /**
     * _adjustSenderTrove(): Alongside a debt change, this function can perform either a collateral top-up or a collateral withdrawal.
     *
     * It therefore expects either a positive msg.value, or a positive _collWithdrawal argument.
     *
     * If both are positive, it will revert.
     */
    function _adjustSenderTrove(
        address _borrower,
        uint256 _collWithdrawal,
        uint256 _ZUSDChange,
        bool _isDebtIncrease,
        address _upperHint,
        address _lowerHint,
        uint256 _maxFeePercentage,
        address _tokensRecipient
    ) internal {
        ContractsCache memory contractsCache = ContractsCache(troveManager, activePool, zusdToken);
        LocalVariables_adjustTrove memory vars;

        vars.price = priceFeed.fetchPrice();
        vars.isRecoveryMode = _checkRecoveryMode(vars.price);

        if (_isDebtIncrease) {
            _requireValidMaxFeePercentage(_maxFeePercentage, vars.isRecoveryMode);
            _requireNonZeroDebtChange(_ZUSDChange);
        }
        _requireSingularCollChange(_collWithdrawal);
        _requireNonZeroAdjustment(_collWithdrawal, _ZUSDChange);
        _requireTroveisActive(contractsCache.troveManager, _borrower);

        // Confirm the operation is either a borrower adjusting their own trove, or a pure ETH transfer from the Stability Pool to a trove
        assert(
            msg.sender == _borrower ||
                (msg.sender == stabilityPoolAddress && msg.value > 0 && _ZUSDChange == 0)
        );

        contractsCache.troveManager.applyPendingRewards(_borrower);

        // Get the collChange based on whether or not ETH was sent in the transaction
        (vars.collChange, vars.isCollIncrease) = _getCollChange(msg.value, _collWithdrawal);

        vars.netDebtChange = _ZUSDChange;

        // If the adjustment incorporates a debt increase and system is in Normal Mode, then trigger a borrowing fee
        if (_isDebtIncrease && !vars.isRecoveryMode) {
            vars.ZUSDFee = _triggerBorrowingFee(
                contractsCache.troveManager,
                contractsCache.zusdToken,
                _ZUSDChange,
                _maxFeePercentage
            );
            vars.netDebtChange = vars.netDebtChange.add(vars.ZUSDFee); // The raw debt change includes the fee
        }

        vars.debt = contractsCache.troveManager.getTroveDebt(_borrower);
        vars.coll = contractsCache.troveManager.getTroveColl(_borrower);

        // Get the trove's old ICR before the adjustment, and what its new ICR will be after the adjustment
        vars.oldICR = LiquityMath._computeCR(vars.coll, vars.debt, vars.price);
        vars.newICR = _getNewICRFromTroveChange(
            vars.coll,
            vars.debt,
            vars.collChange,
            vars.isCollIncrease,
            vars.netDebtChange,
            _isDebtIncrease,
            vars.price
        );
        assert(_collWithdrawal <= vars.coll);

        // Check the adjustment satisfies all conditions for the current system mode
        _requireValidAdjustmentInCurrentMode(
            vars.isRecoveryMode,
            _collWithdrawal,
            _isDebtIncrease,
            vars
        );

        // When the adjustment is a debt repayment, check it's a valid amount and that the caller has enough ZUSD
        if (!_isDebtIncrease && _ZUSDChange > 0) {
            _requireAtLeastMinNetDebt(_getNetDebt(vars.debt).sub(vars.netDebtChange));
            _requireValidZUSDRepayment(vars.debt, vars.netDebtChange);
            _requireSufficientZUSDBalance(contractsCache.zusdToken, _borrower, vars.netDebtChange);
        }

        (vars.newColl, vars.newDebt) = _updateTroveFromAdjustment(
            contractsCache.troveManager,
            _borrower,
            vars.collChange,
            vars.isCollIncrease,
            vars.netDebtChange,
            _isDebtIncrease
        );
        vars.stake = contractsCache.troveManager.updateStakeAndTotalStakes(_borrower);

        // Re-insert trove in to the sorted list
        vars.newNICR = _getNewNominalICRFromTroveChange(
            vars.coll,
            vars.debt,
            vars.collChange,
            vars.isCollIncrease,
            vars.netDebtChange,
            _isDebtIncrease
        );
        sortedTroves.reInsert(_borrower, vars.newNICR, _upperHint, _lowerHint);

        emit TroveUpdated(
            _borrower,
            vars.newDebt,
            vars.newColl,
            vars.stake,
            BorrowerOperation.adjustTrove
        );
        emit ZUSDBorrowingFeePaid(msg.sender, vars.ZUSDFee);

        // Use the unmodified _ZUSDChange here, as we don't send the fee to the user
        _moveTokensAndETHfromAdjustment(
            contractsCache.activePool,
            contractsCache.zusdToken,
            msg.sender,
            vars.collChange,
            vars.isCollIncrease,
            _ZUSDChange,
            _isDebtIncrease,
            vars.netDebtChange,
            _tokensRecipient
        );
    }

    function closeTrove() external override {
        _closeTrove();
    }

    function closeNueTrove(IMassetManager.PermitParams calldata _permitParams) external override {
        require(address(massetManager) != address(0), "Masset address not set");

        uint256 debt = troveManager.getTroveDebt(msg.sender);

        MyntLib.redeemZusdFromDllrWithPermit(
            massetManager,
            debt.sub(ZUSD_GAS_COMPENSATION),
            address(zusdToken),
            _permitParams
        );
        _closeTrove();
    }

    function closeNueTroveWithPermit2(
        ISignatureTransfer.PermitTransferFrom memory _permit,
        bytes calldata _signature
    ) external override {
        require(address(massetManager) != address(0), "Masset address not set");

        uint256 debt = troveManager.getTroveDebt(msg.sender);

        MyntLib.redeemZusdFromDllrWithPermit2(
            massetManager,
            address(zusdToken),
            _permit,
            permit2,
            _signature
        );

        _closeTrove();
    }

    function _closeTrove() internal {
        ITroveManager troveManagerCached = troveManager;
        IActivePool activePoolCached = activePool;
        IZUSDToken zusdTokenCached = zusdToken;

        _requireTroveisActive(troveManagerCached, msg.sender);
        uint256 price = priceFeed.fetchPrice();
        _requireNotInRecoveryMode(price);

        troveManagerCached.applyPendingRewards(msg.sender);

        uint256 coll = troveManagerCached.getTroveColl(msg.sender);
        uint256 debt = troveManagerCached.getTroveDebt(msg.sender);

        _requireSufficientZUSDBalance(
            zusdTokenCached,
            msg.sender,
            debt.sub(ZUSD_GAS_COMPENSATION)
        );

        uint256 newTCR = _getNewTCRFromTroveChange(coll, false, debt, false, price);
        _requireNewTCRisAboveCCR(newTCR);

        troveManagerCached.removeStake(msg.sender);
        troveManagerCached.closeTrove(msg.sender);

        emit TroveUpdated(msg.sender, 0, 0, 0, BorrowerOperation.closeTrove);

        // Burn the repaid ZUSD from the user's balance and the gas compensation from the Gas Pool
        _burnZusdAndDecreaseActivePoolDebt(
            activePoolCached,
            zusdTokenCached,
            msg.sender,
            debt.sub(ZUSD_GAS_COMPENSATION)
        );
        _burnZusdAndDecreaseActivePoolDebt(
            activePoolCached,
            zusdTokenCached,
            gasPoolAddress,
            ZUSD_GAS_COMPENSATION
        );

        // Send the collateral back to the user (charging the ColFee exit fee)
        _sendCollWithExitFee(activePoolCached, msg.sender, coll);
    }

    /**
     * Claim remaining collateral from a redemption or from a liquidation with ICR > MCR in Recovery Mode,
     * charging the ColFee exit fee when the SURFACE_ZERO_CLAIM_SURPLUS policy is active.
     * Fail-open like every ColFee hook: on any ColFee failure (controller missing/
     * reverting, invalid quote, fee-leg transfer failure inside the pool) the claimant
     * receives the full surplus — a ColFee failure can never brick a claim. The
     * non-charging path is the untouched claimColl flow (plus the ExitFeeSkipped
     * event, same convention as _sendCollWithExitFee).
     */
    function claimCollateral() external override {
        uint256 gross = collSurplusPool.getCollateral(msg.sender);
        // Single Zero deployment: subProduct = address(0). Asset is native RBTC.
        IExitFeeController.ExitFeeQuote memory q = _safeQuote(
            SURFACE_ZERO_CLAIM_SURPLUS,
            address(0),
            msg.sender,
            gross
        );

        // Defensive: a quote that charges into address(0) would burn the fee (a
        // value call to a no-code address succeeds). Demote to the non-charging
        // path — DISABLED is the enum's "feeReceiver == address(0)" reason.
        if (q.active && q.feeAmount > 0 && q.feeReceiver == address(0)) {
            q.active = false;
            q.netAmount = gross;
            q.reason = uint8(IExitFeeController.SkipReason.DISABLED);
        }

        if (q.active && q.feeAmount > 0) {
            // Two-leg split inside the pool (fee → feeReceiver, net → claimant);
            // the pool's fee leg is fail-open and reports which event is truthful.
            bool feePaid = collSurplusPool.claimCollWithFee(
                msg.sender,
                q.feeReceiver,
                q.feeAmount
            );
            if (feePaid) {
                emit ExitFeeApplied(
                    SURFACE_ZERO_CLAIM_SURPLUS,
                    msg.sender,
                    address(0),
                    address(0),
                    msg.sender,
                    gross,
                    q.feeAmount,
                    q.netAmount,
                    q.feeReceiver
                );
            } else {
                emit ExitFeeSkipped(
                    SURFACE_ZERO_CLAIM_SURPLUS,
                    msg.sender,
                    address(0),
                    gross,
                    q.rateBps,
                    uint8(IExitFeeController.SkipReason.VAULT_REVERT)
                );
            }
        } else {
            // !active (INACTIVE / DISABLED / INVALID_QUOTE / CONTROLLER_REVERT)
            // OR active-but-zero-fee (dust / zero-rate / gross == 0 → reason NONE).
            emit ExitFeeSkipped(
                SURFACE_ZERO_CLAIM_SURPLUS,
                msg.sender,
                address(0),
                gross,
                q.rateBps,
                q.reason
            );
            // send ETH from CollSurplus Pool to owner — untouched original path
            // (gross == 0 falls through to claimColl's own revert, identical to today)
            collSurplusPool.claimColl(msg.sender);
        }
    }

    // --- Helper functions ---

    function _triggerBorrowingFee(
        ITroveManager _troveManager,
        IZUSDToken _zusdToken,
        uint256 _ZUSDAmount,
        uint256 _maxFeePercentage
    ) internal returns (uint256) {
        _troveManager.decayBaseRateFromBorrowing(); // decay the baseRate state variable
        uint256 ZUSDFee = _troveManager.getBorrowingFee(_ZUSDAmount);

        _requireUserAcceptsFee(ZUSDFee, _ZUSDAmount, _maxFeePercentage);
        _zusdToken.mint(address(feeDistributor), ZUSDFee);
        feeDistributor.distributeFees();

        return ZUSDFee;
    }

    function _getUSDValue(uint256 _coll, uint256 _price) internal pure returns (uint256) {
        uint256 usdValue = _price.mul(_coll).div(DECIMAL_PRECISION);

        return usdValue;
    }

    function _getCollChange(
        uint256 _collReceived,
        uint256 _requestedCollWithdrawal
    ) internal pure returns (uint256 collChange, bool isCollIncrease) {
        if (_collReceived != 0) {
            collChange = _collReceived;
            isCollIncrease = true;
        } else {
            collChange = _requestedCollWithdrawal;
        }
    }

    /// Update trove's coll and debt based on whether they increase or decrease
    function _updateTroveFromAdjustment(
        ITroveManager _troveManager,
        address _borrower,
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _debtChange,
        bool _isDebtIncrease
    ) internal returns (uint256, uint256) {
        uint256 newColl = (_isCollIncrease)
            ? _troveManager.increaseTroveColl(_borrower, _collChange)
            : _troveManager.decreaseTroveColl(_borrower, _collChange);
        uint256 newDebt = (_isDebtIncrease)
            ? _troveManager.increaseTroveDebt(_borrower, _debtChange)
            : _troveManager.decreaseTroveDebt(_borrower, _debtChange);

        return (newColl, newDebt);
    }

    function _moveTokensAndETHfromAdjustment(
        IActivePool _activePool,
        IZUSDToken _zusdToken,
        address _borrower,
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _ZUSDChange,
        bool _isDebtIncrease,
        uint256 _netDebtChange,
        address _tokensRecipient
    ) internal {
        if (_isDebtIncrease) {
            _mintZusdAndIncreaseActivePoolDebt(
                _activePool,
                _zusdToken,
                _tokensRecipient,
                _ZUSDChange,
                _netDebtChange
            );
        } else {
            _burnZusdAndDecreaseActivePoolDebt(_activePool, _zusdToken, _borrower, _ZUSDChange);
        }

        if (_isCollIncrease) {
            _activePoolAddColl(_activePool, _collChange);
        } else {
            _sendCollWithExitFee(_activePool, _borrower, _collChange);
        }
    }

    // --- ColFee (exit-fee) helpers ---

    /// @notice Address of the ColFee controller this instance consults. Held in
    ///         an EIP-1967-style unstructured slot (no regular-storage footprint).
    function exitFeeController() public view returns (address ctrl) {
        bytes32 slot = EXIT_FEE_CONTROLLER_SLOT;
        assembly {
            ctrl := sload(slot)
        }
    }

    /// @notice Set (or rotate) the ColFee controller this instance consults.
    ///         Owner-only, one call, effective for every subsequent exit.
    function setExitFeeController(address ctrl) external onlyOwner {
        require(ctrl != address(0), "EFC:zero");
        // A no-code controller would make the high-level quoteExitFee call
        // revert with "function call to a non-contract account", which 0.6.11
        // try/catch does NOT catch — bricking borrower exits. Reject it here
        // (and fail open in _safeQuote if it later becomes code-less).
        checkContract(ctrl);
        address prev = exitFeeController();
        bytes32 slot = EXIT_FEE_CONTROLLER_SLOT;
        assembly {
            sstore(slot, ctrl)
        }
        emit ExitFeeControllerSet(prev, ctrl);
    }

    /// @notice Address of the ExitDelayQueue this instance escrows delayed
    ///         collateral exits into. Held in an EIP-1967-style unstructured slot
    ///         (no regular-storage footprint). address(0) until governance pins
    ///         one ⇒ the security-perimeter reroute is unwired ⇒ exits pay direct
    ///         at `d == 0` and fail CLOSED at `d > 0` (a delay is never silently
    ///         bypassed by a missing pointer).
    function exitDelayQueue() public view returns (address queue) {
        bytes32 slot = EXIT_DELAY_QUEUE_SLOT;
        assembly {
            queue := sload(slot)
        }
    }

    /// @notice Pin/rotate the ExitDelayQueue pointer. `onlyOwner` — the same
    ///         BorrowerOperations proxy owner (= TimelockOwner on mainnet) that
    ///         gates `setExitFeeController`. Because the pointer redirects ESCROW
    ///         it is MORE sensitive than the controller pointer; rotation is an
    ///         Owner/SIP action. Reverts on a non-contract so a typo cannot point
    ///         the reroute at a no-code address (address(0) is likewise rejected —
    ///         unwiring, if ever needed, is a deliberate distinct governance path,
    ///         and the perimeter is instead disabled via the controller kill
    ///         switch, which quotes `d == 0` and pays direct).
    function setExitDelayQueue(address queue) external onlyOwner {
        require(queue != address(0), "EDQ:zero");
        checkContract(queue);
        address prev = exitDelayQueue();
        bytes32 slot = EXIT_DELAY_QUEUE_SLOT;
        assembly {
            sstore(slot, queue)
        }
        emit ExitDelayQueueSet(prev, queue);
    }

    /// @dev Fail-CLOSED delay quote wrapper. Resolves the single hook
    ///      entry `quoteExitDelayFor` on the shared ColFee controller and returns
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
                SURFACE_ZERO_WITHDRAW_COLL,
                address(0)
            )
        returns (uint32 d_, address effOrig_, address effOwner_) {
            return (d_, effOrig_, effOwner_);
        } catch {
            revert("COLFEE:delay-quote-failed");
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

    /// @dev Settle a borrower collateral payout, charging the ColFee exit fee
    ///      when the resolved policy is active. The fee leg uses `try/catch`
    ///      (0.6.11 native) so a fee-receiver failure never bricks the exit; on
    ///      any non-charging path the full `gross` is sent to the borrower via
    ///      the existing fail-closed `sendETH`. ActivePool's recorded ETH
    ///      decrements by exactly `gross` either way (the reverted fee-leg
    ///      subcall rolls back its `ETH.sub`).
    function _sendCollWithExitFee(
        IActivePool _activePool,
        address borrower,
        uint256 gross
    ) private {
        // Debt-only adjustments (repay / debt-decrease) reach here with gross == 0:
        // no collateral leaves the pool, so there is nothing to settle. Skip the
        // controller round-trip and the ColFee event. (Baseline called
        // sendETH(borrower, 0) here — a value-less no-op that only emitted
        // EtherSent(_, 0) / ActivePoolETHBalanceUpdated; we drop that redundant
        // transfer, so debt-only ops emit fewer events than pre-ColFee.)
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
            SURFACE_ZERO_WITHDRAW_COLL,
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
                    SURFACE_ZERO_WITHDRAW_COLL,
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
                    SURFACE_ZERO_WITHDRAW_COLL,
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
                SURFACE_ZERO_WITHDRAW_COLL,
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
            require(queue != address(0), "COLFEE:queue-unset");
            require(amount <= uint256(uint128(-1)), "COLFEE:amount-too-large");

            // PUSH native to the queue (reuses the existing fail-closed sendETH
            // primitive — ActivePool.ETH decrements by exactly `amount`, identical
            // to the direct payout), then measured-record in the SAME outer tx.
            _activePool.sendETH(queue, amount);
            IExitDelayQueueHook(queue).recordReceivedNativeExit(
                uint128(amount),
                dl.d,
                SURFACE_ZERO_WITHDRAW_COLL,
                address(0),
                dl.effOrig,
                dl.effOwner,
                receiver
            );
        } else {
            _activePool.sendETH(receiver, amount); // EXISTING native payout, unchanged
        }
    }

    /// @notice Read-only preview of the ColFee exit fee on a Zero borrower collateral
    ///         payout of `grossColl` for `borrower`. Hard-wired to
    ///         SURFACE_ZERO_WITHDRAW_COLL / subProduct=address(0) / actor=borrower, and
    ///         routes through the same `_safeQuote` the live hook uses — so the synthesized
    ///         fail-open quote on controller failure matches execution wei-for-wise. The
    ///         caller passes `grossColl` (computed from trove state); this is a thin policy
    ///         lookup, not a re-derivation of the per-function gross.
    /// @return rateBps     resolved rate (0 when not charging / fail-open)
    /// @return feeAmount   fee that would be taken (0 unless active && rateBps>0 && not dust)
    /// @return netAmount   amount the borrower would receive (== grossColl when not charging)
    /// @return feeReceiver fee destination from the quote
    /// @return active      resolved policy active flag (the "will charge" test is active && feeAmount>0)
    /// @return reason      SkipReason (NONE on an honest/charging quote)
    function previewZeroCollWithdrawExitFee(
        address borrower,
        uint256 grossColl
    )
        external
        view
        returns (
            uint16 rateBps,
            uint256 feeAmount,
            uint256 netAmount,
            address feeReceiver,
            bool active,
            uint8 reason
        )
    {
        IExitFeeController.ExitFeeQuote memory q = _safeQuote(
            SURFACE_ZERO_WITHDRAW_COLL,
            address(0),
            borrower,
            grossColl
        );
        return (q.rateBps, q.feeAmount, q.netAmount, q.feeReceiver, q.active, q.reason);
    }

    /// Send ETH to Active Pool and increase its recorded ETH balance
    function _activePoolAddColl(IActivePool _activePool, uint256 _amount) internal {
        (bool success, ) = address(_activePool).call{ value: _amount }("");
        require(success, "BorrowerOps: Sending ETH to ActivePool failed");
    }

    /// Issue the specified amount of ZUSD to _account and increases the total active debt (_netDebtIncrease potentially includes a ZUSDFee)
    function _mintZusdAndIncreaseActivePoolDebt(
        IActivePool _activePool,
        IZUSDToken _zusdToken,
        address _account,
        uint256 _ZUSDAmount,
        uint256 _netDebtIncrease
    ) internal {
        _activePool.increaseZUSDDebt(_netDebtIncrease);
        _zusdToken.mint(_account, _ZUSDAmount);
    }

    /// Burn the specified amount of ZUSD from _account and decreases the total active debt
    function _burnZusdAndDecreaseActivePoolDebt(
        IActivePool _activePool,
        IZUSDToken _zusdToken,
        address _account,
        uint256 _ZUSD
    ) internal {
        _activePool.decreaseZUSDDebt(_ZUSD);
        _zusdToken.burn(_account, _ZUSD);
    }

    // --- 'Require' wrapper functions ---

    function _requireSingularCollChange(uint256 _collWithdrawal) internal view {
        require(
            msg.value == 0 || _collWithdrawal == 0,
            "BorrowerOperations: Cannot withdraw and add coll"
        );
    }

    function _requireCallerIsBorrower(address _borrower) internal view {
        require(
            msg.sender == _borrower,
            "BorrowerOps: Caller must be the borrower for a withdrawal"
        );
    }

    function _requireNonZeroAdjustment(
        uint256 _collWithdrawal,
        uint256 _ZUSDChange
    ) internal view {
        require(
            msg.value != 0 || _collWithdrawal != 0 || _ZUSDChange != 0,
            "BorrowerOps: There must be either a collateral change or a debt change"
        );
    }

    function _requireTroveisActive(ITroveManager _troveManager, address _borrower) internal view {
        uint256 status = _troveManager.getTroveStatus(_borrower);
        require(status == 1, "BorrowerOps: Trove does not exist or is closed");
    }

    function _requireTroveisNotActive(
        ITroveManager _troveManager,
        address _borrower
    ) internal view {
        uint256 status = _troveManager.getTroveStatus(_borrower);
        require(status != 1, "BorrowerOps: Trove is active");
    }

    function _requireNonZeroDebtChange(uint256 _ZUSDChange) internal pure {
        require(_ZUSDChange > 0, "BorrowerOps: Debt increase requires non-zero debtChange");
    }

    function _requireNotInRecoveryMode(uint256 _price) internal view {
        require(
            !_checkRecoveryMode(_price),
            "BorrowerOps: Operation not permitted during Recovery Mode"
        );
    }

    function _requireNoCollWithdrawal(uint256 _collWithdrawal) internal pure {
        require(
            _collWithdrawal == 0,
            "BorrowerOps: Collateral withdrawal not permitted Recovery Mode"
        );
    }

    function _requireValidAdjustmentInCurrentMode(
        bool _isRecoveryMode,
        uint256 _collWithdrawal,
        bool _isDebtIncrease,
        LocalVariables_adjustTrove memory _vars
    ) internal view {
        /*
         *In Recovery Mode, only allow:
         *
         * - Pure collateral top-up
         * - Pure debt repayment
         * - Collateral top-up with debt repayment
         * - A debt increase combined with a collateral top-up which makes the ICR >= 150% and improves the ICR (and by extension improves the TCR).
         *
         * In Normal Mode, ensure:
         *
         * - The new ICR is above MCR
         * - The adjustment won't pull the TCR below CCR
         */
        if (_isRecoveryMode) {
            _requireNoCollWithdrawal(_collWithdrawal);
            if (_isDebtIncrease) {
                _requireICRisAboveCCR(_vars.newICR);
                _requireNewICRisAboveOldICR(_vars.newICR, _vars.oldICR);
            }
        } else {
            // if Normal Mode
            _requireICRisAboveMCR(_vars.newICR);
            _vars.newTCR = _getNewTCRFromTroveChange(
                _vars.collChange,
                _vars.isCollIncrease,
                _vars.netDebtChange,
                _isDebtIncrease,
                _vars.price
            );
            _requireNewTCRisAboveCCR(_vars.newTCR);
        }
    }

    function _requireICRisAboveMCR(uint256 _newICR) internal view {
        require(
            _newICR >= liquityBaseParams.MCR(),
            "BorrowerOps: An operation that would result in ICR < MCR is not permitted"
        );
    }

    function _requireICRisAboveCCR(uint256 _newICR) internal view {
        require(
            _newICR >= liquityBaseParams.CCR(),
            "BorrowerOps: Operation must leave trove with ICR >= CCR"
        );
    }

    function _requireNewICRisAboveOldICR(uint256 _newICR, uint256 _oldICR) internal pure {
        require(
            _newICR >= _oldICR,
            "BorrowerOps: Cannot decrease your Trove's ICR in Recovery Mode"
        );
    }

    function _requireNewTCRisAboveCCR(uint256 _newTCR) internal view {
        require(
            _newTCR >= liquityBaseParams.CCR(),
            "BorrowerOps: An operation that would result in TCR < CCR is not permitted"
        );
    }

    function _requireAtLeastMinNetDebt(uint256 _netDebt) internal pure {
        require(
            _netDebt >= MIN_NET_DEBT,
            "BorrowerOps: Trove's net debt must be greater than minimum"
        );
    }

    function _requireValidZUSDRepayment(
        uint256 _currentDebt,
        uint256 _debtRepayment
    ) internal pure {
        require(
            _debtRepayment <= _currentDebt.sub(ZUSD_GAS_COMPENSATION),
            "BorrowerOps: Amount repaid must not be larger than the Trove's debt"
        );
    }

    function _requireCallerIsStabilityPool() internal view {
        require(msg.sender == stabilityPoolAddress, "BorrowerOps: Caller is not Stability Pool");
    }

    function _requireSufficientZUSDBalance(
        IZUSDToken _zusdToken,
        address _borrower,
        uint256 _debtRepayment
    ) internal view {
        require(
            _zusdToken.balanceOf(_borrower) >= _debtRepayment,
            "BorrowerOps: Caller doesnt have enough ZUSD to make repayment"
        );
    }

    function _requireValidMaxFeePercentage(
        uint256 _maxFeePercentage,
        bool _isRecoveryMode
    ) internal view {
        if (_isRecoveryMode) {
            require(
                _maxFeePercentage <= DECIMAL_PRECISION,
                "Max fee percentage must less than or equal to 100%"
            );
        } else {
            require(
                _maxFeePercentage >= liquityBaseParams.BORROWING_FEE_FLOOR() &&
                    _maxFeePercentage <= DECIMAL_PRECISION,
                "Max fee percentage must be between 0.5% and 100%"
            );
        }
    }

    // --- ICR and TCR getters ---

    /// Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
    function _getNewNominalICRFromTroveChange(
        uint256 _coll,
        uint256 _debt,
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _debtChange,
        bool _isDebtIncrease
    ) internal pure returns (uint256) {
        (uint256 newColl, uint256 newDebt) = _getNewTroveAmounts(
            _coll,
            _debt,
            _collChange,
            _isCollIncrease,
            _debtChange,
            _isDebtIncrease
        );

        uint256 newNICR = LiquityMath._computeNominalCR(newColl, newDebt);
        return newNICR;
    }

    /// Compute the new collateral ratio, considering the change in coll and debt. Assumes 0 pending rewards.
    function _getNewICRFromTroveChange(
        uint256 _coll,
        uint256 _debt,
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _debtChange,
        bool _isDebtIncrease,
        uint256 _price
    ) internal pure returns (uint256) {
        (uint256 newColl, uint256 newDebt) = _getNewTroveAmounts(
            _coll,
            _debt,
            _collChange,
            _isCollIncrease,
            _debtChange,
            _isDebtIncrease
        );

        uint256 newICR = LiquityMath._computeCR(newColl, newDebt, _price);
        return newICR;
    }

    function _getNewTroveAmounts(
        uint256 _coll,
        uint256 _debt,
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _debtChange,
        bool _isDebtIncrease
    ) internal pure returns (uint256, uint256) {
        uint256 newColl = _coll;
        uint256 newDebt = _debt;

        newColl = _isCollIncrease ? _coll.add(_collChange) : _coll.sub(_collChange);
        newDebt = _isDebtIncrease ? _debt.add(_debtChange) : _debt.sub(_debtChange);

        return (newColl, newDebt);
    }

    function _getNewTCRFromTroveChange(
        uint256 _collChange,
        bool _isCollIncrease,
        uint256 _debtChange,
        bool _isDebtIncrease,
        uint256 _price
    ) internal view returns (uint256) {
        uint256 totalColl = getEntireSystemColl();
        uint256 totalDebt = getEntireSystemDebt();

        totalColl = _isCollIncrease ? totalColl.add(_collChange) : totalColl.sub(_collChange);
        totalDebt = _isDebtIncrease ? totalDebt.add(_debtChange) : totalDebt.sub(_debtChange);

        uint256 newTCR = LiquityMath._computeCR(totalColl, totalDebt, _price);
        return newTCR;
    }

    function getCompositeDebt(uint256 _debt) external view override returns (uint256) {
        return _getCompositeDebt(_debt);
    }

    function BORROWING_FEE_FLOOR() external view override returns (uint256) {
        return liquityBaseParams.BORROWING_FEE_FLOOR();
    }

    function getMassetManager() external view override returns (IMassetManager) {
        return massetManager;
    }
}
