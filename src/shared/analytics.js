const CURRENCIES = ["EUR", "USD"];

export const DEFAULT_RISK_FREE_RATE = 0.0455;

const COLOR_POOL = [
  "#0f766e",
  "#2563eb",
  "#dc2626",
  "#7c3aed",
  "#ca8a04",
  "#0891b2",
  "#be123c",
  "#4d7c0f",
  "#9333ea",
  "#ea580c"
];
const POSITION_EPSILON = 0.0005;
const TRADING_DAYS_PER_YEAR = 252;
const VOLATILITY_WINDOW_DAYS = 30;
const OPTIMIZER_LOOKBACK_DAYS = 252;
const MIN_OPTIMIZER_OBSERVATIONS = 60;
const MAX_OPTIMIZER_WEIGHT = 0.3;
const ROBUST_RETURN_BLEND = 0.4;
const RISK_PARITY_BLEND = 0.3;
const COVARIANCE_SHRINKAGE = 0.35;
const REBALANCE_DRIFT_THRESHOLD = 0.03;
const COVARIANCE_RIDGE = 1e-8;

export function emptyAnalytics(displayCurrency = "EUR", options = {}) {
  const riskFreeRate = normalizeRiskFreeRate(options.riskFreeRate);

  return {
    displayCurrency,
    summary: {
      grossInvested: 0,
      sellProceeds: 0,
      netInvested: 0,
      marketValue: 0,
      profit: 0,
      profitRatio: 0,
      openPositions: 0
    },
    portfolioSeries: [],
    profitSeries: [],
    stockTraceSeries: [],
    stockDcaSeries: {},
    yearlyPerformance: [],
    growthRebalance: emptyGrowthRebalance(riskFreeRate, displayCurrency),
    holdings: [],
    colors: {}
  };
}

export function buildAnalytics(trades, marketData, displayCurrency = "EUR", options = {}) {
  const riskFreeRate = normalizeRiskFreeRate(options.riskFreeRate);

  if (!Array.isArray(trades) || trades.length === 0) {
    return emptyAnalytics(displayCurrency, { riskFreeRate });
  }

  const sortedTrades = [...trades].sort((a, b) => a.date.localeCompare(b.date));
  const tickers = [...new Set(sortedTrades.map((trade) => trade.ticker))].sort();
  const colors = Object.fromEntries(tickers.map((ticker, index) => [ticker, COLOR_POOL[index % COLOR_POOL.length]]));
  const valuationDate = getLatestPortfolioValuationDate(sortedTrades, marketData);
  const dates = buildTimelineDates(sortedTrades, marketData, valuationDate);
  const positions = Object.fromEntries(tickers.map((ticker) => [ticker, { shares: 0, cost: 0 }]));
  let tradeIndex = 0;
  let grossInvested = 0;
  let sellProceeds = 0;
  const portfolioSeries = [];
  const profitSeries = [];

  for (const date of dates) {
    while (tradeIndex < sortedTrades.length && sortedTrades[tradeIndex].date <= date) {
      const trade = sortedTrades[tradeIndex];
      const amount = convertCurrency(trade.total_amount, trade.currency, displayCurrency, date, marketData);
      const position = positions[trade.ticker];

      if (trade.action === "BUY") {
        position.shares += trade.shares;
        position.cost += amount;
        grossInvested += amount;
      } else {
        const costPerShare = position.shares > POSITION_EPSILON ? position.cost / position.shares : 0;
        const removedShares = Math.min(trade.shares, Math.max(position.shares, 0));
        position.shares -= trade.shares;
        position.cost -= costPerShare * removedShares;
        if (Math.abs(position.shares) <= POSITION_EPSILON) {
          position.shares = 0;
          position.cost = 0;
        }
        sellProceeds += amount;
      }

      tradeIndex += 1;
    }

    const marketValue = tickers.reduce((sum, ticker) => {
      const position = positions[ticker];
      const shares = position.shares ?? 0;
      if (Math.abs(shares) <= POSITION_EPSILON) return sum;

      const marketPrice = getConvertedMarketPrice(ticker, date, displayCurrency, marketData);
      return sum + (Number.isFinite(marketPrice) ? shares * marketPrice : position.cost);
    }, 0);

    const netInvested = grossInvested - sellProceeds;
    const profit = marketValue + sellProceeds - grossInvested;
    const profitRatio = netInvested > 0 ? (profit / netInvested) * 100 : 0;

    portfolioSeries.push({
      date,
      grossInvested: roundMoney(grossInvested),
      netInvested: roundMoney(netInvested),
      marketValue: roundMoney(marketValue)
    });

    profitSeries.push({
      date,
      profit: roundMoney(profit),
      profitRatio: roundPercent(profitRatio)
    });
  }

  const finalPoint = portfolioSeries.at(-1) ?? {};
  const finalProfit = profitSeries.at(-1) ?? {};
  const portfolioReturnSeries = buildPortfolioReturnSeries(
    sortedTrades,
    dates,
    portfolioSeries,
    profitSeries,
    marketData,
    displayCurrency
  );
  const yearlyPerformance = buildYearlyPerformance(sortedTrades, dates, portfolioSeries, marketData, displayCurrency);
  const holdingRows = tickers
    .map((ticker) => {
      const position = positions[ticker];
      const shares = position.shares ?? 0;
      const marketPrice = getConvertedMarketPrice(ticker, dates.at(-1), displayCurrency, marketData);
      const latestPrice = Number.isFinite(marketPrice) ? marketPrice : position.cost / shares;
      return {
        ticker,
        shares,
        price: latestPrice,
        value: shares * latestPrice
      };
    })
    .filter((row) => Math.abs(row.shares) > POSITION_EPSILON)
    .sort((a, b) => b.value - a.value)
    .map((row) => ({
      ...row,
      shares: roundShares(row.shares),
      price: roundMoney(row.price),
      value: roundMoney(row.value)
    }));
  return {
    displayCurrency,
    summary: {
      grossInvested: finalPoint.grossInvested ?? 0,
      sellProceeds: roundMoney(sellProceeds),
      netInvested: finalPoint.netInvested ?? 0,
      marketValue: finalPoint.marketValue ?? 0,
      profit: finalProfit.profit ?? 0,
      profitRatio: finalProfit.profitRatio ?? 0,
      openPositions: holdingRows.length
    },
    portfolioSeries,
    profitSeries: portfolioReturnSeries,
    stockTraceSeries: buildStockProfitSeries(sortedTrades, dates, marketData, displayCurrency),
    stockDcaSeries: buildStockDcaSeries(sortedTrades, dates, marketData, displayCurrency),
    yearlyPerformance,
    growthRebalance: buildGrowthRebalance(holdingRows, marketData, { riskFreeRate, displayCurrency }),
    holdings: holdingRows,
    colors
  };
}

