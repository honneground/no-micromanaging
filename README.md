# No Micromanaging

**An "AI Decelerator" harness that stops the lead agent from doing the team's work itself.**

**▶ Demo (recorded runs, replayed in your browser): https://honneground.github.io/no-micromanaging/**

Built in one evening at the [+81 Builders](https://x.com/Plus81builders) **Agent Harness Build Night** (Tokyo, 17 Nov 2026), on top of [basically-ai-harness](https://github.com/TejasQ/basically-ai-harness).

---

## The problem

Give an orchestrator agent a team and a prompt like *"You are the Tech Lead, delegate to your team"*, and it still does this:

1. **Does it itself.** It reads the code, writes the code and runs the tests on its own.
2. **Takes over on the first failure.** QA reports a failing test, and the Lead fixes it personally instead of sending it back.
3. **Grades its own homework.** It reports "done, 10/10" based on tests it ran on code it wrote.

In a multi-model team this is also the expensive path. The Lead is usually the biggest model you have, and every file it reads lands in its context.

A prompt asks the model to behave. A harness makes sure it does.

## The idea

Put a **decelerator** between the Lead and the execution tools. The Lead still *sees* every tool, but the harness checks each call before it runs. A blocked call does not crash the run. The model gets back a message telling it what to do instead.

```
                 ┌──────────────────────────────┐
   🧑 User  ◄──── │ ask_user (clarify the rules) │
 (Product Owner)  └──────────────▲───────────────┘
                                 │
                        👔 Tech Lead  (expensive model)
                                 │  every tool call
                    ┌────────────▼────────────┐
                    │  🛑  AI DECELERATOR      │   deterministic rules,
                    │  (agent/4-guardrails.ts) │   not prompts
                    └──────┬────────────┬─────┘
            delegate_task  │            │  delegate_task
                  ┌────────▼───┐   ┌────▼────────┐
                  │ 🔧 Engineer │   │ 🧪 QA        │   cheap models,
                  │ read/write │   │ run_tests   │   own context each
                  └────────┬───┘   └────┬────────┘
                           ▼            ▼
                  workspace/pricing.ts   qa/*.test.ts  (QA only, hidden from Engineer)
```

**Same model, same prompt, same tools in both modes. The only difference is whether the decelerator is switched on.**

### The brakes

| Brake | Fires when the Lead… | What it is told instead |
|---|---|---|
| `ANTI-DIY` | calls `read_file`, `list_files`, `write_file` or `run_tests` itself | Stay above the code and delegate to @engineer / @qa |
| `NO TAKEOVER` | touches the code after QA failed | Coach @engineer with QA's exact failures, then re-run QA |
| `ASK USER FIRST` | delegates before clarifying ambiguous business rules | Call `ask_user` first |
| `VAGUE BRIEF` | delegates "fix checkout" with no scope or acceptance criteria | A delegation is a contract: owner + scope + criteria |
| `NO MICROCODE` | pastes implementation code into the brief | Give requirements and let @engineer write the code |
| `USER BOUNDARY` | asks the user a vague question, or dumps raw code on them | Ask about business decisions, with 2–4 options |
| `DONE GATE` | tries to report "done" before QA passed on the latest code | Done means independently verified |

### What the harness owns

- **Isolation.** Each role runs its own loop with its own context. The Engineer only sees the delegation contract, never the Lead's conversation.
- **Tool scoping.** Engineer: `list_files`, `read_file`, `write_file`. QA: `run_tests` only. Path guards keep the Engineer out of QA's test folder.
- **Facts over claims.** QA's test result is recorded by the harness from the actual test run, not from what the model says.
- **Ground truth.** After every run the harness executes the hidden suite itself and scores the outcome.

## Result from a real run

Lead `moonshotai/kimi-k3.1-pro` · Engineer `deepseek-ai/deepseek-v4.1-flash-1017` · QA `zai-org/glm-5.3-flash` · User `qwen/qwen3.8-27b`, all on ai& Inference.

| | Before (bare Lead) | After (decelerator on) |
|---|---|---|
| Lead touched the repo itself | **6×** | **0×** (2 attempts braked) |
| Code written by | Lead 2× · Engineer 0× | Lead 0× · Engineer 1× |
| Independent QA verified the final code | ✗ | ✓ |
| **Expensive-model (Lead) tokens** | **21,585** | **10,935** |
| Cheap-model (team) tokens | 1,118 | 7,267 |
| Hidden test suite | 10/10 | 10/10 |

In the "before" run the Lead wrote the code itself, got 9/10, delegated to QA, saw the failure and **fixed it personally**. That is the takeover pattern, and nobody prompted it to do that. The "after" run delegated, QA verified, and the Lead used half the expensive tokens.

Raw output of the runs on this page (console log, full report, and the final `pricing.ts` each team produced):

| Pair | Before (bare Lead) | After (decelerator on) |
|---|---|---|
| **105734** · Lead takes over after QA fails (the numbers above) | [console](docs/runs/20261117-105615-bare/console.txt) · [report](docs/runs/20261117-105615-bare/report.json) · [code](docs/runs/20261117-105615-bare/pricing.ts.txt) | [console](docs/runs/20261117-105734-harness/console.txt) · [report](docs/runs/20261117-105734-harness/report.json) · [code](docs/runs/20261117-105734-harness/pricing.ts.txt) |
| **113132** · Lead coaches after QA fails | [console](docs/runs/20261117-113033-bare/console.txt) · [report](docs/runs/20261117-113033-bare/report.json) · [code](docs/runs/20261117-113033-bare/pricing.ts.txt) | [console](docs/runs/20261117-113132-harness/console.txt) · [report](docs/runs/20261117-113132-harness/report.json) · [code](docs/runs/20261117-113132-harness/pricing.ts.txt) |

In pair 113132 the After run shows the coaching path: QA fails 9/10, the Lead sends the failure back to the Engineer instead of fixing it, and QA passes 10/10. Its Lead used 25.7k → 19.3k tokens (−25%).

> Runs are non-deterministic. Both versions usually pass the hidden tests. The difference is *how* the work gets done, who verified it, and what it cost.

## The task

A small TypeScript checkout module, [`sandbox-template/workspace/pricing.ts`](sandbox-template/workspace/pricing.ts), needs a `BUILD20` promo code. The brief is deliberately urgent and vague about one business rule (how BUILD20 interacts with the VIP discount). The Product Owner, played by a model, knows the real rules, and so do the 10 hidden tests:

- BUILD20 = 20% off, only on subtotals of at least 3000 yen
- VIP 10% and BUILD20 do not stack: the single biggest discount wins
- Codes are case-insensitive and ignore surrounding spaces; unknown codes are ignored
- Totals round down to whole yen

## Quickstart

```sh
npm install
cp .env.example .env        # add your API key
npm run models              # list model IDs your key can use
npm run team                # before, then after, then a comparison table
```

| Command | What it does |
|---|---|
| `npm run team` | Run the bare Lead, then the decelerated Lead, then compare |
| `npm run team:before` / `team:after` | Run one mode |
| `npm run team -- --interactive` | You answer the Lead's questions in the terminal |
| `npm run team -- --scripted-user` | Use a fixed reply instead of the Product Owner model |
| `npm run team:runs` | List saved runs |
| `npm run team:replay -- latest` | Replay the latest before/after pair (offline demo backup) |
| `npm run demo` | Web UI at http://localhost:3810 (live runs + saved runs) |
| `npm run build:pages` | Export the featured runs to `docs/` for the static GitHub Pages demo |
| `npm test` | Unit tests for the guardrails (no API calls) |

Each role's model is set by `LEAD_MODEL`, `ENGINEER_MODEL`, `QA_MODEL` and `USER_MODEL` (see `.env.example`). Any OpenAI-compatible endpoint works if you set `AIAND_BASE_URL`.

Every run is saved to `runs/<timestamp>-<mode>/` (`console.log` + `report.json`).

## Code map

| File | Role |
|---|---|
| [`agent/4-guardrails.ts`](agent/4-guardrails.ts) | The decelerator: every brake, as plain functions |
| [`agent/5-loop.ts`](agent/5-loop.ts) | The agent loop with `beforeTool` / `beforeFinish` hooks and an iteration budget |
| [`agent/6-harness.ts`](agent/6-harness.ts) | Owns the run: workspace, roles, prompts, Product Owner, scoreboard |
| [`agent/team-tools.ts`](agent/team-tools.ts) | Role-scoped tools bound to one run's workspace |
| [`agent/8-team.ts`](agent/8-team.ts) | CLI: run, list, replay |
| [`agent/server.ts`](agent/server.ts) + [`public/index.html`](public/index.html) | Web UI |
| [`sandbox-template/`](sandbox-template) | The repo the team works on, plus QA's hidden tests |

The original starter is still here: `eval/` (an eval harness) and `agent/1-tools.ts`, `browser.ts` and `7-index.ts` (a browser agent). See [basically-ai-harness](https://github.com/TejasQ/basically-ai-harness) for the walkthrough.

## Credits

- Starter harness: [basically-ai-harness](https://github.com/TejasQ/basically-ai-harness) by Tejas Kumar (MIT)
- Event: +81 Builders Agent Harness Build Night, hosted at Build+ in Ebisu, with sponsors ai& and Neo4j
- License: MIT (see [LICENSE](LICENSE))
