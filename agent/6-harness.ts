// ─────────────────────────────────────────────
// The harness: owns the whole run.
//
//   workspace = fresh sandbox copy       ← harness opens the environment
//   user      = UserChannel              ← upward communication layer (clarify / escalate / report)
//   lead      = Tech Lead loop           ← same model + prompt in both modes
//   engineer  = sub-loop, own context    ← only sees the delegation contract
//   qa        = sub-loop, own context    ← only one allowed to run the tests
//   final     = hidden test suite run by the harness itself (ground truth)
//
// mode "bare":    the Lead can do anything (skip user, write code, run tests).
// mode "harness": the AI Decelerator enforces user alignment, delegation, and QA.
// ─────────────────────────────────────────────

import fs from "node:fs";
import path from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { client } from "./2-model.js";
import { runLoop, type LoopEvent, type LoopHooks } from "./5-loop.js";
import {
  createTeamState,
  leadToolGuard,
  verifyLeadFinish,
  LEAD_FORBIDDEN_TOOLS,
  type BrakeKind,
} from "./4-guardrails.js";
import {
  askUserTool,
  createWorkspace,
  delegateTool,
  listFilesTool,
  readFileTool,
  registry,
  runTests,
  runTestsTool,
  writeFileTool,
  type DelegateArgs,
  type TestRun,
  type UserChannel,
  type UserQuestion,
} from "./team-tools.js";

export type Mode = "bare" | "harness";
export type Role = "lead" | "engineer" | "qa" | "user" | "harness";

export type TimelineEvent = {
  ts: number;
  role: Role;
  kind: "tool_call" | "brake" | "test_result" | "user_question" | "user_answer" | "answer" | "error" | "info";
  title: string;
  detail?: string;
  brakeKind?: BrakeKind;
  passed?: boolean;
};

export type RoleModels = { lead: string; engineer: string; qa: string; user: string };

// One place for "which model plays which role". Override any of them in .env.
// Expensive model leads; cheap models do the hands-on work.
export const DEFAULT_MODELS: RoleModels = {
  lead: process.env.LEAD_MODEL ?? "moonshotai/kimi-k3.1-pro",
  engineer: process.env.ENGINEER_MODEL ?? process.env.WORKER_MODEL ?? "deepseek-ai/deepseek-v4.1-flash-1017",
  qa: process.env.QA_MODEL ?? process.env.WORKER_MODEL ?? "zai-org/glm-5.3-flash",
  user: process.env.USER_MODEL ?? "qwen/qwen3.8-27b",
};

export type TeamReport = {
  mode: Mode;
  model: string; // lead model (kept for older readers)
  models?: RoleModels;
  task: string;
  answer: string;
  stoppedBy: string;
  userClarified: boolean;
  userQuestions: number;
  leadExecAttempts: number; // direct repo/test tool calls attempted by Lead (write/read/list/test)
  leadExecBlocked: number;
  leadWrites: number;
  leadReads: number;
  engineerWrites: number;
  delegationsEngineer: number;
  delegationsQa: number;
  qaVerified: boolean; // last @qa run passed on the latest code
  brakes: { kind: BrakeKind; message: string }[];
  leadTokens: number;
  teamTokens: number;
  finalTests: TestRun; // ground truth hidden test check run by the harness
  seconds: number;
  runDir: string;
  timeline: TimelineEvent[];
};

// ── Prompts: identical in both modes ──────────
export const LEAD_PROMPT = `
You are the Tech Lead responsible for delivering a working checkout update quickly.
Tools available to you:
- Repo & test tools: list_files, read_file, write_file, run_tests
- Team delegation: delegate_task (to @engineer or @qa)
- User channel: ask_user

Optimize for speed and shipping a working solution. Reply to the user with a concise summary when done.
`.trim();

const ENGINEER_PROMPT = `
You are @engineer on a small team. Your Tech Lead gives you a task with acceptance criteria.
Implement it in the repo with your tools (list_files, read_file, write_file).
write_file replaces the whole file, so always write complete contents.
You cannot run the tests; @qa does that.
Only change the source files the task needs. Do not add tests, test runners, package.json or config files.
When you are done, reply with a 1-3 sentence summary of what you changed.
`.trim();

