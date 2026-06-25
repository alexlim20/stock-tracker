export const DEFAULT_MARKET_DATA = {
  fetchedAt: null,
  prices: {},
  fundamentals: {},
  fx: {
    base: "EUR",
    rates: {},
    latest: 1.08
  },
  failures: []
};

const MARKET_RADAR_DEFAULTS = {
  minMarketCap: 300_000_000,
  maxMarketCap: 10_000_000_000,
  drawdownThresholdPct: 25,
  sectors: ["Technology", "Healthcare", "Financial Services"],
  exchanges: ["NASDAQ", "NYSE", "AMEX"],
  perSectorLimit: 36,
  maxCandidates: 0,
  maxResults: 0,
  yahooPageSize: 250,
  scoringConcurrency: 4
};

let yahooAuthState = {
  cookie: "",
  crumb: "",
  expiresAt: 0
};
let requestNonce = 0;

export async function refreshMarketDataForTrades(trades, extraTickers = []) {
  const sortedTrades = [...trades].sort((a, b) => a.date.localeCompare(b.date));
  const tradeTickers = sortedTrades.map((trade) => trade.ticker);
  const watchTickers = Array.isArray(extraTickers) ? extraTickers : [];
  const tickers = [...new Set([...tradeTickers, ...watchTickers].map(normalizeTicker).filter(Boolean))].sort();
  const startDate = sortedTrades[0]?.date ?? yearsAgoIso(1);
  const endDate = todayIso();
  const prices = {};
  const fundamentals = {};
  const failures = [];

  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        prices[ticker] = await fetchYahooPrices(ticker, startDate, endDate);
      } catch (error) {
        failures.push({ ticker, message: error.message });
      }
    })
  );

  await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const rawFundamentals = await fetchYahooFundamentals(ticker, prices[ticker]);
        fundamentals[ticker] = scoreUnderdogProfiles(ticker, prices[ticker], rawFundamentals);
      } catch (error) {
        fundamentals[ticker] = scoreUnderdogProfiles(ticker, prices[ticker], null);
        failures.push({ ticker, message: `Fundamentals: ${error.message}` });
      }
    })
  );

  let fx = DEFAULT_MARKET_DATA.fx;
  try {
    fx = await fetchFxRates(startDate, endDate);
  } catch (error) {
    failures.push({ ticker: "EUR/USD", message: error.message });
  }

  return {
    fetchedAt: new Date().toISOString(),
    prices,
    fundamentals,
    fx,
    failures
  };
}

export async function scanMarketUnderdogRadar(options = {}) {
  const apiKey = String(options.apiKey || "").trim();
  const filters = normalizeMarketRadarFilters(options);
  const failures = [];

  let provider = "Yahoo Finance screener + Yahoo Finance scoring";
  let screenerCandidates = await fetchYahooScreenerCandidates(filters, failures);

  if (!screenerCandidates.length && apiKey) {
    provider = "Financial Modeling Prep company screener + Yahoo Finance scoring";
    screenerCandidates = await fetchFmpScreenerCandidates(filters, apiKey, failures);
  }

  if (!screenerCandidates.length && failures.length) {
    throw new Error(`Market radar screener failed: ${failures.map((failure) => failure.message).slice(0, 2).join(" ")}`);
  }
  if (!screenerCandidates.length) {
    throw new Error("Market radar screener did not return candidates for the current filters.");
  }

  const universeCandidates = dedupeRadarCandidates(screenerCandidates);
  const candidates = universeCandidates.filter((candidate) => isRadarCandidatePrequalified(candidate, filters));
  const scored = await mapWithConcurrency(candidates, filters.scoringConcurrency, async (candidate) => {
    try {
      const priceData = await fetchYahooPrices(candidate.ticker, yearsAgoIso(1), todayIso());
      const rawFundamentals = await fetchYahooFundamentals(candidate.ticker, priceData);
      const scanner = scoreUnderdogProfiles(candidate.ticker, priceData, rawFundamentals);
      const marketCap = readFirst(rawFundamentals?.quote?.marketCap, candidate.marketCap);
      const drawdownFromHighPct = scanner.metrics.drawdownFromHighPct;
      const hasRadarMarketCap = Number.isFinite(Number(marketCap)) && Number(marketCap) >= filters.minMarketCap && Number(marketCap) <= filters.maxMarketCap;
      const hasRadarDrawdown = Number.isFinite(Number(drawdownFromHighPct)) && Number(drawdownFromHighPct) >= filters.drawdownThresholdPct;
      const strictTags = getStrictRadarTags(scanner);
      const hasStrictProfile = strictTags.length > 0;

      if (!hasRadarMarketCap || !hasRadarDrawdown || !hasStrictProfile) return null;

      return {
        ticker: candidate.ticker,
        companyName: candidate.companyName,
        sector: candidate.sector || rawFundamentals?.summary?.assetProfile?.sector || "Screened sector",
        industry: candidate.industry || rawFundamentals?.summary?.assetProfile?.industry || "",
        exchange: candidate.exchange,
        marketCap,
        price: scanner.metrics.currentPrice ?? candidate.price,
        sourceTicker: scanner.sourceTicker,
        source: scanner.source,
        tags: strictTags,
        metrics: scanner.metrics,
        profiles: scanner.profiles,
        scanner: {
          ...scanner,
          tags: strictTags
        },
        priceData
      };
    } catch (error) {
      failures.push({ ticker: candidate.ticker, message: error.message });
      return null;
    }
  });

  const matchedItems = scored
    .filter(Boolean)
    .sort((left, right) => getRadarRank(right) - getRadarRank(left));
  const items = filters.maxResults ? matchedItems.slice(0, filters.maxResults) : matchedItems;

  return {
    fetchedAt: new Date().toISOString(),
    provider,
    filters: {
      minMarketCap: filters.minMarketCap,
      maxMarketCap: filters.maxMarketCap,
      drawdownThresholdPct: filters.drawdownThresholdPct,
      sectors: filters.sectors,
      exchanges: filters.exchanges
    },
    universeCount: universeCandidates.length,
    scannedCount: universeCandidates.length,
    scoredCount: candidates.length,
    returnedCount: items.length,
    items,
    failures
  };
}

