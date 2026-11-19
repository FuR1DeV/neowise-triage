import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp, AI_TIMEOUT_MS } from "../server.mjs";

const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };
const silentLogger = { warn() {}, error() {} };

// Поднимает сервер на свободном порту (port 0) и возвращает его адрес.
async function startServer(options = {}) {
  const server = createApp({ logger: silentLogger, ...options });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, url: `http://127.0.0.1:${server.address().port}/api/triage` };
}

function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

let app;
before(async () => {
  app = await startServer();
});
after(() => app.server.close());

test("обычный текст: ready с темой и черновиком", async () => {
  const reply = await post(app.url, { text: "Когда будет доставка заказа?" });
  assert.equal(reply.status, 200);
  const data = await reply.json();
  assert.deepEqual(Object.keys(data).sort(), ["draft", "status", "topic"]);
  assert.equal(data.status, "ready");
  assert.equal(data.topic, "delivery");
  assert.ok(data.draft.trim().length > 0);
});

for (const label of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой модели ${label}: manual_review`, async () => {
    const reply = await post(app.url, { text: `Сколько стоит доставка? ${label}` });
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), MANUAL_REVIEW);
  });
}

test("таймаут: ответ приходит примерно через 300 мс, а не через 1,2 с", async () => {
  const startedAt = performance.now();
  const reply = await post(app.url, { text: "Нужна консультация [timeout]" });
  const elapsed = performance.now() - startedAt;
  assert.deepEqual(await reply.json(), MANUAL_REVIEW);
  assert.ok(elapsed >= AI_TIMEOUT_MS - 20, `слишком рано: ${elapsed} мс`);
  assert.ok(elapsed < AI_TIMEOUT_MS + 300, `слишком долго: ${elapsed} мс`);
});

test("модель игнорирует сигнал отмены: всё равно manual_review по таймауту", async () => {
  const hanging = await startServer({ classify: () => new Promise(() => {}) });
  try {
    const startedAt = performance.now();
    const reply = await post(hanging.url, { text: "Обычная заявка" });
    assert.deepEqual(await reply.json(), MANUAL_REVIEW);
    assert.ok(performance.now() - startedAt < AI_TIMEOUT_MS + 300);
  } finally {
    hanging.server.close();
  }
});

test("лишние поля из ответа модели не уходят клиенту", async () => {
  const chatty = await startServer({
    classify: async () => JSON.stringify({ topic: "other", draft: "Ответ", internal: "секрет" }),
  });
  try {
    const reply = await post(chatty.url, { text: "Вопрос" });
    assert.deepEqual(await reply.json(), { status: "ready", topic: "other", draft: "Ответ" });
  } finally {
    chatty.server.close();
  }
});

for (const value of [null, undefined]) {
  test(`модель отказала значением ${value}: manual_review, а не 500`, async () => {
    const broken = await startServer({ classify: () => Promise.reject(value) });
    try {
      const reply = await post(broken.url, { text: "Вопрос" });
      assert.equal(reply.status, 200);
      assert.deepEqual(await reply.json(), MANUAL_REVIEW);
    } finally {
      broken.server.close();
    }
  });
}

test("текст заявки не попадает в лог, даже если модель вернула его в ошибке", async () => {
  const lines = [];
  const logger = { warn: (line) => lines.push(line), error: (line) => lines.push(line) };
  const secret = "Паспорт 4510 123456";
  const leaky = await startServer({
    logger,
    classify: async (text) => {
      throw new Error(`provider rejected prompt: ${text}`);
    },
  });
  try {
    const reply = await post(leaky.url, { text: secret });
    assert.deepEqual(await reply.json(), MANUAL_REVIEW);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /reason=model_error/);
    assert.ok(!lines[0].includes(secret), lines[0]);
  } finally {
    leaky.server.close();
  }
});

const invalidBodies = {
  "пустое тело": "",
  "битый JSON": "{text:",
  "null": "null",
  "массив": "[]",
  "строка вместо объекта": '"Когда доставка?"',
  "нет поля text": {},
  "text пустой": { text: "" },
  "text из пробелов": { text: "  \n\t " },
  "text число": { text: 42 },
  "text null": { text: null },
};

for (const [name, body] of Object.entries(invalidBodies)) {
  test(`невалидный ввод (${name}): 400 invalid_input`, async () => {
    const reply = await post(app.url, body);
    assert.equal(reply.status, 400);
    assert.deepEqual(await reply.json(), { status: "invalid_input" });
  });
}
