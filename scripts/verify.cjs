const hre = require("hardhat");
const fs = require("node:fs");
const path = require("node:path");
const { Etherscan } = require("@nomicfoundation/hardhat-verify/etherscan");
const { ROOT, requireCredentials, assertSepolia, sourceHashes, validateManifest, compiledForManifest, writeJson, redact } = require("./lib/deployment.cjs");

async function main() {
  if (hre.network.name !== "sepolia") throw Error("Verification requires --network sepolia; local receipts are not public evidence.");
  requireCredentials(process.env, true); await assertSepolia(hre.ethers.provider);
  const chain = await Etherscan.getCurrentChainConfig(hre.network.name, hre.network.provider, hre.config.etherscan.customChains);
  const explorer = Etherscan.fromChainConfig(hre.config.etherscan.apiKey, chain);
  const file = path.join(ROOT, "deployment/sepolia.json"), manifest = JSON.parse(fs.readFileSync(file));
  if (!["deployed", "verified"].includes(manifest.status) || manifest.contracts?.length !== 2) throw Error("Sepolia deployment is incomplete; source verification cannot start.");
  const codes = Object.fromEntries(await Promise.all((manifest.contracts || []).map(async item => [item.address, await hre.ethers.provider.getCode(item.address)])));
  const compiled = await compiledForManifest(hre, manifest);
  const escrow = await hre.ethers.getContractAt("StreamPay", manifest.contracts[1].address);
  validateManifest(manifest, sourceHashes(), codes, compiled, await escrow.token());
  for (const item of manifest.contracts) {
    let response = "explorer reported already verified";
    const alreadyVerified = await explorer.isVerified(item.address);
    if (alreadyVerified && item.verification?.status === "verified") {
      console.log(`Etherscan verified ${item.name}: ${explorer.getContractUrl(item.address)}`);
      continue;
    }
    if (!alreadyVerified) {
      const contract = `contracts/${item.name}.sol:${item.name}`;
      const build = await hre.artifacts.getBuildInfo(contract);
      const artifact = await hre.artifacts.readArtifact(contract);
      const args = new hre.ethers.Interface(artifact.abi).encodeDeploy(item.constructorArguments).slice(2);
      // Etherscan uses Solidity release identifiers without the solc-js platform suffix.
      const version = `v${build.solcLongVersion.replace(/\.Emscripten\.clang$/, "")}`;
      try {
        const { message: guid } = await explorer.verify(item.address, JSON.stringify(build.input), contract, version, args);
        const result = await explorer.getVerificationStatus(guid);
        if (!result.isSuccess() && !result.isAlreadyVerified()) throw Error(result.message);
        response = result.message;
      } catch (error) {
        if (!/already (?:been )?verified/i.test(error.message)) throw error;
      }
    }
    item.verification = { status: "verified", checkedAt: new Date().toISOString(), response,
      verifiedSourceUrl: explorer.getContractUrl(item.address) };
    writeJson(file, manifest);
    console.log(`Etherscan verified ${item.name}: ${item.verification.verifiedSourceUrl}`);
  }
  if (manifest.status !== "verified") {
    manifest.status = "verified";
    writeJson(file, manifest);
  }
}
main().catch(error => { console.error(redact(error.shortMessage || error.message)); process.exitCode = 1; });
