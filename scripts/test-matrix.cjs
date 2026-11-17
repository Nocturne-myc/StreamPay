const fs = require("node:fs");
const path = require("node:path");
const { ROOT } = require("./lib/deployment.cjs");
const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file)));
const cases = [...read("tests/cases-core.json"), ...read("tests/cases-tooling.json")];
const results = read("evidence/test-results.json");
const definitions = new Map(), executed = new Map();
for (const item of cases) {
  if (!item.id || definitions.has(item.id)) throw Error("Missing or duplicate case definition: " + item.id);
  for (const field of ["purpose", "preconditions", "steps", "expected"]) if (!item[field]) throw Error(item.id + " lacks " + field);
  definitions.set(item.id, item);
}
for (const item of results.tests) {
  if (!item.id || executed.has(item.id) || !definitions.has(item.id)) throw Error("Unknown, missing or duplicate executed ID: " + item.id);
  if (item.status === "pass" && !item.actual) throw Error(item.id + " has no actual-result observation.");
  executed.set(item.id, item);
}
if (definitions.size !== executed.size) throw Error("Some defined cases did not execute: " + [...definitions.keys()].filter(id => !executed.has(id)).join(", "));
const cell = value => (Array.isArray(value) ? value.join("; ") : String(value)).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
const lines = ["# StreamPay executed test matrix", "", `Run completed: ${results.completedAt}. All execution is local.`, "",
  "Each row joins a declared requirement with its actual test outcome. Numeric observations are supplied by executed tests, not generated from expected-result descriptions.", "",
  "| ID | Purpose | Preconditions | Steps / input | Expected | Actual | Status |", "| --- | --- | --- | --- | --- | --- | --- |"];
for (const [id, item] of definitions) {
  const actual = executed.get(id);
  lines.push("| " + [id, item.purpose, item.preconditions, item.steps, item.expected,
    actual.actual || actual.error?.message || "Not executed", actual.status].map(cell).join(" | ") + " |");
}
lines.push("", "Raw results: `evidence/test-results.json`; execution log: `evidence/tests.txt`. Test and production-source hashes accompany the raw results.", "");
fs.writeFileSync(path.join(ROOT, "docs/test-matrix.md"), lines.join("\n"));
console.log(`Matched ${executed.size} executed tests to ${definitions.size} case definitions.`);
if (results.tests.some(test => test.status !== "pass")) process.exitCode = 1;
