import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import {
  CalendarClock,
  ChartColumn,
  ChevronDown,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  FolderOpen,
  Key,
  Landmark,
  Link2,
  Moon,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Tags,
  Trash2,
  TrendingUp,
  Upload,
  Wallet,
  X
} from "lucide-react";
import {
  buildAnalytics,
  emptyAnalytics,
  formatCurrency,
  formatPercent
} from "../shared/analytics.js";
import { DEFAULT_MARKET_DATA } from "../shared/marketData.js";
import { portfolioApi } from "./api.js";
import MarketPulseDashboard from "./MarketPulse.jsx";
import MediaPipelineDashboard from "./MediaPipeline.jsx";

const today = new Date().toISOString().slice(0, 10);
const blankTrade = {
  date: today,
  ticker: "",
  action: "BUY",
  shares: "",
  total_amount: "",
  currency: "EUR"
};

const blankBankingConfig = {
  applicationId: "",
  privateKeyContent: "",
  redirectUrl: "https://localhost:8080/",
  aspspName: "N26",
  aspspCountry: "DE",
  psuType: "personal",
  consentDays: 90
};

const blankBankingState = {
  config: blankBankingConfig,
  privateKeyExists: false,
  privateKeyResolvedPath: "",
  privateKeyStoredInSettings: false,
  connection: {
    sessionIdPresent: false,
    accounts: [],
    selectedAccountUid: "",
    accessValidUntil: "",
    connectedAt: "",
    lastBalanceFetchedAt: "",
    pendingAuthorization: null
  }
};

function toBankingConfig(config = {}) {
  const { privateKeyPath: _privateKeyPath, privateKeyContent: _privateKeyContent, ...publicConfig } = config || {};
  return { ...blankBankingConfig, ...publicConfig, privateKeyContent: "" };
}

const BALANCE_CACHE_TTL_MS = 60 * 1000;
const EXPENSE_CACHE_TTL_MS = 5 * 60 * 1000;
const UNCATEGORIZED = "Uncategorized";
const DEFAULT_EXPENSE_CATEGORIES = [
  "Groceries",
  "Restaurants",
  "Transport",
  "Travel",
  "Fuel",
  "Subscriptions",
  "Phone & Internet",
  "Bills & Utilities",
  "Health",
  "Entertainment",
  "Shopping",
  "Personal Care",
  "Financial",
  "Transfers",
  "Cash",
  "Other",
  UNCATEGORIZED
];
const CASH_FLOW_RANGE_OPTIONS = [
  { value: "1m", label: "1M", detail: "Last 30 days" },
  { value: "3m", label: "3M", detail: "3 months" },
  { value: "5m", label: "5M", detail: "5 months" },
  { value: "1y", label: "1Y", detail: "12 months" },
  { value: "5y", label: "5Y", detail: "60 months" }
];
const GEMINI_API_KEY_SLOT_COUNT = 5;
const WATCH_TIMEFRAME_OPTIONS = [
  { value: "1d", label: "1D", days: 1 },
  { value: "1w", label: "1W", days: 7 },
  { value: "1m", label: "1M", days: 31 },
  { value: "1y", label: "1Y", days: 365 }
];
const THEME_STORAGE_KEY = "portfolioTrackerTheme";
const CLOSED_LEDGER_STROKE = "#94a3b8";
const DIMMED_LEDGER_STROKE = "#9aa4b2";

function getInitialTheme() {
  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return storedTheme === "light" || storedTheme === "dark" ? storedTheme : "dark";
  } catch {
    return "dark";
  }
}

function persistTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Theme persistence is a convenience; the in-memory state is enough.
  }
}

