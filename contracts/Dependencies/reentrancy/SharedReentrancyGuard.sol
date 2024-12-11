// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

import "../../Interfaces/IZeroProtocolMutex.sol";

/*
 * @title contract for shared reentrancy guards
 *
 * @dev This contract exposes the modifiers for opening, closing, increasing, decreasing trove functionality
 * The objective is we will not allow the opening, increase/decrease, closing functionalityto be executed in the same block
 *
 * @dev The ZeroProtocolMutex contract address is hardcoded because the address is deployed using a
 * special deployment method (similar to ERC1820Registry). This contract therefore has no
 * state and is thus safe to add to the inheritance chain of upgradeable contracts.
 */
contract SharedReentrancyGuard {
    /*
     * This is the address of the zero protocol mutex contract that will be used as the
     * reentrancy guard.
     *
     * The address is hardcoded to avoid changing the memory layout of
     * derived contracts (possibly upgradable). Hardcoding the address is possible,
     * because the Mutex contract is always deployed to the same address, with the
     * same method used in the deployment of ERC1820Registry.
     */
    IZeroProtocolMutex private constant MUTEX = IZeroProtocolMutex(0x42B023F998d7B9c127e9bDcDCE57ccd1f5e1d919);

    /*
     * This is the modifier that will be used to set the user's block number when opening/increasing trove
     */
    modifier nonReentrantAtOpening() {
        MUTEX.handleMutex(true);

        _;
    }

    /*
     * This is the modifier that will be used to check the user's block number to be not the same block
     * And if the check pass, it will reset the user's block number to 0
     * when closing trove
     */
    modifier nonReentrantAtClosing() {
        MUTEX.handleMutex(false);

        _;
    }

    /*
     * In case of _isDebtIncrease true it will do the same behaviour as nonReentrantAtOpening
     * Otherwise it will do the nonReentrantAtClosing
     */
    modifier nonReentrantAtTroveAdjustment(bool _isDebtIncrease) {
        if(_isDebtIncrease) {
            MUTEX.handleMutex(true);
        } else {
            MUTEX.handleMutex(false);
        }

        _;
    }
}
