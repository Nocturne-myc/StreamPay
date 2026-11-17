const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const { ROOT, assertSepolia, requireCredentials, sourceHashes, validateManifest, compiledForManifest, writeJson, redact } = require("./lib/deployment.cjs");

function integer(name) {
  if (!/^\d+$/.test(process.env[name] || "")) throw Error(`${name} must be an unsigned integer in raw units.`);
  return BigInt(process.env[name]);
}
async function main() {
  if (!["localhost", "sepolia"].includes(hre.network.name)) throw Error("Use --network localhost or sepolia with a persistent deployment.");
  const isPublic = hre.network.name === "sepolia", action = process.env.ACTION || "query";
  if (isPublic) { await assertSepolia(hre.ethers.provider); if (action !== "query") requireCredentials(); }
  else if (BigInt((await hre.ethers.provider.getNetwork()).chainId) !== 31337n) throw Error("Expected local chain ID 31337.");
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment", isPublic ? "sepolia.json" : "local.json")));
  if (manifest.chainId !== Number((await hre.ethers.provider.getNetwork()).chainId) || manifest.contracts?.length !== 2) throw Error("Deployment manifest does not match this network.");
  const codes = Object.fromEntries(await Promise.all(manifest.contracts.map(async item => [item.address, await hre.ethers.provider.getCode(item.address)])));
  if (Object.values(codes).some(code => code === "0x")) throw Error("Node/addresses do not match; check deployment before interacting.");
  const compiled = await compiledForManifest(hre, manifest);
  const bindingReader = new hre.ethers.Contract(manifest.contracts[1].address, (await hre.artifacts.readArtifact("StreamPay")).abi, hre.ethers.provider);
  validateManifest(manifest, sourceHashes(), codes, compiled, await bindingReader.token());
  const index = Number(process.env.SIGNER_INDEX || 0), signers = await hre.ethers.getSigners();
  if (action !== "query" && (!Number.isSafeInteger(index) || index < 0 || !signers[index])) throw Error("SIGNER_INDEX does not select a configured account.");
  const signer = action === "query" ? hre.ethers.provider : signers[index];
  const token = new hre.ethers.Contract(manifest.contracts[0].address, (await hre.artifacts.readArtifact("MockStreamToken")).abi, signer);
  const stream = new hre.ethers.Contract(manifest.contracts[1].address, (await hre.artifacts.readArtifact("StreamPay")).abi, signer);
  const logFile = path.join(ROOT, "evidence", `interactions-${hre.network.name}.json`);
  const log = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile)) : { chainId: manifest.chainId, operations: [] };
  async function send(label, promise) {
    const receipt = await (await promise).wait();
    const block = await hre.ethers.provider.getBlock(receipt.blockNumber);
    log.operations.push({ action: label, caller: await signer.getAddress(), transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber, blockTimestamp: block.timestamp, gasUsed: receipt.gasUsed.toString(), status: receipt.status });
    writeJson(logFile, log); console.log(`${label}: ${receipt.hash}`);
  }
  if (action === "create") {
    const recipient = process.env.RECIPIENT;
    if (!hre.ethers.isAddress(recipient || "")) throw Error("RECIPIENT must be an address.");
    const amount = integer("AMOUNT"), start = integer("START"), end = integer("END");
    if (amount === 0n || start >= end || BigInt((await hre.ethers.provider.getBlock("latest")).timestamp) > start) throw Error("Invalid amount or schedule; no approval broadcast.");
    if ([hre.ethers.ZeroAddress, await stream.getAddress(), await signer.getAddress()].some(address => address.toLowerCase() === recipient.toLowerCase())) throw Error("Invalid recipient; no approval broadcast.");
    await send("approve", token.approve(await stream.getAddress(), amount));
    await send("create", stream.createStream(recipient, amount, start, end));
  } else if (action === "withdraw") await send(action, stream.withdraw(integer("STREAM_ID"), integer("AMOUNT")));
  else if (action === "cancel") await send(action, stream.cancel(integer("STREAM_ID")));
  else if (action === "refund") await send(action, stream.withdrawRefund(integer("STREAM_ID")));
  else if (action === "query") {
    const id = integer("STREAM_ID"), item = await stream.getStream(id);
    console.log(JSON.stringify({ id: id.toString(), sender: item.sender, recipient: item.recipient,
      deposit: item.deposit.toString(), start: item.start.toString(), end: item.end.toString(),
      withdrawn: item.withdrawn.toString(), cancelled: item.cancelled, refunded: item.refunded.toString(),
      accrued: (await stream.accrued(id)).toString(), withdrawable: (await stream.withdrawable(id)).toString(),
      refundable: (await stream.refundable(id)).toString(), status: ["Scheduled", "Active", "Ended", "Cancelled"][Number(await stream.status(id))] }, null, 2));
  } else throw Error("ACTION must be query, create, withdraw, cancel or refund.");
}
main().catch(error => { console.error(redact(error.shortMessage || error.message)); process.exitCode = 1; });
