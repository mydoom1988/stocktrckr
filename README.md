# stocktrckr

A Render-ready stock ticker dashboard. Upload or paste a CSV/TXT list of ticker symbols and the app shows whether each ticker is green, red, or flat based on the latest market change.

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Deploy on Render

1. Connect the GitHub repository to Render.
2. Use the included `render.yaml`, or create a Web Service manually.
3. Set:
   - Build command: `npm install`
   - Start command: `npm start`

The server reads Render's `PORT` environment variable automatically.

## Ticker input

The app accepts comma, space, semicolon, or newline separated tickers, for example:

```text
AAPL, MSFT, NVDA
TSLA
AMZN
```
