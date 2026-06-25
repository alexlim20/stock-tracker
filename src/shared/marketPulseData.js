const FRED_TTL_MS = 24 * 60 * 60 * 1000;
const MARKET_TTL_MS = 90 * 60 * 1000;
const MAX_RENDER_POINTS = 650;
const DAY_MS = 24 * 60 * 60 * 1000;

const FRED_SERIES = {
  walcl: "WALCL",
  reverseRepo: "RRPONTSYD",
  treasuryGeneralAccount: "WTREGEN",
  ecbAssets: "ECBASSETSW",
  bojAssets: "JPNASSETS",
  usM2: "M2SL",
  chinaM2: "MYAGM2CNM189N",
  ecbM2: "EUM2SZPTA",
  ecbM2Fallback: "MYAGM2EZM196N",
  japanM2: "MYAGM2JPM189N",
  pbcAssets: "CHNCBBSASALM",
  coreCpi: "CPILFESL",
  corePpi: "WPSFD4131",
  initialClaims: "ICSA",
  continuingClaims: "CCSA",
  payrolls: "PAYEMS",
  realGdp: "A191RL1Q225SBEA",
  unemployment: "UNRATE",
  effectiveFedFundsRate: "FEDFUNDS"
};

const YAHOO_SYMBOLS = {
  btc: "BTC-USD",
  dxy: "DX-Y.NYB",
  sp500: "^GSPC",
  software: "IGV",
  gold: "GC=F",
  eurUsd: "EURUSD=X",
  jpyUsd: "JPYUSD=X",
  cnyUsd: "CNYUSD=X"
};

const DEFILLAMA_DAT_PAGE = "https://defillama.com/digital-asset-treasuries";
const DEFILLAMA_DAT_NEXT_DATA_PROXY = "https://r.jina.ai/http://r.jina.ai/http://https://defillama.com/_next/data";

const MARKET_PULSE_VERSION = 14;

export const MARKET_PULSE_TIMEFRAMES = {
  "30d": { key: "30d", days: 30, cadence: "day" },
  "1y": { key: "1y", days: 365, cadence: "day" },
  all: { key: "all", days: null, cadence: "auto" }
};

export function createSeedMarketPulseCache(now = new Date()) {
  const daily = buildSeedDailySeries(now);
  const monthly = buildSeedMonthlyDates(now);
  const fred = buildSeedFredRaw(daily, monthly);
  const market = buildSeedMarketRaw(daily, monthly);

  const raw = {
    fred,
    market
  };

  return {
    version: MARKET_PULSE_VERSION,
    updatedAt: now.toISOString(),
    sourceStatus: {
      fred: {
        lastFetchedAt: null,
        nextFetchAfter: now.toISOString(),
        ttlMs: FRED_TTL_MS,
        source: "FRED keyless CSV graph endpoint",
        failures: []
      },
      market: {
        lastFetchedAt: null,
        nextFetchAfter: now.toISOString(),
        ttlMs: MARKET_TTL_MS,
        source: "Yahoo Finance, CoinGecko Demo, Alternative.me, CNN, Blockchain.com, DefiLlama DAT",
        failures: []
      }
    },
    raw,
    fallback: true
  };
}

export function getMarketPulseCacheMeta(cache) {
  return {
    version: cache?.version ?? MARKET_PULSE_VERSION,
    updatedAt: cache?.updatedAt ?? null,
    sourceStatus: cache?.sourceStatus ?? {},
    fallback: Boolean(cache?.fallback)
  };
}

export function getMarketPulseRefreshPlan(cache, nowMs = Date.now()) {
  const isOutdated = Number(cache?.version) !== MARKET_PULSE_VERSION;
  const safeCache = normalizeMarketPulseCache(cache);
  return {
    fred: isOutdated || isSegmentDue(safeCache, "fred", nowMs),
    market: isOutdated || isSegmentDue(safeCache, "market", nowMs)
  };
}

export async function refreshMarketPulseCache(cache, options = {}) {
  const startedAt = new Date();
  const isOutdated = Number(cache?.version) !== MARKET_PULSE_VERSION;
  const safeCache = normalizeMarketPulseCache(cache);
  const force = Boolean(options.force);
  const plan = force || isOutdated
    ? { fred: true, market: true }
    : getMarketPulseRefreshPlan(safeCache, startedAt.getTime());
  const nextCache = {
    ...safeCache,
    raw: {
      fred: { ...safeCache.raw.fred },
      market: { ...safeCache.raw.market }
    },
    sourceStatus: {
      fred: { ...safeCache.sourceStatus.fred, failures: [] },
      market: { ...safeCache.sourceStatus.market, failures: [] }
    }
  };

  if (plan.fred) {
    const fredResult = await refreshFredSegment(nextCache.raw.fred);
    nextCache.raw.fred = fredResult.raw;
    nextCache.sourceStatus.fred = buildSegmentStatus("fred", startedAt, FRED_TTL_MS, fredResult.failures);
  }

  if (plan.market) {
    const marketResult = await refreshMarketSegment(nextCache.raw.market);
    nextCache.raw.market = marketResult.raw;
    nextCache.sourceStatus.market = buildSegmentStatus("market", startedAt, MARKET_TTL_MS, marketResult.failures);
  }

  return {
    ...nextCache,
    updatedAt: startedAt.toISOString(),
    fallback: false
  };
}

export function buildMarketPulseView(cache, timeframe = "1y") {
  const safeCache = normalizeMarketPulseCache(cache);
  const key = MARKET_PULSE_TIMEFRAMES[timeframe] ? timeframe : "1y";
  const raw = safeCache.raw;
  const dxy = selectSeries(raw.market.dxy, key);
  const cryptoFearGreed = raw.market.cryptoFearGreed?.at(-1) || { score: 50, label: "Neutral", tone: "neutral" };
  const equityFearGreed = raw.market.equityFearGreed?.at(-1) || { score: 50, label: "Neutral", tone: "neutral" };

  return {
    timeframe: key,
    meta: getMarketPulseCacheMeta(safeCache),
    kpis: {
      dxy: buildDxyKpi(dxy.length ? dxy : raw.market.dxy),
      cryptoFearGreed: normalizeSentimentPoint(cryptoFearGreed),
      equityFearGreed: normalizeSentimentPoint(equityFearGreed)
    },
    liquidity: {
      gliLeadLag: buildGliLeadLag(raw, key),
      walcl: selectSeries(raw.fred.walcl, key),
      goldDollar: buildGoldDollarSeries(raw, key)
    },
    inflation: {
      pipeline: buildInflationPipeline(raw, key),
      fedFundsRate: buildFedFundsRateSeries(raw, key)
    },
    labor: {
      claims: buildClaimsSeries(raw, key),
      payrolls: buildPayrollSeries(raw, key),
      growth: buildGrowthSeries(raw, key)
    },
    valuation: {
      bands: {
        BTC: buildMaBands(raw.market.btcUsd, key, "BTC"),
        Gold: buildMaBands(raw.market.gold, key, "Gold"),
        "S&P 500": buildMaBands(raw.market.sp500, key, "S&P 500")
      },
      mvrv: buildMvrvBands(raw, key),
      datInflows: buildDatInflows(raw.market.datInflows, key),
      relativePerformance: buildRelativePerformance(raw, key)
    }
  };
}

