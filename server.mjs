import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify as mockClassify } from "./mock-ai.mjs";

export const AI_TIMEOUT_MS = 300;
const TOPICS = new Set(["delivery", "pricing", "other"]);
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

const html = await readFile(new URL("./index.html", import.meta.url));

class AiTimeoutError extends Error {}

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Ввод менеджера: JSON-объект с непустым полем text. Строка из одних пробелов
// считается пустой. Возвращает текст или null, если ввод не подходит.
export function parseInput(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { text } = body;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

// Проверка результата AI. Ответ модели считается успехом, только если это
// JSON-объект с допустимой темой и непустым черновиком. Наружу отдаём только
// topic и draft, остальные поля модели отбрасываем.
export function validateModelOutput(raw) {
  if (typeof raw !== "string") return { ok: false, reason: "not_string" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "bad_json" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, reason: "not_object" };
  }
  if (!TOPICS.has(data.topic)) return { ok: false, reason: "bad_topic" };
  if (typeof data.draft !== "string" || data.draft.trim() === "") {
    return { ok: false, reason: "empty_draft" };
  }
  return { ok: true, topic: data.topic, draft: data.draft.trim() };
}

// Ждём модель не дольше timeoutMs. AbortController просит модель прерваться,
// а Promise.race страхует, если модель сигнал проигнорирует.
async function classifyWithTimeout(classify, text, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new AiTimeoutError(`AI did not answer in ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createApp({ classify = mockClassify, timeoutMs = AI_TIMEOUT_MS, logger = console } = {}) {
  async function handleTriage(request, response) {
    const text = parseInput(await readBody(request));
    if (text === null) return json(response, 400, { status: "invalid_input" });

    const startedAt = Date.now();
    let reason;
    try {
      const result = validateModelOutput(await classifyWithTimeout(classify, text, timeoutMs));
      if (result.ok) {
        return json(response, 200, { status: "ready", topic: result.topic, draft: result.draft });
      }
      reason = result.reason;
    } catch (error) {
      reason = error instanceof AiTimeoutError ? "timeout" : `model_error: ${error.message}`;
    }
    // В лог пишем причину и длину текста, но не сам текст заявки.
    logger.warn(
      `[triage] manual_review reason=${reason} elapsed_ms=${Date.now() - startedAt} text_length=${text.length}`,
    );
    return json(response, 200, MANUAL_REVIEW);
  }

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      await handleTriage(request, response);
    } catch (error) {
      logger.error(`[triage] server_error: ${error.message}`);
      json(response, 500, { status: "server_error" });
    }
  });
}

// Сервер слушает порт только при прямом запуске (node server.mjs), а тесты
// импортируют createApp и поднимают его сами на свободном порту.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Triage server: http://127.0.0.1:${port}`);
  });
}
