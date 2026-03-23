#!/usr/bin/env node

/**
 * Grok MCP Server
 *
 * A Model Context Protocol (MCP) server that exposes xAI's Grok API
 * as tools for AI assistants like Claude Code. Provides two capabilities:
 *
 * - ask_grok: Send prompts to Grok and receive text responses.
 * - generate_image: Generate images using Grok's Aurora model and save them locally.
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

// -- Configuration -----------------------------------------------------------

const XAI_API_BASE = "https://api.x.ai/v1";
const CHAT_MODEL = "grok-3-fast";
const IMAGE_MODEL = "grok-imagine-image";
const MAX_IMAGE_VARIATIONS = 10;
const REQUEST_TIMEOUT_MS = parsePositiveIntEnv("XAI_REQUEST_TIMEOUT_MS", 30_000);
const MAX_RETRIES = parseNonNegativeIntEnv("XAI_MAX_RETRIES", 2);
const RETRY_BASE_DELAY_MS = parsePositiveIntEnv("XAI_RETRY_BASE_DELAY_MS", 500);
const LOG_REQUESTS = parseBooleanEnv("LOG_REQUESTS", false);
const LOG_REQUEST_PAYLOADS = parseBooleanEnv("LOG_REQUEST_PAYLOADS", false);
const SERVER_VERSION = "1.2.0.0";

const SAFE_WRITE_BASE_DIR = process.env.SAFE_WRITE_BASE_DIR;
if (SAFE_WRITE_BASE_DIR && !isAbsolute(SAFE_WRITE_BASE_DIR)) {
  console.error("SAFE_WRITE_BASE_DIR must be an absolute path");
  process.exit(1);
}
const WRITE_BASE_DIR = SAFE_WRITE_BASE_DIR ? resolve(SAFE_WRITE_BASE_DIR) : process.cwd();

const API_KEY = process.env.XAI_API_KEY;
if (!API_KEY) {
  console.error("Missing XAI_API_KEY environment variable");
  process.exit(1);
}

// -- Tool definitions --------------------------------------------------------

const tools = [
  {
    name: "ask_grok",
    description: "Ask Grok a question and get a response",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The question or prompt to send to Grok",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_image",
    description:
      "Generate an image using Grok's Aurora image model and save it to a local file",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Text description of the image to generate",
        },
        file_path: {
          type: "string",
          description:
            "Path where the image file should be saved. Relative paths resolve from cwd; absolute paths must be within SAFE_WRITE_BASE_DIR (or cwd if unset). Example: images/output.png",
        },
        n: {
          type: "number",
          description: "Number of image variations to generate (1-10, default 1)",
        },
      },
      required: ["prompt", "file_path"],
    },
  },
];

// -- Helpers -----------------------------------------------------------------

/**
 * Writes data to a file, enforcing that the destination is inside the
 * allowed base directory. Creates parent directories as needed.
 *
 * Base dir precedence:
 *   1. SAFE_WRITE_BASE_DIR env var (must be an absolute path)
 *   2. process.cwd() as the default fallback
 *
 * @param {string} dest - Resolved absolute destination path.
 * @param {Buffer|string} data - File contents to write.
 * @throws {Error} If dest resolves outside the allowed base.
 */
