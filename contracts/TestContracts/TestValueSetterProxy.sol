// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "../Proxy/UpgradableProxy.sol";

contract TestValueSetterProxy is UpgradableProxy {
    // This is here for the memory layout
    uint256 public value;
}
