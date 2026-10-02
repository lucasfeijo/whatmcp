# Windows: iPhone history plus WhatsApp Desktop increments

The iPhone backup is the historical base. Windows Desktop contributes later
messages to the **same durable archive**. Neither source is ever overwritten.
The Windows app's local databases are encrypted; pointing WhatMCP at
`genericStorage.db` does not work. WhatMCP invokes the separate
[WAren6 fork](https://github.com/caduosmarini/WAren6) GPL-3.0 tool in offline mode, then
imports its validated `unified_whatsapp.db`. No WAren6 code is bundled here.

## One-time setup

1. Install WhatsApp Desktop and sign in. Install Node 22.6+ and PowerShell.
2. Clone WAren6 separately and review its requirements:

   ```powershell
   git clone https://github.com/caduosmarini/WAren6.git C:\path\to\WAren6
   ```

3. Keep the WhatMCP archive and API key outside the checkout. If using a
   nondefault location, set `WHATMCP_HOME` in the shell **and** in the MCP
   configuration. Then configure the Windows source:

   ```powershell
   npm run wa -- windows-source C:\path\to\WAren6
   ```

   This writes `source_type=windows-waren6` and `windows_waren6_path` to
   `config.json`; it does not run extraction. Optional config field
   `windows_output_dir` changes the private case directory (default:
   `WHATMCP_HOME\windows-cases`).

4. An already completed WAren6 case can be imported without running WAren6
   again:

   ```powershell
   npm run wa -- import-windows C:\path\to\unified_whatsapp.db
   npm run wa -- embed
   ```

   `import-windows` checks the SQLite schema and `quick_check`. The first pass
   imports records newer than the newest message already in the archive. Later
   passes revisit the last seven days; stable `chat_jid:msg_id` keys prevent
   duplicates. Rows without a stable message ID are counted and skipped.
   `--full` intentionally scans all available Windows records, without deleting
   the iPhone history. Embedding sends new text windows to OpenAI, as in macOS.

## Acquisition without closing WhatsApp

`npm run sync` uses `scripts/sync-hotcopy-windows.ps1` to copy LocalState,
WebView2 IndexedDB and Local Storage while WhatsApp remains open. It then runs
WAren6 offline against that copy with `-f -n -NoArchive -PreservedCopy`, validates
the new case and imports its `unified_whatsapp.db`. Manual sync also embeds new
windows. There is no close/reopen step or confirmation dialog.

Use the WAren6 fork's preserved-copy implementation, starting at commit
`e53aa64`. Use `3fd7f19` or newer for the quoted-reply index that avoids
repeated full-chat scans during unification. It refuses an incomplete preserved source instead of falling back to
live acquisition. Upstream WAren6 remains available at
https://github.com/MayukXT/WAren6. WhatMCP invokes this GPL-3.0 dependency as a
separate process; its implementation is not bundled in this MIT repository.

A live file copy is not an atomic snapshot. Files can change during copying;
copy diagnostics, WAren6 validation and SQLite integrity checks gate import.
Failed validation rejects the run and preserves the existing archive. Successful
checks establish that the captured case is usable, not that every live message
was captured at one exact instant. A later sync revisits recent messages.

Cases contain decrypted personal data and key material. Keep cases, logs,
configuration, certificates and the archive outside Git and cloud-sync folders.
The hot-copy pipeline keeps its latest two generated runs.

## Scheduled collection

For the sibling `whatmcp`, `WAren6` and private `data` directory layout, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/register-hotcopy-task.ps1 -IntervalHours 2
```

The `WhatMCP Hot Copy` task uses an invisible launcher under the interactive
user's profile. The user must be signed in. Configure `data/runtime-windows.json`
with `python_path` when Python is unavailable on that user's PATH. The task
collects, validates and imports, then generates all pending embeddings.

Alternatively, `npm run wa -- sync-every <hours>` creates the per-user
`WhatMCP Sync` task, which also embeds missing windows. `sync-every 0` removes
that task. Choose one schedule to avoid redundant acquisitions. Both use the
supervised sync worker, and neither closes WhatsApp or places credentials on
the command line.

## Upstream v0.2.0 integration

Windows sync uses the upstream supervised worker and SQLite process lock, with a
30-minute timeout (ChatStorage keeps the upstream 5-minute timeout). A timeout
pauses scheduled attempts until a successful manual retry. On Windows the worker
and its helper processes are terminated together; WhatsApp remains open.

The hidden scheduled launcher runs `sync --scheduled`: collection, validation,
import and pending embeddings run on every synchronization. Manual CLI, MCP and
dashboard sync also generate pending embeddings. Existing vectors are reused;
only missing vectors require embedding API calls. Configure `windows_source_path` when
a service account must refer to another user's live WhatsApp package directory.
The account must have access to the source and any required user credentials.

## MCP client timeout

Windows collection can take several minutes. Configure the MCP client's tool
call timeout above the server's 30-minute watchdog, rather than abandoning the
request while extraction is still running. In an existing Codex
`[mcp_servers.whatmcp]` entry, set `tool_timeout_sec = 1900` and reload the MCP
connection to apply it. Remote clients need their own timeout configuration.
The source service and scheduled task are independent of that client setting.
Read tools query the existing archive without triggering collection; request
`sync_archive` only for an explicit refresh or when newer data is necessary.