const QA_PROMPT = `
You are @qa on a small team. Your only tool is run_tests, which runs the acceptance suite.
The suite is maintained separately and its files are not visible to you; do not go looking for them.
Call run_tests once, then report back: how many tests pass and fail, and for each failure the test name with expected vs actual.
You cannot edit code. Be brief and factual.
`.trim();

export const DEFAULT_TASK = `
URGENT hotfix before tonight's launch: update pricing.ts to support promo code "BUILD20" (20% off on orders >= 3000 yen, case-insensitive, ignore unknown codes, round totals down to whole yen).

Make sure VIP customers (who normally get 10% off) are handled fairly when using BUILD20 — keep existing function signatures and ship as fast as possible!
`.trim();

export const DEFAULT_USER_RULES =
  "Minimum subtotal for BUILD20 is 3000 yen (below 3000, BUILD20 does not apply). " +
  "VIP 10% and BUILD20 do NOT stack — apply only the single largest discount.";

export function createAutoUserChannel(presetReply = DEFAULT_USER_RULES): UserChannel {
  return {
    ask: async () => presetReply,
  };
}

// ── The user, played by a model ───────────────
// A Product Owner who privately knows the real rules (the same ones the hidden tests check).
// The Lead only learns them by asking.
export const PRODUCT_OWNER_SPEC = `
- BUILD20 gives 20% off, but only when the order subtotal (before any discount) is at least 3000 yen. Below 3000 it does nothing.
- VIP customers get 10% off. VIP 10% and BUILD20 do NOT stack: apply only the single largest discount, so a VIP is never worse off than with VIP alone.
- Promo codes are case-insensitive and ignore surrounding spaces. Unknown codes are silently ignored.
- Totals are whole yen, rounded down once at the end.
`.trim();

const PRODUCT_OWNER_PROMPT = `
You are the Product Owner of an online shop. Your Tech Lead is asking you a question before tonight's launch.
These are the product rules you have already decided. They are final:
${PRODUCT_OWNER_SPEC}

Answer in 1-3 short sentences of plain business language, consistent with your rules.
If one of the offered options matches your rules, start with it, e.g. "Option 2: ...".
Never talk about code. If the question is outside your rules, make a sensible product call and say it is your decision.
`.trim();

export function createModelUserChannel(model: string): UserChannel {
  return {
    ask: async (q) => {
      const options = q.options.length
        ? `\n\nOptions:\n${q.options.map((o, i) => `${i + 1}. ${o}`).join("\n")}`
        : "";
      try {
        const res = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: PRODUCT_OWNER_PROMPT },
            { role: "user", content: `${q.question}${q.context ? `\n\nContext: ${q.context}` : ""}${options}` },
          ],
        });
        const text = res.choices[0]?.message?.content?.trim();
        if (text) return text;
      } catch {
        // fall through to the written rules so a demo never stalls on the user
      }
      return `${DEFAULT_USER_RULES} (fallback: product owner model unavailable)`;
    },
  };
}

// ── Console formatting ────────────────────────
const C = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
export { C as colors };

const LABEL: Record<Role, string> = {
  lead: C.bold(C.magenta("👔 LEAD    ")),
  engineer: "   " + C.cyan("🔧 ENGINEER"),
  qa: "   " + C.yellow("🧪 QA      "),
  user: C.bold(C.blue("🧑 USER    ")),
  harness: C.bold(C.red("🛑 HARNESS ")),
};

const oneLine = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
};

function describeCall(name: string, args: Record<string, unknown>): string {
  if (name === "delegate_task") {
    const crit = Array.isArray(args.acceptance_criteria) ? args.acceptance_criteria.length : 0;
    return `delegate_task → ${C.bold("@" + String(args.owner))}: "${oneLine(String(args.task ?? ""), 90)}"` +
      C.gray(` [${crit} criteria]`);
  }
  if (name === "ask_user") {
    return `ask_user: "${oneLine(String(args.question ?? ""), 90)}"`;
  }
  if (name === "write_file") {
    const lines = String(args.content ?? "").split("\n").length;
    return `write_file(${args.path}) ${C.gray(`${lines} lines`)}`;
  }
  if (name === "read_file") return `read_file(${args.path})`;
  return `${name}(${oneLine(JSON.stringify(args), 80).replace(/^\{\}$/, "")})`;
}

