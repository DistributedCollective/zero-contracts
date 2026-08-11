// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

/// @notice ColFee test double: a fee receiver that burns essentially all the
///         gas forwarded to it. consumeAll=false → burns down to a small floor
///         then RETURNS SUCCESS (the starvation shape: without the pool's
///         FEE_LEG_GAS_CAP this would leave the claimant leg out of gas);
///         consumeAll=true → burns until it OOGs (fee leg fails → fail-open).
contract GasSinkFeeReceiver {
    bool public consumeAll;
    uint256 public totalReceived;

    function setConsumeAll(bool _v) external {
        consumeAll = _v;
    }

    receive() external payable {
        totalReceived += msg.value;
        uint256 floor = consumeAll ? 0 : 5000;
        bytes32 h;
        while (gasleft() > floor) {
            h = keccak256(abi.encode(h));
        }
    }
}
