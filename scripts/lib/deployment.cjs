const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "../..");
const BUILD = Object.freeze({ version: "0.8.28", optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" });
const sha256 = value => crypto.createHash("sha256").update(value).digest("hex");
const hashCode = code => sha256(Buffer.from(code.replace(/^0x/, ""), "hex"));

function requireCredentials(env = process.env, verification = false) {
  let rpc;
  try { rpc = new URL(env.SEPOLIA_RPC_URL); } catch { throw Error("SEPOLIA_RPC_URL is required and must be an HTTP(S) URL."); }
  if (!["http:", "https:"].includes(rpc.protocol) || rpc.username || rpc.password) {
    throw Error("SEPOLIA_RPC_URL must use HTTP(S) without embedded credentials.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.PRIVATE_KEY || "")) throw Error("PRIVATE_KEY must be a locally configured 32-byte hex key.");
  if (verification && !(env.ETHERSCAN_API_KEY || "").trim()) throw Error("ETHERSCAN_API_KEY is required for verification.");
  return { rpcUrl: env.SEPOLIA_RPC_URL, privateKey: env.PRIVATE_KEY, apiKey: env.ETHERSCAN_API_KEY };
}

async function assertSepolia(provider) {
  if (BigInt((await provider.getNetwork()).chainId) !== 11155111n) throw Error("Refusing broadcast: expected Sepolia chain ID 11155111.");
  return 11155111;
}

function sourceHashes(root = ROOT) {
  const names = ["contracts/MockStreamToken.sol", "contracts/StreamPay.sol", "hardhat.config.cjs", "package.json", "pnpm-lock.yaml"];
  return Object.fromEntries(names.map(name => [name, sha256(fs.readFileSync(path.join(root, name)))]));
}

function matchesCompiledCode(actual, compiled) {
  if (!compiled || !/^0x[0-9a-f]+$/i.test(compiled.deployedBytecode || "") || actual.length !== compiled.deployedBytecode.length) return false;
  let observed = actual.slice(2).toLowerCase(), expected = compiled.deployedBytecode.slice(2).toLowerCase();
  for (const [id, locations] of Object.entries(compiled.immutableReferences || {})) for (const { start, length } of locations) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || (start + length) * 2 > observed.length) return false;
    const value = compiled.immutableValues?.[id];
    if (typeof value !== "string" || value.length !== length * 2 || !/^[0-9a-f]+$/i.test(value)) return false;
    const a = start * 2, b = (start + length) * 2;
    expected = expected.slice(0, a) + value.toLowerCase() + expected.slice(b);
  }
  return observed === expected;
}

async function compiledForManifest(runtime, manifest) {
  const compiled = {};
  for (const record of manifest.contracts || []) {
    if (!["MockStreamToken", "StreamPay"].includes(record.name)) throw Error("Unexpected artifact name.");
    const sourceName = `contracts/${record.name}.sol`, fqn = `${sourceName}:${record.name}`;
    const [artifact, build] = await Promise.all([runtime.artifacts.readArtifact(fqn), runtime.artifacts.getBuildInfo(fqn)]);
    if (!build || build.solcLongVersion !== require("solc").version() || build.input.settings.evmVersion !== BUILD.evmVersion ||
        build.input.settings.optimizer?.enabled !== true || build.input.settings.optimizer?.runs !== 200) throw Error("Compiled artifact build provenance differs from the pinned settings.");
    for (const file of ["contracts/MockStreamToken.sol", "contracts/StreamPay.sol"]) {
      if (build.input.sources[file]?.content !== fs.readFileSync(path.join(ROOT, file), "utf8")) throw Error("Compiled artifact source differs; run a normal uninstrumented compile.");
    }
    const immutableReferences = build.output.contracts[sourceName][record.name].evm.deployedBytecode.immutableReferences || {};
    if ((record.name === "StreamPay" && Object.keys(immutableReferences).length !== 1) ||
        (record.name === "MockStreamToken" && Object.keys(immutableReferences).length !== 0)) throw Error("Unsupported compiled immutable layout.");
    const tokenWord = String(manifest.contracts[0].address).replace(/^0x/, "").padStart(64, "0").toLowerCase();
    compiled[record.address] = { deployedBytecode: artifact.deployedBytecode, immutableReferences,
      immutableValues: Object.fromEntries(Object.keys(immutableReferences).map(id => [id, tokenWord])) };
  }
  return compiled;
}

function validateManifest(manifest, currentSources, onchainCodes, compiled, observedToken) {
  const publicRecord = manifest?.network === "sepolia" && manifest.chainId === 11155111 && ["deployed", "verified"].includes(manifest.status);
  const localRecord = ["hardhat", "localhost"].includes(manifest?.network) && manifest.chainId === 31337 && manifest.status === "deployed-local";
  if (!publicRecord && !localRecord) {
    throw Error("Manifest is not a completed deployment on the selected network.");
  }
  const compiler = manifest.compiler;
  if (compiler?.version !== BUILD.version || compiler?.evmVersion !== BUILD.evmVersion ||
      compiler?.optimizer?.enabled !== true || compiler?.optimizer?.runs !== 200) throw Error("Compiler/build settings differ from the pinned configuration.");
  const recorded = manifest.sourceHashes || {};
  if (Object.keys(recorded).length !== Object.keys(currentSources).length ||
      Object.entries(currentSources).some(([name, hash]) => recorded[name] !== hash)) throw Error("Source/config/lock hash mismatch.");
  const records = manifest.contracts;
  if (!Array.isArray(records) || records.length !== 2 || records[0].name !== "MockStreamToken" || records[1].name !== "StreamPay") {
    throw Error("Manifest must contain the two assessed contracts in deployment order.");
  }
  for (const record of records) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(record.address || "") || /^0x0{40}$/i.test(record.address)) throw Error("Invalid contract address in manifest.");
    const code = onchainCodes[record.address];
    if (!/^0x[0-9a-fA-F]+$/.test(code || "") || code.length % 2 !== 0 || hashCode(code) !== record.runtimeCodeSha256) {
      throw Error("Runtime code missing or changed.");
    }
    if (!matchesCompiledCode(code, compiled?.[record.address])) throw Error("Runtime code differs from the local compiled artifact.");
  }
  if (records[0].address.toLowerCase() === records[1].address.toLowerCase() ||
      records[0].constructorArguments?.length !== 0 || records[1].constructorArguments?.length !== 1 ||
      String(records[1].constructorArguments[0]).toLowerCase() !== records[0].address.toLowerCase()) {
    throw Error("Constructor linkage does not match token then escrow deployment.");
  }
  if (String(observedToken || "").toLowerCase() !== records[0].address.toLowerCase()) throw Error("On-chain token binding differs from the recorded token.");
  return true;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
  fs.renameSync(temporary, file);
}