function normalizeTickerSymbol(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeWatchlist(values = []) {
  const source = Array.isArray(values) ? values : [];
  return [...new Set(source.map(normalizeTickerSymbol).filter(Boolean))].sort();
}

function getTickerPriceInfo(ticker, marketData) {
  const tickerData = marketData?.prices?.[ticker];
  const points = tickerData?.points ?? [];
  const latest = points.at(-1) || null;
  const previous = points.at(-2) || null;
  const changeAmount = latest && previous ? latest.close - previous.close : null;
  const changePercent = latest && previous && previous.close
    ? (changeAmount / previous.close) * 100
    : null;

  return {
    currency: tickerData?.currency || "EUR",
    latestPrice: latest?.close ?? null,
    latestDate: latest?.date || "",
    changeAmount,
    changePercent
  };
}

function getActiveScannerTags(scanner) {
  const tags = [];
  if (scanner?.profiles?.rocket?.passed) {
    tags.push({
      key: "rocket",
      label: "ROCKET / HIGH VELOCITY",
      profile: scanner.profiles.rocket.label
    });
  }
  if (scanner?.profiles?.wideMoat?.passed) {
    tags.push({
      key: "wideMoat",
      label: "WIDE-MOAT UNDERDOG",
      profile: scanner.profiles.wideMoat.label
    });
  }
  return tags;
}

function buildWatchlistItems(watchlist, holdings, marketData) {
  const holdingsByTicker = new Map(holdings.map((holding) => [holding.ticker, holding]));

  return watchlist.map((ticker) => {
    const holding = holdingsByTicker.get(ticker);
    const priceInfo = getTickerPriceInfo(ticker, marketData);
    const scanner = marketData?.fundamentals?.[ticker] || null;
    return {
      ticker,
      holding,
      scanner,
      tags: getActiveScannerTags(scanner),
      ...priceInfo
    };
  });
}

function buildWatchPriceSeries(ticker, marketData, timeframe) {
  const option = WATCH_TIMEFRAME_OPTIONS.find((item) => item.value === timeframe) || WATCH_TIMEFRAME_OPTIONS[2];
  const points = marketData?.prices?.[ticker]?.points ?? [];
  const filteredPoints = filterPricePointsByDays(points, option.days);
  return filteredPoints.map((point) => ({
    date: point.date,
    price: point.close
  }));
}

function filterPricePointsByDays(points, days) {
  if (!Array.isArray(points) || points.length === 0) return [];
  if (days <= 1) return points.slice(-2);
  const latestDate = points.at(-1)?.date;
  if (!latestDate) return points;
  const cutoff = new Date(`${latestDate}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  const filtered = points.filter((point) => point.date >= cutoffDate);
  return filtered.length ? filtered : points.slice(-1);
}

function formatSignedPercent(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "--";
  const numeric = Number(value);
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(2)}%`;
}

function getChangeTone(value) {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "";
  return Number(value) >= 0 ? "good" : "bad";
}

function formatMetricValue(value, type = "number") {
  if (value == null || value === "" || !Number.isFinite(Number(value))) return "--";
  const numeric = Number(value);
  if (type === "percent") return `${numeric.toFixed(1)}%`;
  if (type === "ratio") return numeric.toFixed(2);
  return numeric.toFixed(1);
}

function getScannerTagClass(tagKey) {
  if (tagKey === "rocket") return "rocket";
  if (tagKey === "wideMoat") return "wide-moat";
  return "";
}

function getProfileScore(profile) {
  if (!profile) return "0/3";
  return `${profile.score || 0}/${profile.total || 0}`;
}

function getDiscoverySummary(items) {
  const rocketCount = items.filter((item) => item.tags.some((tag) => tag.key === "rocket")).length;
  const wideMoatCount = items.filter((item) => item.tags.some((tag) => tag.key === "wideMoat")).length;
  const scannedCount = items.filter((item) => item.scanner).length;
  return { rocketCount, wideMoatCount, scannedCount };
}

function normalizeGeminiApiKeySlots(keys = []) {
  const values = Array.isArray(keys)
    ? keys
    : typeof keys === "string"
      ? keys.split("\n")
      : [];
  return Array.from({ length: GEMINI_API_KEY_SLOT_COUNT }, (_value, index) => String(values[index] || ""));
}

function getFilledGeminiApiKeys(keys = []) {
  return normalizeGeminiApiKeySlots(keys)
    .map((key) => key.trim())
    .filter(Boolean);
}

function App() {
  const [activeTab, setActiveTab] = useState("stocks");
  const [theme, setTheme] = useState(() => getInitialTheme());
  const [displayCurrency, setDisplayCurrency] = useState("EUR");
  const [portfolio, setPortfolio] = useState({ trades: [], marketData: null, dataDir: "" });
  const [form, setForm] = useState(blankTrade);
  const [status, setStatus] = useState("Ready");
  const [isBusy, setIsBusy] = useState(false);
  const [isIntelBusy, setIsIntelBusy] = useState(false);
  const [intelMode] = useState("gemini");
  const [stockIntel, setStockIntel] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [geminiApiKeys, setGeminiApiKeys] = useState(() => normalizeGeminiApiKeySlots());
  const [visibleGeminiApiKeys, setVisibleGeminiApiKeys] = useState(() => Array(GEMINI_API_KEY_SLOT_COUNT).fill(false));
  const [geminiModel, setGeminiModel] = useState("gemini-2.5-flash");
  const [fmpApiKey, setFmpApiKey] = useState("");
  const [visibleFmpApiKey, setVisibleFmpApiKey] = useState(false);
  const [availableModels, setAvailableModels] = useState([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [watchlist, setWatchlist] = useState([]);
  const [watchTickerInput, setWatchTickerInput] = useState("");
  const [selectedWatchTicker, setSelectedWatchTicker] = useState("");
  const [watchTimeframe, setWatchTimeframe] = useState("1m");
  const [selectedLedgerTicker, setSelectedLedgerTicker] = useState("all");
  const [selectedDcaTicker, setSelectedDcaTicker] = useState("");
  const [stockAnalysisView, setStockAnalysisView] = useState("profit");
  const [hoveredLedgerTicker, setHoveredLedgerTicker] = useState("");
  const autoRefreshStarted = useRef(false);

  const analytics = useMemo(() => {
    if (!portfolio.trades.length) return emptyAnalytics(displayCurrency);
    return buildAnalytics(portfolio.trades, portfolio.marketData, displayCurrency);
  }, [displayCurrency, portfolio]);
  const portfolioReturns = useMemo(
    () => summarizePortfolioReturns(analytics.yearlyPerformance),
    [analytics.yearlyPerformance]
  );
  const visibleTrades = useMemo(
    () => [...portfolio.trades].sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker)),
    [portfolio.trades]
  );
  const watchlistItems = useMemo(
    () => buildWatchlistItems(watchlist, analytics.holdings, portfolio.marketData),
    [watchlist, analytics.holdings, portfolio.marketData]
  );
  const discoverySummary = useMemo(() => getDiscoverySummary(watchlistItems), [watchlistItems]);
  const activeWatchTicker = watchlist.includes(selectedWatchTicker) ? selectedWatchTicker : watchlist[0] || "";
  const activeWatchItem = watchlistItems.find((item) => item.ticker === activeWatchTicker) || null;
  const watchChartData = useMemo(
    () => buildWatchPriceSeries(activeWatchTicker, portfolio.marketData, watchTimeframe),
    [activeWatchTicker, portfolio.marketData, watchTimeframe]
  );
  const isDarkMode = theme === "dark";

  useEffect(() => {
    persistTheme(theme);
  }, [theme]);

  function handleToggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  async function loadPortfolio() {
    try {
      const data = await portfolioApi.getPortfolio();
      setPortfolio(data);
      setStatus(`Loaded ${data.trades.length} trades`);
    } catch (error) {
      setStatus(error.message);
    }
  }

  useEffect(() => {
    loadPortfolio();
    portfolioApi.getSettings?.().then((settings) => {
      if (settings?.geminiApiKeys) setGeminiApiKeys(normalizeGeminiApiKeySlots(settings.geminiApiKeys));
      if (settings?.geminiModel) setGeminiModel(settings.geminiModel);
      if (settings?.fmpApiKey) setFmpApiKey(settings.fmpApiKey);
      const savedWatchlist = normalizeWatchlist(settings?.watchlist);
      setWatchlist(savedWatchlist);
      setSelectedWatchTicker((current) => current || savedWatchlist[0] || "");
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (portfolio.trades.length > 0 && !portfolio.marketData?.fetchedAt && !autoRefreshStarted.current) {
      autoRefreshStarted.current = true;
      handleRefresh();
    }
  }, [portfolio.trades.length, portfolio.marketData?.fetchedAt]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      document.querySelectorAll(".table-wrap").forEach((node) => {
        node.scrollLeft = 0;
      });
    });

    return () => window.cancelAnimationFrame(frame);
  }, [analytics.yearlyPerformance.length, displayCurrency, visibleTrades.length]);

  useEffect(() => {
    if (!showSettings) return;
    const keysArray = getFilledGeminiApiKeys(geminiApiKeys);
    if (!keysArray.length) {
      setAvailableModels([]);
      return;
    }
    const fetchModels = async () => {
      setIsLoadingModels(true);
      try {
        const models = await portfolioApi.getGeminiModels?.(keysArray[0]);
        setAvailableModels(models || []);
      } catch (error) {
        console.error("Failed to fetch models", error);
        setAvailableModels([]);
      } finally {
        setIsLoadingModels(false);
      }
    };
    
    const timer = setTimeout(fetchModels, 500);
    return () => clearTimeout(timer);
  }, [geminiApiKeys, showSettings]);

  async function handleImport() {
    setIsBusy(true);
    setStatus("Importing CSV");
    try {
      const result = await portfolioApi.importCsv();
      if (result.canceled) {
        setStatus("Import canceled");
      } else {
        setPortfolio((current) => ({ ...current, trades: result.trades }));
        setStatus(`Imported ${result.imported} rows, added ${result.added}`);
      }
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRefresh() {
    setIsBusy(true);
    setStatus("Refreshing market data");
    try {
      const result = await portfolioApi.refreshMarketData();
      setPortfolio((current) => ({ ...current, marketData: result.marketData }));
      const failed = result.marketData.failures?.length ?? 0;
      const tagged = Object.values(result.marketData?.fundamentals || {}).filter((item) => getActiveScannerTags(item).length).length;
      const scannerCopy = tagged ? `, ${tagged} underdog candidate${tagged === 1 ? "" : "s"} flagged` : "";
      setStatus(failed ? `Market data refreshed with ${failed} warning${failed === 1 ? "" : "s"}${scannerCopy}` : `Market data refreshed${scannerCopy}`);
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStockIntel() {
    setIsIntelBusy(true);
    setStatus("Refreshing Gemini AI stock intelligence");
    try {
      const result = await portfolioApi.getStockIntel({ mode: intelMode });
      setPortfolio((current) => ({ ...current, marketData: result.marketData }));
      setStockIntel(result.stockIntel);
      setStatus(`Stock intelligence refreshed for ${result.stockIntel.items.length} open stocks (${result.stockIntel.engine})`);
    } catch (error) {
      if (error.message.includes("QUOTA_EXHAUSTED")) {
        alert("All provided Gemini API keys have reached their quota limits. Please add more keys or wait until your quota resets.");
        setStatus("Stock intelligence failed: Quota exhausted");
      } else {
        setStatus(error.message);
      }
    } finally {
      setIsIntelBusy(false);
    }
  }

  function handleGeminiKeyChange(index, value) {
    setGeminiApiKeys((current) => current.map((key, keyIndex) => (keyIndex === index ? value : key)));
  }

  function toggleGeminiKeyVisibility(index) {
    setVisibleGeminiApiKeys((current) => current.map((visible, keyIndex) => (keyIndex === index ? !visible : visible)));
  }
  async function handleSaveSettings() {
    try {
      const keysArray = getFilledGeminiApiKeys(geminiApiKeys);
      await portfolioApi.saveSettings?.({ geminiApiKeys: keysArray, geminiModel, fmpApiKey: fmpApiKey.trim() });
      setShowSettings(false);
      setStatus("Settings saved");
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function persistWatchlist(nextWatchlist, message, preferredTicker = "") {
    const normalized = normalizeWatchlist(nextWatchlist);
    setWatchlist(normalized);
    setSelectedWatchTicker((current) => preferredTicker || (normalized.includes(current) ? current : normalized[0] || ""));

    try {
      await portfolioApi.saveSettings?.({ watchlist: normalized });
      setStatus(message);
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function handleAddWatchTicker(event) {
    event.preventDefault();
    const ticker = normalizeTickerSymbol(watchTickerInput);
    if (!ticker) return;

    setWatchTickerInput("");
    if (watchlist.includes(ticker)) {
      setSelectedWatchTicker(ticker);
      setStatus(`${ticker} is already on the watchlist`);
      return;
    }

    await persistWatchlist([...watchlist, ticker], `${ticker} added to watchlist`, ticker);
  }

  async function handleWatchTicker(ticker) {
    const normalized = normalizeTickerSymbol(ticker);
    if (!normalized) return;
    if (watchlist.includes(normalized)) {
      setSelectedWatchTicker(normalized);
      return;
    }

    await persistWatchlist([...watchlist, normalized], `${normalized} added to watchlist`, normalized);
  }

  async function handleRemoveWatchTicker(ticker) {
    await persistWatchlist(watchlist.filter((item) => item !== ticker), `${ticker} removed from watchlist`);
  }

  async function handleSaveTrade(event) {
    event.preventDefault();
    setIsBusy(true);
    setStatus("Saving trade");
    try {
      const result = await portfolioApi.addTrade({
        ...form,
        shares: Number(form.shares),
        total_amount: Number(form.total_amount)
      });
      setPortfolio((current) => ({ ...current, trades: result.trades }));
      setForm(blankTrade);
      setStatus(result.added ? "Trade saved" : "Trade already exists");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleDeleteTrade(trade) {
    const confirmed = window.confirm(`Delete ${trade.action} ${trade.shares} ${trade.ticker} from ${trade.date}?`);
    if (!confirmed) return;

    setIsBusy(true);
    setStatus("Deleting trade");
    try {
      const result = await portfolioApi.deleteTrade?.(trade);
      if (!result) {
        throw new Error("Trade deletion is not available in this app surface.");
      }
      setPortfolio((current) => ({ ...current, trades: result.trades }));
      setStatus(result.deleted ? "Trade deleted" : "Trade was already gone");
    } catch (error) {
      setStatus(error.message);
    } finally {
      setIsBusy(false);
    }
  }

  async function handleOpenFolder() {
    try {
      await portfolioApi.openDataFolder();
    } catch (error) {
      setStatus(error.message);
    }
  }

  const tickerKeys = useMemo(() => Object.keys(analytics.colors), [analytics.colors]);
  const activeLedgerTickerSet = useMemo(
    () => new Set(analytics.holdings.map((holding) => holding.ticker)),
    [analytics.holdings]
  );
  const activeLedgerTickers = useMemo(
    () => tickerKeys.filter((ticker) => activeLedgerTickerSet.has(ticker)),
    [activeLedgerTickerSet, tickerKeys]
  );
  const closedLedgerTickers = useMemo(
    () => tickerKeys.filter((ticker) => !activeLedgerTickerSet.has(ticker)),
    [activeLedgerTickerSet, tickerKeys]
  );
  const visibleLedgerTickers = useMemo(() => {
    if (selectedLedgerTicker === "active") return activeLedgerTickers;
    if (selectedLedgerTicker === "closed") return closedLedgerTickers;
    if (tickerKeys.includes(selectedLedgerTicker)) return [selectedLedgerTicker];
    return tickerKeys;
  }, [activeLedgerTickers, closedLedgerTickers, selectedLedgerTicker, tickerKeys]);
  const ledgerTickerOptions = useMemo(() => {
    const stockOptions = [
      ...activeLedgerTickers.map((ticker) => ({ value: ticker, label: ticker, detail: "Active position" })),
      ...closedLedgerTickers.map((ticker) => ({ value: ticker, label: ticker, detail: "Closed position" }))
    ];
    return [
      { value: "all", label: "All stocks", detail: `${tickerKeys.length} lifetime P&L lines` },
      { value: "active", label: "Active positions", detail: `${activeLedgerTickers.length} currently held` },
      { value: "closed", label: "Closed positions", detail: `${closedLedgerTickers.length} no longer held` },
      ...stockOptions
    ];
  }, [activeLedgerTickers, closedLedgerTickers, tickerKeys.length]);
  const dcaTickerOptions = useMemo(
    () => [
      ...activeLedgerTickers.map((ticker) => ({ value: ticker, label: ticker, detail: "Active position" })),
      ...closedLedgerTickers.map((ticker) => ({ value: ticker, label: ticker, detail: "Closed position" }))
    ],
    [activeLedgerTickers, closedLedgerTickers]
  );
  const activeDcaTicker = dcaTickerOptions.some((option) => option.value === selectedDcaTicker)
    ? selectedDcaTicker
    : dcaTickerOptions[0]?.value || "";
  const dcaChartData = activeDcaTicker ? analytics.stockDcaSeries?.[activeDcaTicker] || [] : [];
  const latestDcaPoint = [...dcaChartData].reverse().find((point) => point.averageCost || point.marketPrice) || null;
  const isSingleLedgerTicker = tickerKeys.includes(selectedLedgerTicker);
  const ledgerChartData = useMemo(() => {
    if (!isSingleLedgerTicker) return analytics.stockTraceSeries;
    const startIndex = analytics.stockTraceSeries.findIndex((point) => Number.isFinite(Number(point[selectedLedgerTicker])));
    return startIndex >= 0 ? analytics.stockTraceSeries.slice(startIndex) : [];
  }, [analytics.stockTraceSeries, isSingleLedgerTicker, selectedLedgerTicker]);
  const ledgerChartTicks = useMemo(
    () => (isSingleLedgerTicker ? buildChartDateTicks(ledgerChartData, 7) : undefined),
    [isSingleLedgerTicker, ledgerChartData]
  );
  const dcaChartTicks = useMemo(() => buildChartDateTicks(dcaChartData, 8), [dcaChartData]);
  const showLedgerPointMarkers = isSingleLedgerTicker && ledgerChartData.length <= 32;
  const showDcaPointMarkers = dcaChartData.length <= 32;

  useEffect(() => {
    if (ledgerTickerOptions.some((option) => option.value === selectedLedgerTicker)) return;
    setSelectedLedgerTicker("all");
  }, [ledgerTickerOptions, selectedLedgerTicker]);

  useEffect(() => {
    if (!dcaTickerOptions.length || dcaTickerOptions.some((option) => option.value === selectedDcaTicker)) return;
    setSelectedDcaTicker(dcaTickerOptions[0].value);
  }, [dcaTickerOptions, selectedDcaTicker]);

  return (
    <main className="app-shell">
      <nav className="app-tabs" aria-label="Application sections">
        <button
          className={activeTab === "stocks" ? "active" : ""}
          onClick={() => setActiveTab("stocks")}
          type="button"
        >
          <TrendingUp size={18} />
          Stocks
        </button>
        <button
          className={activeTab === "market-pulse" ? "active" : ""}
          onClick={() => setActiveTab("market-pulse")}
          type="button"
        >
          <ChartColumn size={18} />
          Market Pulse
        </button>
        <button
          className={activeTab === "banking" ? "active" : ""}
          onClick={() => setActiveTab("banking")}
          type="button"
        >
          <Wallet size={18} />
          Banking
        </button>
        <button
          className={activeTab === "media-pipeline" ? "active" : ""}
          onClick={() => setActiveTab("media-pipeline")}
          type="button"
        >
          <FolderOpen size={18} />
          Media Pipeline
        </button>
      </nav>

      {activeTab === "stocks" ? (
        <>
      <header className="topbar">
        <div>
          <p className="eyebrow">Desktop Ledger</p>
          <h1>Portfolio Tracker</h1>
        </div>
        <div className="top-actions">
          <div className="segmented" aria-label="Display currency">
            {["EUR", "USD"].map((currency) => (
              <button
                className={displayCurrency === currency ? "active" : ""}
                key={currency}
                onClick={() => setDisplayCurrency(currency)}
                type="button"
              >
                {currency}
              </button>
            ))}
          </div>
          <IconButton
            icon={isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
            label={isDarkMode ? "Light Mode" : "Dark Mode"}
            onClick={handleToggleTheme}
          />
          <IconButton icon={<Upload size={18} />} label="Import CSV" onClick={handleImport} disabled={isBusy} />
          <IconButton icon={<RefreshCw size={18} />} label="Refresh" onClick={handleRefresh} disabled={isBusy} />
          <IconButton icon={<FolderOpen size={18} />} label="Folder" onClick={handleOpenFolder} />
        </div>
      </header>

      <section className="status-strip">
        <span>{status}</span>
        <span>{portfolio.dataDir}</span>
      </section>

      <section className="summary-grid">
        <Metric title="Market Value" value={formatCurrency(analytics.summary.marketValue, displayCurrency)} />
        <Metric title="Net Hard Money" value={formatCurrency(analytics.summary.netInvested, displayCurrency)} />
        <Metric title="Profit" value={formatCurrency(analytics.summary.profit, displayCurrency)} tone={analytics.summary.profit >= 0 ? "good" : "bad"} />
        <ReturnMetric cumulative={portfolioReturns.cumulative} annualized={portfolioReturns.annualized} />
        <Metric title="Open Stocks" value={analytics.summary.openPositions} />
      </section>

      <section className="intel-panel">
        <div className="intel-header">
          <PanelTitle icon={<Sparkles size={18} />} title="Open Stock Intelligence" />
          <div className="intel-actions">
            <span>
              {stockIntel?.asOf
                ? `${stockIntel.engine} - next ${stockIntel.lookAheadMonths} months through ${stockIntel.lookAheadEndDate}`
                : "Gemini AI catalyst scan for the next six months"}
            </span>

            <IconButton icon={<Key size={18} />} label="Settings" onClick={() => setShowSettings(true)} />
            <IconButton icon={<RefreshCw size={18} />} label="Refresh Intel" onClick={handleStockIntel} disabled={isIntelBusy || isBusy} />
          </div>
        </div>
        {stockIntel?.items?.length ? (
          <div className="intel-grid">
            {stockIntel.items.map((item) => (
              <StockIntelCard item={item} key={item.ticker} />
            ))}
          </div>
        ) : (
          <div className="intel-empty">
            <span>Refresh to scan high-impact catalysts, fresh company news, and scheduled dates for your open stocks.</span>
          </div>
        )}

        {showSettings && (
          <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Intelligence Settings</h3>
                <button className="modal-close" onClick={() => setShowSettings(false)} type="button">
                  <X size={18} />
                </button>
              </div>
              <div className="modal-field">
                <span>Gemini API Keys (Up to 5)</span>
                {geminiApiKeys.map((apiKey, index) => {
                  const isVisible = visibleGeminiApiKeys[index];
                  return (
                    <div
                      key={`gemini-api-key-${index}`}
                      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 42px", gap: "8px", alignItems: "center" }}
                    >
                      <input
                        aria-label={`Gemini API key ${index + 1}`}
                        autoComplete="off"
                        placeholder={`Gemini API key ${index + 1}`}
                        spellCheck={false}
                        type={isVisible ? "text" : "password"}
                        value={apiKey}
                        onChange={(e) => handleGeminiKeyChange(index, e.target.value)}
                      />
                      <button
                        aria-label={`${isVisible ? "Hide" : "Show"} Gemini API key ${index + 1}`}
                        className="icon-button"
                        onClick={() => toggleGeminiKeyVisibility(index)}
                        style={{ minWidth: "42px", padding: 0 }}
                        title={`${isVisible ? "Hide" : "Show"} Gemini API key ${index + 1}`}
                        type="button"
                      >
                        {isVisible ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                    </div>
                  );
                })}
                <small>Get a free key at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a></small>
              </div>
              <label className="modal-field">
                <span>Gemini Model {isLoadingModels && "(Loading...)"}</span>
                <select value={geminiModel} onChange={(e) => setGeminiModel(e.target.value)}>
                  {availableModels.length > 0 ? (
                    availableModels.map((m) => (
                      <option key={m.id} value={m.id} title={m.description}>
                        {m.displayName}
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                      <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                      <option value="gemini-2.0-flash">Gemini 2.0 Flash</option>
                      <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                      <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                    </>
                  )}
                </select>
                {availableModels.length === 0 && <small>Enter a valid API key to fetch live models.</small>}
              </label>
              <div className="modal-field">
                <span>Optional FMP API Key</span>
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 42px", gap: "8px", alignItems: "center" }}>
                  <input
                    aria-label="Optional Financial Modeling Prep API key"
                    autoComplete="off"
                    placeholder="Optional paid screener fallback"
                    spellCheck={false}
                    type={visibleFmpApiKey ? "text" : "password"}
                    value={fmpApiKey}
                    onChange={(event) => setFmpApiKey(event.target.value)}
                  />
                  <button
                    aria-label={`${visibleFmpApiKey ? "Hide" : "Show"} FMP API key`}
                    className="icon-button"
                    onClick={() => setVisibleFmpApiKey((current) => !current)}
                    style={{ minWidth: "42px", padding: 0 }}
                    title={`${visibleFmpApiKey ? "Hide" : "Show"} FMP API key`}
                    type="button"
                  >
                    {visibleFmpApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <small>Market Radar uses Yahoo by default; FMP is only a paid fallback.</small>
              </div>
              <button className="primary-action" onClick={handleSaveSettings} type="button">
                <Save size={18} />
                Save Settings
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="workspace-grid">
        <div className="chart-panel wide">
          <PanelTitle icon={<Database size={18} />} title="Hard Money vs Portfolio" />
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={analytics.portfolioSeries} margin={{ top: 14, right: 42, left: 12, bottom: 4 }}>
                <defs>
                  <linearGradient id="marketFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0f766e" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#0f766e" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#e3e7ed" vertical={false} />
                <XAxis dataKey="date" minTickGap={32} padding={{ left: 10, right: 18 }} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(value) => compactMoney(value, displayCurrency)} tickLine={false} axisLine={false} width={72} />
                <Tooltip formatter={(value) => formatCurrency(value, displayCurrency)} labelFormatter={(label) => `Date ${label}`} />
                <Legend iconType="plainline" verticalAlign="bottom" height={28} />
                <Area type="monotone" dataKey="marketValue" name="Portfolio value" stroke="#0f766e" fill="url(#marketFill)" strokeWidth={2.5} />
                <Line type="monotone" dataKey="netInvested" name="Net hard money" stroke="#374151" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="chart-panel">
          <PanelTitle icon={<TrendingUp size={18} />} title="Portfolio Returns" />
          <div className="chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analytics.profitSeries} margin={{ top: 14, right: 42, left: 12, bottom: 4 }}>
                <CartesianGrid stroke="#e3e7ed" vertical={false} />
                <XAxis dataKey="date" minTickGap={28} padding={{ left: 10, right: 18 }} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(value) => `${value}%`} tickLine={false} axisLine={false} width={52} />
                <Tooltip formatter={(value) => formatPercent(value)} labelFormatter={(label) => `Date ${label}`} />
                <Legend iconType="plainline" verticalAlign="bottom" height={28} />
                <ReferenceLine y={0} stroke="#97a3b3" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="cumulativeReturn" name="Cumulative return" stroke="#14b8a6" strokeWidth={2.8} dot={false} />
                <Line type="monotone" dataKey="profitRatio" name="Simple ROI" stroke="#2563eb" strokeWidth={2.2} strokeDasharray="6 4" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="chart-panel stock-analysis-panel">
          <div className="stock-analysis-header">
            <div className="stock-analysis-heading">
              <span className="stock-analysis-heading-icon"><TrendingUp size={18} /></span>
              <div>
                <h2>Stock performance</h2>
                <p>Lifetime profit and cost-basis tracking</p>
              </div>
            </div>
            <div className="stock-analysis-toolbar">
              <div className="segmented stock-analysis-tabs" aria-label="Stock analysis view" role="tablist">
                <button
                  aria-selected={stockAnalysisView === "profit"}
                  className={stockAnalysisView === "profit" ? "active" : ""}
                  onClick={() => setStockAnalysisView("profit")}
                  role="tab"
                  type="button"
                >
                  <TrendingUp size={15} />
                  Profit
                </button>
                <button
                  aria-selected={stockAnalysisView === "dca"}
                  className={stockAnalysisView === "dca" ? "active" : ""}
                  onClick={() => setStockAnalysisView("dca")}
                  role="tab"
                  type="button"
                >
                  <ChartColumn size={15} />
                  DCA
                </button>
              </div>
              <div className="stock-analysis-picker-wrap">
                <span>{stockAnalysisView === "profit" ? "Display" : "Position"}</span>
                {stockAnalysisView === "profit" ? (
                  <FancySelect
                    ariaLabel="Stock profit ledger line filter"
                    className="stock-analysis-picker"
                    onChange={setSelectedLedgerTicker}
                    options={ledgerTickerOptions}
                    value={selectedLedgerTicker}
                  />
                ) : (
                  <FancySelect
                    ariaLabel="DCA stock filter"
                    className="stock-analysis-picker"
                    onChange={setSelectedDcaTicker}
                    options={dcaTickerOptions}
                    value={activeDcaTicker}
                  />
                )}
              </div>
            </div>
          </div>
          {stockAnalysisView === "profit" ? (
            <div className="stock-analysis-view" onMouseLeave={() => setHoveredLedgerTicker("")}>
              <div className="stock-analysis-subheader">
                <div>
                  <strong>{isSingleLedgerTicker ? `${selectedLedgerTicker} lifetime P&L` : "Lifetime P&L by ticker"}</strong>
                  <span>
                    {isSingleLedgerTicker
                      ? `${ledgerChartData.length} market sessions since first trade`
                      : `${activeLedgerTickers.length} active · ${closedLedgerTickers.length} closed`}
                  </span>
                </div>
                <em>Value + sales − purchases</em>
              </div>
              <div className="stock-analysis-chart-box">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={ledgerChartData}
                    margin={{ top: 14, right: 24, left: 4, bottom: 0 }}
                    onMouseLeave={() => setHoveredLedgerTicker("")}
                  >
                    <CartesianGrid stroke="#e3e7ed" vertical={isSingleLedgerTicker} />
                    <XAxis
                      dataKey="date"
                      interval={isSingleLedgerTicker ? 0 : "preserveStartEnd"}
                      minTickGap={28}
                      tickFormatter={isSingleLedgerTicker ? formatCompactChartDate : undefined}
                      ticks={ledgerChartTicks}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis tickFormatter={(value) => compactMoney(value, displayCurrency)} tickLine={false} axisLine={false} width={72} />
                    <Tooltip
                      cursor={{ stroke: "#64748b", strokeDasharray: "3 4", strokeWidth: 1 }}
                      content={(props) => (
                        <StockLedgerTooltip
                          {...props}
                          colors={analytics.colors}
                          currency={displayCurrency}
                          focusedTicker={hoveredLedgerTicker}
                        />
                      )}
                    />
                    <ReferenceLine y={0} stroke="#97a3b3" strokeDasharray="4 4" />
                    {visibleLedgerTickers.map((ticker) => {
                      const isActiveTicker = activeLedgerTickerSet.has(ticker);
                      const isHovered = hoveredLedgerTicker === ticker;
                      const isDimmed = Boolean(hoveredLedgerTicker) && !isHovered && visibleLedgerTickers.length > 1;
                      const stroke = isDimmed
                        ? DIMMED_LEDGER_STROKE
                        : isActiveTicker
                          ? analytics.colors[ticker]
                          : CLOSED_LEDGER_STROKE;
                      return (
                        <Line
                          activeDot={isHovered ? { r: 5, strokeWidth: 0 } : false}
                          connectNulls
                          dataKey={ticker}
                          dot={showLedgerPointMarkers ? { r: 2.4, strokeWidth: 1.5, fill: "var(--chart-point-fill)" } : false}
                          isAnimationActive={false}
                          key={ticker}
                          name={ticker}
                          stroke={stroke}
                          strokeOpacity={isDimmed ? 0.2 : isActiveTicker ? 0.96 : 0.46}
                          strokeWidth={isHovered ? 3.4 : isActiveTicker ? 2.35 : 1.8}
                          type={isSingleLedgerTicker ? "linear" : "monotone"}
                        />
                      );
                    })}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {visibleLedgerTickers.length > 1 && (
                <div className="stock-ledger-chip-row" aria-label="Focus stock profit line">
                  {visibleLedgerTickers.map((ticker) => {
                    const isActiveTicker = activeLedgerTickerSet.has(ticker);
                    const color = isActiveTicker ? analytics.colors[ticker] : CLOSED_LEDGER_STROKE;
                    const isFocused = hoveredLedgerTicker === ticker;
                    return (
                      <button
                        className={`stock-ledger-chip${isFocused ? " focused" : ""}${isActiveTicker ? "" : " closed"}`}
                        key={ticker}
                        onBlur={() => setHoveredLedgerTicker("")}
                        onClick={() => setSelectedLedgerTicker(ticker)}
                        onFocus={() => setHoveredLedgerTicker(ticker)}
                        onMouseEnter={() => setHoveredLedgerTicker(ticker)}
                        onMouseLeave={() => setHoveredLedgerTicker("")}
                        style={{ "--chip-color": color }}
                        title={`Focus ${ticker}`}
                        type="button"
                      >
                        <span />
                        {ticker}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="stock-analysis-view">
              <div className="stock-analysis-subheader dca-analysis-subheader">
                <div>
                  <strong>{activeDcaTicker || "Cost basis"}</strong>
                  <span>
                    {latestDcaPoint
                      ? `${dcaChartData.length} daily closes since first trade`
                      : "Choose a stock"}
                  </span>
                </div>
                <em>Price, average cost and return</em>
              </div>
              {latestDcaPoint && (
                <div className="dca-metric-strip">
                  <div>
                    <span>Shares</span>
                    <strong>{latestDcaPoint.shares}</strong>
                  </div>
                  <div>
                    <span>Market price</span>
                    <strong>{formatNullableCurrency(latestDcaPoint.marketPrice, displayCurrency)}</strong>
                  </div>
                  <div>
                    <span>Average cost</span>
                    <strong>{formatNullableCurrency(latestDcaPoint.averageCost, displayCurrency)}</strong>
                  </div>
                  <div className={latestDcaPoint.returnRatio >= 0 ? "good" : "bad"}>
                    <span>Return</span>
                    <strong>{formatNullablePercent(latestDcaPoint.returnRatio)}</strong>
                  </div>
                </div>
              )}
              <div className="stock-analysis-chart-box dca-chart-box">
                {dcaChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={dcaChartData} margin={{ top: 14, right: 18, left: 4, bottom: 0 }}>
                      <CartesianGrid stroke="#e3e7ed" vertical />
                      <XAxis
                        dataKey="date"
                        interval={0}
                        minTickGap={16}
                        tickFormatter={formatCompactChartDate}
                        ticks={dcaChartTicks}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis yAxisId="price" tickFormatter={(value) => compactMoney(value, displayCurrency)} tickLine={false} axisLine={false} width={72} />
                      <YAxis yAxisId="return" orientation="right" tickFormatter={(value) => `${value}%`} tickLine={false} axisLine={false} width={52} />
                      <Tooltip formatter={(value, name) => formatDcaTooltipValue(value, name, displayCurrency)} labelFormatter={(label) => `Date ${label}`} />
                      <Legend iconType="plainline" verticalAlign="bottom" height={28} />
                      <ReferenceLine yAxisId="return" y={0} stroke="#97a3b3" strokeDasharray="4 4" />
                      <Line yAxisId="price" connectNulls dataKey="marketPrice" dot={showDcaPointMarkers ? { r: 2.5, strokeWidth: 1.5, fill: "var(--chart-point-fill)" } : false} name="Market price" stroke="#2563eb" strokeWidth={2.6} type="linear" />
                      <Line yAxisId="price" connectNulls dataKey="averageCost" dot={showDcaPointMarkers ? { r: 2, strokeWidth: 1.5, fill: "var(--chart-point-fill)" } : false} name="Avg cost" stroke="#0f766e" strokeWidth={2.5} type="stepAfter" />
                      <Line yAxisId="return" connectNulls dataKey="returnRatio" dot={showDcaPointMarkers ? { r: 2.5, strokeWidth: 1.5, fill: "var(--chart-point-fill)" } : false} name="Return %" stroke="#ca8a04" strokeWidth={2.1} type="linear" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="watchlist-empty">No DCA data for this stock.</div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="yearly-grid">
        <div className="chart-panel">
          <PanelTitle icon={<TrendingUp size={18} />} title="Yearly Stock Profit" />
          <div className="yearly-chart-box">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={analytics.yearlyPerformance} margin={{ top: 14, right: 24, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="#e3e7ed" vertical={false} />
                <XAxis dataKey="year" tickLine={false} axisLine={false} />
                <YAxis yAxisId="profit" tickFormatter={(value) => compactMoney(value, displayCurrency)} tickLine={false} axisLine={false} width={72} />
                <YAxis
                  yAxisId="compound"
                  orientation="right"
                  tickFormatter={(value) => `${value}%`}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                />
                <Tooltip
                  formatter={(value, name) => (name === "Cumulative return" ? formatPercent(value) : formatYearlyCurrency(value, displayCurrency))}
                  labelFormatter={(_label, payload) => {
                    const row = payload?.[0]?.payload;
                    return row ? `${row.year} - ${row.startDate} to ${row.endDate}` : "";
                  }}
                />
                <Legend iconType="plainline" verticalAlign="bottom" height={28} />
                <ReferenceLine yAxisId="profit" y={0} stroke="#97a3b3" strokeDasharray="4 4" />
                <Bar yAxisId="profit" dataKey="profit" name="Stock profit" radius={[5, 5, 0, 0]}>
                  {analytics.yearlyPerformance.map((year) => (
                    <Cell fill={year.profit >= 0 ? "#0f766e" : "#dc2626"} key={year.year} />
                  ))}
                </Bar>
                <Line
                  yAxisId="compound"
                  type="monotone"
                  dataKey="cumulativeReturn"
                  name="Cumulative return"
                  stroke="#2563eb"
                  strokeWidth={2.5}
                  dot={{ r: 4 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="table-panel yearly-table-panel">
          <PanelTitle icon={<Database size={18} />} title="Yearly Stock Summary" />
          <div className="table-wrap yearly-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Opening value</th>
                  <th>Purchases</th>
                  <th>Sales</th>
                  <th>Ending value</th>
                  <th>Period profit</th>
                  <th>Period return</th>
                  <th>Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {analytics.yearlyPerformance.map((year) => (
                  <tr key={year.year}>
                    <td data-label="Period">
                      <span className="period-name">{year.year}</span>
                      <span className="subtle-cell">
                        {year.startDate} to {year.endDate}
                        {!year.isComplete ? " - running" : ""}
                      </span>
                    </td>
                    <td data-label="Opening value">{formatYearlyCurrency(year.openingValue, displayCurrency)}</td>
                    <td data-label="Purchases">{formatYearlyCurrency(year.cashAdded, displayCurrency)}</td>
                    <td data-label="Sales">{formatYearlyCurrency(year.cashOut, displayCurrency)}</td>
                    <td data-label="Ending value">{formatYearlyCurrency(year.endingValue, displayCurrency)}</td>
                    <td className={year.profit >= 0 ? "number-good" : "number-bad"} data-label="Period profit">
                      {formatYearlyCurrency(year.profit, displayCurrency)}
                    </td>
                    <td className={year.returnRatio >= 0 ? "number-good" : "number-bad"} data-label="Period return">
                      {formatPercent(year.returnRatio)}
                    </td>
                    <td className={year.cumulativeReturn >= 0 ? "number-good" : "number-bad"} data-label="Cumulative">
                      {formatPercent(year.cumulativeReturn)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="yearly-method-note">
            Profit = ending value + sales - opening value - purchases. Period return uses Modified Dietz to account for when purchases and sales occurred; cumulative return links each period.
          </p>
        </div>
      </section>

      <section className="lower-grid trading-workspace">
        <form className="trade-form trade-entry-panel" onSubmit={handleSaveTrade}>
          <PanelTitle icon={<Plus size={18} />} title="Record Trade" />
          <div className="trade-form-grid">
            <label>
              Date
              <input value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} type="date" required />
            </label>
            <label>
              Ticker
              <input value={form.ticker} onChange={(event) => setForm({ ...form, ticker: normalizeTickerSymbol(event.target.value) })} placeholder="MSFT" required />
            </label>
            <label>
              Action
              <select value={form.action} onChange={(event) => setForm({ ...form, action: event.target.value })}>
                <option>BUY</option>
                <option>SELL</option>
              </select>
            </label>
            <label>
              Shares
              <input value={form.shares} onChange={(event) => setForm({ ...form, shares: event.target.value })} type="number" min="0" step="0.000001" required />
            </label>
            <label>
              Total Amount
              <input value={form.total_amount} onChange={(event) => setForm({ ...form, total_amount: event.target.value })} type="number" min="0" step="0.01" required />
            </label>
            <label>
              Currency
              <select value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value })}>
                <option>EUR</option>
                <option>USD</option>
              </select>
            </label>
          </div>
          <button className="primary-action" disabled={isBusy} type="submit">
            <Save size={18} />
            Save Trade
          </button>
        </form>

        <div className="trade-tables-stack">
          <div className="table-panel positions-panel">
            <div className="panel-heading-row">
              <PanelTitle icon={<Database size={18} />} title="Open Positions" />
              <span>{analytics.holdings.length} active</span>
            </div>
            <div className="table-wrap compact positions-table">
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Shares</th>
                    <th>Price</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.holdings.length > 0 ? (
                    analytics.holdings.map((holding) => (
                      <tr key={holding.ticker}>
                        <td>
                          <button className="ticker-link-button" onClick={() => handleWatchTicker(holding.ticker)} type="button">
                            {holding.ticker}
                          </button>
                        </td>
                        <td>{holding.shares}</td>
                        <td>{formatCurrency(holding.price, displayCurrency)}</td>
                        <td>{formatCurrency(holding.value, displayCurrency)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="4">No open positions.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="table-panel trades ledger-panel">
            <div className="panel-heading-row">
              <PanelTitle icon={<Database size={18} />} title="Trade Ledger" />
              <span>{visibleTrades.length} trades</span>
            </div>
            <div className="table-wrap ledger-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Ticker</th>
                    <th>Action</th>
                    <th>Shares</th>
                    <th>Total</th>
                    <th>Currency</th>
                    <th>Delete</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTrades.length > 0 ? (
                    visibleTrades.map((trade, index) => (
                      <tr key={`${trade.date}-${trade.ticker}-${trade.action}-${index}`}>
                        <td>{trade.date}</td>
                        <td>{trade.ticker}</td>
                        <td>
                          <span className={`pill ${trade.action.toLowerCase()}`}>{trade.action}</span>
                        </td>
                        <td>{trade.shares}</td>
                        <td>{formatCurrency(trade.total_amount, trade.currency)}</td>
                        <td>{trade.currency}</td>
                        <td>
                          <button
                            aria-label={`Delete ${trade.action} ${trade.ticker} trade from ${trade.date}`}
                            className="ledger-delete-button"
                            disabled={isBusy}
                            onClick={() => handleDeleteTrade(trade)}
                            title="Delete trade"
                            type="button"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="7">No trades recorded.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section className="watchlist-panel underdog-engine-panel discovery-workspace-panel">
        <div className="watchlist-header">
          <div>
            <PanelTitle icon={<TrendingUp size={18} />} title="Watchlist Analyzer" />
            <span className="section-kicker">Fundamental scanner, price history & growth allocation</span>
          </div>
          <div className="watchlist-actions">
            <form className="watchlist-add-form" onSubmit={handleAddWatchTicker}>
              <input
                aria-label="Watchlist ticker"
                value={watchTickerInput}
                onChange={(event) => setWatchTickerInput(normalizeTickerSymbol(event.target.value))}
                placeholder="TSLA"
              />
              <button className="primary-action" disabled={isBusy} type="submit">
                <Plus size={18} />
                Add
              </button>
            </form>
            <IconButton icon={<RefreshCw size={18} />} label="Refresh Scanner" onClick={handleRefresh} disabled={isBusy} />
          </div>
        </div>

        <div className="scanner-summary-grid">
          <div>
            <span>Scanned</span>
            <strong>{discoverySummary.scannedCount}/{watchlistItems.length}</strong>
          </div>
          <div>
            <span>Rockets</span>
            <strong>{discoverySummary.rocketCount}</strong>
          </div>
          <div>
            <span>Wide-moat</span>
            <strong>{discoverySummary.wideMoatCount}</strong>
          </div>
        </div>

        <div className="watchlist-content">
          <div className="watchlist-rail" role="listbox" aria-label="Rocket and underdog watchlist">
            {watchlistItems.length > 0 ? (
              watchlistItems.map((item) => {
                const metrics = item.scanner?.metrics || {};
                const rocketProfile = item.scanner?.profiles?.rocket;
                const wideMoatProfile = item.scanner?.profiles?.wideMoat;
                return (
                  <article className={`watchlist-row${activeWatchTicker === item.ticker ? " active" : ""}`} key={item.ticker}>
                    <button
                      aria-selected={activeWatchTicker === item.ticker}
                      className="watch-select-button"
                      onClick={() => setSelectedWatchTicker(item.ticker)}
                      role="option"
                      type="button"
                    >
                      <span className="watch-title-stack">
                        <strong>{item.ticker}</strong>
                        {item.holding && <small>{formatCurrency(item.holding.value, displayCurrency)} held</small>}
                      </span>
                      <span className="watch-price-stack">
                        <em>{item.latestPrice == null ? "--" : formatCurrency(item.latestPrice, item.currency)}</em>
                        <small className={getChangeTone(item.changePercent)}>{formatSignedPercent(item.changePercent)}</small>
                      </span>
                    </button>

                    <div className="watch-scanner-body">
                      <div className="scanner-badges">
                        {item.tags.length > 0 ? (
                          item.tags.map((tag) => (
                            <span className={`scanner-badge ${getScannerTagClass(tag.key)}`} key={tag.key}>
                              {tag.label}
                            </span>
                          ))
                        ) : (
                          <span className="scanner-badge neutral">{item.scanner ? "SCANNED" : "PENDING SCAN"}</span>
                        )}
                      </div>
                      <div className="scanner-metric-grid">
                        <span>Drawdown <strong>{formatMetricValue(metrics.drawdownFromHighPct, "percent")}</strong></span>
                        <span>Growth <strong>{formatMetricValue(metrics.growthPct, "percent")}</strong></span>
                        <span>Current <strong>{formatMetricValue(metrics.currentRatio, "ratio")}</strong></span>
                        <span>Margin <strong>{formatMetricValue(metrics.marginPct, "percent")}</strong></span>
                        <span>ROE/ROIC <strong>{formatMetricValue(metrics.returnQualityPct, "percent")}</strong></span>
                        <span>P/E <strong>{formatMetricValue(metrics.peRatio, "ratio")}</strong></span>
                      </div>
                      <div className="scanner-score-row">
                        <span>Rocket {getProfileScore(rocketProfile)}</span>
                        <span>Wide-moat {getProfileScore(wideMoatProfile)}</span>
                      </div>
                    </div>

                    <div className="watch-row-actions">
                      <button className="view-chart-button" onClick={() => setSelectedWatchTicker(item.ticker)} type="button">
                        View Full Chart
                      </button>
                      <button className="watch-remove-button" onClick={() => handleRemoveWatchTicker(item.ticker)} title={`Remove ${item.ticker}`} type="button">
                        <X size={15} />
                      </button>
                    </div>
                  </article>
                );
              })
            ) : (
              <div className="watchlist-empty">No watchlist tickers yet.</div>
            )}
          </div>

          <div className="watch-chart-panel full-watch-chart-panel">
            <div className="watch-chart-heading">
              <div>
                <span>{activeWatchTicker || "Full Chart"}</span>
                <strong>
                  {activeWatchItem?.latestPrice == null
                    ? "No price loaded"
                    : formatCurrency(activeWatchItem.latestPrice, activeWatchItem.currency)}
                </strong>
              </div>
              <div className="watch-chart-controls">
                <em className={getChangeTone(activeWatchItem?.changePercent)}>
                  {formatSignedPercent(activeWatchItem?.changePercent)}
                </em>
                <div className="segmented watch-timeframe-tabs" aria-label="Watchlist chart timeframe">
                  {WATCH_TIMEFRAME_OPTIONS.map((option) => (
                    <button
                      className={watchTimeframe === option.value ? "active" : ""}
                      key={option.value}
                      onClick={() => setWatchTimeframe(option.value)}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="watch-chart-box">
              {watchChartData.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={watchChartData} margin={{ top: 14, right: 24, left: 8, bottom: 0 }}>
                    <defs>
                      <linearGradient id="watchPriceFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#2563eb" stopOpacity={0.22} />
                        <stop offset="95%" stopColor="#2563eb" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e3e7ed" vertical={false} />
                    <XAxis dataKey="date" minTickGap={36} tickLine={false} axisLine={false} />
                    <YAxis tickFormatter={(value) => compactMoney(value, activeWatchItem?.currency || displayCurrency)} tickLine={false} axisLine={false} width={72} />
                    <Tooltip
                      formatter={(value) => formatCurrency(value, activeWatchItem?.currency || displayCurrency)}
                      labelFormatter={(label) => `Date ${label}`}
                    />
                    <Area type="monotone" dataKey="price" name={`${activeWatchTicker} price`} stroke="#2563eb" fill="url(#watchPriceFill)" strokeWidth={2.4} dot={watchChartData.length < 8 ? { r: 3 } : false} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="watchlist-empty">
                  {activeWatchTicker ? "No chart data loaded." : "No chart selected."}
                </div>
              )}
            </div>
          </div>
        </div>

        <GrowthRebalancePanel colors={analytics.colors} rebalance={analytics.growthRebalance} />
      </section>
        </>
      ) : activeTab === "banking" ? (
        <BankingDashboard isDarkMode={isDarkMode} onToggleTheme={handleToggleTheme} />
      ) : activeTab === "media-pipeline" ? (
        <MediaPipelineDashboard isDarkMode={isDarkMode} onToggleTheme={handleToggleTheme} />
      ) : (
        <MarketPulseDashboard isDarkMode={isDarkMode} onToggleTheme={handleToggleTheme} />
      )}
    </main>
  );
}

function GrowthRebalancePanel({ colors = {}, rebalance }) {
  const assets = rebalance?.assets || [];
  const rollingVolatility = rebalance?.rollingVolatility || [];
  const portfolio = rebalance?.portfolio || {};
  const currency = rebalance?.currency || "EUR";
  const warnings = rebalance?.warnings || [];
  const allocationRows = [...assets].sort((left, right) => right.weight - left.weight);
  const volatilityTickers = assets
    .map((asset) => asset.ticker)
    .filter((ticker) => rollingVolatility.some((point) => Number.isFinite(point[ticker])));

  return (
    <div className="growth-rebalance-panel">
      <div className="panel-heading-row rebalance-heading">
        <div>
          <PanelTitle icon={<ChartColumn size={18} />} title="Risk-Controlled Growth Allocation" />
          <span className="section-kicker">Robust estimates · {formatRatioAsPercent(rebalance?.maximumWeight, 0)} position cap · {currency}-normalised</span>
        </div>
        <span>{assets.length ? `${assets.length} active holdings` : "No active holdings"}</span>
      </div>

      <div className="rebalance-summary-grid">
        <div>
          <span>Robust return estimate</span>
          <strong>{formatRatioAsPercent(portfolio.expectedReturn)}</strong>
        </div>
        <div>
          <span>Estimated volatility</span>
          <strong>{formatRatioAsPercent(portfolio.volatility)}</strong>
        </div>
        <div>
          <span>Sharpe estimate</span>
          <strong>{formatSharpe(portfolio.sharpeRatio)}</strong>
        </div>
        <div>
          <span>Suggested turnover</span>
          <strong>{formatRatioAsPercent(rebalance?.turnover)}</strong>
        </div>
      </div>

      <div className="rebalance-model-strip">
        <span className={`rebalance-confidence ${rebalance?.confidence || "insufficient"}`}>
          <ShieldCheck size={15} />
          {rebalance?.confidence || "insufficient"} confidence
        </span>
        <span>{rebalance?.lookbackDays || 0}-day robust lookback</span>
        <span>Common data through {rebalance?.asOf || "--"}</span>
        <span>Model rate {formatRatioAsPercent(rebalance?.riskFreeRate, 2)}</span>
        <span>Trade only beyond {formatRatioAsPercent(rebalance?.rebalanceThreshold, 0)} drift</span>
      </div>

      <div className="rebalance-content-grid">
        <div className="rebalance-chart-panel">
          <div className="rebalance-subheading">
            <strong>30-Day Annualized Volatility</strong>
            <span>Observed risk · not a forecast</span>
          </div>
          <div className="rebalance-chart-box">
            {rollingVolatility.length > 0 && volatilityTickers.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rollingVolatility} margin={{ top: 14, right: 24, left: 4, bottom: 0 }}>
                  <CartesianGrid stroke="#e3e7ed" vertical={false} />
                  <XAxis dataKey="date" minTickGap={32} tickLine={false} axisLine={false} />
                  <YAxis tickFormatter={(value) => formatRatioAsPercent(value, 0)} tickLine={false} axisLine={false} width={58} />
                  <Tooltip formatter={(value) => formatRatioAsPercent(value, 2)} labelFormatter={(label) => `Date ${label}`} />
                  <Legend iconType="plainline" verticalAlign="bottom" height={28} />
                  {volatilityTickers.map((ticker) => (
                    <Line
                      connectNulls
                      dataKey={ticker}
                      dot={false}
                      isAnimationActive={false}
                      key={ticker}
                      name={ticker}
                      stroke={colors[ticker] || "#0f766e"}
                      strokeWidth={2.2}
                      type="monotone"
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="rebalance-empty">Load at least 30 daily returns for active positions.</div>
            )}
          </div>
        </div>

        <div className="rebalance-allocation-panel">
          <div className="rebalance-subheading">
            <strong>Current → Strategic Target</strong>
            <span>{rebalance?.status || "empty"} · {rebalance?.optimizer === "robust-max-sharpe-risk-parity-blend" ? "robust blend" : rebalance?.optimizer}</span>
          </div>
          <div className="rebalance-weight-list">
            {allocationRows.length > 0 ? (
              allocationRows.map((asset) => (
                <div className="rebalance-weight-row" key={asset.ticker}>
                  <div className="rebalance-weight-main">
                    <div className="rebalance-asset-heading">
                      <strong>{asset.ticker}</strong>
                      <span className={`rebalance-action ${asset.action}`}>{asset.action}</span>
                    </div>
                    <span>
                      Current {formatRatioAsPercent(asset.currentWeight, 1)} → target {formatRatioAsPercent(asset.weight, 1)}
                    </span>
                    <small>
                      {asset.action === "hold"
                        ? `Within drift band · ${formatCurrency(asset.currentValue, currency)}`
                        : `${asset.tradeValue > 0 ? "Add" : "Trim"} ${formatCurrency(Math.abs(asset.tradeValue), currency)}`}
                      {` · return est. ${formatRatioAsPercent(asset.expectedReturn)} · vol ${formatRatioAsPercent(asset.volatility)}`}
                    </small>
                  </div>
                  <em>{formatRatioAsPercent(asset.weight, 1)}</em>
                  <div className="rebalance-weight-track" aria-hidden="true">
                    <span
                      style={{
                        "--weight-width": `${Math.max(asset.weight * 100, 0.8)}%`,
                        "--weight-color": colors[asset.ticker] || "#0f766e"
                      }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <div className="rebalance-empty">No active positions available.</div>
            )}
          </div>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="rebalance-warning-list">
          {warnings.map((warning) => <span key={warning}>{warning}</span>)}
        </div>
      )}
    </div>
  );
}

function BankingDashboard({ isDarkMode, onToggleTheme }) {
  const [bankingState, setBankingState] = useState(blankBankingState);
  const [config, setConfig] = useState(blankBankingConfig);
  const [balances, setBalances] = useState([]);
  const [balanceCache, setBalanceCache] = useState({});
  const [expenseSummary, setExpenseSummary] = useState(null);
  const [expenseCache, setExpenseCache] = useState({});
  const [cashFlowRange, setCashFlowRange] = useState("3m");
  const [cashFlowTrend, setCashFlowTrend] = useState(null);
  const [cashFlowAutoSync, setCashFlowAutoSync] = useState(false);
  const [selectedExpenseCategory, setSelectedExpenseCategory] = useState("");
  const [selectedExpenseMonthOffset, setSelectedExpenseMonthOffset] = useState(0);
  const [cashFlowView, setCashFlowView] = useState("expenses");
  const [aspspMatches, setAspspMatches] = useState([]);
  const [selectedAccountUid, setSelectedAccountUid] = useState("");
  const [status, setStatus] = useState("Banking connection ready");
  const [isBusy, setIsBusy] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const balanceInflightRef = useRef(new Set());
  const cashFlowInflightRef = useRef(new Set());
  const cashFlowAutoSyncAttemptRef = useRef("");
  const expenseInflightRef = useRef(new Set());
  const bankSyncInflightRef = useRef(false);

  const accounts = bankingState.connection?.accounts || [];
  const connected = Boolean(bankingState.connection?.sessionIdPresent);
  const privateKeyFileLoaded = Boolean(String(config.privateKeyContent || "").trim());
  const privateKeyStoredInSettings = Boolean(bankingState.privateKeyStoredInSettings);
  const selectedAccount = accounts.find((account) => account.uid === selectedAccountUid) || accounts[0];
  const preferredBalance = useMemo(() => {
    return (
      balances.find((balance) => ["CLAV", "CLBD", "ITAV", "ITBD"].includes(balance.balanceType)) ||
      balances[0] ||
      null
    );
  }, [balances]);
  const balanceCurrency = preferredBalance?.currency || selectedAccount?.currency || "EUR";
  const expenseCurrency = expenseSummary?.currency || balanceCurrency;
  const isIncomeView = cashFlowView === "income";
  const cashFlowLabel = isIncomeView ? "Income" : "Expenses";
  const cashFlowItemLabel = isIncomeView ? "income" : "spending";
  const flowCurrency = isIncomeView ? expenseSummary?.incomeCurrency || expenseCurrency : expenseCurrency;
  const flowCategories = isIncomeView ? expenseSummary?.incomeSources || [] : expenseSummary?.categories || [];
  const expenseMonthOptions = useMemo(() => getExpenseMonthOptions(), []);
  const selectedExpenseMonthOption = expenseMonthOptions.find((option) => option.value === selectedExpenseMonthOffset);
  const selectedExpenseMonthLabel = selectedExpenseMonthOption?.label || "Current month";
  const selectedExpenseMonthDisplay = selectedExpenseMonthOption?.detail || selectedExpenseMonthLabel;
  const selectedCashFlowRangeOption = CASH_FLOW_RANGE_OPTIONS.find((option) => option.value === cashFlowRange) || CASH_FLOW_RANGE_OPTIONS[1];
  const cashFlowTrendPoints = cashFlowTrend?.points || [];
  const cashFlowCurrency = cashFlowTrend?.currency || balanceCurrency;
  const cashFlowTotals = cashFlowTrend?.totals || { income: 0, expenses: 0, net: 0 };
  const cashFlowHistorySync = cashFlowTrend?.historySync || null;
  const cashFlowPointCount = cashFlowTrendPoints.length;
  const cashFlowTotalPointCount = cashFlowTrend?.totalPoints || cashFlowPointCount;
  const cashFlowAvailableLabel = cashFlowTrend
    ? cashFlowTrend.missingPoints > 0
      ? `${Number(cashFlowTrend.availablePoints || 0).toLocaleString()}/${Number(cashFlowTotalPointCount || 0).toLocaleString()} days`
      : `${Number(cashFlowTotalPointCount || 0).toLocaleString()} daily points`
    : "No trend loaded";
  const cashFlowSyncProgress = cashFlowHistorySync?.totalPoints
    ? Math.round(((cashFlowHistorySync.availablePoints || 0) / cashFlowHistorySync.totalPoints) * 100)
    : 0;
  const cashFlowHistoryCanResume = cashFlowRange === "5y" && isResumableCashFlowHistory(cashFlowHistorySync);
  const cashFlowActionLabel = cashFlowAutoSync
    ? "Pause History Sync"
    : cashFlowHistoryCanResume
      ? "Resume History Sync"
      : "Update Cash Flow";
  const maxFlowCategoryAmount = Math.max(...flowCategories.map((category) => category.amount), 0);
  const expenseCategoryOptions = expenseSummary?.categoryOptions || DEFAULT_EXPENSE_CATEGORIES;
  const selectedCategoryTotal = selectedExpenseCategory
    ? flowCategories.find((category) => category.category === selectedExpenseCategory)
    : null;
  const visibleCashFlowItems = useMemo(() => {
    const items = isIncomeView ? expenseSummary?.income || [] : expenseSummary?.expenses || [];
    return selectedExpenseCategory
      ? items.filter((item) => getCashFlowGroupLabel(item, isIncomeView) === selectedExpenseCategory)
      : items;
  }, [expenseSummary, isIncomeView, selectedExpenseCategory]);
  const groupedCashFlowItems = useMemo(() => groupExpensesByDate(visibleCashFlowItems), [visibleCashFlowItems]);
  const activeCashFlowTotal = isIncomeView ? expenseSummary?.totalIncome || 0 : expenseSummary?.totalExpenses || 0;
  const activeCashFlowCount = isIncomeView
    ? expenseSummary?.incomeCount ?? expenseSummary?.incomingCount ?? 0
    : expenseSummary?.transactionCount || 0;
  const activeCashFlowTopLabel = isIncomeView
    ? expenseSummary?.topIncomeSource?.category || "--"
    : expenseSummary?.topCategory?.category || "--";
  const incomeDetailsMissing = isIncomeView && expenseSummary && !Array.isArray(expenseSummary.income) && (expenseSummary.incomingCount || 0) > 0;
  const cashFlowEmptyMessage = isIncomeView
    ? incomeDetailsMissing
      ? `Sync All Data to load ${expenseSummary.incomingCount} income item${expenseSummary.incomingCount === 1 ? "" : "s"} for ${selectedExpenseMonthDisplay}.`
      : expenseSummary
        ? `No income found for ${selectedExpenseMonthDisplay}.`
        : `Sync All Data to load income sources for ${selectedExpenseMonthDisplay}.`
    : `Sync All Data to load spending items for ${selectedExpenseMonthDisplay}.`;

  async function loadBankingState({ silent = false } = {}) {
    try {
      const state = await portfolioApi.getBankingState?.();
      if (!state) return;
      setBankingState(state);
      setConfig(toBankingConfig(state.config));
      setSelectedAccountUid(state.connection?.selectedAccountUid || state.connection?.accounts?.[0]?.uid || "");
      if (!silent) {
        setStatus(state.connection?.sessionIdPresent ? "N26 session connected" : "Banking connection ready");
      }
    } catch (error) {
      if (!silent) setStatus(cleanIpcError(error));
    }
  }

  useEffect(() => {
    loadBankingState();
  }, []);

  useEffect(() => {
    if (!authPending) return;
    const timer = window.setInterval(async () => {
      try {
        const state = await portfolioApi.getBankingState?.();
        if (!state) return;
        setBankingState(state);
        setConfig(toBankingConfig(state.config));
        const pending = state.connection?.pendingAuthorization;

        if (pending?.status === "error") {
          setAuthPending(false);
          setStatus(pending.error || "Bank authorization failed");
          return;
        }

        if (state.connection?.sessionIdPresent) {
          setAuthPending(false);
          const connectedAccountUid = state.connection.selectedAccountUid || state.connection.accounts?.[0]?.uid || "";
          setSelectedAccountUid(connectedAccountUid);
          setStatus("Bank connected. Sync All Data when you want fresh balances, cash flow, and monthly transactions.");
        }
      } catch (error) {
        setAuthPending(false);
        setStatus(cleanIpcError(error));
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [authPending]);

  useEffect(() => {
    if (!cashFlowAutoSync || cashFlowRange !== "5y" || !connected || !selectedAccountUid || isBusy) return;

    const sync = cashFlowHistorySync;
    if (!sync) return;

    if (["complete", "blocked", "limited"].includes(sync.status)) {
      setCashFlowAutoSync(false);
      return;
    }

    const signature = [
      sync.status,
      sync.nextBlockLabel,
      sync.availablePoints,
      sync.missingPoints,
      sync.nextRetryAt
    ].join("|");

    if (sync.canSync && cashFlowAutoSyncAttemptRef.current === signature) {
      setCashFlowAutoSync(false);
      setStatus("History sync paused because the bank did not return new cached months for that block.");
      return;
    }

    const delayMs = sync.canSync
      ? 900
      : sync.nextRetryAt
        ? Math.max(900, Math.min(new Date(sync.nextRetryAt).getTime() - Date.now() + 1000, 30 * 60 * 1000))
        : 0;

    if (!delayMs) return;

    const timer = window.setTimeout(() => {
      if (sync.canSync) {
        cashFlowAutoSyncAttemptRef.current = signature;
      }
      handleRefreshCashFlowTrend(selectedAccountUid, { range: "5y", force: true });
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [
    cashFlowAutoSync,
    cashFlowRange,
    cashFlowHistorySync?.availablePoints,
    cashFlowHistorySync?.canSync,
    cashFlowHistorySync?.missingPoints,
    cashFlowHistorySync?.nextBlockLabel,
    cashFlowHistorySync?.nextRetryAt,
    cashFlowHistorySync?.status,
    connected,
    isBusy,
    selectedAccountUid
  ]);

  function updateConfig(key, value) {
    setConfig((current) => ({
      ...current,
      [key]: value
    }));
  }

  function buildBankingSettingsPayload() {
    const { privateKeyPath: _privateKeyPath, privateKeyContent, ...settings } = config;
    const payload = {
      ...settings,
      consentDays: Number(config.consentDays)
    };

    if (String(privateKeyContent || "").trim()) {
      payload.privateKeyContent = privateKeyContent;
      payload.privateKeyPath = "";
    }

    return payload;
  }

  function ensurePrivateKeyReady(message) {
    if (privateKeyFileLoaded || privateKeyStoredInSettings) return true;
    setStatus(message);
    return false;
  }

  function handlePrivateKeyFileChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      const privateKeyContent = String(reader.result || "");
      if (!privateKeyContent.trim()) {
        updateConfig("privateKeyContent", "");
        setStatus("Selected private key file was empty");
        return;
      }
      updateConfig("privateKeyContent", privateKeyContent);
      setStatus("Private key file loaded. Save settings to encrypt it.");
    };
    reader.onerror = () => {
      updateConfig("privateKeyContent", "");
      setStatus("Could not read the selected private key file");
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  async function handleSaveBankingSettings(event) {
    event?.preventDefault();
    if (!ensurePrivateKeyReady("Select your private key file before saving banking settings")) return;

    setIsBusy(true);
    setStatus("Saving banking settings");
    try {
      const state = await portfolioApi.saveBankingSettings?.(buildBankingSettingsPayload());
      if (state) {
        setBankingState(state);
        setConfig(toBankingConfig(state.config));
      }
      setStatus(state?.privateKeyExists ? "Banking settings saved" : "Settings saved. Select a private key file before connecting");
    } catch (error) {
      setStatus(cleanIpcError(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleFindAspsps() {
    setIsBusy(true);
    setStatus("Searching Enable Banking ASPSPs");
    setAspspMatches([]);
    try {
      const matches = await portfolioApi.searchBankingAspsps?.({
        query: config.aspspName || "N26",
        country: config.aspspCountry || "DE",
        psuType: config.psuType || "personal"
      });
      setAspspMatches(matches || []);
      if (matches?.[0]) {
        setConfig((current) => ({
          ...current,
          aspspName: matches[0].name,
          aspspCountry: matches[0].country || current.aspspCountry
        }));
        setStatus(`Found ${matches.length} ASPSP match${matches.length === 1 ? "" : "es"}. Selected ${matches[0].name}`);
      } else {
        setStatus("No ASPSP matches found");
      }
    } catch (error) {
      setStatus(cleanIpcError(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStartAuthorization() {
    if (!ensurePrivateKeyReady("Select your private key file before connecting N26")) return;

    setIsBusy(true);
    setStatus("Opening N26 authorization");
    try {
      const result = await portfolioApi.startBankAuthorization?.(buildBankingSettingsPayload());
      if (result?.state) {
        setBankingState(result.state);
        setConfig(toBankingConfig(result.state.config));
      }
      setAuthPending(true);
      setStatus("Authorization opened in your browser. Waiting for the localhost redirect");
    } catch (error) {
      setAuthPending(false);
      setStatus(cleanIpcError(error));
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRefreshBalances(accountUid = selectedAccountUid, options = {}) {
    const targetAccountUid = accountUid || selectedAccountUid;
    if (!targetAccountUid) {
      setStatus("Select a connected account before refreshing balances");
      return;
    }

    const cached = balanceCache[targetAccountUid];
    if (!options.force && cached && Date.now() - cached.receivedAt < BALANCE_CACHE_TTL_MS) {
      setBalances(cached.balances);
      setSelectedAccountUid(targetAccountUid);
      setStatus(`Showing cached balance from ${formatDateTime(cached.fetchedAt)}`);
      return;
    }

    if (balanceInflightRef.current.has(targetAccountUid)) {
      setStatus("Balance refresh is already running for this account");
      return;
    }

    balanceInflightRef.current.add(targetAccountUid);
    setIsBusy(true);
    setStatus("Refreshing N26 balance");
    try {
      const result = await portfolioApi.getBankingBalances?.(targetAccountUid, options);
      setBankingState(result);
      setBalances(result?.balances || []);
      setSelectedAccountUid(result?.selectedAccountUid || targetAccountUid);
      if (result?.balances) {
        setBalanceCache((current) => ({
          ...current,
          [result?.selectedAccountUid || targetAccountUid]: {
            balances: result.balances,
            fetchedAt: result.fetchedAt,
            receivedAt: Date.now()
          }
        }));
      }
      setStatus(result?.warning || (result?.fromCache ? `Showing cached balance from ${formatDateTime(result?.fetchedAt)}` : `Balance refreshed ${formatDateTime(result?.fetchedAt)}`));
    } catch (error) {
      setStatus(cleanIpcError(error));
    } finally {
      balanceInflightRef.current.delete(targetAccountUid);
      setIsBusy(false);
    }
  }

  async function handleSyncBankData(accountUid = selectedAccountUid) {
    const targetAccountUid = accountUid || selectedAccountUid || selectedAccount?.uid;
    if (!targetAccountUid) {
      setStatus("Select a connected account before syncing bank data");
      return;
    }

    if (bankSyncInflightRef.current) {
      setStatus("Bank data sync is already running");
      return;
    }

    bankSyncInflightRef.current = true;
    setIsBusy(true);
    setStatus("Syncing bank data");

    const messages = [];
    let syncedSteps = 0;
    let refreshedCashFlowSync = null;
    const targetRange = cashFlowRange;
    const targetMonthOffset = normalizeExpenseMonthOffset(selectedExpenseMonthOffset);
    const rememberMessage = (message) => {
      if (message && !messages.includes(message)) {
        messages.push(message);
      }
    };

    try {
      try {
        const result = await portfolioApi.getBankingBalances?.(targetAccountUid, { force: true });
        if (result) {
          setBankingState(result);
          setBalances(result?.balances || []);
          setSelectedAccountUid(result?.selectedAccountUid || targetAccountUid);
          if (result?.balances) {
            setBalanceCache((current) => ({
              ...current,
              [result?.selectedAccountUid || targetAccountUid]: {
                balances: result.balances,
                fetchedAt: result.fetchedAt,
                receivedAt: Date.now()
              }
            }));
          }
          rememberMessage(result?.warning);
          syncedSteps += 1;
        }
      } catch (error) {
        rememberMessage(`Balance: ${cleanIpcError(error)}`);
      }

      try {
        const result = await portfolioApi.getBankingCashFlowTrend?.(targetAccountUid, {
          backfill: false,
          force: true,
          range: targetRange
        });
        if (result) {
          setBankingState(result);
          setSelectedAccountUid(result?.selectedAccountUid || targetAccountUid);
          setCashFlowRange(result?.cashFlowTrend?.range || targetRange);
          setCashFlowTrend(result?.cashFlowTrend || null);
          refreshedCashFlowSync = result?.cashFlowTrend?.historySync || null;
          rememberMessage(result?.cashFlowTrend?.warning);
          syncedSteps += 1;
        }
      } catch (error) {
        rememberMessage(`Cash flow: ${cleanIpcError(error)}`);
      }

      try {
        const result = await portfolioApi.getBankingMonthlyExpenses?.(targetAccountUid, {
          force: true,
          monthOffset: targetMonthOffset
        });
        if (result) {
          setBankingState(result);
          setExpenseSummary(result?.expenseSummary || null);
          setSelectedAccountUid(result?.selectedAccountUid || targetAccountUid);
          setSelectedExpenseMonthOffset(result?.expenseSummary?.monthOffset ?? targetMonthOffset);
          const returnedSummaries = Array.isArray(result?.expenseSummaries) && result.expenseSummaries.length
            ? result.expenseSummaries
            : result?.expenseSummary
              ? [result.expenseSummary]
              : [];
          if (returnedSummaries.length > 0) {
            setExpenseCache((current) => {
              const next = { ...current };
              for (const summary of returnedSummaries) {
                next[getExpenseCacheKey(result?.selectedAccountUid || targetAccountUid, summary.monthOffset ?? targetMonthOffset)] = {
                  summary,
                  receivedAt: Date.now()
                };
              }
              return next;
            });
          }
          rememberMessage(result?.warning);
          syncedSteps += 1;
        }
      } catch (error) {
        rememberMessage(`Month: ${cleanIpcError(error)}`);
      }

      if (syncedSteps === 0) {
        setStatus(messages[0] || "Bank data sync did not return data");
      } else if (messages.length > 0) {
        setStatus(`${syncedSteps === 3 ? "Bank data synced" : "Bank data partially synced"}: ${messages[0]}`);
      } else {
        setStatus("Bank data synced");
      }
    } finally {
      bankSyncInflightRef.current = false;
      setIsBusy(false);
      if (targetRange === "5y" && isResumableCashFlowHistory(refreshedCashFlowSync)) {
        cashFlowAutoSyncAttemptRef.current = "";
        setCashFlowAutoSync(true);
      }
    }
  }

  async function handleRefreshCashFlowTrend(accountUid = selectedAccountUid, options = {}) {
    const targetAccountUid = accountUid || selectedAccountUid;
    if (!targetAccountUid) {
      setStatus("Select a connected account before refreshing cash flow");
      return;
    }

    const range = options.range || cashFlowRange;
    const requestKey = `${targetAccountUid}:${range}`;
    if (cashFlowInflightRef.current.has(requestKey)) {
      setStatus("Cash-flow trend refresh is already running for this range");
      return;
    }

    cashFlowInflightRef.current.add(requestKey);
    setIsBusy(true);
    setStatus(`Refreshing ${CASH_FLOW_RANGE_OPTIONS.find((option) => option.value === range)?.label || "cash-flow"} trend`);
    try {
      const result = await portfolioApi.getBankingCashFlowTrend?.(targetAccountUid, {
        ...options,
        range
      });
      setBankingState(result);
      setSelectedAccountUid(result?.selectedAccountUid || targetAccountUid);
      setCashFlowRange(result?.cashFlowTrend?.range || range);
      setCashFlowTrend(result?.cashFlowTrend || null);
      setStatus(result?.cashFlowTrend?.warning || (result?.cashFlowTrend?.fromCache ? `Showing cached ${result?.cashFlowTrend?.label || "cash-flow"} trend` : `Cash-flow trend refreshed ${formatDateTime(result?.cashFlowTrend?.fetchedAt)}`));
      return result;
    } catch (error) {
      setStatus(cleanIpcError(error));
      return null;
    } finally {
      cashFlowInflightRef.current.delete(requestKey);
      setIsBusy(false);
    }
  }

  async function handleRefreshExpenses(accountUid = selectedAccountUid, options = {}) {
    const targetAccountUid = accountUid || selectedAccountUid;
    if (!targetAccountUid) {
      setStatus("Select a connected account before refreshing monthly transactions");
      return;
    }

    const monthOffset = normalizeExpenseMonthOffset(
      Number.isFinite(Number(options.monthOffset)) ? Number(options.monthOffset) : selectedExpenseMonthOffset
    );
    const cacheKey = getExpenseCacheKey(targetAccountUid, monthOffset);
    const cached = expenseCache[cacheKey];
    if (!options.force && cached && Date.now() - cached.receivedAt < EXPENSE_CACHE_TTL_MS) {
      setExpenseSummary(cached.summary);
      setSelectedAccountUid(targetAccountUid);
      setSelectedExpenseMonthOffset(monthOffset);
      setStatus(`Showing cached ${cached.summary?.monthLabel || "monthly"} transactions`);
      return;
    }

    if (expenseInflightRef.current.has(cacheKey)) {
      setStatus("Monthly transaction refresh is already running for this account");
      return;
    }

    expenseInflightRef.current.add(cacheKey);
    setIsBusy(true);
    setStatus(`Refreshing ${expenseMonthOptions.find((option) => option.value === monthOffset)?.label || "monthly"} transactions`);
    try {
      const result = await portfolioApi.getBankingMonthlyExpenses?.(targetAccountUid, {
        ...options,
        monthOffset
      });
      setBankingState(result);
      setExpenseSummary(result?.expenseSummary || null);
      setSelectedAccountUid(result?.selectedAccountUid || targetAccountUid);
      setSelectedExpenseMonthOffset(result?.expenseSummary?.monthOffset ?? monthOffset);
      const returnedSummaries = Array.isArray(result?.expenseSummaries) && result.expenseSummaries.length
        ? result.expenseSummaries
        : result?.expenseSummary
          ? [result.expenseSummary]
          : [];
      if (returnedSummaries.length > 0) {
        setExpenseCache((current) => {
          const next = { ...current };
          for (const summary of returnedSummaries) {
            next[getExpenseCacheKey(result?.selectedAccountUid || targetAccountUid, summary.monthOffset ?? monthOffset)] = {
              summary,
              receivedAt: Date.now()
            };
          }
          return next;
        });
      }
      setStatus(result?.warning || (result?.fromCache ? `Showing cached ${result?.expenseSummary?.monthLabel || "monthly"} transactions` : `Monthly transactions refreshed ${formatDateTime(result?.expenseSummary?.fetchedAt)}`));
    } catch (error) {
      setStatus(cleanIpcError(error));
    } finally {
      expenseInflightRef.current.delete(cacheKey);
      setIsBusy(false);
    }
  }

  async function handleChangeExpenseCategory(expense, nextCategory) {
    if (!expenseSummary || !expense?.id) return;

    const category = nextCategory || UNCATEGORIZED;
    const previousSummary = expenseSummary;
    const updatedSummary = rebuildExpenseSummaryWithCategory(expenseSummary, expense.id, category);
    const cacheKey = getExpenseCacheKey(selectedAccountUid, expenseSummary.monthOffset ?? selectedExpenseMonthOffset);
    setExpenseSummary(updatedSummary);
    setExpenseCache((current) => ({
      ...current,
      [cacheKey]: {
        summary: updatedSummary,
        receivedAt: Date.now()
      }
    }));

    try {
      await portfolioApi.setBankingTransactionCategory?.({
        transactionId: expense.id,
        category
      });
      setStatus(`${expense.counterparty} moved to ${category}`);
    } catch (error) {
      setExpenseSummary(previousSummary);
      setExpenseCache((current) => ({
        ...current,
        [cacheKey]: {
          summary: previousSummary,
          receivedAt: Date.now()
        }
      }));
      setStatus(cleanIpcError(error));
    }
  }

  async function handleChangeExpenseMonth(monthOffset) {
    const nextOffset = normalizeExpenseMonthOffset(monthOffset);
    setSelectedExpenseMonthOffset(nextOffset);
    setSelectedExpenseCategory("");

    if (!selectedAccountUid) {
      setExpenseSummary(null);
      return;
    }

    const cacheKey = getExpenseCacheKey(selectedAccountUid, nextOffset);
    const cached = expenseCache[cacheKey];
    if (cached) {
      setExpenseSummary(cached.summary);
      setStatus(`Showing cached ${cached.summary?.monthLabel || "monthly"} transactions`);
      return;
    }

    setExpenseSummary(null);
    const monthLabel = expenseMonthOptions.find((option) => option.value === nextOffset)?.detail || "that month";
    setStatus(`Selected ${monthLabel}. Use Sync All Data to load it.`);
  }

  function handleChangeCashFlowView(nextView) {
    setCashFlowView(nextView === "income" ? "income" : "expenses");
    setSelectedExpenseCategory("");
  }

  async function handleChangeCashFlowRange(nextRange) {
    const range = CASH_FLOW_RANGE_OPTIONS.some((option) => option.value === nextRange) ? nextRange : "3m";
    setCashFlowRange(range);
    setCashFlowTrend(null);
    setCashFlowAutoSync(false);
    cashFlowAutoSyncAttemptRef.current = "";

    if (!selectedAccountUid || !connected) {
      setStatus(`Selected ${CASH_FLOW_RANGE_OPTIONS.find((option) => option.value === range)?.label || "cash-flow"} trend. Connect an account to load it.`);
      return;
    }

    await handleRefreshCashFlowTrend(selectedAccountUid, { range, force: false });
  }

  function handleToggleCashFlowHistorySync() {
    if (cashFlowAutoSync) {
      setCashFlowAutoSync(false);
      setStatus("History sync stopped");
      return;
    }

    cashFlowAutoSyncAttemptRef.current = "";
    setCashFlowAutoSync(true);
    if (cashFlowHistorySync?.canSync) {
      setStatus(`Syncing ${cashFlowHistorySync.nextBlockLabel || "the next history block"}`);
    } else if (cashFlowHistorySync?.nextRetryAt) {
      setStatus(`History sync will retry ${formatRelativeTime(cashFlowHistorySync.nextRetryAt)}`);
    } else {
      setStatus("History sync ready");
    }
  }

  async function handleCashFlowPrimaryAction() {
    if (cashFlowAutoSync || cashFlowHistoryCanResume) {
      handleToggleCashFlowHistorySync();
      return;
    }

    cashFlowAutoSyncAttemptRef.current = "";
    const result = await handleRefreshCashFlowTrend(selectedAccountUid, {
      backfill: false,
      force: true,
      range: cashFlowRange
    });
    const refreshedSync = result?.cashFlowTrend?.historySync || null;

    if (cashFlowRange === "5y" && isResumableCashFlowHistory(refreshedSync)) {
      setCashFlowAutoSync(true);
      setStatus(`Recent cash flow updated. Continuing with ${refreshedSync.nextBlockLabel || "the next saved history block"}.`);
    }
  }

  async function handleDisconnectBanking() {
    setIsBusy(true);
    setStatus("Clearing banking session");
    try {
      const state = await portfolioApi.disconnectBanking?.();
      setBankingState(state || blankBankingState);
      setConfig(toBankingConfig(state?.config));
      setBalances([]);
      setBalanceCache({});
      setExpenseSummary(null);
      setExpenseCache({});
      setCashFlowTrend(null);
      setCashFlowAutoSync(false);
      setSelectedExpenseCategory("");
      balanceInflightRef.current.clear();
      cashFlowInflightRef.current.clear();
      cashFlowAutoSyncAttemptRef.current = "";
      expenseInflightRef.current.clear();
      bankSyncInflightRef.current = false;
      setSelectedAccountUid("");
      setAuthPending(false);
      setStatus("Banking session cleared");
    } catch (error) {
      setStatus(cleanIpcError(error));
    } finally {
      setIsBusy(false);
    }
  }

  function handleSelectAccount(accountUid) {
    setSelectedAccountUid(accountUid);
    const cached = balanceCache[accountUid];
    if (cached) {
      setBalances(cached.balances);
      setStatus(`Showing cached balance from ${formatDateTime(cached.fetchedAt)}`);
    } else {
      setBalances([]);
      setStatus("Account selected. Use Sync All Data when you want a fresh API call");
    }

    const cachedExpenses = expenseCache[getExpenseCacheKey(accountUid, selectedExpenseMonthOffset)];
    setExpenseSummary(cachedExpenses?.summary || null);
    setCashFlowTrend(null);
    setCashFlowAutoSync(false);
    cashFlowAutoSyncAttemptRef.current = "";
    setSelectedExpenseCategory("");
  }

  return (
    <>
      <header className="topbar banking-topbar">
        <div>
          <p className="eyebrow">Open Banking</p>
          <h1>Banking Tracker</h1>
        </div>
        <div className="top-actions">
          <IconButton
            icon={isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
            label={isDarkMode ? "Light Mode" : "Dark Mode"}
            onClick={onToggleTheme}
          />
          <IconButton icon={<Save size={18} />} label="Save Settings" onClick={handleSaveBankingSettings} disabled={isBusy} />
          <IconButton icon={<Search size={18} />} label="Find ASPSP" onClick={handleFindAspsps} disabled={isBusy} />
          <IconButton icon={<Link2 size={18} />} label="Connect N26" onClick={handleStartAuthorization} disabled={isBusy || authPending} />
          <IconButton icon={<RefreshCw size={18} />} label="Sync All Data" onClick={() => handleSyncBankData(selectedAccountUid)} disabled={isBusy || !connected} />
        </div>
      </header>

      <section className="status-strip">
        <span>{status}</span>
        <span>
          {privateKeyFileLoaded
            ? "Private key loaded locally. Save settings to encrypt it."
            : privateKeyStoredInSettings
              ? "Encrypted private key ready"
              : "Private key not loaded"}
        </span>
      </section>

      <section className="banking-summary-grid">
        <BankingStat
          icon={<Wallet size={18} />}
          title="Current Balance"
          value={preferredBalance ? formatCurrency(preferredBalance.amount, balanceCurrency) : "--"}
          meta={preferredBalance?.balanceType || "No balance loaded"}
          tone={preferredBalance?.amount >= 0 ? "good" : preferredBalance ? "bad" : ""}
        />
        <BankingStat
          icon={<ShieldCheck size={18} />}
          title="Connection"
          value={connected ? "Connected" : authPending ? "Pending" : "Not Connected"}
          meta={bankingState.connection?.accessValidUntil ? `Access until ${formatShortDate(bankingState.connection.accessValidUntil)}` : "N26 via Enable Banking"}
        />
        <BankingStat
          icon={<Landmark size={18} />}
          title="Account"
          value={selectedAccount ? selectedAccount.name : config.aspspName || "N26"}
          meta={formatAccountMeta(selectedAccount)}
        />
      </section>

      <section className="banking-cash-flow-panel">
        <div className="banking-panel-header">
          <PanelTitle icon={<TrendingUp size={18} />} title="Cumulative Income vs Expenses" />
          <div className="cash-flow-actions">
            <div className="segmented cash-flow-range-tabs" aria-label="Cash-flow chart range">
              {CASH_FLOW_RANGE_OPTIONS.map((option) => (
                <button
                  className={cashFlowRange === option.value ? "active" : ""}
                  disabled={isBusy}
                  key={option.value}
                  onClick={() => handleChangeCashFlowRange(option.value)}
                  title={option.detail}
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="cash-flow-update-action">
              <IconButton
                icon={cashFlowAutoSync ? <X size={18} /> : <RefreshCw size={18} />}
                label={cashFlowActionLabel}
                onClick={handleCashFlowPrimaryAction}
                disabled={isBusy || !connected}
              />
            </div>
          </div>
        </div>

        <div className="cash-flow-summary">
          <div>
            <span>Total income</span>
            <strong>{formatCurrency(cashFlowTotals.income || 0, cashFlowCurrency)}</strong>
          </div>
          <div>
            <span>Total expenses</span>
            <strong>{formatCurrency(cashFlowTotals.expenses || 0, cashFlowCurrency)}</strong>
          </div>
          <div className={(cashFlowTotals.net || 0) >= 0 ? "good" : "bad"}>
            <span>Total net</span>
            <strong>{formatCurrency(cashFlowTotals.net || 0, cashFlowCurrency)}</strong>
          </div>
          <div>
            <span>Coverage</span>
            <strong>{cashFlowAvailableLabel}</strong>
          </div>
        </div>

        {cashFlowRange === "5y" && cashFlowHistorySync && (
          <div className={`cash-flow-sync-strip ${cashFlowHistorySync.status}`}>
            <div className="cash-flow-sync-copy">
              <strong>{getCashFlowHistorySyncTitle(cashFlowHistorySync)}</strong>
              <span>{getCashFlowHistorySyncMessage(cashFlowHistorySync, cashFlowAutoSync)}</span>
            </div>
            <div className="cash-flow-sync-progress" aria-label={`${cashFlowSyncProgress}% of 5Y history synced`}>
              <span style={{ "--sync-progress": `${cashFlowSyncProgress}%` }} />
            </div>
            <div className={`cash-flow-sync-state ${cashFlowHistorySync.status}`}>
              {cashFlowHistorySync.status === "complete" ? <ShieldCheck size={16} /> : <CalendarClock size={16} />}
              <span>{getCashFlowHistoryStateLabel(cashFlowHistorySync, cashFlowAutoSync)}</span>
            </div>
          </div>
        )}

        <div className="cash-flow-chart-box">
          {cashFlowTrendPoints.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cashFlowTrendPoints} margin={{ top: 14, right: 24, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="cashFlowIncomeFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0f766e" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#0f766e" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="cashFlowExpenseFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#dc2626" stopOpacity={0.14} />
                    <stop offset="95%" stopColor="#dc2626" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#e3e7ed" vertical={false} />
                <XAxis
                  dataKey="date"
                  minTickGap={34}
                  tickFormatter={(value) => formatCashFlowAxisDate(value, cashFlowRange)}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis tickFormatter={(value) => compactMoney(value, cashFlowCurrency)} tickLine={false} axisLine={false} width={72} />
                <Tooltip content={(props) => <CashFlowTrendTooltip {...props} currency={cashFlowCurrency} />} />
                <ReferenceLine y={0} stroke="#cbd5e1" strokeDasharray="4 4" />
                <Area type="linear" dataKey="income" name="income" stroke="#0f766e" fill="url(#cashFlowIncomeFill)" strokeWidth={2.2} dot={false} connectNulls={false} />
                <Area type="linear" dataKey="expenses" name="expenses" stroke="#dc2626" fill="url(#cashFlowExpenseFill)" strokeWidth={2.2} dot={false} connectNulls={false} />
                <Line type="linear" dataKey="net" name="net" stroke="#2563eb" strokeWidth={2} dot={false} connectNulls={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="banking-empty">
              Update Cash Flow to compare cumulative income and expenses over {selectedCashFlowRangeOption.detail.toLowerCase()}.
            </div>
          )}
        </div>
        {cashFlowTrend?.warning && <div className="cash-flow-warning">{cashFlowTrend.warning}</div>}
      </section>

      <section className="banking-expense-layout">
        <div className="banking-expense-panel expense-chart-panel">
          <div className="banking-panel-header">
            <PanelTitle
              icon={isIncomeView ? <TrendingUp size={18} /> : <ChartColumn size={18} />}
              title={`${expenseSummary?.monthLabel || selectedExpenseMonthDisplay} ${cashFlowLabel}`}
            />
            <div className="expense-header-actions">
              <div className="segmented cash-flow-tabs" role="tablist" aria-label="Monthly banking view">
                <button
                  aria-selected={!isIncomeView}
                  className={!isIncomeView ? "active" : ""}
                  onClick={() => handleChangeCashFlowView("expenses")}
                  role="tab"
                  type="button"
                >
                  <ChartColumn size={15} />
                  <span>Expenses</span>
                </button>
                <button
                  aria-selected={isIncomeView}
                  className={isIncomeView ? "active" : ""}
                  onClick={() => handleChangeCashFlowView("income")}
                  role="tab"
                  type="button"
                >
                  <TrendingUp size={15} />
                  <span>Income</span>
                </button>
              </div>
              <FancySelect
                ariaLabel="Monthly transaction month"
                className="month-picker"
                value={selectedExpenseMonthOffset}
                options={expenseMonthOptions}
                onChange={handleChangeExpenseMonth}
                disabled={isBusy}
              />
            </div>
          </div>
          <div className="expense-metrics">
            <div>
              <span>{isIncomeView ? "Total income" : "Total spent"}</span>
              <strong>{formatCurrency(activeCashFlowTotal, flowCurrency)}</strong>
            </div>
            <div>
              <span>{isIncomeView ? "Income items" : "Transactions"}</span>
              <strong>{activeCashFlowCount}</strong>
            </div>
            <div>
              <span>{isIncomeView ? "Top source" : "Top category"}</span>
              <strong>{activeCashFlowTopLabel}</strong>
            </div>
          </div>
          <div className="expense-chart-box">
            {flowCategories.length > 0 ? (
              <div className="expense-column-chart" aria-label={isIncomeView ? "Income sources" : "Expense categories"}>
                {flowCategories.slice(0, 8).map((category) => (
                  <button
                    className={`expense-column${selectedExpenseCategory === category.category ? " active" : ""}${isIncomeView ? " income" : ""}`}
                    key={category.category}
                    onClick={() => setSelectedExpenseCategory((current) => (current === category.category ? "" : category.category))}
                    style={{ "--bar-height": `${Math.max(maxFlowCategoryAmount ? (category.amount / maxFlowCategoryAmount) * 100 : 0, 6)}%` }}
                    type="button"
                  >
                    <em>{formatCurrency(category.amount, category.currency || flowCurrency)}</em>
                    <span className="expense-column-track">
                      <span className="expense-column-fill" />
                    </span>
                    <strong>{category.category}</strong>
                    <small>{category.count}x - {category.share}%</small>
                  </button>
                ))}
              </div>
            ) : (
              <div className="banking-empty">{cashFlowEmptyMessage}</div>
            )}
          </div>
        </div>

        <div className="banking-expense-panel">
          <div className="banking-panel-header">
            <PanelTitle icon={<Tags size={18} />} title={selectedExpenseCategory || `${expenseSummary?.monthLabel || selectedExpenseMonthDisplay} ${cashFlowLabel}`} />
            {selectedExpenseCategory && (
              <IconButton icon={<X size={18} />} label={isIncomeView ? "All Income" : "All Items"} onClick={() => setSelectedExpenseCategory("")} />
            )}
          </div>
          <div className={`expense-list-summary${isIncomeView ? " income" : ""}`}>
            <span>
              {selectedExpenseCategory
                ? `${visibleCashFlowItems.length} ${cashFlowItemLabel} item${visibleCashFlowItems.length === 1 ? "" : "s"} ${isIncomeView ? "from" : "in"} ${selectedExpenseCategory}`
                : `${visibleCashFlowItems.length} ${cashFlowItemLabel} item${visibleCashFlowItems.length === 1 ? "" : "s"} in ${selectedExpenseMonthDisplay}`}
            </span>
            <strong>
              {formatCurrency(selectedExpenseCategory ? selectedCategoryTotal?.amount || 0 : activeCashFlowTotal, flowCurrency)}
            </strong>
          </div>
          {groupedCashFlowItems.length > 0 ? (
            <div className="expense-item-groups">
              {groupedCashFlowItems.map((group) => (
                <section className="expense-date-group" key={group.date}>
                  <header>
                    <span>{formatExpenseDateLabel(group.date)}</span>
                    <em>{formatCurrency(group.total, flowCurrency)}</em>
                  </header>
                  {group.items.map((item) => (
                    <div className={`expense-item-row${isIncomeView ? " income-item-row" : ""}`} key={item.id}>
                      <div className="expense-item-main">
                        <strong>{item.counterparty}</strong>
                        <span>{formatCashFlowTransactionMeta(item, isIncomeView)}</span>
                      </div>
                      <em>{formatCurrency(item.amount, item.currency || flowCurrency)}</em>
                      {!isIncomeView && (
                        <FancySelect
                          ariaLabel={`Category for ${item.counterparty}`}
                          className="category-picker"
                          value={item.category}
                          options={expenseCategoryOptions.map((category) => ({ value: category, label: category }))}
                          onChange={(category) => handleChangeExpenseCategory(item, category)}
                        />
                      )}
                      {!isIncomeView && selectedExpenseCategory && item.category === selectedExpenseCategory && (
                        <button
                          className="expense-remove-button"
                          onClick={() => handleChangeExpenseCategory(item, UNCATEGORIZED)}
                          title="Remove from this category"
                          type="button"
                        >
                          <X size={14} />
                          <span>Remove</span>
                        </button>
                      )}
                    </div>
                  ))}
                </section>
              ))}
            </div>
          ) : (
            <div className="banking-empty">
              {selectedExpenseCategory ? `No ${cashFlowItemLabel} items ${isIncomeView ? "from this source" : "in this category"}.` : cashFlowEmptyMessage}
            </div>
          )}
        </div>
      </section>

      {aspspMatches.length > 0 && (
        <section className="aspsp-results" aria-label="ASPSP matches">
          {aspspMatches.map((aspsp) => (
            <button
              className="aspsp-result"
              key={`${aspsp.country}-${aspsp.name}-${aspsp.bic}`}
              onClick={() => {
                setConfig((current) => ({
                  ...current,
                  aspspName: aspsp.name,
                  aspspCountry: aspsp.country || current.aspspCountry
                }));
                setStatus(`Selected ${aspsp.name}`);
              }}
              type="button"
            >
              <strong>{aspsp.name}</strong>
              <span>{[aspsp.country, aspsp.bic].filter(Boolean).join(" - ") || "Enable Banking ASPSP"}</span>
            </button>
          ))}
        </section>
      )}

      <section className="banking-layout">
        <form className="banking-settings-panel" onSubmit={handleSaveBankingSettings}>
          <PanelTitle icon={<Key size={18} />} title="Enable Banking Setup" />
          <label>
            Application ID
            <input
              autoComplete="off"
              value={config.applicationId}
              onChange={(event) => updateConfig("applicationId", event.target.value)}
              placeholder="Your Enable Banking application ID"
              required
            />
          </label>
          <div className="pem-upload-field">
            <span>Private Key File</span>
            <div className="pem-upload-row">
              <label className="pem-upload-button">
                <Upload size={16} />
                <span>Select Private Key File</span>
                <input accept=".pem" onChange={handlePrivateKeyFileChange} type="file" />
              </label>
              <span className={`pem-upload-status ${privateKeyFileLoaded || privateKeyStoredInSettings ? "ready" : ""}`}>
                {privateKeyFileLoaded ? "Key file loaded" : privateKeyStoredInSettings ? "Encrypted key saved" : "No key selected"}
              </span>
            </div>
          </div>
          <label>
            Redirect URL
            <input
              value={config.redirectUrl}
              onChange={(event) => updateConfig("redirectUrl", event.target.value)}
              placeholder="http://localhost:8080"
              required
            />
          </label>
          <div className="banking-form-row">
            <label>
              ASPSP Name
              <input
                value={config.aspspName}
                onChange={(event) => updateConfig("aspspName", event.target.value)}
                required
              />
            </label>
            <label>
              Country
              <input
                maxLength={2}
                value={config.aspspCountry}
                onChange={(event) => updateConfig("aspspCountry", event.target.value.toUpperCase())}
                required
              />
            </label>
          </div>
          <div className="banking-form-row">
            <label>
              PSU Type
              <select value={config.psuType} onChange={(event) => updateConfig("psuType", event.target.value)}>
                <option value="personal">Personal</option>
                <option value="business">Business</option>
              </select>
            </label>
            <label>
              Consent Days
              <input
                min="1"
                max="180"
                step="1"
                type="number"
                value={config.consentDays}
                onChange={(event) => updateConfig("consentDays", event.target.value)}
              />
            </label>
          </div>
          <button className="primary-action" disabled={isBusy} type="submit">
            <Save size={18} />
            Save Settings
          </button>
        </form>

        <div className="banking-panel">
          <div className="banking-panel-header">
            <PanelTitle icon={<Database size={18} />} title="N26 Account Balances" />
            {connected && (
              <IconButton icon={<X size={18} />} label="Disconnect" onClick={handleDisconnectBanking} disabled={isBusy} />
            )}
          </div>

          {accounts.length > 0 ? (
            <div className="account-selector" role="listbox" aria-label="Connected bank accounts">
              {accounts.map((account) => (
                <button
                  className={account.uid === selectedAccountUid ? "active" : ""}
                  key={account.uid}
                  onClick={() => handleSelectAccount(account.uid)}
                  type="button"
                >
                  <strong>{account.name}</strong>
                  <span>{formatAccountMeta(account)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="banking-empty">Connect N26 to load the account list.</div>
          )}

          <div className="table-wrap banking-balance-table">
            <table>
              <thead>
                <tr>
                  <th>Balance Type</th>
                  <th>Amount</th>
                  <th>Currency</th>
                  <th>Reference</th>
                </tr>
              </thead>
              <tbody>
                {balances.length > 0 ? (
                  balances.map((balance, index) => (
                    <tr key={`${balance.balanceType}-${index}`}>
                      <td>{balance.balanceType}</td>
                      <td className={balance.amount >= 0 ? "number-good" : "number-bad"}>
                        {formatCurrency(balance.amount, balance.currency || balanceCurrency)}
                      </td>
                      <td>{balance.currency || balanceCurrency}</td>
                      <td>{balance.referenceDate ? formatShortDate(balance.referenceDate) : "--"}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4}>No balances loaded yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </>
  );
}

function BankingStat({ icon, title, value, meta, tone }) {
  return (
    <div className={`banking-stat ${tone ?? ""}`}>
      <span className="banking-stat-icon">{icon}</span>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{meta}</small>
    </div>
  );
}

function formatAccountMeta(account) {
  if (!account) return "No account selected";
  const iban = account.ibanLast4 ? `IBAN ...${account.ibanLast4}` : "";
  return [account.currency, iban, account.cashAccountType].filter(Boolean).join(" - ") || "Account UID ready";
}

function formatShortDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium"
  }).format(date);
}

function getExpenseCacheKey(accountUid, monthOffset = 0) {
  const normalizedOffset = normalizeExpenseMonthOffset(monthOffset);
  return `${accountUid || "account"}:${normalizedOffset}`;
}

function normalizeExpenseMonthOffset(value) {
  const offset = Number(value);
  if (!Number.isFinite(offset)) return 0;
  return Math.min(3, Math.max(0, Math.round(offset)));
}

function getExpenseMonthOptions(now = new Date()) {
  return [0, 1, 2, 3].map((offset) => {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const monthLabel = new Intl.DateTimeFormat(undefined, {
      month: "long",
      year: "numeric"
    }).format(monthDate);
    const relativeLabel = offset === 0 ? "Current month" : offset === 1 ? "Last month" : `${offset} months ago`;

    return {
      value: offset,
      label: relativeLabel,
      detail: monthLabel
    };
  });
}

function getCashFlowGroupLabel(transaction = {}, isIncomeView = false) {
  if (isIncomeView) {
    return transaction.incomeSource || transaction.counterparty || transaction.category || "Income";
  }
  return transaction.category || UNCATEGORIZED;
}

function formatCashFlowTransactionMeta(transaction = {}, isIncomeView = false) {
  const primary = isIncomeView
    ? transaction.category || transaction.categorySource || "Income"
    : transaction.categorySource || transaction.category || "Transaction";
  return [primary, transaction.note].filter(Boolean).join(" - ");
}

function rebuildExpenseSummaryWithCategory(summary, transactionId, nextCategory) {
  if (!summary) return summary;
  const expenses = (summary.expenses || []).map((expense) => {
    if (expense.id !== transactionId) return expense;
    return {
      ...expense,
      category: nextCategory,
      categorySource: "Manual",
      manuallyCategorized: true
    };
  });

  return rebuildExpenseSummaryFromExpenses(summary, expenses);
}

function rebuildExpenseSummaryFromExpenses(summary, expenses) {
  const totalExpenses = expenses.reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  const categoryMap = new Map();

  for (const expense of expenses) {
    const category = expense.category || UNCATEGORIZED;
    const current = categoryMap.get(category) || {
      category,
      amount: 0,
      count: 0,
      currency: expense.currency || summary.currency || "EUR",
      source: expense.categorySource,
      examples: []
    };
    current.amount += Number(expense.amount || 0);
    current.count += 1;
    if (current.examples.length < 3) current.examples.push(expense.counterparty);
    categoryMap.set(category, current);
  }

  const categories = [...categoryMap.values()]
    .map((category) => ({
      ...category,
      amount: Number(category.amount.toFixed(2)),
      share: totalExpenses ? Number(((category.amount / totalExpenses) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.amount - a.amount);

  const sortedExpenses = [...expenses].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    ...summary,
    totalExpenses: Number(totalExpenses.toFixed(2)),
    transactionCount: sortedExpenses.length,
    topCategory: categories[0] || null,
    categoryOptions: [...new Set([...DEFAULT_EXPENSE_CATEGORIES, ...(summary.categoryOptions || []), ...categories.map((category) => category.category)])],
    categories,
    expenses: sortedExpenses,
    recentExpenses: sortedExpenses.slice(0, 8)
  };
}

function groupExpensesByDate(expenses = []) {
  const groups = new Map();
  for (const expense of expenses) {
    const date = expense.date || "No date";
    const current = groups.get(date) || {
      date,
      total: 0,
      items: []
    };
    current.total += Number(expense.amount || 0);
    current.items.push(expense);
    groups.set(date, current);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      total: Number(group.total.toFixed(2))
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function formatExpenseDateLabel(value) {
  if (!value || value === "No date") return "No date";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short"
  }).format(date);
}

function cleanIpcError(error) {
  const raw = String(error?.message || error || "Something went wrong");
  const withoutInvokePrefix = raw.replace(/^Error invoking remote method '[^']+':\s*/i, "");
  return withoutInvokePrefix.replace(/^Error:\s*/i, "");
}

function verifyCatalyst(catalyst, newsItems = [], priceMetrics = {}) {
  const titleText = String(catalyst.title ?? "").toLowerCase();
  const watchText = String(catalyst.watchFor ?? "").toLowerCase();
  const fullText = `${titleText} ${watchText}`;

  // 1. Check if it's a technical/price consolidation catalyst
  const isTechnical = 
    titleText.includes("price") || 
    titleText.includes("support") || 
    titleText.includes("resistance") || 
    titleText.includes("consolidation") || 
    titleText.includes("trend") || 
    titleText.includes("momentum") || 
    titleText.includes("floor") ||
    watchText.includes("price") ||
    watchText.includes("drawdown") ||
    watchText.includes("decline") ||
    watchText.includes("recovery") ||
    watchText.includes("stagnation") ||
    watchText.includes("1d") ||
    watchText.includes("5d") ||
    watchText.includes("30d") ||
    watchText.includes("1m");

  if (isTechnical && priceMetrics) {
    const numbers = [
      priceMetrics.latestPrice,
      priceMetrics.change1d,
      priceMetrics.change5d,
      priceMetrics.change30d
    ].filter(n => n !== undefined && n !== null);
    
    const hasPriceNumberMatch = numbers.some(num => {
      const numStr = Math.abs(num).toString();
      return watchText.includes(numStr) || titleText.includes(numStr);
    });

    if (hasPriceNumberMatch || isTechnical) {
      return {
        verified: true,
        type: "price",
        sourceName: "Price Metrics"
      };
    }
  }

  // 2. Otherwise, check for news matches
  const stopWords = new Set([
    "with", "than", "that", "this", "these", "those", "their", "there", "about", "above", "below",
    "from", "over", "under", "after", "before", "during", "through", "between", "against", "would",
    "could", "should", "shall", "might", "must", "other", "another", "some", "every", "each", "both",
    "many", "much", "more", "most", "less", "least", "fewer", "fewest", "been", "have", "has", "had",
    "having", "does", "done", "doing", "will", "would", "shall", "should", "going", "came", "come"
  ]);

  const words = fullText
    .replace(/[^a-zA-Z0-9\s]/g, "")
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 3 && !stopWords.has(w));

  if (words.length === 0) {
    return { verified: false };
  }

  let bestMatch = null;
  let highestScore = 0;

  for (const newsItem of newsItems) {
    const newsTitle = String(newsItem.title ?? "").toLowerCase();
    let score = 0;
    for (const word of words) {
      if (newsTitle.includes(word)) {
        score += 1;
      }
    }

    if (score > highestScore) {
      highestScore = score;
      bestMatch = newsItem;
    }
  }

  if (highestScore >= 1 && bestMatch) {
    return {
      verified: true,
      type: "news",
      sourceName: bestMatch.publisher || "News Source",
      url: bestMatch.url,
      title: bestMatch.title
    };
  }

  return { verified: false };
}

function StockIntelCard({ item }) {
  const hasNarrative = Boolean(item.narrative);
  return (
    <article className={`intel-card${hasNarrative ? " intel-card--narrative" : ""}`}>
      <header className="intel-card-header">
        <div>
          <strong>{item.ticker}</strong>
          <span>
            {item.analysisMode}
            {item.primaryTicker && item.primaryTicker !== item.ticker ? ` - primary ${item.primaryTicker}` : ""}
          </span>
        </div>
        <span className={`impact-pill ${item.impact.toLowerCase()}`}>{item.impact}</span>
      </header>
      <div className="intel-meta">
        <span>
          <CalendarClock size={15} />
          Watch {item.reviewDate}
        </span>
        <span>{item.turningPointBias}</span>
        <span>Confidence {item.confidence}</span>
        {item.shares !== undefined && <span>Your Shares: {item.shares}</span>}
      </div>
      <div className="price-strip">
        <span>1D {formatPercent(item.priceMetrics?.change1d)}</span>
        <span>5D {formatPercent(item.priceMetrics?.change5d)}</span>
        <span>1M {formatPercent(item.priceMetrics?.change30d)}</span>
      </div>

      {hasNarrative ? (
        <div className="intel-narrative">
          <SimpleMarkdown text={item.narrative} />
        </div>
      ) : (
        <p className="intel-read">{item.interpretation}</p>
      )}

      {item.keyCatalysts?.length > 0 && (
        <div className="catalyst-cards">
          <span className="event-list-title">Key Catalyst Windows</span>
          {item.keyCatalysts.map((cat, i) => {
            const verification = verifyCatalyst(cat, item.news, item.priceMetrics);
            return (
              <div className="catalyst-card" key={`${cat.dateRange}-${i}`}>
                {verification.verified ? (
                  verification.type === "news" ? (
                    <a
                      href={verification.url}
                      target="_blank"
                      rel="noreferrer"
                      className="catalyst-badge verified clickable"
                      title={`Verified via ${verification.sourceName}: "${verification.title}"`}
                    >
                      âœ“ Verified <ExternalLink size={10} />
                    </a>
                  ) : (
                    <span className="catalyst-badge verified" title="Verified via price history metrics">
                      âœ“ Price Verified
                    </span>
                  )
                ) : (
                  <span className="catalyst-badge unverified" title="AI-generated catalyst, not matching news articles or price metrics">
                    âš  Unverified
                  </span>
                )}
                <div className="catalyst-card-header">
                  <span className="catalyst-date">{cat.dateRange}</span>
                  <strong>{cat.title}</strong>
                </div>
                {cat.watchFor && (
                  <div className="catalyst-watchfor">
                    <em>Watch:</em> {cat.watchFor}
                  </div>
                )}
                <div className="catalyst-cases">
                  <span className="bull-case"><em>Bull:</em> {cat.bullCase}</span>
                  <span className="bear-case"><em>Bear:</em> {cat.bearCase}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {item.marketMechanics && (
        <div className="market-mechanics">
          <span className="event-list-title">Volatility &amp; Market Mechanics</span>
          <p><SimpleMarkdown text={item.marketMechanics} /></p>
        </div>
      )}

      {item.upcomingEvents?.length > 0 && (
        <div className="event-list">
          <span className="event-list-title">Next 6 months</span>
          {(item.upcomingEvents ?? []).slice(0, 5).map((event) => (
            <a className="event-row" href={event.sourceUrl} key={`${event.date}-${event.title}`} rel="noreferrer" target="_blank">
              <span className="event-date">{event.date}</span>
              <span className="event-copy">
                <strong>
                  {event.title}
                  <em>{event.importance}</em>
                </strong>
                <small>
                  {event.category ?? event.type} - {event.direction ?? "Watch"} - {event.certainty}
                  {event.details ? ` - ${event.details}` : ""}
                </small>
              </span>
              <ExternalLink size={14} />
            </a>
          ))}
        </div>
      )}
      {item.watchItems?.length > 0 && (
        <div className="watch-list">
          {(item.watchItems ?? []).map((watchItem) => (
            <span key={watchItem}>{watchItem}</span>
          ))}
        </div>
      )}
      {item.reviewReason && (
        <div className="intel-reason">{item.reviewReason}</div>
      )}
      {item.news?.length > 0 && (
        <div className="news-list">
          {(item.news ?? []).slice(0, 3).map((newsItem) => (
            <a href={newsItem.url} key={newsItem.url} rel="noreferrer" target="_blank">
              <span>{newsItem.title}</span>
              <small>
                {newsItem.publisher} - {formatDateTime(newsItem.publishedAt)}
              </small>
              <ExternalLink size={14} />
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function SimpleMarkdown({ text }) {
  if (!text) return null;
  const paragraphs = text.split(/\n\n+/);
  return (
    <>
      {paragraphs.map((para, i) => {
        const lines = para.split(/\n/);
        return (
          <p key={i}>
            {lines.map((line, j) => (
              <React.Fragment key={j}>
                {j > 0 && <br />}
                {renderInlineMarkdown(line)}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

function renderInlineMarkdown(text) {
  const parts = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(<strong key={match.index}>{match[1]}</strong>);
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return parts.length ? parts : text;
}

function IconButton({ icon, label, ...props }) {
  return (
    <button className="icon-button" title={label} type="button" {...props}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Metric({ title, value, tone }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{title}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReturnMetric({ cumulative, annualized }) {
  return (
    <div className="metric return-metric">
      <span>Investment Returns</span>
      <div className="return-metric-values">
        <div className={cumulative >= 0 ? "good" : "bad"}>
          <strong>{formatNullablePercent(cumulative)}</strong>
          <small>Cumulative</small>
        </div>
        <div className={annualized >= 0 ? "good" : "bad"}>
          <strong>{formatNullablePercent(annualized)}</strong>
          <small>Annualized</small>
        </div>
      </div>
    </div>
  );
}

function PanelTitle({ icon, title }) {
  return (
    <div className="panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function FancySelect({ ariaLabel, className = "", disabled = false, options = [], value, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = options.find((option) => String(option.value) === String(value)) || options[0];

  function handleBlur(event) {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setIsOpen(false);
    }
  }

  return (
    <div className={`fancy-select ${className} ${isOpen ? "open" : ""} ${disabled ? "disabled" : ""}`} onBlur={handleBlur}>
      <button
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className="fancy-select-trigger"
        disabled={disabled}
        onClick={() => setIsOpen((current) => !current)}
        type="button"
      >
        <span>
          <strong>{selected?.label || "Select"}</strong>
          {selected?.detail && <small>{selected.detail}</small>}
        </span>
        <ChevronDown className="fancy-select-chevron" size={16} />
      </button>
      <div className="fancy-select-menu" role="listbox">
        {options.map((option) => (
          <button
            aria-selected={String(option.value) === String(value)}
            className={String(option.value) === String(value) ? "selected" : ""}
            key={option.value}
            onClick={() => {
              onChange?.(option.value);
              setIsOpen(false);
            }}
            role="option"
            type="button"
          >
            <span>
              <strong>{option.label}</strong>
              {option.detail && <small>{option.detail}</small>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function buildChartDateTicks(data = [], maximumTicks = 7) {
  const dates = data.map((point) => point?.date).filter(Boolean);
  if (dates.length <= maximumTicks) return dates;

  const lastIndex = dates.length - 1;
  return [...new Set(
    Array.from({ length: maximumTicks }, (_, index) => dates[Math.round((index * lastIndex) / (maximumTicks - 1))])
  )];
}

function formatCompactChartDate(value) {
  if (!value) return "";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC"
  }).format(parsed);
}

function compactMoney(value, currency) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value || 0);
}

function StockLedgerTooltip({ active, payload = [], label, currency, colors = {}, focusedTicker = "" }) {
  if (!active || !payload.length) return null;

  const rows = payload
    .map((item) => ({
      key: item.dataKey || item.name,
      color: colors[item.dataKey || item.name] || item.color || CLOSED_LEDGER_STROKE,
      value: Number(item.value)
    }))
    .filter((item) => item.key && Number.isFinite(item.value))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const focusedRows = focusedTicker ? rows.filter((item) => item.key === focusedTicker) : rows;
  const visibleRows = (focusedRows.length ? focusedRows : rows).slice(0, focusedTicker ? 1 : 8);

  if (!visibleRows.length) return null;

  return (
    <div className="stock-ledger-tooltip">
      <strong>{label}</strong>
      <div>
        {visibleRows.map((item) => (
          <span className="stock-ledger-tooltip-row" key={item.key}>
            <i style={{ "--tooltip-color": item.color }} />
            <em>{item.key}</em>
            <b className={item.value >= 0 ? "good" : "bad"}>{formatCurrency(item.value, currency)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function formatRatioAsPercent(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function summarizePortfolioReturns(yearlyPerformance = []) {
  const latestPeriod = yearlyPerformance.at(-1);
  if (!latestPeriod || !Number.isFinite(Number(latestPeriod.cumulativeReturn))) {
    return { cumulative: null, annualized: null };
  }
  return {
    cumulative: Number(latestPeriod.cumulativeReturn),
    annualized: Number.isFinite(Number(latestPeriod.annualizedReturn)) ? Number(latestPeriod.annualizedReturn) : null
  };
}

function formatYearlyCurrency(value, currency) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value || 0);
}

function formatSharpe(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  return Number(value).toFixed(2);
}

function formatNullablePercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  return formatPercent(Number(value));
}

function formatDcaTooltipValue(value, name, currency) {
  if (name === "Return %") return formatNullablePercent(value);
  return formatNullableCurrency(value, currency);
}

function formatCashFlowAxisDate(value, range) {
  if (!value) return "";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  const longRange = ["1y", "5y"].includes(range);
  return new Intl.DateTimeFormat(undefined, {
    day: longRange ? undefined : "numeric",
    month: "short",
    year: longRange ? "2-digit" : undefined,
    timeZone: "UTC"
  }).format(parsed);
}

function formatCashFlowTooltipDate(value) {
  if (!value) return "Cash flow";
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeZone: "UTC"
  }).format(parsed);
}

function CashFlowTrendTooltip({ active, payload = [], currency }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) return null;

  if (point.missing) {
    return (
      <div className="cash-flow-trend-tooltip">
        <strong>{formatCashFlowTooltipDate(point.date)}</strong>
        <span className="cash-flow-tooltip-empty">No cached data for this day</span>
      </div>
    );
  }

  return (
    <div className="cash-flow-trend-tooltip">
      <strong>{formatCashFlowTooltipDate(point.date)}</strong>
      <div className="cash-flow-tooltip-section">
        <span>Daily movement</span>
        <CashFlowTooltipRow label="Income" value={point.periodIncome} currency={currency} tone="income" />
        <CashFlowTooltipRow label="Expenses" value={point.periodExpenses} currency={currency} tone="expense" />
        <CashFlowTooltipRow label="Net" value={point.periodNet} currency={currency} tone={point.periodNet >= 0 ? "income" : "expense"} />
      </div>
      <div className="cash-flow-tooltip-section cumulative">
        <span>Cumulative</span>
        <CashFlowTooltipRow label="Income" value={point.income} currency={currency} />
        <CashFlowTooltipRow label="Expenses" value={point.expenses} currency={currency} />
        <CashFlowTooltipRow label="Net" value={point.net} currency={currency} tone={point.net >= 0 ? "income" : "expense"} />
      </div>
    </div>
  );
}

function CashFlowTooltipRow({ label, value, currency, tone = "" }) {
  return (
    <div className={`cash-flow-tooltip-row ${tone}`}>
      <span>{label}</span>
      <strong>{formatNullableCurrency(value, currency)}</strong>
    </div>
  );
}

function formatNullableCurrency(value, currency) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "--";
  return formatCurrency(Number(value), currency);
}

function formatRelativeTime(value) {
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return "later";
  const seconds = Math.max(0, Math.ceil((target - Date.now()) / 1000));
  if (seconds < 60) return seconds <= 1 ? "in 1 second" : `in ${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "in 1 minute" : `in ${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "in 1 hour" : `in ${hours} hours`;
}

function isResumableCashFlowHistory(sync) {
  if (!sync || ["complete", "blocked", "limited"].includes(sync.status)) return false;
  return Boolean(sync.canSync || sync.nextRetryAt || ["ready", "cooldown", "partial"].includes(sync.status));
}

function getCashFlowHistoryStateLabel(sync, autoSync = false) {
  if (!sync) return "Not loaded";
  if (sync.status === "complete") return "Complete";
  if (sync.status === "limited") return "Provider limited";
  if (sync.status === "blocked") return "Needs import";
  if (autoSync && sync.status === "cooldown") return "Waiting to retry";
  if (autoSync) return "Syncing history";
  if (sync.status === "cooldown") return "Paused for cooldown";
  return "Ready to resume";
}

function getCashFlowHistorySyncTitle(sync) {
  if (!sync) return "History sync";
  if (sync.status === "complete") return "History complete";
  if (sync.status === "cooldown") return "Waiting for bank cooldown";
  if (sync.status === "blocked") return "History needs import";
  if (sync.status === "limited") return "Provider history limit reached";
  if (sync.status === "ready") return "History block ready";
  return "History partially synced";
}

function getCashFlowHistorySyncMessage(sync, autoSync = false) {
  if (!sync) return "Load the 5Y chart to see history sync status.";
  if (sync.status === "complete") return sync.message || "All months are synced.";
  if (sync.status === "cooldown") {
    const wait = sync.nextRetryAt ? formatRelativeTime(sync.nextRetryAt) : "later";
    return `${sync.message || "Waiting for the bank API."} ${autoSync ? `Auto-sync will retry ${wait}.` : `You can retry ${wait}.`}`;
  }
  if (sync.status === "ready") {
    return `${sync.message || "A history block is ready."} ${autoSync ? "The app is saving each available block automatically." : "Resume History Sync to continue from the next missing block."}`;
  }
  return sync.message || "History is partially synced.";
}

function formatDateTime(value) {
  if (!value) return "No date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

persistTheme(getInitialTheme());

export default App;

