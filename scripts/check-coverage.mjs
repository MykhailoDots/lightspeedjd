#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const minArg = args.find((arg) => arg.startsWith("--min-lines="));
const fileArg = args.find((arg) => arg.startsWith("--file="));

const minLines = minArg ? Number(minArg.split("=")[1]) : 65;
if (!Number.isFinite(minLines) || minLines < 0 || minLines > 100) {
  console.error(`Invalid --min-lines value: ${minArg}`);
  process.exit(1);
}

const lcovPath = fileArg
  ? path.resolve(fileArg.split("=")[1])
  : path.resolve(process.cwd(), "coverage/lcov.info");

if (!fs.existsSync(lcovPath)) {
  console.error(`Coverage file not found: ${lcovPath}`);
  process.exit(1);
}

const content = fs.readFileSync(lcovPath, "utf-8");
const records = content.split("end_of_record");

const excludedPatterns = [
  /src\/graphql\/generated\//,
  /\.test\.ts$/,
  /\.spec\.ts$/,
];

const includedPatterns = [
  /src\/index\.ts$/,
  /src\/core\//,
  /src\/sources\//,
  /src\/helper\//,
  /src\/util\.ts$/,
  /src\/config\.ts$/,
];

let totalLines = 0;
let coveredLines = 0;

for (const record of records) {
  const lines = record
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) continue;

  const sfLine = lines.find((line) => line.startsWith("SF:"));
  if (!sfLine) continue;

  const filePath = sfLine.slice(3).replaceAll("\\", "/");
  if (excludedPatterns.some((pattern) => pattern.test(filePath))) {
    continue;
  }
  if (!includedPatterns.some((pattern) => pattern.test(filePath))) {
    continue;
  }

  for (const line of lines) {
    if (!line.startsWith("DA:")) continue;
    const [, payload] = line.split(":");
    const [, hits] = payload.split(",");
    totalLines += 1;
    if (Number(hits) > 0) coveredLines += 1;
  }
}

if (totalLines === 0) {
  console.error("No measured source lines found in coverage file.");
  process.exit(1);
}

const percentage = (coveredLines / totalLines) * 100;
console.log(
  `Coverage (filtered): ${percentage.toFixed(2)}% (${coveredLines}/${totalLines})`
);

if (percentage < minLines) {
  console.error(
    `Coverage threshold not met. Required >= ${minLines.toFixed(
      2
    )}%, got ${percentage.toFixed(2)}%.`
  );
  process.exit(1);
}

console.log(`Coverage threshold met (>= ${minLines.toFixed(2)}%).`);
