import { test } from "node:test";
import assert from "node:assert/strict";
import { createTeamState, leadToolGuard, verifyLeadFinish } from "./4-guardrails.js";

test("blocks direct execution tools (ANTI-DIY) and switches to NO TAKEOVER after QA fail", () => {
  const state = createTeamState();
  const guard = leadToolGuard(state);

  const d1 = guard("write_file", { path: "pricing.ts", content: "// x" });
  assert.equal(d1.allow, false);
  assert.match(d1.message, /ANTI-DIY/);

  const d2 = guard("read_file", { path: "pricing.ts" });
  assert.equal(d2.allow, false);
  assert.match(d2.message, /ANTI-DIY/);

  state.lastQa = "fail";
  const d3 = guard("write_file", { path: "pricing.ts", content: "// fix" });
  assert.equal(d3.allow, false);
  assert.match(d3.message, /NO TAKEOVER/);
});

test("enforces ASK USER FIRST before delegating to engineer", () => {
  const state = createTeamState({ requireUserClarification: true });
  const guard = leadToolGuard(state);

  const blocked = guard("delegate_task", {
    owner: "engineer",
    task: "Update pricing.ts with BUILD20 promo code support",
    acceptance_criteria: ["20% off"],
  });
  assert.equal(blocked.allow, false);
  assert.match(blocked.message, /ASK USER FIRST/);

  const badAsk = guard("ask_user", { question: "hi?", options: ["one"] });
  assert.equal(badAsk.allow, false);
  assert.match(badAsk.message, /USER BOUNDARY/);

  const okAsk = guard("ask_user", {
    question: "Should VIP 10% stack with BUILD20?",
    options: ["No stacking, max discount wins", "Stack discounts"],
  });
  assert.equal(okAsk.allow, true);
  state.userClarified = true;

  const microcode = guard("delegate_task", {
    owner: "engineer",
    task: "Put this code in pricing.ts:\n```ts\nexport function calculateTotal() {}\n```",
    acceptance_criteria: ["BUILD20 works"],
  });
  assert.equal(microcode.allow, false);
  assert.match(microcode.message, /NO MICROCODE/);

  const allowed = guard("delegate_task", {
    owner: "engineer",
    task: "Update pricing.ts to support BUILD20 with no VIP stacking.",
    acceptance_criteria: ["BUILD20 applies 20% off when subtotal >= 3000", "No VIP stacking"],
  });
  assert.equal(allowed.allow, true);
});

test("DONE GATE rejects premature finish or code dump to user", () => {
  const state = createTeamState({ requireUserClarification: true });
  state.userClarified = true;
  const finish = verifyLeadFinish(state);

  const noQa = finish("All done!");
  assert.equal(noQa.accept, false);
  assert.match(noQa.message, /DONE GATE/);

  state.lastQa = "pass";
  state.codeChangedSinceQa = false;

  const codeDump = finish("Done!\n```ts\nexport function calculateTotal() { return 0; }\n```");
  assert.equal(codeDump.accept, false);
  assert.match(codeDump.message, /USER BOUNDARY/);

  const clean = finish("Shipped BUILD20 with no VIP stacking; QA verified 10/10 tests passing.");
  assert.equal(clean.accept, true);
});
