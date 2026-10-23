# Windows HTTPS service

Place the official WinSW 2.12.0 x64 executable beside the service template as
`whatmcp-service.exe`. The executable and generated configuration are local files
and must not be committed. The installer expands `@PROJECT@` to the project root.

The service runs as LocalService, starts automatically after boot, and recovers
after process failures. Grant this account read/execute permissions on the MCP
checkout, read/write permissions on the archive/log directory, and read-only
access to private TLS settings. For synchronization through MCP, LocalService
also needs read/execute access to the separate WAren6 checkout and Python
runtime, and read access to the WhatsApp LocalState, IndexedDB and Local Storage
source directories. Configure `windows_source_path` explicitly; LocalService
does not use the interactive user's LOCALAPPDATA. Grant only traversal and
read-attributes on ancestor directories. No write access to the live WhatsApp
source is required. The interactive scheduled task alone working does not
verify service-account access. If Node reports an ancestor-directory `lstat`
permission error, grant only traversal and read-attributes on that directory.

Configure `WHATMCP_HOME` with a private `config.json` containing a randomly
generated `http_token` of at least 32 random bytes. Create `tls-runtime.json` with
`pfx_path` and `pfx_password`, referencing a protected PFX certificate. Keep all
credentials, certificates and archives outside version control.

Run `scripts/install-service.ps1` from an elevated PowerShell session. The HTTPS
gateway listens on port 8787 and forwards only `/mcp` and `/health` to the loopback
HTTP service on port 8786. The MCP endpoint still requires its bearer token.
Configure the firewall for the networks intended to access the service and
configure clients to trust the server certificate without disabling TLS checks.

The `WhatMCP Hot Copy` task is separate from the service. It runs under the
interactive user's profile. Configure `runtime-windows.json` with `python_path`
when Python is not available on that user's PATH. Extraction requires the
preserved-copy support from https://github.com/caduosmarini/WAren6,
starting at commit `e53aa64`; use `3fd7f19` or newer for fast quoted-message
unification. Keep that repository as the WAren6 dependency;
https://github.com/MayukXT/WAren6 remains its upstream project.

## Desktop 0.3.0: Windows verbatim-path repair

Some Windows launch contexts supply the Node entrypoint with a `\\?\` prefix.
The bundled Node 22 runtime can exit before loading the backend with
`EISDIR: illegal operation on a directory, lstat 'C:'`; the UI then shows pipe error 232.
The source fix in `desktop/src-tauri/src/main.rs` normalizes the Node entrypoint and
selected profile only on Windows. Other platforms retain the original paths.

For an already installed Windows app, close the desktop window and run:

```powershell
.\scripts\repair-desktop-windows.ps1 -InstallDir "$env:LOCALAPPDATA\WhatMCP"
```

This builds a Windows-only bootstrap locally using the existing .NET Framework
compiler. The bootstrap is unsigned and must be explicitly approved by the owner.
The original signed Node executable remains intact as `bin/node.original.exe`.
Private stdin/stdout IPC and the Node exit status are preserved. No services,
schedulers, archive contents, provider keys or macOS files are changed.
A future native desktop build containing the Rust fix no longer needs the bootstrap.