async function safeWrite(dest, data) {
  const rel = relative(WRITE_BASE_DIR, dest);

  // Starts with ".." → outside base; isAbsolute guards cross-drive (Windows)
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
 * Makes an authenticated request to the xAI API.
 *
 * @param {string} endpoint - API path relative to the base URL (e.g. "/chat/completions").
 * @param {object} body     - JSON-serializable request body.
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {Error} On non-2xx responses, includes status code and error body.
 */
async function xaiRequest(endpoint, body) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const startedAt = Date.now();

    try {
      if (LOG_REQUESTS) {
        logEvent("xai_request", {
          endpoint,
          attempt: attempt + 1,
          max_attempts: MAX_RETRIES + 1,
          timeout_ms: REQUEST_TIMEOUT_MS,
          body: LOG_REQUEST_PAYLOADS ? body : undefined,
        });
      }

      const res = await fetch(`${XAI_API_BASE}${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const elapsedMs = Date.now() - startedAt;

      if (!res.ok) {
        const errorBody = await res.text();
        const retriable = isRetriableStatus(res.status);
        if (LOG_REQUESTS) {
          logEvent("xai_error", {
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
 *
 * @param {string} url - The URL to download.
 * @returns {Promise<Buffer>} The downloaded file contents.
 * @throws {Error} On non-2xx responses.
 */
async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download image: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Builds a numbered file path for multi-image generation.
 * For a single image, returns the path unchanged.
 * For multiple images, inserts an index before the extension:
 *   /tmp/cat.png -> /tmp/cat-1.png, /tmp/cat-2.png, ...
 *
 * @param {string} basePath - The original file path.
 * @param {number} index    - Zero-based image index.
 * @param {number} total    - Total number of images being saved.
 * @returns {string} The resolved, possibly indexed, file path.
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

// -- Tool handlers -----------------------------------------------------------

/**
 * Sends a prompt to Grok's chat completion endpoint and returns the response.
 */
async function handleAskGrok(args) {
  if (!args || typeof args.prompt !== "string" || !args.prompt.trim()) {
    throw new Error("Invalid arguments: 'prompt' must be a non-empty string");
  }

  const data = await xaiRequest("/chat/completions", {
    model: CHAT_MODEL,
    messages: [{ role: "user", content: args.prompt }],
  });

  const messageContent = data?.choices?.[0]?.message?.content;
  const text =
    typeof messageContent === "string"
      ? messageContent
      : messageContent != null
        ? JSON.stringify(messageContent)
        : "No response";
  return { content: [{ type: "text", text }] };
}

/**
 * Generates images via Grok's Aurora model, downloads them, and saves to disk.
 */
async function handleGenerateImage(args) {
  if (!args || typeof args.prompt !== "string" || !args.prompt.trim()) {
    throw new Error("Invalid arguments: 'prompt' must be a non-empty string");
  }
  if (typeof args.file_path !== "string" || !args.file_path.trim()) {
    throw new Error("Invalid arguments: 'file_path' must be a non-empty string");
  }
  if (args.n != null && (!Number.isInteger(args.n) || args.n < 1)) {
    throw new Error("Invalid arguments: 'n' must be a positive integer");
  }

  const n = Math.min(Math.max(args.n ?? 1, 1), MAX_IMAGE_VARIATIONS);

  const data = await xaiRequest("/images/generations", {
    model: IMAGE_MODEL,
    prompt: args.prompt,
    n,
  });

  const images = Array.isArray(data?.data) ? data.data : [];
  if (images.length === 0) {
    throw new Error("xAI API did not return any images");
  }

  const saved = [];
  for (let i = 0; i < images.length; i++) {
    const imageUrl = images[i]?.url;
    if (typeof imageUrl !== "string" || !imageUrl) {
      throw new Error(`xAI API returned an invalid image URL at index ${i}`);
    }

    const buffer = await downloadBuffer(imageUrl);
    const dest = buildFilePath(args.file_path, i, images.length);
    await safeWrite(dest, buffer);
    saved.push(dest);
  }

  return {
    content: [
      {
        type: "text",
        text: `Generated and saved ${saved.length} image(s):\n${saved.join("\n")}`,
      },
    ],
  };
}

const toolHandlers = {
  ask_grok: handleAskGrok,
  generate_image: handleGenerateImage,
};

// -- Server setup ------------------------------------------------------------

const server = new Server(
  { name: "grok", version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

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
    throw new Error(`Unknown tool: ${name}`);
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
    throw error;
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

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
  // Exponential backoff: base, 2*base, 4*base...
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
  return summary;
}

function logEvent(event, fields) {
  const payload = {
    timestamp: new Date().toISOString(),
    event,
    ...fields,
  };
  // MCP uses stdout for protocol; logs must go to stderr.
  console.error(JSON.stringify(payload));
}
