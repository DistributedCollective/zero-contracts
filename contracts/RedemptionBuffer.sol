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

    uint256 public totalBufferedColl;

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

    function deposit() external payable override onlyBorrowerOps {
        require(msg.value > 0, "RB: no value");
        totalBufferedColl = totalBufferedColl.add(msg.value);
    }

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

    function distributeToStakers(uint256 _amount) external override onlyOwner {
        require(address(feeDistributor) != address(0), "RB: feeDistributor not set");
        require(_amount <= totalBufferedColl, "RB: insufficient buffer");

        totalBufferedColl = totalBufferedColl.sub(_amount);

        (bool success, ) = address(feeDistributor).call{ value: _amount }("");
        require(success, "RB: send to feeDistributor failed");

        // With the FeeDistributor patch above, this can now succeed.
        feeDistributor.distributeFees();
    }

    function syncBalance() external onlyOwner {
        totalBufferedColl = address(this).balance;
    }

    function getBalance() external view override returns (uint256) {
        return totalBufferedColl;
    }

    receive() external payable {
        totalBufferedColl = totalBufferedColl.add(msg.value);
    }
}
