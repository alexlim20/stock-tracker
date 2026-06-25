# Portfolio Tracker

Desktop portfolio tracker for trade CSVs with EUR/USD display conversion, persistent imports, manual trade entry, and portfolio charts.

## Run

```powershell
npm install
npm run dev
```

During development the app stores the main ledger at `data/trades.csv` and imported source files under `data/imports/`. In a packaged Electron build it uses the operating system's app data folder.

## Local Stock Intelligence

The Open Stock Intelligence panel fetches live market/news context for open positions and scans the next six months for catalysts such as earnings, dividends, splits, company-specific news, government/contract headlines, product launches, regulatory/legal items, financing events, partnerships, and sector-specific exposure such as Bitcoin or GLP-1 drug news. It uses the Deep Local catalyst engine by default, so there is no paid AI API call.

The panel has two modes:

- `Deep Local`: free, fast, rule-based catalyst ranking with live sources.
- `Local LLM`: opt-in Ollama synthesis on top of the same live source package. It falls back to Deep Local if no usable local model responds.

Optional: if you want local LLM wording through Ollama, start the app with:

```powershell
$env:PORTFOLIO_USE_OLLAMA="1"
$env:OLLAMA_MODEL="llama3.2"
npm run dev
```

Cloud-style Ollama model names are ignored by default so the app does not accidentally route analysis through a paid remote model.

The stock intelligence code is structured around a mode parameter, so a paid AI provider can be added later without changing how the dashboard stores trades or market data.

## CSV Format

```csv
date,ticker,action,shares,total_amount,currency
2026-03-24,MSFT,BUY,5,1904,USD
```

The supported currencies are `EUR` and `USD`; actions are `BUY` and `SELL`.
