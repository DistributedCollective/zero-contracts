// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "../Dependencies/reentrancy/SharedReentrancyGuard.sol";

contract TestNonReentrantValueSetter is SharedReentrancyGuard {
    uint256 public value;

    function setValueOpening(uint256 newValue) public {
        nonReentrantCheck(true);
        value = newValue;
    }

    function setValueClosing(uint256 newValue) public {
        nonReentrantCheck(false);
        value = newValue;
    }

    // this will always fail
    function setOtherContractValueNonReentrant(
        address other,
        uint256 newValue
    ) external {
        nonReentrantCheck(true);
        TestNonReentrantValueSetter(other).setValueClosing(newValue);
    }
}
