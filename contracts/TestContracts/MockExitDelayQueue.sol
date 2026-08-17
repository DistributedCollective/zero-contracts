// SPDX-License-Identifier: MIT
pragma solidity 0.6.11;
pragma experimental ABIEncoderV2;

import "../Interfaces/colfee/IExitDelayQueueHook.sol";

/// @title  MockExitDelayQueue
/// @notice Minimal test double for the real 0.8.20 `ExitDelayQueue`, implemented
///         at 0.6.11 so the zero-contracts hardhat suites can deploy it and wire
///         it behind `BorrowerOperations` (the registered allowed source). It
///         mirrors ONLY the behaviour the Zero borrower hook depends on:
///           - an unconditional native `receive()` that accepts RBTC from
///             anyone with no sender gate;
///           - `recordReceivedNativeExit` (`onlyAllowedSource`), which narrows to
///             uint128, enforces the per-request delay floor, proves receipt by
///             measured-delta (surplus `>= amount`, credit EXACTLY `amount` —
///             ), stamps `unlockAt = now + delaySeconds`, and emits
///             `ExitQueued`;
///           - `executeExit`, which pays the immutable receiver after `unlockAt`
///             iff `msg.sender ∈ {originator, owner}` (receiver is NOT an executor)
///             and none of {originator, owner, receiver} is blocked;
///           - a minimal `freeze`/`unfreeze` block model so the fail-closed /
///             block-trap regressions can be exercised.
///         The three ERC20 / value-carrying ingress fns are present for interface
///         completeness but revert (the Zero surface is native-only). This is
///         deliberately NOT the full security model — the real queue's recovery
///         legs and per-request index are covered by the colfee Foundry suite.
contract MockExitDelayQueue is IExitDelayQueueHook {
    struct Req {
        uint128 amount;
        uint64 createdAt;
        uint64 unlockAt;
        address originator;
        address owner;
        address receiver;
        address token; // address(0) = native
        bytes32 surfaceId;
        address subProduct;
        bool executed;
    }

    uint32 public minimumDelaySeconds;
    uint256 public lastRequestId;
    mapping(uint256 => Req) internal _requests;
    mapping(address => bool) public allowedSource;
    mapping(address => bool) public blocked;
    // token => sum of Queued amounts (backing). address(0) = native.
    mapping(address => uint256) public totalEscrowed;

    event ExitQueued(
        uint256 indexed id,
        address indexed originator,
        address indexed owner,
        address receiver,
        address token,
        uint128 amount,
        uint64 unlockAt,
        bytes32 surfaceId,
        address subProduct
    );
    event ExitExecuted(
        uint256 indexed id,
        address indexed receiver,
        address token,
        uint128 amount
    );

    constructor(uint32 _minDelay) public {
        minimumDelaySeconds = _minDelay;
    }

    /// @dev Unconditional native receive() — accepts RBTC from anyone.
    receive() external payable {}

    function setAllowedSource(address src, bool ok) external {
        allowedSource[src] = ok;
    }

    function freeze(address a) external {
        blocked[a] = true;
    }

    function unfreeze(address a) external {
        blocked[a] = false;
    }

    modifier onlyAllowedSource() {
        require(allowedSource[msg.sender], "MockQueue: unregistered source");
        _;
    }

    function getRequest(uint256 id) external view returns (Req memory) {
        return _requests[id];
    }

    // ── Native measured-receipt ingress (the ONLY path Zero uses) ─────────────

    function recordReceivedNativeExit(
        uint128 amount,
        uint32 delaySeconds,
        bytes32 surfaceId,
        address subProduct,
        address effOrig,
        address effOwner,
        address receiver
    ) external override onlyAllowedSource returns (uint256 id) {
        require(amount > 0, "MockQueue: zero amount");
        require(delaySeconds >= minimumDelaySeconds, "MockQueue: delay below floor");
        // measured-receipt: the native RBTC was pushed to receive() first; the
        // non-backing surplus must cover `amount`, and we credit EXACTLY `amount`
        // A stray donation only raises the surplus and cannot brick the record.
        uint256 surplus = address(this).balance - totalEscrowed[address(0)];
        require(surplus >= amount, "MockQueue: received amount mismatch");
        totalEscrowed[address(0)] += amount;

        id = ++lastRequestId;
        Req storage r = _requests[id];
        r.amount = amount;
        r.createdAt = uint64(block.timestamp);
        r.unlockAt = uint64(block.timestamp + delaySeconds);
        r.originator = effOrig;
        r.owner = effOwner;
        r.receiver = receiver;
        r.token = address(0);
        r.surfaceId = surfaceId;
        r.subProduct = subProduct;

        emit ExitQueued(
            id,
            effOrig,
            effOwner,
            receiver,
            address(0),
            amount,
            r.unlockAt,
            surfaceId,
            subProduct
        );
    }

    // ── Execution (subset) ────────────────────────────────────────────────────

    function executeExit(uint256 id) external {
        Req storage r = _requests[id];
        require(r.amount > 0 && !r.executed, "MockQueue: not queued");
        require(block.timestamp >= r.unlockAt, "MockQueue: not unlocked");
        require(msg.sender == r.originator || msg.sender == r.owner, "MockQueue: not executor");
        require(
            !blocked[r.originator] && !blocked[r.owner] && !blocked[r.receiver],
            "MockQueue: actor blocked"
        );

        r.executed = true;
        totalEscrowed[r.token] -= r.amount;
        uint128 amount = r.amount;
        address payable receiver = address(uint160(r.receiver));

        (bool ok, ) = receiver.call{ value: amount }("");
        require(ok, "MockQueue: payout failed");
        emit ExitExecuted(id, receiver, r.token, amount);
    }

    // ── Interface completeness (Zero is native-only; these are unused) ────────

    function recordERC20Exit(
        address,
        uint128,
        uint32,
        bytes32,
        address,
        address,
        address,
        address,
        bool
    ) external override returns (uint256) {
        revert("MockQueue: erc20 unsupported");
    }

    function recordReceivedERC20Exit(
        address,
        uint128,
        uint32,
        bytes32,
        address,
        address,
        address,
        address
    ) external override returns (uint256) {
        revert("MockQueue: erc20 unsupported");
    }

    function recordNativeExit(
        uint128,
        uint32,
        bytes32,
        address,
        address,
        address,
        address
    ) external payable override returns (uint256) {
        revert("MockQueue: value-carrying unsupported");
    }
}
