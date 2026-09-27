// Company financials from Yahoo's fundamentals timeseries, reduced to the numbers the buy checklist uses.

const TIMESERIES_TYPES = [
  "annualNetIncome",
  "annualNetIncomeCommonStockholders",
  "annualStockholdersEquity",
  "annualTotalAssets",
  "annualTotalDebt",
  "annualNetTangibleAssets",
  "annualOperatingCashFlow",
  "annualIssuanceOfDebt",
  "annualRepaymentOfDebt",
  "annualDilutedEPS",
  "annualOrdinarySharesNumber",
  "trailingPeRatio",
  "trailingMarketCap",
];
const HISTORY_SECONDS = 12 * 365 * 24 * 60 * 60;

// { type: [{ date, value, currency }] } sorted oldest first; missing or empty series are left out.
function parseTimeseries(json) {
  const series = {};
  for (const result of json?.timeseries?.result || []) {
    const type = result?.meta?.type?.[0];
    if (!type || !Array.isArray(result[type])) continue;

    const points = result[type]
      .filter((point) => point?.asOfDate && Number.isFinite(point.reportedValue?.raw))
      .map((point) => ({ date: String(point.asOfDate), value: point.reportedValue.raw, currency: point.currencyCode || "" }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (points.length) series[type] = points;
  }
  return series;
}

async function fetchTimeseries(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}`);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("type", TIMESERIES_TYPES.join(","));
  url.searchParams.set("period1", String(now - HISTORY_SECONDS));
  url.searchParams.set("period2", String(now));

  const response = await fetch(url, {
    headers: {
      "User-Agent": "stocktrckr/1.0",
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Financials provider returned ${response.status}`);
  }

  return parseTimeseries(await response.json());
}

function latest(points) {
  return points?.length ? points[points.length - 1] : null;
}

function fiscalYear(point) {
  return point ? point.date.slice(0, 4) : null;
}

function ratio(numerator, denominator) {
  return numerator && denominator && denominator.value > 0 ? numerator.value / denominator.value : null;
}

// Every value is null when Yahoo has no data for it; the checklist then asks the user instead.
function deriveMetrics(series, { price = 0, priceCurrency = "" } = {}) {
  const netIncome = series.annualNetIncome || series.annualNetIncomeCommonStockholders || [];
  const income = latest(netIncome);
  const equity = latest(series.annualStockholdersEquity);
  const assets = latest(series.annualTotalAssets);
  const debt = latest(series.annualTotalDebt);
  const cashFlow = series.annualOperatingCashFlow || [];
  const eps = series.annualDilutedEPS || [];
  const issued = latest(series.annualIssuanceOfDebt);
  const repaid = latest(series.annualRepaymentOfDebt);
  const shares = latest(series.annualOrdinarySharesNumber);
  const trailingPe = latest(series.trailingPeRatio);
  const trailingCap = latest(series.trailingMarketCap);

  let epsGrowth = null;
  if (eps.length >= 2) {
    const first = eps[0];
    const last = latest(eps);
    const years = Number(fiscalYear(last)) - Number(fiscalYear(first));
    epsGrowth = {
      from: first.value,
      to: last.value,
      firstYear: fiscalYear(first),
      lastYear: fiscalYear(last),
      cagr: first.value > 0 && last.value > 0 && years > 0 ? (last.value / first.value) ** (1 / years) - 1 : null,
    };
  }

  let cashFlowGrowth = null;
  if (cashFlow.length >= 2) {
    const steps = cashFlow.slice(1).map((point, index) => point.value > cashFlow[index].value);
    cashFlowGrowth = {
      increases: steps.filter(Boolean).length,
      steps: steps.length,
      firstYear: fiscalYear(cashFlow[0]),
      lastYear: fiscalYear(latest(cashFlow)),
    };
  }

  // Yahoo books repayments as negative numbers, so the sum is the net new debt.
  const netBorrowing = issued || repaid ? (issued?.value || 0) + (repaid?.value || 0) : null;

  let pe = trailingPe && trailingPe.value > 0 ? trailingPe.value : null;
  const latestEps = latest(eps);
  if (pe === null && price > 0 && latestEps?.value > 0 && latestEps.currency === priceCurrency) {
    pe = price / latestEps.value;
  }

  let marketCap = trailingCap ? { value: trailingCap.value, currency: trailingCap.currency || priceCurrency } : null;
  if (!marketCap && shares && price > 0) {
    marketCap = { value: shares.value * price, currency: priceCurrency };
  }

  return {
    currency: income?.currency || equity?.currency || priceCurrency,
    lastYear: fiscalYear(income),
    profitability: netIncome.length
      ? {
          profitableYears: netIncome.filter((point) => point.value > 0).length,
          years: netIncome.length,
          firstYear: fiscalYear(netIncome[0]),
          lastYear: fiscalYear(income),
        }
      : null,
    netIncome: income?.value ?? null,
    negativeEquity: Boolean(equity && equity.value <= 0),
    roe: ratio(income, equity),
    roa: ratio(income, assets),
    debtToEquity: ratio(debt, equity),
    operatingCashFlow: latest(cashFlow)?.value ?? null,
    netBorrowing,
    netTangibleAssets: latest(series.annualNetTangibleAssets)?.value ?? null,
    epsGrowth,
    cashFlowGrowth,
    pe,
    marketCap,
  };
}

module.exports = { TIMESERIES_TYPES, parseTimeseries, fetchTimeseries, deriveMetrics };
