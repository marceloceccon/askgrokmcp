/**
 * Tool definitions and handlers for the Grok MCP Server.
 *
 * This module owns all MCP tool schemas and their implementation.
 * The main server module provides the HTTP client and configuration.
 */

// -- Consensus Validation Protocol -------------------------------------------

const CVP_SYSTEM_PROMPT =
  "You are participating in a Consensus Validation Protocol (CVP). " +
  "Your role is to provide rigorous, evidence-based analysis through multiple rounds " +
  "of iterative refinement. Be thorough but concise. Avoid repetition — each round " +
  "must meaningfully advance the analysis. Stay objective and acknowledge uncertainty.";

/**
 * Returns the user prompt for a given CVP round.
 *
 * @param {string} topic  - The topic under analysis.
 * @param {number} round  - Current round (1-based).
 * @param {number} total  - Total number of rounds.
 * @returns {string}
 */
function cvpRoundPrompt(topic, round, total) {
  if (round === 1) {
    return (
      `Round ${round}/${total} — Initial Analysis\n\n` +
      `Analyze the following topic thoroughly and objectively. Identify the key claims, ` +
      `supporting evidence, areas of genuine uncertainty, and any common misconceptions.\n\n` +
      `Topic: ${topic}`
    );
  }
  if (round === total) {
    return (
      `Round ${round}/${total} — Final Synthesis\n\n` +
      `Synthesize your full multi-round analysis into a coherent, balanced conclusion. ` +
      `Clearly state: (1) points of strong consensus, (2) remaining uncertainties, and ` +
      `(3) your confidence level for each major conclusion. Be definitive where the evidence supports it.`
    );
  }

  // Intermediate rounds cycle through deepening strategies
  const strategies = [
    `Round ${round}/${total} — Counterarguments & Critique\n\n` +
      `Critically examine your previous analysis. What are the strongest counterarguments? ` +
      `Where might you be wrong or overconfident? What evidence supports alternative viewpoints?`,
    `Round ${round}/${total} — Evidence Assessment\n\n` +
      `Assess the quality and strength of evidence on all sides. Distinguish between what is ` +
      `well-established, what is probable, and what remains genuinely uncertain or contested.`,
    `Round ${round}/${total} — Perspectives & Edge Cases\n\n` +
      `Consider perspectives you have not yet explored. What would domain experts disagree on? ` +
      `Are there edge cases, regional differences, or temporal factors that affect the analysis?`,
  ];
  return strategies[(round - 2) % strategies.length];
}

/**
 * Formats the final CVP output as structured Markdown.
 */
function formatConsensusResult(topic, rounds, roundResults, model) {
  const lines = [
    `## Consensus Validation Protocol — Results`,
    ``,
    `| Field | Value |`,
    `|-------|-------|`,
    `| **Topic** | ${topic} |`,
    `| **Rounds completed** | ${rounds} |`,
    `| **Model** | ${model} |`,
    ``,
  ];

  for (const r of roundResults) {
    lines.push(`### Round ${r.round}`);
    lines.push(``);
    lines.push(r.content);
    lines.push(``);
  }

  return lines.join("\n");
}

// -- Tool definitions --------------------------------------------------------

/**
 * Returns the MCP tool schema array. Called on each ListTools request
 * so descriptions always reflect the current resolved model names.
 *
 * @param {{ chatModel: string, imageModel: string }} config
 * @returns {Array<object>}
 */
