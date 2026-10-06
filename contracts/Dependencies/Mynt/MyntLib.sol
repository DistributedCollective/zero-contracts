// SPDX-License-Identifier: MIT

pragma solidity 0.6.11;

import "./IMassetManager.sol";
import "./IDLLR.sol";
import "../SafeMath.sol";
import { IPermit2, ISignatureTransfer } from "../../Interfaces/IPermit2.sol";

library MyntLib {
    using SafeMath for uint256;

    /**
     * @notice Convert DLLR _dllrAmount to _toToken utilizing EIP-2612 permit
     * to reduce the additional sending transaction for doing the approval to the spender.
     *
     * @dev WARNING!! Do not us this lib function on RSK network because there is a griefing attack issue in the DLLR contract.
     *
     * @param _myntMassetManager Mynt protocol MassetManager contract address - needed for integration
     * @param _dllrAmount The amount of the DLLR (mAsset) token that will be burned in exchange for _toToken
     * @param _toToken bAsset token address to withdraw from DLLR
     * @param _permitParams EIP-2612 permit params:
     *        _deadline Expiration time of the signature.
     *        _v Last 1 byte of ECDSA signature.
     *        _r First 32 bytes of ECDSA signature.
     *        _s 32 bytes after _r in ECDSA signature.
     * @return redeemed ZUSD amount
     */
    function redeemZusdFromDllrWithPermit(
        IMassetManager _myntMassetManager,
        uint256 _dllrAmount,
        address _toToken,
        IMassetManager.PermitParams calldata _permitParams
    ) internal returns (uint256) {
        IDLLR dllr = IDLLR(_myntMassetManager.getToken());
        uint256 thisBalanceBefore = dllr.balanceOf(address(this));
        address thisAddress = address(this);
        dllr.transferWithPermit(
            msg.sender,
            thisAddress,
            _dllrAmount,
            _permitParams.deadline,
            _permitParams.v,
            _permitParams.r,
            _permitParams.s
        );
        require(
            dllr.balanceOf(thisAddress).sub(thisBalanceBefore) == _dllrAmount,
            "DLLR transferred amount validation failed"
        );
        return _myntMassetManager.redeemTo(_toToken, _dllrAmount, msg.sender);
    }

    /**
     * @notice Convert DLLR _dllrAmount to _toToken utilizing EIP-2612 permit via a canonical Permit2 contract
     * to reduce the additional sending transaction for doing the approval to the spender.
     *
     * @param _myntMassetManager Mynt protocol MassetManager contract address - needed for integration
     * @param _toToken bAsset token address to withdraw from DLLR
     * @param _permit permit data, in form of PermitTransferFrom struct.
     * @param _permit2 permit2 contract address
     * @param _signature signatue of the permit data.
     * @return redeemed ZUSD amount
     */
    function redeemZusdFromDllrWithPermit2(
        IMassetManager _myntMassetManager,
        address _toToken,
        ISignatureTransfer.PermitTransferFrom memory _permit,
        IPermit2 _permit2,
        bytes calldata _signature
    ) internal returns (uint256) {
        IDLLR dllr = IDLLR(_myntMassetManager.getToken());
        uint256 thisBalanceBefore = dllr.balanceOf(address(this));
        address thisAddress = address(this);
        uint256 _dllrAmount = _permit.permitted.amount;

        _permit2.permitTransferFrom(
            _permit,
            _generateTransferDetails(thisAddress, _dllrAmount),
            msg.sender,
            _signature
        );

        require(
            dllr.balanceOf(thisAddress).sub(thisBalanceBefore) == _dllrAmount,
            "DLLR transferred amount validation failed"
        );
        return _myntMassetManager.redeemTo(_toToken, _dllrAmount, msg.sender);
    }

    /**
     * @dev view function to construct SignatureTransferDetails struct to be used by Permit2
     *
     * @param _to ultimate recipient
     * @param _amount amount of transfer
     *
     * @return SignatureTransferDetails struct object 
     */
    function _generateTransferDetails(address _to, uint256 _amount) private view returns (ISignatureTransfer.SignatureTransferDetails memory) {
        ISignatureTransfer.SignatureTransferDetails memory transferDetails = ISignatureTransfer.SignatureTransferDetails({
            to: _to,
            requestedAmount: _amount
        });

        return transferDetails;
    }
}