export function buildGrowthRebalance(activePositions = [], marketData, options = {}) {
  const riskFreeRate = normalizeRiskFreeRate(options.riskFreeRate);
  const displayCurrency = options.displayCurrency || "EUR";
  const positionMap = new Map();
  for (const position of Array.isArray(activePositions) ? activePositions : []) {
    const ticker = String(typeof position === "string" ? position : position?.ticker || "").trim();
    if (!ticker) continue;
    const value = typeof position === "string" ? 0 : Number(position?.value);
    positionMap.set(ticker, Number.isFinite(value) && value > 0 ? value : 0);
  }
  const tickers = [...positionMap.keys()];
  if (!tickers.length) return emptyGrowthRebalance(riskFreeRate, displayCurrency);

  const rawAssets = tickers.map((ticker) => buildOptimizerAsset(ticker, marketData, displayCurrency));
  const assets = applyRobustExpectedReturns(rawAssets);
  const covariance = buildAnnualizedCovarianceArray(assets);
  const optimized = optimizeMaxSharpePortfolio(assets, covariance, riskFreeRate);
  const riskParityWeights = buildRiskParityWeights(covariance);
  const weights = roundWeightsToUnity(
    projectWeightsToLongOnlySimplex(
      optimized.weights.map((weight, index) => (1 - RISK_PARITY_BLEND) * weight + RISK_PARITY_BLEND * (riskParityWeights[index] || 0)),
      0,
      getMaximumWeight(assets.length)
    )
  );
  const metrics = calculatePortfolioMetrics(weights, assets.map((asset) => asset.expectedReturn), covariance, riskFreeRate);
  const usableAssetCount = assets.filter((asset) => asset.returnSeries.length >= MIN_OPTIMIZER_OBSERVATIONS).length;
  const totalValue = [...positionMap.values()].reduce((sum, value) => sum + value, 0);
  const currentWeights = assets.map((asset) => (totalValue > 0 ? (positionMap.get(asset.ticker) || 0) / totalValue : 1 / assets.length));
  const turnover = currentWeights.reduce((sum, currentWeight, index) => sum + Math.abs((weights[index] || 0) - currentWeight), 0) / 2;
  const commonAsOf = getCommonLatestAssetDate(assets);
  const modelWarnings = buildRebalanceWarnings(assets, weights, turnover, commonAsOf, metrics);

  return {
    riskFreeRate: roundRatio(riskFreeRate),
    windowDays: VOLATILITY_WINDOW_DAYS,
    lookbackDays: OPTIMIZER_LOOKBACK_DAYS,
    tradingDaysPerYear: TRADING_DAYS_PER_YEAR,
    optimizer: "robust-max-sharpe-risk-parity-blend",
    currency: displayCurrency,
    maximumWeight: roundRatio(getMaximumWeight(assets.length)),
    rebalanceThreshold: REBALANCE_DRIFT_THRESHOLD,
    turnover: roundRatio(turnover),
    status: usableAssetCount === assets.length ? "ready" : usableAssetCount ? "partial-data" : "insufficient-data",
    confidence: getModelConfidence(assets),
    asOf: commonAsOf,
    warnings: modelWarnings,
    rollingVolatility: buildRollingVolatilityRows(assets),
    allocationWeights: Object.fromEntries(assets.map((asset, index) => [asset.ticker, weights[index] ?? 0])),
    expectedReturns: Object.fromEntries(assets.map((asset) => [asset.ticker, roundRatio(asset.expectedReturn)])),
    covarianceMatrix: serializeCovarianceMatrix(assets, covariance),
    portfolio: {
      expectedReturn: roundRatio(metrics.expectedReturn),
      volatility: roundRatio(metrics.volatility),
      sharpeRatio: roundRatio(metrics.sharpeRatio, 4)
    },
    assets: assets.map((asset, index) => {
      const volatility = asset.volatility ?? Math.sqrt(Math.max(covariance[index]?.[index] ?? 0, 0));
      const currentWeight = currentWeights[index] || 0;
      const targetWeight = weights[index] || 0;
      const drift = targetWeight - currentWeight;
      const targetValue = totalValue * targetWeight;
      const currentValue = positionMap.get(asset.ticker) || 0;
      return {
        ticker: asset.ticker,
        weight: targetWeight,
        currentWeight: roundRatio(currentWeight),
        drift: roundRatio(drift),
        currentValue: roundMoney(currentValue),
        targetValue: roundMoney(targetValue),
        tradeValue: roundMoney(targetValue - currentValue),
        action: Math.abs(drift) < REBALANCE_DRIFT_THRESHOLD ? "hold" : drift > 0 ? "add" : "trim",
        expectedReturn: roundRatio(asset.expectedReturn),
        historicalReturn: roundRatio(asset.historicalReturn),
        volatility: roundRatio(volatility),
        sharpeRatio: roundRatio(volatility > 0 ? (asset.expectedReturn - riskFreeRate) / volatility : 0, 4),
        observations: asset.returnSeries.length,
        latestDate: asset.latestDate,
        confidence: asset.confidence,
        currencyAdjusted: asset.currencyAdjusted,
        usesAdjustedClose: asset.usesAdjustedClose
      };
    })
  };
}

