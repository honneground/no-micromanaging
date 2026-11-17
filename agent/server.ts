// Web UI server for "No Micromanaging" (AI Decelerator Harness).
// Zero extra dependencies — built on node:http + SSE.
//
//   npm run demo  →  http://localhost:3810

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { client } from "./2-model.js";
import {
  createModelUserChannel,
  DEFAULT_MODELS,
  DEFAULT_TASK,
  DEFAULT_USER_RULES,
  runTeam,
  type Mode,
  type TeamReport,
  type TimelineEvent,
} from "./6-harness.js";
import { REPO_ROOT, type UserChannel, type UserQuestion } from "./team-tools.js";

const PORT = Number(process.env.PORT ?? 3810);
const DEFAULT_MODEL = DEFAULT_MODELS.lead;
const FALLBACK_MODELS = [
  "qwen/qwen3.8-27b",
  "deepseek-ai/deepseek-v4.1-flash-1017",
  "zai-org/glm-5.3-flash",
  "zai-org/glm-5.3",
  "moonshotai/kimi-k3.1-pro",
  "deepseek-ai/deepseek-v4-pro",
  "google/gemma-4-31b-it",
];

type SseEvent =
  | { type: "phase_start"; mode: Mode; model: string }
  | { type: "timeline"; mode: Mode; event: TimelineEvent }
  | { type: "user_question"; mode: Mode; questionId: string; question: UserQuestion }
  | { type: "user_answered"; mode: Mode; questionId: string; answer: string }
  | { type: "phase_done"; mode: Mode; report: TeamReport }
  | { type: "all_done" }
  | { type: "stopped" };

type Session = {
  id: string;
  controller: AbortController;
  buffer: SseEvent[];
  clients: Set<http.ServerResponse>;
  pendingQuestions: Map<string, { resolve: (ans: string) => void; reject: (err: Error) => void }>;
  done: boolean;
};

const sessions = new Map<string, Session>();

function emit(session: Session, payload: SseEvent) {
  session.buffer.push(payload);
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of session.clients) {
    res.write(line);
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

type BackupPair = {
  id: string;
  label: string;
  bare: string;
  harness: string;
};

function loadRunReport(dirName: string): TeamReport | null {
  const reportPath = path.join(REPO_ROOT, "runs", dirName, "report.json");
  if (!fs.existsSync(reportPath)) return null;
  try {
    const rep = JSON.parse(fs.readFileSync(reportPath, "utf8")) as TeamReport;
    if (!Array.isArray(rep.timeline) || rep.timeline.length === 0) return null;
    return rep;
  } catch {
    return null;
  }
}

function findLatestBackups(): { bare: string | null; harness: string | null; pairs: BackupPair[] } {
  const runsDir = path.join(REPO_ROOT, "runs");
  if (!fs.existsSync(runsDir)) return { bare: null, harness: null, pairs: [] };
  const dirs = fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  const entries: { dir: string; rep: TeamReport }[] = [];
  for (const d of dirs) {
    const rep = loadRunReport(d);
    if (rep) entries.push({ dir: d, rep });
  }

  // A pair is a bare run immediately followed by a harness run (one `--mode both` run).
  // Matching by adjacency keeps a lone harness-only run from shifting every pair.
  const pairs: BackupPair[] = [];
  for (let i = 0; i < entries.length - 1; i++) {
    const h = entries[i]; // entries are newest first
    const matchBare = entries[i + 1];
    if (h.rep.mode !== "harness" || matchBare.rep.mode !== "bare") continue;
    const lead = h.rep.models?.lead ?? h.rep.model;
    const isMulti = h.rep.models && h.rep.models.lead !== h.rep.models.engineer;
    const tag = isMulti ? `${lead.split("/").pop()} + team` : lead.split("/").pop();
    const bareExec = (matchBare.rep.leadExecAttempts ?? 0) - (matchBare.rep.leadExecBlocked ?? 0);
    pairs.push({
      id: `${matchBare.dir}__${h.dir}`,
      label: `${h.dir.slice(9, 15)} · ${tag} (${matchBare.rep.seconds}s→${h.rep.seconds}s, DIY ${bareExec}x→0x, brakes ${h.rep.brakes.length})`,
      bare: matchBare.dir,
      harness: h.dir,
    });
  }

  return {
    bare: pairs[0]?.bare ?? entries.find((e) => e.rep.mode === "bare")?.dir ?? null,
    harness: pairs[0]?.harness ?? entries.find((e) => e.rep.mode === "harness")?.dir ?? null,
    pairs: pairs.slice(0, 8),
  };
}

let cachedModels: string[] | null = null;
async function getModels(): Promise<string[]> {
  if (cachedModels) return cachedModels;
  try {
    const list = await Promise.race([
      client.models.list(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3500)),
    ]);
    const ids = list.data.map((m) => m.id).filter(Boolean);
    if (ids.length > 0) {
      // Put default first
      const ordered = [DEFAULT_MODEL, ...ids.filter((id) => id !== DEFAULT_MODEL)];
      cachedModels = ordered;
      return ordered;
    }
  } catch {
    // offline fallback
  }
  return FALLBACK_MODELS;
}

