/**
 * Task notification handler — POST /api/notifications/tasks
 *
 * Receives KC push notifications from the orchestrator and triggers the target
 * agent via the internal openclaw gateway (/v1/chat/completions).
 *
 * Design rules (from design doc):
 *
 * Coalescing (tasks_available / task_assigned only):
 *   Per-agent in-memory set with a 30-second window. If a wake-up notification
 *   arrives for an agent already in the set, it is dropped. The agent always
 *   calls kc_get_next_task on activation, so extra wake-ups carry no info.
 *   approval_actioned is NEVER coalesced — dropping it leaves a task stuck in
 *   received_approval permanently.
 *
 * Gateway readiness guard:
 *   Calls ensureGatewayRunning() before triggering. If the gateway is not up,
 *   the notification is queued per-agent:
 *     - Wake-up slot (tasks_available / task_assigned): max 1 entry — collapses.
 *     - Approval queue (approval_actioned): unbounded list (soft cap 50 + warning).
 *   On the next successful ensureGatewayRunning() call, pending queues are
 *   drained: approval_actioned entries first (in order), then the wake-up slot.
 *
 * approval_actioned retry on UNAVAILABLE:
 *   If the gateway returns UNAVAILABLE / "session is still active", the agent is
 *   mid-turn. Retry up to 3 times with backoff: 30 s, 60 s, 120 s. If all
 *   retries are exhausted, log an error — manual operator recovery is needed.
 */

import express from "express";
import jwt from "jsonwebtoken";
import logger from "../agents/utils/logger.js";

const GATEWAY_PORT = 18789;
const GATEWAY_TOKEN = () => process.env.OPENCLAW_GATEWAY_TOKEN?.trim();

// ---------------------------------------------------------------------------
// Coalesce map: agentId → timer handle.
// Tracks agents that have a pending or in-flight wake-up trigger (30s window).
// ---------------------------------------------------------------------------
const COALESCE_WINDOW_MS = 30_000;
const coalesceMap = new Map(); // agentId → NodeJS.Timeout

function markCoalescing(agentId) {
  const existing = coalesceMap.get(agentId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => coalesceMap.delete(agentId), COALESCE_WINDOW_MS);
  coalesceMap.set(agentId, timer);
}

function isCoalescing(agentId) {
  return coalesceMap.has(agentId);
}

// ---------------------------------------------------------------------------
// Gateway readiness queue.
// Per-agent: { wakeup: event | null, approvals: event[] }
// ---------------------------------------------------------------------------
const pendingQueues = new Map(); // agentId → { wakeup, approvals }

function getOrCreateQueue(agentId) {
  if (!pendingQueues.has(agentId)) {
    pendingQueues.set(agentId, { wakeup: null, approvals: [] });
  }
  return pendingQueues.get(agentId);
}

function enqueue(event) {
  const q = getOrCreateQueue(event.agentId);

  if (event.event === "tasks_available" || event.event === "task_assigned") {
    // Collapse: wake-up slot holds at most one entry.
    q.wakeup = event;
  } else if (event.event === "approval_actioned") {
    if (q.approvals.length >= 50) {
      logger.warn(
        `[notifications] approval queue soft limit (50) reached for agent ${event.agentId}; enqueueing anyway`
      );
    }
    q.approvals.push(event);
  }
}

// ---------------------------------------------------------------------------
// Agent triggering via /v1/chat/completions (fire-and-forget internally;
// callers await the returned promise for retry logic).
// ---------------------------------------------------------------------------

function buildMessage(event) {
  if (event.event === "tasks_available" || event.event === "task_assigned") {
    return "You have a task scheduled. Invoke kc_get_next_task to fetch it and begin.";
  }
  if (event.event === "approval_actioned") {
    const { taskId, action, userNotes } = event;
    return (
      `Approval actioned for task ${taskId}. action=${action}. ` +
      `userNotes=${userNotes ?? "null"}. ` +
      `Invoke kc_get_task with taskId=${taskId} to fetch current state and resume.`
    );
  }
  return null;
}

