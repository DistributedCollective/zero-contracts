// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "./Dependencies/Ownable.sol";
import "./Dependencies/SafeMath.sol";
import "./Interfaces/IRedemptionBuffer.sol";
import "./Interfaces/IFeeDistributor.sol";

contract RedemptionBuffer is Ownable, IRedemptionBuffer {
    using SafeMath for uint256;

    address public borrowerOperations;
    address public troveManager;
    IFeeDistributor public feeDistributor;

    uint256 public totalBufferedColl; // RBTC tracked by this contract

    modifier onlyBorrowerOps() {
        require(msg.sender == borrowerOperations, "RB: caller is not BorrowerOperations");
        _;
    }

    modifier onlyTroveManager() {
        require(msg.sender == troveManager, "RB: caller is not TroveManager");
        _;
    }

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

    /// @dev Receives RBTC from BorrowerOperations when a user opens a Line of Credit.
    function deposit() external payable override onlyBorrowerOps {
        require(msg.value > 0, "RB: no value");
        totalBufferedColl = totalBufferedColl.add(msg.value);
    }

    /// @dev Used by TroveManager to serve ZUSD redemptions from the buffer.
    function withdrawForRedemption(address payable _to, uint256 _amount)
        external
        override
        onlyTroveManager
    {
        require(_amount <= totalBufferedColl, "RB: insufficient buffer");
        totalBufferedColl = totalBufferedColl.sub(_amount);

        (bool success, ) = _to.call{ value: _amount }("");
        require(success, "RB: send failed");
    }

    /// @dev Governance-controlled: send RBTC to FeeDistributor so it’s split like other ZERO fees.
    function distributeToStakers(uint256 _amount) external override onlyOwner {
        require(address(feeDistributor) != address(0), "RB: feeDistributor not set");
        require(_amount <= totalBufferedColl, "RB: insufficient buffer");

        totalBufferedColl = totalBufferedColl.sub(_amount);

        // Same pattern as TroveManagerRedeemOps
        (bool success, ) = address(feeDistributor).call{ value: _amount }("");
        require(success, "RB: send to feeDistributor failed");

        feeDistributor.distributeFees();
    }

    function getBalance() external view override returns (uint256) {
        return totalBufferedColl;
    }

    receive() external payable {}
}