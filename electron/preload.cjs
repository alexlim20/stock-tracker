const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("portfolioApi", {
  addTrade: (trade) => ipcRenderer.invoke("portfolio:add-trade", trade),
  deleteTrade: (trade) => ipcRenderer.invoke("portfolio:delete-trade", trade),
  disconnectBanking: () => ipcRenderer.invoke("banking:disconnect"),
  getBankingBalances: (accountUid, options) => ipcRenderer.invoke("banking:get-balances", accountUid, options),
  getBankingCashFlowTrend: (accountUid, options) => ipcRenderer.invoke("banking:get-cash-flow-trend", accountUid, options),
  getBankingMonthlyExpenses: (accountUid, options) => ipcRenderer.invoke("banking:get-monthly-expenses", accountUid, options),
  getBankingState: () => ipcRenderer.invoke("banking:get-state"),
  getMarketPulseData: (options) => ipcRenderer.invoke("market-pulse:get", options),
  getPortfolio: () => ipcRenderer.invoke("portfolio:get"),
  getSettings: () => ipcRenderer.invoke("portfolio:get-settings"),
  getGeminiModels: (apiKey) => ipcRenderer.invoke("portfolio:get-gemini-models", apiKey),
  getStockIntel: (options) => ipcRenderer.invoke("portfolio:get-stock-intel", options),
  importCsv: () => ipcRenderer.invoke("portfolio:import-csv"),
  openDataFolder: () => ipcRenderer.invoke("portfolio:open-data-folder"),
  refreshMarketPulseData: (options) => ipcRenderer.invoke("market-pulse:refresh", options),
  refreshMarketData: () => ipcRenderer.invoke("portfolio:refresh-market-data"),
  scanMarketUnderdogRadar: (options) => ipcRenderer.invoke("portfolio:scan-market-underdog-radar", options),
  saveBankingSettings: (settings) => ipcRenderer.invoke("banking:save-settings", settings),
  saveSettings: (settings) => ipcRenderer.invoke("portfolio:save-settings", settings),
  searchBankingAspsps: (options) => ipcRenderer.invoke("banking:search-aspsps", options),
  setBankingTransactionCategory: (update) => ipcRenderer.invoke("banking:set-transaction-category", update),
  startBankAuthorization: (settings) => ipcRenderer.invoke("banking:start-authorization", settings),
  selectMediaFolder: (initialPath) => ipcRenderer.invoke("media:select-folder", initialPath),
  selectTargetFolder: (initialPath) => ipcRenderer.invoke("media:select-target-folder", initialPath),
  runMediaPipeline: (sourcePath, targetPath, apiKey) => ipcRenderer.invoke("media:run-pipeline", sourcePath, targetPath, apiKey),
  runMediaCleanup: (targetPath, apiKey) => ipcRenderer.invoke("media:run-cleanup", targetPath, apiKey),
  onPipelineLog: (callback) => {
    const subscription = (_event, log) => callback(log);
    ipcRenderer.on("media:pipeline-log", subscription);
    return () => ipcRenderer.removeListener("media:pipeline-log", subscription);
  },
  onPipelineProgress: (callback) => {
    const subscription = (_event, progress) => callback(progress);
    ipcRenderer.on("media:pipeline-progress", subscription);
    return () => ipcRenderer.removeListener("media:pipeline-progress", subscription);
  },
  onPipelineItem: (callback) => {
    const subscription = (_event, item) => callback(item);
    ipcRenderer.on("media:pipeline-item", subscription);
    return () => ipcRenderer.removeListener("media:pipeline-item", subscription);
  }
});
