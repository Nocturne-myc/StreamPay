const fs = require("node:fs");
const path = require("node:path");
const Mocha = require(require.resolve("mocha", { paths: [path.dirname(require.resolve("hardhat/package.json"))] }));
const { ROOT, BUILD, sourceHashes, sha256, writeJson } = require("./lib/deployment.cjs");

function testHashes(dir, relative = "tests") {
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const key = relative + "/" + entry.name, file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, testHashes(file, key));
    else result[key] = sha256(fs.readFileSync(file));
  }
  return result;
}

module.exports = class EvidenceReporter extends Mocha.reporters.Spec {
  constructor(runner, options) {
    super(runner, options);
    const startedAt = new Date().toISOString(), records = [];
    function record(test, status, error) {
      records.push({ id: test.title.match(/\bT-[A-Z]+\d+\b/)?.[0] || null,
        title: test.title, fullTitle: test.fullTitle(), status,
        actual: test.ctx?.actual || null, durationMs: test.duration ?? null,
        error: error ? { name: error.name, message: error.message } : null });
      if (test.ctx) delete test.ctx.actual;
    }
    runner.on("pass", test => record(test, "pass"));
    runner.on("fail", (test, error) => record(test, "fail", error));
    runner.on("pending", test => record(test, "pending"));
    runner.once("end", () => writeJson(path.join(ROOT, "evidence/test-results.json"), {
      startedAt, completedAt: new Date().toISOString(), environment: "Hardhat local execution; no public transactions",
      command: process.argv.slice(1).join(" "), node: process.version, compiler: BUILD,
      sourceHashes: sourceHashes(), testHashes: testHashes(path.join(ROOT, "tests")),
      stats: runner.stats, tests: records
    }));
  }
};
