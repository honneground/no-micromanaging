// ─────────────────────────────────────────────
// The AI Decelerator: guardrails that enforce "No Micromanaging".
//
// Two boundaries the Lead cannot cross:
//   1. Upward (User Layer): clarify ambiguous business rules via ask_user;
//      never dump raw code or debugging onto the user.
//   2. Downward (Team Layer): never inspect/edit code or run tests directly,
//      never spoon-feed code in briefs, and never take over when QA fails.
//
// Same model, same prompt — only the harness changes.
// ─────────────────────────────────────────────

import type { FinishDecision, ToolDecision } from "./5-loop.js";

export type BrakeKind =
  | "ASK USER FIRST"
  | "USER BOUNDARY"
  | "ANTI-DIY"
  | "NO TAKEOVER"
  | "VAGUE BRIEF"
  | "NO MICROCODE"
  | "DONE GATE";

export type TeamState = {
  requireUserClarification: boolean;
  userClarified: boolean;
  userQuestions: number;
  lastQa: "none" | "pass" | "fail";
  codeChangedSinceQa: boolean;
  brakes: { kind: BrakeKind; message: string }[];
};

export function createTeamState(opts?: { requireUserClarification?: boolean }): TeamState {
  return {
    requireUserClarification: opts?.requireUserClarification ?? true,
    userClarified: false,
    userQuestions: 0,
    lastQa: "none",
    codeChangedSinceQa: false,
    brakes: [],
  };
}

// Hands-on repo & test tools belong to @engineer and @qa, not the Lead.
export const EXECUTION_TOOLS = new Set(["write_file", "run_tests"]);
export const LEAD_FORBIDDEN_TOOLS = new Set(["write_file", "run_tests", "read_file", "list_files"]);

function brake(state: TeamState, kind: BrakeKind, message: string): string {
  const full = `🛑 DECELERATOR BRAKE [${kind}]: ${message}`;
  state.brakes.push({ kind, message: full });
  return full;
}

function looksLikeCodeDump(text: string): boolean {
  if (/```/.test(text)) return true;
  const codePatterns = [
    /\bexport\s+(?:function|const|type|interface)\b/,
    /\b(?:const|let|var)\s+[a-zA-Z_$][\w$]*\s*=/,
    /=>\s*\{/,
    /\bif\s*\([^)]+\)\s*\{/,
  ];
  let hits = 0;
  for (const re of codePatterns) {
    if (re.test(text)) hits++;
  }
  return hits >= 2 || /\bexport\s+function\b/.test(text);
}

// Guardrail 1 + 3: Anti-DIY, and No-Takeover after a QA failure.
export function blockDirectExecution(name: string, state: TeamState): ToolDecision {
  if (!LEAD_FORBIDDEN_TOOLS.has(name)) return { allow: true };

  if (state.lastQa === "fail") {
    return {
      allow: false,
      message: brake(
        state,
        "NO TAKEOVER",
        `@engineer's change failed QA. Do not take over by calling "${name}" yourself. ` +
          `Coach @engineer via delegate_task with the exact QA failure, then have @qa re-run tests.`,
      ),
    };
  }

  const owner = name === "run_tests" ? "@qa" : "@engineer";
  const verb = name === "read_file" || name === "list_files" ? "inspect code directly via" : "call";
  return {
    allow: false,
    message: brake(
      state,
      "ANTI-DIY",
      `Tech Lead cannot ${verb} "${name}". Stay above the code: clarify intent with the user (ask_user) ` +
        `and delegate hands-on work to ${owner} via delegate_task.`,
    ),
  };
}