function normalizeMarketRadarFilters(options = {}) {
  return {
    minMarketCap: readPositiveNumber(options.minMarketCap, MARKET_RADAR_DEFAULTS.minMarketCap),
    maxMarketCap: readPositiveNumber(options.maxMarketCap, MARKET_RADAR_DEFAULTS.maxMarketCap),
    drawdownThresholdPct: readPositiveNumber(options.drawdownThresholdPct, MARKET_RADAR_DEFAULTS.drawdownThresholdPct),
    sectors: normalizeStringList(options.sectors, MARKET_RADAR_DEFAULTS.sectors),
    exchanges: normalizeStringList(options.exchanges, MARKET_RADAR_DEFAULTS.exchanges),
    perSectorLimit: Math.min(readPositiveNumber(options.perSectorLimit, MARKET_RADAR_DEFAULTS.perSectorLimit), 100),
    maxCandidates: normalizeOptionalPositiveLimit(options.maxCandidates, MARKET_RADAR_DEFAULTS.maxCandidates),
    maxResults: normalizeOptionalPositiveLimit(options.maxResults, MARKET_RADAR_DEFAULTS.maxResults),
    yahooPageSize: Math.min(readPositiveNumber(options.yahooPageSize, MARKET_RADAR_DEFAULTS.yahooPageSize), 250),
    scoringConcurrency: Math.max(1, Math.min(readPositiveNumber(options.scoringConcurrency, MARKET_RADAR_DEFAULTS.scoringConcurrency), 8))
  };
}

async function fetchYahooScreenerCandidates(filters, failures) {
  try {
    const authState = await getYahooAuth();
    const params = new URLSearchParams({
      crumb: authState.crumb,
      lang: "en-US",
      region: "US",
      formatted: "false",
      corsDomain: "finance.yahoo.com"
    });
    const url = `https://query1.finance.yahoo.com/v1/finance/screener?${params.toString()}`;
    const candidates = [];
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const pageSize = getYahooPageSize(filters, candidates.length);
      if (pageSize <= 0) break;

      const payload = buildYahooRadarScreenerPayload(filters, offset, pageSize);
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Cookie: authState.cookie,
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 PortfolioTracker/0.1"
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const result = data.finance?.result?.[0] || {};
      const quotes = result.quotes || [];
      const pageCandidates = quotes.map(normalizeYahooRadarCandidate).filter(Boolean);
      candidates.push(...pageCandidates);
      total = readRaw(result.total) ?? candidates.length;

      if (!quotes.length) break;
      offset += quotes.length;
      if (filters.maxCandidates && candidates.length >= filters.maxCandidates) break;
    }

    return filters.maxCandidates ? candidates.slice(0, filters.maxCandidates) : candidates;
  } catch (error) {
    failures.push({ ticker: "Yahoo Screener", message: `Yahoo screener: ${error.message}` });
    return [];
  }
}

