import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { client } from "./2-model.js";
import type { ToolRegistry } from "./1-tools.js";

// A single tool call + its result, captured for the trace
export type ToolEvent = {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  blocked?: boolean;          // true if a guardrail refused to run it
};

// One loop iteration: the model either called tools or gave a final answer
export type LoopIteration = {
  index: number;
  outcome: "tool_calls" | "answer" | "answer_rejected";
  toolEvents: ToolEvent[];    // empty if outcome is an answer
  contextSize: number;        // how many messages were in context for this call
};

export type LoopResult = {
  answer: string;
  iterations: number;
  trace: LoopIteration[];
  stoppedBy: "model" | "guardrail" | "success";
};

// ── Harness hooks ─────────────────────────────
// The loop itself stays dumb. The harness plugs rules in here.
export type ToolDecision = { allow: true } | { allow: false; message: string };
export type FinishDecision = { accept: true } | { accept: false; message: string };

export type LoopEvent =
  | { type: "model_call"; iteration: number; contextSize: number; totalTokens: number }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_blocked"; name: string; args: Record<string, unknown>; message: string }
  | { type: "tool_result"; name: string; result: string; error: boolean }
  | { type: "finish_rejected"; message: string }
  | { type: "answer"; answer: string }
  | { type: "iteration_limit"; limit: number };

export type LoopHooks = {
  maxIterations?: number;
  signal?: AbortSignal;
  // Runs before every tool call. Return allow:false to block it; the message goes back to the model.
  beforeTool?: (name: string, args: Record<string, unknown>) => ToolDecision | Promise<ToolDecision>;
  // Runs before a final answer is accepted. Return accept:false to send the model back to work.
  beforeFinish?: (answer: string) => FinishDecision | Promise<FinishDecision>;
  // If set, the loop reports through this instead of printing.
  onEvent?: (event: LoopEvent) => void;
};

export async function runLoop(
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,           // injected by the harness, not imported globally
  hooks: LoopHooks = {},
): Promise<LoopResult> {
  const trace: LoopIteration[] = [];
  const maxIterations = hooks.maxIterations ?? Infinity;
  const emit = hooks.onEvent;

  while (true) {
    if (hooks.signal?.aborted) {
      throw new Error("Run aborted");
    }
    const iterationIndex = trace.length + 1;

    // ── Guardrail: iteration budget ───────────
    if (iterationIndex > maxIterations) {
      emit?.({ type: "iteration_limit", limit: maxIterations });
      return {
        answer: "(stopped: iteration limit reached)",
        iterations: trace.length,
        trace,
        stoppedBy: "guardrail",
      };
    }

    // ── Model call ────────────────────────────
    if (!emit) process.stdout.write(`[iter ${iterationIndex}] calling model... `);
    const response = await client.chat.completions.create(
      {
        model,
        messages,
        tools: tools.definitions,
      },
      hooks.signal ? { signal: hooks.signal } : undefined,
    );

    const choice = response.choices[0];
    const contextSize = messages.length;
    const toolCalls = choice.message.tool_calls ?? [];
    if (emit) {
      emit({
        type: "model_call",
        iteration: iterationIndex,
        contextSize,
        totalTokens: response.usage?.total_tokens ?? 0,
      });
    } else {
      console.log(`${choice.finish_reason}`);
    }

    messages.push(choice.message as ChatCompletionMessageParam);

    // ── Final answer ──────────────────────────
    // Decide by tool_calls, not finish_reason: some providers report "stop" alongside tool calls.
    if (toolCalls.length === 0) {
      const answer = choice.message.content ?? "(no response)";

      if (hooks.beforeFinish) {
        const decision = await hooks.beforeFinish(answer);
        if (!decision.accept) {
          emit?.({ type: "finish_rejected", message: decision.message });
          messages.push({ role: "user", content: decision.message });
          trace.push({ index: iterationIndex, outcome: "answer_rejected", toolEvents: [], contextSize });
          continue;
        }
      }

      emit?.({ type: "answer", answer });
      trace.push({ index: iterationIndex, outcome: "answer", toolEvents: [], contextSize });
      return { answer, iterations: trace.length, trace, stoppedBy: "model" };
    }

    // ── Tool calls → (guardrail) → execute → loop ──
    const toolEvents: ToolEvent[] = [];

    for (const call of toolCalls) {
      const name = call.function.name;
      let args: Record<string, unknown> = {};
      let result: string;
      let blocked = false;

      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        result = `Error: arguments for "${name}" were not valid JSON. Try again.`;
        emit?.({ type: "tool_result", name, result, error: true });
        toolEvents.push({ tool: name, args, result });
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
        continue;
      }

      const decision: ToolDecision = hooks.beforeTool ? await hooks.beforeTool(name, args) : { allow: true };

      if (!decision.allow) {
        blocked = true;
        result = decision.message;
        emit?.({ type: "tool_blocked", name, args, message: decision.message });
      } else {
        const tool = tools.byName.get(name);
        if (emit) emit({ type: "tool_call", name, args });
        else process.stdout.write(`           → ${name}(${JSON.stringify(args)}) ... `);
        let error = false;
        try {
          result = tool ? await tool.execute(args) : `Unknown tool: "${name}"`;
        } catch (err) {
          error = true;
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (emit) emit({ type: "tool_result", name, result, error });
        else console.log(error ? "error" : "done");
      }

      toolEvents.push({ tool: name, args, result, blocked });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }

    trace.push({ index: iterationIndex, outcome: "tool_calls", toolEvents, contextSize });
  }
}
