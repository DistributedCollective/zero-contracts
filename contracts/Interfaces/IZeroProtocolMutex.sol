pragma solidity 0.6.11;

interface IZeroProtocolMutex {
    function handleMutex(bool) external;
    function userBlockNumber(address) external view returns(uint256);
}