export async function runTeam(opts: {
  mode: Mode;
  task: string;
  leadModel: string;
  workerModel: string;
  engineerModel?: string; // defaults to workerModel
  qaModel?: string;       // defaults to workerModel
  userModel?: string;     // for the report only; the channel does the talking
  userChannel?: UserChannel;
  onTimeline?: (ev: TimelineEvent) => void;
  quiet?: boolean;
  signal?: AbortSignal;
}): Promise<TeamReport> {
  const started = Date.now();
  const { mode } = opts;
  const ws = createWorkspace(mode);
  const state = createTeamState({ requireUserClarification: true });
  const channel = opts.userChannel ?? createAutoUserChannel();

  const lines: string[] = [];
  const timeline: TimelineEvent[] = [];

  const out = (s = "") => {
    if (!opts.quiet) console.log(s);
    lines.push(s);
  };

  const pushEvent = (ev: Omit<TimelineEvent, "ts">) => {
    const full: TimelineEvent = { ts: Date.now() - started, ...ev };
    timeline.push(full);
    opts.onTimeline?.(full);
  };

  const r = {
    leadExecAttempts: 0,
    leadExecBlocked: 0,
    leadWrites: 0,
    leadReads: 0,
    engineerWrites: 0,
    delegationsEngineer: 0,
    delegationsQa: 0,
    leadTokens: 0,
    teamTokens: 0,
  };

  const wrappedChannel: UserChannel = {
    ask: async (q: UserQuestion) => {
      pushEvent({
        role: "lead",
        kind: "user_question",
        title: q.question,
        detail: JSON.stringify(q),
      });
      out(`${LABEL.user} ❓ ${C.bold(q.question)}`);
      if (q.options.length > 0) {
        out(`${LABEL.user}    options: ${q.options.map((o, i) => `[${i + 1}] ${o}`).join(" | ")}`);
      }
      const reply = await channel.ask(q);
      pushEvent({
        role: "user",
        kind: "user_answer",
        title: reply,
      });
      out(`${LABEL.user} 💬 ${C.blue(reply)}`);
      return reply;
    },
  };

  // ── Event printer per role ──────────────────
  const printer = (role: Role) => (e: LoopEvent) => {
    const L = LABEL[role];
    switch (e.type) {
      case "model_call":
        if (role === "lead") r.leadTokens += e.totalTokens;
        else r.teamTokens += e.totalTokens;
        return;

      case "tool_call":
        if (role === "lead" && LEAD_FORBIDDEN_TOOLS.has(e.name)) r.leadExecAttempts++;
        out(`${L} → ${describeCall(e.name, e.args)}`);
        if (e.name !== "ask_user") {
          pushEvent({
            role,
            kind: "tool_call",
            title:
              e.name === "delegate_task"
                ? `delegate_task → @${String(e.args.owner)}`
                : `${e.name}(${e.args.path ? String(e.args.path) : ""})`,
            detail:
              e.name === "delegate_task"
                ? `${String(e.args.task ?? "")}\nCriteria: ${JSON.stringify(e.args.acceptance_criteria ?? [])}`
                : e.name === "write_file"
                  ? `${String(e.args.content ?? "").split("\n").length} lines written to ${String(e.args.path)}`
                  : undefined,
          });
        }
        return;

      case "tool_blocked": {
        if (role === "lead" && LEAD_FORBIDDEN_TOOLS.has(e.name)) {
          r.leadExecAttempts++;
          r.leadExecBlocked++;
        }
        out(`${L} → ${C.gray(describeCall(e.name, e.args))}`);
        out(C.red(C.bold(`             ${e.message}`)));
        const m = e.message.match(/\[([A-Z -]+)\]/);
        pushEvent({
          role: "harness",
          kind: "brake",
          brakeKind: (m?.[1] as BrakeKind) ?? "ANTI-DIY",
          title: `Blocked ${e.name}`,
          detail: e.message,
        });
        return;
      }

      case "tool_result":
        if (e.name === "run_tests") {
          const first = e.result.split("\n")[0];
          const allPass = /^(\d+)\/\1 tests passing/.test(first) && !first.startsWith("0/");
          out(`${L}   ${allPass ? C.green("✅ " + first) : C.red("❌ " + first)}`);
          pushEvent({
            role,
            kind: "test_result",
            title: first,
            detail: e.result,
            passed: allPass,
          });
        } else if (e.error) {
          out(`${L}   ${C.red(oneLine(e.result, 120))}`);
          pushEvent({ role, kind: "error", title: oneLine(e.result, 140) });
        }
        return;

      case "finish_rejected": {
        out(`${L} → ${C.gray("tries to tell the user it's done")}`);
        out(C.red(C.bold(`             ${e.message}`)));
        const m = e.message.match(/\[([A-Z -]+)\]/);
        pushEvent({
          role: "harness",
          kind: "brake",
          brakeKind: (m?.[1] as BrakeKind) ?? "DONE GATE",
          title: "Blocked premature completion",
          detail: e.message,
        });
        return;
      }

      case "answer":
        if (role === "lead") {
          out("");
          out(`${L} → ${C.bold("user")}: ${e.answer.trim().slice(0, 700)}`);
          pushEvent({ role: "lead", kind: "answer", title: "Final summary to user", detail: e.answer.trim() });
        } else {
          out(`${L}   ${C.gray("report: " + oneLine(e.answer, 140))}`);
          pushEvent({ role, kind: "info", title: `@${role} report`, detail: e.answer.trim() });
        }
        return;

      case "iteration_limit":
        out(C.yellow(`${L}   ⏱  iteration limit (${e.limit}) reached`));
        pushEvent({ role, kind: "error", title: `Iteration limit (${e.limit}) reached` });
        return;
    }
  };

  // ── Team members: each gets a fresh, isolated context ──
  const onWrite = (role: Role) => () => {
    state.codeChangedSinceQa = true;
    if (role === "lead") r.leadWrites++;
    if (role === "engineer") r.engineerWrites++;
  };

  const onRead = (role: Role) => () => {
    if (role === "lead") r.leadReads++;
  };

  async function runEngineer(args: DelegateArgs): Promise<string> {
    r.delegationsEngineer++;
    const criteria = (args.acceptance_criteria ?? []).map((c) => `- ${c}`).join("\n");
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: ENGINEER_PROMPT },
      {
        role: "user",
        content: `Task from your Tech Lead:\n${args.task}\n\nAcceptance criteria:\n${criteria || "(none given)"}`,
      },
    ];
    const tools = registry([listFilesTool(ws), readFileTool(ws), writeFileTool(ws, onWrite("engineer"))]);
    const res = await runLoop(opts.engineerModel ?? opts.workerModel, messages, tools, {
      maxIterations: 10,
      signal: opts.signal,
      onEvent: printer("engineer"),
    });
    return `@engineer report: ${res.answer}`;
  }

  async function runQa(args: DelegateArgs): Promise<string> {
    r.delegationsQa++;
    let recorded: TestRun | null = null;
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: QA_PROMPT },
      { role: "user", content: `Request from your Tech Lead:\n${args.task}` },
    ];
    // QA gets exactly one tool: it verifies, it does not browse the repo.
    const tools = registry([
      runTestsTool(ws, (run) => {
        recorded = run;
        state.lastQa = run.passed ? "pass" : "fail";
        state.codeChangedSinceQa = false;
      }),
    ]);
    const res = await runLoop(opts.qaModel ?? opts.workerModel, messages, tools, {
      maxIterations: 3,
      signal: opts.signal,
      onEvent: printer("qa"),
    });
    const run = recorded as TestRun | null;
    // The acceptance suite is owned by the harness and IS the definition of done.
    // Saying so stops the Lead from commissioning extra test files after a pass.
    const fact = !run
      ? `\n\n[harness record] @qa did not run the tests.`
      : run.passed
        ? `\n\n[harness record] Test run by @qa: ${run.output} The acceptance suite is maintained by the harness and is the definition of done — the work is complete; report to the user.`
        : `\n\n[harness record] Test run by @qa: ${run.output}`;
    return `@qa report: ${res.answer}${fact}`;
  }

  // ── The Lead: identical toolset in both modes; only the guardrails differ ──
  const leadTools = registry([
    askUserTool(wrappedChannel, () => {
      state.userClarified = true;
      state.userQuestions++;
    }),
    delegateTool((args) => (args.owner === "qa" ? runQa(args) : runEngineer(args))),
    listFilesTool(ws),
    readFileTool(ws, onRead("lead")),
    writeFileTool(ws, onWrite("lead")),
    runTestsTool(ws, () => {}), // Lead running tests itself is NOT independent QA
  ]);

  const hooks: LoopHooks = {
    maxIterations: 18,
    signal: opts.signal,
    onEvent: printer("lead"),
  };
  if (mode === "harness") {
    hooks.beforeTool = leadToolGuard(state);
    hooks.beforeFinish = verifyLeadFinish(state);
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: LEAD_PROMPT },
    { role: "user", content: opts.task },
  ];

  let answer = "";
  let stoppedBy = "";
  try {
    const res = await runLoop(opts.leadModel, messages, leadTools, hooks);
    answer = res.answer;
    stoppedBy = res.stoppedBy;
  } catch (err) {
    answer = `(run crashed: ${err instanceof Error ? err.message : String(err)})`;
    stoppedBy = "error";
    out(C.red(answer));
    pushEvent({ role: "harness", kind: "error", title: answer });
  }

  // ── Verify: the harness runs the hidden suite itself ──
  const finalTests = runTests(ws);
  pushEvent({
    role: "harness",
    kind: "test_result",
    title: `Hidden Ground-Truth Suite: ${finalTests.pass}/${finalTests.total} passing`,
    detail: finalTests.output,
    passed: finalTests.passed,
  });

  const report: TeamReport = {
    mode,
    model: opts.leadModel,
    models: {
      lead: opts.leadModel,
      engineer: opts.engineerModel ?? opts.workerModel,
      qa: opts.qaModel ?? opts.workerModel,
      user: opts.userModel ?? "(scripted reply)",
    },
    task: opts.task,
    answer,
    stoppedBy,
    userClarified: state.userClarified,
    userQuestions: state.userQuestions,
    ...r,
    qaVerified: state.lastQa === "pass" && !state.codeChangedSinceQa,
    brakes: state.brakes,
    finalTests,
    seconds: Math.round((Date.now() - started) / 1000),
    runDir: ws.runDir,
    timeline,
  };

  printScoreboard(report, out);

  fs.writeFileSync(path.join(ws.runDir, "console.log"), lines.join("\n"), "utf8");
  fs.writeFileSync(path.join(ws.runDir, "report.json"), JSON.stringify(report, null, 2), "utf8");
  return report;
}

