const hre = require("hardhat");
const path = require("node:path");
const { ROOT, BUILD, sourceHashes, requireCredentials, assertSepolia, hashCode, writeJson, saveConfirmedRecord, assertFreshPublicManifest, redact } = require("./lib/deployment.cjs");

async function deploy(runtime = hre, options = {}) {
  const isPublic = runtime.network.name === "sepolia";
  if (isPublic) requireCredentials(options.env || process.env);
  else if (!["hardhat", "localhost"].includes(runtime.network.name)) throw Error("Select hardhat, localhost or sepolia explicitly.");
  const provider = runtime.ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);
  if (isPublic) await assertSepolia(provider);
  else if (chainId !== 31337) throw Error("Local deployment requires chain ID 31337.");
  const [signer] = await runtime.ethers.getSigners();
  if (!signer) throw Error("No signer configured.");
  const manifest = { status: "deploying", network: runtime.network.name, chainId,
    startedAt: new Date().toISOString(), compiler: BUILD, compilerLongVersion: require("solc").version(), sourceHashes: sourceHashes(),
    node: process.version, hardhat: require("hardhat/package.json").version, contracts: [] };
  const file = options.manifestFile || path.join(ROOT, "deployment", isPublic ? "sepolia.json" : "local.json");
  if (isPublic) assertFreshPublicManifest(file);
  writeJson(file, manifest);
  try {
    for (const name of ["MockStreamToken", "StreamPay"]) {
      const args = name === "StreamPay" ? [manifest.contracts[0].address] : [];
      const contract = await (await runtime.ethers.getContractFactory(name, signer)).deploy(...args);
      const transaction = contract.deploymentTransaction(), receipt = await transaction.wait();
      if (receipt.status !== 1) throw Error("Deployment receipt indicates failure.");
      const address = receipt.contractAddress || await contract.getAddress();
      await saveConfirmedRecord(file, manifest, { name, address, deployer: await signer.getAddress(), constructorArguments: args,
        transactionHash: receipt.hash, blockNumber: receipt.blockNumber, blockTimestamp: null,
        gasUsed: receipt.gasUsed.toString(), runtimeCodeSha256: null,
        explorerUrl: isPublic ? `https://sepolia.etherscan.io/address/${address}` : null,
        verification: { status: "not-executed", verifiedSourceUrl: null } }, async () => {
        const [block, code] = await Promise.all([provider.getBlock(receipt.blockNumber), provider.getCode(address)]);
        if (!block || code === "0x") throw Error("Confirmed deployment metadata is not available yet.");
        return { blockTimestamp: block.timestamp, runtimeCodeSha256: hashCode(code) };
      });
    }
    manifest.status = isPublic ? "deployed" : "deployed-local";
    manifest.completedAt = new Date().toISOString(); writeJson(file, manifest);
    console.log(`Deployed two contracts on ${runtime.network.name} (chain ${chainId}); manifest: deployment/${path.basename(file)}`);
    return manifest;
  } catch (error) {
    manifest.status = manifest.contracts.length ? "partial-deployment" : "deployment-failed";
    manifest.failure = { category: manifest.contracts.some(record => record.metadataStatus === "incomplete") ? "metadata-failed" : "deployment-failed", confirmedContracts: manifest.contracts.length };
    writeJson(file, manifest); throw error;
  }
}
if (require.main === module) deploy().catch(error => { console.error(redact(error.shortMessage || error.message)); process.exitCode = 1; });
module.exports = { deploy };