function emptyGrowthRebalance(riskFreeRate = DEFAULT_RISK_FREE_RATE, currency = "EUR") {
  return {
    riskFreeRate: roundRatio(riskFreeRate),
    windowDays: VOLATILITY_WINDOW_DAYS,
    lookbackDays: OPTIMIZER_LOOKBACK_DAYS,
    tradingDaysPerYear: TRADING_DAYS_PER_YEAR,
    optimizer: "robust-max-sharpe-risk-parity-blend",
    currency,
    maximumWeight: MAX_OPTIMIZER_WEIGHT,
    rebalanceThreshold: REBALANCE_DRIFT_THRESHOLD,
    turnover: 0,
    status: "empty",
    confidence: "insufficient",
    asOf: "",
    warnings: [],
    rollingVolatility: [],
    allocationWeights: {},
    expectedReturns: {},
    covarianceMatrix: {},
    portfolio: {
      expectedReturn: 0,
      volatility: 0,
      sharpeRatio: 0
    },
    assets: []
  };
}

function buildOptimizerAsset(ticker, marketData, displayCurrency) {
  const points = marketData?.prices?.[ticker]?.points ?? [];
  const sourceCurrency = marketData?.prices?.[ticker]?.currency || displayCurrency;
  const normalizedPoints = points.map((point) => ({
    date: point.date,
    close: convertCurrency(
      Number.isFinite(Number(point.adjustedClose)) ? Number(point.adjustedClose) : Number(point.close),
      sourceCurrency,
      displayCurrency,
      point.date,
      marketData
    )
  }));
  const rawReturnSeries = buildDailyReturnSeries(normalizedPoints).slice(-OPTIMIZER_LOOKBACK_DAYS);
  const returnSeries = winsorizeReturnSeries(rawReturnSeries);
  const returnValues = returnSeries.map((point) => point.value);
  const dailyVolatility = returnValues.length >= 2 ? sampleStd(returnValues) : null;
  const historicalReturn = annualizeGeometricReturn(returnValues);

  return {
    ticker,
    returnSeries,
    returnMap: new Map(returnSeries.map((point) => [point.date, point.value])),
    rawReturnSeries,
    historicalReturn,
    expectedReturn: historicalReturn,
    volatility: Number.isFinite(dailyVolatility) ? dailyVolatility * Math.sqrt(TRADING_DAYS_PER_YEAR) : null,
    latestDate: normalizedPoints.at(-1)?.date || returnSeries.at(-1)?.date || "",
    confidence: getAssetConfidence(returnSeries.length),
    currencyAdjusted: sourceCurrency !== displayCurrency,
    usesAdjustedClose: points.some((point) => Number.isFinite(Number(point.adjustedClose)))
  };
}

function buildDailyReturnSeries(points = []) {
  const sortedPoints = [...points]
    .map((point) => ({
      date: point.date,
      close: Number(point.close)
    }))
    .filter((point) => point.date && Number.isFinite(point.close) && point.close > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  const returns = [];
  let previous = null;

  for (const point of sortedPoints) {
    if (previous?.close > 0) {
      returns.push({
        date: point.date,
        value: point.close / previous.close - 1
      });
    }
    previous = point;
  }

  return returns;
}

function winsorizeReturnSeries(returnSeries) {
  if (returnSeries.length < 20) return returnSeries;
  const values = returnSeries.map((point) => point.value).filter(Number.isFinite).sort((left, right) => left - right);
  const lower = quantile(values, 0.02);
  const upper = quantile(values, 0.98);
  return returnSeries.map((point) => ({
    ...point,
    value: Math.min(Math.max(point.value, lower), upper)
  }));
}

function annualizeGeometricReturn(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value) && value > -1);
  if (!finiteValues.length) return 0;
  const meanLogReturn = mean(finiteValues.map((value) => Math.log1p(value)));
  const annualized = Math.expm1(meanLogReturn * TRADING_DAYS_PER_YEAR);
  return Number.isFinite(annualized) ? annualized : 0;
}

function applyRobustExpectedReturns(assets) {
  const historicalReturns = assets
    .filter((asset) => asset.returnSeries.length >= MIN_OPTIMIZER_OBSERVATIONS)
    .map((asset) => asset.historicalReturn);
  const prior = clamp(median(historicalReturns), -0.05, 0.2);

  return assets.map((asset) => {
    const reliability = Math.min(asset.returnSeries.length / OPTIMIZER_LOOKBACK_DAYS, 1);
    const assetBlend = ROBUST_RETURN_BLEND * reliability;
    const expectedReturn = clamp(assetBlend * asset.historicalReturn + (1 - assetBlend) * prior, -0.2, 0.45);
    return { ...asset, expectedReturn };
  });
}

