// No Micromanaging — CLI entry.
//
//   npm run team                          → before, then after, then comparison table
//   npm run team:before                   → bare Lead only
//   npm run team:after                    → with AI Decelerator only
//   npm run team -- --interactive         → you answer ask_user in the terminal
//   npm run team -- --scripted-user       → fixed reply instead of the Product Owner model
//   npm run team:runs                     → list saved runs
//   npm run team:replay -- latest         → replay the latest before+after pair (demo backup)
//   npm run team:replay -- runs/<dir>     → replay one saved run
//
// Models per role come from DEFAULT_MODELS (6-harness.ts); override with
// LEAD_MODEL / ENGINEER_MODEL / QA_MODEL / USER_MODEL in .env.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { BASE_URL } from "./2-model.js";
import {
  colors as C,
  createAutoUserChannel,
  createModelUserChannel,
  DEFAULT_MODELS,
  DEFAULT_TASK,
  DEFAULT_USER_RULES,
  runTeam,
  type Mode,
  type RoleModels,
  type TeamReport,
} from "./6-harness.js";
import { REPO_ROOT, type UserChannel } from "./team-tools.js";

export const TASK = DEFAULT_TASK;
const RUNS_DIR = path.join(REPO_ROOT, "runs");

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (name: string) => argv.includes(`--${name}`);

function createCliUserChannel(): UserChannel {
  return {
    ask: async (q) => {
      const rl = readline.createInterface({ input, output });
      try {
        console.log(C.blue("\n┌── USER DECISION REQUIRED ─────────────────────────────────────────"));
        console.log(C.bold(`│ ${q.question}`));
        q.options.forEach((o, i) => console.log(`│   [${i + 1}] ${o}`));
        console.log(C.gray(`│   [Enter] Use default launch rule: ${DEFAULT_USER_RULES}`));
        console.log(C.blue("└───────────────────────────────────────────────────────────────────"));
        const ans = (await rl.question("Your choice (number, text, or Enter): ")).trim();
        if (!ans) return DEFAULT_USER_RULES;
        const idx = Number(ans) - 1;
        if (Number.isInteger(idx) && idx >= 0 && idx < q.options.length) {
          return q.options[idx]!;
        }
        return ans;
      } finally {
        rl.close();
      }
    },
  };
}

// ── Saved runs ────────────────────────────────
type SavedRun = { dir: string; report: TeamReport };

function savedRuns(): SavedRun[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .flatMap((name) => {
      const dir = path.join(RUNS_DIR, name);
      const reportPath = path.join(dir, "report.json");
      if (!fs.existsSync(reportPath) || !fs.existsSync(path.join(dir, "console.log"))) return [];
      try {
        return [{ dir, report: JSON.parse(fs.readFileSync(reportPath, "utf8")) as TeamReport }];
      } catch {
        return [];
      }
    });
}

function modelsOf(rep: TeamReport): RoleModels {
  // Runs saved before per-role models existed used one model for every role and a scripted user.
  const m = rep.model ?? "?";
  return rep.models ?? { lead: m, engineer: m, qa: m, user: "(scripted reply)" };
}

