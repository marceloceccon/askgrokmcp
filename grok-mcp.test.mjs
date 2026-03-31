import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";

// Set NODE_TEST before importing so the server doesn't start.
process.env.NODE_TEST = "1";

const {
  safeWrite,
  buildFilePath,
  handleAskGrok,
  handleGenerateImage,
  handleListModels,
  toolHandlers,
  WRITE_BASE_DIR,
  MAX_PROMPT_LENGTH,
} = await import("./grok-mcp.mjs");

// ---------------------------------------------------------------------------
// safeWrite — path traversal protection
// ---------------------------------------------------------------------------

describe("safeWrite", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "grok-test-"));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a file inside the allowed base directory", async () => {
    const dest = join(WRITE_BASE_DIR, "test-output", "hello.txt");
    await safeWrite(dest, "hello");
    const content = await readFile(dest, "utf8");
    assert.equal(content, "hello");
    // cleanup
    await rm(join(WRITE_BASE_DIR, "test-output"), { recursive: true, force: true });
  });

  it("rejects paths that escape the base directory via ..", async () => {
    const dest = resolve(WRITE_BASE_DIR, "..", "escaped.txt");
    await assert.rejects(() => safeWrite(dest, "bad"), {
      message: /outside the allowed write directory/,
    });
  });

  it("rejects absolute paths outside the base directory", async () => {
    const dest = "/tmp/should-not-be-written.txt";
    // Only rejects if /tmp is outside WRITE_BASE_DIR (which it normally is)
    if (!WRITE_BASE_DIR.startsWith("/tmp")) {
      await assert.rejects(() => safeWrite(dest, "bad"), {
        message: /outside the allowed write directory/,
      });
    }
  });

  it("creates parent directories as needed", async () => {
    const dest = join(WRITE_BASE_DIR, "deep", "nested", "dir", "file.txt");
    await safeWrite(dest, "nested");
    const content = await readFile(dest, "utf8");
    assert.equal(content, "nested");
    await rm(join(WRITE_BASE_DIR, "deep"), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// buildFilePath — numbered file paths for multi-image generation
// ---------------------------------------------------------------------------

describe("buildFilePath", () => {
  it("returns the path unchanged for a single image", () => {
    const result = buildFilePath("images/cat.png", 0, 1);
    assert.equal(result, resolve("images/cat.png"));
  });

  it("inserts index before extension for multiple images", () => {
    const result = buildFilePath("images/cat.png", 0, 3);
    assert.equal(result, resolve("images/cat-1.png"));
  });

  it("inserts index for second image", () => {
    const result = buildFilePath("images/cat.png", 2, 3);
    assert.equal(result, resolve("images/cat-3.png"));
  });

  it("appends index when there is no extension", () => {
    const result = buildFilePath("images/cat", 0, 2);
    assert.equal(result, resolve("images/cat-1"));
  });
});

// ---------------------------------------------------------------------------
// handleAskGrok — input validation
// ---------------------------------------------------------------------------

describe("handleAskGrok input validation", () => {
  it("rejects missing prompt", async () => {
    await assert.rejects(() => handleAskGrok({}), {
      message: /prompt.*must be a non-empty string/,
    });
  });

  it("rejects empty prompt", async () => {
    await assert.rejects(() => handleAskGrok({ prompt: "   " }), {
      message: /prompt.*must be a non-empty string/,
    });
  });

  it("rejects null args", async () => {
    await assert.rejects(() => handleAskGrok(null), {
      message: /prompt.*must be a non-empty string/,
    });
  });

  it("rejects prompt exceeding max length", async () => {
    const longPrompt = "x".repeat(MAX_PROMPT_LENGTH + 1);
    await assert.rejects(() => handleAskGrok({ prompt: longPrompt }), {
      message: /Prompt too long/,
    });
  });
});

// ---------------------------------------------------------------------------
// handleGenerateImage — input validation
// ---------------------------------------------------------------------------

describe("handleGenerateImage input validation", () => {
  it("rejects missing prompt", async () => {
    await assert.rejects(
      () => handleGenerateImage({ file_path: "out.png" }),
      { message: /prompt.*must be a non-empty string/ },
    );
  });

  it("rejects missing file_path", async () => {
    await assert.rejects(
      () => handleGenerateImage({ prompt: "a cat" }),
      { message: /file_path.*must be a non-empty string/ },
    );
  });

  it("rejects non-integer n", async () => {
    await assert.rejects(
      () => handleGenerateImage({ prompt: "a cat", file_path: "out.png", n: 1.5 }),
      { message: /n.*must be a positive integer/ },
    );
  });

  it("rejects n < 1", async () => {
    await assert.rejects(
      () => handleGenerateImage({ prompt: "a cat", file_path: "out.png", n: 0 }),
      { message: /n.*must be a positive integer/ },
    );
  });

  it("rejects prompt exceeding max length", async () => {
    const longPrompt = "x".repeat(MAX_PROMPT_LENGTH + 1);
    await assert.rejects(
      () => handleGenerateImage({ prompt: longPrompt, file_path: "out.png" }),
      { message: /Prompt too long/ },
    );
  });
});

// ---------------------------------------------------------------------------
// handleListModels — input validation
// ---------------------------------------------------------------------------

describe("handleListModels input validation", () => {
  it("rejects invalid filter value", async () => {
    await assert.rejects(() => handleListModels({ filter: "invalid" }), {
      message: /filter.*must be.*all.*chat.*image/,
    });
  });
});

// ---------------------------------------------------------------------------
// toolHandlers — routing
// ---------------------------------------------------------------------------

describe("toolHandlers", () => {
  it("maps ask_grok to a function", () => {
    assert.equal(typeof toolHandlers.ask_grok, "function");
  });

  it("maps generate_image to a function", () => {
    assert.equal(typeof toolHandlers.generate_image, "function");
  });

  it("maps list_models to a function", () => {
    assert.equal(typeof toolHandlers.list_models, "function");
  });

  it("has exactly 3 handlers", () => {
    assert.equal(Object.keys(toolHandlers).length, 3);
  });
});

// ---------------------------------------------------------------------------
// MAX_PROMPT_LENGTH — sanity check
// ---------------------------------------------------------------------------

describe("MAX_PROMPT_LENGTH", () => {
  it("is a positive number", () => {
    assert.equal(typeof MAX_PROMPT_LENGTH, "number");
    assert.ok(MAX_PROMPT_LENGTH > 0);
  });

  it("is 128000", () => {
    assert.equal(MAX_PROMPT_LENGTH, 128_000);
  });
});
