// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

interface IEIP712 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