export function getToolDefinitions({ chatModel, imageModel }) {
  return [
    {
      name: "ask_grok",
      description:
        "Ask Grok a question and get a response. " +
        `Default model: ${chatModel}. ` +
        "Supports system prompts and sampling parameters (temperature, max_tokens, top_p). " +
        "Run list_models to see all available model options.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "The question or prompt to send to Grok",
          },
          system_prompt: {
            type: "string",
            description:
              "Optional system prompt to set Grok's behavior and persona for this request.",
          },
          model: {
            type: "string",
            description:
              `Chat model to use for this request. Defaults to "${chatModel}". ` +
              "Use list_models to see available chat models.",
          },
          temperature: {
            type: "number",
            description:
              "Sampling temperature (0-2). Lower values make output more deterministic. Default: model-dependent.",
          },
          max_tokens: {
            type: "number",
            description:
              "Maximum number of tokens to generate in the response.",
          },
          top_p: {
            type: "number",
            description:
              "Nucleus sampling: only consider tokens with cumulative probability up to this value (0-1).",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "generate_image",
      description:
        "Generate an image using Grok's Aurora image model and save it to a local file. " +
        `Default model: ${imageModel}. ` +
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
              `Image model to use for this request. Defaults to "${imageModel}". ` +
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
    {
      name: "grok_consensus",
      description:
        "Runs a full iterative Consensus Validation Protocol (CVP) between Claude and Grok. " +
        "Returns a structured final summary. Default 3-5 rounds. " +
        "Supports custom round count via the 'rounds' argument.",
      inputSchema: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "The topic, claim, or question to analyze through the consensus protocol.",
          },
          rounds: {
            type: "number",
            description:
              "Number of analysis rounds to run. Omit for the default (3 rounds). " +
              "Higher values (up to 10) yield deeper analysis at the cost of latency.",
          },
        },
        required: ["topic"],
      },
    },
  ];
}

// -- Tool handlers -----------------------------------------------------------

/**
 * Creates tool handler functions bound to the provided server context.
 *
 * @param {object} ctx
 * @param {Function} ctx.xaiPost  - Authenticated POST to xAI API.
 * @param {Function} ctx.xaiGet   - Authenticated GET from xAI API.
 * @param {Function} ctx.safeWrite - Safe file writer.
 * @param {Function} ctx.buildFilePath - Multi-image path builder.
 * @param {Function} ctx.downloadBuffer - URL downloader.
 * @param {Function} ctx.resolve - path.resolve.
 * @param {object}   ctx.config  - Mutable config object with chatModel, imageModel, etc.
 * @returns {Record<string, Function>}
 */