async function refreshFredSegment(previousRaw) {
  const failures = [];
  const fetched = {};

  await Promise.all(Object.entries(FRED_SERIES).map(async ([key, seriesId]) => {
    try {
      fetched[key] = await fetchFredSeries(seriesId);
    } catch (error) {
      failures.push({ source: "FRED", series: seriesId, message: error.message });
    }
  }));

  const rawEcbM2 = (fetched.ecbM2 && fetched.ecbM2.length > 0) ? fetched.ecbM2 : fetched.ecbM2Fallback;
  const ecbM2Mapped = rawEcbM2?.map((point) => ({ date: point.date, value: round(point.value / 1_000_000_000_000, 4) }));

  const japanM2Mapped = fetched.japanM2?.map((point) => ({ date: point.date, value: round(point.value / 1_000_000_000_000, 4) }));

  const rawChinaM2 = fetched.chinaM2 || previousRaw.chinaM2;
  let pbcAssetsMapped = (fetched.pbcAssets && fetched.pbcAssets.length > 0)
    ? fetched.pbcAssets.map((point) => ({ date: point.date, value: round(point.value / 1_000_000_000_000, 4) }))
    : null;
  if (!pbcAssetsMapped && rawChinaM2) {
    pbcAssetsMapped = rawChinaM2.map((point) => {
      const valInTrillions = point.value > 10000 ? point.value / 1_000_000_000_000 : point.value;
      return { date: point.date, value: round(valInTrillions * 0.16, 4) };
    });
  }
  const fedFundsRateMapped = fetched.effectiveFedFundsRate?.map((point) => ({ date: point.date, value: round(point.value, 3) }));

  return {
    raw: {
      ...previousRaw,
      walcl: sanitizePositiveSeries(fetched.walcl?.map((point) => ({ date: point.date, value: round(point.value / 1_000_000, 4) }))) || sanitizePositiveSeries(previousRaw.walcl),
      reverseRepo: sanitizeNonNegativeSeries(fetched.reverseRepo?.map((point) => ({ date: point.date, value: round(point.value / 1000, 4) }))) || sanitizeNonNegativeSeries(previousRaw.reverseRepo),
      treasuryGeneralAccount: sanitizeNonNegativeSeries(fetched.treasuryGeneralAccount?.map((point) => ({ date: point.date, value: round(point.value / 1_000_000, 4) }))) || sanitizeNonNegativeSeries(previousRaw.treasuryGeneralAccount),
      ecbAssets: sanitizePositiveSeries(fetched.ecbAssets?.map((point) => ({ date: point.date, value: round(point.value / 1_000_000, 4) }))) || sanitizePositiveSeries(previousRaw.ecbAssets),
      bojAssets: sanitizePositiveSeries(fetched.bojAssets?.map((point) => ({ date: point.date, value: round(point.value / 10000, 4) }))) || sanitizePositiveSeries(previousRaw.bojAssets),
      usM2: sanitizePositiveSeries(fetched.usM2?.map((point) => ({ date: point.date, value: round(point.value / 1000, 4) }))) || sanitizePositiveSeries(previousRaw.usM2),
      chinaM2: sanitizePositiveSeries(fetched.chinaM2?.map((point) => ({ date: point.date, value: round(point.value / 1_000_000_000_000, 4) }))) || sanitizePositiveSeries(previousRaw.chinaM2),
      ecbM2: sanitizePositiveSeries(ecbM2Mapped) || sanitizePositiveSeries(previousRaw.ecbM2),
      japanM2: sanitizePositiveSeries(japanM2Mapped) || sanitizePositiveSeries(previousRaw.japanM2),
      pbcAssets: sanitizePositiveSeries(pbcAssetsMapped) || sanitizePositiveSeries(previousRaw.pbcAssets),
      coreCpi: sanitizeFredIndexSeries(fetched.coreCpi) || sanitizeFredIndexSeries(previousRaw.coreCpi),
      corePpi: sanitizeFredIndexSeries(fetched.corePpi) || sanitizeFredIndexSeries(previousRaw.corePpi),
      initialClaims: sanitizePositiveSeries(fetched.initialClaims?.map((point) => ({ date: point.date, value: round(point.value / 1000, 2) }))) || sanitizePositiveSeries(previousRaw.initialClaims),
      continuingClaims: sanitizePositiveSeries(fetched.continuingClaims?.map((point) => ({ date: point.date, value: round(point.value / 1000, 2) }))) || sanitizePositiveSeries(previousRaw.continuingClaims),
      payrolls: sanitizePositiveSeries(fetched.payrolls) || sanitizePositiveSeries(previousRaw.payrolls),
      realGdp: sanitizeFiniteSeries(fetched.realGdp) || sanitizeFiniteSeries(previousRaw.realGdp),
      unemployment: sanitizePositiveSeries(fetched.unemployment) || sanitizePositiveSeries(previousRaw.unemployment),
      effectiveFedFundsRate: sanitizeNonNegativeSeries(fedFundsRateMapped) || sanitizeNonNegativeSeries(previousRaw.effectiveFedFundsRate)
    },
    failures
  };
}

async function refreshMarketSegment(previousRaw) {
  const failures = [];
  const now = new Date();
  const from2010 = Math.floor(Date.UTC(2010, 0, 1) / 1000);
  const toNow = Math.floor(now.getTime() / 1000);
  const startIso = "2010-01-01";
  const endIso = now.toISOString().slice(0, 10);

  const results = await Promise.allSettled([
    fetchBitcoinPrices(startIso, endIso, from2010, toNow),
    fetchYahooChart(YAHOO_SYMBOLS.dxy, startIso, endIso),
    fetchYahooChart(YAHOO_SYMBOLS.sp500, startIso, endIso),
    fetchYahooChart(YAHOO_SYMBOLS.software, startIso, endIso),
    fetchYahooChart(YAHOO_SYMBOLS.gold, startIso, endIso),
    fetchYahooChart(YAHOO_SYMBOLS.eurUsd, startIso, endIso),
    fetchYahooChart(YAHOO_SYMBOLS.jpyUsd, startIso, endIso),
    fetchYahooChart(YAHOO_SYMBOLS.cnyUsd, startIso, endIso),
    fetchAlternativeFearGreed(),
    fetchCnnFearGreed(),
    fetchCoinMetricsMvrv(),
    fetchDefillamaDatInflows()
  ]);

  const [btc, dxy, sp500, software, gold, eurUsd, jpyUsd, cnyUsd, cryptoFearGreed, equityFearGreed, mvrvRatio, datInflows] = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    failures.push({ source: "market", index, message: result.reason?.message || "Unknown market refresh failure" });
    return null;
  });

  return {
    raw: {
      ...previousRaw,
      btcUsd: btc?.length ? btc : previousRaw.btcUsd,
      dxy: dxy?.length ? dxy.map(toValuePointFromClose) : previousRaw.dxy,
      sp500: sp500?.length ? sp500 : previousRaw.sp500,
      software: software?.length ? software : previousRaw.software,
      gold: gold?.length ? gold : previousRaw.gold,
      eurUsd: eurUsd?.length ? eurUsd.map(toValuePointFromClose) : previousRaw.eurUsd,
      jpyUsd: jpyUsd?.length ? jpyUsd.map(toValuePointFromClose) : previousRaw.jpyUsd,
      cnyUsd: cnyUsd?.length ? cnyUsd.map(toValuePointFromClose) : previousRaw.cnyUsd,
      cryptoFearGreed: cryptoFearGreed?.length ? cryptoFearGreed : previousRaw.cryptoFearGreed,
      equityFearGreed: equityFearGreed?.length ? equityFearGreed : previousRaw.equityFearGreed,
      mvrvRatio: mvrvRatio?.length ? mvrvRatio : previousRaw.mvrvRatio,
      datInflows: datInflows?.length ? mergeDatInflows(previousRaw.datInflows, datInflows) : normalizeDatInflows(previousRaw.datInflows)
    },
    failures
  };
}

async function fetchFredSeries(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const text = await fetchText(url);
  const lines = text.trim().split(/\r?\n/).slice(1);
  return lines
    .map((line) => {
      const [date, value] = line.split(",");
      const numeric = Number(value);
      if (!date || !Number.isFinite(numeric)) return null;
      return { date, value: numeric };
    })
    .filter(Boolean);
}

