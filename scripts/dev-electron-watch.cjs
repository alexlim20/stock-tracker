const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const electronPath = require("electron");

const projectRoot = path.join(__dirname, "..");
const devServerUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const watchedFiles = [
  path.join(projectRoot, "electron", "main.js"),
  path.join(projectRoot, "electron", "preload.cjs"),
  path.join(projectRoot, "src", "shared", "marketPulseData.js")
];

let electronProcess = null;
let restartTimer = null;
let isStopping = false;
const pendingRestartFiles = new Set();

waitForDevServer()
  .then(() => {
    startElectron();
    watchElectronFiles();
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });

function waitForDevServer() {
  const startedAt = Date.now();
  const timeoutMs = 60_000;

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(devServerUrl, (response) => {
        response.resume();
        resolve();
      });

      request.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for Vite at ${devServerUrl}`));
          return;
        }
        setTimeout(check, 350);
      });
      request.setTimeout(1500, () => {
        request.destroy();
      });
    };

    check();
  });
}

function startElectron() {
  if (isStopping) return;

  electronProcess = spawn(electronPath, ["."], {
    cwd: projectRoot,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devServerUrl
    },
    stdio: "inherit"
  });

  electronProcess.on("exit", (code, signal) => {
    electronProcess = null;
    if (!isStopping && signal !== "SIGTERM" && code !== 0) {
      console.log(`Electron exited with code ${code ?? "null"}. Waiting for file changes before restarting.`);
    }
  });
}

function watchElectronFiles() {
  for (const filePath of watchedFiles) {
    fs.watchFile(filePath, { interval: 500 }, (current, previous) => {
      if (isStopping) return;
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
      scheduleRestart(filePath);
    });
  }
}

function scheduleRestart(filePath) {
  if (filePath) {
    pendingRestartFiles.add(path.relative(projectRoot, filePath));
  }
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    restartElectron([...pendingRestartFiles]);
  }, 250);
}

function restartElectron(changedFiles = []) {
  if (isStopping) return;
  pendingRestartFiles.clear();
  const fileLabel = changedFiles.length ? ` (${changedFiles.join(", ")})` : "";
  console.log(`Electron main/preload changed${fileLabel}. Restarting Electron...`);

  if (!electronProcess) {
    startElectron();
    return;
  }

  const currentProcess = electronProcess;
  currentProcess.once("exit", () => {
    if (!isStopping) startElectron();
  });
  currentProcess.kill();
}

function stop() {
  isStopping = true;
  clearTimeout(restartTimer);
  for (const filePath of watchedFiles) {
    fs.unwatchFile(filePath);
  }
  if (electronProcess) electronProcess.kill();
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