async function triggerAgent(agentId, message) {
  const gatewayToken = GATEWAY_TOKEN();
  const url = `http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${gatewayToken}`,
    },
    body: JSON.stringify({
      model: `openclaw:${agentId}`,
      messages: [{ role: "user", content: message }],
    }),
  });

  return resp;
}

// Check whether a gateway response signals UNAVAILABLE / "session is still active".
async function isUnavailable(resp) {
  if (resp.ok) return false;
  // Clone response text without consuming the original (already consumed by caller if needed).
  try {
    const text = await resp.clone().text();
    return (
      text.includes("UNAVAILABLE") ||
      text.includes("session is still active") ||
      resp.status === 503 ||
      resp.status === 409
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// approval_actioned delivery with retry on UNAVAILABLE.
// Retries: 30 s, 60 s, 120 s. After exhaustion, logs and gives up.
// ---------------------------------------------------------------------------
const APPROVAL_RETRY_DELAYS = [30_000, 60_000, 120_000];

function scheduleApprovalRetry(agentId, message, attempt = 0) {
  if (attempt >= APPROVAL_RETRY_DELAYS.length) {
    logger.error(
      `[notifications] approval_actioned exhausted all retries for agent ${agentId} — manual recovery needed`
    );
    return;
  }

  const delay = APPROVAL_RETRY_DELAYS[attempt];
  logger.warn(
    `[notifications] approval_actioned UNAVAILABLE for agent ${agentId}; retry ${attempt + 1}/${APPROVAL_RETRY_DELAYS.length} in ${delay / 1000}s`
  );

  setTimeout(async () => {
    try {
      const resp = await triggerAgent(agentId, message);
      if (await isUnavailable(resp)) {
        scheduleApprovalRetry(agentId, message, attempt + 1);
      } else if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        logger.error(
          `[notifications] approval_actioned delivery failed for agent ${agentId} [${resp.status}]: ${text}`
        );
      }
    } catch (err) {
      logger.error(
        `[notifications] approval_actioned retry error for agent ${agentId}: ${err.message}`
      );
      scheduleApprovalRetry(agentId, message, attempt + 1);
    }
  }, delay);
}

async function dispatchApprovalActioned(agentId, message) {
  try {
    const resp = await triggerAgent(agentId, message);
    if (await isUnavailable(resp)) {
      scheduleApprovalRetry(agentId, message, 0);
    } else if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logger.error(
        `[notifications] approval_actioned delivery failed for agent ${agentId} [${resp.status}]: ${text}`
      );
    }
  } catch (err) {
    logger.error(
      `[notifications] approval_actioned trigger error for agent ${agentId}: ${err.message}`
    );
    // On network error, start retry schedule.
    scheduleApprovalRetry(agentId, message, 0);
  }
}

// ---------------------------------------------------------------------------
// Wake-up dispatch (tasks_available / task_assigned).
// Marks coalesce window; errors are logged, not fatal.
// ---------------------------------------------------------------------------
async function dispatchWakeup(agentId, message) {
  markCoalescing(agentId);
  try {
    const resp = await triggerAgent(agentId, message);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logger.warn(
        `[notifications] wake-up trigger failed for agent ${agentId} [${resp.status}]: ${text}`
      );
    }
  } catch (err) {
    logger.warn(
      `[notifications] wake-up trigger error for agent ${agentId}: ${err.message}`
    );
  }
}

// ---------------------------------------------------------------------------
// Drain all pending queues after the gateway becomes available.
// approval_actioned entries fire first (in order), then the wake-up slot.
// ---------------------------------------------------------------------------
async function drainAllQueues() {
  for (const [agentId, q] of pendingQueues.entries()) {
    // Snapshot + clear before dispatching to avoid double-dispatch if a new
    // notification arrives mid-drain.
    const approvals = q.approvals.splice(0);
    const wakeup = q.wakeup;
    q.wakeup = null;

    if (approvals.length === 0 && !wakeup) {
      pendingQueues.delete(agentId);
      continue;
    }

    // Approvals first.
    for (const ev of approvals) {
      const msg = buildMessage(ev);
      if (msg) await dispatchApprovalActioned(agentId, msg);
    }

    // Wake-up slot last.
    if (wakeup) {
      const msg = buildMessage(wakeup);
      if (msg) await dispatchWakeup(agentId, msg);
    }

    pendingQueues.delete(agentId);
  }
}