export function createToolHandlers(ctx) {
  const {
    xaiPost,
    xaiGet,
    safeWrite,
    buildFilePath,
    downloadBuffer,
    resolve,
    config,
  } = ctx;

  // -- ask_grok --------------------------------------------------------------

  async function handleAskGrok(args) {
    if (!args || typeof args.prompt !== "string" || !args.prompt.trim()) {
      throw new Error("Invalid arguments: 'prompt' must be a non-empty string");
    }
    if (args.prompt.length > config.maxPromptLength) {
      throw new Error(
        `Prompt too long: ${args.prompt.length} chars exceeds the ${config.maxPromptLength} char limit`,
      );
    }

    const model =
      typeof args.model === "string" && args.model.trim()
        ? args.model.trim()
        : config.chatModel;

    const messages = [];
    if (typeof args.system_prompt === "string" && args.system_prompt.trim()) {
      messages.push({ role: "system", content: args.system_prompt });
    }
    messages.push({ role: "user", content: args.prompt });

    const requestBody = { model, messages };
    if (typeof args.temperature === "number") requestBody.temperature = args.temperature;
    if (typeof args.max_tokens === "number") requestBody.max_tokens = args.max_tokens;
    if (typeof args.top_p === "number") requestBody.top_p = args.top_p;

    const data = await xaiPost("/chat/completions", requestBody);

    const messageContent = data?.choices?.[0]?.message?.content;
    const text =
      typeof messageContent === "string"
        ? messageContent
        : messageContent != null
          ? JSON.stringify(messageContent)
          : "No response";
    return { content: [{ type: "text", text }] };
  }

  // -- generate_image --------------------------------------------------------

  async function handleGenerateImage(args) {
    if (!args || typeof args.prompt !== "string" || !args.prompt.trim()) {
      throw new Error("Invalid arguments: 'prompt' must be a non-empty string");
    }
    if (args.prompt.length > config.maxPromptLength) {
      throw new Error(
        `Prompt too long: ${args.prompt.length} chars exceeds the ${config.maxPromptLength} char limit`,
      );
    }
    if (typeof args.file_path !== "string" || !args.file_path.trim()) {
      throw new Error("Invalid arguments: 'file_path' must be a non-empty string");
    }
    if (args.n != null && (!Number.isInteger(args.n) || args.n < 1)) {
      throw new Error("Invalid arguments: 'n' must be a positive integer");
    }

    const n = Math.min(Math.max(args.n ?? 1, 1), config.maxImageVariations);
    const model =
      typeof args.model === "string" && args.model.trim()
        ? args.model.trim()
        : config.imageModel;

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

  // -- list_models -----------------------------------------------------------

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

    const isImageModel = (id) => /image|imagine|aurora/i.test(id);

    const filtered = models.filter((m) => {
      if (filter === "all") return true;
      const isImg = isImageModel(m.id ?? "");
      return filter === "image" ? isImg : !isImg;
    });

    if (filtered.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No ${filter} models found. Try filter: "all" to see everything.`,
          },
        ],
      };
    }

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
      const isDefaultChat = id === config.chatModel;
      const isDefaultImage = id === config.imageModel;
      const defaultTag = isDefaultChat
        ? " <- current default (chat)"
        : isDefaultImage
          ? " <- current default (image)"
          : "";
      lines.push(`  ${id}  [${type}]${defaultTag}`);
    }

    lines.push("");
    lines.push(`To change the default: set GROK_CHAT_MODEL or GROK_IMAGE_MODEL env vars.`);
    lines.push(`To use once: pass model="<id>" to ask_grok or generate_image.`);

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // -- grok_consensus --------------------------------------------------------

  const CVP_DEFAULT_ROUNDS = 3;
  const CVP_MAX_ROUNDS = 10;

  async function handleGrokConsensus(args) {
    if (!args || typeof args.topic !== "string" || !args.topic.trim()) {
      throw new Error("Invalid arguments: 'topic' must be a non-empty string");
    }
    if (args.topic.length > config.maxPromptLength) {
      throw new Error(
        `Topic too long: ${args.topic.length} chars exceeds the ${config.maxPromptLength} char limit`,
      );
    }
    if (
      args.rounds != null &&
      (!Number.isInteger(args.rounds) || args.rounds < 1 || args.rounds > CVP_MAX_ROUNDS)
    ) {
      throw new Error(
        `Invalid arguments: 'rounds' must be an integer between 1 and ${CVP_MAX_ROUNDS}`,
      );
    }

    const topic = args.topic.trim();
    const numRounds = args.rounds ?? CVP_DEFAULT_ROUNDS;
    const model = config.chatModel;

    // Build conversation incrementally — Grok sees the full history each round.
    const messages = [{ role: "system", content: CVP_SYSTEM_PROMPT }];

    const roundResults = [];

    for (let round = 1; round <= numRounds; round++) {
      const userPrompt = cvpRoundPrompt(topic, round, numRounds);
      messages.push({ role: "user", content: userPrompt });

      const data = await xaiPost("/chat/completions", {
        model,
        messages,
        temperature: 0.7,
      });

      const content = data?.choices?.[0]?.message?.content ?? "No response";
      messages.push({ role: "assistant", content });
      roundResults.push({ round, content });
    }

    const text = formatConsensusResult(topic, numRounds, roundResults, model);
    return { content: [{ type: "text", text }] };
  }

  // -- Handler map -----------------------------------------------------------

  return {
    ask_grok: handleAskGrok,
    generate_image: handleGenerateImage,
    list_models: handleListModels,
    grok_consensus: handleGrokConsensus,
  };
}
