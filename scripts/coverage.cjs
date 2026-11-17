const cp = require("node:child_process");
const { ROOT } = require("./lib/deployment.cjs");
// solidity-coverage 0.8.16's --testfiles filter omits .cjs files. A dedicated
// Mocha grep selects the contract cases while preserving every ordinary test.
const run = cp.spawnSync(process.execPath, [require.resolve("hardhat/internal/cli/bootstrap.js"), "coverage"], {
  cwd: ROOT, env: { ...process.env, STREAMPAY_COVERAGE: "1", RECORD_TESTS: "" }, stdio: "inherit"
});
process.exitCode = run.status === 0 ? 0 : 1;
