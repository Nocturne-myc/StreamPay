// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Fixed-supply, valueless demonstration token; six decimal units.
/// @dev ERC-20 implementation reused from OpenZeppelin Contracts 5.4.0.
contract MockStreamToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1_000_000 * 10 ** 6;

    constructor() ERC20("StreamPay Demo Token", "SPAY") {
        _mint(msg.sender, INITIAL_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