// Guardrail 0: User Communication Layer — clarify business ambiguities before delegating.
export function validateUserQuestion(args: Record<string, unknown>, state: TeamState): ToolDecision {
  const question = typeof args.question === "string" ? args.question.trim() : "";
  const context = typeof args.context === "string" ? args.context.trim() : "";
  const options = Array.isArray(args.options)
    ? args.options.filter((o) => typeof o === "string" && o.trim())
    : [];

  if (question.length < 10) {
    return {
      allow: false,
      message: brake(state, "USER BOUNDARY", `Ask a clear product question (at least 10 characters).`),
    };
  }
  if (options.length < 2) {
    return {
      allow: false,
      message: brake(
        state,
        "USER BOUNDARY",
        `Provide 2-4 crisp decision options in ask_user so the user can align quickly without reading code.`,
      ),
    };
  }
  if (looksLikeCodeDump(`${question}\n${context}\n${options.join("\n")}`)) {
    return {
      allow: false,
      message: brake(
        state,
        "USER BOUNDARY",
        `Do not send raw code to the user. Ask about business rules and desired behavior only.`,
      ),
    };
  }
  return { allow: true };
}

// Guardrail 2: Delegation Contract Gate + Anti-Microcode.
export function validateDelegationBrief(args: Record<string, unknown>, state: TeamState): ToolDecision {
  const owner = args.owner;
  const task = typeof args.task === "string" ? args.task.trim() : "";
  const criteria = Array.isArray(args.acceptance_criteria)
    ? args.acceptance_criteria.filter((c) => typeof c === "string" && c.trim())
    : [];

  if (owner !== "engineer" && owner !== "qa") {
    return { allow: false, message: brake(state, "VAGUE BRIEF", `owner must be "engineer" or "qa".`) };
  }

  if (owner === "engineer" && state.requireUserClarification && !state.userClarified) {
    return {
      allow: false,
      message: brake(
        state,
        "ASK USER FIRST",
        `Business rules in the user's request are ambiguous (discount stacking, thresholds, edge cases). ` +
          `Do not guess — call ask_user first to confirm product rules before delegating to @engineer.`,
      ),
    };
  }

  if (task.length < 20) {
    return {
      allow: false,
      message: brake(state, "VAGUE BRIEF", `"${task}" is too vague. Describe the target scope and desired outcome.`),
    };
  }

  if (looksLikeCodeDump(`${task}\n${criteria.join("\n")}`)) {
    return {
      allow: false,
      message: brake(
        state,
        "NO MICROCODE",
        `Stop spoon-feeding implementation code in delegate_task! Specify requirements and acceptance_criteria; let @engineer write the code.`,
      ),
    };
  }

  if (owner === "engineer" && criteria.length === 0) {
    return {
      allow: false,
      message: brake(
        state,
        "VAGUE BRIEF",
        `@engineer needs acceptance_criteria: list the verified business rules the implementation must satisfy.`,
      ),
    };
  }
  return { allow: true };
}

// Everything the Lead tries goes through here first.
export function leadToolGuard(state: TeamState) {
  return (name: string, args: Record<string, unknown>): ToolDecision => {
    const exec = blockDirectExecution(name, state);
    if (!exec.allow) return exec;
    if (name === "ask_user") return validateUserQuestion(args, state);
    if (name === "delegate_task") return validateDelegationBrief(args, state);
    return { allow: true };
  };
}

// Guardrail 4: Lead may only report "done" after user alignment + independent QA pass + no code dump.
export function verifyLeadFinish(state: TeamState): (answer: string) => FinishDecision {
  return (answer: string) => {
    if (state.requireUserClarification && !state.userClarified) {
      return {
        accept: false,
        message: brake(
          state,
          "ASK USER FIRST",
          `You haven't clarified the ambiguous product rules with the user yet. Call ask_user first.`,
        ),
      };
    }

    if (state.lastQa !== "pass" || state.codeChangedSinceQa) {
      const why =
        state.lastQa === "none"
          ? "Nobody has verified this change yet."
          : state.lastQa === "fail"
            ? "@qa's last run FAILED."
            : "Code changed after @qa's last passing run.";
      return {
        accept: false,
        message: brake(
          state,
          "DONE GATE",
          `${why} You can only report done after @qa runs the tests on the latest code and they pass.`,
        ),
      };
    }

    if (looksLikeCodeDump(answer)) {
      return {
        accept: false,
        message: brake(
          state,
          "USER BOUNDARY",
          `Do not paste raw code in your final user update. Summarize business rules applied and QA verification status.`,
        ),
      };
    }

    return { accept: true };
  };
}
