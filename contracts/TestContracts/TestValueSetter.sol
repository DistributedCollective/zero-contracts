// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

contract TestValueSetter {
    uint256 public value;

    function setValueOpening(uint256 newValue) public {
        value = newValue;
    }

    function setValueClosing(uint256 newValue) public {
        value = newValue;
    }
}
