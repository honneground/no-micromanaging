// Builds the static demo for GitHub Pages into docs/.
//
//   npm run build:pages
//
// docs/index.html   = public/index.html (it falls back to recorded runs when there is no server)
// docs/demo-data.json = the chosen before/after runs from runs/, with local paths removed
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

const pairs = PAIRS.map((p) => ({ id: p.id, label: p.label, bare: loadReport(p.bare), harness: loadReport(p.harness) }));
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

const leaks = JSON.stringify(data).match(/Users[\\/]|[A-Za-z]:\\\\/g);
console.log(`Wrote docs/index.html and docs/demo-data.json (${pairs.length} pairs, default ${DEFAULT_PAIR}).`);
if (leaks) {
  console.error(`Possible local paths left in demo-data.json: ${leaks.length}`);
  process.exit(1);
}
