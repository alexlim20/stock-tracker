import { askGemini } from "./geminiIntel.js";

const LOOKAHEAD_MONTHS = 6;
const POSITION_EPSILON = 0.0005;
const USER_AGENT = "Mozilla/5.0 PortfolioTracker/0.1";

const US_EXCHANGES = new Set(["NMS", "NYQ", "NGM", "NCM", "ASE", "NAS"]);

const MONTHS = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11
};

export async function refreshStockIntelligence({ trades, marketData, geminiApiKeys = [], geminiModel = "" }) {
  const asOf = new Date();
  const startDate = asOf.toISOString().slice(0, 10);
  const endDate = addMonths(startDate, LOOKAHEAD_MONTHS);
  const positions = getOpenPositions(trades);

  if (!positions.length) {
    return {
      asOf: asOf.toISOString(),
      engine: getEngineName(),
      mode: "gemini",
      lookAheadMonths: LOOKAHEAD_MONTHS,
      lookAheadStartDate: startDate,
      lookAheadEndDate: endDate,
      items: []
    };
  }

  const quotes = await mapLimit(positions, 4, async (position) => resolveQuote(position.ticker));
  const quoteByTicker = Object.fromEntries(quotes.map((quote) => [quote.ledgerTicker, quote]));

  const items = await mapLimit(positions, 3, async (position) => {
    // Re-initialize for the current ticker loop
    const quote = quoteByTicker[position.ticker];
    const priceMetrics = getPriceMetrics(position.ticker, marketData);

    let interpretation = {
      analysisMode: "Gemini AI",
      confidence: "Medium",
      impact: "Neutral",
      interpretation: "Please configure a Gemini API key in Settings to generate stock intelligence.",
      turningPointBias: "Neutral watch",
      keyCatalysts: [],
      watchItems: [],
      reviewReason: "No Gemini API key provided."
    };

    let reviewDate = addDays(startDate, 14);
    let tickerNews = [];

    if (geminiApiKeys && geminiApiKeys.length > 0) {
      try {
        const query = quote.companyName.replace(/,?\s+(Inc|Corp|Corporation|Ltd|Incorporated)\.?$/i, "");
        const searchResult = await fetchYahooSearch(query, { quotesCount: 0, newsCount: 10 });
        const primaryName = getPrimaryName(quote.companyName);
        const tickerStr = String(position.ticker ?? "").toLowerCase();

        tickerNews = (searchResult.news ?? [])
          .filter((n) => {
            const headline = String(n.title ?? "").toLowerCase();
            const related = (n.relatedTickers ?? []).map((t) => String(t ?? "").toLowerCase());
            return headline.includes(primaryName) || headline.includes(tickerStr) || related.includes(tickerStr);
          })
          .map((n) => ({
            title: String(n.title ?? ""),
            publisher: String(n.publisher ?? ""),
            publishedAt: n.providerPublishTime
              ? new Date(n.providerPublishTime * 1000).toISOString()
              : new Date().toISOString(),
            url: String(n.link ?? "")
          }));

        const geminiResult = await askGemini(
          { position, priceMetrics, quote, news: tickerNews },
          geminiApiKeys,
          { model: geminiModel }
        );
        if (geminiResult) {
          interpretation = {
            impact: geminiResult.impact,
            confidence: geminiResult.confidence,
            turningPointBias: geminiResult.turningPointBias,
            interpretation: geminiResult.narrative,
            narrative: geminiResult.narrative,
            marketMechanics: geminiResult.marketMechanics || "",
            keyCatalysts: geminiResult.keyCatalysts,
            analysisMode: geminiResult.analysisMode,
            // watchItems removed: catalyst cards already display all structured data
            watchItems: [],
            // reviewReason: only shown when no catalyst cards exist, otherwise the cards are self-explanatory
            reviewReason: geminiResult.keyCatalysts?.length > 0
              ? ""
              : "No near-term catalyst identified. Use as a manual calendar check."
          };

          if (geminiResult.keyCatalysts && geminiResult.keyCatalysts.length > 0) {
            const firstCatalyst = geminiResult.keyCatalysts[0];
            const dates = extractDates(firstCatalyst.dateRange, startDate, endDate);
            if (dates.length > 0) {
              reviewDate = dates[0];
            }
          }
        }
      } catch (err) {
        if (err.message === "QUOTA_EXHAUSTED") {
          throw err;
        }
      }
    }

    return {
      ticker: position.ticker,
      primaryTicker: quote.primaryTicker,
      companyName: quote.companyName,
      shares: round(position.shares, 6),
      priceMetrics,
      upcomingEvents: [], // Scraper removed
      reviewDate,
      ...interpretation,
      news: tickerNews
    };
  });

  return {
    asOf: asOf.toISOString(),
    engine: getEngineName(),
    mode: "gemini",
    lookAheadMonths: LOOKAHEAD_MONTHS,
    lookAheadStartDate: startDate,
    lookAheadEndDate: endDate,
    items: items.sort((a, b) => a.reviewDate.localeCompare(b.reviewDate) || a.ticker.localeCompare(b.ticker)),
    sources: [
      "Gemini AI analyst"
    ]
  };
}

