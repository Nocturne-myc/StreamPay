// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST ONLY: deliberately malicious token and permissionless role actor.
/// @dev Not part of the supported StreamPay token model. Configuration and proxy
/// methods are intentionally unrestricted so each test can build hostile calls.
contract AdversarialToken is ERC20 {
    error FixtureTransferRejected();

    uint8 public incomingMode; // 0 exact, 1 short, 2 decrease, 3 false, 4 revert
    uint8 public outgoingMode; // 0 exact, 1 transfer then false, 2 revert
    address public blockedRecipient;
    address public callbackTarget;
    bytes public callbackData;
    bool public propagateCallbackFailure;
    uint8 public callbackOn; // 0 disabled, 1 incoming, 2 outgoing, 3 both
    bool public lastCallbackSuccess;
    bytes public lastCallbackResult;

    constructor(uint256 initialSupply) ERC20("Malicious Test Fixture", "FIXTURE") {
        _mint(msg.sender, initialSupply);
    }

    function setIncomingMode(uint8 mode) external { incomingMode = mode; }
    function setOutgoingMode(uint8 mode, address recipient) external {
        outgoingMode = mode;
        blockedRecipient = recipient;
    }
    function configureCallback(address target, bytes calldata data, bool propagate, uint8 on) external {
        callbackTarget = target;
        callbackData = data;
        propagateCallbackFailure = propagate;
        callbackOn = on;
        lastCallbackSuccess = false;
        delete lastCallbackResult;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (incomingMode == 4) revert FixtureTransferRejected();
        if (incomingMode == 2) {
            _burn(to, 1); // A hostile balance decrease rather than funding.
        } else if (incomingMode == 1) {
            _spendAllowance(from, msg.sender, amount);
            _transfer(from, to, amount - 1);
        } else {
            super.transferFrom(from, to, amount);
        }
        if (callbackOn == 1 || callbackOn == 3) _callback();
        return incomingMode != 3;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        bool blocked = blockedRecipient == address(0) || blockedRecipient == to;
        if (blocked && outgoingMode == 2) revert FixtureTransferRejected();
        super.transfer(to, amount);
        if (callbackOn == 2 || callbackOn == 3) _callback();
        return !(blocked && outgoingMode == 1);
    }

    function proxy(address target, bytes calldata data) external returns (bytes memory) {
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        return result;
    }

    function _callback() private {
        if (callbackTarget == address(0)) return;
        (bool ok, bytes memory result) = callbackTarget.call(callbackData);
        lastCallbackSuccess = ok;
        lastCallbackResult = result;
        if (!ok && propagateCallbackFailure) {
            assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
        }
    }
}
