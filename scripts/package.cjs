const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const { ROOT, BUILD, sha256, sourceHashes, writeJson } = require("./lib/deployment.cjs");

const read = relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative)));
const tests = read("evidence/test-results.json"), reproduction = read("evidence/reproducibility.json");
const currentSources = sourceHashes();
if (!tests.tests.length || tests.tests.some(test => test.status !== "pass") || !reproduction.passed) throw Error("Current tests and clean-source reproduction must pass before packaging.");
for (const [file, hash] of Object.entries(currentSources)) if (tests.sourceHashes[file] !== hash || reproduction.sourceHashes[file] !== hash) throw Error("Validation source hash is stale: " + file);
for (const [file, hash] of Object.entries(tests.testHashes)) if (sha256(fs.readFileSync(path.join(ROOT, file))) !== hash) throw Error("Executed test file changed: " + file);

const publicDeployment = read("deployment/sepolia.json");
if (publicDeployment.network !== "sepolia" || publicDeployment.chainId !== 11155111 || !Array.isArray(publicDeployment.contracts)) {
  throw Error("Invalid Sepolia deployment manifest.");
}
const deferred = publicDeployment.status === "pending-user-deferred" && publicDeployment.contracts.length === 0;
if (!deferred) {
  const { status, contracts, compiler, compilerLongVersion, sourceHashes: recorded, hardhat } = publicDeployment;
  if (status !== "verified" || contracts.length !== 2 || contracts[0]?.name !== "MockStreamToken" || contracts[1]?.name !== "StreamPay") {
    throw Error("Package an empty deferred manifest or both verified Sepolia contracts.");
  }
  if (compiler?.version !== BUILD.version || compiler?.evmVersion !== BUILD.evmVersion ||
      compiler?.optimizer?.enabled !== BUILD.optimizer.enabled || compiler?.optimizer?.runs !== BUILD.optimizer.runs ||
      typeof compilerLongVersion !== "string" || !compilerLongVersion.startsWith(BUILD.version + "+") ||
      hardhat !== read("package.json").dependencies.hardhat) {
    throw Error("Verified deployment build settings must match the pinned build.");
  }
  if (Object.keys(recorded || {}).length !== Object.keys(currentSources).length ||
      Object.entries(currentSources).some(([file, hash]) => recorded[file] !== hash)) {
    throw Error("Verified deployment source hashes must match the package sources.");
  }
  const validAddress = value => /^0x[\da-f]{40}$/i.test(value) && !/^0x0{40}$/i.test(value);
  for (const record of contracts) {
    const explorerUrl = `https://sepolia.etherscan.io/address/${record.address}`;
    if (!validAddress(record.address) || !validAddress(record.deployer) || !/^0x[\da-f]{64}$/i.test(record.transactionHash) ||
        !Number.isSafeInteger(record.blockNumber) || record.blockNumber <= 0 ||
        !Number.isSafeInteger(record.blockTimestamp) || record.blockTimestamp <= 0 ||
        !/^[\da-f]{64}$/i.test(record.runtimeCodeSha256) || record.metadataStatus !== "complete" ||
        record.explorerUrl !== explorerUrl || record.verification?.status !== "verified" ||
        record.verification?.verifiedSourceUrl !== `${explorerUrl}#code`) {
      throw Error("Incomplete Sepolia receipt or source verification for " + record.name + ".");
    }
  }
  const [token, escrow] = contracts;
  if (token.address.toLowerCase() === escrow.address.toLowerCase() ||
      token.transactionHash.toLowerCase() === escrow.transactionHash.toLowerCase() ||
      !Array.isArray(token.constructorArguments) || token.constructorArguments.length !== 0 ||
      !Array.isArray(escrow.constructorArguments) || escrow.constructorArguments.length !== 1 ||
      String(escrow.constructorArguments[0]).toLowerCase() !== token.address.toLowerCase()) {
    throw Error("Verified Sepolia records must describe the token and its linked escrow.");
  }
}
if (!fs.existsSync(path.join(ROOT, "report/StreamPay_Report.pdf"))) throw Error("Compile and inspect the report before packaging.");

