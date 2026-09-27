// The buy checklist: each rule is met, not met or still unknown. Financial rules are scored from
// Yahoo data when it exists; judgement rules come from the user, who can also override any rule.
// Runs in the browser as window.ChecklistRules and in Node for the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ChecklistRules = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const NEXT_STATUS = { unknown: "pass", pass: "fail", fail: "unknown" };

  function percent(value) {
    return `${(value * 100).toFixed(1)}%`;
  }

  function money(value, currency, locale) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(value);
    } catch (error) {
      return `${new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value)} ${currency}`;
    }
  }

  function years(from, to) {
    return from === to ? `FY${to}` : `FY${from}–${to}`;
  }

  // The rules ask for longer histories than Yahoo keeps; say so instead of pretending.
  function shortHistory(count, wanted) {
    return count < wanted ? ` Yahoo only has ${count} year${count === 1 ? "" : "s"}; the rule asks for ${wanted}+.` : "";
  }

  function result(status, detail) {
    return { status, detail };
  }

  const CRITERIA = [
    {
      id: "profitable",
      group: "data",
      label: "Profitable every year for 5+ years",
      evaluate(m) {
        const p = m.profitability;
        if (!p) return null;
        const detail = `Profitable in ${p.profitableYears} of ${p.years} reported years (${years(p.firstYear, p.lastYear)}).`;
        return result(p.profitableYears === p.years ? "pass" : "fail", detail + (p.profitableYears === p.years ? shortHistory(p.years, 5) : ""));
      },
    },
    {
      id: "cashFlowGrowth",
      group: "data",
      label: "Operating cash flow growing for 7+ years",
      evaluate(m) {
        const g = m.cashFlowGrowth;
        if (!g) return null;
        const met = g.increases === g.steps;
        const detail = `Grew in ${g.increases} of ${g.steps} year${g.steps === 1 ? "" : "s"} (${years(g.firstYear, g.lastYear)}).`;
        return result(met ? "pass" : "fail", detail + (met ? shortHistory(g.steps + 1, 7) : ""));
      },
    },
    {
      id: "earningsGrowth",
      group: "data",
      label: "Earnings growing at least 3% a year",
      evaluate(m) {
        const g = m.epsGrowth;
        if (!g) return null;
        if (g.cagr === null) {
          return result("fail", `EPS went from ${g.from.toFixed(2)} to ${g.to.toFixed(2)} (${years(g.firstYear, g.lastYear)}), with losses along the way.`);
        }
        return result(g.cagr >= 0.03 ? "pass" : "fail", `EPS grew ${percent(g.cagr)} a year (${years(g.firstYear, g.lastYear)}).`);
      },
    },
    {
      id: "roe",
      group: "data",
      label: "Return on equity above 15%",
      evaluate(m) {
        if (m.negativeEquity) return result("fail", "Shareholders' equity is negative.");
        if (m.roe === null) return null;
        return result(m.roe > 0.15 ? "pass" : "fail", `ROE ${percent(m.roe)} (FY${m.lastYear}).`);
      },
    },
    {
      id: "roa",
      group: "data",
      label: "Return on assets at least 7%",
      evaluate(m) {
        if (m.roa === null) return null;
        return result(m.roa >= 0.07 ? "pass" : "fail", `ROA ${percent(m.roa)} (FY${m.lastYear}).`);
      },
    },
    {
      id: "debtToEquity",
      group: "data",
      label: "Debt-to-equity at most 1.5",
      evaluate(m) {
        if (m.negativeEquity) return result("fail", "Shareholders' equity is negative.");
        if (m.debtToEquity === null) return null;
        return result(m.debtToEquity <= 1.5 ? "pass" : "fail", `Debt-to-equity ${m.debtToEquity.toFixed(2)}.`);
      },
    },
    {
      id: "cashFromProfit",
      group: "data",
      label: "Cash comes from the business, not from debt",
      evaluate(m, locale) {
        if (m.operatingCashFlow === null) return null;
        const ocf = money(m.operatingCashFlow, m.currency, locale);
        if (m.operatingCashFlow <= 0) return result("fail", `Operating cash flow was ${ocf}.`);
        if (m.netBorrowing === null) return result("pass", `Operating cash flow ${ocf}; no borrowing reported.`);
        const met = m.operatingCashFlow > m.netBorrowing;
        return result(met ? "pass" : "fail", `Operating cash flow ${ocf} vs. net new debt ${money(m.netBorrowing, m.currency, locale)}.`);
      },
    },
    {
      id: "tangibleAssets",
      group: "data",
      label: "Owns tangible assets",
      evaluate(m, locale) {
        if (m.netTangibleAssets === null) return null;
        return result(m.netTangibleAssets > 0 ? "pass" : "fail", `Net tangible assets ${money(m.netTangibleAssets, m.currency, locale)}.`);
      },
    },
    {
      id: "marketCap",
      group: "data",
      label: "Market cap at least $500 million",
      evaluate(m, locale) {
        if (m.marketCapUsd === null || m.marketCapUsd === undefined) return null;
        return result(m.marketCapUsd >= 500e6 ? "pass" : "fail", `Market cap ${money(m.marketCapUsd, "USD", locale)}.`);
      },
    },
    {
      id: "pe",
      group: "data",
      label: "P/E below 15",
      evaluate(m) {
        if (m.pe === null) {
          return m.netIncome !== null && m.netIncome <= 0 ? result("fail", "Loss-making, so there is no P/E.") : null;
        }
        return result(m.pe < 15 ? "pass" : "fail", `P/E ${m.pe.toFixed(1)}.`);
      },
    },
    { id: "forecasts", group: "judgement", label: "Hit its previous forecasts" },
    { id: "ceoPay", group: "judgement", label: "CEO pay tracks the company's results" },
    { id: "institutions", group: "judgement", label: "Institutions own at most 60%" },
    { id: "insiderBuying", group: "judgement", label: "Insiders have been buying" },
    { id: "revenue", group: "judgement", label: "You know where the revenue comes from" },
    { id: "business", group: "judgement", label: "You understand the business" },
  ];

  // answers: { [criterionId]: "pass" | "fail" } set by the user; they override the data.
  function evaluate(metrics, answers = {}, locale) {
    return CRITERIA.map((criterion) => {
      const fromData = metrics && criterion.evaluate ? criterion.evaluate(metrics, locale) : null;
      const dataStatus = fromData ? fromData.status : "unknown";
      const answer = answers[criterion.id];
      return {
        id: criterion.id,
        group: criterion.group,
        label: criterion.label,
        dataStatus,
        status: answer || dataStatus,
        source: answer ? "you" : fromData ? "data" : "none",
        detail: fromData ? fromData.detail : "",
      };
    });
  }

  // A verdict is only given once the unchecked rules can no longer change it; until then it is null.
  function summarize(results) {
    const met = results.filter((item) => item.status === "pass").length;
    const notMet = results.filter((item) => item.status === "fail").length;
    const total = results.length;
    const unknown = total - met - notMet;
    const strong = Math.ceil(total * 0.8);
    const partial = Math.ceil(total * 0.55);

    let verdict = null;
    if (met >= strong) verdict = "strong";
    else if (met + unknown < partial) verdict = "weak";
    else if (met >= partial && met + unknown < strong) verdict = "partial";
    return { met, notMet, unknown, total, verdict };
  }

  // The answer to store after a tap (null clears it). Rules without data cycle
  // unknown → met → not met → unknown; rules with data flip to the opposite, and back on the next tap.
  function nextAnswer(item) {
    if (item.dataStatus === "unknown") {
      const next = NEXT_STATUS[item.status];
      return next === "unknown" ? null : next;
    }
    if (item.source === "you") return null;
    return item.dataStatus === "pass" ? "fail" : "pass";
  }

  return { CRITERIA, evaluate, summarize, nextAnswer };
});
