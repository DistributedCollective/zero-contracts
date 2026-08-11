// SPDX-License-Identifier: MIT
// ─────────────────────────────────────────────────────────────────────────────
// Vendored copy of the ColFee exit-fee controller interface, taken from
// DistributedCollective/colfee @ c85f60aef91bc644517cf1b3ea7c5e8c565f4ca5
//   src/interfaces/IExitFeeController.sol
// Do not change the declarations here: the binding property is ABI equality with
// the deployed controller. To pick up an interface change, change it upstream,
// re-copy, and bump the SHA above. Local formatting follows this repo's
// formatter, so the file is not byte-identical to the upstream source.
// ─────────────────────────────────────────────────────────────────────────────
// Range pragma is intentional: the same declarations are compiled under Solidity
// 0.5.17, 0.6.11 (this repo), and 0.8.20.
// aderyn-ignore-next-line(unspecific-solidity-pragma)
pragma solidity >=0.5.17 <0.9.0;
// `pragma experimental ABIEncoderV2;` is required for the 0.5.17 leg — that
// compiler needs the directive to emit/decode struct returns (ExitFeeQuote)
// across the ABI boundary. The modern `pragma abicoder v2;` was only added
// in 0.7.4 and is incompatible with 0.5.x, so the experimental pragma is the
// only spelling that works across all three target compilers. On 0.6+/0.8+
// the experimental pragma is accepted (silently on 0.6.x; with a deprecation
// notice on 0.8.x that does NOT enable the historical encoder bugs — those
// bugs were fixed long before 0.6.0). This is a pure interface (no
// implementation, no storage), so there is no exposure to encoder-bug
// surface area beyond the ABI itself. Removing it would require a separate
// file per pragma, reintroducing declaration drift between the consumers.
// aderyn-ignore-next-line(experimental-encoder)
pragma experimental ABIEncoderV2;

/// @title  IExitFeeController
/// @notice Cross-pragma interface for the Sovryn ExitFee (ColFee) controller.
///         One declaration shared by every consumer so they all resolve the
///         same ABI. Products compiled under a pragma this file cannot span
///         declare their own ABI-equivalent variant instead.
///         Zero calls only `quoteExitFee`; the rest is declared for completeness.
interface IExitFeeController {
    // ─── Types ────────────────────────────────────────────────────────────

    /// @notice Reason a `ColFeeSkipped` event was emitted instead of an
    ///         `ColFeeApplied`. NONE covers honest paths (positive charge,
    ///         dust, or actor-exemption); the rest cover off-state outcomes.
    enum SkipReason {
        NONE, // Controller computed an honest quote (charge / dust / zero-rate).
        INACTIVE, // exitFeeEnabled == false.
        DISABLED, // feeReceiver == address(0), OR surface gate off.
        INVALID_QUOTE, // Defensive: overflow or fee > gross.
        CONTROLLER_REVERT, // Set by the product's local _safeQuote on staticcall failure.
        VAULT_REVERT // Set by the product hook when the fee transfer itself failed.
    }

    /// @notice A single rate-policy entry. Lives at each of the three tiers
    ///         (actor → sub-product → surface).
    struct RatePolicy {
        bool active;
        uint16 rateBps;
    }

    /// @notice Quote returned by `quoteExitFee`. `reason` carries the precise
    ///         off-state code; `active` is the resolved policy state (true iff
    ///         a RatePolicy.active entry was used and reason ∈ {NONE}).
    struct ExitFeeQuote {
        bool active;
        uint16 rateBps;
        uint256 feeAmount;
        uint256 netAmount;
        address feeReceiver;
        uint8 reason;
    }

    // ─── Events ───────────────────────────────────────────────────────────

    event ExitFeeEnabledSet(bool enabled);
    event FeeReceiverSet(address indexed feeReceiver);
    event SurfacePolicySet(bytes32 indexed surfaceId, bool active, uint16 rateBps);
    event SubProductPolicySet(
        bytes32 indexed surfaceId,
        address indexed subProduct,
        bool active,
        uint16 rateBps
    );
    event ActorPolicySet(
        bytes32 indexed surfaceId,
        address indexed actor,
        bool active,
        uint16 rateBps
    );
    event SubProductPolicyRemoved(bytes32 indexed surfaceId, address indexed subProduct);
    event ActorPolicyRemoved(bytes32 indexed surfaceId, address indexed actor);

    // ─── Quote ────────────────────────────────────────────────────────────

    /// @notice Resolve the fee policy for `(surfaceId, subProduct, actor)` and
    ///         compute the fee on `grossAmount`. Reads only; never reverts on
    ///         policy lookups (returns active=false with a SkipReason instead).
    ///         May revert only on internal arithmetic invariants (caught by
    ///         the product's local _safeQuote helper as CONTROLLER_REVERT).
    function quoteExitFee(
        bytes32 surfaceId,
        address subProduct,
        address actor,
        uint256 grossAmount
    ) external view returns (ExitFeeQuote memory);

    // ─── State views ──────────────────────────────────────────────────────

    function exitFeeEnabled() external view returns (bool);

    function feeReceiver() external view returns (address);

    function surfacePolicy(bytes32 surfaceId) external view returns (RatePolicy memory);

    function subProductPolicy(
        bytes32 surfaceId,
        address subProduct
    ) external view returns (RatePolicy memory);

    function actorPolicy(
        bytes32 surfaceId,
        address actor
    ) external view returns (RatePolicy memory);

    function subProductKeys(bytes32 surfaceId) external view returns (address[] memory);

    function actorKeys(bytes32 surfaceId) external view returns (address[] memory);

    // ─── Admin ────────────────────────────────────────────────────────────

    function setExitFeeEnabled(bool enabled) external;

    function setFeeReceiver(address newReceiver) external;

    function setSurfacePolicy(bytes32 surfaceId, RatePolicy calldata policy) external;

    function setSubProductPolicy(
        bytes32 surfaceId,
        address subProduct,
        RatePolicy calldata policy
    ) external;

    function setSubProductPolicies(
        bytes32 surfaceId,
        address[] calldata subProducts,
        RatePolicy[] calldata policies
    ) external;

    function setActorPolicy(bytes32 surfaceId, address actor, RatePolicy calldata policy) external;

    function setActorPolicies(
        bytes32 surfaceId,
        address[] calldata actors,
        RatePolicy[] calldata policies
    ) external;

    function removeSubProductPolicy(bytes32 surfaceId, address subProduct) external;

    function removeSubProductPolicies(bytes32 surfaceId, address[] calldata subProducts) external;

    function removeActorPolicy(bytes32 surfaceId, address actor) external;

    function removeActorPolicies(bytes32 surfaceId, address[] calldata actors) external;
}
