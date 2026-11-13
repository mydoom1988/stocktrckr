# Third-party skills

These skills come from [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills)
(MIT license, copy in `LICENSE-claude-trading-skills`), copied unmodified at commit `3bd4b7a2c7329ffb5efef95db2e53d1125b3dc40`.
They are Claude Code skills: instructions and helper scripts that Claude follows in sessions on this repository.
The web app itself does not use them. Upstream's disclaimer applies: educational and research use only, not financial advice.

## Included (14)

| Skill | Use | Needs |
| --- | --- | --- |
| market-news-analyst | Read and rank market-moving news | nothing |
| market-environment-analysis | Overall market regime and risk tone | nothing |
| us-stock-analysis | Single-stock review | nothing |
| position-sizer | Size a position from risk and stop | nothing |
| scenario-analyzer | Turn a news item into scenarios and impacts | nothing |
| us-market-bubble-detector | Bubble-risk check (relevant to a concentrated AI/chip book) | nothing |
| portfolio-manager | Allocation and risk review; works offline from a holdings CSV | `ALPACA_API_KEY` only for live Alpaca data |
| technical-analyst | Chart analysis | `FMP_API_KEY` |
| earnings-calendar | Upcoming earnings for holdings | `FMP_API_KEY` |
| economic-calendar-fetcher | Macro events | `FMP_API_KEY` |
| exposure-coach | How much equity exposure the market allows | `FMP_API_KEY` |
| market-top-detector | Market-top risk signals | `FMP_API_KEY` |
| theme-detector | Theme and sector strength | `FMP_API_KEY`; reads public CSVs published by the upstream author |
| sector-analyst | Sector rotation | reads public CSVs published by the upstream author |

Scripts assume Python 3 with `requests`, `pandas`, `numpy`, `pyyaml`, `yfinance` and `pandas-market-calendars`; none of these are installed by this repository.

## Left out on purpose

- `trader-memory-core` and everything built on its trade journal (`pre-trade-discipline-gate`, `drawdown-circuit-breaker`,
  `trade-performance-coach`, `weekly-performance-digest`): it keeps trade records in a state folder and its wrapper expects
  the upstream repository layout. This app has its own thesis tracker, and trade records don't belong in a public repo.
- `trading-skills-navigator`: reads the upstream index files, so it would mislead with a partial install.
- The remaining 50-odd skills (crypto, MT5, futures, strategy research, screeners that need paid Finviz data).

## Before updating

Skills are instructions Claude acts on. Read upstream's diff first, copy only the folders you want, and re-check which
hosts the scripts contact. Skill outputs default to `reports/` and `state/`; both are git-ignored so a portfolio report
can't be committed by accident.
