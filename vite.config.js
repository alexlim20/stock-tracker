import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs/promises";
import path from "node:path";
import { refreshMarketDataForTrades, scanMarketUnderdogRadar } from "./src/shared/marketData.js";
import {
  buildMarketPulseView,
  createSeedMarketPulseCache,
  getMarketPulseRefreshPlan,
  refreshMarketPulseCache
} from "./src/shared/marketPulseData.js";
import { refreshStockIntelligence } from "./src/shared/stockIntel.js";

const marketPulseCachePath = path.join(process.cwd(), "data", "market-pulse-cache.json");

export default defineConfig({
  plugins: [react(), marketDataApi()],
  build: {
    outDir: "dist",
    emptyOutDir: true
  }
});

function marketDataApi() {
  return {
    name: "market-data-api",
    configureServer(server) {
      server.middlewares.use("/api/market-data", handleMarketDataRequest);
      server.middlewares.use("/api/market-pulse", handleMarketPulseRequest);
      server.middlewares.use("/api/market-radar", handleMarketRadarRequest);
      server.middlewares.use("/api/stock-intel", handleStockIntelRequest);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/market-data", handleMarketDataRequest);
      server.middlewares.use("/api/market-pulse", handleMarketPulseRequest);
      server.middlewares.use("/api/market-radar", handleMarketRadarRequest);
      server.middlewares.use("/api/stock-intel", handleStockIntelRequest);
    }
  };
}

async function handleMarketDataRequest(req, res, next) {
  if (req.method !== "POST") {
    next();
    return;
  }

  try {
    const body = await readBody(req);
    const { trades, watchlist } = JSON.parse(body || "{}");
    const marketData = await refreshMarketDataForTrades(
      Array.isArray(trades) ? trades : [],
      Array.isArray(watchlist) ? watchlist : []
    );
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ marketData }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleMarketPulseRequest(req, res, next) {
  if (!["GET", "POST"].includes(req.method)) {
    next();
    return;
  }

  try {
    const body = req.method === "POST" ? await readBody(req) : "{}";
    const options = JSON.parse(body || "{}");
    const cache = await readMarketPulseCache();
    const force = Boolean(options.force);
    const plan = getMarketPulseRefreshPlan(cache);
    const usableCache = force ? await refreshMarketPulseCache(cache, { force: true }).catch(() => cache) : cache;

    if (usableCache !== cache) {
      await writeMarketPulseCache(usableCache);
    } else if (plan.fred || plan.market) {
      refreshMarketPulseCache(cache)
        .then(writeMarketPulseCache)
        .catch(() => {});
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: buildMarketPulseView(usableCache, options.timeframe || "1y") }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleMarketRadarRequest(req, res, next) {
  if (req.method !== "POST") {
    next();
    return;
  }

  try {
    const body = await readBody(req);
    const { fmpApiKey, options } = JSON.parse(body || "{}");
    const radar = await scanMarketUnderdogRadar({
      ...(options && typeof options === "object" ? options : {}),
      apiKey: fmpApiKey || process.env.FMP_API_KEY || ""
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ radar }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message }));
  }
}

async function handleStockIntelRequest(req, res, next) {
  if (req.method !== "POST") {
    next();
    return;
  }

  try {
    const body = await readBody(req);
    const { trades, marketData, geminiApiKeys, geminiApiKey, geminiModel } = JSON.parse(body || "{}");
    const keys = geminiApiKeys || (geminiApiKey ? [geminiApiKey] : []) || (process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY] : []);
    const stockIntel = await refreshStockIntelligence({
      trades: Array.isArray(trades) ? trades : [],
      marketData,
      geminiApiKeys: keys,
      geminiModel: geminiModel || ""
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ stockIntel }));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error.message }));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function readMarketPulseCache() {
  try {
    return JSON.parse(await fs.readFile(marketPulseCachePath, "utf8"));
  } catch {
    const seed = createSeedMarketPulseCache();
    await writeMarketPulseCache(seed);
    return seed;
  }
}

async function writeMarketPulseCache(cache) {
  await fs.mkdir(path.dirname(marketPulseCachePath), { recursive: true });
  await fs.writeFile(marketPulseCachePath, JSON.stringify(cache, null, 2), "utf8");
}
