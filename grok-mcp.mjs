#!/usr/bin/env node

/**
 * Grok MCP Server
 *
 * A Model Context Protocol (MCP) server that exposes xAI's Grok API
 * as tools for AI assistants like Claude Code. Provides three capabilities:
 *
 * - ask_grok:      Send prompts to Grok and receive text responses.
 * - generate_image: Generate images using Grok's Aurora model and save them locally.
 * - list_models:   List all models available to your xAI account.
 *
 * Model selection (highest priority wins):
 *   1. Per-call `model` argument
 *   2. GROK_CHAT_MODEL / GROK_IMAGE_MODEL environment variables
 *   3. Built-in defaults (grok-3-fast / grok-2-image)
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

/** Default models — overridable via env vars or per-call argument. */
const DEFAULT_CHAT_MODEL  = "grok-3-fast";
const DEFAULT_IMAGE_MODEL = "grok-2-image";

/** Active defaults (env vars take precedence over built-ins). */
const CHAT_MODEL  = process.env.GROK_CHAT_MODEL  ?? DEFAULT_CHAT_MODEL;
const IMAGE_MODEL = process.env.GROK_IMAGE_MODEL ?? DEFAULT_IMAGE_MODEL;

const MAX_IMAGE_VARIATIONS  = 10;
const REQUEST_TIMEOUT_MS    = parsePositiveIntEnv("XAI_REQUEST_TIMEOUT_MS",  30_000);
const MAX_RETRIES           = parseNonNegativeIntEnv("XAI_MAX_RETRIES",          2);
const RETRY_BASE_DELAY_MS   = parsePositiveIntEnv("XAI_RETRY_BASE_DELAY_MS",   500);
const LOG_REQUESTS          = parseBooleanEnv("LOG_REQUESTS",          false);
const LOG_REQUEST_PAYLOADS  = parseBooleanEnv("LOG_REQUEST_PAYLOADS",  false);
const SERVER_VERSION        = "1.3.0";

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
    description:
      "Ask Grok a question and get a response. " +
      `Default model: ${CHAT_MODEL}. ` +
      "Use the optional 'model' parameter to use a different chat model. " +
      "Run list_models to see all available options.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The question or prompt to send to Grok",
        },
        model: {
          type: "string",
          description:
            `Chat model to use for this request. Defaults to "${CHAT_MODEL}". ` +
            "Use list_models to see available chat models.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_image",
    description:
      "Generate an image using Grok's Aurora image model and save it to a local file. " +
      `Default model: ${IMAGE_MODEL}. ` +
      "Use the optional 'model' parameter to use a different image model.",
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
            "Path where the image file should be saved. Relative paths resolve from cwd; " +
            "absolute paths must be within SAFE_WRITE_BASE_DIR (or cwd if unset). Example: images/output.png",
        },
        n: {
          type: "number",
          description: "Number of image variations to generate (1-10, default 1)",
        },
        model: {
          type: "string",
          description:
            `Image model to use for this request. Defaults to "${IMAGE_MODEL}". ` +
            "Use list_models to see available image models.",
        },
      },
      required: ["prompt", "file_path"],
    },
  },
  {
    name: "list_models",
    description:
      "List all xAI models available to your account, including their IDs and capabilities. " +
      "Use this to discover which models you can pass to ask_grok or generate_image. " +
      "You can also filter by type: 'chat' for language models or 'image' for image generation.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all", "chat", "image"],
          description:
            "Filter models by capability. " +
            "'chat' returns language/reasoning models, " +
            "'image' returns image generation models, " +
            "'all' returns everything (default).",
        },
      },
      required: [],
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
 * Makes an authenticated POST request to the xAI API with retries.
 *
 * @param {string} endpoint - API path relative to the base URL (e.g. "/chat/completions").
 * @param {object} body     - JSON-serializable request body.
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {Error} On non-2xx responses after retries.
 */
