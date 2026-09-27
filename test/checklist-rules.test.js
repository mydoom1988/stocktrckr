const assert = require("node:assert/strict");
const { test } = require("node:test");
const { CRITERIA, evaluate, nextAnswer, summarize } = require("../public/checklist-rules");

// A healthy company, except that operating cash flow dipped once.
const METRICS = {
  currency: "EUR",
  lastYear: "2024",
  profitability: { profitableYears: 4, years: 4, firstYear: "2021", lastYear: "2024" },
  netIncome: 120,
  negativeEquity: false,
  roe: 0.2,
  roa: 0.1,
  debtToEquity: 0.5,
  operatingCashFlow: 130e6,
  netBorrowing: -30e6,
  netTangibleAssets: 400e6,
  epsGrowth: { from: 2, to: 3, firstYear: "2021", lastYear: "2024", cagr: 0.1447 },
  cashFlowGrowth: { increases: 2, steps: 3, firstYear: "2021", lastYear: "2024" },
  pe: 13.9,
  marketCapUsd: 2.3e9,
};
const JUDGEMENT = CRITERIA.filter((criterion) => criterion.group === "judgement").map((criterion) => criterion.id);

function statusOf(results, id) {
  return results.find((item) => item.id === id).status;
}

test("scores the financial rules from data and leaves judgement to the user", () => {
  const results = evaluate(METRICS, {}, "en-US");

  assert.equal(results.length, 16);
  assert.equal(statusOf(results, "cashFlowGrowth"), "fail");
  for (const id of ["profitable", "earningsGrowth", "roe", "roa", "debtToEquity", "cashFromProfit", "tangibleAssets", "marketCap", "pe"]) {
    assert.equal(statusOf(results, id), "pass", id);
  }
  for (const id of JUDGEMENT) assert.equal(statusOf(results, id), "unknown", id);

  const byId = Object.fromEntries(results.map((item) => [item.id, item.detail]));
  assert.equal(byId.profitable, "Profitable in 4 of 4 reported years (FY2021–2024). Yahoo only has 4 years; the rule asks for 5+.");
  assert.equal(byId.cashFlowGrowth, "Grew in 2 of 3 years (FY2021–2024).");
  assert.equal(byId.earningsGrowth, "EPS grew 14.5% a year (FY2021–2024).");
  assert.equal(byId.cashFromProfit, "Operating cash flow €130M vs. net new debt -€30M.");
  assert.equal(byId.marketCap, "Market cap $2.3B.");
});

test("applies each threshold at its boundary", () => {
  const edge = { ...METRICS, roe: 0.15, roa: 0.07, debtToEquity: 1.5, pe: 15, marketCapUsd: 499e6 };
  const results = evaluate(edge, {}, "en-US");

  assert.equal(statusOf(results, "roe"), "fail", "ROE must be above 15%");
  assert.equal(statusOf(results, "roa"), "pass", "ROA of 7% is enough");
  assert.equal(statusOf(results, "debtToEquity"), "pass", "1.5 is allowed");
  assert.equal(statusOf(results, "pe"), "fail", "P/E must be below 15");
  assert.equal(statusOf(results, "marketCap"), "fail");
});

test("fails loss-makers and companies with negative equity", () => {
  const results = evaluate(
    { ...METRICS, netIncome: -5, pe: null, roe: null, debtToEquity: null, negativeEquity: true, operatingCashFlow: -2e6 },
    {},
    "en-US"
  );

  assert.equal(statusOf(results, "pe"), "fail");
  assert.equal(statusOf(results, "roe"), "fail");
  assert.equal(statusOf(results, "debtToEquity"), "fail");
  assert.equal(statusOf(results, "cashFromProfit"), "fail");
});

test("without data every rule waits for the user", () => {
  const results = evaluate(null, { roe: "pass" });
  assert.equal(results.filter((item) => item.status === "unknown").length, 15);
  assert.equal(statusOf(results, "roe"), "pass");
  assert.equal(results.find((item) => item.id === "roe").source, "you");
});

test("only gives a verdict once the unchecked rules can't change it", () => {
  assert.equal(summarize(evaluate(METRICS, {})).verdict, null, "9 met with 6 open could still end anywhere");

  const allYes = Object.fromEntries(JUDGEMENT.map((id) => [id, "pass"]));
  assert.deepEqual(summarize(evaluate(METRICS, allYes)), { met: 15, notMet: 1, unknown: 0, total: 16, verdict: "strong" });

  const allNo = Object.fromEntries(JUDGEMENT.map((id) => [id, "fail"]));
  assert.equal(summarize(evaluate(METRICS, allNo)).verdict, "partial");

  const failing = {
    ...METRICS,
    roe: 0.05,
    roa: 0.02,
    pe: 40,
    debtToEquity: 3,
    marketCapUsd: 1e8,
    netTangibleAssets: -1e6,
    epsGrowth: { ...METRICS.epsGrowth, cagr: 0.01 },
  };
  assert.equal(summarize(evaluate(failing, {})).verdict, "weak", "2 met + 6 open can't reach 9");
});

test("tapping cycles judgement rules and flips data rules", () => {
  const [judgement] = evaluate(METRICS, {}).filter((item) => item.id === "business");
  assert.equal(nextAnswer(judgement), "pass");
  assert.equal(nextAnswer({ ...judgement, status: "pass", source: "you" }), "fail");
  assert.equal(nextAnswer({ ...judgement, status: "fail", source: "you" }), null);

  const roe = evaluate(METRICS, {}).find((item) => item.id === "roe");
  assert.equal(nextAnswer(roe), "fail");
  const overridden = evaluate(METRICS, { roe: "fail" }).find((item) => item.id === "roe");
  assert.equal(overridden.status, "fail");
  assert.equal(nextAnswer(overridden), null, "a second tap goes back to the data");
});