function getYahooPageSize(filters, fetchedCount) {
  if (!filters.maxCandidates) return filters.yahooPageSize;
  return Math.min(filters.yahooPageSize, Math.max(filters.maxCandidates - fetchedCount, 0));
}

function buildYahooRadarScreenerPayload(filters, offset, size) {
  const operands = [
    buildYahooOrFilter("region", ["us"]),
    {
      operator: "or",
      operands: [
        {
          operator: "btwn",
          operands: ["intradaymarketcap", filters.minMarketCap, filters.maxMarketCap]
        }
      ]
    },
    buildYahooOrFilter("sector", filters.sectors)
  ];

  const yahooExchanges = getYahooExchangeCodes(filters.exchanges);
  if (yahooExchanges.length) {
    operands.push(buildYahooOrFilter("exchange", yahooExchanges));
  }

  return {
    includeFields: null,
    offset,
    query: {
      operator: "and",
      operands
    },
    quoteType: "equity",
    size,
    sortField: "intradaymarketcap",
    sortType: "desc",
    topOperator: "and"
  };
}

function buildYahooOrFilter(field, values) {
  return {
    operator: "or",
    operands: values.map((value) => ({
      operator: "eq",
      operands: [field, value]
    }))
  };
}

function getYahooExchangeCodes(exchanges) {
  const codeMap = {
    AMEX: ["ASE"],
    ASE: ["ASE"],
    NASDAQ: ["NMS", "NGM", "NCM"],
    NCM: ["NCM"],
    NGM: ["NGM"],
    NMS: ["NMS"],
    NYSE: ["NYQ"],
    NYQ: ["NYQ"]
  };

  return [
    ...new Set(
      exchanges
        .map((exchange) => codeMap[String(exchange).toUpperCase()] || [String(exchange).toUpperCase()])
        .flat()
        .filter(Boolean)
    )
  ];
}

function normalizeYahooRadarCandidate(candidate) {
  const ticker = normalizeTicker(candidate?.symbol);
  if (!ticker) return null;

  return {
    ticker,
    companyName: String(candidate.longName || candidate.shortName || ticker),
    sector: String(candidate.sector || ""),
    industry: String(candidate.industry || ""),
    exchange: String(candidate.exchange || candidate.fullExchangeName || ""),
    marketCap: readRaw(candidate.marketCap || candidate.intradaymarketcap),
    price: readRaw(candidate.regularMarketPrice),
    drawdownFromHighPct: readYahooDrawdownFromHighPct(candidate)
  };
}

function isRadarCandidatePrequalified(candidate, filters) {
  const marketCap = readRaw(candidate.marketCap);
  const drawdownFromHighPct = readRaw(candidate.drawdownFromHighPct);
  const hasRadarMarketCap =
    Number.isFinite(Number(marketCap)) &&
    Number(marketCap) >= filters.minMarketCap &&
    Number(marketCap) <= filters.maxMarketCap;
  const hasRadarDrawdown = drawdownFromHighPct == null || Number(drawdownFromHighPct) >= filters.drawdownThresholdPct;
  return hasRadarMarketCap && hasRadarDrawdown;
}

function readYahooDrawdownFromHighPct(candidate) {
  const highChangePct = readRaw(candidate.fiftyTwoWeekHighChangePercent);
  if (highChangePct != null) {
    const percent = Math.abs(highChangePct) <= 1 ? highChangePct * 100 : highChangePct;
    return percent < 0 ? roundMetric(Math.abs(percent)) : 0;
  }

  const currentPrice = readRaw(candidate.regularMarketPrice);
  const high52Week = readRaw(candidate.fiftyTwoWeekHigh);
  if (!currentPrice || !high52Week) return null;
  return roundMetric(((high52Week - currentPrice) / high52Week) * 100);
}

async function fetchFmpScreenerCandidates(filters, apiKey, failures) {
  const sectorBatches = await mapWithConcurrency(filters.sectors, 2, async (sector) => {
    try {
      return await fetchFmpScreenerSector(sector, filters, apiKey);
    } catch (error) {
      failures.push({ ticker: sector, message: `FMP screener: ${error.message}` });
      return [];
    }
  });
  return sectorBatches.flat();
}

async function fetchFmpScreenerSector(sector, filters, apiKey) {
  const params = {
    marketCapMoreThan: filters.minMarketCap,
    marketCapLowerThan: filters.maxMarketCap,
    sector,
    isActivelyTrading: true,
    limit: filters.perSectorLimit
  };

  if (filters.exchanges.length) {
    params.exchange = filters.exchanges.join(",");
  }

  try {
    return await fetchFmpScreenerUrl("https://financialmodelingprep.com/stable/company-screener", params, apiKey);
  } catch (stableError) {
    try {
      return await fetchFmpScreenerUrl("https://financialmodelingprep.com/api/v3/stock-screener", params, apiKey);
    } catch (legacyError) {
      throw new Error(`${stableError.message}; legacy fallback: ${legacyError.message}`);
    }
  }
}