function getEngineName() {
  return "Gemini AI catalyst engine";
}

function getOpenPositions(trades) {
  const positions = new Map();
  for (const trade of [...(trades ?? [])].sort((a, b) => a.date.localeCompare(b.date))) {
    const ticker = String(trade.ticker ?? "").toUpperCase();
    if (!ticker) continue;
    const current = positions.get(ticker) ?? { ticker, shares: 0 };
    current.shares += trade.action === "SELL" ? -Number(trade.shares) : Number(trade.shares);
    if (Math.abs(current.shares) <= POSITION_EPSILON) current.shares = 0;
    positions.set(ticker, current);
  }

  return [...positions.values()]
    .filter((position) => Math.abs(position.shares) > POSITION_EPSILON)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

async function resolveQuote(ticker) {
  const fallback = {
    ledgerTicker: ticker,
    primaryTicker: ticker,
    companyName: ticker,
    exchange: ""
  };

  try {
    const search = await fetchYahooSearch(ticker, { quotesCount: 10, newsCount: 0 });
    const quotes = (search.quotes ?? []).filter((quote) => quote.quoteType === "EQUITY");
    const exact = quotes.find((quote) => quote.symbol?.toUpperCase() === ticker.toUpperCase()) ?? quotes[0];
    if (!exact) return fallback;

    const companyName = exact.longname ?? exact.shortname ?? ticker;
    let primary = exact;

    if (ticker.includes(".")) {
      const companySearch = await fetchYahooSearch(companyName, { quotesCount: 10, newsCount: 0 });
      const companyQuotes = (companySearch.quotes ?? []).filter((quote) => quote.quoteType === "EQUITY");
      primary =
        companyQuotes.find((quote) => US_EXCHANGES.has(quote.exchange) && !quote.symbol.includes(".")) ??
        companyQuotes.find((quote) => !quote.symbol.includes(".")) ??
        exact;
    }

    return {
      ledgerTicker: ticker,
      primaryTicker: primary.symbol ?? ticker,
      companyName: primary.longname ?? primary.shortname ?? companyName,
      exchange: primary.exchange ?? exact.exchange ?? "",
      ledgerExchange: exact.exchange ?? ""
    };
  } catch {
    return fallback;
  }
}

function getPriceMetrics(ticker, marketData) {
  const points = marketData?.prices?.[ticker]?.points ?? [];
  const latest = points.at(-1);
  return {
    latestPrice: round(latest?.close ?? 0, 4),
    currency: marketData?.prices?.[ticker]?.currency ?? "",
    change1d: round(changeFrom(points, 1), 2),
    change5d: round(changeFrom(points, 5), 2),
    change30d: round(changeFrom(points, 22), 2)
  };
}

function changeFrom(points, periodsBack) {
  if (points.length <= periodsBack) return 0;
  const latest = points.at(-1)?.close;
  const previous = points.at(-1 - periodsBack)?.close;
  if (!Number.isFinite(latest) || !Number.isFinite(previous) || previous === 0) return 0;
  return ((latest - previous) / previous) * 100;
}

async function fetchYahooSearch(query, { quotesCount, newsCount }) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(
    query
  )}&quotesCount=${quotesCount}&newsCount=${newsCount}&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query&multiQuoteQueryId=multi_quote_single_token_query&newsQueryId=news_cie_vespa`;
  return fetchJson(url);
}

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": USER_AGENT,
        ...(options.headers ?? {})
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function extractDates(text, startDate, endDate) {
  const dates = new Set();
  const monthPattern =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,\s*(20\d{2}))?\b/gi;
  const numericPattern = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g;

  for (const match of text.matchAll(monthPattern)) {
    const month = MONTHS[match[1].toLowerCase().replace(".", "")];
    const day = Number(match[2]);
    const year = match[3] ? Number(match[3]) : inferYear(month, day, startDate);
    const date = makeIsoDate(year, month, day);
    if (date && date >= startDate && date <= endDate) dates.add(date);
  }

  for (const match of text.matchAll(numericPattern)) {
    const month = Number(match[1]) - 1;
    const day = Number(match[2]);
    const year = Number(match[3]);
    const date = makeIsoDate(year, month, day);
    if (date && date >= startDate && date <= endDate) dates.add(date);
  }

  return [...dates].sort();
}

function inferYear(month, day, startDate) {
  const start = parseIso(startDate);
  const candidate = makeIsoDate(start.getUTCFullYear(), month, day);
  return candidate && candidate >= startDate ? start.getUTCFullYear() : start.getUTCFullYear() + 1;
}

function makeIsoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function addMonths(dateText, months) {
  const date = parseIso(dateText);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const date = parseIso(dateText);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function parseIso(dateText) {
  return new Date(`${dateText}T00:00:00Z`);
}

function round(value, digits) {
  return Number((Number(value) || 0).toFixed(digits));
}

function getPrimaryName(name) {
  return name
    .replace(/(?:Incorporated|Corporation|Corp|Co|Inc|Ltd|plc|Aktiengesellschaft|AG)\.?\s*$/i, "")
    .trim()
    .toLowerCase();
}
