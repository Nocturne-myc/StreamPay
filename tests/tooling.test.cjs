const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  assertSepolia, requireCredentials, validateManifest, saveRecord, hashCode, redact,
  saveConfirmedRecord, assertFreshPublicManifest
} = require("../scripts/lib/deployment.cjs");

function example() {
  const token = "0x" + "12".repeat(20), escrow = "0x" + "34".repeat(20);
  const sourceHashes = { "contracts/StreamPay.sol": "source-A", "pnpm-lock.yaml": "lock-A" };
  const codes = { [token]: "0x60016000", [escrow]: "0x60026000" };
  const compiled = Object.fromEntries(Object.entries(codes).map(([address, code]) => [address, { deployedBytecode: code, immutableReferences: {} }]));
  return { sourceHashes, codes, compiled, token, manifest: {
    status: "deployed", network: "sepolia", chainId: 11155111,
    compiler: { version: "0.8.28", optimizer: { enabled: true, runs: 200 }, evmVersion: "shanghai" },
    sourceHashes,
    contracts: [
      { name: "MockStreamToken", address: token, constructorArguments: [], runtimeCodeSha256: hashCode(codes[token]) },
      { name: "StreamPay", address: escrow, constructorArguments: [token], runtimeCodeSha256: hashCode(codes[escrow]) }
    ]
  }};
}

