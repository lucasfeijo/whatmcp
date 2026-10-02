# Changelog

Notable changes to this fork of WhatMCP are recorded here.

## [0.2.0] - 2026-10-01

### Added

- `list_messages_since` enumerates archived messages by time across chats, with an optional chat filter and a resumable cursor. It needs neither a search term nor an embedding API key. The feed has supporting database indexes and a test for messages with identical timestamps.
- Guides for importing a compatible `ChatStorage.sqlite` file on macOS or Windows and for recovering history from an encrypted iPhone backup. These are documented workflows; no new backup extractor or WhatsApp database adapter was added.

### Fixed

- Embedding continues when the API rejects an oversized input: the batch is split, successful windows are saved, and the individual rejected window remains pending for a later retry.
- Syncs launched from the CLI, schedule, MCP tool, or dashboard run in a supervised process with a five-minute limit and a short termination grace period.
- A process-held SQLite lock skips overlapping sync requests immediately, without building a queue. The lock is released if the worker is killed.
- After a sync times out, scheduled attempts pause until a manual sync succeeds. Archive status and the dashboard report the pause.

### Upgrade notes

- Run `npm install`, then `npm run index` once to create the message-feed indexes before starting the MCP server.
- If a macOS LaunchAgent was already installed, reapply its current cadence with `npm run wa -- sync-every <hours>` to install the updated scheduled command.
- The feed filters by message time. Importing older history or editing an existing message can require rescanning an earlier interval. A macOS permission prompt can still block a sync until the user grants access.