function createInteractiveChannel(session: Session, mode: Mode): UserChannel {
  return {
    ask: (question) =>
      new Promise<string>((resolve, reject) => {
        if (session.controller.signal.aborted) {
          reject(new Error("Run aborted"));
          return;
        }
        const questionId = crypto.randomUUID().slice(0, 8);
        session.pendingQuestions.set(questionId, { resolve, reject });
        emit(session, { type: "user_question", mode, questionId, question });
      }),
  };
}

async function runLiveSession(
  session: Session,
  opts: { mode: "both" | "bare" | "harness"; model: string; interactive: boolean },
) {
  const modes: Mode[] = opts.mode === "both" ? ["bare", "harness"] : [opts.mode];
  try {
    for (const mode of modes) {
      if (session.controller.signal.aborted) break;
      emit(session, { type: "phase_start", mode, model: opts.model });

      const userChannel =
        mode === "harness" && opts.interactive
          ? createInteractiveChannel(session, mode)
          : createModelUserChannel(DEFAULT_MODELS.user);

      // The UI picks the Lead; the team and the Product Owner stay on the cheap defaults.
      const report = await runTeam({
        mode,
        task: DEFAULT_TASK,
        leadModel: opts.model,
        workerModel: DEFAULT_MODELS.engineer,
        engineerModel: DEFAULT_MODELS.engineer,
        qaModel: DEFAULT_MODELS.qa,
        userModel: mode === "harness" && opts.interactive ? "(you, in the browser)" : DEFAULT_MODELS.user,
        userChannel,
        quiet: true,
        signal: session.controller.signal,
        onTimeline: (event) => emit(session, { type: "timeline", mode, event }),
      });

      emit(session, { type: "phase_done", mode, report });
    }
    emit(session, session.controller.signal.aborted ? { type: "stopped" } : { type: "all_done" });
  } catch {
    emit(session, { type: "stopped" });
  } finally {
    session.done = true;
  }
}