async function fetchYahooChart(symbol, startDate, endDate, interval = "1d") {
  const period1 = Math.floor(new Date(`${startDate}T00:00:00.000Z`).getTime() / 1000);
  const period2 = Math.floor(new Date(`${endDate}T23:59:59.000Z`).getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${interval}&events=history`;
  const data = await fetchJson(url);
  const result = data.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  if (!timestamps.length) throw new Error(`Yahoo returned no chart data for ${symbol}`);

  return timestamps.map((stamp, index) => {
    const close = Number(quote.close?.[index]);
    if (!Number.isFinite(close)) return null;
    return {
      date: new Date(stamp * 1000).toISOString().slice(0, 10),
      open: readFinite(quote.open?.[index], close),
      high: readFinite(quote.high?.[index], close),
      low: readFinite(quote.low?.[index], close),
      close
    };
  }).filter(Boolean);
}

async function fetchBitcoinPrices(startDate, endDate, from, to) {
  try {
    const yahoo = await fetchYahooChart(YAHOO_SYMBOLS.btc, startDate, endDate);
    if (yahoo.length) return yahoo;
  } catch {
    // CoinGecko has stricter demo limits now; keep it as a free fallback when it is available.
  }

  return fetchCoinGeckoBitcoin(from, to);
}

async function fetchCoinGeckoBitcoin(from, to) {
  const url = `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;
  const data = await fetchJson(url);
  const prices = data.prices || [];
  if (!prices.length) throw new Error("CoinGecko returned no Bitcoin prices");
  return aggregateDailyPrices(prices.map(([timestamp, price]) => ({
    date: new Date(timestamp).toISOString().slice(0, 10),
    value: Number(price)
  })));
}

async function fetchAlternativeFearGreed() {
  const data = await fetchJson("https://api.alternative.me/fng/?limit=30&format=json");
  const rows = Array.isArray(data.data) ? data.data : [];
  return rows
    .map((row) => normalizeSentimentPoint({
      date: new Date(Number(row.timestamp) * 1000).toISOString().slice(0, 10),
      score: Number(row.value),
      label: row.value_classification
    }))
    .reverse();
}

async function fetchCnnFearGreed() {
  const data = await fetchJson("https://production.dataviz.cnn.io/index/fearandgreed/graphdata");
  const score = Number(data.fear_and_greed?.score);
  if (!Number.isFinite(score)) throw new Error("CNN Fear & Greed score unavailable");
  return [normalizeSentimentPoint({
    date: new Date().toISOString().slice(0, 10),
    score,
    label: data.fear_and_greed?.rating
  })];
}

async function fetchCoinMetricsMvrv() {
  try {
    const url = "https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=btc&metrics=CapMVRVCur&frequency=1d&start_time=2011-01-01&page_size=10000&paging_from=start";
    const data = await fetchJson(url);
    const rows = data.data || [];
    const parsed = rows.map((row) => {
      const value = Number(row.CapMVRVCur);
      if (!row.time || !Number.isFinite(value) || value <= 0) return null;
      return {
        date: new Date(row.time).toISOString().slice(0, 10),
        value
      };
    }).filter(Boolean);
    if (parsed.length) return parsed;
  } catch {
    // Keep the legacy public endpoint as a last resort if Coin Metrics is unavailable.
  }

  const data = await fetchJson("https://api.blockchain.info/charts/mvrv?timespan=all&format=json&sampled=false");
  const rows = data.values || [];
  return rows.map((row) => {
    const value = Number(row.y);
    if (!Number.isFinite(value) || value <= 0) return null;
    return {
      date: new Date(Number(row.x) * 1000).toISOString().slice(0, 10),
      value
    };
  }).filter(Boolean);
}

async function fetchDefillamaDatInflows() {
  try {
    const data = await fetchJson("https://api.llama.fi/dat/institutions");
    const rows = parseDefillamaDatRows(data);
    if (rows.length) return rows;
  } catch {
    // DefiLlama's public DAT API currently 404s from Node, while the site serves the same data via SSG props.
  }

  const buildId = await fetchDefillamaBuildId();
  const proxyUrl = `${DEFILLAMA_DAT_NEXT_DATA_PROXY}/${buildId}/digital-asset-treasuries.json`;
  const text = await fetchText(proxyUrl, {}, 45000);
  const jsonText = extractJsonPayload(text);
  const data = JSON.parse(jsonText);
  const rows = parseDefillamaDatRows(data.pageProps || data);
  if (!rows.length) throw new Error("DefiLlama DAT page returned no flow data");
  return rows;
}

async function fetchDefillamaBuildId() {
  const probeUrl = `${DEFILLAMA_DAT_PAGE}.csv`;
  const response = await fetchWithTimeout(probeUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  }, 20000);
  const html = await response.text();
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!nextDataMatch) throw new Error("DefiLlama build id unavailable");
  const nextData = JSON.parse(nextDataMatch[1]);
  if (!nextData?.buildId) throw new Error("DefiLlama build id missing");
  return nextData.buildId;
}

function extractJsonPayload(text) {
  const index = String(text || "").indexOf("{");
  if (index < 0) throw new Error("DefiLlama DAT JSON payload missing");
  return text.slice(index).trim();
}

function parseDefillamaDatRows(data) {
  const dailyFlowsByAsset = data?.dailyFlowsByAsset || buildDailyFlowsByAsset(data);
  const rows = [];

  for (const [assetName, series] of Object.entries(dailyFlowsByAsset || {})) {
    const key = getDatAssetKey(assetName);
    const points = Array.isArray(series?.points) ? series.points : [];
    for (const point of points) {
      const timestamp = Number(point?.[0]);
      const value = Number(point?.[1]);
      if (!Number.isFinite(timestamp) || !Number.isFinite(value)) continue;
      rows.push({
        date: new Date(timestamp).toISOString().slice(0, 10),
        btc: key === "btc" ? value / 1_000_000_000 : 0,
        eth: key === "eth" ? value / 1_000_000_000 : 0,
        sol: key === "sol" ? value / 1_000_000_000 : 0,
        other: key === "other" ? value / 1_000_000_000 : 0
      });
    }
  }

  return normalizeDatInflows(rows);
}

function buildDailyFlowsByAsset(data) {
  const flows = data?.flows || {};
  const assetMetadata = data?.assetMetadata || {};
  const output = {};

  for (const [asset, tuples] of Object.entries(flows)) {
    const name = assetMetadata[asset]?.name || asset;
    output[name] = {
      name,
      points: (Array.isArray(tuples) ? tuples : []).map((tuple) => {
        const timestamp = Number(tuple?.[0]);
        const value = Number(tuple?.[4] ?? tuple?.[5] ?? 0);
        return [timestamp < 1e12 ? timestamp * 1000 : timestamp, value];
      })
    };
  }

  return output;
}

function getDatAssetKey(assetName) {
  const normalized = String(assetName || "").trim().toLowerCase();
  if (normalized === "bitcoin") return "btc";
  if (normalized === "ethereum") return "eth";
  if (normalized === "solana") return "sol";
  return "other";
}

function mergeDatInflows(existing, incoming) {
  const byDate = new Map();
  for (const point of normalizeDatInflows(existing)) {
    byDate.set(point.date, point);
  }
  for (const point of normalizeDatInflows(incoming)) {
    byDate.set(point.date, point);
  }
  return normalizeDatInflows([...byDate.values()]);
}

function buildDatInflows(series, timeframe) {
  const rows = normalizeDatInflows(series);
  if (!rows.length) return [];

  const config = MARKET_PULSE_TIMEFRAMES[timeframe] || MARKET_PULSE_TIMEFRAMES["1y"];
  let selected = rows;
  if (config.days) {
    const latest = parseDate(rows.at(-1).date);
    const cutoff = new Date(latest.getTime() - config.days * DAY_MS);
    selected = rows.filter((point) => parseDate(point.date) >= cutoff);
    if (!selected.length) selected = rows.slice(-Math.min(rows.length, config.days + 1));
  }

  const cadence = timeframe === "30d" ? "day" : timeframe === "1y" ? "week" : "month";
  return bucketDatInflows(selected, cadence);
}

function bucketDatInflows(rows, cadence) {
  const buckets = new Map();
  for (const row of rows) {
    const date = cadence === "day" ? row.date : getDatBucketDate(row.date, cadence);
    const current = buckets.get(date) || { date, btc: 0, eth: 0, sol: 0, other: 0 };
    current.btc += Number(row.btc) || 0;
    current.eth += Number(row.eth) || 0;
    current.sol += Number(row.sol) || 0;
    current.other += Number(row.other) || 0;
    buckets.set(date, current);
  }
  return normalizeDatInflows([...buckets.values()]);
}

