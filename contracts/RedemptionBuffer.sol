// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "./Dependencies/Ownable.sol";
import "./Dependencies/SafeMath.sol";
import "./Interfaces/IRedemptionBuffer.sol";

/**
 * @dev Holds RBTC collected when Lines of Credit are opened.
 *      TroveManager uses this pool to satisfy ZUSD redemptions before touching troves.
 *      Governance (timelock / Bitocracy) can send excess RBTC to SOV stakers.
 */
contract RedemptionBuffer is Ownable, IRedemptionBuffer {
    using SafeMath for uint256;

    address public borrowerOperations;
    address public troveManager;

    uint256 public totalBufferedColl; // RBTC tracked by this contract

    modifier onlyBorrowerOps() {
        require(msg.sender == borrowerOperations, "RB: caller is not BorrowerOperations");
        _;
    }

    modifier onlyTroveManager() {
        require(msg.sender == troveManager, "RB: caller is not TroveManager");
        _;
    }

    function setAddresses(address _borrowerOps, address _troveManager) external onlyOwner {
        require(_borrowerOps != address(0) && _troveManager != address(0), "RB: zero address");
        borrowerOperations = _borrowerOps;
        troveManager = _troveManager;
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

    /// @dev Governance-controlled drain of RBTC from the buffer to SOV stakers.
    function distributeToStakers(address payable _stakingContract, uint256 _amount)
        external
        override
        onlyOwner
    {
        require(_stakingContract != address(0), "RB: zero staking address");
        require(_amount <= totalBufferedColl, "RB: insufficient buffer");

        totalBufferedColl = totalBufferedColl.sub(_amount);

        (bool success, ) = _stakingContract.call{ value: _amount }("");
        require(success, "RB: staking send failed");
    }

    /// @dev Returns the tracked RBTC balance of the buffer.
    function getBalance() external view override returns (uint256) {
        return totalBufferedColl;
    }

    // Accept stray RBTC (e.g. selfdestruct), but do not count it in totalBufferedColl
    receive() external payable {}
}