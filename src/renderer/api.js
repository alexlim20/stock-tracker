import Papa from "papaparse";
import sampleTradesCsv from "./sample.csv?raw";
import { DEFAULT_MARKET_DATA } from "../shared/marketData.js";

const DEFAULT_MEDIA_PIPELINE_PATHS = {
  sourcePath: "",
  targetPath: ""
};

const defaultBankingState = {
  config: {
    applicationId: "",
    privateKeyPath: "application_private_key.pem",
    redirectUrl: "https://localhost:8080/",
    aspspName: "N26",
    aspspCountry: "DE",
    psuType: "personal",
    consentDays: 90
  },
  privateKeyExists: false,
  privateKeyResolvedPath: "",
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

const fallbackApi = {
  async addTrade(trade) {
    const current = parseTrades(sampleTradesCsv);
    return { added: true, trades: [...current, trade] };
  },
  async deleteTrade(trade) {
    const targetKey = getTradeKey(trade);
    const current = parseTrades(sampleTradesCsv);
    const nextTrades = current.filter((item) => getTradeKey(item) !== targetKey);
    return { deleted: nextTrades.length !== current.length, trades: nextTrades };
  },
  async disconnectBanking() {
    localStorage.removeItem("bankingSettings");
    return defaultBankingState;
  },
  async getBankingBalances(_accountUid, _options) {
    throw new Error("Enable Banking balance refresh is available in the Electron app.");
  },
  async getBankingCashFlowTrend() {
    throw new Error("Enable Banking cash-flow trend refresh is available in the Electron app.");
  },
  async getBankingMonthlyExpenses() {
    throw new Error("Enable Banking expense refresh is available in the Electron app.");
  },
  async getBankingState() {
    try {
      const config = JSON.parse(localStorage.getItem("bankingSettings") || "{}");
      return {
        ...defaultBankingState,
        config: {
          ...defaultBankingState.config,
          ...config
        }
      };
    } catch {
      return defaultBankingState;
    }
  },
  async getMarketPulseData(options = {}) {
    const response = await fetch("/api/market-pulse", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(options)
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Market Pulse cache failed: ${response.status}`);
    }

    return response.json();
  },
  async getPortfolio() {
    return {
      dataDir: "Electron data folder",
      trades: parseTrades(sampleTradesCsv),
      marketData: DEFAULT_MARKET_DATA
    };
  },
  async getSettings() {
    try {
      return JSON.parse(localStorage.getItem("portfolioSettings") || "{}");
    } catch {
      return {};
    }
  },
  async getGeminiModels(apiKey) {
    if (!apiKey) return [];
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!response.ok) return [];
      const data = await response.json();
      return (data.models || [])
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && (m.name.includes("gemini") || m.name.includes("gemma")))
        .map((m) => ({
          id: m.name.replace("models/", ""),
          displayName: m.displayName || m.name,
          description: m.description || ""
        }));
    } catch {
      return [];
    }
  },
  async getStockIntel(options = {}) {
    const trades = parseTrades(sampleTradesCsv);
    const settings = await fallbackApi.getSettings();
    const marketResponse = await fetch("/api/market-data", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ trades, watchlist: settings.watchlist || [] })
    });

    if (!marketResponse.ok) {
      throw new Error(`Market refresh failed: ${marketResponse.status}`);
    }

    const { marketData } = await marketResponse.json();
    const intelResponse = await fetch("/api/stock-intel", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ trades, marketData, geminiApiKeys: settings.geminiApiKeys || [], geminiModel: settings.geminiModel })
    });

    if (!intelResponse.ok) {
      throw new Error(`Stock intelligence failed: ${intelResponse.status}`);
    }

    const { stockIntel } = await intelResponse.json();
    return { marketData, stockIntel };
  },
  async importCsv() {
    return { canceled: true };
  },
  async openDataFolder() {
    return { dataDir: "Electron data folder" };
  },
  async refreshMarketData() {
    const settings = await fallbackApi.getSettings();
    const response = await fetch("/api/market-data", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ trades: parseTrades(sampleTradesCsv), watchlist: settings.watchlist || [] })
    });

    if (!response.ok) {
      throw new Error(`Market refresh failed: ${response.status}`);
    }

    return response.json();
  },
  async refreshMarketPulseData(options = {}) {
    return fallbackApi.getMarketPulseData({ ...options, force: true });
  },
  async scanMarketUnderdogRadar(options = {}) {
    const settings = await fallbackApi.getSettings();
    const response = await fetch("/api/market-radar", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fmpApiKey: settings.fmpApiKey || "", options })
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Market radar failed: ${response.status}`);
    }

    return response.json();
  },
  async saveBankingSettings(settings) {
    const current = await fallbackApi.getBankingState();
    const config = {
      ...current.config,
      ...settings
    };
    localStorage.setItem("bankingSettings", JSON.stringify(config));
    return {
      ...current,
      config
    };
  },
  async saveSettings(settings) {
    const current = await fallbackApi.getSettings();
    const merged = { ...current, ...settings };
    localStorage.setItem("portfolioSettings", JSON.stringify(merged));
    return merged;
  },
  async searchBankingAspsps() {
    return [];
  },
  async setBankingTransactionCategory() {
    throw new Error("Banking category edits are available in the Electron app.");
  },
  async startBankAuthorization() {
    throw new Error("Enable Banking authorization is available in the Electron app.");
  },
  async selectMediaFolder(initialPath) {
    return { canceled: false, filePaths: [initialPath || DEFAULT_MEDIA_PIPELINE_PATHS.sourcePath] };
  },
  async selectTargetFolder(initialPath) {
    return { canceled: false, filePaths: [initialPath || DEFAULT_MEDIA_PIPELINE_PATHS.targetPath] };
  },
  async runMediaPipeline(sourcePath, targetPath, apiKey) {
    return { success: true, filesFound: 15, source: sourcePath, target: targetPath, apiKey };
  },
  async runMediaCleanup(targetPath, apiKey) {
    return { success: true, cleaned: true, target: targetPath, apiKey };
  },
  onPipelineLog() {
    return () => {};
  },
  onPipelineProgress() {
    return () => {};
  },
  onPipelineItem() {
    return () => {};
  }
};

export const portfolioApi = window.portfolioApi ?? fallbackApi;

function parseTrades(csvText) {
  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true
  });

  return parsed.data.map((row) => ({
    date: row.date,
    ticker: row.ticker,
    action: row.action,
    shares: Number(row.shares),
    total_amount: Number(row.total_amount),
    currency: row.currency
  }));
}

function getTradeKey(trade) {
  return [
    trade.date,
    String(trade.ticker || "").toUpperCase(),
    String(trade.action || "").toUpperCase(),
    Number(trade.shares).toFixed(8),
    Number(trade.total_amount).toFixed(8),
    String(trade.currency || "").toUpperCase()
  ].join("|");
}