// ---------------------------------------------------------------------------
// Main notification dispatcher.
// ---------------------------------------------------------------------------
async function handleEvent(event, ensureGatewayRunning) {
  const { agentId } = event;
  const message = buildMessage(event);
  if (!message) {
    logger.warn(`[notifications] unknown event type: ${event.event}`);
    return;
  }

  // Gateway readiness guard.
  // ensureGatewayRunning() returns { ok: false } (no throw) when not configured,
  // and throws when the gateway fails to start. Both cases mean not ready.
  let gatewayReady = false;
  try {
    const result = await ensureGatewayRunning();
    gatewayReady = result?.ok === true;
  } catch {
    gatewayReady = false;
  }

  if (!gatewayReady) {
    enqueue(event);
    logger.info(
      `[notifications] gateway not ready — queued ${event.event} for agent ${agentId}`
    );
    return;
  }

  // Gateway is up. Drain any backlog for all agents before processing the
  // current event so queued approvals are not overtaken by a fresh wake-up.
  if (pendingQueues.size > 0) {
    await drainAllQueues();
  }

  // Now process the current event.
  if (event.event === "approval_actioned") {
    // Never coalesced.
    await dispatchApprovalActioned(agentId, message);
  } else {
    // tasks_available or task_assigned — apply coalescing.
    if (isCoalescing(agentId)) {
      logger.info(
        `[notifications] coalescing ${event.event} for agent ${agentId} (already in-flight)`
      );
      return;
    }
    await dispatchWakeup(agentId, message);
  }
}

// ---------------------------------------------------------------------------
// Router factory.
// jwtSecret: same JWT_SECRET used by all /api/* routes — the orchestrator signs
// notifications with openclaw_jwt_secret which equals JWT_SECRET on this tenant.
// ensureGatewayRunning: from server.js — starts the gateway if not running.
// ---------------------------------------------------------------------------
export function createNotificationsRouter(jwtSecret, ensureGatewayRunning) {
  const router = express.Router();

  // Auth: JWT signed by the orchestrator with openclaw_jwt_secret (= JWT_SECRET).
  function requireJwt(req, res, next) {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing or invalid Authorization header" });
    }
    const token = header.slice(7);
    try {
      req.jwtPayload = jwt.verify(token, jwtSecret);
      next();
    } catch {
      return res.status(401).json({ error: "Invalid or expired token" });
    }
  }

  /**
   * POST /api/notifications/tasks
   *
   * Body shapes:
   *   { event: "tasks_available",   agentId }
   *   { event: "task_assigned",     agentId, taskId }
   *   { event: "approval_actioned", agentId, taskId, action, userNotes }
   *
   * Responds immediately (202) — agent triggering is async.
   */
  router.post("/tasks", requireJwt, async (req, res) => {
    const { event, agentId, taskId, action, userNotes } = req.body ?? {};

    if (!event || !agentId) {
      return res.status(400).json({ error: "event and agentId are required" });
    }

    const VALID_EVENTS = new Set(["tasks_available", "task_assigned", "approval_actioned"]);
    if (!VALID_EVENTS.has(event)) {
      return res.status(400).json({ error: `Unknown event type: ${event}` });
    }

    if (event === "approval_actioned") {
      if (!taskId || !action) {
        return res.status(400).json({ error: "approval_actioned requires taskId and action" });
      }
      if (action !== "approve" && action !== "modify") {
        return res
          .status(400)
          .json({ error: "approval_actioned action must be approve or modify" });
      }
    }

    if (event === "task_assigned" && !taskId) {
      return res.status(400).json({ error: "task_assigned requires taskId" });
    }

    // Respond immediately — agent triggering is async.
    res.status(202).json({ ok: true });

    // Process without blocking the response.
    const normalizedEvent = { event, agentId, taskId, action, userNotes: userNotes ?? null };
    handleEvent(normalizedEvent, ensureGatewayRunning).catch((err) => {
      logger.error(`[notifications] unhandled error in handleEvent: ${err.message}`);
    });
  });

  return router;
}
