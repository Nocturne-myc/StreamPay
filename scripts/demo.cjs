const hre = require("hardhat");
const path = require("node:path");
const assert = require("node:assert/strict");
const { deploy } = require("./deploy.cjs");
const { ROOT, sourceHashes, writeJson, redact } = require("./lib/deployment.cjs");

async function main() {
  if (hre.network.name !== "hardhat" || BigInt((await hre.ethers.provider.getNetwork()).chainId) !== 31337n) throw Error("The accelerated demo runs only on ephemeral Hardhat chain 31337.");
  const manifest = await deploy(), [sender, recipient] = await hre.ethers.getSigners();
  const token = await hre.ethers.getContractAt("MockStreamToken", manifest.contracts[0].address, sender);
  const stream = await hre.ethers.getContractAt("StreamPay", manifest.contracts[1].address, sender);
  const output = { environment: "Ephemeral Hardhat local chain; not Sepolia", chainId: 31337,
    generatedAt: new Date().toISOString(), sourceHashes: sourceHashes(), deployment: manifest,
    sender: sender.address, recipient: recipient.address, transactions: [], checkpoints: [] };
  async function send(action, promise) {
    const receipt = await (await promise).wait(), block = await hre.ethers.provider.getBlock(receipt.blockNumber);
    const events = [];
    for (const log of receipt.logs) {
      try {
        const decoded = (log.address.toLowerCase() === (await stream.getAddress()).toLowerCase() ? stream.interface : token.interface).parseLog(log);
        events.push({ name: decoded.name, args: Array.from(decoded.args).map(value => typeof value === "bigint" ? value.toString() : value) });
      } catch { /* A foreign log is not part of the two assessed interfaces. */ }
    }
    output.transactions.push({ action, hash: receipt.hash, blockNumber: receipt.blockNumber, timestamp: block.timestamp, gasUsed: receipt.gasUsed.toString(), status: receipt.status, events });
  }
  async function at(timestamp) { await hre.network.provider.send("evm_setNextBlockTimestamp", [timestamp]); }
  const now = (await hre.ethers.provider.getBlock("latest")).timestamp, firstStart = now + 30, secondStart = now + 200;
  await send("approve-two-streams", token.approve(await stream.getAddress(), 1700000n));
  await send("create-normal", stream.createStream(recipient.address, 1000000n, firstStart, firstStart + 100));
  await send("create-cancellable", stream.createStream(recipient.address, 700000n, secondStart, secondStart + 100));
  const beforeBalance = await token.balanceOf(recipient.address);
  await at(firstStart + 20); await hre.network.provider.send("evm_mine");
  const afterBalance = await token.balanceOf(recipient.address), accrued = await stream.accrued(1);
  assert.equal(beforeBalance, 0n); assert.equal(afterBalance, 0n); assert.equal(accrued, 200000n);
  output.checkpoints.push({ label: "Time changes entitlement without transferring tokens", timestamp: firstStart + 20,
    recipientBalanceBefore: beforeBalance, recipientBalanceAfter: afterBalance, accrued });
  await at(firstStart + 40); await send("partial-withdraw", stream.connect(recipient).withdraw(1, 400000n));
  await at(firstStart + 100); await send("final-withdraw", stream.connect(recipient).withdraw(1, 600000n));
  await at(secondStart + 40); await send("cancel-at-40-percent", stream.cancel(2));
  assert.equal(await stream.withdrawable(2), 280000n); assert.equal(await stream.refundable(2), 420000n);
  output.checkpoints.push({ label: "Cancellation preserves both independent claims", recipientDue: await stream.withdrawable(2), senderRefund: await stream.refundable(2), liabilities: await stream.totalLiabilities() });
  await send("recipient-cancelled-claim", stream.connect(recipient).withdraw(2, 280000n));
  await send("sender-refund", stream.withdrawRefund(2));
  assert.equal(await token.balanceOf(recipient.address), 1280000n);
  assert.equal(await token.balanceOf(await stream.getAddress()), 0n); assert.equal(await stream.totalLiabilities(), 0n);
  output.checkpoints.push({ label: "All obligations settled", recipientBalance: await token.balanceOf(recipient.address),
    escrowBalance: await token.balanceOf(await stream.getAddress()), liabilities: await stream.totalLiabilities(),
    firstStatus: Number(await stream.status(1)), secondStatus: Number(await stream.status(2)) });
  writeJson(path.join(ROOT, "evidence/local-demo.json"), output);
  console.log("Local demonstration passed: normal and cancelled streams settled; recipient received 1,280,000 raw units; escrow and liabilities are zero.");
}
main().catch(error => { console.error(redact(error.shortMessage || error.message)); process.exitCode = 1; });
