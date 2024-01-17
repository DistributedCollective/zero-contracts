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
     * @param _myntMassetManager Mynt protocol MassetManager contract address - needed for integration
     * @param _dllrAmount The amount of the DLLR (mAsset) token that will be burned in exchange for _toToken
     * @param _toToken bAsset token address to wothdraw from DLLR
     * @param _permitParams EIP-2612 permit params:
     *        _deadline Expiration time of the signature.
     *        _v Last 1 byte of ECDSA signature.
     *        _r First 32 bytes of ECDSA signature.
     *        _s 32 bytes after _r in ECDSA signature.
     * @param _nonce nonce
     * @param _permit2 permit2 contract interface
     * @return redeemed ZUSD amount
     */
    function redeemZusdFromDllrWithPermit(
        IMassetManager _myntMassetManager,
        uint256 _dllrAmount,
        address _toToken,
        IMassetManager.PermitParams calldata _permitParams,
        uint256 _nonce,
        IPermit2 _permit2
    ) internal returns (uint256) {
        IDLLR dllr = IDLLR(_myntMassetManager.getToken());
        uint256 thisBalanceBefore = dllr.balanceOf(address(this));
        address thisAddress = address(this);

        _permit2.permitTransferFrom(
            _generateERC20PermitTransfer(address(dllr), _dllrAmount, _permitParams.deadline, _nonce),
            _generateTransferDetails(thisAddress, _dllrAmount),
            msg.sender,
            _generatePermit2Signature(_permitParams.v, _permitParams.r, _permitParams.s)
        );

        require(
            dllr.balanceOf(thisAddress).sub(thisBalanceBefore) == _dllrAmount,
            "DLLR transferred amount validation failed"
        );
        return _myntMassetManager.redeemTo(_toToken, _dllrAmount, msg.sender);
    }

    /**
     * @dev view function to construct PermiTransferFrom struct to be used by Permit2
     *
     * @param _amount amount of transfer
     * @param _deadline signature deadline
     * @param _nonce nonce
     *
     * @return PermitTransferFrom struct object 
     */
    function _generateERC20PermitTransfer(address _token, uint256 _amount, uint256 _deadline, uint256 _nonce) private view returns (ISignatureTransfer.PermitTransferFrom memory) {
        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({
                token: _token, 
                amount: _amount
            }),
            nonce: _nonce,
            deadline: _deadline
        });

        return permit;
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

    /**
     * @dev view function to generate permit2 signature
     *
     * @param _v v component of ECDSA signature
     * @param _r r component of ECDSA signature
     * @param _s s component of ECDSA signature
     *
     * @return constructed signature
     */
    function _generatePermit2Signature(uint8 _v, bytes32 _r, bytes32 _s) private pure returns (bytes memory) {
        return abi.encodePacked(_r, _s, _v);
    }
}