function buildRollingVolatilityRows(assets) {
  const rowsByDate = new Map();

  for (const asset of assets) {
    const volatilitySeries = asset.rawReturnSeries || asset.returnSeries;
    if (volatilitySeries.length < VOLATILITY_WINDOW_DAYS) continue;

    for (let index = VOLATILITY_WINDOW_DAYS - 1; index < volatilitySeries.length; index += 1) {
      const windowReturns = volatilitySeries
        .slice(index - VOLATILITY_WINDOW_DAYS + 1, index + 1)
        .map((point) => point.value);
      const annualizedVolatility = sampleStd(windowReturns) * Math.sqrt(TRADING_DAYS_PER_YEAR);
      const date = volatilitySeries[index].date;
      const row = rowsByDate.get(date) ?? { date };
      row[asset.ticker] = roundRatio(annualizedVolatility);
      rowsByDate.set(date, row);
    }
  }

  return [...rowsByDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function buildAnnualizedCovarianceArray(assets) {
  const individualVariances = assets.map((asset) => {
    const values = asset.returnSeries.map((point) => point.value);
    const variance = values.length >= 2 ? sampleVariance(values) * TRADING_DAYS_PER_YEAR : null;
    return Number.isFinite(variance) && variance > 0 ? variance : null;
  });
  const fallbackVariance = Math.max(median(individualVariances.filter((value) => Number.isFinite(value))), 0.3 ** 2);

  const sampleCovariance = assets.map((left, leftIndex) =>
    assets.map((right, rightIndex) => {
      if (leftIndex === rightIndex) {
        return (individualVariances[leftIndex] ?? fallbackVariance) + COVARIANCE_RIDGE;
      }

      return getPairwiseAnnualizedCovariance(left, right);
    })
  );

  return sampleCovariance.map((row, rowIndex) =>
    row.map((value, columnIndex) => {
      if (rowIndex === columnIndex) return value;
      return value * (1 - COVARIANCE_SHRINKAGE);
    })
  );
}

function getPairwiseAnnualizedCovariance(left, right) {
  const paired = [];

  for (const point of left.returnSeries) {
    const rightValue = right.returnMap.get(point.date);
    if (Number.isFinite(rightValue)) {
      paired.push([point.value, rightValue]);
    }
  }

  if (paired.length < 2) return 0;

  const leftMean = mean(paired.map(([leftValue]) => leftValue));
  const rightMean = mean(paired.map(([, rightValue]) => rightValue));
  const covariance =
    paired.reduce((total, [leftValue, rightValue]) => total + (leftValue - leftMean) * (rightValue - rightMean), 0) /
    (paired.length - 1);

  return Number.isFinite(covariance) ? covariance * TRADING_DAYS_PER_YEAR : 0;
}

function optimizeMaxSharpePortfolio(assets, covariance, riskFreeRate) {
  const count = assets.length;
  if (!count) {
    return {
      weights: [],
      metrics: { expectedReturn: 0, volatility: 0, sharpeRatio: 0 }
    };
  }
  if (count === 1) {
    const weights = [1];
    return {
      weights,
      metrics: calculatePortfolioMetrics(weights, assets.map((asset) => asset.expectedReturn), covariance, riskFreeRate)
    };
  }

  const expectedReturns = assets.map((asset) => (Number.isFinite(asset.expectedReturn) ? asset.expectedReturn : 0));
  const maximumWeight = getMaximumWeight(count);
  let best = null;

  for (const start of buildInitialWeightCandidates(expectedReturns, covariance, riskFreeRate)) {
    let weights = projectWeightsToLongOnlySimplex(start, 0, maximumWeight);
    let metrics = calculatePortfolioMetrics(weights, expectedReturns, covariance, riskFreeRate);
    let step = 0.2;

    for (let iteration = 0; iteration < 650; iteration += 1) {
      const gradient = getSharpeGradient(weights, expectedReturns, covariance, riskFreeRate);
      const gradientNorm = Math.sqrt(gradient.reduce((total, value) => total + value ** 2, 0));
      if (!Number.isFinite(gradientNorm) || gradientNorm <= 1e-12) break;

      let improved = false;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const candidateWeights = projectWeightsToLongOnlySimplex(
          weights.map((weight, index) => weight + (step * gradient[index]) / gradientNorm),
          0,
          maximumWeight
        );
        const candidateMetrics = calculatePortfolioMetrics(candidateWeights, expectedReturns, covariance, riskFreeRate);

        if (candidateMetrics.sharpeRatio > metrics.sharpeRatio + 1e-10) {
          weights = candidateWeights;
          metrics = candidateMetrics;
          step *= 1.08;
          improved = true;
          break;
        }

        step *= 0.5;
      }

      if (!improved && step < 1e-8) break;
    }

    if (!best || metrics.sharpeRatio > best.metrics.sharpeRatio) {
      best = { weights, metrics };
    }
  }

  const weights = roundWeightsToUnity(best?.weights ?? buildEqualWeights(count));
  return {
    weights,
    metrics: calculatePortfolioMetrics(weights, expectedReturns, covariance, riskFreeRate)
  };
}

function buildInitialWeightCandidates(expectedReturns, covariance, riskFreeRate) {
  const count = expectedReturns.length;
  const minimumReturn = Math.min(...expectedReturns);
  const returnScores = expectedReturns.map((value) => Math.max(value - minimumReturn + 1e-6, 0));
  const excessScores = expectedReturns.map((value) => Math.max(value - riskFreeRate, 0));
  const sharpeScores = expectedReturns.map((value, index) => {
    const volatility = Math.sqrt(Math.max(covariance[index]?.[index] ?? 0, COVARIANCE_RIDGE));
    return Math.max((value - riskFreeRate) / volatility, 0);
  });
  const inverseVolatilityScores = covariance.map((row, index) => 1 / Math.sqrt(Math.max(row[index] ?? 0, COVARIANCE_RIDGE)));
  const candidates = [buildEqualWeights(count), returnScores, excessScores, sharpeScores, inverseVolatilityScores];

  for (let index = 0; index < count; index += 1) {
    candidates.push(Array.from({ length: count }, (_value, candidateIndex) => (candidateIndex === index ? 1 : 0)));
  }

  return candidates;
}

function projectWeightsToLongOnlySimplex(values, floor = 0, ceiling = 1) {
  const count = values.length;
  if (!count) return [];
  if (count === 1) return [1];

  const minimumWeight = Math.max(0, Math.min(floor, 1 / (count * 2)));
  const maximumWeight = Math.max(1 / count, Math.min(ceiling, 1));
  const finiteValues = values.map((value) => (Number.isFinite(value) ? value : 0));
  let lowerLambda = Math.min(...finiteValues.map((value) => value - maximumWeight)) - 1;
  let upperLambda = Math.max(...finiteValues.map((value) => value - minimumWeight)) + 1;

  for (let iteration = 0; iteration < 80; iteration += 1) {
    const lambda = (lowerLambda + upperLambda) / 2;
    const total = finiteValues.reduce((sum, value) => sum + clamp(value - lambda, minimumWeight, maximumWeight), 0);
    if (total > 1) lowerLambda = lambda;
    else upperLambda = lambda;
  }

  const lambda = (lowerLambda + upperLambda) / 2;
  return normalizeProjectedWeights(
    finiteValues.map((value) => clamp(value - lambda, minimumWeight, maximumWeight)),
    1
  );
}

function normalizeProjectedWeights(values, target = 1) {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return values.map(() => target / values.length);
  }

  const normalized = values.map((value) => (value / total) * target);
  const diff = target - normalized.reduce((sum, value) => sum + value, 0);
  const targetIndex = normalized.reduce((bestIndex, value, index) => (value > normalized[bestIndex] ? index : bestIndex), 0);
  normalized[targetIndex] += diff;
  return normalized;
}

