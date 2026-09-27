# stocktrckr

A private, password-protected stock dashboard for Render. Sign in with a password, import your Revolut brokerage statement to see your portfolio valued live in EUR, and scan any tickers on a green/red market heatmap.

## Privacy

- Every page, script and API call requires signing in. Only the login page, its stylesheet and `robots.txt` are public, and search engines are told not to index anything.
- There is a single password and no usernames. It lives in the `APP_PASSWORD` environment variable, never in the code: this repository is public.
- Sessions are HttpOnly, SameSite=Lax cookies (Secure over HTTPS) signed with HMAC-SHA256 and valid for 30 days. Changing `APP_PASSWORD` signs every device out.
- After 10 wrong passwords from one address, or 100 in total, sign-in pauses for 15 minutes.
- If `APP_PASSWORD` is missing, the app stays locked rather than opening up.
- Imported portfolios are parsed and stored in your browser only (`localStorage`); the server never receives them. Never commit statements or exports to this repository.

## Deploy on Render

1. In the Render dashboard, open the **stocktrckr** service → **Environment** and add:
   - `APP_PASSWORD`: a long passphrase that only you know.
   - `SESSION_SECRET`: a long random string (Render's **Generate** button works). Optional but recommended; without it the session key is derived from the password.
2. Save. Render redeploys, and every push to `main` deploys automatically.

The service uses `npm install` as the build command and `npm start` (or `node server.js`) as the start command. The included `render.yaml` declares the same settings for Blueprint deploys.

## Portfolio import

Click **Import report** and choose one of:

- **Revolut account statement.** In the Revolut app, request the brokerage account statement covering everything since the account was opened, in Excel/CSV format. Buys, sells, stock splits and transfers are replayed to rebuild your open positions, with the average cost converted to EUR using the statement's FX Rate column. Statements don't include the cash balance, so click **Cash** to enter it.
- **Holdings CSV.** Any CSV with `Ticker` and `Quantity` columns. Optional columns are `Name`, `Currency`, `Average price` (per share, in `Currency`), and `Cost basis` with `Cost currency`. A row with the ticker `CASH` sets the cash balance in EUR.

```csv
Ticker,Name,Quantity,Currency,Cost basis,Cost currency
AAPL,Apple Inc.,2.5,USD,410.00,EUR
SAP,SAP SE,1.25,EUR,200.00,EUR
CASH,Cash balance,150.00,EUR,,
```

PDF statements, `.xlsx` workbooks and screenshots aren't read; export CSV instead. Live prices and currency rates come from Yahoo Finance. Values match Revolut's when Yahoo resolves a ticker to the same listing; hover over a holding to see which listing was used.

## News

The News panel lists the latest Yahoo Finance headlines for your holdings, newest first. Tap a ticker chip to see one holding's news; chips are ordered by position size. Each holding is looked up by the symbol its price came from (for example `RHM.DE` for Rheinmetall), and results are cached on the server for 10 minutes.

## Buy checklist

The Opportunity ranking and Thesis tracker score stocks against a fixed set of buying rules. Check one ticker, or tap **Check my holdings**.

- **From the financials** (Yahoo Finance annual data, filled in automatically): profitable every year for 5+ years, operating cash flow growing for 7+ years, earnings per share growing at least 3% a year, ROE above 15%, ROA at least 7%, debt-to-equity at most 1.5, cash coming from the business rather than new debt, positive net tangible assets, market cap of at least $500 million, and P/E below 15. Yahoo usually keeps about four years, so the multi-year rules say when they could only check a shorter window.
- **Your judgement** (you answer): whether it hit its previous forecasts, whether CEO pay tracks results, institutional ownership of at most 60%, whether insiders have been buying, and whether you understand the business and where its revenue comes from.

Tap a rule to answer or override it. A verdict appears only once the open rules can no longer change it. Each stock also keeps your thesis, buy zone, sell rule and risks, and a purchase date that starts a 3-year review reminder. Funds and ETFs aren't scored. For a secondary listing without statements, check the main listing's Yahoo symbol instead (for example `285A.T`). Everything is saved in the browser.

## Local development

```bash
npm install
APP_PASSWORD=choose-a-password npm run dev
```

Open `http://localhost:3000`. Run the tests with `npm test`.

## Ticker input

The heatmap accepts comma, space, semicolon, or newline separated tickers, for example:

```text
AAPL, MSFT, NVDA
TSLA
AMZN
```
