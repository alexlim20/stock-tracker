import React, { useState, useEffect, useRef } from "react";
import {
  FolderOpen,
  Cpu,
  Sparkles,
  Terminal,
  Image as ImageIcon,
  FileText,
  AlertTriangle,
  Trash2,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  List,
  Info,
  Coins,
  Eye,
  ShieldCheck,
  RefreshCw
} from "lucide-react";
import { portfolioApi } from "./api.js";

const MEDIA_PIPELINE_PATHS_STORAGE_KEY = "mediaPipelinePaths";
const DEFAULT_MEDIA_PIPELINE_PATHS = {
  sourcePath: "C:\\Users\\Alex2\\Downloads\\Pixel_Dump",
  targetPath: "C:\\Users\\Alex2\\Downloads\\Organized_Media"
};

function readStoredMediaPipelinePaths() {
  try {
    const paths = JSON.parse(localStorage.getItem(MEDIA_PIPELINE_PATHS_STORAGE_KEY) || "{}");
    return paths && typeof paths === "object" ? paths : {};
  } catch {
    return {};
  }
}

function writeStoredMediaPipelinePaths(paths) {
  const nextPaths = {
    ...DEFAULT_MEDIA_PIPELINE_PATHS,
    ...readStoredMediaPipelinePaths(),
    ...paths
  };
  localStorage.setItem(MEDIA_PIPELINE_PATHS_STORAGE_KEY, JSON.stringify(nextPaths));
  return nextPaths;
}

function getInitialMediaPipelinePath(key) {
  const storedPaths = readStoredMediaPipelinePaths();
  return storedPaths[key] || DEFAULT_MEDIA_PIPELINE_PATHS[key];
}