async function xaiPost(endpoint, body) {
  return xaiRequest("POST", endpoint, body);
}

/**
 * Makes an authenticated GET request to the xAI API.
 *
 * @param {string} endpoint - API path relative to the base URL (e.g. "/models").
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {Error} On non-2xx responses.
 */
async function xaiGet(endpoint) {
  return xaiRequest("GET", endpoint, null);
}

/**
 * Core HTTP request handler for the xAI API with retry logic.
 *
 * @param {"GET"|"POST"} method - HTTP method.
 * @param {string} endpoint     - API path relative to the base URL.
 * @param {object|null} body    - JSON body (POST only; null for GET).
 * @returns {Promise<object>} Parsed JSON response.
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
 * Honors the optional per-call `model` argument.
 */
async function handleAskGrok(args) {
  if (!args || typeof args.prompt !== "string" || !args.prompt.trim()) {
    throw new Error("Invalid arguments: 'prompt' must be a non-empty string");
  }

  const model = (typeof args.model === "string" && args.model.trim())
    ? args.model.trim()
    : CHAT_MODEL;

  const data = await xaiPost("/chat/completions", {
    model,
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
 * Honors the optional per-call `model` argument.
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
  const model = (typeof args.model === "string" && args.model.trim())
    ? args.model.trim()
    : IMAGE_MODEL;

  const data = await xaiPost("/images/generations", {
    model,
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

/**
 * Fetches available models from the xAI API and formats them for display.
 * Supports optional filtering by capability (chat or image).
 */
async function handleListModels(args) {
  const filter = args?.filter ?? "all";
  if (!["all", "chat", "image"].includes(filter)) {
    throw new Error("Invalid arguments: 'filter' must be 'all', 'chat', or 'image'");
  }

  const data = await xaiGet("/models");
  const models = Array.isArray(data?.data) ? data.data : [];

  if (models.length === 0) {
    return { content: [{ type: "text", text: "No models returned by the xAI API." }] };
  }

  // xAI model IDs contain hints about their capability:
  // image generation models have "image" or "imagine" in the ID.
  const isImageModel = (id) =>
    /image|imagine|aurora/i.test(id);

  const filtered = models.filter((m) => {
    if (filter === "all") return true;
    const isImg = isImageModel(m.id ?? "");
    return filter === "image" ? isImg : !isImg;
  });

  if (filtered.length === 0) {
    return {
      content: [{
        type: "text",
        text: `No ${filter} models found. Try filter: "all" to see everything.`,
      }],
    };
  }

  // Sort: alphabetically, images last
  filtered.sort((a, b) => {
    const aImg = isImageModel(a.id ?? "");
    const bImg = isImageModel(b.id ?? "");
    if (aImg !== bImg) return aImg ? 1 : -1;
    return (a.id ?? "").localeCompare(b.id ?? "");
  });

  const lines = [
    `${filtered.length} model(s) available${filter !== "all" ? ` (filter: ${filter})` : ""}:`,
    "",
  ];

  for (const m of filtered) {
    const id = m.id ?? "unknown";
    const type = isImageModel(id) ? "image" : "chat";
    const isDefaultChat  = id === CHAT_MODEL;
    const isDefaultImage = id === IMAGE_MODEL;
    const defaultTag = isDefaultChat
      ? " ← current default (chat)"
      : isDefaultImage
        ? " ← current default (image)"
        : "";
    lines.push(`  ${id}  [${type}]${defaultTag}`);
  }

  lines.push("");
  lines.push(`To change the default: set GROK_CHAT_MODEL or GROK_IMAGE_MODEL env vars.`);
  lines.push(`To use once: pass model="<id>" to ask_grok or generate_image.`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

const toolHandlers = {
  ask_grok:       handleAskGrok,
  generate_image: handleGenerateImage,
  list_models:    handleListModels,
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
  // Exponential backoff: base, 2×base, 4×base, …
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
