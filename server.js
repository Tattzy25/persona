// server.js
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Search } from "@upstash/search";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
const HTML_FILE = path.join(__dirname, "index.html");

const client = Search.fromEnv();
const index = client.index(process.env.UPSTASH_INDEX_NAME);

class RetryableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "RetryableError";
    this.status = 500;
    this.details = details;
  }
}

class FatalError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "FatalError";
    this.status = 400;
    this.details = details;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(base) {
  return Math.floor(base / 2 + (Math.random() * base) / 2);
}

function isRetryableUpstashError(error) {
  const status = Number(
    error?.status || error?.response?.status || error?.cause?.status || 0,
  );

  const code = String(error?.code || error?.cause?.code || "");

  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  if (
    [
      "ETIMEDOUT",
      "ECONNRESET",
      "EAI_AGAIN",
      "ENOTFOUND",
      "UND_ERR_CONNECT_TIMEOUT",
    ].includes(code)
  )
    return true;

  const msg = String(error?.message || "").toLowerCase();
  if (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("tempor") ||
    msg.includes("network")
  ) {
    return true;
  }

  return false;
}

async function withRetry(operationName, fn, options = {}) {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelay = options.baseDelay ?? 500;
  const maxDelay = options.maxDelay ?? 5000;
  const startedAt = new Date().toISOString();

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStartedAt = new Date().toISOString();

    try {
      return await fn({
        operationName,
        attempt,
        maxAttempts,
        startedAt,
        attemptStartedAt,
      });
    } catch (error) {
      lastError = error;

      if (error instanceof FatalError) {
        throw error;
      }

      const retryable =
        error instanceof RetryableError || isRetryableUpstashError(error);

      if (!retryable || attempt === maxAttempts) {
        throw new RetryableError(
          `${operationName} failed after ${attempt} attempt(s)`,
          {
            attempt,
            maxAttempts,
            startedAt,
            attemptStartedAt,
            cause: {
              name: error?.name,
              message: error?.message,
              status: error?.status || error?.response?.status || null,
              code: error?.code || null,
            },
          },
        );
      }

      const rawDelay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
      const delay = jitter(rawDelay);

      console.error(
        JSON.stringify({
          level: "warn",
          type: "retry",
          operationName,
          attempt,
          maxAttempts,
          delay,
          startedAt,
          attemptStartedAt,
          error: {
            name: error?.name,
            message: error?.message,
            status: error?.status || error?.response?.status || null,
            code: error?.code || null,
          },
        }),
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
  });
  res.end(html);
}

async function parseJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) return {};

  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(raw);
  } catch {
    throw new FatalError("Invalid JSON body");
  }
}

function normalizeItem(item) {
  return {
    id: item?.id ?? "",
    label: item?.content?.label ?? item?.content?.title ?? "",
    description:
      item?.content?.description ?? item?.metadata?.seoDescription ?? "",
    persona: item?.metadata?.persona ?? item?.metadata?.prompt ?? "",
  };
}

async function handleSearch(req, res) {
  const body = await parseJsonBody(req);

  const query = typeof body.query === "string" ? body.query : "";
  const limit = Number(body.limit ?? 50);
  const offset = Number(body.offset ?? 0);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new FatalError("limit must be an integer between 1 and 100");
  }

  if (!Number.isInteger(offset) || offset < 0) {
    throw new FatalError("offset must be an integer >= 0");
  }

  const results = await withRetry("search_personas", async (context) => {
    try {
      const data = await index.search({
        query,
        limit: offset + limit,
      });

      return { data, context };
    } catch (error) {
      if (isRetryableUpstashError(error)) {
        throw new RetryableError("Temporary search failure", {
          ...context,
          cause: error?.message,
        });
      }

      throw new FatalError("Search request failed", {
        ...context,
        cause: error?.message,
      });
    }
  });

  const rawItems = Array.isArray(results.data) ? results.data : [];
  const sliced = rawItems.slice(offset, offset + limit).map(normalizeItem);

  return sendJson(res, 200, {
    items: sliced,
    pagination: {
      offset,
      limit,
      returned: sliced.length,
      nextOffset: offset + sliced.length,
      hasMore: rawItems.length > offset + sliced.length,
    },
    retryContext: results.context,
  });
}

async function handleById(req, res) {
  const body = await parseJsonBody(req);
  const id = typeof body.id === "string" ? body.id.trim() : "";

  if (!id) {
    throw new FatalError("id is required");
  }

  const result = await withRetry("fetch_persona_by_id", async (context) => {
    try {
      const data = await index.search({
        query: id,
        limit: 25,
      });

      const items = Array.isArray(data) ? data : [];
      const exact = items.find((item) => item?.id === id);

      if (!exact) {
        throw new FatalError("Persona not found", { ...context, id });
      }

      return { data: normalizeItem(exact), context };
    } catch (error) {
      if (error instanceof FatalError) {
        throw error;
      }

      if (isRetryableUpstashError(error)) {
        throw new RetryableError("Temporary lookup failure", {
          ...context,
          id,
          cause: error?.message,
        });
      }

      throw new FatalError("Lookup request failed", {
        ...context,
        id,
        cause: error?.message,
      });
    }
  });

  return sendJson(res, 200, {
    item: result.data,
    retryContext: result.context,
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }

    if (req.method === "GET" && req.url === "/") {
      const html = await fs.readFile(HTML_FILE, "utf8");
      return sendHtml(res, html);
    }

    if (req.method === "POST" && req.url === "/api/personas/search") {
      return await handleSearch(req, res);
    }

    if (req.method === "POST" && req.url === "/api/personas/by-id") {
      return await handleById(req, res);
    }

    return sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    const status = error instanceof FatalError ? 400 : 500;

    console.error(
      JSON.stringify({
        level: "error",
        type: error?.name || "Error",
        status,
        message: error?.message || "Unknown error",
        details: error?.details || null,
      }),
    );

    return sendJson(res, status, {
      error: error?.message || "Server error",
      type: error?.name || "Error",
      details: error?.details || null,
    });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
