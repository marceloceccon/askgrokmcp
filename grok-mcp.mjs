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

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
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
            "Absolute path where the image file should be saved (e.g. /tmp/background-001.png)",
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
 * Makes an authenticated request to the xAI API.
 *
 * @param {string} endpoint - API path relative to the base URL (e.g. "/chat/completions").
 * @param {object} body     - JSON-serializable request body.
 * @returns {Promise<object>} Parsed JSON response.
 * @throws {Error} On non-2xx responses, includes status code and error body.
 */
async function xaiRequest(endpoint, body) {
  const res = await fetch(`${XAI_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`xAI API error ${res.status}: ${errorBody}`);
  }

  return res.json();
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
  const data = await xaiRequest("/chat/completions", {
    model: CHAT_MODEL,
    messages: [{ role: "user", content: args.prompt }],
  });

  const text = data.choices?.[0]?.message?.content ?? "No response";
  return { content: [{ type: "text", text }] };
}

/**
 * Generates images via Grok's Aurora model, downloads them, and saves to disk.
 */
async function handleGenerateImage(args) {
  const n = Math.min(Math.max(args.n ?? 1, 1), MAX_IMAGE_VARIATIONS);

  const data = await xaiRequest("/images/generations", {
    model: IMAGE_MODEL,
    prompt: args.prompt,
    n,
  });

  const saved = [];
  for (let i = 0; i < data.data.length; i++) {
    const buffer = await downloadBuffer(data.data[i].url);
    const dest = buildFilePath(args.file_path, i, data.data.length);
    await writeFile(dest, buffer);
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
  { name: "grok", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const handler = toolHandlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(request.params.arguments);
});

const transport = new StdioServerTransport();
await server.connect(transport);