async function fetchFmpScreenerUrl(endpoint, params, apiKey) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 PortfolioTracker/0.1"
    }
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
  if (!rows) {
    const message = data?.["Error Message"] || data?.error || data?.message || "Unexpected FMP screener response.";
    throw new Error(message);
  }

  return rows.map(normalizeRadarCandidate).filter(Boolean);
}

function normalizeRadarCandidate(candidate) {
  const ticker = normalizeTicker(candidate?.symbol || candidate?.ticker);
  if (!ticker) return null;

  return {
    ticker,
    companyName: String(candidate.companyName || candidate.company_name || candidate.name || ticker),
    sector: String(candidate.sector || "Unknown"),
    industry: String(candidate.industry || ""),
    exchange: String(candidate.exchangeShortName || candidate.exchange || ""),
    marketCap: readRaw(candidate.marketCap || candidate["market capitalization"] || candidate.mktCap),
    price: readRaw(candidate.price)
  };
}

function dedupeRadarCandidates(candidates) {
  const seen = new Set();
  const deduped = [];
  for (const candidate of candidates) {
    const ticker = normalizeTicker(candidate?.ticker);
    if (!ticker || seen.has(ticker)) continue;
    seen.add(ticker);
    deduped.push({ ...candidate, ticker });
  }
  return deduped;
}

function getRadarRank(item) {
  const rocket = item.profiles?.rocket?.passed ? 4 : 0;
  const wideMoat = item.profiles?.wideMoat?.passed ? 3 : 0;
  const drawdown = Number(item.metrics?.drawdownFromHighPct || 0) / 100;
  const growth = Number(item.metrics?.growthPct || 0) / 100;
  const margin = Number(item.metrics?.marginPct || 0) / 100;
  return rocket + wideMoat + drawdown + growth + margin;
}

function getStrictRadarTags(scanner) {
  const tags = [];
  if (isStrictProfilePass(scanner?.profiles?.rocket)) {
    tags.push({
      key: "rocket",
      label: "ROCKET / HIGH VELOCITY",
      profile: scanner.profiles.rocket.label
    });
  }
  if (isStrictProfilePass(scanner?.profiles?.wideMoat)) {
    tags.push({
      key: "wideMoat",
      label: "WIDE-MOAT UNDERDOG",
      profile: scanner.profiles.wideMoat.label
    });
  }
  return tags;
}

function isStrictProfilePass(profile) {
  return Boolean(profile?.passed && profile?.total > 0 && profile.score === profile.total);
}