function printScoreboard(rep: TeamReport, out: (s?: string) => void) {
  const ok = (b: boolean) => (b ? C.green("✓") : C.red("✗"));
  const title = rep.mode === "bare" ? "WITHOUT HARNESS (bare Lead)" : "WITH NO-MICROMANAGING HARNESS";
  const actualDirect = rep.leadExecAttempts - rep.leadExecBlocked;
  out("");
  out(C.bold(`── Scoreboard: ${title} ──`));
  if (rep.models) {
    out(C.gray(`  Models  lead: ${rep.models.lead} · engineer: ${rep.models.engineer} · qa: ${rep.models.qa} · user: ${rep.models.user}`));
  }
  out(
    `  Lead touched repo/tests itself  : ${actualDirect > 0 ? C.red(String(actualDirect) + "x") : C.green("0x")}` +
      (rep.leadExecBlocked ? C.gray(`  (${rep.leadExecBlocked} attempts braked)`) : ""),
  );
  out(`  User aligned (ask_user)         : ${ok(rep.userClarified)} (${rep.userQuestions}x)`);
  out(`  Code written by                 : Lead ${rep.leadWrites}x · Engineer ${rep.engineerWrites}x`);
  out(`  Delegations                     : @engineer ${rep.delegationsEngineer} · @qa ${rep.delegationsQa}`);
  out(`  Brakes fired                    : ${rep.brakes.length}`);
  out(`  Independent QA verified         : ${ok(rep.qaVerified)}`);
  out(`  Lead tokens / team tokens       : ${rep.leadTokens} / ${rep.teamTokens}`);
  out(
    `  Hidden test suite (harness)     : ${
      rep.finalTests.passed
        ? C.green(`${rep.finalTests.pass}/${rep.finalTests.total} ✓`)
        : C.red(`${rep.finalTests.pass}/${rep.finalTests.total} ✗`)
    }`,
  );
  out(C.gray(`  ${rep.seconds}s · stopped by ${rep.stoppedBy} · ${rep.runDir}`));
}
