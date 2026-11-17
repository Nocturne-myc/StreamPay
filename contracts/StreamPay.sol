// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Fully prepaid streams for one immutable standard ERC-20 token.
/// @dev Uses OpenZeppelin Contracts 5.4.0; elapsed-time streaming is inspired by
/// Sablier. This is an independent, restricted educational implementation.
contract StreamPay is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status { Scheduled, Active, Ended, Cancelled }

    struct Stream {
        address sender;
        address recipient;
        uint256 deposit;
        uint256 start;
        uint256 end;
        uint256 withdrawn;
        bool cancelled;
        uint256 accruedAtCancellation;
        uint256 refunded;
    }

    error InvalidToken(address tokenAddress);
    error InvalidRecipient(address recipient);
    error InvalidAmount();
    error InvalidSchedule(uint256 start, uint256 end);
    error StreamNotFound(uint256 id);
    error InexactFunding(uint256 expected, uint256 beforeBalance, uint256 afterBalance);
    error UnauthorizedSender(address caller);
    error UnauthorizedRecipient(address caller);
    error AlreadyCancelled(uint256 id);
    error StreamAlreadyEnded(uint256 id);
    error InsufficientWithdrawable(uint256 requested, uint256 available);
    error NoRefund(uint256 id);

    event StreamCreated(uint256 indexed id, address indexed sender, address indexed recipient, uint256 deposit, uint256 start, uint256 end);
    event Withdrawn(uint256 indexed id, address indexed recipient, uint256 amount);
    event Cancelled(uint256 indexed id, address indexed sender, uint256 accruedAmount, uint256 refundAmount);
    event RefundWithdrawn(uint256 indexed id, address indexed sender, uint256 amount);

    IERC20 public immutable token;
    uint256 public nextStreamId = 1;
    uint256 public totalLiabilities;
    mapping(uint256 id => Stream) private streams;

    constructor(address token_) {
        if (token_ == address(0) || token_.code.length == 0) revert InvalidToken(token_);
        (bool success, bytes memory result) = token_.staticcall(abi.encodeCall(IERC20.balanceOf, (address(this))));
        // Interface screening only: a valid ABI word cannot establish trust.
        if (!success || result.length != 32) revert InvalidToken(token_);
        token = IERC20(token_);
    }

    function createStream(address recipient, uint256 amount, uint256 start, uint256 end) external nonReentrant returns (uint256 id) {
        if (recipient == address(0) || recipient == msg.sender || recipient == address(this)) revert InvalidRecipient(recipient);
        if (amount == 0) revert InvalidAmount();
        if (start < block.timestamp || end <= start) revert InvalidSchedule(start, end);

        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 afterBalance = token.balanceOf(address(this));
        if (afterBalance < beforeBalance || afterBalance - beforeBalance != amount) {
            revert InexactFunding(amount, beforeBalance, afterBalance);
        }

        id = nextStreamId++;
        streams[id] = Stream(msg.sender, recipient, amount, start, end, 0, false, 0, 0);
        totalLiabilities += amount;
        emit StreamCreated(id, msg.sender, recipient, amount, start, end);
    }

    /// @notice Pull a positive amount of the caller's available recipient share.
    function withdraw(uint256 id, uint256 amount) external nonReentrant {
        Stream storage stream = _stream(id);
        if (msg.sender != stream.recipient) revert UnauthorizedRecipient(msg.sender);
        if (amount == 0) revert InvalidAmount();
        uint256 available = _accrued(stream) - stream.withdrawn;
        if (amount > available) revert InsufficientWithdrawable(amount, available);

        stream.withdrawn += amount;
        totalLiabilities -= amount;
        token.safeTransfer(stream.recipient, amount);
        emit Withdrawn(id, stream.recipient, amount);
    }

    /// @notice Freeze earned funds without making a token transfer.
    function cancel(uint256 id) external nonReentrant {
        Stream storage stream = _stream(id);
        if (msg.sender != stream.sender) revert UnauthorizedSender(msg.sender);
        if (stream.cancelled) revert AlreadyCancelled(id);
        if (block.timestamp >= stream.end) revert StreamAlreadyEnded(id);

        uint256 earned = _accrued(stream);
        stream.accruedAtCancellation = earned;
        stream.cancelled = true;
        emit Cancelled(id, stream.sender, earned, stream.deposit - earned);
    }

    /// @notice Pull the sender's unclaimed cancellation refund independently.
    function withdrawRefund(uint256 id) external nonReentrant {
        Stream storage stream = _stream(id);
        if (msg.sender != stream.sender) revert UnauthorizedSender(msg.sender);
        uint256 amount = stream.cancelled ? stream.deposit - stream.accruedAtCancellation - stream.refunded : 0;
        if (amount == 0) revert NoRefund(id);

        stream.refunded += amount;
        totalLiabilities -= amount;
        token.safeTransfer(stream.sender, amount);
        emit RefundWithdrawn(id, stream.sender, amount);
    }

    function getStream(uint256 id) external view returns (Stream memory) {
        return _stream(id);
    }

    function accrued(uint256 id) external view returns (uint256) {
        return _accrued(_stream(id));
    }

    function withdrawable(uint256 id) external view returns (uint256) {
        Stream storage stream = _stream(id);
        return _accrued(stream) - stream.withdrawn;
    }

    function refundable(uint256 id) external view returns (uint256) {
        Stream storage stream = _stream(id);
        return stream.cancelled ? stream.deposit - stream.accruedAtCancellation - stream.refunded : 0;
    }

    function status(uint256 id) external view returns (Status) {
        Stream storage stream = _stream(id);
        if (stream.cancelled) return Status.Cancelled;
        if (block.timestamp < stream.start) return Status.Scheduled;
        if (block.timestamp >= stream.end) return Status.Ended;
        return Status.Active;
    }

    function _stream(uint256 id) private view returns (Stream storage stream) {
        stream = streams[id];
        if (stream.sender == address(0)) revert StreamNotFound(id);
    }

    function _accrued(Stream storage stream) private view returns (uint256) {
        if (stream.cancelled) return stream.accruedAtCancellation;
        if (block.timestamp <= stream.start) return 0;
        if (block.timestamp >= stream.end) return stream.deposit;
        return Math.mulDiv(stream.deposit, block.timestamp - stream.start, stream.end - stream.start);
    }
}
