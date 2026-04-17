import fs from "fs";
import path from "path";
import os from "os";
import logger from "./logger.js";

/**
 * Simple async mutex — prevents concurrent read-modify-write races on the config file.
 * Only protects in-process concurrency; the openclaw gateway has its own atomic write
 * mechanism (temp file + rename) for cross-process safety.
 */
class Mutex {
  constructor() {
    this._queue = Promise.resolve();
  }
  acquire(fn) {
    const result = this._queue.then(fn);
    this._queue = result.catch(() => {});
    return result;
  }
}

/**
 * OpenClaw Config Manager
 * Handles reading and writing the /data/.openclaw/openclaw.json config file
 * All file operations are logged for transparency
 */
class ConfigManager {
  constructor() {
    // Prefer OPENCLAW_STATE_DIR env var (set to /data/.openclaw on Railway).
    // Fall back to ~/.openclaw for local development.
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim()
      || path.join(os.homedir(), ".openclaw");
    this.configPath = path.join(stateDir, "openclaw.json");
    this.configDir = path.dirname(this.configPath);
    this._mutex = new Mutex();
  }

  /**
   * Ensure the .openclaw directory exists
   */
  ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) {
      logger.debug("Creating config directory", { path: this.configDir });
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  /**
   * Read the current OpenClaw config.
   * Returns default config only when the file does not exist yet.
   * Throws if the file exists but cannot be read or parsed — prevents
   * a bad read from silently triggering a write that overwrites real config.
   * @returns {object} - Current configuration
   */
  readConfig() {
    this.ensureConfigDir();

    if (!fs.existsSync(this.configPath)) {
      logger.debug("Config file not found, using default", { path: this.configPath });
      return this.getDefaultConfig();
    }

    logger.debug("Reading OpenClaw config", { path: this.configPath });
    const content = fs.readFileSync(this.configPath, "utf8");
    const config = JSON.parse(content);
    logger.debug("Config parsed successfully");
    return config;
  }

  /**
   * Write the OpenClaw config
   * @param {object} config - Configuration to write
   */
  writeConfig(config) {
    try {
      this.ensureConfigDir();
      const content = JSON.stringify(config, null, 2);
      logger.debug("Writing OpenClaw config", { path: this.configPath });
      fs.writeFileSync(this.configPath, content, "utf8");
      logger.debug("OpenClaw config written successfully");
      return true;
    } catch (error) {
      logger.error("Failed to write config", error, { path: this.configPath });
      throw {
        statusCode: 500,
        message: `Failed to write config: ${error.message}`,
        details: error.message,
      };
    }
  }

  /**
   * Get default empty config
   * @returns {object}
   */
  getDefaultConfig() {
    return {
      agents: {
        list: [],
        defaults: {
          workspace: `/data/.openclaw/workspace`,
        },
      },
      channels: {},
      bindings: [],
    };
  }

  /**
   * Add or update an agent in the config.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {string} agentId - Agent ID
   * @param {object} agentConfig - Agent configuration
   */
  updateAgentInConfig(agentId, agentConfig) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();

      if (!config.agents) {
        config.agents = { list: [], defaults: {} };
      }
      if (!Array.isArray(config.agents.list)) {
        config.agents.list = [];
      }

      const existingIndex = config.agents.list.findIndex((a) => a.id === agentId);
      const agentEntry = {
        id: agentId,
        workspace: agentConfig.workspace || `/data/.openclaw/workspace-${agentId}`,
        agentDir: agentConfig.agentDir || `/data/.openclaw/agents/${agentId}/agent`,
        ...agentConfig,
      };

      if (existingIndex >= 0) {
        config.agents.list[existingIndex] = {
          ...config.agents.list[existingIndex],
          ...agentEntry,
        };
      } else {
        config.agents.list.push(agentEntry);
      }

      this.writeConfig(config);
      return agentEntry;
    });
  }

  /**
   * Remove an agent from the config.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {string} agentId - Agent ID to remove
   */
  removeAgentFromConfig(agentId) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();

      if (config.agents && Array.isArray(config.agents.list)) {
        config.agents.list = config.agents.list.filter((a) => a.id !== agentId);
      }

      if (Array.isArray(config.bindings)) {
        config.bindings = config.bindings.filter((b) => b.agentId !== agentId);
      }

      this.writeConfig(config);
    });
  }

  /**
   * Get agent config from the main config
   * @param {string} agentId - Agent ID
   * @returns {object|null}
   */
  getAgentConfig(agentId) {
    const config = this.readConfig();
    if (config.agents && Array.isArray(config.agents.list)) {
      return config.agents.list.find((a) => a.id === agentId) || null;
    }
    return null;
  }

  /**
   * Patch agent config (merge with existing).
   * Serialised via mutex — reads and writes inside a single locked operation
   * to prevent races with concurrent updateAgentInConfig calls.
   * @param {string} agentId - Agent ID
   * @param {object} configPatch - Partial config to merge
   */
  patchAgentConfig(agentId, configPatch) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();
      const existingConfig = config.agents?.list?.find((a) => a.id === agentId);

      if (!existingConfig) {
        throw {
          statusCode: 404,
          message: `Agent ${agentId} not found in config`,
        };
      }

      const mergedConfig = {
        ...existingConfig,
        ...configPatch,
        id: agentId,
      };

      const existingIndex = config.agents.list.findIndex((a) => a.id === agentId);
      config.agents.list[existingIndex] = mergedConfig;

      this.writeConfig(config);
      return mergedConfig;
    });
  }

  /**
   * Add or remove tool names from the global tools.allow list.
   * This is required for optional plugin tools to be visible to agents —
   * openclaw resolves optional tool availability against the global tools.allow,
   * not the per-agent one.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {"add"|"remove"} action
   * @param {string[]} toolNames
   */
  patchGlobalToolsAllow(action, toolNames) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();
      const currentAllow = config.tools?.allow ?? [];

      let newAllow;
      if (action === "add") {
        const toAdd = toolNames.filter((n) => !currentAllow.includes(n));
        if (toAdd.length === 0) return;
        newAllow = [...currentAllow, ...toAdd];
      } else {
        const toRemove = new Set(toolNames);
        newAllow = currentAllow.filter((n) => !toRemove.has(n));
        if (newAllow.length === currentAllow.length) return;
      }

      const updated = {
        ...config,
        tools: { ...(config.tools ?? {}), allow: newAllow },
      };
      this.writeConfig(updated);
      logger.info("ConfigManager: patched global tools.allow", { action, toolNames });
    });
  }

  /**
   * Add a binding to route messages to an agent.
   * Serialised via mutex to prevent concurrent read-modify-write races.
   * @param {string} agentId - Agent ID
   * @param {object} matchCriteria - Matching criteria (channel, accountId, peer, etc.)
   */
  addBinding(agentId, matchCriteria) {
    return this._mutex.acquire(() => {
      const config = this.readConfig();

      if (!Array.isArray(config.bindings)) {
        config.bindings = [];
      }

      const binding = { agentId, match: matchCriteria };
      config.bindings.push(binding);
      this.writeConfig(config);
      return binding;
    });
  }
}

export default new ConfigManager();
