// Builds the static demo for GitHub Pages into docs/.
//
//   npm run build:pages
//
// docs/index.html   = public/index.html (it falls back to recorded runs when there is no server)
// docs/demo-data.json = the chosen before/after runs from runs/, with local paths removed
// docs/runs/<run>/  = each run's raw output: console.txt, report.json, final pricing.ts (as .txt)
//
// runs/ is git-ignored, so this only works on the machine that recorded the runs.
// To feature other runs, edit PAIRS below.

import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./team-tools.js";

const PAIRS = [
  {
    id: "105734",
    label: "Kimi lead · Lead takes over after QA fails",
    bare: "20261117-105615-bare",
    harness: "20261117-105734-harness",
  },
  {
    id: "113132",
    label: "Kimi lead · Lead coaches after QA fails",
    bare: "20261117-113033-bare",
    harness: "20261117-113132-harness",
  },
];
const DEFAULT_PAIR = "105734";

const OUT = path.join(REPO_ROOT, "docs");

// Remove anything that points at this machine: the repo path and any user home folder.
function scrub(value: unknown): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const root of [REPO_ROOT, REPO_ROOT.replace(/\\/g, "/")]) s = s.split(root).join(".");
    return s
      .replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/g, "~")
      .replace(/\/(?:home|Users)\/[^/\s"']+/g, "~");
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => k !== "runDir")
        .map(([k, v]) => [k, scrub(v)]),
    );
  }
  return value;
}

function loadReport(dir: string) {
  const file = path.join(REPO_ROOT, "runs", dir, "report.json");
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Record it with npm run team first.`);
  return scrub(JSON.parse(fs.readFileSync(file, "utf8"))) as Record<string, unknown>;
}

// Raw output per run, served as plain text so browsers display it instead of downloading.
function exportRaw(dir: string) {
  const src = path.join(REPO_ROOT, "runs", dir);
  const dst = path.join(OUT, "runs", dir);
  fs.mkdirSync(dst, { recursive: true });
  const report = JSON.parse(fs.readFileSync(path.join(src, "report.json"), "utf8"));
  const m = report.models ?? {};
  const header = [
    `# Raw console output of run ${dir}`,
    `# mode: ${report.mode} · lead: ${m.lead ?? report.model} · engineer: ${m.engineer ?? "-"} · qa: ${m.qa ?? "-"} · user: ${m.user ?? "-"}`,
    `# Colors removed and local paths replaced; otherwise exactly as printed.`,
    "",
  ].join("\n");
  const log = fs.readFileSync(path.join(src, "console.log"), "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  // A UTF-8 BOM makes browsers decode emoji / ¥ correctly even if the host sends no charset.
  const BOM = "﻿";
  fs.writeFileSync(path.join(dst, "console.txt"), BOM + header + (scrub(log) as string), "utf8");
  fs.writeFileSync(path.join(dst, "report.json"), JSON.stringify(scrub(report), null, 2), "utf8");
  const code = path.join(src, "workspace", "pricing.ts");
  if (fs.existsSync(code)) fs.writeFileSync(path.join(dst, "pricing.ts.txt"), BOM + fs.readFileSync(code, "utf8"), "utf8");
}

fs.rmSync(path.join(OUT, "runs"), { recursive: true, force: true });
for (const p of PAIRS) {
  exportRaw(p.bare);
  exportRaw(p.harness);
}

const pairs = PAIRS.map((p) => ({
  id: p.id,
  label: p.label,
  bareDir: p.bare,
  harnessDir: p.harness,
  bare: loadReport(p.bare),
  harness: loadReport(p.harness),
}));
const first = pairs.find((p) => p.id === DEFAULT_PAIR) ?? pairs[0];

const data = {
  task: first.harness.task,
  models: first.harness.models,
  defaultPair: DEFAULT_PAIR,
  pairs,
};

fs.mkdirSync(OUT, { recursive: true });
fs.copyFileSync(path.join(REPO_ROOT, "public", "index.html"), path.join(OUT, "index.html"));
fs.writeFileSync(path.join(OUT, "demo-data.json"), JSON.stringify(data, null, 1), "utf8");
fs.writeFileSync(path.join(OUT, ".nojekyll"), "", "utf8");

const rawText = PAIRS.flatMap((p) => [p.bare, p.harness])
  .flatMap((d) => fs.readdirSync(path.join(OUT, "runs", d)).map((f) => fs.readFileSync(path.join(OUT, "runs", d, f), "utf8")))
  .join("\n");
const leaks = (JSON.stringify(data) + rawText).match(/Users[\\/]|[A-Za-z]:\\\\|[A-Za-z]:\\Users/g);
console.log(`Wrote docs/index.html, docs/demo-data.json and docs/runs/ (${pairs.length} pairs, default ${DEFAULT_PAIR}).`);
if (leaks) {
  console.error(`Possible local paths left in demo-data.json: ${leaks.length}`);
  process.exit(1);
}
