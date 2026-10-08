# CLI and MCP usage

Run commands from a checkout with dependencies installed and Node.js 22.6 or
newer; desktop development uses Node 22.23.2. The CLI defaults to `~/.whatmcp`.
If using a desktop-selected archive, set `WHATMCP_HOME` to that profile directory
in the shell and in each MCP client. The native app does not configure clients
or install a background service.

## Choose a source

| Source | Instructions |
| --- | --- |
| Live macOS WhatsApp Desktop | Sign in to WhatsApp Desktop, then use CLI guided setup below |
| Live Windows WhatsApp Desktop | Configure the separate [WAren6 adapter](WINDOWS.md) |
| Compatible, prepared ChatStorage SQLite file | Follow [file import](IMPORT.md) |
| Existing WhatMCP archive | Select the [existing archive](IMPORT.md#use-an-existing-archive) |
| Older iPhone history | [Extract/decrypt the backup](IPHONE.md), then import the prepared file |

A source database and a WhatMCP archive use different schemas. Never use the
same file as both source and destination.

## CLI guided setup

```sh
npm run setup
```

The CLI wizard checks source permissions, offers provider/audio settings, imports
messages, estimates embedding cost before confirmation, and calibrates search.
It also offers background sync with a default interval of six hours. Choose `0`
to keep sync manual. This differs from the desktop wizard, which uses manual jobs
and does not install a scheduler.

For live macOS capture, the terminal or MCP client that launches the CLI needs
user-granted Full Disk Access. `setup` and `doctor` check readability. Browsing
an already-built archive does not need access to WhatsApp's protected source.

For manual setup, select the source first, then run only the steps you want:

```sh
npm run index                       # import / index
npm run wa -- set-key                # hidden prompt; save provider key
npm run embed                       # sends pending conversation text to OpenAI
npm run wa -- calibrate              # sends calibration queries to OpenAI
npm run wa -- search "invoice" --mode=bm25
```

`index` alone does not call the embedding API by default. If automatic
post-import transcription is explicitly enabled, its processing pipeline can
also publish and embed transcripts. See [audio settings](AUDIO.md).

Do not pass keys as command-line arguments: `set-key` refuses them to keep secrets
out of process lists and shell history. For automation, pipe a secret manager
or redirect a protected key file into `npm run wa -- set-key`.

## Connect an MCP client

Use absolute paths and the same profile for the CLI and client. For example:

```json
{
  "mcpServers": {
    "whatmcp": {
      "command": "node",
      "args": [
        "--experimental-sqlite",
        "--experimental-strip-types",
        "--no-warnings",
        "/absolute/path/to/whatmcp/src/mcp/server.ts"
      ],
      "env": {
        "WHATMCP_HOME": "/absolute/path/to/your/profile"
      }
    }
  }
}
```

Replace both paths. On Windows, use absolute Windows paths with JSON-escaped
backslashes or forward slashes. The `env` block can be omitted for the default
CLI profile. The provider key is read from that profile's `config.json`.

For Claude Code on macOS, from the checkout:

```sh
claude mcp add whatmcp -- node --experimental-sqlite --experimental-strip-types \
  --no-warnings "$(pwd)/src/mcp/server.ts"
```

That example uses the default CLI profile. Configure `WHATMCP_HOME` explicitly in
the client when using another profile. For Claude Desktop, put the JSON entry in
its MCP configuration; on macOS this is
`~/Library/Application Support/Claude/claude_desktop_config.json`.

For clients requiring a URL, use the [remote-access guide](REMOTE.md). It covers
authenticated HTTP, the loopback web dashboard, TLS/tunnels, OAuth, grant revocation,
and shutdown. Opening the native app alone does not start any of these servers.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `search_messages` | Keyword, semantic, or hybrid window search; filter by chat, sender, date |
| `get_conversation` | Read a thread, optionally around a timestamp |
| `list_messages_since` | Chronological messages by date, with a resumable page cursor |
| `list_chats` | Chats by recency, counts, and date ranges |
| `find_people` | Resolve names or phone numbers and their chats |
| `get_chat_summary` | Participants, volume, and peak period for a chat |
| `get_timeline` | Message volume over time, optionally by topic, person, or chat |
| `get_archive_status` | Coverage, embeddings, and source freshness |
| `sync_archive` | Update the local archive; available locally or with a static token, not OAuth grants |

For a topic, call `search_messages`, then expand useful hits with
`get_conversation`. Weak search hits are candidates rather than confirmed answers.
Use `mode="bm25"` for keyword-only search without an API key.

## Recurring reviews

Sync first when available, then call `list_messages_since` with an ISO `after`
timestamp and optionally `before` or an exact `thread_id`. For example:

```json
{
  "after": "2026-10-01T00:00:00-03:00",
  "before": "2026-10-02T00:00:00-03:00",
  "limit": 100
}
```

When `has_more` is true, repeat with `cursor` set to `next_cursor`. The cursor
retains the original range and chat filter. Continue to the final page before
saving a checkpoint, and keep message IDs to deduplicate between reviews. Media
placeholders are included; no search term, embeddings, or API key is needed.

The range uses message time. A later import of older history or an edit will not
appear in a completed interval; rescan relevant intervals after those changes.
`get_archive_status` reports freshness. After upgrading an older checkout, run
`npm run index` once to create feed indexes before starting the MCP server.

## Scheduling and job supervision

On macOS, the CLI can install a per-user LaunchAgent separately from the MCP server:

```sh
npm run wa -- sync-every 6    # explicitly enable a six-hour schedule
npm run wa -- sync-every 0    # disable it
```

With transcription enabled, the scheduled pipeline captures messages, processes
a bounded audio batch, then syncs again to embed published transcripts. The
`transcription_batch_size` setting defaults to 100 per cycle. Transcription errors
do not prevent the final sync, while capture failure stops the pipeline.

`sync_timeout_minutes` defaults to 10 for ChatStorage and 30 for WAren6. Explicit
automatic post-import transcription adds 45 minutes to the base watchdog. A sync
lock prevents overlapping writers. After a timeout, scheduled attempts pause;
a successful manual `npm run sync` resumes them. Completed archive work is retained.
Logs live in the profile's `logs/sync.log`. See [Windows scheduling](WINDOWS.md#scheduled-collection)
for the separate Task Scheduler workflow.

The desktop app has its own capture deadline and manual job controls. It neither
installs nor changes existing schedules. Coordinate existing writers before
upgrades or maintenance on a shared profile.

## Backups

Stop all archive writers before backup. When WAL data is present, use SQLite's
backup API to create a consistent database copy; copying only `archive.db` can
lose committed data still in the WAL. For a closed database with no pending WAL
data, a normal file copy is sufficient.

Preserve the selected profile's configuration and media as well as the database.
Keep backups outside the checkout and protect them as private message data.
Restore tests should use a separate profile rather than overwriting the live one.
