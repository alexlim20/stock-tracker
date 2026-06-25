const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_RESPONSE_TOKENS = 8192;

/**
 * Ask Gemini for a rich narrative stock briefing.
 *
 * @param {object} payload – The collected data for one stock.
 * @param {string|string[]} apiKeys  – Gemini API key(s).
 */
export async function askGemini(payload, apiKeys, options = {}) {
  const keys = Array.isArray(apiKeys) ? apiKeys.filter(Boolean) : [apiKeys].filter(Boolean);
  if (!keys.length) return null;

  const model = options.model || DEFAULT_MODEL;
  const { events, news, position, priceMetrics, quote, fundamentalsSnapshot } = payload;
  const isGemma = model.toLowerCase().includes("gemma");
  const systemPrompt = buildSystemPrompt(isGemma);
  const userPrompt = buildUserPrompt({
    events,
    news,
    position,
    priceMetrics,
    quote,
    fundamentalsSnapshot
  });


  const generationConfig = {
    temperature: 0.4,
    maxOutputTokens: MAX_RESPONSE_TOKENS,
    responseMimeType: "application/json"
  };

  if (!isGemma) {
    generationConfig.responseSchema = {
      type: "OBJECT",
      properties: {
        narrative: {
          type: "STRING",
          description: "Multi-paragraph markdown-formatted strategic briefing. Must contain ALL specific numbers from the input: dollar prices, percentage changes, margin targets, deal sizes, growth rates, RPO figures, historical benchmarks, and prior-period comparisons. Do NOT omit, round, or summarize away any numerical value."
        },
        marketMechanics: {
          type: "STRING",
          description: "Dedicated section covering volatility amplifiers: leveraged ETF tickers (e.g. NVDL, MSFU, TQQQ), options open interest and strike ranges, gamma squeeze potential, institutional positioning, short interest levels, and any structural market factors that could amplify price moves. Leave empty string if none are relevant."
        },
        impact: {
          type: "STRING",
          enum: ["Positive", "Negative", "Mixed", "Neutral"],
          description: "Overall sentiment tilt of the catalyst landscape."
        },
        confidence: {
          type: "STRING",
          enum: ["High", "Medium", "Low"],
          description: "How much hard data backs the assessment."
        },
        turningPointBias: {
          type: "STRING",
          description: "Upside watch, Downside watch, Two-way watch, or Neutral watch."
        },
        keyCatalysts: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              dateRange: { type: "STRING", description: "Specific, sharp date or narrow date range (e.g. 'July 24, 2026', 'Late July 2026', 'Q3 2026', or 'Within 30 Days'). Never output the generic 6-month window (like '2026-06-05 to 2026-12-05') or 'Next 6 Months'. If not explicitly mentioned in news, estimate the narrow range logically based on the event type and current date." },
              title: { type: "STRING", description: "Short catalyst title." },
              watchFor: { type: "STRING", description: "ALL specific metrics, thresholds, variables, AND historical baselines the market will scrutinize. Must include prior-period benchmarks for comparison (e.g. 'prior 31% constant-currency growth', 'prior 7% AI service contribution', 'previous $260B RPO'). Never omit a benchmark that appears in the source data." },
              bullCase: { type: "STRING", description: "What bullish outcome looks like. Must include specific target numbers, growth rates, and historical comparisons where the data provides them." },
              bearCase: { type: "STRING", description: "What bearish outcome looks like. Must include specific risk thresholds, prior-period baselines that could be missed, and downside trigger numbers." }
            },
            required: ["dateRange", "title", "watchFor", "bullCase", "bearCase"]
          },
          description: "EXHAUSTIVE list of catalyst windows. You MUST produce one entry for EVERY distinct catalyst event or theme in the input data. Omitting any catalyst is a critical failure. If the input mentions earnings, cloud bookings, RPO, regulatory events, product launches, and M&A separately, each gets its own entry."
        }
      },
      required: ["narrative", "marketMechanics", "impact", "confidence", "turningPointBias", "keyCatalysts"]
    };
  }

  const body = {
    contents: [
      {
        parts: [
          {
            text: isGemma
              ? `${systemPrompt}\n\n${userPrompt}\n\nIMPORTANT: You must output a single valid JSON object containing the following keys: "narrative" (string), "marketMechanics" (string), "impact" ("Positive", "Negative", "Mixed", or "Neutral"), "confidence" ("High", "Medium", or "Low"), "turningPointBias" (string), and "keyCatalysts" (array of objects with "dateRange", "title", "watchFor", "bullCase", "bearCase"). Do not output any markdown code blocks or other text.`
              : userPrompt
          }
        ]
      }
    ],
    generationConfig
  };

  if (!isGemma) {
    body.system_instruction = { parts: [{ text: systemPrompt }] };
  }

  let lastError = null;

  for (const apiKey of keys) {
    try {
      const url = `${GEMINI_API_BASE}/${model}:generateContent?key=${apiKey}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 180000); // 180 second timeout


      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "");
          console.error(`Gemini API error ${response.status}: ${errorText}`);
          if (response.status === 429 || response.status === 503 || response.status === 500) {
            lastError = new Error(response.status === 429 ? "QUOTA_EXHAUSTED" : `API_ERROR_${response.status}`);
            continue; // Try next key
          }
          return null; // Other non-quota, non-transient error, fail fast
        }

        const data = await response.json();

        // Check if the response was truncated by the token limit
        const finishReason = data.candidates?.[0]?.finishReason;
        if (finishReason === "MAX_TOKENS") {
          console.warn("Gemini response was truncated (MAX_TOKENS). Attempting repair.");
        }

        const parts = data.candidates?.[0]?.content?.parts || [];
        // Filter out parts representing thinking/thought (i.e. those with thought: true)
        const nonThoughtParts = parts.filter(p => !p.thought);
        let text = nonThoughtParts.map(p => p.text).join("").trim();
        if (!text && parts.length > 0) {
          text = parts[parts.length - 1]?.text;
        }
        if (!text) return null;


        // Clean any markdown code blocks or wrapper text
        text = extractJsonString(text);

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch (parseError) {
          // Attempt to repair truncated JSON by closing open strings/objects/arrays
          console.warn("Gemini returned invalid JSON, attempting repair…", parseError.message);
          parsed = tryRepairJson(text);
          if (!parsed) return null;
        }
        return sanitizeGeminiResponse(parsed);
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      console.error("Gemini request failed:", error.message ?? error);
      lastError = error;
      continue; // Try next key
    }
  }

  if (lastError) {
    throw lastError;
  }

  return null;
}

function buildSystemPrompt(isGemma = false) {
  return [
    "You are a senior equity research analyst writing a private catalyst briefing note for a portfolio manager.",
    "",
    "Your output must be a substantive, direct, and specific strategic briefing. Do NOT produce generic summaries.",
    "",
    "ABSOLUTE RULES:",
    "",
    "RULE 1 — NARRATIVE STRUCTURE:",
    "Start with 2-3 sentences of context anchored in EXACT numbers from the input: current price, 1D/5D/30D percentage moves, and the core market focus. Then cover every material catalyst window in the next 6 months: M&A, regulatory, product launches, government contracts, partnerships, balance sheet events, sector catalysts, and management commentary.",
    "",
    "RULE 2 — ZERO DATA LOSS (CRITICAL):",
    "You MUST preserve and echo back EVERY specific number from the input data without exception: dollar prices, percentage changes, EPS figures, margin percentages (e.g. '43-45% operating margin target'), revenue growth rates, deal sizes (e.g. '$11B Catalent transaction'), guidance ranges, RPO/backlog figures (e.g. '$260 billion RPO'), historical baselines and prior-period benchmarks (e.g. 'prior 31% constant-currency growth', 'prior 7% AI service contribution'). If a number or benchmark appears in the input, it MUST appear in your output narrative AND/OR in the keyCatalysts fields. Dropping ANY number is a critical failure.",
    "",
    "RULE 3 — EXHAUSTIVE CATALYST EXTRACTION (CRITICAL):",
    isGemma
      ? "You MUST produce one keyCatalyst entry for EVERY distinct catalyst event or analytical theme in the input. If the input news and events are empty or unavailable, you MUST still generate at least one keyCatalyst entry analyzing technical price consolidation, support/resistance levels, or momentum based on the 1D/5D/30D price metrics provided in the stock data. Never return an empty keyCatalysts array."
      : "You MUST produce one keyCatalyst entry for EVERY distinct catalyst event or analytical theme in the input. Count the distinct topics: if the input discusses earnings, cloud bookings, RPO pipeline, regulatory risk, product launches, and M&A integration separately, you MUST output 6 separate keyCatalyst entries. Merging distinct catalysts into fewer entries or omitting any catalyst is a critical failure.",
    "",
    "RULE 4 — HISTORICAL BENCHMARKS IN WATCHFOR:",
    "Every 'watchFor' field must include the specific prior-period baseline that the market will compare against. Example: instead of 'Azure growth rate', write 'Azure growth rate vs. prior 31% constant-currency benchmark'. Always anchor forward-looking metrics to their historical comparison point.",
    "",
    "RULE 5 — MARKET MECHANICS:",
    isGemma
      ? "The 'marketMechanics' field must capture volatility amplifiers: leveraged ETF tickers (NVDL, MSFU, TQQQ, etc.), options open interest concentrations, strike ranges, gamma squeeze potential, high short interest, and institutional positioning. If no notable options or ETF data is present, analyze general institutional liquidity, trading volume, or market beta relative to the sector. Never return an empty string or null."
      : "The 'marketMechanics' field must capture volatility amplifiers: leveraged ETF tickers (NVDL, MSFU, TQQQ, etc.), options open interest concentrations, strike ranges, gamma squeeze potential, high short interest, and institutional positioning. If the stock has no notable mechanics, return an empty string.",
    "",
    "RULE 6 — STYLE:",
    "Do NOT recommend buy, sell, or hold. Frame everything as what to watch and why it matters. Write in a direct, analytical tone. No filler. No disclaimers. No 'it remains to be seen' padding. Use **bold** for key terms and catalyst names. Use line breaks between sections. Do not use headings (no # or ##). The narrative must be 200-500 words.",
    "",
    "RULE 7 — HARD STOP (CRITICAL):",
    "The narrative MUST end cleanly after the final analytical point. Do NOT append any of the following at the end: 'Review around...', 'Next key date...', 'Watch date:...', 'Key dates to watch:', catalyst date summaries, or any list that echoes the keyCatalysts array. The keyCatalysts JSON array already holds that structured data. The narrative must simply stop after the last substantive sentence. Any trailing summary, echo, or date list is a critical failure.",
    "",
    "RULE 8 — HALLUCINATION GUARDRAIL (CRITICAL):",
    "If a fetched article does not explicitly mention the primary company name or stock ticker within its text body, discard it entirely. Do not hallucinate cross-sector corporate partnerships.",
    "",
    "RULE 9 — SPECIFIC CATALYST DATES (CRITICAL):",
    "For every entry in the keyCatalysts array, the 'dateRange' field MUST be a specific date or narrow date range (e.g. 'July 24, 2026', 'Late July 2026', 'Q3 2026', or 'Within 30 Days'). You MUST NOT output the generic 6-month window (like '2026-06-05 to 2026-12-05') or 'Next 6 Months' as the date range. If the source data does not state an exact date, estimate the narrow window logically based on when the event (e.g. quarterly earnings, trials, launch timelines) is expected to occur."
  ].join("\n");
}

function buildUserPrompt({ events, news, position, priceMetrics, quote, fundamentalsSnapshot }) {
  const today = new Date().toISOString().slice(0, 10);

  const trimmedEvents = (events ?? []).slice(0, 8).map((e) => ({
    date: e.date,
    type: e.type,
    title: e.title,
    details: e.details,
    certainty: e.certainty,
    importance: e.importance,
    category: e.category,
    direction: e.direction
  }));

  const trimmedNews = (news ?? []).slice(0, 10).map((n) => ({
    title: n.title,
    publisher: n.publisher,
    publishedAt: n.publishedAt
  }));

  const dataPayload = {
    today,
    ticker: quote.ledgerTicker,
    primaryTicker: quote.primaryTicker,
    companyName: quote.companyName,
    exchange: quote.exchange,
    priceMetrics: {
      latestPrice: priceMetrics.latestPrice,
      currency: priceMetrics.currency,
      change1d: priceMetrics.change1d,
      change5d: priceMetrics.change5d,
      change30d: priceMetrics.change30d
    },
    upcomingEvents: trimmedEvents,
    recentNews: trimmedNews
  };

  if (fundamentalsSnapshot) {
    dataPayload.fundamentals = fundamentalsSnapshot;
  }

  // Format the raw news headlines and publisher details into an explicit text body block
  const newsContent = trimmedNews.length > 0
    ? trimmedNews.map((n, i) => `[News Item #${i + 1}]
Source: ${n.publisher}
Published At: ${n.publishedAt}
Content: ${n.title}`).join("\n\n")
    : "No news content available in the immediate input.";

  return [
    `Write a catalyst briefing for ${quote.primaryTicker} (${quote.companyName}) covering the period from ${today} through the next 6 months.`,
    "",
    "IMPORTANT: Every number in the STOCK DATA below (prices, percentages, deal sizes, margin targets) MUST appear in your narrative output. Do not summarize or round them away.",
    "",
    "STOCK DATA:",
    JSON.stringify(dataPayload, null, 2),
    "",
    "RAW NEWS AND ANALYSIS CONTENT:",
    newsContent
  ].join("\n");
}

/**
 * Attempt to repair truncated JSON from Gemini.
 * Handles common truncation patterns: unclosed strings, trailing commas,
 * and missing closing braces/brackets.
 */
function attemptBasicClose(repaired) {
  repaired = repaired.replace(/[:,\s]+$/, '');

  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces--;
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
    }
  }

  if (inString) {
    repaired += '"';
  }

  repaired = repaired.replace(/,\s*$/, '');

  let tempBrackets = openBrackets;
  let tempBraces = openBraces;
  while (tempBrackets > 0) { repaired += ']'; tempBrackets--; }
  while (tempBraces > 0) { repaired += '}'; tempBraces--; }

  return repaired;
}

function tryRepairJson(text) {
  try {
    let repaired = text.trim();
    // Try simple parse first
    try {
      return JSON.parse(repaired);
    } catch {
      // Backtrack character by character to find a valid prefix that can be closed
      const maxBacktrack = Math.min(repaired.length, 2000);
      for (let i = 0; i < maxBacktrack; i++) {
        const candidate = repaired.slice(0, repaired.length - i);
        const closed = attemptBasicClose(candidate);
        if (closed) {
          try {
            return JSON.parse(closed);
          } catch {
            // continue backtracking
          }
        }
      }
    }
  } catch (err) {
    console.error("JSON repair failed — could not salvage Gemini response.", err);
  }
  return null;
}

function sanitizeGeminiResponse(raw) {
  const validImpacts = ["Positive", "Negative", "Mixed", "Neutral"];
  const validConfidence = ["High", "Medium", "Low"];

  const impact = validImpacts.includes(raw.impact) ? raw.impact : "Neutral";
  const confidence = validConfidence.includes(raw.confidence) ? raw.confidence : "Medium";

  let narrative = String(raw.narrative ?? "").trim();
  // Strip only explicit investment advice phrases, not individual financial words
  narrative = narrative.replace(/\b(you should (buy|sell|hold)|we recommend (buying|selling|holding))\b/gi, "monitor");

  // Aggressively strip ALL trailing echo/loop patterns
  // Pattern 1: "Review around...", "Next key date...", "Watch date:", "Key dates:" etc.
  narrative = narrative.replace(/\n\s*(?:Review around|Next (?:key )?date|Watch date|Key date[s]?(?: to watch)?|Next review|Upcoming date)[:\s].+$/gim, "");
  // Pattern 2: Trailing date-colon-title lists (e.g. "Late July 2026: Q4 FY26 Earnings...")
  // Only strip if it appears after the main narrative body as a summary block
  narrative = narrative.replace(/(?:\n\s*(?:(?:Early|Mid|Late|Q[1-4])\s+\w+\s+\d{4}|\w+\s+\d{4}|\d{4}-\d{2}-\d{2})\s*[:—–-]\s*.+){2,}\s*$/gm, "");
  // Pattern 3: Clean any final partial lines that are just a date reference
  narrative = narrative.replace(/\n\s*(?:(?:Early|Mid|Late)\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s*[:.]?\s*$/i, "");
  narrative = narrative.trim();

  if (!narrative || narrative.length < 50) return null;

  const turningPointBias = sanitizeBias(raw.turningPointBias, impact);

  let marketMechanics = String(raw.marketMechanics ?? "").trim();
  // Strip the same advice phrases from market mechanics
  marketMechanics = marketMechanics.replace(/\b(you should (buy|sell|hold)|we recommend (buying|selling|holding))\b/gi, "monitor");

  const keyCatalysts = Array.isArray(raw.keyCatalysts)
    ? raw.keyCatalysts
        .filter((c) => c && c.title && c.dateRange)
        .slice(0, 8)
        .map((c) => ({
          dateRange: String(c.dateRange),
          title: String(c.title),
          watchFor: String(c.watchFor ?? ""),
          bullCase: String(c.bullCase ?? ""),
          bearCase: String(c.bearCase ?? "")
        }))
    : [];

  return {
    narrative,
    marketMechanics: marketMechanics || "",
    impact,
    confidence,
    turningPointBias,
    keyCatalysts,
    analysisMode: "Gemini AI"
  };
}

function sanitizeBias(raw, impact) {
  const text = String(raw ?? "").toLowerCase();
  if (text.includes("upside")) return "Upside watch";
  if (text.includes("downside")) return "Downside watch";
  if (text.includes("two-way") || text.includes("two way")) return "Two-way watch";
  if (text.includes("neutral")) return "Neutral watch";
  // Fallback from impact
  if (impact === "Positive") return "Upside watch";
  if (impact === "Negative") return "Downside watch";
  if (impact === "Mixed") return "Two-way watch";
  return "Neutral watch";
}

function extractJsonString(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + 1);
  }
  return text;
}