export default function MediaPipelineDashboard({ isDarkMode, onToggleTheme }) {
  const [sourcePath, setSourcePath] = useState(() => getInitialMediaPipelinePath("sourcePath"));
  const [targetPath, setTargetPath] = useState(() => getInitialMediaPipelinePath("targetPath"));
  const [apiKey, setApiKey] = useState(() => localStorage.getItem("mediaPipelineApiKey") || "");
  const [isPipelineRunning, setIsPipelineRunning] = useState(false);
  const [mediaPathsHydrated, setMediaPathsHydrated] = useState(false);
  
  // Counters for the Metric cards
  const [scannedCount, setScannedCount] = useState(0);
  const [lifeCount, setLifeCount] = useState(0);
  const [clutterCount, setClutterCount] = useState(0);
  const [unknownCount, setUnknownCount] = useState(0);

  // Lists for Split Viewer
  const [lifeMemories, setLifeMemories] = useState([]);
  const [digitalExhaust, setDigitalExhaust] = useState([]);

  // Terminal log activity
  const [logs, setLogs] = useState([
    { type: "system", message: "Media Ingestion Engine Ready.", timestamp: "10:50:00" },
    { type: "system", message: "Waiting for source/target directories and Run action...", timestamp: "10:50:01" }
  ]);

  // UI Interactive States
  const [selectedTab, setSelectedTab] = useState("memories"); // "memories" | "clutter"
  const [viewMode, setViewMode] = useState("grid"); // "grid" | "list"
  const [logFilter, setLogFilter] = useState("all"); // "all" | "system" | "metadata" | "heuristics" | "ai"
  const [blueprintCollapsed, setBlueprintCollapsed] = useState(true);

  const terminalEndRef = useRef(null);

  // Restore saved media paths from the Electron settings store when available.
  useEffect(() => {
    let isActive = true;

    portfolioApi.getSettings?.()
      .then((settings) => {
        if (!isActive) return;
        const savedPaths = settings?.mediaPipelinePaths;
        if (!savedPaths || typeof savedPaths !== "object") return;

        if (typeof savedPaths.sourcePath === "string" && savedPaths.sourcePath.trim()) {
          setSourcePath(savedPaths.sourcePath);
        }
        if (typeof savedPaths.targetPath === "string" && savedPaths.targetPath.trim()) {
          setTargetPath(savedPaths.targetPath);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (isActive) setMediaPathsHydrated(true);
      });

    return () => {
      isActive = false;
    };
  }, []);

  // Persist typed or selected media paths without requiring a pipeline run.
  useEffect(() => {
    if (!mediaPathsHydrated) return;

    const mediaPipelinePaths = writeStoredMediaPipelinePaths({ sourcePath, targetPath });
    const saveTimer = window.setTimeout(() => {
      portfolioApi.saveSettings?.({ mediaPipelinePaths }).catch((error) => {
        console.warn("Failed to save media pipeline paths", error);
      });
    }, 350);

    return () => window.clearTimeout(saveTimer);
  }, [mediaPathsHydrated, sourcePath, targetPath]);

  // Auto-scroll terminal logs
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Bind live main process pipeline events
  useEffect(() => {
    if (!isPipelineRunning) return;

    // Listen for real-time logs emitted by the main process
    const unsubscribeLog = portfolioApi.onPipelineLog?.((log) => {
      setLogs((prev) => [...prev, log]);
    });

    // Listen for progress updates
    const unsubscribeProgress = portfolioApi.onPipelineProgress?.((progress) => {
      setScannedCount(progress.scannedCount || 0);
      setLifeCount(progress.lifeCount || 0);
      setClutterCount(progress.clutterCount || 0);
      setUnknownCount(progress.unknownCount || 0);
    });

    // Listen for individual processed items
    const unsubscribeItem = portfolioApi.onPipelineItem?.((item) => {
      if (item.type === "life") {
        setLifeMemories((prev) => [...prev, item]);
      } else if (item.type === "clutter") {
        setDigitalExhaust((prev) => [...prev, item]);
      } else if (item.type === "unknown") {
        setDigitalExhaust((prev) => [...prev, { ...item, isUnknown: true }]);
      }
    });

    // Cleanup listeners when component unmounts or running state changes
    return () => {
      if (unsubscribeLog) unsubscribeLog();
      if (unsubscribeProgress) unsubscribeProgress();
      if (unsubscribeItem) unsubscribeItem();
    };
  }, [isPipelineRunning]);

  // Handle Directory Import Selection Dialog
  async function handleSelectFolder() {
    try {
      const result = await portfolioApi.selectMediaFolder?.(sourcePath);
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        const nextPath = result.filePaths[0];
        setSourcePath(nextPath);
        writeStoredMediaPipelinePaths({ sourcePath: nextPath, targetPath });
        addLog("system", `Source directory updated to: ${nextPath}`);
      }
    } catch (error) {
      addLog("system", `Error selecting folder: ${error.message}`);
    }
  }

  // Handle Target Directory Selection Dialog
  async function handleSelectTargetFolder() {
    try {
      const result = await portfolioApi.selectTargetFolder?.(targetPath);
      if (result && !result.canceled && result.filePaths && result.filePaths.length > 0) {
        const nextPath = result.filePaths[0];
        setTargetPath(nextPath);
        writeStoredMediaPipelinePaths({ sourcePath, targetPath: nextPath });
        addLog("system", `Target directory updated to: ${nextPath}`);
      }
    } catch (error) {
      addLog("system", `Error selecting target folder: ${error.message}`);
    }
  }

  function handleSourcePathChange(nextPath) {
    setSourcePath(nextPath);
    writeStoredMediaPipelinePaths({ sourcePath: nextPath, targetPath });
  }

  function handleTargetPathChange(nextPath) {
    setTargetPath(nextPath);
    writeStoredMediaPipelinePaths({ sourcePath, targetPath: nextPath });
  }

  // Append a single log entry
  function addLog(type, message) {
    const now = new Date();
    const timeStr = now.toTimeString().split(" ")[0];
    setLogs((prev) => [...prev, { type, message, timestamp: timeStr }]);
  }

  // Trigger Backend Ingestion Process
  function handleRunPipeline() {
    if (isPipelineRunning) return;

    setIsPipelineRunning(true);
    setScannedCount(0);
    setLifeCount(0);
    setClutterCount(0);
    setUnknownCount(0);
    setLifeMemories([]);
    setDigitalExhaust([]);
    
    // Clear logs and print startup info
    setLogs([
      { type: "system", message: `[System] Registering IPC listeners and launching main process Media Pipeline...`, timestamp: new Date().toTimeString().split(" ")[0] }
    ]);

    portfolioApi.runMediaPipeline(sourcePath, targetPath, apiKey)
      .then((result) => {
        setIsPipelineRunning(false);
      })
      .catch((error) => {
        setIsPipelineRunning(false);
        addLog("system", `Pipeline execution failed: ${error.message}`);
      });
  }

  // Trigger Backend Library Refresh (Deep Clean) Process
  function handleRunCleanup() {
    if (isPipelineRunning) return;

    setIsPipelineRunning(true);
    setScannedCount(0);
    setLifeCount(0);
    setClutterCount(0);
    setUnknownCount(0);
    setLifeMemories([]);
    setDigitalExhaust([]);
    
    setLogs([
      { type: "system", message: `[System] Launching visual library refresh (Deep Clean) on Target Destination...`, timestamp: new Date().toTimeString().split(" ")[0] }
    ]);

    portfolioApi.runMediaCleanup(targetPath, apiKey)
      .then((result) => {
        setIsPipelineRunning(false);
      })
      .catch((error) => {
        setIsPipelineRunning(false);
        addLog("system", `Library refresh failed: ${error.message}`);
      });
  }

  // Clears the logs
  function handleClearLogs() {
    setLogs([
      { type: "system", message: "Logs cleared.", timestamp: new Date().toTimeString().split(" ")[0] }
    ]);
  }

  // Option B Credit-Saving Metrics calculations
  const processedList = [...lifeMemories, ...digitalExhaust];
  const savedCallsCount = processedList.filter(
    (item) => item.tier === 1 || item.tier === 2 || item.tier === 3
  ).length;
  const aiCallsCount = processedList.filter((item) => item.tier === 4).length;
  
  // Estimate values
  const gpuTimeSavedSec = (savedCallsCount * 8.5).toFixed(1);
  const creditsSavedUSD = (savedCallsCount * 0.15).toFixed(2);

  // Calculate percentage ratios
  const lifePercent = scannedCount > 0 ? Math.round((lifeCount / scannedCount) * 100) : 0;
  const clutterPercent = scannedCount > 0 ? Math.round((clutterCount / scannedCount) * 100) : 0;
  const unknownPercent = scannedCount > 0 ? Math.round((unknownCount / scannedCount) * 100) : 0;

  // Filter logs for waterfall terminal display
  const filteredLogs = logs.filter((log) => {
    if (logFilter === "all") return true;
    if (logFilter === "system") return log.type === "system" || log.type === "success";
    if (logFilter === "metadata") return log.type === "tier1" || log.type === "tier2";
    if (logFilter === "heuristics") return log.type === "tier3";
    if (logFilter === "ai") return log.type === "tier4";
    return true;
  });

  return (
    <div className="media-dashboard-container">
      
      {/* 1. Hero Header Banner */}
      <header className="media-hero-banner">
        <div className="media-hero-title-group">
          <h1>Ingestion & In-Memory Filtering</h1>
          <p>
            Redundant asset pairing and content verification engine powered by EXIF headers, filename rules, and cloud serverless Gemma 4 models.
          </p>
        </div>
        <div className="top-actions" style={{ margin: 0 }}>
          <div className="api-status-tag">
            <span className="api-status-dot"></span>
            <span>API Serverless: Live</span>
          </div>
          <button
            className="icon-button"
            onClick={onToggleTheme}
            type="button"
            title={isDarkMode ? "Light Theme" : "Dark Theme"}
            style={{ minHeight: "36px", padding: "0 12px", fontSize: "12px" }}
          >
            {isDarkMode ? "Light Mode" : "Dark Mode"}
          </button>
        </div>
      </header>

      {/* 2. Option B - AI Credits Engine Dashboard Panel */}
      <section className="credits-engine-card" aria-label="AI Credit Control Panel">
        <div className="credits-info-section">
          <h3>
            <Coins size={18} style={{ color: "#0d9488" }} />
            AI Credits Optimization Engine
            <span className="credits-toggle-badge">Option B Active</span>
          </h3>
          <p>
            Bypasses serverless Gemma 4 L4 GPU inferences when valid EXIF camera make/model headers or standardized filename date patterns exist, conserving billing quotas.
          </p>
        </div>
        <div className="credit-stat-item">
          <span>Inferences Bypassed</span>
          <strong>{savedCallsCount} files</strong>
          <small>⚡ Heuristic Fast-Pass</small>
        </div>
        <div className="credit-stat-item">
          <span>Est. Savings Conserved</span>
          <strong>${creditsSavedUSD}</strong>
          <small>≈ {gpuTimeSavedSec}s GPU-sec saved</small>
        </div>
      </section>

      {/* 3. Ingestion Path & Action Controls Card */}
      <section className="media-controls-card" aria-label="Ingestion Paths and Controls">
        <div className="media-paths-grid">
          
          <div className="media-input-wrapper">
            <label htmlFor="source-dir-input">Source Directory</label>
            <div className="media-input-field">
              <input
                id="source-dir-input"
                type="text"
                value={sourcePath}
                onChange={(e) => handleSourcePathChange(e.target.value)}
                placeholder="Provide folder containing pixel dump photos..."
                disabled={isPipelineRunning}
              />
              <button
                className="picker-btn"
                onClick={handleSelectFolder}
                disabled={isPipelineRunning}
                title="Select Source Directory"
                type="button"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

          <div className="media-input-wrapper">
            <label htmlFor="target-dir-input">Target Destination</label>
            <div className="media-input-field">
              <input
                id="target-dir-input"
                type="text"
                value={targetPath}
                onChange={(e) => handleTargetPathChange(e.target.value)}
                placeholder="Provide folder to sort structured memories..."
                disabled={isPipelineRunning}
              />
              <button
                className="picker-btn"
                onClick={handleSelectTargetFolder}
                disabled={isPipelineRunning}
                title="Select Target Directory"
                type="button"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

        </div>

        <div className="media-actions-strip">
          <div className="credit-saving-info-tag">
            <ShieldCheck size={14} />
            <span>EXIF camera metadata check and WhatsApp overrides verified automatically.</span>
          </div>
          
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              className="icon-button"
              onClick={handleRunCleanup}
              disabled={isPipelineRunning}
              style={{
                minHeight: "40px",
                padding: "0 18px",
                borderColor: isDarkMode ? "#f59e0b" : "#d97706",
                background: "transparent",
                color: isDarkMode ? "#f59e0b" : "#d97706",
                fontWeight: "750",
                display: "inline-flex",
                gap: "8px",
                alignItems: "center"
              }}
              type="button"
            >
              <RefreshCw size={14} className={isPipelineRunning ? "animate-spin" : ""} />
              <span>Library Refresh (Deep Clean)</span>
            </button>

            <button
              className="primary-action"
              onClick={handleRunPipeline}
              disabled={isPipelineRunning}
              style={{
                width: "auto",
                minHeight: "40px",
                margin: 0,
                padding: "0 22px",
                background: "#0d9488",
                borderColor: "#0d9488",
                display: "inline-flex",
                gap: "8px",
                alignItems: "center",
                boxShadow: "0 4px 12px rgba(13, 148, 136, 0.15)"
              }}
              type="button"
            >
              <Cpu size={16} className={isPipelineRunning ? "animate-spin" : ""} />
              <span>{isPipelineRunning ? "Running Pipeline..." : "Run Ingestion Pipeline"}</span>
            </button>
          </div>
        </div>

        {/* Dynamic Sweeping Scanner Bar when Running */}
        {isPipelineRunning && (
          <div className="scanner-progress-wrapper">
            <div className="scanner-bar"></div>
          </div>
        )}
      </section>

      {/* 4. Ingestion Metrics Grid */}
      <section className="media-stats-grid" aria-label="Ingestion Statistics Summary">
        
        <article className="media-stat-card">
          <div className="media-stat-icon-wrapper scanned">
            <Eye size={22} />
          </div>
          <div className="media-stat-content" style={{ width: "100%" }}>
            <span>Total Scanned</span>
            <strong>{scannedCount}</strong>
            <div className="media-stat-percent-bar">
              <div className="media-stat-percent-fill scanned" style={{ width: scannedCount > 0 ? "100%" : "0%" }}></div>
            </div>
          </div>
        </article>

        <article className="media-stat-card">
          <div className="media-stat-icon-wrapper life">
            <ImageIcon size={22} />
          </div>
          <div className="media-stat-content" style={{ width: "100%" }}>
            <span>Verified Memories</span>
            <strong>{lifeCount}</strong>
            <div className="media-stat-percent-bar">
              <div className="media-stat-percent-fill life" style={{ width: `${lifePercent}%` }}></div>
            </div>
          </div>
        </article>

        <article className="media-stat-card">
          <div className="media-stat-icon-wrapper clutter">
            <FileText size={22} />
          </div>
          <div className="media-stat-content" style={{ width: "100%" }}>
            <span>Filtered Clutter</span>
            <strong>{clutterCount}</strong>
            <div className="media-stat-percent-bar">
              <div className="media-stat-percent-fill clutter" style={{ width: `${clutterPercent}%` }}></div>
            </div>
          </div>
        </article>

        <article className="media-stat-card">
          <div className="media-stat-icon-wrapper unknown">
            <AlertTriangle size={22} />
          </div>
          <div className="media-stat-content" style={{ width: "100%" }}>
            <span>Unclassified / Unknown</span>
            <strong>{unknownCount}</strong>
            <div className="media-stat-percent-bar">
              <div className="media-stat-percent-fill unknown" style={{ width: `${unknownPercent}%` }}></div>
            </div>
          </div>
        </article>

      </section>

      {/* 5. Ingestion Split Workspace */}
      <section className="media-workspace-grid">
        
        {/* Left Column: Waterfall Logger Terminal */}
        <article className="media-terminal-card" aria-label="Ingestion Intelligence Logs">
          <header className="media-terminal-header-strip">
            <span className="media-terminal-title">
              <Terminal size={15} />
              Ingestion Intelligence Stream
            </span>
            <div className="media-terminal-filter-tabs">
              <button
                className={`media-filter-btn ${logFilter === "all" ? "active" : ""}`}
                onClick={() => setLogFilter("all")}
                type="button"
              >
                All
              </button>
              <button
                className={`media-filter-btn ${logFilter === "system" ? "active" : ""}`}
                onClick={() => setLogFilter("system")}
                type="button"
              >
                System
              </button>
              <button
                className={`media-filter-btn ${logFilter === "metadata" ? "active" : ""}`}
                onClick={() => setLogFilter("metadata")}
                type="button"
              >
                Metadata
              </button>
              <button
                className={`media-filter-btn ${logFilter === "heuristics" ? "active" : ""}`}
                onClick={() => setLogFilter("heuristics")}
                type="button"
              >
                Heuristics
              </button>
              <button
                className={`media-filter-btn ${logFilter === "ai" ? "active" : ""}`}
                onClick={() => setLogFilter("ai")}
                type="button"
              >
                AI CV
              </button>
            </div>
          </header>

          <div className="media-terminal-body-scroll">
            {filteredLogs.length > 0 ? (
              filteredLogs.map((log, index) => {
                let badgeText = log.type;
                if (log.type === "tier1") badgeText = "EXIF Header";
                if (log.type === "tier2") badgeText = "PXL Regex";
                if (log.type === "tier3") badgeText = "Heuristic";
                if (log.type === "tier4") badgeText = "Gemma 4 AI";
                
                return (
                  <div key={index} className="log-entry-row">
                    <span className="log-entry-time">[{log.timestamp}]</span>
                    <span className={`log-entry-badge ${log.type}`}>{badgeText}</span>
                    <span className={`log-entry-msg ${log.type}`}>{log.message}</span>
                  </div>
                );
              })
            ) : (
              <div style={{ color: "#475569", fontStyle: "italic", padding: "12px 0" }}>
                No matching log stream rows found for filter: {logFilter}.
              </div>
            )}
            <div ref={terminalEndRef} />
          </div>

          <footer className="media-terminal-footer">
            <span>
              <RefreshCw size={11} className={isPipelineRunning ? "animate-spin" : ""} />
              {isPipelineRunning ? "Processing pipeline queue..." : "Pipeline Idle"}
            </span>
            <button
              className="icon-button"
              onClick={handleClearLogs}
              disabled={isPipelineRunning}
              style={{
                minHeight: "24px",
                padding: "0 8px",
                fontSize: "11px",
                borderColor: "rgba(255,255,255,0.15)",
                background: "transparent"
              }}
              type="button"
            >
              <Trash2 size={11} />
              Clear Terminal
            </button>
          </footer>
        </article>

        {/* Right Column: Live Ingestion Stream Viewer */}
        <article className="media-viewer-card" aria-label="Ingested Files Stream Preview">
          <header className="media-viewer-header-strip">
            <div className="media-viewer-tabs">
              <button
                className={`media-tab-btn ${selectedTab === "memories" ? "active" : ""}`}
                onClick={() => setSelectedTab("memories")}
                type="button"
              >
                <ImageIcon size={14} />
                Memories Stream ({lifeMemories.length})
              </button>
              <button
                className={`media-tab-btn ${selectedTab === "clutter" ? "active" : ""}`}
                onClick={() => setSelectedTab("clutter")}
                type="button"
              >
                <FileText size={14} />
                Exhaust / Clutter ({digitalExhaust.length})
              </button>
            </div>
            
            <div className="media-viewer-actions">
              <div className="view-mode-toggle">
                <button
                  className={`view-mode-btn ${viewMode === "grid" ? "active" : ""}`}
                  onClick={() => setViewMode("grid")}
                  title="Grid View"
                  type="button"
                >
                  <LayoutGrid size={13} />
                </button>
                <button
                  className={`view-mode-btn ${viewMode === "list" ? "active" : ""}`}
                  onClick={() => setViewMode("list")}
                  title="List View"
                  type="button"
                >
                  <List size={13} />
                </button>
              </div>
            </div>
          </header>

          <div className="media-viewer-body-scroll">
            
            {/* memories stream tab */}
            {selectedTab === "memories" && (
              lifeMemories.length > 0 ? (
                viewMode === "grid" ? (
                  <div className="media-assets-grid">
                    {lifeMemories.map((file, idx) => (
                      <div key={idx} className="asset-card-item">
                        <div className="asset-card-thumb">
                          <ImageIcon size={26} />
                          <div className="asset-card-badge-container">
                            {file.isRawJpegPair && (
                              <span className="asset-badge raw">RAW+JPEG</span>
                            )}
                            {file.isAiMatch && (
                              <span className="asset-badge ai" style={{ background: file.detail?.includes("Gemma 4") ? "#a855f7" : undefined }}>
                                {file.detail?.includes("Gemma 4") ? "Gemma 4" : "AI Twin"}
                              </span>
                            )}
                            {file.suggestedSubFolder === "Screenshots" && (
                              <span className="asset-badge screenshot">Screenshot</span>
                            )}
                          </div>
                        </div>
                        <div className="asset-card-info">
                          <span className="asset-card-name" title={file.filename}>
                            {file.filename}
                          </span>
                          <span className="asset-card-meta">{file.size}</span>
                          <span className="asset-card-date" title={file.date}>
                            {file.date}
                          </span>
                          {file.gps && (
                            <span className="asset-card-location" style={{ fontSize: "10.5px", color: "#0284c7", fontWeight: "600", marginTop: "2px", display: "inline-flex", alignItems: "center", gap: "2px" }}>
                              📍 {file.gps.city}, {file.gps.country}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="media-assets-list">
                    {lifeMemories.map((file, idx) => (
                      <div key={idx} className="asset-list-row">
                        <div className="asset-list-row-left">
                          <div className="asset-list-icon" style={{ background: "rgba(13, 148, 136, 0.06)", color: "#0d9488" }}>
                            <ImageIcon size={15} />
                          </div>
                          <div className="asset-list-row-info">
                            <span className="asset-list-row-name" title={file.filename}>{file.filename}</span>
                            <span className="asset-list-row-detail" title={file.detail}>{file.detail || "Verified life media relocated."}</span>
                          </div>
                        </div>
                        <div className="asset-list-row-meta">
                          {file.gps && (
                            <span className="asset-list-row-badge gps" style={{ color: "#0284c7", background: "rgba(2, 132, 199, 0.1)", marginRight: "6px" }}>
                              📍 {file.gps.city}, {file.gps.country}
                            </span>
                          )}
                          <span className="asset-list-row-size">{file.size}</span>
                          <span className="asset-list-row-badge" style={{ color: "#0d9488", background: "rgba(13, 148, 136, 0.1)" }}>
                            {file.suggestedSubFolder || "Media"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className="media-empty-view">
                  <ImageIcon size={38} strokeWidth={1.2} />
                  <span>No life memories ingested yet. Run the pipeline to relocate files.</span>
                </div>
              )
            )}

            {/* clutter stream tab */}
            {selectedTab === "clutter" && (
              digitalExhaust.length > 0 ? (
                viewMode === "grid" ? (
                  <div className="media-assets-grid">
                    {digitalExhaust.map((file, idx) => (
                      <div key={idx} className="asset-card-item" style={file.isUnknown ? { borderColor: "rgba(245, 158, 11, 0.3)" } : undefined}>
                        <div className="asset-card-thumb" style={{ background: file.isUnknown ? "rgba(245, 158, 11, 0.03)" : undefined }}>
                          {file.isUnknown ? <AlertTriangle size={26} style={{ color: "#fbbf24" }} /> : <FileText size={26} />}
                          <div className="asset-card-badge-container">
                            {file.isUnknown ? (
                              <span className="asset-badge unknown">Unknown</span>
                            ) : (
                              <span className="asset-badge clutter">Clutter</span>
                            )}
                          </div>
                        </div>
                        <div className="asset-card-info">
                          <span className="asset-card-name" title={file.filename} style={file.isUnknown ? { color: "#d97706" } : undefined}>
                            {file.filename}
                          </span>
                          <span className="asset-card-meta">{file.size}</span>
                          <span className="asset-card-date" title={file.detail}>
                            {file.detail || "Identified junk format."}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="media-assets-list">
                    {digitalExhaust.map((file, idx) => (
                      <div key={idx} className="asset-list-row" style={file.isUnknown ? { borderColor: "rgba(245, 158, 11, 0.25)" } : undefined}>
                        <div className="asset-list-row-left">
                          <div className={`asset-list-icon ${file.isUnknown ? "unknown" : "clutter"}`}>
                            {file.isUnknown ? <AlertTriangle size={15} /> : <FileText size={15} />}
                          </div>
                          <div className="asset-list-row-info">
                            <span className="asset-list-row-name" title={file.filename} style={file.isUnknown ? { color: "#b45309" } : undefined}>
                              {file.filename} {file.isUnknown && "(Pending L3 AI)"}
                            </span>
                            <span className="asset-list-row-detail" title={file.detail}>{file.detail || "Non-life file detected."}</span>
                          </div>
                        </div>
                        <div className="asset-list-row-meta">
                          <span className="asset-list-row-size">{file.size}</span>
                          <span className={`asset-list-row-badge ${file.isUnknown ? "unknown" : "clutter"}`}>
                            {file.isUnknown ? "Anomalies" : "Clutter"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                <div className="media-empty-view">
                  <FileText size={38} strokeWidth={1.2} />
                  <span>No digital exhaust detected yet. Screenshots and junk will appear here.</span>
                </div>
              )
            )}

          </div>
        </article>

      </section>

      {/* 6. Architectural Code Blueprint Collapsible Section */}
      <section className="blueprint-accordion-card">
        <header
          className="blueprint-accordion-header"
          onClick={() => setBlueprintCollapsed(!blueprintCollapsed)}
          aria-expanded={!blueprintCollapsed}
        >
          <span className="blueprint-accordion-title">
            <Sparkles size={16} />
            Level 3/4 Vector Classification Pipeline Blueprint
          </span>
          <button
            type="button"
            className="icon-button"
            style={{
              width: "28px",
              height: "28px",
              padding: 0,
              borderRadius: "50%",
              borderColor: "transparent",
              background: "transparent"
            }}
            title={blueprintCollapsed ? "Expand Blueprint Code" : "Collapse Blueprint Code"}
          >
            {blueprintCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
        </header>
        
        {!blueprintCollapsed && (
          <div className="blueprint-accordion-content">
            <p style={{ margin: "0 0 14px", fontSize: "13px", lineHeight: "1.6", color: isDarkMode ? "#94a3b8" : "#475569" }}>
              To connect the simulator up to high-performance real operations, implement this Python/JavaScript IPC bridge handler. It extracts visual embeddings using ONNX and checks for visual similarity in a local vector database.
            </p>
            <pre style={{
              background: isDarkMode ? "#090d10" : "#f1f5f9",
              color: isDarkMode ? "#34d399" : "#0d9488",
              padding: "16px",
              borderRadius: "8px",
              overflowX: "auto",
              fontSize: "11.5px",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              border: isDarkMode ? "1px solid #1e293b" : "1px solid #e2e8f0",
              margin: 0
            }}>
{`# ==============================================================================
# PYTHON BACKEND: TIER 4 AI-CV COSINE SIMILARITY ENGINE (ONNX RUNTIME OVERVIEW)
# ==============================================================================
# Dependency Requirements: pip install onnxruntime numpy Pillow sentence-transformers sqlite3

import numpy as np
import sqlite3
from PIL import Image
import onnxruntime as ort

class VectorEmbeddingPipeline:
    def __init__(self, model_onnx_path="models/clip_vit_b32_vision.onnx"):
        # 1. Load the lightweight ONNX runtime session for CLIP / MobileNet
        self.session = ort.InferenceSession(model_onnx_path, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name
        
    def preprocess_image(self, image_path):
        # Resize image to model expectation (e.g. 224x224), normalize channels
        img = Image.open(image_path).convert('RGB').resize((224, 224))
        img_arr = np.array(img).astype(np.float32) / 255.0
        # Normalize with ImageNet mean & std dev
        mean = np.array([0.485, 0.456, 0.406])
        std = np.array([0.229, 0.224, 0.225])
        img_arr = (img_arr - mean) / std
        img_arr = np.transpose(img_arr, (2, 0, 1)) # C, H, W
        return np.expand_dims(img_arr, axis=0) # Batch size 1

    def extract_feature_vector(self, image_path):
        # 2. Run forward pass through the ONNX model to get 512-d or 128-d float embeddings
        preprocessed = self.preprocess_image(image_path)
        raw_embeddings = self.session.run(None, {self.input_name: preprocessed})[0]
        # Flatten and L2-normalize vector to prepare for cosine similarity check
        embedding = raw_embeddings.flatten()
        norm = np.linalg.norm(embedding)
        return (embedding / norm).tolist() if norm > 0 else embedding.tolist()

    @staticmethod
    def calculate_cosine_similarity(vec_a, vec_b):
        # Cosine similarity is the dot product of pre-normalized L2 vectors
        return np.dot(vec_a, vec_b)

    def check_visual_similarity_twins(self, target_embedding, db_path="media_vectors.db", threshold=0.85):
        # 3. Query local SQLite vector database to compare vector distance against already-sorted items
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        cursor.execute("SELECT file_path, embedding_blob, date_taken FROM sorted_media")
        
        matches = []
        for file_path, emb_blob, date_taken in cursor.fetchall():
            db_vector = np.frombuffer(emb_blob, dtype=np.float32)
            similarity = self.calculate_cosine_similarity(target_embedding, db_vector)
            if similarity >= threshold:
                matches.append((file_path, similarity, date_taken))
                
        # Sort by highest similarity
        matches.sort(key=lambda x: x[1], reverse=True)
        conn.close()
        return matches # Returns matching twins and their metadata for timestamp interpolation`}
            </pre>
          </div>
        )}
      </section>

    </div>
  );
}
