import React, { useEffect, useState } from "react";
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
import { Activity, Gauge, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { buildMarketPulseView, createSeedMarketPulseCache } from "../shared/marketPulseData.js";
import { portfolioApi } from "./api.js";

const TIMEFRAME_OPTIONS = [
  { value: "30d", label: "30D", days: 30 },
  { value: "1y", label: "1Y", days: 365 },
  { value: "all", label: "All", days: null }
];

const MACRO_MODULES = [
  {
    id: "liquidity",
    kicker: "Liquidity Engine",
    title: "Bitcoin vs Global Liquidity",
    tabs: [
      { value: "gli", label: "GLI lead-lag" },
      { value: "walcl", label: "WALCL" },
      { value: "goldDollar", label: "Gold vs USD" }
    ]
  },
  {
    id: "inflation",
    kicker: "Inflation & Central Banks",
    title: "Inflation Pipeline Overlay",
    tabs: [
      { value: "pipeline", label: "CPI / PPI" },
      { value: "fedwatch", label: "FedWatch" }
    ]
  },
  {
    id: "labor",
    kicker: "Growth & Labor Market",
    title: "Jobless Claims Engine",
    tabs: [
      { value: "claims", label: "Claims" },
      { value: "nfp", label: "Payrolls" },
      { value: "growth", label: "GDP / Jobs" }
    ]
  },
  {
    id: "valuation",
    kicker: "Valuation & Flows",
    title: "200-Week MA Extension Bands",
    tabs: [
      { value: "bands", label: "MA bands" },
      { value: "mvrv", label: "MVRV" },
      { value: "dat", label: "DAT flows" },
      { value: "relative", label: "Relative" }
    ]
  }
];

const MARKET_PULSE_DATA_CONTRACT = [
  "dxy",
  "cryptoFearGreed",
  "equityFearGreed",
  "globalLiquidityIndexLead75d",
  "walcl",
  "centralBankGoldReserves",
  "adjustedUsdReserveAssets",
  "coreCpiYoY",
  "corePpiYoY",
  "effectiveFederalFundsRate",
  "initialJoblessClaims",
  "continuingJoblessClaims",
  "nonfarmPayrolls",
  "realGdpGrowth",
  "civilianUnemploymentRate",
  "ma200WeekExtensionBands",
  "mvrvDeviationBands",
  "datCorporateInflows",
  "relativePerformance"
];

export default function MarketPulseDashboard({ isDarkMode, onToggleTheme }) {
  const [timeframe, setTimeframe] = useState("1y");
  const [data, setData] = useState(() => buildMarketPulseView(createSeedMarketPulseCache(), "1y"));
  const [status, setStatus] = useState("Cached macro data ready");
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeTabs, setActiveTabs] = useState({
    liquidity: "gli",
    inflation: "pipeline",
    labor: "claims",
    valuation: "bands"
  });
  const [crosshairDate, setCrosshairDate] = useState("");
  const [maximizedModule, setMaximizedModule] = useState("");
  const [valuationAsset, setValuationAsset] = useState("BTC");

  const dataContract = MARKET_PULSE_DATA_CONTRACT.length;

  useEffect(() => {
    let isActive = true;
    portfolioApi.getMarketPulseData?.({ timeframe })
      .then((result) => {
        if (!isActive || !result?.data) return;
        setData(result.data);
        setStatus(getMarketPulseStatus(result.data));
      })
      .catch((error) => {
        if (isActive) setStatus(`Cached fallback active: ${error.message}`);
      });
    return () => {
      isActive = false;
    };
  }, [timeframe]);

  function setModuleTab(moduleId, tabValue) {
    setActiveTabs((current) => ({ ...current, [moduleId]: tabValue }));
  }

  async function handleRefreshMarketPulse() {
    setIsRefreshing(true);
    setStatus("Refreshing free macro feeds");
    try {
      const result = await portfolioApi.refreshMarketPulseData?.({ timeframe, force: true });
      if (result?.data) {
        setData(result.data);
        setStatus(getMarketPulseStatus(result.data));
      }
    } catch (error) {
      setStatus(`Refresh failed, cache retained: ${error.message}`);
    } finally {
      setIsRefreshing(false);
    }
  }

  return (
    <section className={`market-pulse-shell${maximizedModule ? " has-maximized" : ""}`}>
      <header className="market-pulse-topbar">
        <div>
          <p className="eyebrow">Macro Terminal</p>
          <h1>Market Pulse</h1>
        </div>
        <div className="market-pulse-actions">
          <span>{dataContract} live-ready metrics mapped · {status}</span>
          <div className="segmented market-timeframe-tabs" aria-label="Global macro timeframe">
            {TIMEFRAME_OPTIONS.map((option) => (
              <button
                className={timeframe === option.value ? "active" : ""}
                key={option.value}
                onClick={() => setTimeframe(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <button className="icon-button" disabled={isRefreshing} onClick={handleRefreshMarketPulse} type="button">
            <RefreshCw size={16} />
            {isRefreshing ? "Refreshing" : "Refresh Macro"}
          </button>
        </div>
      </header>

      <div className="market-pulse-kpi-strip">
        <DxyCard dxy={data.kpis.dxy} />
        <SentimentCard
          icon={<Gauge size={18} />}
          sentiment={data.kpis.cryptoFearGreed}
          title="Crypto Sentiment"
        />
        <SentimentCard
          icon={<Activity size={18} />}
          sentiment={data.kpis.equityFearGreed}
          title="Equity Sentiment"
        />
      </div>

      <section className="macro-workspace-grid" onMouseLeave={() => setCrosshairDate("")}>
        {MACRO_MODULES.map((module) => (
          <MacroQuadrant
            activeTab={activeTabs[module.id]}
            crosshairDate={crosshairDate}
            data={data}
            isMaximized={maximizedModule === module.id}
            key={module.id}
            module={module}
            onCrosshair={setCrosshairDate}
            onTabChange={(tabValue) => setModuleTab(module.id, tabValue)}
            onToggleMaximize={() => setMaximizedModule((current) => (current === module.id ? "" : module.id))}
            timeframe={timeframe}
            valuationAsset={valuationAsset}
            onValuationAssetChange={setValuationAsset}
          />
        ))}
      </section>
    </section>
  );
}

function DxyCard({ dxy }) {
  const tone = dxy.changePct >= 0 ? "good" : "bad";
  return (
    <article className="macro-kpi-card dxy-card">
      <div className="macro-kpi-copy">
        <span>US Dollar Index</span>
        <strong>{dxy.value.toFixed(2)}</strong>
        <em className={tone}>{formatSignedPercent(dxy.changePct)}</em>
      </div>
      <div className="macro-sparkline">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={dxy.sparkline} margin={{ top: 8, right: 4, bottom: 6, left: 4 }}>
            <Line dataKey="value" dot={false} isAnimationActive={false} stroke={tone === "good" ? "#22c55e" : "#ef4444"} strokeWidth={2.2} type="monotone" />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </article>
  );
}

function getMarketPulseStatus(data) {
  const updatedAt = data?.meta?.updatedAt;
  if (!updatedAt) return "seed cache";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "cache loaded";
  return `cache ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function SentimentCard({ icon, sentiment, title }) {
  return (
    <article className={`macro-kpi-card sentiment-card ${sentiment.tone}`}>
      <div className="macro-kpi-copy">
        <span>{title}</span>
        <strong>{sentiment.score}</strong>
        <em>{sentiment.label}</em>
      </div>
      <div className="sentiment-gauge-wrap">
        <div className="sentiment-gauge" style={{ "--score": sentiment.score }}>
          {icon}
          <b>{sentiment.score}</b>
        </div>
      </div>
    </article>
  );
}

function MacroQuadrant({
  activeTab,
  crosshairDate,
  data,
  isMaximized,
  module,
  onCrosshair,
  onTabChange,
  onToggleMaximize,
  timeframe,
  valuationAsset,
  onValuationAssetChange
}) {
  return (
    <article className={`macro-quadrant${isMaximized ? " maximized" : ""}`}>
      <div className="macro-card-header">
        <div className="macro-card-title">
          <span>{module.kicker}</span>
          <strong>{getModuleTitle(module, activeTab)}</strong>
        </div>
        <div className="macro-card-controls">
          <div className="segmented macro-module-tabs" aria-label={`${module.title} module tabs`} style={{ "--macro-tab-count": module.tabs.length }}>
            {module.tabs.map((tab) => (
              <button
                className={activeTab === tab.value ? "active" : ""}
                key={tab.value}
                onClick={() => onTabChange(tab.value)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>
          <button className="macro-expand-button" onClick={onToggleMaximize} title={isMaximized ? "Minimize" : "Maximize"} type="button">
            {isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </div>
      </div>
      <div className="macro-chart-body">
        {renderModuleView({
          activeTab,
          crosshairDate,
          data,
          moduleId: module.id,
          onCrosshair,
          timeframe,
          valuationAsset,
          onValuationAssetChange
        })}
      </div>
    </article>
  );
}

function getModuleTitle(module, activeTab) {
  if (module.id !== "valuation") return module.title;
  return {
    bands: "200-Week MA Extension Bands",
    mvrv: "MVRV Extreme Deviation Bands",
    dat: "DAT Inflows by Asset",
    relative: "Relative Performance"
  }[activeTab] || module.title;
}

function renderModuleView({ activeTab, crosshairDate, data, moduleId, onCrosshair, timeframe, valuationAsset, onValuationAssetChange }) {
  if (moduleId === "liquidity") {
    if (activeTab === "walcl") {
      const series = filterSeries(data.liquidity.walcl, timeframe);
      const walclDomain = getPaddedNumericDomain(series, ["value"], {
        clampMin: 0,
        digits: 2,
        minSpan: 0.45,
        paddingRatio: 0.16,
        step: 0.05
      });
      return (
        <AreaChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
          <defs>
            <linearGradient id="walclFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="5%" stopColor="#14b8a6" stopOpacity={0.26} />
              <stop offset="95%" stopColor="#14b8a6" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#26323b" vertical={false} />
          <XAxis dataKey="date" minTickGap={28} tickLine={false} axisLine={false} />
          <YAxis domain={walclDomain} tickFormatter={formatTrillions} tickLine={false} axisLine={false} width={62} />
          <Tooltip formatter={(value) => formatTrillions(value)} labelFormatter={(label) => `Date ${label}`} />
          {linkedGuide(series, crosshairDate)}
          <Area dataKey="value" fill="url(#walclFill)" name="Fed assets" stroke="#14b8a6" strokeWidth={2.4} type="monotone" />
        </AreaChartFrame>
      );
    }

    if (activeTab === "goldDollar") {
      const series = filterSeries(data.liquidity.goldDollar, timeframe);
      return (
        <LineChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
          <CartesianGrid stroke="#26323b" vertical={false} />
          <XAxis dataKey="date" minTickGap={28} tickLine={false} axisLine={false} />
          <YAxis tickFormatter={formatTrillions} tickLine={false} axisLine={false} width={62} />
          <Tooltip formatter={(value) => formatTrillions(value)} labelFormatter={(label) => `Date ${label}`} />
          <Legend iconType="plainline" verticalAlign="bottom" height={24} />
          {linkedGuide(series, crosshairDate)}
          <Line dataKey="goldReserves" dot={false} name="Central bank gold" stroke="#f59e0b" strokeWidth={2.3} type="monotone" />
          <Line dataKey="usdReserves" dot={false} name="Adjusted USD reserves" stroke="#60a5fa" strokeWidth={2.3} type="monotone" />
        </LineChartFrame>
      );
    }

    const series = filterSeries(data.liquidity.gliLeadLag, timeframe);
    return (
      <LineChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
        <CartesianGrid stroke="#26323b" vertical={false} />
        <XAxis dataKey="date" minTickGap={28} tickLine={false} axisLine={false} />
        <YAxis yAxisId="gli" domain={[60, 160]} tickFormatter={(value) => Number(value).toFixed(0)} tickLine={false} axisLine={false} width={50} />
        <YAxis yAxisId="btc" orientation="right" tickFormatter={formatCompactUsd} tickLine={false} axisLine={false} width={72} />
        <Tooltip formatter={(value, name) => (name === "BTC price" ? formatUsd(value) : Number(value).toFixed(2))} labelFormatter={(label) => `Date ${label}`} />
        <Legend iconType="plainline" verticalAlign="bottom" height={24} />
        {linkedGuide(series, crosshairDate)}
        <Line yAxisId="btc" dataKey="btc" dot={false} name="BTC price" stroke="#f97316" strokeWidth={2.2} type="monotone" />
        <Line yAxisId="gli" dataKey="gliShifted" dot={false} name="GLI +75d" stroke="#14b8a6" strokeWidth={2.5} type="monotone" />
      </LineChartFrame>
    );
  }

  if (moduleId === "inflation") {
    if (activeTab === "fedwatch") {
      const series = data.inflation.fedFundsRate || [];
      const rateDomain = getPaddedNumericDomain(series, ["value"], {
        clampMin: 0,
        digits: 2,
        minSpan: 1,
        paddingRatio: 0.18,
        step: 0.25
      });
      return (
        <LineChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
          <CartesianGrid stroke="#26323b" vertical={false} />
          <XAxis dataKey="date" minTickGap={28} tickLine={false} axisLine={false} />
          <YAxis domain={rateDomain} tickFormatter={(value) => `${Number(value).toFixed(1)}%`} tickLine={false} axisLine={false} width={58} />
          <Tooltip formatter={(value) => `${Number(value).toFixed(3)}%`} labelFormatter={(label) => `Date ${label}`} />
          {linkedGuide(series, crosshairDate)}
          <Line dataKey="value" dot={false} name="Effective Fed Funds Rate" stroke="#f59e0b" strokeWidth={2.5} type="monotone" />
        </LineChartFrame>
      );
    }
    const series = filterSeries(data.inflation.pipeline, timeframe);
    const inflationDomain = getPaddedNumericDomain(series, ["coreCpi", "corePpi"], {
      clampMin: 0,
      digits: 2,
      minSpan: 1,
      paddingRatio: 0.18,
      step: 0.25
    });
    return (
      <LineChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
        <CartesianGrid stroke="#26323b" vertical={false} />
        <XAxis dataKey="date" minTickGap={28} tickLine={false} axisLine={false} />
        <YAxis domain={inflationDomain} tickFormatter={(value) => `${value.toFixed(1)}%`} tickLine={false} axisLine={false} width={58} />
        <Tooltip formatter={(value) => `${Number(value).toFixed(2)}%`} labelFormatter={(label) => `Date ${label}`} />
        <Legend iconType="plainline" verticalAlign="bottom" height={24} />
        {linkedGuide(series, crosshairDate)}
        <Line dataKey="coreCpi" dot={false} name="Core CPI YoY" stroke="#ef4444" strokeWidth={2.4} type="monotone" />
        <Line dataKey="corePpi" dot={false} name="Core PPI YoY" stroke="#f59e0b" strokeWidth={2.4} type="monotone" />
      </LineChartFrame>
    );
  }

  if (moduleId === "labor") {
    if (activeTab === "nfp") {
      const series = filterSeries(data.labor.payrolls, timeframe);
      return (
        <ComposedChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
          <CartesianGrid stroke="#26323b" vertical={false} />
          <XAxis dataKey="date" minTickGap={20} tickLine={false} axisLine={false} height={34} />
          <YAxis domain={[-1000, 1000]} tickFormatter={(value) => `${value}K`} tickLine={false} axisLine={false} width={60} />
          <Tooltip
            formatter={(value, _name, item) => `${Number(item?.payload?.jobs ?? value).toFixed(0)}K jobs`}
            labelFormatter={(label) => `Month ${label}`}
          />
          <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" />
          {linkedGuide(series, crosshairDate)}
          <Bar dataKey="jobsDisplay" name="Net payrolls" radius={[4, 4, 0, 0]}>
            {series.map((point) => <Cell fill={point.jobs >= 0 ? "#14b8a6" : "#ef4444"} key={point.date} />)}
          </Bar>
        </ComposedChartFrame>
      );
    }

    if (activeTab === "growth") {
      const series = filterSeries(data.labor.growth, timeframe);
      return (
        <LineChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
          <CartesianGrid stroke="#26323b" vertical={false} />
          <XAxis dataKey="date" minTickGap={28} tickLine={false} axisLine={false} />
          <YAxis yAxisId="gdp" tickFormatter={(value) => `${value.toFixed(1)}%`} tickLine={false} axisLine={false} width={58} />
          <YAxis yAxisId="jobs" orientation="right" tickFormatter={(value) => `${value.toFixed(1)}%`} tickLine={false} axisLine={false} width={52} />
          <Tooltip formatter={(value) => `${Number(value).toFixed(2)}%`} labelFormatter={(label) => `Date ${label}`} />
          <Legend iconType="plainline" verticalAlign="bottom" height={24} />
          {linkedGuide(series, crosshairDate)}
          <Line yAxisId="gdp" dataKey="realGdp" dot={false} name="Real GDP growth" stroke="#22c55e" strokeWidth={2.2} type="monotone" />
          <Line yAxisId="jobs" dataKey="unemployment" dot={false} name="Unemployment" stroke="#60a5fa" strokeWidth={2.2} type="monotone" />
        </LineChartFrame>
      );
    }

    const series = filterSeries(data.labor.claims, timeframe);
    return (
      <LineChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
        <CartesianGrid stroke="#26323b" vertical={false} />
        <XAxis dataKey="date" minTickGap={28} tickLine={false} axisLine={false} />
        <YAxis tickFormatter={(value) => `${value.toFixed(0)}K`} tickLine={false} axisLine={false} width={58} />
        <Tooltip formatter={(value) => `${Number(value).toFixed(0)}K claims`} labelFormatter={(label) => `Date ${label}`} />
        <Legend iconType="plainline" verticalAlign="bottom" height={24} />
        {linkedGuide(series, crosshairDate)}
        <Line dataKey="initial" dot={false} name="Initial claims" stroke="#14b8a6" strokeWidth={2.3} type="monotone" />
        <Line dataKey="continuing" dot={false} name="Continuing claims" stroke="#a78bfa" strokeWidth={2.3} type="monotone" />
      </LineChartFrame>
    );
  }

  if (activeTab === "mvrv") {
    const series = filterSeries(data.valuation.mvrv, timeframe);
    const mvrvDomain = getPaddedNumericDomain(series, ["minus1Sigma", "minusHalfSigma", "mean", "plusHalfSigma", "plus1Sigma", "price"], {
      digits: 0,
      paddingRatio: 0.12,
      step: 1000
    });
    return (
      <LineChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
        <CartesianGrid stroke="#26323b" vertical={false} />
        <XAxis dataKey="date" minTickGap={28} tickLine={false} axisLine={false} />
        <YAxis domain={mvrvDomain} tickFormatter={formatCompactUsd} tickLine={false} axisLine={false} width={72} />
        <Tooltip formatter={(value) => formatUsd(value)} labelFormatter={(label) => `Date ${label}`} />
        <Legend iconType="plainline" verticalAlign="bottom" height={24} />
        {linkedGuide(series, crosshairDate)}
        <Line dataKey="minus1Sigma" dot={false} name="-1.0σ Band" stroke="#22c55e" strokeDasharray="4 4" strokeWidth={1.5} type="monotone" />
        <Line dataKey="minusHalfSigma" dot={false} name="-0.5σ Band" stroke="#14b8a6" strokeDasharray="4 4" strokeWidth={1.5} type="monotone" />
        <Line dataKey="mean" dot={false} name="Mean" stroke="#94a3b8" strokeWidth={1.8} type="monotone" />
        <Line dataKey="price" dot={false} name="BTC price" stroke="#f97316" strokeWidth={2.4} type="monotone" />
        <Line dataKey="plusHalfSigma" dot={false} name="+0.5σ Band" stroke="#f59e0b" strokeDasharray="4 4" strokeWidth={1.5} type="monotone" />
        <Line dataKey="plus1Sigma" dot={false} name="+1.0σ Band" stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1.5} type="monotone" />
      </LineChartFrame>
    );
  }

  if (activeTab === "dat") {
    const series = data.valuation.datInflows || [];
    const datBars = [
      { key: "btc", color: "#f97316", label: "BTC" },
      { key: "eth", color: "#60a5fa", label: "ETH" },
      { key: "sol", color: "#a78bfa", label: "SOL" },
      { key: "other", color: "#14b8a6", label: "Other" }
    ].filter((bar) => series.some((point) => Number(point[bar.key]) !== 0));
    const stackedDomain = getDatStackedDomain(series);
    return (
      <ComposedChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
        <CartesianGrid stroke="#26323b" vertical={false} />
        <XAxis dataKey="date" minTickGap={18} tickLine={false} axisLine={false} />
        <YAxis domain={stackedDomain} tickFormatter={formatDatAxisBillions} tickLine={false} axisLine={false} width={66} />
        <Tooltip formatter={(value) => formatBillions(value)} labelFormatter={(label) => `Period ${label}`} />
        <Legend iconType="circle" verticalAlign="bottom" height={24} />
        {linkedGuide(series, crosshairDate)}
        {datBars.map((bar) => (
          <Bar dataKey={bar.key} fill={bar.color} key={bar.key} maxBarSize={26} name={bar.label} radius={[3, 3, 0, 0]} stackId="flows" />
        ))}
      </ComposedChartFrame>
    );
  }

  if (activeTab === "relative") {
    const series = rebaseRelativePerformance(filterSeries(data.valuation.relativePerformance, timeframe, {
      maxLookbackDays: timeframe === "all" ? 365 * 5 : null
    }));
    const relativeDomain = getPaddedNumericDomain(series, ["btc", "software", "sp500"], {
      digits: 1,
      minSpan: 4,
      paddingRatio: 0.18,
      step: 1
    });
    return (
      <LineChartFrame data={series} crosshairDate={crosshairDate} onCrosshair={onCrosshair}>
        <CartesianGrid stroke="#26323b" vertical={false} />
        <XAxis dataKey="date" minTickGap={28} tickLine={false} axisLine={false} />
        <YAxis domain={relativeDomain} tickFormatter={(value) => `${value.toFixed(0)}%`} tickLine={false} axisLine={false} width={58} />
        <Tooltip formatter={(value) => `${Number(value).toFixed(2)}%`} labelFormatter={(label) => `Date ${label}`} />
        <Legend iconType="plainline" verticalAlign="bottom" height={24} />
        <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" />
        {linkedGuide(series, crosshairDate)}
        <Line dataKey="btc" dot={false} name="BTC" stroke="#f97316" strokeWidth={2.3} type="monotone" />
        <Line dataKey="software" dot={false} name="Tech/software" stroke="#60a5fa" strokeWidth={2.3} type="monotone" />
        <Line dataKey="sp500" dot={false} name="S&P 500" stroke="#14b8a6" strokeWidth={2.3} type="monotone" />
      </LineChartFrame>
    );
  }

  const series = filterSeries(data.valuation.bands[valuationAsset], timeframe);
  const bandLabels = series[0]?.bandLabels || (valuationAsset === "BTC" ? ["+25%", "+50%", "+75%", "+100%"] : ["+10%", "+20%", "+30%", "+40%"]);
  return (
    <div className="valuation-bands-panel">
      <div className="asset-selector-row">
        <div className="segmented asset-selector-tabs" aria-label="Valuation asset">
          {Object.keys(data.valuation.bands).map((asset) => (
            <button
              className={valuationAsset === asset ? "active" : ""}
              key={asset}
              onClick={() => onValuationAssetChange(asset)}
              type="button"
            >
              {asset}
            </button>
          ))}
        </div>
        <div className="risk-zone-legend">
          <span className="fire">{bandLabels[0]}</span>
          <span className="cheap">{bandLabels[1]}</span>
          <span className="fair">{bandLabels[2]}</span>
          <span className="hot">{bandLabels[3]}</span>
        </div>
      </div>
      <div className="valuation-chart-wrap">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={series} margin={{ top: 10, right: 18, left: 6, bottom: 0 }} onMouseLeave={() => onCrosshair("")} onMouseMove={(event) => handleChartMove(event, onCrosshair)}>
            <CartesianGrid stroke="#26323b" vertical={false} />
            <XAxis dataKey="date" minTickGap={28} tickLine={false} axisLine={false} />
            <YAxis tickFormatter={formatCompactUsd} tickLine={false} axisLine={false} width={72} />
            <Tooltip formatter={(value) => (Array.isArray(value) ? value.map(formatUsd).join(" to ") : formatUsd(value))} labelFormatter={(label) => `Date ${label}`} />
            <Legend iconType="plainline" verticalAlign="bottom" height={24} />
            {linkedGuide(series, crosshairDate)}
            <Bar dataKey="wickRange" fill="#64748b" name="High-low range" barSize={2} isAnimationActive={false} />
            <Bar dataKey="candleBody" name="Open-close candle" barSize={7} isAnimationActive={false}>
              {series.map((point) => <Cell fill={point.close >= point.open ? "#14b8a6" : "#ef4444"} key={point.date} />)}
            </Bar>
            <Line dataKey="ma200w" dot={false} name="200W MA" stroke="#94a3b8" strokeWidth={1.8} type="monotone" />
            <Line dataKey="band1" dot={false} name={bandLabels[0]} stroke="#22c55e" strokeDasharray="4 4" strokeWidth={1.4} type="monotone" />
            <Line dataKey="band2" dot={false} name={bandLabels[1]} stroke="#eab308" strokeDasharray="4 4" strokeWidth={1.4} type="monotone" />
            <Line dataKey="band3" dot={false} name={bandLabels[2]} stroke="#f97316" strokeDasharray="4 4" strokeWidth={1.4} type="monotone" />
            <Line dataKey="band4" dot={false} name={bandLabels[3]} stroke="#ef4444" strokeDasharray="4 4" strokeWidth={1.4} type="monotone" />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function LineChartFrame({ children, data, onCrosshair }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 12, right: 18, left: 4, bottom: 0 }} onMouseLeave={() => onCrosshair("")} onMouseMove={(event) => handleChartMove(event, onCrosshair)}>
        {children}
      </LineChart>
    </ResponsiveContainer>
  );
}

function AreaChartFrame({ children, data, onCrosshair }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 12, right: 18, left: 4, bottom: 0 }} onMouseLeave={() => onCrosshair("")} onMouseMove={(event) => handleChartMove(event, onCrosshair)}>
        {children}
      </AreaChart>
    </ResponsiveContainer>
  );
}

function ComposedChartFrame({ children, data, onCrosshair }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 12, right: 18, left: 4, bottom: 0 }} onMouseLeave={() => onCrosshair("")} onMouseMove={(event) => handleChartMove(event, onCrosshair)}>
        {children}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function handleChartMove(event, onCrosshair) {
  if (event?.activeLabel) onCrosshair(event.activeLabel);
}

function linkedGuide(series, date) {
  const nearestDate = getNearestDate(series, date);
  if (!nearestDate) return null;
  return <ReferenceLine x={nearestDate} stroke="#94a3b8" strokeDasharray="3 4" strokeWidth={1.2} />;
}

function getNearestDate(series, targetDate) {
  if (!targetDate || !Array.isArray(series) || !series.length) return "";
  if (series.some((point) => point.date === targetDate)) return targetDate;
  const targetTime = new Date(`${targetDate}T00:00:00.000Z`).getTime();
  let nearest = "";
  let nearestDistance = Infinity;
  for (const point of series) {
    const time = new Date(`${point.date}T00:00:00.000Z`).getTime();
    const distance = Math.abs(time - targetTime);
    if (distance < nearestDistance) {
      nearest = point.date;
      nearestDistance = distance;
    }
  }
  return nearestDistance <= 1000 * 60 * 60 * 24 * 20 ? nearest : "";
}

function filterSeries(series, timeframe, options = {}) {
  if (!Array.isArray(series)) return [];
  if (timeframe === "all") {
    if (Number.isFinite(options.maxLookbackDays) && options.maxLookbackDays > 0 && series.length) {
      return filterByLookback(series, options.maxLookbackDays);
    }
    return series;
  }
  const option = TIMEFRAME_OPTIONS.find((item) => item.value === timeframe);
  if (!option?.days || !series.length) return series;
  return filterByLookback(series, option.days);
}

function filterByLookback(series, days) {
  const latest = new Date(`${series.at(-1).date}T00:00:00.000Z`);
  const cutoff = new Date(latest);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const filtered = series.filter((point) => new Date(`${point.date}T00:00:00.000Z`) >= cutoff);
  return filtered.length ? filtered : series.slice(-Math.min(series.length, 6));
}

function getPaddedNumericDomain(series, keys, options = {}) {
  const values = (Array.isArray(series) ? series : [])
    .flatMap((point) => keys.map((key) => Number(point[key])))
    .filter(Number.isFinite);

  if (!values.length) return ["auto", "auto"];

  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const minSpan = Number(options.minSpan) || 0;
  const rawSpan = maximum - minimum;
  const span = Math.max(rawSpan, minSpan);
  const center = (minimum + maximum) / 2;
  const baseMin = rawSpan < minSpan ? center - span / 2 : minimum;
  const baseMax = rawSpan < minSpan ? center + span / 2 : maximum;
  const padding = span * (Number(options.paddingRatio) || 0.12);
  const step = Number(options.step) || 0;
  const digits = Number.isInteger(options.digits) ? options.digits : 2;
  let lower = baseMin - padding;
  let upper = baseMax + padding;

  if (Number.isFinite(options.clampMin)) {
    lower = Math.max(Number(options.clampMin), lower);
  }

  if (step > 0) {
    lower = Math.floor(lower / step) * step;
    upper = Math.ceil(upper / step) * step;
  }

  return [round(lower, digits), round(upper, digits)];
}

function getDatStackedDomain(series) {
  const totals = (Array.isArray(series) ? series : []).map((point) => {
    const values = ["btc", "eth", "sol", "other"].map((key) => Number(point[key]) || 0);
    return {
      positive: values.filter((value) => value > 0).reduce((sum, value) => sum + value, 0),
      negative: values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0)
    };
  });

  return getPaddedNumericDomain([{ positive: 0, negative: 0 }, ...totals], ["positive", "negative"], {
    digits: 1,
    minSpan: 2,
    paddingRatio: 0.08,
    step: 1
  });
}

function rebaseRelativePerformance(series) {
  if (!Array.isArray(series) || !series.length) return [];
  const keys = ["btc", "software", "sp500"];
  const baseline = Object.fromEntries(keys.map((key) => [key, 1 + (Number(series[0][key]) || 0) / 100]));

  return series.map((point, pointIndex) => {
    const rebased = { date: point.date };
    for (const key of keys) {
      const base = baseline[key];
      const current = 1 + (Number(point[key]) || 0) / 100;
      rebased[key] = pointIndex === 0 || !Number.isFinite(base) || base === 0
        ? 0
        : round(((current / base) - 1) * 100, 2);
    }
    return rebased;
  });
}

function buildMarketPulseData() {
  const daily = buildDailyBaseSeries();
  const monthly = buildMonthlyDates();
  const latestDxy = daily.at(-1).dxy;
  const previousDxy = daily.at(-2).dxy;

  return {
    kpis: {
      dxy: {
        value: latestDxy,
        changePct: ((latestDxy - previousDxy) / previousDxy) * 100,
        sparkline: daily.slice(-30).map((point) => ({ date: point.date, value: point.dxy }))
      },
      cryptoFearGreed: sentimentFromScore(15),
      equityFearGreed: sentimentFromScore(39)
    },
    liquidity: {
      gliLeadLag: daily.slice(75).map((point, index) => ({
        date: point.date,
        btc: point.btc,
        gliShifted: daily[index].gli
      })),
      walcl: daily.map((point, index) => ({
        date: point.date,
        value: round(7.15 + Math.sin(index / 42) * 0.12 - index * 0.00055, 3)
      })),
      goldDollar: daily.map((point, index) => ({
        date: point.date,
        goldReserves: round(2.55 + index * 0.0044 + Math.sin(index / 36) * 0.06, 3),
        usdReserves: round(3.9 - index * 0.0025 + Math.cos(index / 48) * 0.05, 3)
      }))
    },
    inflation: {
      pipeline: daily.map((point, index) => ({
        date: point.date,
        coreCpi: round(3.6 - index * 0.002 + Math.sin(index / 37) * 0.22, 2),
        corePpi: round(2.9 - index * 0.001 + Math.cos(index / 29) * 0.28, 2)
      })),
      fedFundsRate: daily.map((point, index) => ({
        date: point.date,
        value: round(0.1 + Math.min(5.25, Math.max(0, index - 470) * 0.018), 3)
      }))
    },
    labor: {
      claims: daily.filter((_, index) => index % 5 === 0).map((point, index) => ({
        date: point.date,
        initial: round(215 + Math.sin(index / 5) * 18 + index * 0.12, 0),
        continuing: round(1760 + Math.cos(index / 7) * 72 + index * 1.4, 0)
      })),
      payrolls: monthly.map((date, index) => ({
        date,
        jobs: round(170 + Math.sin(index / 2.2) * 85 - (index > 13 ? 5 : 0), 0)
      })),
      growth: daily.filter((_, index) => index % 7 === 0).map((point, index) => ({
        date: point.date,
        realGdp: round(2.1 + Math.sin(index / 8) * 0.65, 2),
        unemployment: round(3.8 + Math.cos(index / 10) * 0.35 + index * 0.003, 2)
      }))
    },
    valuation: {
      bands: {
        BTC: buildBandSeries(daily, "BTC", 72000),
        Gold: buildBandSeries(daily, "Gold", 2350),
        "S&P 500": buildBandSeries(daily, "S&P 500", 5450)
      },
      mvrv: daily.map((point, index) => {
        const base = 42000 + index * 56 + Math.sin(index / 24) * 2200;
        return {
          date: point.date,
          price: round(point.btc, 2),
          minus1Sigma: round(base * 0.78, 2),
          minusHalfSigma: round(base * 0.89, 2),
          mean: round(base, 2),
          plusHalfSigma: round(base * 1.13, 2),
          plus1Sigma: round(base * 1.28, 2)
        };
      }),
      datInflows: monthly.map((date, index) => ({
        date,
        btc: round(0.42 + Math.max(0, Math.sin(index / 2)) * 0.66, 2),
        eth: round(0.18 + Math.max(0, Math.cos(index / 3)) * 0.32, 2),
        sol: round(0.08 + Math.max(0, Math.sin(index / 2.7)) * 0.15, 2),
        other: round(0.07 + Math.max(0, Math.cos(index / 2.4)) * 0.12, 2)
      })),
      relativePerformance: daily.map((point, index) => ({
        date: point.date,
        btc: round(((point.btc / daily[0].btc) - 1) * 100, 2),
        software: round(((point.software / daily[0].software) - 1) * 100, 2),
        sp500: round(((point.sp500 / daily[0].sp500) - 1) * 100, 2)
      }))
    }
  };
}

function buildDailyBaseSeries() {
  const count = 528;
  const start = new Date("2025-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_value, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index);
    const cycle = Math.sin(index / 36);
    const slowCycle = Math.cos(index / 83);
    const btc = 69000 + index * 42 + cycle * 7200 + slowCycle * 2800;
    return {
      date: date.toISOString().slice(0, 10),
      btc: round(btc, 2),
      gli: round(96 + index * 0.018 + Math.sin(index / 44) * 3.1, 2),
      dxy: round(103.4 - index * 0.003 + Math.cos(index / 28) * 0.7, 2),
      software: round(100 + index * 0.055 + Math.sin(index / 31) * 5.8, 2),
      sp500: round(100 + index * 0.042 + Math.cos(index / 47) * 3.9, 2)
    };
  });
}

function buildMonthlyDates() {
  const start = new Date("2025-01-01T00:00:00.000Z");
  return Array.from({ length: 18 }, (_value, index) => {
    const date = new Date(start);
    date.setUTCMonth(start.getUTCMonth() + index);
    return date.toISOString().slice(0, 10);
  });
}

function buildBandSeries(daily, asset, basePrice) {
  const slope = asset === "BTC" ? 38 : asset === "Gold" ? 1.7 : 3.2;
  const volatility = asset === "BTC" ? 0.11 : asset === "Gold" ? 0.025 : 0.04;
  return daily.map((point, index) => {
    const trend = basePrice + index * slope;
    const ma200w = trend * (0.78 + Math.sin(index / 120) * 0.015);
    const close = trend * (1 + Math.sin(index / 28) * volatility + Math.cos(index / 67) * volatility * 0.55);
    const open = close * (1 + Math.sin(index / 9) * volatility * 0.28);
    const high = Math.max(open, close) * (1 + volatility * 0.34);
    const low = Math.min(open, close) * (1 - volatility * 0.3);
    return {
      date: point.date,
      open: round(open, 2),
      high: round(high, 2),
      low: round(low, 2),
      close: round(close, 2),
      ma200w: round(ma200w, 2),
      band25: round(ma200w * 1.25, 2),
      band50: round(ma200w * 1.5, 2),
      band75: round(ma200w * 1.75, 2),
      band100: round(ma200w * 2, 2),
      candleBody: [round(Math.min(open, close), 2), round(Math.max(open, close), 2)],
      wickRange: [round(low, 2), round(high, 2)]
    };
  });
}

function sentimentFromScore(score) {
  if (score <= 24) return { score, label: "Extreme Fear", tone: "fear" };
  if (score <= 44) return { score, label: "Fear", tone: "caution" };
  if (score <= 55) return { score, label: "Neutral", tone: "neutral" };
  if (score <= 75) return { score, label: "Greed", tone: "greed" };
  return { score, label: "Extreme Greed", tone: "hot" };
}

function formatUsd(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number(value) >= 1000 ? 0 : 2
  }).format(Number(value) || 0);
}

function formatCompactUsd(value) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1
  }).format(Number(value) || 0);
}

function formatTrillions(value) {
  return `$${Number(value || 0).toFixed(2)}T`;
}

function formatBillions(value) {
  return `$${Number(value || 0).toFixed(2)}B`;
}

function formatDatAxisBillions(value) {
  const numeric = Number(value) || 0;
  if (numeric === 0) return "0B";
  if (Math.abs(numeric) >= 100) return `${Math.round(numeric)}B`;
  if (Math.abs(numeric) >= 10) return `${numeric.toFixed(0)}B`;
  return `${numeric.toFixed(1)}B`;
}

function formatSignedPercent(value) {
  const numeric = Number(value) || 0;
  return `${numeric >= 0 ? "+" : ""}${numeric.toFixed(2)}%`;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}