function roundWeightsToUnity(weights) {
  if (!weights.length) return [];
  if (weights.length === 1) return [1];

  const scale = 1_000_000;
  const units = weights.map((weight) => Math.max(0, Math.round(weight * scale)));
  const largestIndex = units.reduce((bestIndex, value, index) => (value > units[bestIndex] ? index : bestIndex), 0);
  units[largestIndex] += scale - units.reduce((sum, value) => sum + value, 0);
  return units.map((unit) => Number((unit / scale).toFixed(6)));
}

function buildEqualWeights(count) {
  return Array.from({ length: count }, () => 1 / count);
}

function buildRiskParityWeights(covariance) {
  if (!covariance.length) return [];
  const scores = covariance.map((row, index) => 1 / Math.sqrt(Math.max(row[index] || 0, COVARIANCE_RIDGE)));
  return projectWeightsToLongOnlySimplex(scores, 0, getMaximumWeight(covariance.length));
}

function getMaximumWeight(count) {
  if (count <= 1) return 1;
  if (count === 2) return 0.7;
  if (count === 3) return 0.5;
  return Math.max(MAX_OPTIMIZER_WEIGHT, 1 / count);
}

function calculatePortfolioMetrics(weights, expectedReturns, covariance, riskFreeRate) {
  const expectedReturn = dot(weights, expectedReturns);
  const covarianceTimesWeights = multiplyMatrixVector(covariance, weights);
  const variance = Math.max(dot(weights, covarianceTimesWeights), COVARIANCE_RIDGE);
  const volatility = Math.sqrt(variance);
  const sharpeRatio = (expectedReturn - riskFreeRate) / volatility;

  return {
    expectedReturn: Number.isFinite(expectedReturn) ? expectedReturn : 0,
    volatility: Number.isFinite(volatility) ? volatility : 0,
    sharpeRatio: Number.isFinite(sharpeRatio) ? sharpeRatio : 0
  };
}

function getSharpeGradient(weights, expectedReturns, covariance, riskFreeRate) {
  const covarianceTimesWeights = multiplyMatrixVector(covariance, weights);
  const expectedReturn = dot(weights, expectedReturns);
  const variance = Math.max(dot(weights, covarianceTimesWeights), COVARIANCE_RIDGE);
  const volatility = Math.sqrt(variance);
  const excessReturn = expectedReturn - riskFreeRate;

  return expectedReturns.map((expectedReturnValue, index) => expectedReturnValue / volatility - (excessReturn * covarianceTimesWeights[index]) / volatility ** 3);
}

function multiplyMatrixVector(matrix, vector) {
  return matrix.map((row) => dot(row, vector));
}

function dot(left, right) {
  return left.reduce((total, value, index) => total + value * (right[index] ?? 0), 0);
}

function mean(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (!finiteValues.length) return 0;
  return finiteValues.reduce((total, value) => total + value, 0) / finiteValues.length;
}

function sampleVariance(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length < 2) return 0;
  const average = mean(finiteValues);
  return finiteValues.reduce((total, value) => total + (value - average) ** 2, 0) / (finiteValues.length - 1);
}

function sampleStd(values) {
  return Math.sqrt(Math.max(sampleVariance(values), 0));
}

function median(values) {
  const finiteValues = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!finiteValues.length) return 0;
  const midpoint = Math.floor(finiteValues.length / 2);
  return finiteValues.length % 2 === 0 ? (finiteValues[midpoint - 1] + finiteValues[midpoint]) / 2 : finiteValues[midpoint];
}

