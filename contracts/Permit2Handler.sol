// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import { IPermit2, ISignatureTransfer } from "./Interfaces/IPermit2.sol";
import "./Dependencies/Counters.sol";

contract Permit2Handler {
    using Counters for Counters.Counter;

    IPermit2 public immutable permit2;

    mapping(address => Counters.Counter) private _permit2Nonces;

    /** Constructor */
    constructor(address _permit2) public {
        permit2 = IPermit2(_permit2);
    }

    /**
     * @dev "Consume a nonce": return the current value and increment.
     *
     * @param owner address of owner
     *
     * @return current nonce of the owner's address
     */
    function _useNonce(address owner) internal virtual returns (uint256 current) {
        Counters.Counter storage nonce = _permit2Nonces[owner];
        current = nonce.current();
        nonce.increment();
    }

    /**
     * @dev getter for currernt nonce
     *
     * @param owner address of owner
     * @return current nonce of the owner's address
     */
    function nonces(address owner) public view returns (uint256) {
        return _permit2Nonces[owner].current();
    }
}