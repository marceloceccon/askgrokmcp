#!/usr/bin/env node

/**
 * Grok MCP Server
 *
 * A Model Context Protocol (MCP) server that exposes xAI's Grok API
 * as tools for AI assistants like Claude Code. Provides four capabilities:
 *
 * - ask_grok:        Send prompts to Grok and receive text responses.
 * - generate_image:  Generate images using Grok's Aurora model and save them locally.
 * - list_models:     List all models available to your xAI account.
 * - grok_consensus:  Run a full Consensus Validation Protocol (CVP) with Grok.
 *
 * Model selection (highest priority wins):
 *   1. Per-call `model` argument
 *   2. GROK_CHAT_MODEL / GROK_IMAGE_MODEL environment variables
 *   3. Frontier defaults (grok-4.20-0309-reasoning / grok-imagine-image-pro)
 *   4. Fallback defaults (grok-3-fast / grok-2-image)
 *
 * @see https://modelcontextprotocol.io
 * @see https://docs.x.ai/api
 */

import { writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, dirname, isAbsolute } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getToolDefinitions, createToolHandlers } from "./src/tools.js";

// -- Configuration -----------------------------------------------------------

const XAI_API_BASE = "https://api.x.ai/v1";

/** Frontier models — used when available and no env override is set. */
const FRONTIER_CHAT_MODEL  = "grok-4.20-0309-reasoning";
const FRONTIER_IMAGE_MODEL = "grok-imagine-image-pro";

/** Fallback models — used when frontier models are not available. */
const FALLBACK_CHAT_MODEL  = "grok-3-fast";
const FALLBACK_IMAGE_MODEL = "grok-2-image";

/**
 * Active defaults. Env vars take top priority; otherwise resolved at startup
 * by probing the xAI /models endpoint (frontier -> fallback).
 */
let CHAT_MODEL  = process.env.GROK_CHAT_MODEL  ?? FRONTIER_CHAT_MODEL;
let IMAGE_MODEL = process.env.GROK_IMAGE_MODEL ?? FRONTIER_IMAGE_MODEL;

const MAX_PROMPT_LENGTH     = 128_000;
const MAX_IMAGE_VARIATIONS  = 10;
const REQUEST_TIMEOUT_MS    = parsePositiveIntEnv("XAI_REQUEST_TIMEOUT_MS",  30_000);
const MAX_RETRIES           = parseNonNegativeIntEnv("XAI_MAX_RETRIES",          2);
const RETRY_BASE_DELAY_MS   = parsePositiveIntEnv("XAI_RETRY_BASE_DELAY_MS",   500);
const LOG_REQUESTS          = parseBooleanEnv("LOG_REQUESTS",          false);
const LOG_REQUEST_PAYLOADS  = parseBooleanEnv("LOG_REQUEST_PAYLOADS",  false);
const SERVER_VERSION        = "1.4.0";

const SAFE_WRITE_BASE_DIR = process.env.SAFE_WRITE_BASE_DIR;
if (SAFE_WRITE_BASE_DIR && !isAbsolute(SAFE_WRITE_BASE_DIR)) {
  console.error("SAFE_WRITE_BASE_DIR must be an absolute path");
  process.exit(1);
}
const WRITE_BASE_DIR = SAFE_WRITE_BASE_DIR ? resolve(SAFE_WRITE_BASE_DIR) : process.cwd();

const API_KEY = process.env.XAI_API_KEY;
const __testing = process.env.NODE_TEST === "1";
if (!API_KEY && !__testing) {
  console.error("Missing XAI_API_KEY environment variable");
  process.exit(1);
}

// -- Shared mutable config ---------------------------------------------------
// Handlers hold a reference to this object so they always see resolved values.

const config = {
  get chatModel()  { return CHAT_MODEL; },
  get imageModel() { return IMAGE_MODEL; },
  maxPromptLength:    MAX_PROMPT_LENGTH,
  maxImageVariations: MAX_IMAGE_VARIATIONS,
};

// -- Helpers -----------------------------------------------------------------

/**
 * Writes data to a file, enforcing that the destination is inside the
 * allowed base directory. Creates parent directories as needed.
 */
async function safeWrite(dest, data) {
  const rel = relative(WRITE_BASE_DIR, dest);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      `Path "${dest}" is outside the allowed write directory "${WRITE_BASE_DIR}". ` +
        `Set SAFE_WRITE_BASE_DIR to allow writes elsewhere.`,
    );
  }

  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, data);
}

/**
 * Makes an authenticated POST request to the xAI API with retries.
 */
async function xaiPost(endpoint, body) {
  return xaiRequest("POST", endpoint, body);
}

/**
 * Makes an authenticated GET request to the xAI API.
 */