function getDatBucketDate(dateText, cadence) {
  const date = parseDate(dateText);
  if (cadence === "week") {
    const day = date.getUTCDay();
    const offsetToSunday = day === 0 ? 0 : 7 - day;
    const weekEnd = new Date(date.getTime() + offsetToSunday * DAY_MS);
    return weekEnd.toISOString().slice(0, 10);
  }
  const monthEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return monthEnd.toISOString().slice(0, 10);
}

function normalizeDatInflows(series) {
  const grouped = new Map();
  for (const point of Array.isArray(series) ? series : []) {
    const date = normalizeDatDate(point?.date);
    if (!date) continue;
    const current = grouped.get(date) || { date, btc: 0, eth: 0, sol: 0, other: 0 };
    current.btc += readDatFlowValue(point?.btc);
    current.eth += readDatFlowValue(point?.eth);
    current.sol += readDatFlowValue(point?.sol);
    current.other += readDatFlowValue(point?.other);
    grouped.set(date, current);
  }

  return [...grouped.values()]
    .map((point) => ({
      date: point.date,
      btc: round(point.btc, 2),
      eth: round(point.eth, 2),
      sol: round(point.sol, 2),
      other: round(point.other, 2)
    }))
    .filter((point) => totalDatMagnitude(point) > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function totalDatMagnitude(point) {
  return ["btc", "eth", "sol", "other"].reduce((sum, key) => sum + Math.abs(Number(point?.[key]) || 0), 0);
}

function normalizeDatDate(value) {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  if (/^\d{4}-\d{2}$/.test(text)) return `${text}-01`;
  return "";
}

function readDatFlowValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function buildDxyKpi(series = []) {
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted.at(-1)?.value ?? 0;
  const previous = sorted.at(-2)?.value ?? latest;
  return {
    value: latest,
    changePct: previous ? ((latest - previous) / previous) * 100 : 0,
    sparkline: sorted.slice(-30).map((point) => ({ date: point.date, value: point.value }))
  };
}

function buildGliLeadLag(raw, timeframe) {
  const btc = raw.market.btcUsd.map((point) => ({ date: point.date, btc: point.close }));
  const liquidity = buildGlobalLiquidityProxy(raw);
  const joined = btc.map((point) => {
    const priorDate = addDays(point.date, -75);
    const liquidityPoint = getPointAtOrBefore(liquidity, priorDate);
    return liquidityPoint
      ? {
          date: point.date,
          btc: point.btc,
          gliShifted: liquidityPoint.value
        }
      : null;
  }).filter(Boolean);
  return selectSeries(joined, timeframe);
}

function buildGlobalLiquidityProxy(raw) {
  const walcl = sanitizePositiveSeries(raw.fred.walcl) || [];
  const ecbAssets = sanitizePositiveSeries(raw.fred.ecbAssets) || [];
  const bojAssets = sanitizePositiveSeries(raw.fred.bojAssets) || [];
  const reverseRepo = sanitizeNonNegativeSeries(raw.fred.reverseRepo) || [];
  const treasuryGeneralAccount = sanitizeNonNegativeSeries(raw.fred.treasuryGeneralAccount) || [];
  const usM2 = sanitizePositiveSeries(raw.fred.usM2) || [];
  const chinaM2 = sanitizePositiveSeries(raw.fred.chinaM2) || [];
  const ecbM2 = sanitizePositiveSeries(raw.fred.ecbM2) || [];
  const japanM2 = sanitizePositiveSeries(raw.fred.japanM2) || [];
  const pbcAssets = sanitizePositiveSeries(raw.fred.pbcAssets) || [];

  const eurUsd = sanitizePositiveSeries(raw.market.eurUsd) || [];
  const jpyUsd = sanitizePositiveSeries(raw.market.jpyUsd) || [];
  const cnyUsd = sanitizePositiveSeries(raw.market.cnyUsd) || [];

  return walcl.map((point) => {
    const ecbPoint = getPointAtOrBefore(ecbAssets, point.date);
    const bojPoint = getPointAtOrBefore(bojAssets, point.date);
    const reverseRepoPoint = getPointAtOrBefore(reverseRepo, point.date);
    const treasuryPoint = getPointAtOrBefore(treasuryGeneralAccount, point.date);
    const usM2Point = getPointAtOrBefore(usM2, point.date);
    const chinaM2Point = getPointAtOrBefore(chinaM2, point.date);
    const ecbM2Point = getPointAtOrBefore(ecbM2, point.date);
    const japanM2Point = getPointAtOrBefore(japanM2, point.date);
    const pbcPoint = getPointAtOrBefore(pbcAssets, point.date);

    const eurUsdPoint = getPointAtOrBefore(eurUsd, point.date);
    const jpyUsdPoint = getPointAtOrBefore(jpyUsd, point.date);
    const cnyUsdPoint = getPointAtOrBefore(cnyUsd, point.date);

    // Open, additive chain in absolute USD
    let totalUSD = 0;

    // United States Base
    const fedAssets = Number(point.value) * 1_000_000_000_000;
    const reverseRepoValue = Number(reverseRepoPoint?.value || 0) * 1_000_000_000_000;
    const tgaValue = Number(treasuryPoint?.value || 0) * 1_000_000_000_000;

    totalUSD += fedAssets;
    totalUSD -= reverseRepoValue;
    totalUSD -= tgaValue;

    // International Central Bank Assets
    const ecbAssetsUSD = Number(ecbPoint?.value || 0) * Number(eurUsdPoint?.value || 0) * 1_000_000_000_000;
    totalUSD += ecbAssetsUSD;

    const bojAssetsUSD = Number(bojPoint?.value || 0) * Number(jpyUsdPoint?.value || 0) * 1_000_000_000_000;
    totalUSD += bojAssetsUSD;

    // Money Supply Aggregates
    const usM2USD = Number(usM2Point?.value || 0) * 1_000_000_000_000;
    totalUSD += usM2USD;

    const chinaM2USD = Number(chinaM2Point?.value || 0) * Number(cnyUsdPoint?.value || 0) * 1_000_000_000_000;
    totalUSD += chinaM2USD;

    // Eurozone M2 Money Supply
    const ecbM2USD = Number(ecbM2Point?.value || 0) * Number(eurUsdPoint?.value || 0) * 1_000_000_000_000;
    totalUSD += ecbM2USD;

    // Japan M2 Money Supply
    const japanM2USD = Number(japanM2Point?.value || 0) * Number(jpyUsdPoint?.value || 0) * 1_000_000_000_000;
    totalUSD += japanM2USD;

    // China Central Bank Assets (PBOC)
    const pbcAssetsUSD = Number(pbcPoint?.value || 0) * Number(cnyUsdPoint?.value || 0) * 1_000_000_000_000;
    totalUSD += pbcAssetsUSD;

    // Calculate absolute index (divide by 1 Trillion)
    const globalLiquidity = totalUSD / 1_000_000_000_000;
    if (!Number.isFinite(globalLiquidity) || globalLiquidity <= 0) return null;

    return {
      date: point.date,
      value: round(globalLiquidity, 4)
    };
  }).filter(Boolean);
}

function buildGoldDollarSeries(raw, timeframe) {
  const OFFICIAL_SECTOR_GOLD_TROY_OUNCES = 1_000_000_000;
  const TRILLION = 1_000_000_000_000;
  const goldValue = sanitizeOhlcSeries(raw.market.gold, { asset: "Gold" })
    .map((point) => ({
      date: point.date,
      value: round((point.close * OFFICIAL_SECTOR_GOLD_TROY_OUNCES) / TRILLION, 3)
    }))
    .filter((point) => Number.isFinite(point.value) && point.value > 0 && point.value < 10);
  const dxy = normalizeToIndex(raw.market.dxy, "value", true);
  const merged = mergeByPrimaryDates(goldValue, { leftKey: "goldReserves" }, dxy, { rightKey: "usdReserves" })
    .map((point) => ({
      date: point.date,
      goldReserves: round(point.goldReserves, 3),
      usdReserves: round(point.usdReserves / 26, 3)
    }));
  return selectSeries(merged, timeframe);
}

function buildInflationPipeline(raw, timeframe) {
  const coreCpi = yoy(raw.fred.coreCpi);
  const corePpi = yoy(raw.fred.corePpi);
  return selectSeries(mergeByPrimaryDates(coreCpi, { leftKey: "coreCpi" }, corePpi, { rightKey: "corePpi" }), timeframe, { fillDaily: true, rejectKeys: ["coreCpi", "corePpi"] });
}

function buildFedFundsRateSeries(raw, timeframe) {
  return selectSeries(sanitizeNonNegativeSeries(raw.fred.effectiveFedFundsRate) || [], timeframe, {
    fillDaily: timeframe !== "all"
  });
}

function buildClaimsSeries(raw, timeframe) {
  const claims = normalizeClaimsInput(raw.fred.initialClaims, raw.fred.continuingClaims);
  return selectSeries(mergeByPrimaryDates(
    claims.initialClaims,
    { leftKey: "initial" },
    claims.continuingClaims,
    { rightKey: "continuing" }
  ), timeframe, { fillDaily: true });
}

function buildPayrollSeries(raw, timeframe) {
  const payrolls = raw.fred.payrolls
    .map((point, index, rows) => {
      if (index === 0) return null;
      const jobs = round(point.value - rows[index - 1].value, 0);
      return {
        date: point.date,
        jobs,
        jobsDisplay: clamp(jobs, -1000, 1000)
      };
    })
    .filter(Boolean);
  return selectSeries(payrolls, timeframe);
}

function buildGrowthSeries(raw, timeframe) {
  return selectSeries(mergeByPrimaryDates(
    raw.fred.realGdp,
    { leftKey: "realGdp" },
    raw.fred.unemployment,
    { rightKey: "unemployment" }
  ), timeframe, { fillDaily: true });
}

function buildMaBands(priceSeries, timeframe, asset = "BTC") {
  const multipliers = getBandMultipliers(asset);
  const weekly = toWeeklyOhlc(sanitizeOhlcSeries(priceSeries, { asset }));
  const withBands = weekly.map((point, index, rows) => {
    if (index < 199) return null;
    const window = rows.slice(index - 199, index + 1);
    const ma200w = average(window.map((row) => row.close));
    return {
      ...point,
      ma200w: round(ma200w, 2),
      band1: round(ma200w * (1 + multipliers[0]), 2),
      band2: round(ma200w * (1 + multipliers[1]), 2),
      band3: round(ma200w * (1 + multipliers[2]), 2),
      band4: round(ma200w * (1 + multipliers[3]), 2),
      bandLabels: multipliers.map((multiplier) => `+${Math.round(multiplier * 100)}%`),
      candleBody: [round(Math.min(point.open, point.close), 2), round(Math.max(point.open, point.close), 2)],
      wickRange: [round(point.low, 2), round(point.high, 2)]
    };
  }).filter(Boolean);
  return selectSeries(withBands, timeframe, { preserveWeekly: true });
}

function buildMvrvBands(raw, timeframe) {
  const btc = raw.market.btcUsd.map((point) => ({ date: point.date, price: point.close }));
  const mvrv = raw.market.mvrvRatio;
  const joined = btc.map((point) => {
    const ratioPoint = getPointAtOrBefore(mvrv, point.date);
    if (!ratioPoint || !Number.isFinite(ratioPoint.value) || ratioPoint.value <= 0) return null;
    return { date: point.date, price: point.price, ratio: ratioPoint.value };
  }).filter(Boolean);

  const historicalRatios = joined.map((point) => point.ratio);
  const meanMvrv = average(historicalRatios);
  const stdMvrv = standardDeviation(historicalRatios);

  const withBands = joined.map((point) => {
    const realizedPrice = point.price / point.ratio;
    return {
      date: point.date,
      price: round(point.price, 2),
      minus1Sigma: round(realizedPrice * (meanMvrv - stdMvrv), 2),
      minusHalfSigma: round(realizedPrice * (meanMvrv - stdMvrv * 0.5), 2),
      mean: round(realizedPrice * meanMvrv, 2),
      plusHalfSigma: round(realizedPrice * (meanMvrv + stdMvrv * 0.5), 2),
      plus1Sigma: round(realizedPrice * (meanMvrv + stdMvrv), 2)
    };
  });

  return selectSeries(withBands, timeframe);
}

function buildRelativePerformance(raw, timeframe) {
  const btc = raw.market.btcUsd.map((point) => ({ date: point.date, value: point.close }));
  const sp500 = raw.market.sp500.map((point) => ({ date: point.date, value: point.close }));
  const software = raw.market.software.map((point) => ({ date: point.date, value: point.close }));
  const joined = btc.map((point) => {
    const spPoint = getPointAtOrBefore(sp500, point.date);
    const softwarePoint = getPointAtOrBefore(software, point.date);
    if (!spPoint || !softwarePoint) return null;
    return {
      date: point.date,
      btcPrice: point.value,
      sp500Price: spPoint.value,
      softwarePrice: softwarePoint.value
    };
  }).filter(Boolean);
  const selected = selectSeries(joined, timeframe);
  if (!selected.length) return [];
  const first = selected[0];
  return selected.map((point, index) => ({
    date: point.date,
    btc: index === 0 ? 0 : round(((point.btcPrice - first.btcPrice) / first.btcPrice) * 100, 2),
    software: index === 0 ? 0 : round(((point.softwarePrice - first.softwarePrice) / first.softwarePrice) * 100, 2),
    sp500: index === 0 ? 0 : round(((point.sp500Price - first.sp500Price) / first.sp500Price) * 100, 2)
  }));
}

function selectSeries(series, timeframe, options = {}) {
  const rows = [...(Array.isArray(series) ? series : [])]
    .filter((point) => isRenderablePoint(point, options.rejectKeys))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return [];
  const config = MARKET_PULSE_TIMEFRAMES[timeframe] || MARKET_PULSE_TIMEFRAMES["1y"];
  let selected = rows;

  if (config.days) {
    const latest = parseDate(rows.at(-1).date);
    const cutoff = new Date(latest.getTime() - config.days * DAY_MS);
    if (options.fillDaily) {
      return limitPoints(fillForwardDaily(rows, cutoff, latest), MAX_RENDER_POINTS);
    }
    selected = rows.filter((point) => parseDate(point.date) >= cutoff);
    return limitPoints(selected.length ? selected : rows.slice(-Math.min(rows.length, config.days + 1)), MAX_RENDER_POINTS);
  }

  if (options.preserveWeekly) return limitPoints(rows, MAX_RENDER_POINTS);
  return downsampleAll(rows);
}

function downsampleAll(rows) {
  if (rows.length <= MAX_RENDER_POINTS) return rows;
  const monthly = bucketLast(rows, "month");
  if (monthly.length <= MAX_RENDER_POINTS) return monthly;
  return limitPoints(bucketLast(rows, "week"), MAX_RENDER_POINTS);
}

function fillForwardDaily(rows, startDate, endDate) {
  const output = [];
  for (let time = startDate.getTime(); time <= endDate.getTime(); time += DAY_MS) {
    const date = new Date(time).toISOString().slice(0, 10);
    const point = getPointAtOrBefore(rows, date);
    if (!point) continue;
    output.push({ ...point, date });
  }
  return output;
}

function isRenderablePoint(point, keys = null) {
  if (!point?.date) return false;
  const checkKeys = Array.isArray(keys) && keys.length
    ? keys
    : Object.keys(point).filter((key) => !["date", "bandLabels"].includes(key));
  return checkKeys.every((key) => {
    const rawValue = point[key];
    if (Array.isArray(rawValue)) {
      return rawValue.every((entry) => Number.isFinite(Number(entry)) && Math.abs(Number(entry)) < 1_000_000_000);
    }
    const value = Number(rawValue);
    return Number.isFinite(value) && Math.abs(value) < 1_000_000_000;
  });
}

function getBandMultipliers(asset) {
  return asset === "BTC" ? [0.25, 0.5, 0.75, 1] : [0.1, 0.2, 0.3, 0.4];
}

function sanitizeOhlcSeries(series, { asset = "" } = {}) {
  const maxClose = asset === "Gold" ? 2600 : asset === "S&P 500" ? 10000 : 1_000_000;
  return (Array.isArray(series) ? series : [])
    .map((point) => ({
      date: String(point?.date || ""),
      open: Number(point?.open),
      high: Number(point?.high),
      low: Number(point?.low),
      close: Number(point?.close)
    }))
    .filter((point) => (
      /^\d{4}-\d{2}-\d{2}$/.test(point.date) &&
      [point.open, point.high, point.low, point.close].every((value) => Number.isFinite(value) && value > 0 && value <= maxClose) &&
      point.high >= point.low
    ))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function bucketLast(rows, cadence) {
  const buckets = new Map();
  for (const row of rows) {
    const date = parseDate(row.date);
    const key = cadence === "month"
      ? `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`
      : `${date.getUTCFullYear()}-${String(getUtcWeek(date)).padStart(2, "0")}`;
    buckets.set(key, row);
  }
  return [...buckets.values()];
}

function limitPoints(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const step = Math.ceil(rows.length / maxPoints);
  return rows.filter((_row, index) => index % step === 0 || index === rows.length - 1);
}

export function normalizeMarketPulseCache(cache) {
  const seed = createSeedMarketPulseCache();
  if (!cache || typeof cache !== "object") return seed;
  const shouldResetDatInflows = Number(cache?.version) < 10;
  const normalized = {
    ...seed,
    ...cache,
    version: MARKET_PULSE_VERSION,
    sourceStatus: {
      fred: { ...seed.sourceStatus.fred, ...cache.sourceStatus?.fred },
      market: { ...seed.sourceStatus.market, ...cache.sourceStatus?.market }
    },
    raw: {
      fred: { ...seed.raw.fred, ...cache.raw?.fred },
      market: {
        ...seed.raw.market,
        ...cache.raw?.market,
        datInflows: shouldResetDatInflows ? [] : cache.raw?.market?.datInflows
      }
    }
  };

  normalized.raw.fred = sanitizeFredRaw(normalized.raw.fred);
  normalized.raw.market = sanitizeMarketRaw(normalized.raw.market);
  return normalized;
}

function sanitizeFredRaw(fred = {}) {
  return {
    ...fred,
    walcl: sanitizePositiveSeries(fred.walcl) || [],
    reverseRepo: sanitizeNonNegativeSeries(fred.reverseRepo) || [],
    treasuryGeneralAccount: sanitizeNonNegativeSeries(fred.treasuryGeneralAccount) || [],
    ecbAssets: sanitizePositiveSeries(fred.ecbAssets) || [],
    bojAssets: sanitizePositiveSeries(fred.bojAssets) || [],
    usM2: sanitizePositiveSeries(fred.usM2) || [],
    chinaM2: sanitizePositiveSeries(fred.chinaM2) || [],
    ecbM2: sanitizePositiveSeries(fred.ecbM2) || [],
    japanM2: sanitizePositiveSeries(fred.japanM2) || [],
    pbcAssets: sanitizePositiveSeries(fred.pbcAssets) || [],
    coreCpi: sanitizeFredIndexSeries(fred.coreCpi) || [],
    corePpi: sanitizeFredIndexSeries(fred.corePpi) || [],
    initialClaims: sanitizePositiveSeries(fred.initialClaims) || [],
    continuingClaims: sanitizePositiveSeries(fred.continuingClaims) || [],
    payrolls: sanitizePositiveSeries(fred.payrolls) || [],
    realGdp: sanitizeFiniteSeries(fred.realGdp) || [],
    unemployment: sanitizePositiveSeries(fred.unemployment) || [],
    effectiveFedFundsRate: sanitizeNonNegativeSeries(fred.effectiveFedFundsRate) || []
  };
}

function sanitizeMarketRaw(market = {}) {
  return {
    ...market,
    eurUsd: sanitizePositiveSeries(market.eurUsd) || [],
    jpyUsd: sanitizePositiveSeries(market.jpyUsd) || [],
    cnyUsd: sanitizePositiveSeries(market.cnyUsd) || [],
    datInflows: normalizeDatInflows(market.datInflows)
  };
}

function sanitizeFredIndexSeries(series) {
  const clean = sanitizePositiveSeries(series);
  if (!clean?.length) return null;
  return clean.filter((point, index, rows) => {
    if (index === 0) return true;
    const previous = rows[index - 1]?.value;
    if (!Number.isFinite(previous) || previous <= 0) return false;
    const monthlyMove = Math.abs(((point.value - previous) / previous) * 100);
    return monthlyMove <= 8;
  });
}

function sanitizePositiveSeries(series) {
  const clean = sanitizeFiniteSeries(series)?.filter((point) => point.value > 0) || [];
  return clean.length ? clean : null;
}

function sanitizeNonNegativeSeries(series) {
  const clean = sanitizeFiniteSeries(series)?.filter((point) => point.value >= 0) || [];
  return clean.length ? clean : null;
}

function sanitizeFiniteSeries(series) {
  const clean = (Array.isArray(series) ? series : [])
    .map((point) => ({ date: String(point?.date || ""), value: Number(point?.value) }))
    .filter((point) => /^\d{4}-\d{2}-\d{2}$/.test(point.date) && Number.isFinite(point.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  return clean.length ? clean : null;
}

function normalizeClaimsInput(initialClaims, continuingClaims) {
  const initial = sanitizePositiveSeries(initialClaims) || [];
  const continuing = sanitizePositiveSeries(continuingClaims) || [];
  if (hasCovidClaimsSpike(initial, continuing)) {
    return { initialClaims: initial, continuingClaims: continuing };
  }
  return buildReferenceClaimsFallback();
}

function hasCovidClaimsSpike(initialClaims, continuingClaims) {
  const initialPeak = Math.max(
    ...initialClaims
      .filter((point) => point.date >= "2020-03-01" && point.date <= "2020-06-30")
      .map((point) => point.value)
  );
  const continuingPeak = Math.max(
    ...continuingClaims
      .filter((point) => point.date >= "2020-03-01" && point.date <= "2020-09-30")
      .map((point) => point.value)
  );
  return initialPeak > 2000 && continuingPeak > 8000;
}

function buildReferenceClaimsFallback() {
  const anchors = [
    ["2010-01-01", 470, 4550],
    ["2012-01-01", 375, 3400],
    ["2014-01-01", 330, 2850],
    ["2016-01-01", 275, 2250],
    ["2018-01-01", 230, 1900],
    ["2020-02-01", 215, 1700],
    ["2020-03-28", 6867, 3059],
    ["2020-05-09", 3148, 24912],
    ["2020-09-01", 881, 13385],
    ["2021-06-01", 405, 3600],
    ["2022-01-01", 230, 1700],
    ["2024-01-01", 215, 1825],
    ["2026-06-01", 240, 1925]
  ].map(([date, initial, continuing]) => ({ date, initial, continuing }));

  const initialClaims = interpolateWeeklyAnchors(anchors, "initial");
  const continuingClaims = interpolateWeeklyAnchors(anchors, "continuing");
  return { initialClaims, continuingClaims };
}

function interpolateWeeklyAnchors(anchors, key) {
  const rows = [];
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const start = anchors[index];
    const end = anchors[index + 1];
    const startTime = parseDate(start.date).getTime();
    const endTime = parseDate(end.date).getTime();
    const span = Math.max(1, endTime - startTime);
    for (let time = startTime; time < endTime; time += 7 * DAY_MS) {
      const progress = (time - startTime) / span;
      rows.push({
        date: new Date(time).toISOString().slice(0, 10),
        value: round(start[key] + (end[key] - start[key]) * progress, 0)
      });
    }
  }
  const finalAnchor = anchors.at(-1);
  rows.push({ date: finalAnchor.date, value: finalAnchor[key] });
  return rows;
}

function isSegmentDue(cache, segment, nowMs) {
  const status = cache.sourceStatus?.[segment] || {};
  const nextFetchAfter = status.nextFetchAfter ? new Date(status.nextFetchAfter).getTime() : 0;
  return !nextFetchAfter || nowMs >= nextFetchAfter;
}

function buildSegmentStatus(segment, fetchedAt, ttlMs, failures) {
  const hasFailures = Array.isArray(failures) && failures.length > 0;
  const retryMs = segment === "fred" ? 15 * 60 * 1000 : 10 * 60 * 1000;
  return {
    lastFetchedAt: fetchedAt.toISOString(),
    nextFetchAfter: new Date(fetchedAt.getTime() + (hasFailures ? retryMs : ttlMs)).toISOString(),
    ttlMs,
    source: segment === "fred"
      ? "FRED keyless CSV graph endpoint"
      : "Yahoo Finance, CoinGecko Demo, Coin Metrics Community, Alternative.me, CNN, DefiLlama DAT",
    failures
  };
}

function buildSeedFredRaw(daily, monthly) {
  const claimsFallback = buildReferenceClaimsFallback();
  return {
    walcl: daily.filter((_, index) => index % 7 === 0).map((point, index) => ({
      date: point.date,
      value: round(7.15 + Math.sin(index / 6) * 0.12 - index * 0.0038, 3)
    })),
    reverseRepo: daily.filter((_, index) => index % 7 === 0).map((point) => ({
      date: point.date,
      value: seedReverseRepoValue(point.date)
    })),
    treasuryGeneralAccount: daily.filter((_, index) => index % 7 === 0).map((point) => ({
      date: point.date,
      value: seedTreasuryGeneralAccountValue(point.date)
    })),
    ecbAssets: daily.filter((_, index) => index % 7 === 0).map((point) => ({
      date: point.date,
      value: seedEcbAssetsValue(point.date)
    })),
    bojAssets: daily.filter((_, index) => index % 7 === 0).map((point) => ({
      date: point.date,
      value: seedBojAssetsValue(point.date)
    })),
    usM2: daily.filter((_, index) => index % 7 === 0).map((point) => ({
      date: point.date,
      value: seedUsM2Value(point.date)
    })),
    chinaM2: daily.filter((_, index) => index % 7 === 0).map((point) => ({
      date: point.date,
      value: seedChinaM2Value(point.date)
    })),
    ecbM2: daily.filter((_, index) => index % 7 === 0).map((point) => ({
      date: point.date,
      value: seedEcbM2Value(point.date)
    })),
    japanM2: daily.filter((_, index) => index % 7 === 0).map((point) => ({
      date: point.date,
      value: seedJapanM2Value(point.date)
    })),
    pbcAssets: daily.filter((_, index) => index % 7 === 0).map((point) => ({
      date: point.date,
      value: seedPbcAssetsValue(point.date)
    })),
    coreCpi: monthly.map((date, index) => ({ date, value: round(308 + index * 0.55 + Math.sin(index / 4) * 0.35, 3) })),
    corePpi: monthly.map((date, index) => ({ date, value: round(248 + index * 0.48 + Math.cos(index / 3) * 0.8, 3) })),
    initialClaims: claimsFallback.initialClaims,
    continuingClaims: claimsFallback.continuingClaims,
    payrolls: monthly.map((date, index) => ({ date, value: round(158_000 + index * 170 + Math.sin(index / 2.2) * 85, 0) })),
    realGdp: monthly.filter((_, index) => index % 3 === 0).map((date, index) => ({ date, value: round(2.1 + Math.sin(index / 2.5) * 0.65, 2) })),
    unemployment: monthly.map((date, index) => ({ date, value: round(3.8 + Math.cos(index / 6) * 0.35 + index * 0.01, 2) })),
    effectiveFedFundsRate: daily.map((point) => ({ date: point.date, value: seedFedFundsRateValue(point.date) }))
  };
}

function buildSeedMarketRaw(daily, monthly) {
  return {
    btcUsd: daily.map((point, index) => toOhlc(point.date, point.btc, 0.036, index)),
    dxy: daily.map((point) => ({ date: point.date, value: point.dxy })),
    sp500: daily.map((point, index) => toOhlc(point.date, point.sp500 * 52, 0.011, index)),
    software: daily.map((point, index) => toOhlc(point.date, point.software * 4.1, 0.015, index)),
    gold: daily.map((point, index) => toOhlc(point.date, 2250 + index * 1.4 + Math.sin(index / 40) * 95, 0.009, index)),
    eurUsd: daily.map((point, index) => ({ date: point.date, value: seedEurUsdValue(point.date, index) })),
    jpyUsd: daily.map((point, index) => ({ date: point.date, value: seedJpyUsdValue(point.date, index) })),
    cnyUsd: daily.map((point, index) => ({ date: point.date, value: seedCnyUsdValue(point.date, index) })),
    cryptoFearGreed: daily.slice(-30).map((point, index) => normalizeSentimentPoint({ date: point.date, score: 20 + Math.round(Math.max(0, Math.sin(index / 4)) * 30) })),
    equityFearGreed: daily.slice(-30).map((point, index) => normalizeSentimentPoint({ date: point.date, score: 38 + Math.round(Math.max(0, Math.cos(index / 5)) * 24) })),
    mvrvRatio: daily.map((point, index) => ({ date: point.date, value: round(1.7 + Math.sin(index / 70) * 0.45 + Math.cos(index / 24) * 0.15, 3) })),
    datInflows: []
  };
}

function seedReverseRepoValue(date) {
  return interpolateLiquidityDrain(date, [
    ["2010-01-01", 0.08],
    ["2021-01-01", 0.12],
    ["2022-12-30", 2.4],
    ["2024-12-31", 0.62],
    ["2026-06-01", 0.08]
  ]);
}

function seedTreasuryGeneralAccountValue(date) {
  return interpolateLiquidityDrain(date, [
    ["2010-01-01", 0.32],
    ["2016-01-01", 0.45],
    ["2020-07-01", 1.65],
    ["2022-12-30", 0.55],
    ["2024-12-31", 0.78],
    ["2026-06-01", 0.72]
  ]);
}

function seedEcbAssetsValue(date) {
  return interpolateLiquidityDrain(date, [
    ["2010-01-01", 2.2],
    ["2015-01-01", 2.25],
    ["2018-12-31", 4.68],
    ["2022-06-30", 8.82],
    ["2024-12-31", 6.42],
    ["2026-06-01", 6.15]
  ]);
}

function seedBojAssetsValue(date) {
  return interpolateLiquidityDrain(date, [
    ["2010-01-01", 115],
    ["2015-01-01", 345],
    ["2020-01-01", 575],
    ["2022-12-31", 730],
    ["2026-06-01", 765]
  ]);
}

function seedUsM2Value(date) {
  return interpolateLiquidityDrain(date, [
    ["2010-01-01", 8.5],
    ["2015-01-01", 11.8],
    ["2020-01-01", 15.5],
    ["2022-12-31", 21.7],
    ["2026-06-01", 21.2]
  ]);
}

function seedChinaM2Value(date) {
  return interpolateLiquidityDrain(date, [
    ["2010-01-01", 60.8],
    ["2015-01-01", 122.4],
    ["2020-01-01", 198.6],
    ["2022-12-31", 266.4],
    ["2026-06-01", 305.0]
  ]);
}

function seedEcbM2Value(date) {
  return interpolateLiquidityDrain(date, [
    ["2010-01-01", 7.2],
    ["2015-01-01", 9.8],
    ["2020-01-01", 12.5],
    ["2022-12-31", 15.6],
    ["2026-06-01", 16.2]
  ]);
}

function seedJapanM2Value(date) {
  return interpolateLiquidityDrain(date, [
    ["2010-01-01", 780],
    ["2015-01-01", 910],
    ["2020-01-01", 1040],
    ["2022-12-31", 1210],
    ["2026-06-01", 1240]
  ]);
}

function seedPbcAssetsValue(date) {
  return interpolateLiquidityDrain(date, [
    ["2010-01-01", 24.5],
    ["2015-01-01", 33.8],
    ["2020-01-01", 38.2],
    ["2022-12-31", 44.5],
    ["2026-06-01", 48.6]
  ]);
}

function seedFedFundsRateValue(date) {
  return interpolateLiquidityDrain(date, [
    ["2010-01-01", 0.12],
    ["2015-12-16", 0.37],
    ["2018-12-20", 2.4],
    ["2020-03-16", 0.08],
    ["2022-03-17", 0.33],
    ["2023-07-27", 5.33],
    ["2025-01-01", 4.33],
    ["2026-06-01", 3.85]
  ]);
}

function seedEurUsdValue(date, index) {
  const trend = interpolateLiquidityDrain(date, [
    ["2010-01-01", 1.43],
    ["2015-01-01", 1.12],
    ["2020-01-01", 1.11],
    ["2022-10-01", 0.98],
    ["2026-06-01", 1.08]
  ]);
  return round(trend + Math.sin(index / 140) * 0.015, 4);
}

function seedJpyUsdValue(date, index) {
  const trend = interpolateLiquidityDrain(date, [
    ["2010-01-01", 0.011],
    ["2016-01-01", 0.0084],
    ["2020-01-01", 0.0092],
    ["2024-07-01", 0.0063],
    ["2026-06-01", 0.0067]
  ]);
  return round(trend + Math.cos(index / 160) * 0.00008, 6);
}

function seedCnyUsdValue(date, index) {
  const trend = interpolateLiquidityDrain(date, [
    ["2010-01-01", 0.146],
    ["2014-01-01", 0.163],
    ["2019-01-01", 0.145],
    ["2022-01-01", 0.157],
    ["2026-06-01", 0.138]
  ]);
  return round(trend + Math.sin(index / 150) * 0.003, 6);
}

function interpolateLiquidityDrain(date, anchors) {
  const time = parseDate(date).getTime();
  const points = anchors.map(([anchorDate, value]) => ({ time: parseDate(anchorDate).getTime(), value }));
  if (time <= points[0].time) return points[0].value;
  if (time >= points.at(-1).time) return points.at(-1).value;

  const upperIndex = points.findIndex((point) => point.time >= time);
  const lower = points[upperIndex - 1];
  const upper = points[upperIndex];
  const progress = (time - lower.time) / Math.max(1, upper.time - lower.time);
  return round(lower.value + (upper.value - lower.value) * progress, 4);
}

function buildSeedDailySeries(now) {
  const count = 365 * 15;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - (count - 1) * DAY_MS);
  return Array.from({ length: count }, (_value, index) => {
    const date = new Date(start.getTime() + index * DAY_MS);
    const cycle = Math.sin(index / 36);
    const slowCycle = Math.cos(index / 83);
    const btc = 9000 + index * 13.5 + cycle * 4200 + slowCycle * 1800;
    return {
      date: date.toISOString().slice(0, 10),
      btc: round(Math.max(200, btc), 2),
      gli: round(96 + index * 0.006 + Math.sin(index / 44) * 3.1, 2),
      dxy: round(103.4 - index * 0.0006 + Math.cos(index / 28) * 0.7, 2),
      software: round(100 + index * 0.018 + Math.sin(index / 31) * 5.8, 2),
      sp500: round(100 + index * 0.014 + Math.cos(index / 47) * 3.9, 2)
    };
  });
}

function buildSeedMonthlyDates(now) {
  const count = 15 * 12;
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return Array.from({ length: count }, (_value, index) => {
    const date = new Date(end);
    date.setUTCMonth(end.getUTCMonth() - (count - 1 - index));
    return date.toISOString().slice(0, 10);
  });
}

function yoy(series) {
  return (series || []).map((point, index, rows) => {
    if (index < 12) return null;
    const previous = rows[index - 12]?.value;
    if (!previous) return null;
    return { date: point.date, value: round(((point.value - previous) / previous) * 100, 2) };
  }).filter(Boolean);
}

function normalizeToIndex(series, key, inverse = false) {
  const first = (series || []).find((point) => Number.isFinite(Number(point[key])))?.[key];
  if (!Number.isFinite(Number(first)) || Number(first) === 0) return [];
  return series.map((point) => {
    const raw = Number(point[key]);
    if (!Number.isFinite(raw)) return null;
    const value = inverse ? (Number(first) / raw) * 100 : (raw / Number(first)) * 100;
    return { date: point.date, value: round(value, 2) };
  }).filter(Boolean);
}

function mergeByPrimaryDates(left, leftOptions, right, rightOptions) {
  const leftKey = leftOptions.leftKey || "left";
  const rightKey = rightOptions.rightKey || "right";
  return (left || []).map((point) => {
    const rightPoint = getPointAtOrBefore(right || [], point.date);
    if (!rightPoint) return null;
    return {
      date: point.date,
      [leftKey]: point.value,
      [rightKey]: rightPoint.value
    };
  }).filter(Boolean);
}

function getPointAtOrBefore(series, date) {
  let candidate = null;
  for (const point of series || []) {
    if (point.date > date) break;
    candidate = point;
  }
  return candidate;
}

function toWeeklyOhlc(series) {
  const buckets = new Map();
  for (const point of series || []) {
    const date = parseDate(point.date);
    const key = `${date.getUTCFullYear()}-${String(getUtcWeek(date)).padStart(2, "0")}`;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, { ...point });
    } else {
      existing.high = Math.max(existing.high, point.high);
      existing.low = Math.min(existing.low, point.low);
      existing.close = point.close;
      existing.date = point.date;
    }
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function aggregateDailyPrices(points) {
  const byDate = new Map();
  for (const point of points) {
    if (!Number.isFinite(point.value)) continue;
    const existing = byDate.get(point.date);
    if (!existing) {
      byDate.set(point.date, { date: point.date, open: point.value, high: point.value, low: point.value, close: point.value });
    } else {
      existing.high = Math.max(existing.high, point.value);
      existing.low = Math.min(existing.low, point.value);
      existing.close = point.value;
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function toOhlc(date, close, volatility, index) {
  const open = close * (1 + Math.sin(index / 9) * volatility * 0.28);
  const high = Math.max(open, close) * (1 + volatility * 0.34);
  const low = Math.min(open, close) * (1 - volatility * 0.3);
  return {
    date,
    open: round(open, 2),
    high: round(high, 2),
    low: round(low, 2),
    close: round(close, 2)
  };
}

function toValuePointFromClose(point) {
  return { date: point.date, value: point.close };
}

async function fetchJson(url, options = {}, timeoutMs = 15000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function fetchText(url, options = {}, timeoutMs = 15000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "PortfolioTracker/0.1",
        ...(options.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSentimentPoint(point) {
  const score = Math.max(0, Math.min(100, Math.round(Number(point?.score) || 0)));
  const label = point?.label || getSentimentLabel(score);
  return {
    date: point?.date || new Date().toISOString().slice(0, 10),
    score,
    label,
    tone: getSentimentTone(score)
  };
}

function getSentimentLabel(score) {
  if (score <= 24) return "Extreme Fear";
  if (score <= 44) return "Fear";
  if (score <= 55) return "Neutral";
  if (score <= 75) return "Greed";
  return "Extreme Greed";
}

function getSentimentTone(score) {
  if (score <= 24) return "fear";
  if (score <= 44) return "caution";
  if (score <= 55) return "neutral";
  if (score <= 75) return "greed";
  return "hot";
}

function standardDeviation(values) {
  if (!values.length) return 0;
  if (values.length === 1) return 0;
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function average(values) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return 0;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function parseDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(value, days) {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getUtcWeek(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target - yearStart) / DAY_MS) + 1) / 7);
}

function readFinite(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}
