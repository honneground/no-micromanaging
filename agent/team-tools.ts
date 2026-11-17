// Role-scoped tools for the "No Micromanaging" team.
// Every tool is bound to one run's workspace (and user channel), never reaching into globals.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Tool, ToolRegistry } from "./1-tools.js";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type Workspace = {
  runDir: string;
  srcDir: string; // the code: engineers read/write here
  qaDir: string;  // the acceptance tests: only the test runner touches this
};

export type TestRun = {
  passed: boolean;
  total: number;
  pass: number;
  fail: number;
  output: string;
};

export type UserQuestion = {
  kind: "clarify" | "escalate";
  question: string;
  options: string[];
  context?: string;
};

export type UserChannel = {
  ask: (q: UserQuestion) => Promise<string>;
};

export function registry(tools: Tool[]): ToolRegistry {
  return {
    definitions: tools.map((t) => t.definition),
    byName: new Map(tools.map((t) => [t.definition.function.name, t])),
  };
}

// Fresh copy of the sandbox for every run, so "before" and "after" start identical.
export function createWorkspace(label: string): Workspace {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const runDir = path.join(REPO_ROOT, "runs", `${stamp}-${label}`);
  fs.cpSync(path.join(REPO_ROOT, "sandbox-template"), runDir, { recursive: true });
  return { runDir, srcDir: path.join(runDir, "workspace"), qaDir: path.join(runDir, "qa") };
}

// Path guard: tools can never leave the code folder (so nobody can peek at QA's tests).
function resolveInSrc(ws: Workspace, p: unknown): string {
  const full = path.resolve(ws.srcDir, String(p ?? ""));
  if (full !== ws.srcDir && !full.startsWith(ws.srcDir + path.sep)) {
    throw new Error(`Path "${p}" is outside the repo you can access.`);
  }
  return full;
}

export function runTests(ws: Workspace): TestRun {
  const testFiles = fs
    .readdirSync(ws.qaDir)
    .filter((f) => f.endsWith(".test.ts"))
    .map((f) => path.join(ws.qaDir, f));

  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=spec", ...testFiles],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    },
  );

  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\x1b\[[0-9;]*m/g, "");
  const num = (key: string) => Number(raw.match(new RegExp(`\\b${key} (\\d+)`))?.[1] ?? 0);
  const total = num("tests");
  const pass = num("pass");
  const fail = num("fail");
  const passed = r.status === 0 && total > 0 && fail === 0;

  // Keep what the model sees short: summary + test checklist (plus failure details if any).
  const checkLines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[✔✖]/.test(l))
    .slice(0, 20)
    .join("\n");

  let output = `${pass}/${total} tests passing.`;
  if (checkLines) output += `\n${checkLines}`;
  if (!passed) {
    const failIdx = raw.indexOf("failing tests");
    const details = (failIdx >= 0 ? raw.slice(failIdx) : raw)
      .split("\n")
      .filter((l) => !/^\s*at /.test(l) && !/^test at /.test(l) && l.trim())
      .join("\n");
    output += `\n\n${details.slice(0, 2000)}`;
  }
  return { passed, total, pass, fail, output };
}

// ── Individual tools ──────────────────────────

export function listFilesTool(ws: Workspace): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name: "list_files",
        description: "List the files in the repo.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => fs.readdirSync(ws.srcDir, { recursive: true }).map(String).join("\n"),
  };
}

export function readFileTool(ws: Workspace, onRead?: (file: string) => void): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file in the repo.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: 'Path relative to the repo root, e.g. "pricing.ts"' } },
          required: ["path"],
        },
      },
    },
    execute: async ({ path: p }) => {
      onRead?.(String(p));
      return fs.readFileSync(resolveInSrc(ws, p), "utf8");
    },
  };
}

export function writeFileTool(ws: Workspace, onWrite: (file: string) => void): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a file in the repo, replacing its entire contents.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: 'Path relative to the repo root, e.g. "pricing.ts"' },
            content: { type: "string", description: "The complete new file contents." },
          },
          required: ["path", "content"],
        },
      },
    },
    execute: async ({ path: p, content }) => {
      const full = resolveInSrc(ws, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, String(content ?? ""), "utf8");
      onWrite(String(p));
      return `Wrote ${p} (${String(content ?? "").split("\n").length} lines).`;
    },
  };
}

export function runTestsTool(ws: Workspace, onResult: (run: TestRun) => void): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name: "run_tests",
        description: "Run the project's acceptance test suite and get pass/fail results.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    execute: async () => {
      const run = runTests(ws);
      onResult(run);
      return run.output;
    },
  };
}

export function askUserTool(channel: UserChannel, onAnswered?: (q: UserQuestion, a: string) => void): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name: "ask_user",
        description:
          "Ask the user to clarify unclear business rules or escalate a product trade-off. Keep questions non-technical and decision-oriented; provide 2-4 concrete options.",
        parameters: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: ["clarify", "escalate"],
              description: '"clarify" before delegating unclear requirements; "escalate" for mid-task product trade-offs.',
            },
            question: { type: "string", description: "Concise product/business question for the user." },
            options: {
              type: "array",
              items: { type: "string" },
              description: "2-4 clear decision options the user can choose from.",
            },
            context: { type: "string", description: "Optional 1-line explanation of why this choice matters." },
          },
          required: ["question", "options"],
        },
      },
    },
    execute: async (args) => {
      const q: UserQuestion = {
        kind: args.kind === "escalate" ? "escalate" : "clarify",
        question: String(args.question ?? "").trim(),
        options: Array.isArray(args.options) ? args.options.map(String).filter(Boolean) : [],
        context: typeof args.context === "string" ? args.context.trim() : undefined,
      };
      const answer = await channel.ask(q);
      onAnswered?.(q, answer);
      return `User decision: ${answer}`;
    },
  };
}

export type DelegateArgs = {
  owner: "engineer" | "qa";
  task: string;
  acceptance_criteria?: string[];
};

export function delegateTool(run: (args: DelegateArgs) => Promise<string>): Tool {
  return {
    definition: {
      type: "function",
      function: {
        name: "delegate_task",
        description:
          "Hand a task to a team member and get their report back. @engineer implements code changes. @qa runs the acceptance tests.",
        parameters: {
          type: "object",
          properties: {
            owner: { type: "string", enum: ["engineer", "qa"] },
            task: {
              type: "string",
              description: "What outcome is needed and which file/scope it applies to (describe requirements, NOT implementation code).",
            },
            acceptance_criteria: {
              type: "array",
              items: { type: "string" },
              description: "Testable business/behavior conditions that define done.",
            },
          },
          required: ["owner", "task"],
        },
      },
    },
    execute: async (args) => run(args as unknown as DelegateArgs),
  };
}
