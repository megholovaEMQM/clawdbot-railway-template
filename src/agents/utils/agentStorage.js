import fs from "fs";
import path from "path";
import os from "os";
import logger from "./logger.js";

/**
 * Agent Storage
 * Simple file-based storage for agent metadata
 * Stores metadata specific to the OpenClaw Wrapper REST API
 *
 * This is separate from OpenClaw's native config to keep concerns cleanly separated:
 * - OpenClaw config: $OPENCLAW_STATE_DIR/openclaw.json (at /data/.openclaw on Railway)
 * - OpenClaw workspace: $OPENCLAW_WORKSPACE_DIR (at /data/workspace on Railway)
 * - Wrapper API metadata: $OPENCLAW_WRAPPER_DIR/agents.json (at /data/openclaw-wrapper on Railway)
 *
 * Location: Uses OPENCLAW_WRAPPER_DIR env var
 * Defaults: /data/openclaw-wrapper (Railway), ~/.openclaw-wrapper (local development)
 */
class AgentStorage {
  constructor() {
    // Determine wrapper data directory
    // On Railway: OPENCLAW_WRAPPER_DIR=/data/openclaw-wrapper
    // Locally: ~/.openclaw-wrapper
    let wrapperDir;

    if (process.env.OPENCLAW_WRAPPER_DIR?.trim()) {
      wrapperDir = process.env.OPENCLAW_WRAPPER_DIR.trim();
    } else if (
      process.env.NODE_ENV === "production" ||
      process.env.RAILWAY_ENVIRONMENT_NAME
    ) {
      // Default to /data/openclaw-wrapper on Railway
      wrapperDir = "/data/openclaw-wrapper";
    } else {
      // Local development: ~/.openclaw-wrapper
      wrapperDir = path.join(os.homedir(), ".openclaw-wrapper");
    }

    this.wrapperDir = wrapperDir;
    this.agentsFile = path.join(this.wrapperDir, "agents.json");
    logger.debug("AgentStorage initialized", {
      wrapperDir,
      agentsFile: this.agentsFile,
    });
    this.ensureStorage();
  }

  /**
   * Ensure storage directory exists
   */
  ensureStorage() {
    if (!fs.existsSync(this.wrapperDir)) {
      logger.debug("Creating agent storage directory", {
        path: this.wrapperDir,
      });
      fs.mkdirSync(this.wrapperDir, { recursive: true });
    }
    if (!fs.existsSync(this.agentsFile)) {
      logger.debug("Initializing agents storage file", {
        path: this.agentsFile,
      });
      fs.writeFileSync(this.agentsFile, JSON.stringify({}, null, 2), "utf8");
    }
  }

  /**
   * Read all agents metadata
   * @returns {object} - Agent metadata map
   */
  readAgents() {
    try {
      logger.debug("Reading agents metadata", { path: this.agentsFile });
      const content = fs.readFileSync(this.agentsFile, "utf8");
      const agents = JSON.parse(content);
      logger.debug("Agents metadata loaded", {
        count: Object.keys(agents).length,
      });
      return agents;
    } catch (error) {
      logger.error("Error reading agents storage", error, {
        path: this.agentsFile,
      });
      console.error(`Error reading agents storage: ${error.message}`);
      return {};
    }
  }

  /**
   * Write agents metadata
   * @param {object} agents - Agent metadata map
   */
  writeAgents(agents) {
    try {
      logger.debug("Writing agents metadata", {
        path: this.agentsFile,
        count: Object.keys(agents).length,
      });
      fs.writeFileSync(
        this.agentsFile,
        JSON.stringify(agents, null, 2),
        "utf8",
      );
      logger.debug("Agents metadata written successfully");
    } catch (error) {
      logger.error("Failed to write agents metadata", error, {
        path: this.agentsFile,
      });
      throw {
        statusCode: 500,
        message: `Failed to write agents metadata: ${error.message}`,
      };
    }
  }

  /**
   * Save agent metadata
   * @param {string} agentId - Agent ID
   * @param {object} metadata - Metadata to save
   */
  saveAgent(agentId, metadata) {
    logger.debug("Saving agent metadata", { agentId });
    const agents = this.readAgents();
    agents[agentId] = {
      id: agentId,
      createdAt: agents[agentId]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...metadata,
    };
    this.writeAgents(agents);
    logger.debug("Agent metadata saved", { agentId });
    return agents[agentId];
  }

  /**
   * Get agent metadata
   * @param {string} agentId - Agent ID
   * @returns {object|null}
   */
  getAgent(agentId) {
    logger.debug("Retrieving agent metadata", { agentId });
    const agents = this.readAgents();
    const agent = agents[agentId] || null;
    if (!agent) {
      logger.debug("Agent not found in storage", { agentId });
    }
    return agent;
  }

  /**
   * Get all agents
   * @returns {array}
   */
  getAllAgents() {
    logger.debug("Retrieving all agents");
    const agents = this.readAgents();
    const agentList = Object.values(agents);
    logger.debug("All agents retrieved", { count: agentList.length });
    return agentList;
  }

  /**
   * Delete agent metadata
   * @param {string} agentId - Agent ID
   */
  deleteAgent(agentId) {
    logger.debug("Deleting agent metadata", { agentId });
    const agents = this.readAgents();
    delete agents[agentId];
    this.writeAgents(agents);
    logger.debug("Agent metadata deleted", { agentId });
  }

  /**
   * Update agent metadata (merge)
   * @param {string} agentId - Agent ID
   * @param {object} metadata - Metadata to merge
   */
  updateAgent(agentId, metadata) {
    logger.debug("Updating agent metadata", {
      agentId,
      fields: Object.keys(metadata),
    });
    const existingAgent = this.getAgent(agentId);
    if (!existingAgent) {
      logger.warn("Update failed: agent not found", { agentId });
      throw {
        statusCode: 404,
        message: `Agent ${agentId} not found`,
      };
    }

    const updated = this.saveAgent(agentId, {
      ...existingAgent,
      ...metadata,
    });
  }
}

export default new AgentStorage();
