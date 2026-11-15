#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import Reedapt, { APIError } from "reedapt";
import { z } from "zod";
import { VERSION } from "./version.js";

// Long transcripts would flood the calling model's context, so they come back in pages.
const TRANSCRIPT_PAGE = 200;
const LINES_PAGE = 100;
// Clients give up on a tool call after a few minutes; waiting longer is the caller's loop.
const MAX_WAIT_SECONDS = 240;

let client: Reedapt | undefined;
function reedapt(): Reedapt {
  client ??= new Reedapt({ defaultHeaders: { "User-Agent": `reedapt-mcp/${VERSION}` } });
  return client;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    const text =
      err instanceof APIError
        ? JSON.stringify({ error: err.code, message: err.message, fields: err.fields, request_id: err.requestId })
        : `Error: ${err instanceof Error ? err.message : String(err)}`;
    return { content: [{ type: "text", text }], isError: true };
  }
}

const dubId = z.string().min(1).describe("The dub's id, such as dub_…");

const server = new McpServer({ name: "reedapt", version: VERSION });

server.registerTool(
  "list_languages",
  {
    title: "List languages",
    description: "The language codes Reedapt can dub into right now, for this API key's plan.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  () => run(() => reedapt().languages.list()),
);

server.registerTool(
  "get_usage",
  {
    title: "Get usage",
    description:
      "The account's plan, whether the key is live or test, and the minutes left. Check this before a long dub: a live dub uses one minute of the plan per minute of video, per language. Test keys are free and dub only the first seconds with a watermark.",
    inputSchema: {
      month: z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .optional()
        .describe("A month as YYYY-MM for that month's usage report, by key and language. Leave out for the current balance."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ month }) => run(() => (month ? reedapt().usage.report({ month }) : reedapt().usage.retrieve())),
);

server.registerTool(
  "dub_media",
  {
    title: "Dub a video or audio file",
    description:
      "Uploads a local file (an absolute path) or a public https link, and starts one dub per target language. Returns as soon as the dubs have started; dubbing takes minutes. Then call wait_for_dub or get_dub. Languages the plan can't dub into come back under `refused` with a reason. Live keys use plan minutes, so confirm the languages with the person first. Test keys dub only video files, and only the first 60 seconds.",
    inputSchema: {
      source: z.string().min(1).describe("An absolute path to a local video or audio file, or a public https:// link to one."),
      source_language: z.string().min(2).describe("The language spoken in the original, as a code such as en, fr or yo."),
      target_languages: z
        .array(z.string().min(2))
        .min(1)
        .describe("Codes from list_languages, such as [\"fr-FR\", \"es-ES\"]."),
      voice_cloning: z
        .boolean()
        .optional()
        .describe("Keep each speaker's own voice. Leave out for the account's default."),
      num_speakers: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("How many people speak, if known. Leave out to detect it."),
      instructions: z
        .string()
        .max(2000)
        .optional()
        .describe(
          "Notes for the dub, such as names to keep as they are, the tone, or how to address the audience. Followed on paid plans.",
        ),
      metadata: z
        .record(z.string(), z.string())
        .optional()
        .describe("Your own labels, returned on the dub and in webhooks."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  ({ source, ...params }) =>
    run(async () => {
      const isLink = /^https?:\/\//i.test(source);
      if (!isLink && !source.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(source)) {
        throw new Error("`source` must be an absolute path or an https:// link.");
      }
      return reedapt().dub(source, params);
    }),
);

server.registerTool(
  "get_dub",
  {
    title: "Get a dub",
    description: "A dub's status (queued, processing, completed or failed), its stage and progress, and the error if it failed.",
    inputSchema: { dub_id: dubId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ dub_id }) => run(() => reedapt().dubs.retrieve(dub_id)),
);

server.registerTool(
  "wait_for_dub",
  {
    title: "Wait for a dub",
    description: `Waits until a dub completes or fails, up to timeout_seconds (at most ${MAX_WAIT_SECONDS}). If it is still running, it returns the latest status: call it again to keep waiting.`,
    inputSchema: {
      dub_id: dubId,
      timeout_seconds: z.number().int().min(5).max(MAX_WAIT_SECONDS).default(MAX_WAIT_SECONDS),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ dub_id, timeout_seconds }) =>
    run(async () => {
      try {
        return await reedapt().dubs.waitUntilDone(dub_id, {
          timeout: timeout_seconds * 1000,
          pollInterval: 10_000,
        });
      } catch (err) {
        if (err instanceof APIError) throw err;
        return { still_running: true, dub: await reedapt().dubs.retrieve(dub_id) };
      }
    }),
);

server.registerTool(
  "list_dubs",
  {
    title: "List dubs",
    description: "The account's API dubs, newest first.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  (params) => run(() => reedapt().dubs.list(params)),
);

server.registerTool(
  "get_dub_files",
  {
    title: "Get a dub's files",
    description:
      "Download links for a completed dub: the dubbed video or audio, a WAV of the dubbed audio, and the separate voice and background tracks. Links expire at `expires_at`.",
    inputSchema: { dub_id: dubId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ dub_id }) => run(() => reedapt().dubs.files(dub_id)),
);

server.registerTool(
  "get_transcript",
  {
    title: "Get a dub's transcript",
    description: `A completed dub's lines in time order: speaker, original words and the dubbed words, with times in milliseconds. Returns ${TRANSCRIPT_PAGE} lines at a time; use offset for more.`,
    inputSchema: { dub_id: dubId, offset: z.number().int().min(0).default(0) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ dub_id, offset }) =>
    run(async () => {
      const t = await reedapt().dubs.transcript(dub_id);
      const lines = t.lines.slice(offset, offset + TRANSCRIPT_PAGE);
      return {
        ...t,
        lines,
        total_lines: t.lines.length,
        next_offset: offset + lines.length < t.lines.length ? offset + lines.length : null,
      };
    }),
);

server.registerTool(
  "get_subtitles",
  {
    title: "Get subtitles",
    description: "A completed dub's subtitles as SRT or WebVTT text, in the dub's language or the original's.",
    inputSchema: {
      dub_id: dubId,
      format: z.enum(["srt", "vtt"]).default("srt"),
      language: z.enum(["target", "source"]).default("target"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ dub_id, format, language }) => {
    const result = await run(() => reedapt().dubs.subtitles(dub_id, { format, language }));
    if (!result.isError) result.content[0].text = JSON.parse(result.content[0].text) as string;
    return result;
  },
);

server.registerTool(
  "get_quality",
  {
    title: "Get a dub's quality report",
    description:
      "Reedapt's check of a finished dub: how many lines it checked, which it flagged, which it fixed itself (shortened or voiced again) and how many are left for a person to review. `checked` is false until the check has run, a few minutes after the dub completes. Read this before handing a dub over, and tell the person which lines to review.",
    inputSchema: { dub_id: dubId },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ dub_id }) => run(() => reedapt().dubs.quality(dub_id)),
);

server.registerTool(
  "ask_reedapt",
  {
    title: "Ask Reedapt for a change",
    description:
      "Hands Reedapt a request about a finished dub in plain words, such as \"Is line 3 natural?\" or \"Make the greeting warmer\". Early access: accounts that don't have it yet get NOT_AVAILABLE. With autonomy \"ask\" (the default) Reedapt answers, or proposes a change and waits: the returned run has status needs_input, a `proposal` and `options`. Show the person the proposal and call answer_run with their choice. With \"decide\" Reedapt applies changes itself, so use it only when the person said to. Each request counts against the plan's allowance.",
    inputSchema: {
      dub_id: dubId,
      request: z.string().min(1).max(2000).describe("The request, in plain words. Say which lines (by number) when you can."),
      autonomy: z.enum(["ask", "decide"]).default("ask"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  ({ dub_id, request, autonomy }) => run(() => reedapt().dubs.requests.create(dub_id, { text: request, autonomy })),
);

server.registerTool(
  "answer_run",
  {
    title: "Answer a proposed change",
    description:
      "Answers a run from ask_reedapt that is waiting (status needs_input): \"apply\" makes the proposed change, \"decline\" drops it. Only apply what the person has seen and agreed to. Applying voices the changed lines again.",
    inputSchema: {
      run_id: z.string().min(1).describe("The run's id, from ask_reedapt."),
      choice: z.enum(["apply", "decline"]),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  ({ run_id, choice }) => run(() => reedapt().runs.answer(run_id, { choice })),
);

server.registerTool(
  "list_lines",
  {
    title: "List a dub's lines",
    description: `A finished dub's lines by number: timing in milliseconds, speaker, original and dubbed words, and delivery notes. Early access. Returns ${LINES_PAGE} lines at a time; use offset for more. Line numbers are what edit_lines and ask_reedapt refer to.`,
    inputSchema: { dub_id: dubId, offset: z.number().int().min(0).default(0) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ dub_id, offset }) =>
    run(async () => {
      const all = await reedapt().dubs.lines.list(dub_id);
      const lines = all.lines.slice(offset, offset + LINES_PAGE);
      return {
        ...all,
        lines,
        total_lines: all.lines.length,
        next_offset: offset + lines.length < all.lines.length ? offset + lines.length : null,
      };
    }),
);

server.registerTool(
  "edit_lines",
  {
    title: "Edit a dub's lines",
    description:
      "Changes the dubbed words, delivery style or voice instructions of up to 100 lines. Early access. The changed lines are voiced again in the background and the dub's files update when that is done (status \"revoicing\"). This replaces what is there, so confirm the exact new wording with the person first.",
    inputSchema: {
      dub_id: dubId,
      lines: z
        .array(
          z.object({
            line: z.number().int().min(0).describe("The line number from list_lines."),
            text: z.string().optional().describe("The new dubbed words."),
            delivery_style: z.string().optional().describe("How to say it, such as \"warm\" or \"whispered\"."),
            voice_instructions: z.string().optional().describe("Notes on the voice for this line."),
          }),
        )
        .min(1)
        .max(100),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ({ dub_id, lines }) => run(() => reedapt().dubs.lines.edit(dub_id, { lines })),
);

server.registerTool(
  "cancel_dub",
  {
    title: "Cancel a dub",
    description: "Stops a dub that hasn't finished. Its reserved minutes are returned. This can't be undone.",
    inputSchema: { dub_id: dubId },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  ({ dub_id }) =>
    run(async () => {
      await reedapt().dubs.cancel(dub_id);
      return { cancelled: dub_id };
    }),
);

await server.connect(new StdioServerTransport());