const rootName = "21346213_MA_Yuechen_CSIT5760_FinalProject";
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "streampay-package-")), folder = path.join(stage, rootName);
const files = new Set();
function collect(relative) {
  const absolute = path.join(ROOT, relative), stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw Error("Package source must not be a symbolic link: " + relative);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(absolute)) {
      const child = relative + "/" + entry;
      if (entry === "snapshots" || entry === ".DS_Store") continue;
      collect(child);
    }
  } else if (stat.isFile()) files.add(relative);
}
for (const file of ["README.md", "LICENCE", ".gitignore", "package.json", "pnpm-lock.yaml", "hardhat.config.cjs", ".solcover.js", "coverage.json"]) collect(file);
for (const directory of ["contracts", "tests", "scripts", "deployment", "audit", "evidence", "research", "docs"]) collect(directory);
for (const file of ["21346213_MA_Yuechen_CSIT5760_Proposal.pdf", "StreamPay_Proposal.tex", "StreamPay_Workflow.tikz", "proposal-sha256.json"]) collect("proposal/" + file);
for (const file of fs.readdirSync(path.join(ROOT, "report"))) if (/\.(tex|bib|png|jpg|jpeg|svg)$/.test(file)) collect("report/" + file);
try {
  fs.mkdirSync(folder, { recursive: true });
  for (const relative of [...files].sort()) {
    if (/(^|\/)(node_modules|\.build|tmp|output|\.env[^/]*)($|\/)/.test(relative)) throw Error("Excluded path entered package: " + relative);
    const destination = path.join(folder, relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), destination);
  }
  fs.copyFileSync(path.join(ROOT, "report/StreamPay_Report.pdf"), path.join(folder, "report.pdf"));
  fs.writeFileSync(path.join(folder, "STATUS.txt"), [
    "StreamPay: local implementation, tests, security review and documentation completed.",
    ...(deferred ? [
      "PUBLIC REQUIREMENTS PENDING: Sepolia deployment and Etherscan source verification were deferred.",
      "Public contract addresses, transaction hashes and verified-source URLs are still outstanding.",
    ] : [
      "PUBLIC DEPLOYMENT VERIFIED: deployment/sepolia.json records the receipts and Etherscan verified-source URLs for both contracts on chain 11155111.",
    ]),
    `Recorded automated test cases: ${tests.tests.length}. Local-chain evidence is labelled chain 31337.`, ""
  ].join("\n"));
  const staged = [];
  function walk(dir, prefix = "") {
    for (const name of fs.readdirSync(dir).sort()) {
      const relative = prefix + name, absolute = path.join(dir, name);
      if (fs.statSync(absolute).isDirectory()) walk(absolute, relative + "/"); else staged.push(relative);
    }
  }
  walk(folder);
  const banned = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:PRIVATE_KEY|ETHERSCAN_API_KEY)\s*=\s*["']?0x[a-f0-9]{64}\b/i;
  for (const relative of staged) {
    if (/\.(?:cjs|js|json|md|tex|txt|yaml)$/.test(relative) && banned.test(fs.readFileSync(path.join(folder, relative), "utf8"))) throw Error("Possible credential in package: " + relative);
  }
  fs.writeFileSync(path.join(folder, "MANIFEST.sha256"), staged.map(relative => `${sha256(fs.readFileSync(path.join(folder, relative)))}  ${relative}`).join("\n") + "\n");
  fs.mkdirSync(path.join(ROOT, "output"), { recursive: true });
  const archive = path.join(ROOT, "output", rootName + ".zip");
  const result = cp.spawnSync("python3", ["-c", [
    "import pathlib,zipfile,sys",
    "root=pathlib.Path(sys.argv[1])",
    "with zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED) as z:",
    " for p in sorted(root.rglob('*')):",
    "  if p.is_file(): z.write(p,str(pathlib.Path(root.name)/p.relative_to(root)))"
  ].join("\n"), folder, archive], { encoding: "utf8" });
  if (result.status !== 0) throw Error(result.stderr || "ZIP creation failed.");
  const checksum = sha256(fs.readFileSync(archive));
  fs.writeFileSync(archive + ".sha256", checksum + "  " + path.basename(archive) + "\n");
  writeJson(path.join(ROOT, "output/package-info.json"), { archive: path.basename(archive), sha256: checksum, files: staged.length + 1,
    bytes: fs.statSync(archive).size, publicStatus: publicDeployment.status, recordedTests: tests.tests.length });
  console.log(`Packaged ${staged.length + 1} files. Sepolia status: ${publicDeployment.status}. SHA256 ${checksum}`);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
