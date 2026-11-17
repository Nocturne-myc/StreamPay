const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');

async function fixture() {
  const [sender, recipient, stranger, second] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory('MockStreamToken')).deploy();
  const escrow = await (await ethers.getContractFactory('StreamPay')).deploy(await token.getAddress());
  await token.approve(await escrow.getAddress(), ethers.MaxUint256);
  return { sender, recipient, stranger, second, token, escrow };
}
async function create(f, options = {}) {
  const start = options.start ?? (BigInt(await time.latest()) + 20n);
  const end = options.end ?? start + 100n;
  const amount = options.amount ?? 1000n;
  const recipient = options.recipient ?? f.recipient.address;
  const id = await f.escrow.nextStreamId();
  const tx = await f.escrow.createStream(recipient, amount, start, end);
  await tx.wait();
  return { id, start, end, amount, tx };
}
function actual(ctx, value) { ctx.test.ctx.actual = value; }
module.exports = { fixture, create, actual, ethers, time };
