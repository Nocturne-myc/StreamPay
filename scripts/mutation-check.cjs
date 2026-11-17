const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const { ROOT, sha256, writeJson } = require("./lib/deployment.cjs");

const originalFile = path.join(ROOT, "contracts/StreamPay.sol"), original = fs.readFileSync(originalFile, "utf8");
const mutants = [
  { id: "M01", name: "recipient-authorization", before: "if (msg.sender != stream.recipient) revert UnauthorizedRecipient(msg.sender);", after: "// Deliberately removed recipient authorization in this isolated mutant.", grep: "T-S" },
  { id: "M02", name: "withdrawal-accounting", before: "stream.withdrawn += amount;", after: "// Deliberately omitted the withdrawal ledger increment in this isolated mutant.", grep: "T-S" },
  { id: "M03", name: "cancellation-once", before: "if (stream.cancelled) revert AlreadyCancelled(id);", after: "// Deliberately removed one-time cancellation in this isolated mutant.", grep: "T-S" }
];
const results = { generatedAt: new Date().toISOString(), sourceSha256: sha256(original), mutationScope: "Three deliberate defects in temporary copies; no production source is altered.", mutants: [] };
for (const mutant of mutants) {
  if (original.split(mutant.before).length !== 2) throw Error(`Mutation ${mutant.id} does not match exactly one source location.`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "streampay-mutant-"));
  try {
    for (const name of ["package.json", "pnpm-lock.yaml", "hardhat.config.cjs", "contracts", "tests", "scripts"]) fs.cpSync(path.join(ROOT, name), path.join(temporary, name), { recursive: true });
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(temporary, "node_modules"), "dir");
    fs.mkdirSync(path.join(temporary, "evidence"));
    fs.writeFileSync(path.join(temporary, "contracts/StreamPay.sol"), original.replace(mutant.before, mutant.after));
    const args = [path.join(temporary, "node_modules/hardhat/internal/cli/bootstrap.js"), "test", "tests/settlement.test.cjs", "--grep", mutant.grep];
    const run = cp.spawnSync(process.execPath, args, { cwd: temporary, env: { ...process.env, RECORD_TESTS: "" }, encoding: "utf8", timeout: 120000 });
    const output = (run.stdout || "") + (run.stderr || ""), exitCode = run.status;
    const status = exitCode === 0 ? "survived" : /\d+ failing/.test(output) && !/Compilation failed|HH600/.test(output) ? "killed" : "build-failed";
    const log = `audit/mutations/${mutant.id}-${mutant.name}.txt`;
    fs.mkdirSync(path.join(ROOT, "audit/mutations"), { recursive: true }); fs.writeFileSync(path.join(ROOT, log), output);
    results.mutants.push({ ...mutant, status, exitCode, log, observedFailingTests: [...output.matchAll(/\)\s+([^\n]*T-S[^\n]*)/g)].map(match => match[1].trim()) });
    console.log(`${mutant.id}: ${status} (exit ${exitCode})`);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
results.productionSourceUnchanged = sha256(fs.readFileSync(originalFile)) === results.sourceSha256;
writeJson(path.join(ROOT, "audit/mutations.json"), results);
if (!results.productionSourceUnchanged || results.mutants.some(item => item.status !== "killed")) process.exitCode = 1;