async function runReplaySession(
  session: Session,
  bareDir: string,
  harnessDir: string,
  speed: "normal" | "fast" | "instant" = "fast",
) {
  const sleep = (ms: number) =>
    ms <= 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          session.controller.signal.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });

  const pairs: { mode: Mode; dir: string }[] = [
    { mode: "bare", dir: bareDir },
    { mode: "harness", dir: harnessDir },
  ];

  try {
    for (const { mode, dir } of pairs) {
      if (session.controller.signal.aborted) break;
      const safeDir = path.basename(dir);
      const reportPath = path.join(REPO_ROOT, "runs", safeDir, "report.json");
      const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as TeamReport;

      emit(session, { type: "phase_start", mode, model: report.model });
      for (const ev of report.timeline) {
        if (session.controller.signal.aborted) break;
        emit(session, { type: "timeline", mode, event: ev });
        const delay =
          speed === "instant"
            ? 0
            : speed === "fast"
              ? ev.kind === "brake"
                ? 360
                : ev.kind === "user_question"
                  ? 260
                  : 95
              : ev.kind === "brake"
                ? 650
                : ev.kind === "user_question"
                  ? 450
                  : 200;
        await sleep(delay);
      }
      if (!session.controller.signal.aborted) {
        emit(session, { type: "phase_done", mode, report });
        await sleep(speed === "instant" ? 0 : speed === "fast" ? 180 : 350);
      }
    }
    emit(session, session.controller.signal.aborted ? { type: "stopped" } : { type: "all_done" });
  } catch {
    emit(session, { type: "stopped" });
  } finally {
    session.done = true;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") {
    const html = fs.readFileSync(path.join(REPO_ROOT, "public", "index.html"), "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    const models = await getModels();
    sendJson(res, 200, {
      defaultTask: DEFAULT_TASK,
      defaultUserRules: DEFAULT_USER_RULES,
      defaultLeadModel: DEFAULT_MODEL,
      defaultModels: DEFAULT_MODELS,
      models,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/backups") {
    sendJson(res, 200, findLatestBackups());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/start") {
    const body = await readJsonBody(req);
    const id = crypto.randomUUID().slice(0, 10);
    const session: Session = {
      id,
      controller: new AbortController(),
      buffer: [],
      clients: new Set(),
      pendingQuestions: new Map(),
      done: false,
    };
    sessions.set(id, session);
    const mode = body.mode === "bare" || body.mode === "harness" ? body.mode : "both";
    const model = typeof body.model === "string" && body.model ? body.model : DEFAULT_MODEL;
    const interactive = body.interactive !== false;
    void runLiveSession(session, { mode, model, interactive });
    sendJson(res, 200, { sessionId: id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/replay") {
    const body = await readJsonBody(req);
    const bare = typeof body.bare === "string" ? body.bare : "";
    const harness = typeof body.harness === "string" ? body.harness : "";
    const speed =
      body.speed === "normal" || body.speed === "instant" || body.speed === "fast"
        ? body.speed
        : "fast";
    if (!bare || !harness) {
      sendJson(res, 400, { error: "Missing backup runs" });
      return;
    }
    const id = crypto.randomUUID().slice(0, 10);
    const session: Session = {
      id,
      controller: new AbortController(),
      buffer: [],
      clients: new Set(),
      pendingQuestions: new Map(),
      done: false,
    };
    sessions.set(id, session);
    void runReplaySession(session, bare, harness, speed);
    sendJson(res, 200, { sessionId: id });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/reply") {
    const body = await readJsonBody(req);
    const session = sessions.get(String(body.sessionId ?? ""));
    const qid = String(body.questionId ?? "");
    const answer = String(body.answer ?? "").trim();
    const pending = session?.pendingQuestions.get(qid);
    if (!session || !pending || !answer) {
      sendJson(res, 404, { error: "No pending question found" });
      return;
    }
    session.pendingQuestions.delete(qid);
    emit(session, { type: "user_answered", mode: "harness", questionId: qid, answer });
    pending.resolve(answer);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stop") {
    const body = await readJsonBody(req);
    const session = sessions.get(String(body.sessionId ?? ""));
    if (session) {
      session.controller.abort();
      for (const [, p] of session.pendingQuestions) {
        p.reject(new Error("Run aborted"));
      }
      session.pendingQuestions.clear();
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const session = sessions.get(url.searchParams.get("sessionId") ?? "");
    if (!session) {
      res.writeHead(404);
      res.end("Session not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const ev of session.buffer) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    session.clients.add(res);
    req.on("close", () => {
      session.clients.delete(res);
    });
    return;
  }

    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n🛑 No Micromanaging — Demo Arena running at http://localhost:${PORT}\n`);
});