function quantile(sortedValues, probability) {
  if (!sortedValues.length) return 0;
  const index = (sortedValues.length - 1) * probability;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
  const fraction = index - lowerIndex;
  return sortedValues[lowerIndex] * (1 - fraction) + sortedValues[upperIndex] * fraction;
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function serializeCovarianceMatrix(assets, covariance) {
  return Object.fromEntries(
    assets.map((asset, rowIndex) => [
      asset.ticker,
      Object.fromEntries(assets.map((columnAsset, columnIndex) => [columnAsset.ticker, roundRatio(covariance[rowIndex]?.[columnIndex] ?? 0, 8)]))
    ])
  );
}

function getCommonLatestAssetDate(assets) {
  return assets
    .map((asset) => asset.latestDate)
    .filter(Boolean)
    .sort()
    .at(0) ?? "";
}

function getAssetConfidence(observations) {
  if (observations >= 200) return "high";
  if (observations >= 120) return "medium";
  if (observations >= MIN_OPTIMIZER_OBSERVATIONS) return "low";
  return "insufficient";
}

function getModelConfidence(assets) {
  if (!assets.length || assets.some((asset) => asset.confidence === "insufficient")) return "insufficient";
  if (assets.some((asset) => asset.confidence === "low")) return "low";
  if (assets.every((asset) => asset.confidence === "high" && asset.usesAdjustedClose)) return "high";
  return "medium";
}

function buildRebalanceWarnings(assets, weights, turnover, commonAsOf, metrics) {
  const warnings = [];
  const latestDates = [...new Set(assets.map((asset) => asset.latestDate).filter(Boolean))];
  if (latestDates.length > 1) warnings.push(`Common valuation date is ${commonAsOf}; newer quotes exist for only part of the portfolio.`);
  if (assets.some((asset) => !asset.usesAdjustedClose)) warnings.push("Some cached histories use closing prices; adjusted-close data will be used after the next successful refresh.");
  if (assets.some((asset) => asset.returnSeries.length < MIN_OPTIMIZER_OBSERVATIONS)) warnings.push("At least one holding has fewer than 60 usable daily returns.");
  if (turnover > 0.25) warnings.push("The strategic target implies high turnover; phase trades and account for fees and taxes.");
  if (weights.some((weight) => weight >= getMaximumWeight(weights.length) - 0.001)) warnings.push("The position cap is actively limiting concentration in the highest-ranked holdings.");
  if ((metrics?.sharpeRatio || 0) < 0.5) warnings.push("The portfolio has a weak estimated risk-adjusted return; treat target weights as risk control, not a strong buy signal.");
  return warnings;
}

function normalizeRiskFreeRate(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : DEFAULT_RISK_FREE_RATE;
}

export function formatCurrency(value, currency) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2
  }).format(value || 0);
}

export function formatPercent(value) {
  return `${(value || 0).toFixed(2)}%`;
}

function buildTimelineDates(trades, marketData, valuationDate) {
  const timelineEndDate = valuationDate || new Date().toISOString().slice(0, 10);
  const dates = new Set(trades.filter((trade) => trade.date <= timelineEndDate).map((trade) => trade.date));
  for (const tickerData of Object.values(marketData?.prices ?? {})) {
    for (const point of tickerData.points ?? []) {
      if (point.date >= trades[0].date && point.date <= timelineEndDate) {
        dates.add(point.date);
      }
    }
  }

  dates.add(timelineEndDate);
  return [...dates].sort();
}

function getLatestPortfolioValuationDate(trades, marketData) {
  const sharesByTicker = {};
  for (const trade of trades) {
    const signedShares = trade.action === "BUY" ? trade.shares : -trade.shares;
    sharesByTicker[trade.ticker] = (sharesByTicker[trade.ticker] || 0) + signedShares;
  }

  const activeTickers = Object.entries(sharesByTicker)
    .filter(([, shares]) => Math.abs(shares) > POSITION_EPSILON)
    .map(([ticker]) => ticker);
  const valuationDates = activeTickers
    .map((ticker) => marketData?.prices?.[ticker]?.points?.at(-1)?.date)
    .filter(Boolean);
  const hasUsdHolding = activeTickers.some((ticker) => marketData?.prices?.[ticker]?.currency === "USD");

  if (hasUsdHolding) {
    const latestFxDate = Object.keys(marketData?.fx?.rates ?? {}).sort().at(-1);
    if (latestFxDate) valuationDates.push(latestFxDate);
  }

  return valuationDates.sort().at(0) || null;
}

function buildStockProfitSeries(trades, dates, marketData, displayCurrency) {
  const tickers = [...new Set(trades.map((trade) => trade.ticker))].sort();
  const positions = Object.fromEntries(
    tickers.map((ticker) => [
      ticker,
      {
        shares: 0,
        cost: 0,
        grossInvested: 0,
        sellProceeds: 0,
        started: false
      }
    ])
  );
  let tradeIndex = 0;

  return dates.map((date) => {
    while (tradeIndex < trades.length && trades[tradeIndex].date <= date) {
      const trade = trades[tradeIndex];
      const amount = convertCurrency(trade.total_amount, trade.currency, displayCurrency, date, marketData);
      const position = positions[trade.ticker];
      position.started = true;

      if (trade.action === "BUY") {
        position.shares += trade.shares;
        position.cost += amount;
        position.grossInvested += amount;
      } else {
        const costPerShare = position.shares > POSITION_EPSILON ? position.cost / position.shares : 0;
        const removedShares = Math.min(trade.shares, Math.max(position.shares, 0));
        position.shares -= trade.shares;
        position.cost -= costPerShare * removedShares;
        if (Math.abs(position.shares) <= POSITION_EPSILON) {
          position.shares = 0;
          position.cost = 0;
        }
        position.sellProceeds += amount;
      }

      tradeIndex += 1;
    }

    const row = { date };
    for (const ticker of tickers) {
      const position = positions[ticker];
      if (!position.started) continue;

      const marketPrice = getConvertedMarketPrice(ticker, date, displayCurrency, marketData);
      const marketValue =
        Math.abs(position.shares) > POSITION_EPSILON
          ? Number.isFinite(marketPrice)
            ? position.shares * marketPrice
            : position.cost
          : 0;

      row[ticker] = roundMoney(marketValue + position.sellProceeds - position.grossInvested);
    }
    return row;
  });
}

