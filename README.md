# Reedapt MCP server

Dub video and audio into other languages from any AI tool that speaks the [Model Context Protocol](https://modelcontextprotocol.io): Claude Code, Claude Desktop, Cursor and others. Each speaker keeps their own voice, and the background sound is kept.

## Set up

Make an API key under **Developers** in [Reedapt](https://dub.reedapt.com/developers). Test keys are free and dub the first 60 seconds of a video with a watermark; live keys come with paid plans and use plan minutes.

**Claude Code**

```bash
claude mcp add reedapt --env REEDAPT_API_KEY=rk_test_... -- npx -y reedapt-mcp
```

**Claude Desktop, Cursor and other clients** (the `mcpServers` section of the client's config file):

```json
{
  "mcpServers": {
    "reedapt": {
      "command": "npx",
      "args": ["-y", "reedapt-mcp"],
      "env": { "REEDAPT_API_KEY": "rk_test_..." }
    }
  }
}
```

Node.js 18 or later.

## Tools

| Tool | What it does |
|---|---|
| `list_languages` | The languages this key's plan can dub into |
| `get_usage` | The plan, minutes left, or a month's usage report |
| `dub_media` | Upload a local file or a public link and start one dub per language, with optional `instructions` (names to keep, tone) |
| `get_dub` | A dub's status, stage and progress |
| `wait_for_dub` | Wait up to 4 minutes for a dub to finish; call again to keep waiting |
| `list_dubs` | The account's API dubs, newest first |
| `get_dub_files` | Download links for a finished dub |
| `get_transcript` | The dub's lines, original and dubbed, 200 at a time |
| `get_subtitles` | SRT or WebVTT, in the dub's language or the original's |
| `get_quality` | Reedapt's check of a finished dub: lines fixed and lines left to review |
| `ask_reedapt` | Ask for a change in plain words; returns the run, which may wait for your answer (early access) |
| `answer_run` | Apply or decline the change a run proposed (early access) |
| `list_lines` | A dub's lines by number, 100 at a time (early access) |
| `edit_lines` | Change the words or delivery of up to 100 lines; they are voiced again (early access) |
| `cancel_dub` | Stop a dub that hasn't finished; its minutes are returned |

The last four are early access: they work on the accounts Reedapt has released them to and return `NOT_AVAILABLE` on the others. `ask_reedapt` asks before it changes anything unless you say otherwise.

## The Reedapt Skill

`skill/reedapt/SKILL.md` teaches an AI tool how to dub well with Reedapt: checking languages and minutes first, waiting, reading the quality report, asking for changes, handing over the files, and what to say when something fails. To use it in Claude Code, copy the `skill/reedapt` folder into `~/.claude/skills/`.

## Links

- [API reference](https://docs.reedapt.com)
- [Node.js library](https://www.npmjs.com/package/reedapt)
