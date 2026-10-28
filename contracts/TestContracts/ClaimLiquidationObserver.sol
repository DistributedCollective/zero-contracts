// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;

interface IClaimBO {
    function openTrove(uint256, uint256, address, address) external payable;

    function claimCollateral() external;
}

interface IClaimTM {
    function liquidate(address) external;

    function liquidateTroves(uint256) external;

    function batchLiquidateTroves(address[] calldata) external;
}

interface IClaimPool {
    function getCollateral(address) external view returns (uint256);

    function getETH() external view returns (uint256);
}

/// @dev Ordinary claimant fixture observing settlement at its own payout callback.
contract ClaimLiquidationObserver {
    IClaimBO public bo;
    IClaimTM public tm;
    IClaimPool public pool;
    address public target;
    uint8 public mode;
    bool public enabled;
    bool public observed;
    bool public succeeded;
    uint256 public claimAtCallback;
    uint256 public trackedAtCallback;
    uint256 public nativeAtCallback;
    uint256 public payoutAtCallback;
    bytes32 public refusal;

    constructor(IClaimBO b, IClaimTM t, IClaimPool p) public {
        bo = b;
        tm = t;
        pool = p;
    }

    function open(uint256 debt) external payable {
        bo.openTrove{ value: msg.value }(1e18, debt, address(0), address(0));
    }

    function claim() external {
        bo.claimCollateral();
    }

    function configure(address a, uint8 m, bool e) external {
        target = a;
        mode = m;
        enabled = e;
    }

    function settleThenLiquidate() external {
        _liquidate();
    }

    receive() external payable {
        if (enabled && !observed) {
            observed = true;
            claimAtCallback = pool.getCollateral(address(this));
            trackedAtCallback = pool.getETH();
            nativeAtCallback = address(pool).balance;
            payoutAtCallback = msg.value;
            _liquidate();
        }
    }

    function _liquidate() private {
        if (mode == 0) {
            try tm.liquidate(target) {
                succeeded = true;
            } catch (bytes memory e) {
                refusal = keccak256(e);
            }
        } else if (mode == 1) {
            try tm.liquidateTroves(1) {
                succeeded = true;
            } catch (bytes memory e) {
                refusal = keccak256(e);
            }
        } else {
            address[] memory a = new address[](1);
            a[0] = target;
            try tm.batchLiquidateTroves(a) {
                succeeded = true;
            } catch (bytes memory e) {
                refusal = keccak256(e);
            }
        }
    }
}