async function xaiGet(endpoint) {
  return xaiRequest("GET", endpoint, null);
}

/**
 * Core HTTP request handler for the xAI API with retry logic.
 */
async function xaiRequest(method, endpoint, body) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      if (LOG_REQUESTS) {
        logEvent("xai_request", {
          method,
          endpoint,
          attempt: attempt + 1,
          max_attempts: MAX_RETRIES + 1,
          timeout_ms: REQUEST_TIMEOUT_MS,
          body: LOG_REQUEST_PAYLOADS ? body : undefined,
        });
      }

      const fetchOptions = {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        signal: controller.signal,
      };
      if (body !== null) {
        fetchOptions.body = JSON.stringify(body);
      }

      const res = await fetch(`${XAI_API_BASE}${endpoint}`, fetchOptions);
      const elapsedMs = Date.now() - startedAt;

      if (!res.ok) {
        const errorBody = await res.text();
        const retriable = isRetriableStatus(res.status);
        if (LOG_REQUESTS) {
          logEvent("xai_error", {
            method,
            endpoint,
            status: res.status,
            retriable,
            attempt: attempt + 1,
            duration_ms: elapsedMs,
          });
        }
        if (retriable && attempt < MAX_RETRIES) {
          await wait(backoffDelay(attempt));
          continue;
        }
        throw new Error(`xAI API error ${res.status}: ${errorBody}`);
      }

      let json;
      try {
        json = await res.json();
      } catch (parseError) {
        throw new Error(`xAI API returned invalid JSON: ${String(parseError)}`);
      }

      if (LOG_REQUESTS) {
        logEvent("xai_success", {
          method,
          endpoint,
          attempt: attempt + 1,
          duration_ms: elapsedMs,
        });
      }

      return json;
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const isTimeout = error?.name === "AbortError";
      const retriable = isTimeout || isNetworkError(error);

      if (LOG_REQUESTS) {
        logEvent("xai_exception", {
          method,
          endpoint,
          attempt: attempt + 1,
          duration_ms: elapsedMs,
          timeout: isTimeout,
          retriable,
          error: String(error),
        });
      }

      if (retriable && attempt < MAX_RETRIES) {
        await wait(backoffDelay(attempt));
        continue;
      }

      if (isTimeout) {
        throw new Error(
          `xAI API request timed out after ${REQUEST_TIMEOUT_MS}ms (endpoint: ${endpoint})`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("xAI API request failed after retries");
}

/**
 * Downloads a remote URL and returns its contents as a Buffer.
 */
async function downloadBuffer(url) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, { signal: controller.signal });

      if (!res.ok) {
        const retriable = isRetriableStatus(res.status);
        if (retriable && attempt < MAX_RETRIES) {
          await wait(backoffDelay(attempt));
          continue;
        }
        throw new Error(`Failed to download image: HTTP ${res.status}`);
      }

      return Buffer.from(await res.arrayBuffer());
    } catch (error) {
      const isTimeout = error?.name === "AbortError";
      const retriable = isTimeout || isNetworkError(error);

      if (retriable && attempt < MAX_RETRIES) {
        await wait(backoffDelay(attempt));
        continue;
      }

      if (isTimeout) {
        throw new Error(`Image download timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Image download failed after retries");
}

/**
 * Builds a numbered file path for multi-image generation.
 */
function buildFilePath(basePath, index, total) {
  const dest = resolve(basePath);
  if (total <= 1) return dest;

  const dot = dest.lastIndexOf(".");
  if (dot !== -1) {
    return `${dest.slice(0, dot)}-${index + 1}${dest.slice(dot)}`;
  }
  return `${dest}-${index + 1}`;
}

// -- Tool handlers (created from src/tools.js) -------------------------------

const toolHandlers = createToolHandlers({
  xaiPost,
  xaiGet,
  safeWrite,
  buildFilePath,
  downloadBuffer,
  resolve,
  config,
});

// -- Model resolution --------------------------------------------------------

/**
 * Resolves CHAT_MODEL and IMAGE_MODEL at startup.
 * If the user supplied env vars, those are trusted as-is.
 * Otherwise, we probe the xAI /models endpoint: use frontier if available,
 * fall back to the safe defaults if not.
 */
async function resolveDefaults() {
  const chatFromEnv  = !!process.env.GROK_CHAT_MODEL;
  const imageFromEnv = !!process.env.GROK_IMAGE_MODEL;

  if (chatFromEnv && imageFromEnv) return;

  let availableIds;
  try {
    const data = await xaiGet("/models");
    const models = Array.isArray(data?.data) ? data.data : [];
    availableIds = new Set(models.map((m) => m.id));
  } catch {
    logEvent("resolve_defaults", { status: "models_fetch_failed", action: "using_fallbacks" });
    if (!chatFromEnv)  CHAT_MODEL  = FALLBACK_CHAT_MODEL;
    if (!imageFromEnv) IMAGE_MODEL = FALLBACK_IMAGE_MODEL;
    return;
  }

  if (!chatFromEnv) {
    if (availableIds.has(FRONTIER_CHAT_MODEL)) {
      CHAT_MODEL = FRONTIER_CHAT_MODEL;
    } else {
      CHAT_MODEL = FALLBACK_CHAT_MODEL;
      logEvent("resolve_defaults", {
        model_type: "chat",
        wanted: FRONTIER_CHAT_MODEL,
        resolved: FALLBACK_CHAT_MODEL,
        reason: "frontier_unavailable",
      });
    }
  }

  if (!imageFromEnv) {
    if (availableIds.has(FRONTIER_IMAGE_MODEL)) {
      IMAGE_MODEL = FRONTIER_IMAGE_MODEL;
    } else {
      IMAGE_MODEL = FALLBACK_IMAGE_MODEL;
      logEvent("resolve_defaults", {
        model_type: "image",
        wanted: FRONTIER_IMAGE_MODEL,
        resolved: FALLBACK_IMAGE_MODEL,
        reason: "frontier_unavailable",
      });
    }
  }

  logEvent("resolve_defaults", {
    status: "ok",
    chat_model: CHAT_MODEL,
    image_model: IMAGE_MODEL,
    chat_source: chatFromEnv ? "env" : (CHAT_MODEL === FRONTIER_CHAT_MODEL ? "frontier" : "fallback"),
    image_source: imageFromEnv ? "env" : (IMAGE_MODEL === FRONTIER_IMAGE_MODEL ? "frontier" : "fallback"),
  });
}

// -- Server setup ------------------------------------------------------------

if (!__testing) {
  const server = new Server(
    { name: "grok", version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: getToolDefinitions({ chatModel: CHAT_MODEL, imageModel: IMAGE_MODEL }),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = request.params.arguments ?? {};

    const startedAt = Date.now();
    if (LOG_REQUESTS) {
      logEvent("tool_request", {
        tool: name,
        arguments: LOG_REQUEST_PAYLOADS ? args : summarizeArguments(args),
      });
    }

    const handler = toolHandlers[name];
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}. Available tools: ${Object.keys(toolHandlers).join(", ")}` }],
      };
    }
    try {
      const result = await handler(args);
      if (LOG_REQUESTS) {
        logEvent("tool_success", {
          tool: name,
          duration_ms: Date.now() - startedAt,
        });
      }
      return result;
    } catch (error) {
      if (LOG_REQUESTS) {
        logEvent("tool_error", {
          tool: name,
          duration_ms: Date.now() - startedAt,
          error: String(error),
        });
      }
      return {
        isError: true,
        content: [{ type: "text", text: error?.message ?? String(error) }],
      };
    }
  });

  await resolveDefaults();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// -- Exports (testing) -------------------------------------------------------

