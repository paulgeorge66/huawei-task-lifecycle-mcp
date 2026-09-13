#!/usr/bin/env node

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");

async function loadTypeScript(relativePath, transform = (source) => source) {
  const source = transform(await readFile(resolve(root, relativePath), "utf8"));
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function fakeZod() {
  return `
const schemaChain = new Proxy(function () {}, {
  get: () => (..._args) => schemaChain,
  apply: () => schemaChain,
});
const z = new Proxy({}, { get: () => (..._args) => schemaChain });`;
}

async function testHuaweiIdentityAndResponses() {
  const module = await loadTypeScript("src/push.ts", (source) =>
    source.replace('import { z } from "zod";', fakeZod()).replace(
      'import { cardIdFor, providerMessageIdFor } from "./identity";',
      `const sha256Hex = async (value) => {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
          return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        };
        const cardIdFor = async (agentId, taskId) =>
          "task:" + (await sha256Hex(agentId + "\\0" + taskId)).slice(0, 48);
        const providerMessageIdFor = async (agentId, eventId) =>
          "evt:" + (await sha256Hex(agentId + "\\0" + eventId)).slice(0, 48);`,
    ),
  );
  const env = {
    HUAWEI_AUTH_CODE: "test-auth",
    HUAWEI_PUSH_URL: "https://example.invalid/push",
  };
  const event = {
    id: "event-a",
    taskId: "task-a",
    agentId: "agent-a",
    title: "Title",
    summary: "Summary",
    content: "Body",
    result: "Done",
    source: "Test",
    eventAt: 1_800_000_000,
    finishedAt: 1_800_000_001,
  };
  const payloads = [];
  globalThis.fetch = async (_url, init) => {
    payloads.push(JSON.parse(init.body));
    return Response.json({ code: "0000000000", description: "ok" });
  };

  await module.pushEventToHuawei(env, event);
  await module.pushEventToHuawei(env, { ...event, id: "event-b", content: "Body 2" });
  await module.pushEventToHuawei(env, event);
  const [first, second, retry] = payloads.map((payload) => payload.data.msgContent[0]);
  assert.equal(first.scheduleTaskId, second.scheduleTaskId, "same task must update one card");
  assert.notEqual(first.msgId, second.msgId, "different events need different message IDs");
  assert.equal(first.msgId, retry.msgId, "an event retry must preserve its message ID");
  assert.notEqual(first.scheduleTaskId, first.msgId, "card and event identities must be separate");

  globalThis.fetch = async () => Response.json({});
  await assert.rejects(
    module.pushEventToHuawei(env, event),
    (error) => error instanceof module.HuaweiPushError && error.retryable && error.code === null,
  );

  globalThis.fetch = async () => Response.json({ code: "0200100004", description: "invalid" });
  await assert.rejects(
    module.pushEventToHuawei(env, event),
    (error) => error instanceof module.HuaweiPushError && !error.retryable,
  );

  globalThis.fetch = async () => new Response("gateway timeout", { status: 503 });
  await assert.rejects(
    module.pushEventToHuawei(env, event),
    (error) => error instanceof module.HuaweiPushError && error.retryable,
  );
}

async function testPurePolicies() {
  const queues = await loadTypeScript("src/queue-role.ts");
  const names = { delivery: "delivery-prod", deadLetter: "dead-prod" };
  assert.equal(queues.deliveryQueueRole("delivery-prod", names), "delivery");
  assert.equal(queues.deliveryQueueRole("dead-prod", names), "dead-letter");
  assert.equal(queues.deliveryQueueRole("typo", names), "unknown");

  const hook = await loadTypeScript("src/codex-hook.ts");
  assert.deepEqual(hook.codexHookProjection(null), { state: "completed", result: "任务已完成" });
  assert.deepEqual(hook.codexHookProjection({ state: "progress", progress: 63 }), {
    state: "progress",
    progress: 63,
    result: "本轮已结束（任务仍进行中）",
  });
  assert.equal(hook.codexHookProjection({ state: "failed", progress: null }).state, "failed");
  assert.equal(hook.codexHookProjection({ state: "canceled", progress: null }).state, "canceled");

  const policy = await loadTypeScript("src/submission-policy.ts");
  assert.doesNotThrow(() => policy.assertSubmissionAllowed(true, false));
  assert.throws(() => policy.assertSubmissionAllowed(false, false), /disabled/u);
  assert.throws(() => policy.assertSubmissionAllowed(true, true), /administrator/u);
}

async function testQueueConfigAlignment() {
  const configNames = ["wrangler.example.jsonc"];
  try {
    await access(resolve(root, "wrangler.jsonc"));
    configNames.push("wrangler.jsonc");
  } catch {
    // A clean clone intentionally contains only the de-personalized example.
  }
  for (const name of configNames) {
    const raw = await readFile(resolve(root, name), "utf8");
    const parsed = ts.parseConfigFileTextToJson(name, raw);
    assert.equal(parsed.error, undefined, `${name} must be valid JSONC`);
    const config = parsed.config;
    assert.equal(config.vars.DELIVERY_QUEUE_NAME, config.queues.producers[0].queue);
    assert.equal(config.vars.DELIVERY_QUEUE_NAME, config.queues.consumers[0].queue);
    assert.equal(config.vars.DEAD_LETTER_QUEUE_NAME, config.queues.consumers[1].queue);
    assert.equal(config.vars.DEAD_LETTER_QUEUE_NAME, config.queues.consumers[0].dead_letter_queue);
    assert.equal(config.vars.V3_SHADOW_WRITE, "true");
    assert.ok(["true", "false"].includes(config.vars.V3_DELIVERY));
    assert.deepEqual(config.triggers.crons, ["* * * * *"]);
    if (name === "wrangler.example.jsonc") assert.equal(config.vars.V3_DELIVERY, "false");
  }

  const migration = await readFile(resolve(root, "migrations/0001_task_platform.sql"), "utf8");
  assert.match(migration, /notify_started INTEGER NOT NULL DEFAULT 0/u);
  assert.match(migration, /notify_progress INTEGER NOT NULL DEFAULT 0/u);
  assert.match(migration, /notify_completed INTEGER NOT NULL DEFAULT 1/u);
  assert.match(migration, /notify_failed INTEGER NOT NULL DEFAULT 1/u);
  assert.match(migration, /notify_canceled INTEGER NOT NULL DEFAULT 1/u);

  const shadowMigration = await readFile(resolve(root, "migrations/0002_v3_shadow.sql"), "utf8");
  for (const table of [
    "agents_v3",
    "credentials",
    "client_instances",
    "tasks_v3",
    "task_runs",
    "events_v3",
    "card_projections",
    "outbox",
    "card_delivery_state",
    "delivery_attempts_v3",
  ]) {
    assert.match(shadowMigration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, "u"));
  }
  const deliveryMigration = await readFile(
    resolve(root, "migrations/0003_v3_delivery.sql"),
    "utf8",
  );
  assert.match(deliveryMigration, /delivery_mode/u);
  assert.match(deliveryMigration, /enqueued_at/u);
}

async function testVersionConsistency() {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  const version = await loadTypeScript("src/version.ts");
  assert.equal(version.SERVICE_VERSION, packageJson.version);
}

await testHuaweiIdentityAndResponses();
await testPurePolicies();
await testQueueConfigAlignment();
await testVersionConsistency();
console.log("PASS: Huawei identity, response, queue, Hook, and submission contracts");