function buildStockDcaSeries(trades, dates, marketData, displayCurrency) {
  const tickers = [...new Set(trades.map((trade) => trade.ticker))].sort();
  const positions = Object.fromEntries(
    tickers.map((ticker) => [
      ticker,
      {
        shares: 0,
        cost: 0,
        grossInvested: 0,
        sellProceeds: 0,
        started: false
      }
    ])
  );
  const seriesByTicker = Object.fromEntries(tickers.map((ticker) => [ticker, []]));
  let tradeIndex = 0;

  for (const date of dates) {
    while (tradeIndex < trades.length && trades[tradeIndex].date <= date) {
      const trade = trades[tradeIndex];
      const amount = convertCurrency(trade.total_amount, trade.currency, displayCurrency, date, marketData);
      const position = positions[trade.ticker];
      position.started = true;

      if (trade.action === "BUY") {
        position.shares += trade.shares;
        position.cost += amount;
        position.grossInvested += amount;
      } else {
        const costPerShare = position.shares > POSITION_EPSILON ? position.cost / position.shares : 0;
        const removedShares = Math.min(trade.shares, Math.max(position.shares, 0));
        position.shares -= trade.shares;
        position.cost -= costPerShare * removedShares;
        if (Math.abs(position.shares) <= POSITION_EPSILON) {
          position.shares = 0;
          position.cost = 0;
        }
        position.sellProceeds += amount;
      }

      tradeIndex += 1;
    }

    for (const ticker of tickers) {
      const position = positions[ticker];
      if (!position.started) continue;

      const marketPrice = getConvertedMarketPrice(ticker, date, displayCurrency, marketData);
      const shares = Math.abs(position.shares) > POSITION_EPSILON ? position.shares : 0;
      const averageCost = shares > POSITION_EPSILON ? position.cost / shares : null;
      const marketValue = shares && Number.isFinite(marketPrice) ? shares * marketPrice : 0;
      const profit = marketValue + position.sellProceeds - position.grossInvested;
      const returnRatio = averageCost && Number.isFinite(marketPrice) ? ((marketPrice - averageCost) / averageCost) * 100 : null;

      seriesByTicker[ticker].push({
        date,
        marketPrice: Number.isFinite(marketPrice) ? roundMoney(marketPrice) : null,
        averageCost: averageCost ? roundMoney(averageCost) : null,
        shares: roundShares(shares),
        positionCost: roundMoney(position.cost),
        grossInvested: roundMoney(position.grossInvested),
        sellProceeds: roundMoney(position.sellProceeds),
        marketValue: roundMoney(marketValue),
        profit: roundMoney(profit),
        returnRatio: returnRatio == null ? null : roundPercent(returnRatio)
      });
    }
  }

  return seriesByTicker;
}

function buildYearlyPerformance(trades, dates, portfolioSeries, marketData, displayCurrency) {
  const firstDate = trades[0]?.date;
  const lastDate = dates.at(-1);
  if (!firstDate || !lastDate) return [];

  const years = [];
  let index = 0;
  let startDate = firstDate;
  let cumulativeMultiplier = 1;

  while (startDate <= lastDate) {
    const nextStartDate = addYears(firstDate, index + 1);
    const plannedEndDate = addDays(nextStartDate, -1);
    const effectiveEndDate = plannedEndDate <= lastDate ? plannedEndDate : lastDate;
    const openingPoint = index === 0 ? null : getPointAtOrBefore(portfolioSeries, addDays(startDate, -1));
    const openingValue = openingPoint?.marketValue ?? 0;
    const periodPerformance = calculatePeriodPerformance(
      trades,
      portfolioSeries,
      marketData,
      displayCurrency,
      openingValue,
      startDate,
      effectiveEndDate
    );
    const { cashAdded, cashOut, endingValue, profit, returnRatio, weightedCapitalBase } = periodPerformance;
    cumulativeMultiplier *= 1 + returnRatio / 100;
    const cumulativeReturn = (cumulativeMultiplier - 1) * 100;

    years.push({
      year: `Year ${index + 1}`,
      startDate,
      endDate: effectiveEndDate,
      plannedEndDate,
      isComplete: effectiveEndDate === plannedEndDate,
      openingValue: roundMoney(openingValue),
      cashAdded: roundMoney(cashAdded),
      cashOut: roundMoney(cashOut),
      endingValue: roundMoney(endingValue),
      profit: roundMoney(profit),
      returnRatio: roundPercent(returnRatio),
      cumulativeReturn: roundPercent(cumulativeReturn),
      annualizedReturn: roundPercent(calculateAnnualizedReturn(cumulativeReturn, firstDate, effectiveEndDate)),
      weightedCapitalBase: roundMoney(weightedCapitalBase)
    });

    index += 1;
    startDate = nextStartDate;
  }

  return years;
}