function listRuns() {
  const runs = savedRuns();
  if (runs.length === 0) {
    console.log("No saved runs yet. Run: npm run team");
    return;
  }
  console.table(
    runs.map(({ dir, report: r }) => ({
      run: path.basename(dir),
      mode: r.mode,
      lead: modelsOf(r).lead,
      "lead touched repo": (r.leadExecAttempts ?? 0) - (r.leadExecBlocked ?? 0),
      brakes: r.brakes?.length ?? 0,
      "hidden tests": r.finalTests ? `${r.finalTests.pass}/${r.finalTests.total}` : "-",
      seconds: r.seconds ?? "-",
    })),
  );
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function replayOne(dir: string) {
  const reportPath = path.join(dir, "report.json");
  const report = fs.existsSync(reportPath) ? (JSON.parse(fs.readFileSync(reportPath, "utf8")) as TeamReport) : null;
  if (report) banner(report.mode, modelsOf(report), "replay of " + path.basename(dir));
  const text = fs.readFileSync(path.join(dir, "console.log"), "utf8");
  for (const line of text.split("\n")) {
    console.log(line);
    await sleep(line.includes("BRAKE") ? 900 : line.includes("❓") ? 600 : 160);
  }
  return report;
}

async function replay(target: string) {
  if (target === "latest") {
    // Latest bare run that is immediately followed by a harness run (one `--mode both` run).
    const runs = savedRuns();
    let lastBare: SavedRun | undefined;
    let lastHarness: SavedRun | undefined;
    for (let i = runs.length - 1; i > 0; i--) {
      if (runs[i].report.mode === "harness" && runs[i - 1].report.mode === "bare") {
        lastHarness = runs[i];
        lastBare = runs[i - 1];
        break;
      }
    }
    if (!lastHarness || !lastBare) {
      console.log("Need at least one saved before+after pair. Run: npm run team");
      return;
    }
    console.log(C.bold("\n📋 Task for the Tech Lead:\n") + C.gray(lastHarness.report.task ?? TASK));
    const a = await replayOne(lastBare.dir);
    const b = await replayOne(lastHarness.dir);
    if (a && b) compare([a, b]);
    return;
  }
  const dir = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  if (!fs.existsSync(path.join(dir, "console.log"))) {
    console.log(`No console.log in ${dir}. See saved runs with: npm run team:runs`);
    return;
  }
  await replayOne(dir);
}

// ── Output ────────────────────────────────────
function banner(mode: Mode, models: RoleModels, note = BASE_URL) {
  const title =
    mode === "bare"
      ? C.red(C.bold(" BEFORE · bare Tech Lead (no harness) "))
      : C.green(C.bold(" AFTER · No Micromanaging harness (AI Decelerator) "));
  console.log(`\n${"═".repeat(72)}\n${title}`);
  console.log(C.gray(`  👔 lead      ${models.lead}   (expensive: plans, delegates, reports)`));
  console.log(C.gray(`  🔧 engineer  ${models.engineer}   (cheap: writes code)`));
  console.log(C.gray(`  🧪 qa        ${models.qa}   (cheap: runs tests)`));
  console.log(C.gray(`  🧑 user      ${models.user}   (product owner)`));
  console.log(C.gray(`  ${note}`));
  console.log(`${"═".repeat(72)}\n`);
}

function compare(runs: TeamReport[]) {
  console.log(C.bold("\n── Before vs After ──"));
  console.table(
    Object.fromEntries(
      runs.map((r) => [
        r.mode === "bare" ? "before (bare)" : "after (harness)",
        {
          "Lead touched repo": (r.leadExecAttempts ?? 0) - (r.leadExecBlocked ?? 0),
          "Brakes fired": r.brakes?.length ?? 0,
          "User aligned": r.userClarified ? "✓" : "✗",
          "Delegations": (r.delegationsEngineer ?? 0) + (r.delegationsQa ?? 0),
          "Independent QA": r.qaVerified ? "✓" : "✗",
          "Hidden tests": r.finalTests ? `${r.finalTests.pass}/${r.finalTests.total}` : "-",
          "Lead tokens": r.leadTokens ?? 0,
          "Team tokens": r.teamTokens ?? 0,
        },
      ]),
    ),
  );
}

// ── Main ──────────────────────────────────────
const replayTarget = flag("replay");
if (hasFlag("runs")) {
  listRuns();
} else if (hasFlag("replay")) {
  await replay(replayTarget ?? "latest");
} else {
  const modeArg = flag("mode") ?? "both";
  const modes: Mode[] = modeArg === "both" ? ["bare", "harness"] : [modeArg as Mode];

  const interactive = hasFlag("interactive");
  const scripted = hasFlag("scripted-user");
  const userChannel = interactive
    ? createCliUserChannel()
    : scripted
      ? createAutoUserChannel()
      : createModelUserChannel(DEFAULT_MODELS.user);
  const models: RoleModels = {
    ...DEFAULT_MODELS,
    user: interactive ? "(you, in the terminal)" : scripted ? "(scripted reply)" : DEFAULT_MODELS.user,
  };

  console.log(C.bold("\n📋 Task for the Tech Lead:\n") + C.gray(TASK));
  const runs: TeamReport[] = [];
  for (const mode of modes) {
    banner(mode, models);
    runs.push(
      await runTeam({
        mode,
        task: TASK,
        leadModel: models.lead,
        workerModel: models.engineer,
        engineerModel: models.engineer,
        qaModel: models.qa,
        userModel: models.user,
        userChannel,
      }),
    );
  }
  if (runs.length > 1) compare(runs);
}