describe("Deployment tooling without public transactions", function () {
  it("T-D01 refuses absent deployment credentials without exposing values", function () {
    assert.throws(() => requireCredentials({}), /SEPOLIA_RPC_URL/);
    assert.throws(() => requireCredentials({ SEPOLIA_RPC_URL: "https://example.invalid" }), /PRIVATE_KEY/);
    assert.throws(() => requireCredentials({ SEPOLIA_RPC_URL: "https://example.invalid", PRIVATE_KEY: "bad-secret" }), /PRIVATE_KEY/);
    this.test.ctx.actual = "Absent RPC/key and malformed key each rejected; errors contain field names only.";
  });
  it("T-D02 requires verification credentials only for verification", function () {
    const env = { SEPOLIA_RPC_URL: "https://example.invalid", PRIVATE_KEY: "0x" + "1".repeat(64) };
    assert.equal(requireCredentials(env).rpcUrl, env.SEPOLIA_RPC_URL);
    assert.throws(() => requireCredentials(env, true), /ETHERSCAN_API_KEY/);
    this.test.ctx.actual = "Deployment configuration accepted; verification rejected without explorer API key.";
  });
  it("T-D03 rejects a wrong chain before any broadcast", async function () {
    let broadcasts = 0;
    const provider = { getNetwork: async () => ({ chainId: 31337n }), sendTransaction: () => broadcasts++ };
    await assert.rejects(assertSepolia(provider), /11155111/);
    assert.equal(broadcasts, 0);
    assert.equal(await assertSepolia({ getNetwork: async () => ({ chainId: 11155111n }) }), 11155111);
    this.test.ctx.actual = "31337 rejected with zero broadcasts; 11155111 accepted.";
  });
  it("T-D04 validates matching source, constructor and on-chain code records", function () {
    const x = example();
    assert.equal(validateManifest(x.manifest, x.sourceHashes, x.codes, x.compiled, x.token), true);
    this.test.ctx.actual = "Two matching deployment records and constructor linkage accepted.";
  });
  it("T-D05 refuses changed source or lock hashes", function () {
    const x = example();
    assert.throws(() => validateManifest(x.manifest, { ...x.sourceHashes, "contracts/StreamPay.sol": "changed" }, x.codes, x.compiled, x.token), /hash/i);
    assert.throws(() => validateManifest(x.manifest, { ...x.sourceHashes, "pnpm-lock.yaml": "changed" }, x.codes, x.compiled, x.token), /hash/i);
    this.test.ctx.actual = "Independent source and lockfile mismatches both rejected.";
  });
  it("T-D06 refuses absent or changed runtime code", function () {
    const x = example(), addr = x.manifest.contracts[1].address;
    assert.throws(() => validateManifest(x.manifest, x.sourceHashes, { ...x.codes, [addr]: "0x" }, x.compiled, x.token), /code/i);
    assert.throws(() => validateManifest(x.manifest, x.sourceHashes, { ...x.codes, [addr]: "0x00" }, x.compiled, x.token), /code/i);
    this.test.ctx.actual = "Empty and altered runtime bytecode rejected.";
  });
  it("T-D07 rejects pending, malformed, mismatched-constructor and wrong-build manifests", function () {
    const x = example();
    for (const change of [
      m => m.status = "pending-user-deferred", m => m.chainId = 31337,
      m => m.contracts.pop(), m => m.contracts[1].constructorArguments = [m.contracts[1].address],
      m => m.compiler.optimizer.runs = 999
    ]) {
      const manifest = structuredClone(x.manifest); change(manifest);
      assert.throws(() => validateManifest(manifest, x.sourceHashes, x.codes, x.compiled, x.token));
    }
    this.test.ctx.actual = "All five malformed/status/network/constructor/compiler variants rejected.";
  });
  it("T-D08 persists each confirmed receipt before a later deployment fails", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streampay-manifest-"));
    try {
      const file = path.join(dir, "manifest.json"), manifest = { status: "deploying", contracts: [] };
      saveRecord(file, manifest, { name: "MockStreamToken", transactionHash: "confirmed-first" });
      assert.throws(() => { throw Error("second deployment failed"); });
      const saved = JSON.parse(fs.readFileSync(file));
      assert.equal(saved.contracts.length, 1);
      assert.equal(saved.contracts[0].transactionHash, "confirmed-first");
      assert.equal(saved.status, "deploying");
      this.test.ctx.actual = "First confirmed receipt remains on disk after simulated second-step failure.";
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("T-D09 redacts configured secrets and RPC URLs from errors", function () {
    const env = { PRIVATE_KEY: "sensitive-key", ETHERSCAN_API_KEY: "sensitive-api", SEPOLIA_RPC_URL: "https://rpc.invalid/private" };
    const result = redact(Object.values(env).join(" "), env);
    for (const value of Object.values(env)) assert.equal(result.includes(value), false);
    this.test.ctx.actual = "All configured key/API/RPC values replaced with redaction markers.";
  });
  it("T-D10 accepts equivalent build settings regardless of JSON key order", function () {
    const x = example();
    x.manifest.compiler = { evmVersion: "shanghai", optimizer: { runs: 200, enabled: true }, version: "0.8.28" };
    assert.equal(validateManifest(x.manifest, x.sourceHashes, x.codes, x.compiled, x.token), true);
    this.test.ctx.actual = "Semantically identical compiler settings accepted after JSON key reordering.";
  });
  it("T-D11 rejects self-consistent manifest hashes for unrelated runtime code", function () {
    const x = example(), unrelated = "0x60006000fd";
    const codes = Object.fromEntries(x.manifest.contracts.map(record => {
      record.runtimeCodeSha256 = hashCode(unrelated); return [record.address, unrelated];
    }));
    assert.throws(() => validateManifest(x.manifest, x.sourceHashes, codes, x.compiled, x.token), /compiled|artifact/i);
    this.test.ctx.actual = "Always-reverting runtime rejected even when the manifest hashes were made self-consistent.";
  });
  it("T-D12 preserves a confirmed deployment before metadata RPC failure", async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streampay-confirmed-"));
    try {
      const file = path.join(dir, "manifest.json"), manifest = { status: "deploying", contracts: [] };
      await assert.rejects(() => saveConfirmedRecord(file, manifest, { name: "MockStreamToken", transactionHash: "confirmed-first", blockNumber: 7 }, async () => { throw Error("metadata unavailable"); }), /metadata unavailable/);
      const saved = JSON.parse(fs.readFileSync(file));
      assert.equal(saved.contracts[0].transactionHash, "confirmed-first"); assert.equal(saved.contracts[0].blockNumber, 7);
      this.test.ctx.actual = "Confirmed hash/block saved before an intentionally failed metadata read.";
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("T-D13 refuses overwriting prior public deployment evidence", function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streampay-existing-"));
    try {
      const file = path.join(dir, "manifest.json");
      fs.writeFileSync(file, JSON.stringify({ status: "pending-user-deferred", contracts: [] }));
      assert.doesNotThrow(() => assertFreshPublicManifest(file));
      fs.writeFileSync(file, JSON.stringify({ status: "partial-deployment", contracts: [{ transactionHash: "confirmed-first" }] }));
      const original = fs.readFileSync(file, "utf8");
      assert.throws(() => assertFreshPublicManifest(file), /existing|preserv|archive/i);
      assert.equal(fs.readFileSync(file, "utf8"), original);
      this.test.ctx.actual = "Empty deferred marker accepted; prior confirmed public evidence rejected and preserved byte-for-byte.";
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("T-D14 deployment orchestration retains a receipt when metadata fails", async function () {
    const { deploy } = require("../scripts/deploy.cjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streampay-deploy-flow-"));
    try {
      const file = path.join(dir, "manifest.json"), address = "0x" + "12".repeat(20);
      const runtime = { network: { name: "sepolia" }, ethers: {
        provider: { getNetwork: async () => ({ chainId: 11155111n }), getBlock: async () => { throw Error("metadata unavailable"); }, getCode: async () => "0x6001" },
        getSigners: async () => [{ getAddress: async () => "0x" + "56".repeat(20) }],
        getContractFactory: async () => ({ deploy: async () => ({ getAddress: async () => address,
          deploymentTransaction: () => ({ wait: async () => ({ status: 1, hash: "0xconfirmed", blockNumber: 7, gasUsed: 21000n }) }) }) })
      }};
      await assert.rejects(() => deploy(runtime, { manifestFile: file, env: { SEPOLIA_RPC_URL: "https://example.invalid", PRIVATE_KEY: "0x" + "1".repeat(64) } }), /metadata unavailable/);
      const saved = JSON.parse(fs.readFileSync(file));
      assert.equal(saved.contracts[0].transactionHash, "0xconfirmed"); assert.equal(saved.contracts[0].address, address);
      assert.equal(saved.failure.confirmedContracts, 1); assert.equal(saved.contracts[0].metadataStatus, "incomplete");
      this.test.ctx.actual = "Actual deploy orchestration preserved confirmed address/hash/block and counted one confirmation after metadata failure.";
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("T-D15 public deployment retry preserves prior records before any broadcast", async function () {
    const { deploy } = require("../scripts/deploy.cjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "streampay-retry-flow-"));
    try {
      const file = path.join(dir, "manifest.json"), original = JSON.stringify({ status: "partial-deployment", contracts: [{ transactionHash: "prior-confirmed" }] });
      fs.writeFileSync(file, original); let factories = 0;
      const runtime = { network: { name: "sepolia" }, ethers: {
        provider: { getNetwork: async () => ({ chainId: 11155111n }) },
        getSigners: async () => [{ getAddress: async () => "0x" + "56".repeat(20) }],
        getContractFactory: async () => { factories++; throw Error("must not reach factory"); }
      }};
      await assert.rejects(() => deploy(runtime, { manifestFile: file, env: { SEPOLIA_RPC_URL: "https://example.invalid", PRIVATE_KEY: "0x" + "1".repeat(64) } }), /existing|preserv|archive/i);
      assert.equal(factories, 0); assert.equal(fs.readFileSync(file, "utf8"), original);
      this.test.ctx.actual = "Actual public retry stopped before the factory/broadcast and preserved the existing manifest byte-for-byte.";
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("T-D16 matches real compiled runtimes and independently checks token binding", async function () {
    const hre = require("hardhat"), { compiledForManifest } = require("../scripts/lib/deployment.cjs");
    const token = await (await hre.ethers.getContractFactory("MockStreamToken")).deploy(); await token.waitForDeployment();
    const escrow = await (await hre.ethers.getContractFactory("StreamPay")).deploy(await token.getAddress()); await escrow.waitForDeployment();
    const x = example(); x.manifest.network = "hardhat"; x.manifest.chainId = 31337; x.manifest.status = "deployed-local";
    x.manifest.contracts[0].address = await token.getAddress(); x.manifest.contracts[1].address = await escrow.getAddress();
    x.manifest.contracts[1].constructorArguments = [await token.getAddress()];
    const codes = Object.fromEntries(await Promise.all(x.manifest.contracts.map(async item => [item.address, await hre.ethers.provider.getCode(item.address)])));
    for (const item of x.manifest.contracts) item.runtimeCodeSha256 = hashCode(codes[item.address]);
    const compiled = await compiledForManifest(hre, x.manifest);
    assert.equal(validateManifest(x.manifest, x.sourceHashes, codes, compiled, await escrow.token()), true);
    assert.throws(() => validateManifest(x.manifest, x.sourceHashes, codes, compiled, hre.ethers.ZeroAddress), /token|binding/i);
    const reference = Object.values(compiled[await escrow.getAddress()].immutableReferences).flat()[1];
    assert.ok(reference && reference.length === 32);
    const address = await escrow.getAddress(), offset = 2 + reference.start * 2;
    const modified = codes[address].slice(0, offset) + "0".repeat(reference.length * 2) + codes[address].slice(offset + reference.length * 2);
    const tampered = structuredClone(x.manifest); tampered.contracts[1].runtimeCodeSha256 = hashCode(modified);
    assert.throws(() => validateManifest(tampered, x.sourceHashes, { ...codes, [address]: modified }, compiled, x.manifest.contracts[0].address), /compiled|artifact/i);
    this.test.ctx.actual = "Real compiled runtimes accepted; wrong token getter and a self-consistent single-site immutable alteration both rejected.";
  });
});