function buildPortfolioReturnSeries(trades, dates, portfolioSeries, profitSeries, marketData, displayCurrency) {
  const firstDate = trades[0]?.date;
  if (!firstDate) return profitSeries;

  let periodIndex = 0;
  let periodStartDate = firstDate;
  let periodEndDate = addDays(addYears(firstDate, 1), -1);
  let openingValue = 0;
  let completedMultiplier = 1;

  return dates.map((date, index) => {
    while (date > periodEndDate) {
      const completedPeriod = calculatePeriodPerformance(
        trades,
        portfolioSeries,
        marketData,
        displayCurrency,
        openingValue,
        periodStartDate,
        periodEndDate
      );
      completedMultiplier *= 1 + completedPeriod.returnRatio / 100;
      periodIndex += 1;
      periodStartDate = addYears(firstDate, periodIndex);
      periodEndDate = addDays(addYears(firstDate, periodIndex + 1), -1);
      openingValue = getPointAtOrBefore(portfolioSeries, addDays(periodStartDate, -1))?.marketValue ?? 0;
    }

    const runningPeriod = calculatePeriodPerformance(
      trades,
      portfolioSeries,
      marketData,
      displayCurrency,
      openingValue,
      periodStartDate,
      date
    );
    const cumulativeReturn = (completedMultiplier * (1 + runningPeriod.returnRatio / 100) - 1) * 100;

    return {
      ...profitSeries[index],
      cumulativeReturn: roundPercent(cumulativeReturn)
    };
  });
}

function calculatePeriodPerformance(trades, portfolioSeries, marketData, displayCurrency, openingValue, startDate, endDate) {
  const endingValue = getPointAtOrBefore(portfolioSeries, endDate)?.marketValue ?? 0;
  const periodTrades = trades.filter((trade) => trade.date >= startDate && trade.date <= endDate);
  const cashAdded = periodTrades.reduce((sum, trade) => {
    if (trade.action !== "BUY") return sum;
    return sum + convertCurrency(trade.total_amount, trade.currency, displayCurrency, trade.date, marketData);
  }, 0);
  const cashOut = periodTrades.reduce((sum, trade) => {
    if (trade.action !== "SELL") return sum;
    return sum + convertCurrency(trade.total_amount, trade.currency, displayCurrency, trade.date, marketData);
  }, 0);
  const profit = endingValue + cashOut - openingValue - cashAdded;
  const weightedCapitalBase = calculateModifiedDietzCapitalBase(
    openingValue,
    periodTrades,
    startDate,
    endDate,
    marketData,
    displayCurrency
  );
  const returnRatio = weightedCapitalBase > 0 ? (profit / weightedCapitalBase) * 100 : 0;

  return { cashAdded, cashOut, endingValue, profit, returnRatio, weightedCapitalBase };
}

function calculateModifiedDietzCapitalBase(openingValue, trades, startDate, endDate, marketData, displayCurrency) {
  const periodDays = Math.max(1, differenceInDays(startDate, endDate));
  const weightedNetFlows = trades.reduce((sum, trade) => {
    const elapsedDays = Math.min(periodDays, Math.max(0, differenceInDays(startDate, trade.date)));
    const remainingPeriodWeight = (periodDays - elapsedDays) / periodDays;
    const amount = convertCurrency(trade.total_amount, trade.currency, displayCurrency, trade.date, marketData);
    const signedFlow = trade.action === "BUY" ? amount : -amount;
    return sum + signedFlow * remainingPeriodWeight;
  }, 0);

  return openingValue + weightedNetFlows;
}

function calculateAnnualizedReturn(cumulativeReturn, startDate, endDate) {
  const elapsedDays = differenceInDays(startDate, endDate);
  const growthFactor = 1 + cumulativeReturn / 100;
  if (elapsedDays <= 0 || growthFactor <= 0) return 0;
  return (Math.pow(growthFactor, 365 / elapsedDays) - 1) * 100;
}

function convertCurrency(amount, fromCurrency, toCurrency, date, marketData) {
  if (!CURRENCIES.includes(fromCurrency) || !CURRENCIES.includes(toCurrency)) return amount;
  if (fromCurrency === toCurrency) return amount;

  const eurUsd = getEurUsdRate(date, marketData);
  if (fromCurrency === "EUR" && toCurrency === "USD") {
    return amount * eurUsd;
  }

  if (fromCurrency === "USD" && toCurrency === "EUR") {
    return amount / eurUsd;
  }

  return amount;
}

function getConvertedMarketPrice(ticker, date, displayCurrency, marketData) {
  const tickerData = marketData?.prices?.[ticker];
  const rawPrice = getRawPrice(ticker, date, marketData);

  if (Number.isFinite(rawPrice)) {
    return convertCurrency(rawPrice, tickerData?.currency ?? displayCurrency, displayCurrency, date, marketData);
  }

  return null;
}

function getRawPrice(ticker, date, marketData) {
  const points = marketData?.prices?.[ticker]?.points ?? [];
  let candidate = null;
  for (const point of points) {
    if (point.date > date) break;
    candidate = point;
  }

  return candidate?.close;
}

function getEurUsdRate(date, marketData) {
  const rates = marketData?.fx?.rates ?? {};
  if (rates[date]?.USD) return rates[date].USD;

  let candidate = null;
  for (const rateDate of Object.keys(rates).sort()) {
    if (rateDate > date) break;
    candidate = rates[rateDate];
  }

  return candidate?.USD ?? marketData?.fx?.latest ?? 1.08;
}

function getPointAtOrBefore(points, date) {
  let candidate = null;
  for (const point of points) {
    if (point.date > date) break;
    candidate = point;
  }

  return candidate;
}

function addYears(dateText, years) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function differenceInDays(startDateText, endDateText) {
  const startDate = new Date(`${startDateText}T00:00:00Z`);
  const endDate = new Date(`${endDateText}T00:00:00Z`);
  return Math.round((endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));
}

function roundMoney(value) {
  return Number((value || 0).toFixed(2));
}

function roundPercent(value) {
  return Number((value || 0).toFixed(2));
}

function roundShares(value) {
  return Number((value || 0).toFixed(6));
}

function roundRatio(value, precision = 6) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(precision));
}
