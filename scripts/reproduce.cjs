const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const cp = require("node:child_process");
const { ROOT, sourceHashes, sha256, writeJson } = require("./lib/deployment.cjs");

const index = process.argv.indexOf("--archive");
const archive = index >= 0 ? path.resolve(process.argv[index + 1]) : null;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "streampay-reproduce-"));
const label = archive ? "archive" : "clean-source";
const output = { kind: archive ? "actual-zip-extraction" : "clean-source-copy", startedAt: new Date().toISOString(),
  sourceHashes: sourceHashes(), node: process.version, acquisition: process.env.STREAMPAY_PNPM_STORE ? "Frozen offline installation from an existing complete pnpm store" : "Frozen registry installation",
  store: process.env.STREAMPAY_PNPM_STORE || null, metadataCache: process.env.STREAMPAY_PNPM_CACHE || null,
  archiveSha256: archive ? sha256(fs.readFileSync(archive)) : null, steps: [] };
let work;
try {
  if (archive) {
    const extraction = cp.spawnSync("python3", ["-c", [
      "import zipfile,pathlib,sys,stat",
      "dest=pathlib.Path(sys.argv[2]).resolve()",
      "with zipfile.ZipFile(sys.argv[1]) as z:",
      " for item in z.infolist():",
      "  target=(dest/item.filename).resolve()",
      "  if not target.is_relative_to(dest) or stat.S_ISLNK(item.external_attr>>16): raise ValueError('unsafe archive path')",
      " z.extractall(dest)"
    ].join("\n"), archive, temporary], { encoding: "utf8" });
    if (extraction.status !== 0) throw Error(extraction.stderr || "Archive extraction failed.");
    const folders = fs.readdirSync(temporary, { withFileTypes: true }).filter(entry => entry.isDirectory());
    if (folders.length !== 1) throw Error("Archive must contain one root directory.");
    work = path.join(temporary, folders[0].name);
    const manifest = fs.readFileSync(path.join(work, "MANIFEST.sha256"), "utf8");
    for (const line of manifest.trim().split("\n")) {
      const match = line.match(/^([a-f0-9]{64})  (.+)$/);
      if (!match || sha256(fs.readFileSync(path.join(work, match[2]))) !== match[1]) throw Error("Archive file manifest mismatch.");
    }
    output.internalManifestVerified = true;
  } else {
    work = temporary;
    for (const item of ["package.json", "pnpm-lock.yaml", "hardhat.config.cjs", ".solcover.js", "contracts", "tests", "scripts"]) {
      fs.cpSync(path.join(ROOT, item), path.join(work, item), { recursive: true });
    }
  }
  const install = ["install", "--frozen-lockfile", "--ignore-scripts"];
  if (process.env.STREAMPAY_PNPM_STORE) install.push("--offline", "--store-dir", process.env.STREAMPAY_PNPM_STORE);
  if (process.env.STREAMPAY_PNPM_CACHE) install.push("--cache-dir", process.env.STREAMPAY_PNPM_CACHE);
  const env = { ...process.env, RECORD_TESTS: "", PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH };
  fs.mkdirSync(path.join(ROOT, "evidence/reproduction"), { recursive: true });
  for (const [name, args] of [["install", install], ["compile", ["compile"]], ["test", ["test"]], ["demo", ["demo"]]]) {
    const started = Date.now(), run = cp.spawnSync("pnpm", args, { cwd: work, env, encoding: "utf8", timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    const text = (run.stdout || "") + (run.stderr || "") + (run.error ? String(run.error) : "");
    const log = `evidence/reproduction/${label}-${name}.txt`; fs.writeFileSync(path.join(ROOT, log), text);
    output.steps.push({ name, command: "pnpm " + args.join(" "), exitCode: run.status, elapsedMs: Date.now() - started, log,
      observedPassingTests: name === "test" ? Number(text.match(/(\d+) passing/)?.[1] || 0) : undefined });
    console.log(`${label}: ${name} exit ${run.status}`);
    if (run.status !== 0) throw Error(`${name} failed; see ${log}`);
  }
  output.passed = true;
} catch (error) { output.passed = false; output.error = error.message; process.exitCode = 1; }
finally {
  output.completedAt = new Date().toISOString();
  writeJson(path.join(ROOT, archive ? "output/archive-verification.json" : "evidence/reproducibility.json"), output);
  fs.rmSync(temporary, { recursive: true, force: true });
}