export {
  safeWrite,
  buildFilePath,
  toolHandlers,
  WRITE_BASE_DIR,
  MAX_PROMPT_LENGTH,
};

// Re-export individual handlers for backwards-compatible test access.
const { ask_grok, generate_image, list_models, grok_consensus } = toolHandlers;
export {
  ask_grok    as handleAskGrok,
  generate_image as handleGenerateImage,
  list_models    as handleListModels,
  grok_consensus as handleGrokConsensus,
};

// -- Utility functions -------------------------------------------------------

function parseBooleanEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;

  console.error(`${name} must be a boolean-like value (true/false, 1/0)`);
  process.exit(1);
}

function parsePositiveIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error(`${name} must be a positive integer`);
    process.exit(1);
  }
  return parsed;
}

function parseNonNegativeIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (raw == null) return defaultValue;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`${name} must be a non-negative integer`);
    process.exit(1);
  }
  return parsed;
}

function isRetriableStatus(status) {
  return status === 429 || status >= 500;
}

function isNetworkError(error) {
  const message = String(error?.message ?? "").toLowerCase();
  return message.includes("fetch failed") || message.includes("network");
}

function backoffDelay(attempt) {
  return RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
}

function wait(ms) {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function summarizeArguments(args) {
  if (!args || typeof args !== "object") return {};

  const summary = { ...args };
  if (typeof summary.prompt === "string") {
    summary.prompt = `[redacted:${summary.prompt.length} chars]`;
  }
  if (typeof summary.topic === "string") {
    summary.topic = `[redacted:${summary.topic.length} chars]`;
  }
  return summary;
}

function logEvent(event, fields) {
  const payload = {
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  };
  console.error(JSON.stringify(payload));
}
