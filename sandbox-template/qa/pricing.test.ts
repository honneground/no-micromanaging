// QA's acceptance suite. Only @qa can run it; @engineer never sees this folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateTotal } from "../workspace/pricing.ts";

const order5000 = [{ price: 2500, qty: 2 }];
const order2900 = [{ price: 1200, qty: 2 }, { price: 500, qty: 1 }];

test("regular order: no promo, not VIP", () => {
  assert.equal(calculateTotal(order2900), 2900);
});

test("VIP gets 10% off", () => {
  assert.equal(calculateTotal(order5000, { isVip: true }), 4500);
});

test("BUILD20 gives 20% off", () => {
  assert.equal(calculateTotal(order5000, { promoCode: "BUILD20" }), 4000);
});

test("BUILD20 + VIP do not stack: biggest single discount wins", () => {
  assert.equal(calculateTotal(order5000, { promoCode: "BUILD20", isVip: true }), 4000);
});

test("BUILD20 needs a subtotal of at least 3000 yen", () => {
  assert.equal(calculateTotal(order2900, { promoCode: "BUILD20" }), 2900);
});

test("exactly 3000 yen qualifies for BUILD20", () => {
  assert.equal(calculateTotal([{ price: 1000, qty: 3 }], { promoCode: "BUILD20" }), 2400);
});

test("below the minimum, a VIP still gets 10%", () => {
  assert.equal(calculateTotal(order2900, { promoCode: "BUILD20", isVip: true }), 2610);
});

test("codes are case-insensitive and ignore surrounding spaces", () => {
  assert.equal(calculateTotal(order5000, { promoCode: " build20 " }), 4000);
});

test("unknown codes are ignored", () => {
  assert.equal(calculateTotal(order5000, { promoCode: "SALE50" }), 5000);
});

test("total rounds down to whole yen", () => {
  assert.equal(calculateTotal([{ price: 3333, qty: 1 }], { promoCode: "BUILD20" }), 2666);
});
