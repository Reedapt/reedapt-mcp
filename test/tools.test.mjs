// Starts the built server over stdio against a fake Reedapt API and calls the tools.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const calls = [];
let api;
let client;

before(async () => {
  api = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.url.endsWith("/requests")) {
        res.end(JSON.stringify({ id: "run_1", dub_id: "job_1", status: "needs_input", request: "x", reply: "ok", created_at: "t" }));
      } else if (req.url.endsWith("/answer")) {
        res.end(JSON.stringify({ id: "run_1", dub_id: "job_1", status: "declined", request: "x", reply: "ok", created_at: "t" }));
      } else if (req.url.endsWith("/lines/edit")) {
        res.statusCode = 202;
        res.end(JSON.stringify({ dub_id: "job_1", lines: [3], status: "revoicing" }));
      } else if (req.url.endsWith("/lines")) {
        const lines = Array.from({ length: 150 }, (_, i) => ({ line: i, start_ms: i, end_ms: i + 1, original_text: "a", text: "b" }));
        res.end(JSON.stringify({ dub_id: "job_1", lines }));
      } else if (req.url.endsWith("/quality")) {
        res.end(JSON.stringify({ dub_id: "job_1", checked: true, listened: true, lines: 150, fixed: 1, to_review: 0, flagged: [] }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no", request_id: "req_t" } }));
      }
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      env: { ...process.env, REEDAPT_API_KEY: "rk_test_x", REEDAPT_BASE_URL: `http://127.0.0.1:${api.address().port}/v1` },
    }),
  );
});

after(async () => {
  await client.close();
  api.close();
});

const text = (result) => result.content[0].text;

test("the agent tools are listed, and dub_media takes instructions", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of ["get_quality", "ask_reedapt", "answer_run", "list_lines", "edit_lines"]) {
    assert.ok(names.includes(name), name);
  }
  const dub = tools.find((t) => t.name === "dub_media");
  assert.ok(dub.inputSchema.properties.instructions);
});

test("get_quality reads the report", async () => {
  const result = await client.callTool({ name: "get_quality", arguments: { dub_id: "job_1" } });
  assert.equal(JSON.parse(text(result)).fixed, 1);
  assert.equal(calls.at(-1).path, "/v1/dubs/job_1/quality");
});

test("ask_reedapt defaults to ask, and answer_run sends the choice", async () => {
  const asked = await client.callTool({ name: "ask_reedapt", arguments: { dub_id: "job_1", request: "Is line 3 natural?" } });
  assert.equal(JSON.parse(text(asked)).status, "needs_input");
  assert.deepEqual(calls.at(-1).body, { text: "Is line 3 natural?", autonomy: "ask" });
  const answered = await client.callTool({ name: "answer_run", arguments: { run_id: "run_1", choice: "decline" } });
  assert.equal(JSON.parse(text(answered)).status, "declined");
  assert.equal(calls.at(-1).path, "/v1/runs/run_1/answer");
  assert.deepEqual(calls.at(-1).body, { choice: "decline" });
});

test("list_lines pages, and edit_lines posts the edits", async () => {
  const first = JSON.parse(text(await client.callTool({ name: "list_lines", arguments: { dub_id: "job_1" } })));
  assert.equal(first.lines.length, 100);
  assert.equal(first.total_lines, 150);
  assert.equal(first.next_offset, 100);
  const second = JSON.parse(text(await client.callTool({ name: "list_lines", arguments: { dub_id: "job_1", offset: 100 } })));
  assert.equal(second.lines.length, 50);
  assert.equal(second.next_offset, null);
  const edited = await client.callTool({ name: "edit_lines", arguments: { dub_id: "job_1", lines: [{ line: 3, text: "Bonjour." }] } });
  assert.equal(JSON.parse(text(edited)).status, "revoicing");
  assert.deepEqual(calls.at(-1).body, { lines: [{ line: 3, text: "Bonjour." }] });
});

test("an API error comes back as a tool error with its code", async () => {
  const result = await client.callTool({ name: "get_dub", arguments: { dub_id: "nope" } });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(text(result)).error, "NOT_FOUND");
});
