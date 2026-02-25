import fs from "fs";
import path from "path";

/**
 * Simple file-based logger for agent controller and wrapper operations
 * Logs are written to /data/openclaw-wrapper/logs for logical separation
 */

// Fixed log directory location
const LOG_DIR = "/data/openclaw-wrapper/logs";
const LOG_FILE = path.join(LOG_DIR, "agent-api.log");
const COMMAND_LOG_FILE = path.join(LOG_DIR, "commands.log");

// Ensure log directory exists
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  // Set proper permissions for log directory
  fs.chmodSync(LOG_DIR, 0o755);
} catch (err) {
  console.error("Failed to create log directory:", err);
}

function getTimestamp() {
  return new Date().toISOString();
}

function formatLogEntry(level, message, data = null) {
  const timestamp = getTimestamp();
  const dataStr = data ? ` | ${JSON.stringify(data)}` : "";
  return `[${timestamp}] [${level}] ${message}${dataStr}\n`;
}

function writeLog(entry, logFile = LOG_FILE) {
  try {
    fs.appendFileSync(logFile, entry, { encoding: "utf8" });
  } catch (err) {
    console.error(`Failed to write to log file (${logFile}):`, err);
  }
}

export const logger = {
  info: (message, data) => {
    const entry = formatLogEntry("INFO", message, data);
    console.log(`[AGENT-API] ${message}`, data || "");
    writeLog(entry);
  },

  error: (message, error, data) => {
    const errorStr = error instanceof Error ? error.message : String(error);
    const entry = formatLogEntry("ERROR", message, { error: errorStr, ...data });
    console.error(`[AGENT-API] ERROR: ${message}`, error);
    writeLog(entry);
  },

  debug: (message, data) => {
    const entry = formatLogEntry("DEBUG", message, data);
    console.debug(`[AGENT-API] ${message}`, data || "");
    writeLog(entry);
  },

  warn: (message, data) => {
    const entry = formatLogEntry("WARN", message, data);
    console.warn(`[AGENT-API] WARNING: ${message}`, data || "");
    writeLog(entry);
  },

  // Command execution logging
  command: (command, data) => {
    const entry = formatLogEntry("COMMAND", command, data);
    console.log(`[CMD] ${command}`, data || "");
    writeLog(entry, COMMAND_LOG_FILE);
  },

  commandResult: (command, result) => {
    const entry = formatLogEntry("COMMAND_RESULT", command, result);
    console.log(`[CMD_RESULT] ${command}`, result || "");
    writeLog(entry, COMMAND_LOG_FILE);
  },

  getLogPath: () => LOG_FILE,
  getCommandLogPath: () => COMMAND_LOG_FILE,
  getLogDir: () => LOG_DIR,
};

export default logger;
