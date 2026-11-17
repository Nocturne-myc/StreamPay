const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const { ROOT } = require("./lib/deployment.cjs");
const result = path.join(ROOT, "evidence/test-results.json");
if (fs.existsSync(result)) fs.unlinkSync(result);
const args = [require.resolve("hardhat/internal/cli/bootstrap.js"), "test"];
const run = cp.spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, RECORD_TESTS: "1" }, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
const output = (run.stdout || "") + (run.stderr || "");
fs.mkdirSync(path.join(ROOT, "evidence"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "evidence/tests.txt"), `Command: node hardhat/internal/cli/bootstrap.js test (RECORD_TESTS=1)\nNode: ${process.version}\nExit: ${run.status}\n\n${output}`);
process.stdout.write(output);
if (!fs.existsSync(result)) { console.error("No fresh test-results.json was produced."); process.exitCode = 1; }
else process.exitCode = run.status === 0 ? 0 : 1;
