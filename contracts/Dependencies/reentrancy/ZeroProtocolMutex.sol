// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

/*
 * @title Zero Protocol Mutex contract
 *
 * @notice A mutex mechanism contract that will handle some function executions not to be in the same block
 */
contract ZeroProtocolMutex {
    /*
     * We use an uint to store the mutex state.
     */
    mapping(address => uint256) public userBlockNumber;

    /*
     * @notice set the user's block number for opening, and do check & reset to 0 for closing
     *
     * @dev This is the function will be called by the open, close, increase, decrease trove function
     */
    function handleMutex(bool _isOpening) external {
        if(_isOpening) {
            userBlockNumber[tx.origin] = block.number;
        } else {
            if(userBlockNumber[tx.origin] > 0) {
                if(userBlockNumber[tx.origin] == block.number) {
                    revert("ZeroProtocolMutex: mutex locked");
                }

                userBlockNumber[tx.origin] = 0;
            }
        }
    }
}