function toUnixSeconds(dateText) {
  return Math.floor(new Date(`${dateText}T00:00:00Z`).getTime() / 1000);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function yearsAgoIso(years) {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  return date.toISOString().slice(0, 10);
}

function normalizeTicker(ticker) {
  return String(ticker || "").trim().toUpperCase();
}

async function fetchJson(url) {
  const response = await fetch(withCacheBust(url), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Expires: "0",
      Pragma: "no-cache",
      "User-Agent": "Mozilla/5.0 PortfolioTracker/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

async function getYahooAuth() {
  if (yahooAuthState.cookie && yahooAuthState.crumb && yahooAuthState.expiresAt > Date.now()) {
    return yahooAuthState;
  }

  const response = await fetch(withCacheBust("https://fc.yahoo.com"), {
    cache: "no-store",
    redirect: "manual",
    headers: {
      "Cache-Control": "no-cache",
      Expires: "0",
      Pragma: "no-cache",
      "User-Agent": "Mozilla/5.0 PortfolioTracker/0.1"
    }
  });
  const cookie = String(response.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) {
    throw new Error("Yahoo auth cookie was not returned.");
  }

  const crumbResponse = await fetch(withCacheBust("https://query1.finance.yahoo.com/v1/test/getcrumb"), {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Cookie: cookie,
      Expires: "0",
      Pragma: "no-cache",
      "User-Agent": "Mozilla/5.0 PortfolioTracker/0.1"
    }
  });
  if (!crumbResponse.ok) {
    throw new Error(`Yahoo crumb failed: ${crumbResponse.status} ${crumbResponse.statusText}`);
  }

  const crumb = (await crumbResponse.text()).trim();
  if (!crumb) {
    throw new Error("Yahoo crumb was empty.");
  }

  yahooAuthState = {
    cookie,
    crumb,
    expiresAt: Date.now() + 45 * 60 * 1000
  };
  return yahooAuthState;
}

async function fetchYahooJson(url, { auth = false } = {}) {
  if (!auth) {
    return fetchJson(url);
  }

  const authState = await getYahooAuth();
  const separator = url.includes("?") ? "&" : "?";
  const authedUrl = withCacheBust(`${url}${separator}crumb=${encodeURIComponent(authState.crumb)}`);
  const response = await fetch(authedUrl, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Cookie: authState.cookie,
      Expires: "0",
      Pragma: "no-cache",
      "User-Agent": "Mozilla/5.0 PortfolioTracker/0.1"
    }
  });

  if (!response.ok) {
    yahooAuthState = { cookie: "", crumb: "", expiresAt: 0 };
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

function withCacheBust(url) {
  const separator = url.includes("?") ? "&" : "?";
  requestNonce += 1;
  return `${url}${separator}_=${Date.now()}-${requestNonce}`;
}

async function fetchYahooPrices(ticker, startDate, endDate) {
  const period1 = toUnixSeconds(startDate);
  const period2 = toUnixSeconds(endDate) + 24 * 60 * 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?period1=${period1}&period2=${period2}&interval=1d&events=history&includeAdjustedClose=true`;

  const data = await fetchYahooJson(url);
  const result = data.chart?.result?.[0];
  if (!result) {
    throw new Error(`No market data returned for ${ticker}.`);
  }

  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const adjustedCloses = result.indicators?.adjclose?.[0]?.adjclose ?? [];
  const closes = quote.close ?? [];
  const opens = quote.open ?? [];
  const highs = quote.high ?? [];
  const lows = quote.low ?? [];
  const volumes = quote.volume ?? [];
  const currency = result.meta?.currency === "USD" ? "USD" : "EUR";
  const points = timestamps
    .map((timestamp, index) => {
      const close = closes[index];
      if (!Number.isFinite(close)) return null;
      return {
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        open: Number.isFinite(opens[index]) ? Number(opens[index].toFixed(4)) : null,
        high: Number.isFinite(highs[index]) ? Number(highs[index].toFixed(4)) : null,
        low: Number.isFinite(lows[index]) ? Number(lows[index].toFixed(4)) : null,
        volume: Number.isFinite(volumes[index]) ? Number(volumes[index]) : null,
        close: Number(close.toFixed(4)),
        adjustedClose: Number.isFinite(adjustedCloses[index]) ? Number(adjustedCloses[index].toFixed(4)) : null
      };
    })
    .filter(Boolean);

  return { currency, points };
}

async function fetchYahooFundamentals(ticker, priceData) {
  const candidates = await getFundamentalSymbolCandidates(ticker);
  const errors = [];
  const results = [];

  for (const symbol of candidates) {
    try {
      const [summary, quote] = await Promise.all([
        fetchYahooQuoteSummary(symbol),
        fetchYahooQuote(symbol)
      ]);
      results.push(normalizeFundamentals({
        requestedTicker: ticker,
        sourceTicker: symbol,
        priceData,
        quote,
        summary
      }));
    } catch (error) {
      errors.push(`${symbol}: ${error.message}`);
    }
  }

  if (results.length) {
    return chooseBestFundamentalResult(results, ticker);
  }

  throw new Error(errors[0] || `No fundamentals returned for ${ticker}.`);
}

function chooseBestFundamentalResult(results, requestedTicker) {
  return [...results].sort((left, right) => {
    const scoreDelta = scoreFundamentalCompleteness(right) - scoreFundamentalCompleteness(left);
    if (scoreDelta) return scoreDelta;

    const leftExact = normalizeTicker(left.sourceTicker) === normalizeTicker(requestedTicker) ? 1 : 0;
    const rightExact = normalizeTicker(right.sourceTicker) === normalizeTicker(requestedTicker) ? 1 : 0;
    return rightExact - leftExact;
  })[0];
}

function scoreFundamentalCompleteness(result) {
  const metrics = result?.normalized || {};
  return [
    "currentPrice",
    "high52Week",
    "salesGrowthPct",
    "earningsGrowthPct",
    "forwardEpsGrowthPct",
    "currentRatio",
    "operatingMarginPct",
    "netMarginPct",
    "roePct",
    "roicPct",
    "peRatio"
  ].filter((key) => metrics[key] != null && Number.isFinite(Number(metrics[key]))).length;
}

async function getFundamentalSymbolCandidates(ticker) {
  const normalized = normalizeTicker(ticker);
  const candidates = [normalized];
  if (normalized.includes(".")) {
    try {
      const search = await fetchYahooSearch(normalized, { quotesCount: 8, newsCount: 0 });
      const quotes = (search.quotes || []).filter((quote) => quote.quoteType === "EQUITY");
      const exact = quotes.find((quote) => normalizeTicker(quote.symbol) === normalized);
      const companyName = exact?.longname || exact?.shortname || quotes[0]?.longname || quotes[0]?.shortname || "";
      if (companyName) {
        const companySearch = await fetchYahooSearch(companyName, { quotesCount: 10, newsCount: 0 });
        const companyQuotes = (companySearch.quotes || []).filter((quote) => quote.quoteType === "EQUITY");
        const primary =
          companyQuotes.find((quote) => ["NMS", "NYQ", "NGM", "NCM", "ASE", "NAS"].includes(quote.exchange) && !String(quote.symbol || "").includes(".")) ||
          companyQuotes.find((quote) => !String(quote.symbol || "").includes(".")) ||
          companyQuotes[0];
        if (primary?.symbol) candidates.push(normalizeTicker(primary.symbol));
      }
    } catch {
      // Keep the original ticker as the fallback candidate.
    }
  }

  return [...new Set(candidates.filter(Boolean))];
}

async function fetchYahooSearch(query, { quotesCount, newsCount }) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    query
  )}&quotesCount=${quotesCount}&newsCount=${newsCount}&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query&multiQuoteQueryId=multi_quote_single_token_query&newsQueryId=news_cie_vespa`;
  return fetchYahooJson(url);
}

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`;
  const data = await fetchYahooJson(url, { auth: true });
  const quote = data.quoteResponse?.result?.[0];
  if (!quote) {
    throw new Error(`No quote data returned for ${symbol}.`);
  }
  return quote;
}

async function fetchYahooQuoteSummary(symbol) {
  const modules = [
    "assetProfile",
    "defaultKeyStatistics",
    "earningsTrend",
    "financialData",
    "price",
    "summaryDetail"
  ].join(",");
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`;
  const data = await fetchYahooJson(url, { auth: true });
  const result = data.quoteSummary?.result?.[0];
  const error = data.quoteSummary?.error;
  if (!result) {
    throw new Error(error?.description || `No fundamentals returned for ${symbol}.`);
  }

  return result;
}

function normalizeFundamentals({ requestedTicker, sourceTicker, priceData, quote = {}, summary = {} }) {
  const financialData = summary.financialData || {};
  const summaryDetail = summary.summaryDetail || {};
  const defaultKeyStatistics = summary.defaultKeyStatistics || {};
  const epsForward = readFirst(quote.epsForward, defaultKeyStatistics.forwardEps);
  const epsCurrentYear = readFirst(quote.epsCurrentYear, defaultKeyStatistics.currentYearEps);
  const epsTrailing = readFirst(quote.epsTrailingTwelveMonths, defaultKeyStatistics.trailingEps);
  const forwardEpsGrowth = epsForward && epsCurrentYear ? (epsForward - epsCurrentYear) / Math.abs(epsCurrentYear) : null;
  const fallbackEpsGrowth = epsForward && epsTrailing ? (epsForward - epsTrailing) / Math.abs(epsTrailing) : null;

  return {
    requestedTicker,
    sourceTicker,
    quote,
    summary,
    normalized: {
      currentPrice: readFirst(quote.regularMarketPrice, quote.postMarketPrice, quote.preMarketPrice, getLatestClose(priceData)),
      high52Week: readFirst(quote.fiftyTwoWeekHigh, summaryDetail.fiftyTwoWeekHigh, defaultKeyStatistics.fiftyTwoWeekHigh, getTrailingHigh(priceData, 365)),
      salesGrowthPct: readPercentFirst(financialData.revenueGrowth, quote.revenueGrowth),
      earningsGrowthPct: readPercentFirst(financialData.earningsGrowth, quote.earningsGrowth),
      forwardEpsGrowthPct: toPercent(readFirst(getForwardEpsGrowth(summary), forwardEpsGrowth, fallbackEpsGrowth)),
      currentRatio: readFirst(financialData.currentRatio, quote.currentRatio),
      operatingMarginPct: readPercentFirst(financialData.operatingMargins, quote.operatingMargins),
      netMarginPct: readPercentFirst(financialData.profitMargins, quote.profitMargins),
      roePct: readPercentFirst(financialData.returnOnEquity, quote.returnOnEquity),
      roicPct: readPercentFirst(financialData.returnOnCapital, financialData.returnOnInvestedCapital, quote.returnOnCapital, quote.returnOnInvestedCapital),
      peRatio: minPositive(
        readFirst(summaryDetail.trailingPE, quote.trailingPE),
        readFirst(defaultKeyStatistics.forwardPE, quote.forwardPE)
      )
    }
  };
}

function scoreUnderdogProfiles(ticker, priceData, rawFundamentals) {
  const normalized = rawFundamentals?.normalized || {};
  const currentPrice = readFirst(normalized.currentPrice, getLatestClose(priceData));
  const high52Week = maxNumber(
    normalized.high52Week,
    readRaw(rawFundamentals?.summaryDetail?.fiftyTwoWeekHigh),
    readRaw(rawFundamentals?.defaultKeyStatistics?.fiftyTwoWeekHigh),
    getTrailingHigh(priceData, 365)
  );
  const drawdownFromHighPct = high52Week && currentPrice
    ? ((high52Week - currentPrice) / high52Week) * 100
    : null;
  const financialData = rawFundamentals?.summary?.financialData || rawFundamentals?.financialData || {};
  const summaryDetail = rawFundamentals?.summary?.summaryDetail || rawFundamentals?.summaryDetail || {};
  const defaultKeyStatistics = rawFundamentals?.summary?.defaultKeyStatistics || rawFundamentals?.defaultKeyStatistics || {};
  const salesGrowthPct = readFirst(normalized.salesGrowthPct, toPercent(readRaw(financialData.revenueGrowth)));
  const earningsGrowthPct = readFirst(normalized.earningsGrowthPct, toPercent(readRaw(financialData.earningsGrowth)));
  const forwardEpsGrowthPct = readFirst(normalized.forwardEpsGrowthPct, toPercent(getForwardEpsGrowth(rawFundamentals?.summary || rawFundamentals)));
  const growthPct = maxNumber(salesGrowthPct, earningsGrowthPct, forwardEpsGrowthPct);
  const currentRatio = readFirst(normalized.currentRatio, readRaw(financialData.currentRatio));
  const operatingMarginPct = readFirst(normalized.operatingMarginPct, toPercent(readRaw(financialData.operatingMargins)));
  const netMarginPct = readFirst(normalized.netMarginPct, toPercent(readRaw(financialData.profitMargins)));
  const marginPct = maxNumber(operatingMarginPct, netMarginPct);
  const roePct = readFirst(normalized.roePct, toPercent(readRaw(financialData.returnOnEquity)));
  const roicPct = readFirst(normalized.roicPct, toPercent(maxNumber(
    readRaw(financialData.returnOnCapital),
    readRaw(financialData.returnOnInvestedCapital)
  )));
  const returnQualityPct = maxNumber(roePct, roicPct);
  const peRatio = readFirst(
    normalized.peRatio,
    minPositive(
      readRaw(summaryDetail.trailingPE),
      readRaw(defaultKeyStatistics.forwardPE)
    )
  );

  const rocketChecks = [
    buildCheck("52W drawdown", drawdownFromHighPct, 30, ">", "price"),
    buildCheck("Growth", growthPct, 20, ">", "growth"),
    buildCheck("Current ratio", currentRatio, 1.5, ">", "liquidity")
  ];
  const moatChecks = [
    buildCheck("Margin", marginPct, 20, ">", "profitability"),
    buildCheck("ROE/ROIC", returnQualityPct, 15, ">", "capital returns"),
    buildCheck("P/E", peRatio, 15, "<", "valuation")
  ];

  const tags = [];
  if (rocketChecks.every((check) => check.passed)) {
    tags.push({
      key: "rocket",
      label: "ROCKET / HIGH VELOCITY",
      profile: "The High-Velocity Rocket"
    });
  }
  if (moatChecks.every((check) => check.passed)) {
    tags.push({
      key: "wideMoat",
      label: "WIDE-MOAT UNDERDOG",
      profile: "The Wide-Moat Powerhouse"
    });
  }

  return {
    ticker,
    source: rawFundamentals ? `Yahoo Finance ${rawFundamentals.sourceTicker || ticker}` : "Price action only",
    sourceTicker: rawFundamentals?.sourceTicker || ticker,
    fetchedAt: new Date().toISOString(),
    tags,
    metrics: {
      currentPrice: roundMetric(currentPrice),
      high52Week: roundMetric(high52Week),
      drawdownFromHighPct: roundMetric(drawdownFromHighPct),
      salesGrowthPct: roundMetric(salesGrowthPct),
      earningsGrowthPct: roundMetric(earningsGrowthPct),
      forwardEpsGrowthPct: roundMetric(forwardEpsGrowthPct),
      growthPct: roundMetric(growthPct),
      currentRatio: roundMetric(currentRatio),
      operatingMarginPct: roundMetric(operatingMarginPct),
      netMarginPct: roundMetric(netMarginPct),
      marginPct: roundMetric(marginPct),
      roePct: roundMetric(roePct),
      roicPct: roundMetric(roicPct),
      returnQualityPct: roundMetric(returnQualityPct),
      peRatio: roundMetric(peRatio)
    },
    profiles: {
      rocket: {
        label: "The High-Velocity Rocket",
        badge: "ROCKET / HIGH VELOCITY",
        score: countPassed(rocketChecks),
        total: rocketChecks.length,
        passed: rocketChecks.every((check) => check.passed),
        checks: rocketChecks
      },
      wideMoat: {
        label: "The Wide-Moat Powerhouse",
        badge: "WIDE-MOAT UNDERDOG",
        score: countPassed(moatChecks),
        total: moatChecks.length,
        passed: moatChecks.every((check) => check.passed),
        checks: moatChecks
      }
    }
  };
}

function buildCheck(label, value, threshold, operator, category) {
  const hasValue = value != null && value !== "" && Number.isFinite(Number(value));
  const numeric = hasValue ? Number(value) : null;
  const passed = hasValue && (operator === ">" ? numeric > threshold : numeric < threshold);
  return {
    label,
    category,
    value: roundMetric(numeric),
    threshold,
    operator,
    passed,
    available: hasValue
  };
}

function countPassed(checks) {
  return checks.filter((check) => check.passed).length;
}

function getLatestClose(priceData) {
  const latest = priceData?.points?.at(-1);
  return Number.isFinite(Number(latest?.close)) ? Number(latest.close) : null;
}

function getTrailingHigh(priceData, days) {
  const points = priceData?.points ?? [];
  if (!points.length) return null;
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  return maxNumber(...points.filter((point) => point.date >= cutoffDate).map((point) => point.close));
}

function getForwardEpsGrowth(rawFundamentals) {
  const trends = rawFundamentals?.earningsTrend?.trend ?? [];
  const preferred = trends.find((trend) => ["+1y", "nextYear"].includes(trend.period)) || trends.find((trend) => trend.growth);
  return readRaw(preferred?.growth);
}

function readRaw(value) {
  if (value == null || value === "") return null;
  const rawValue = value && typeof value === "object" && "raw" in value ? value.raw : value;
  const numeric = Number(rawValue);
  return Number.isFinite(numeric) ? numeric : null;
}

function readPositiveNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeOptionalPositiveLimit(value, fallback) {
  const source = value == null ? fallback : value;
  const numeric = Number(source);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function readFirst(...values) {
  for (const value of values) {
    const numeric = readRaw(value);
    if (numeric != null) return numeric;
  }
  return null;
}

function readPercentFirst(...values) {
  const value = readFirst(...values);
  return toPercent(value);
}

function toPercent(value) {
  if (value == null || value === "") return null;
  return Number.isFinite(Number(value)) ? Number(value) * 100 : null;
}

function maxNumber(...values) {
  const numbers = values.filter((value) => value != null && value !== "").map(Number).filter(Number.isFinite);
  return numbers.length ? Math.max(...numbers) : null;
}

function minPositive(...values) {
  const numbers = values.filter((value) => value != null && value !== "").map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return numbers.length ? Math.min(...numbers) : null;
}

function roundMetric(value) {
  return value != null && value !== "" && Number.isFinite(Number(value)) ? Number(Number(value).toFixed(2)) : null;
}

function normalizeStringList(value, fallback) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : fallback;
  const normalized = source.map((item) => String(item || "").trim()).filter(Boolean);
  return normalized.length ? [...new Set(normalized)] : [...fallback];
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length || 1);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }));

  return results;
}

async function fetchFxRates(startDate, endDate) {
  const url = `https://api.frankfurter.app/${startDate}..${endDate}?from=EUR&to=USD`;
  const data = await fetchJson(url);
  const rates = {};

  for (const [date, value] of Object.entries(data.rates ?? {})) {
    const usd = Number(value.USD);
    if (Number.isFinite(usd)) {
      rates[date] = { USD: usd };
    }
  }

  const latestRate = Object.values(rates).at(-1)?.USD ?? DEFAULT_MARKET_DATA.fx.latest;
  return {
    base: "EUR",
    rates,
    latest: latestRate
  };
}