function saveRecord(file, manifest, record) {
  if (manifest.contracts.some(item => item.name === record.name)) throw Error("Duplicate deployment record.");
  manifest.contracts.push(record);
  writeJson(file, manifest);
}

async function saveConfirmedRecord(file, manifest, record, loadMetadata) {
  record.metadataStatus = "pending";
  saveRecord(file, manifest, record);
  try {
    Object.assign(record, await loadMetadata()); record.metadataStatus = "complete";
    writeJson(file, manifest);
  } catch (error) {
    record.metadataStatus = "incomplete"; writeJson(file, manifest); throw error;
  }
}

function assertFreshPublicManifest(file) {
  if (!fs.existsSync(file)) return true;
  let existing;
  try { existing = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw Error("Existing public manifest cannot be read safely; preserve and archive it before retrying."); }
  if (existing.status === "pending-user-deferred" && Array.isArray(existing.contracts) && existing.contracts.length === 0) return true;
  throw Error("Existing public deployment evidence is preserved. Archive it deliberately before starting a new deployment; automatic overwrite is refused.");
}

function redact(message, env = process.env) {
  let result = String(message);
  for (const name of ["PRIVATE_KEY", "ETHERSCAN_API_KEY", "SEPOLIA_RPC_URL"]) {
    if (env[name]) result = result.split(env[name]).join("[redacted]");
  }
  return result;
}

module.exports = { ROOT, BUILD, sha256, hashCode, sourceHashes, requireCredentials, assertSepolia, validateManifest, compiledForManifest, matchesCompiledCode, writeJson, saveRecord, saveConfirmedRecord, assertFreshPublicManifest, redact };
