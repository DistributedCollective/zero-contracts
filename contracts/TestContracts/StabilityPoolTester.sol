// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "../StabilityPool.sol";

contract StabilityPoolTester is StabilityPool {

    /** Constructor */
    constructor(address _permit2) public StabilityPool(_permit2) {}
    
    function unprotectedPayable() external payable {
        ETH = ETH.add(msg.value);
    }
}
