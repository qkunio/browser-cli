import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import * as pty from 'node-pty';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const host = '127.0.0.1';
const port = Number(process.env.PORT || 3819);
const isDev = process.env.NODE_ENV !== 'production';
const maxReplayBytes = 1024 * 1024;
const faviconsDir = path.join(rootDir, 'favicons');
const faviconExtensions = new Set(['.ico', '.png', '.jpg', '.jpeg', '.svg', '.webp']);
const defaultFavicon = 'claude.webp';
const preferredFavicons = ['claude.webp', 'codex.svg'];

const app = express();
const server = createServer(app);
const sessions = new Map();

app.use(express.json());

app.get('/sessions', (_req, res) => {
  res.json([...sessions.values()].map(serializeSession));
});

app.get('/favicons', (_req, res) => {
  res.json(listFavicons());
});

app.use('/favicons', express.static(faviconsDir));

app.post('/sessions', async (_req, res) => {
  try {
    const selectedPath = await pickFolder();

    if (!selectedPath) {
      res.status(400).json({ error: 'folder_selection_cancelled' });
      return;
    }

    if (!existsSync(selectedPath)) {
      res.status(400).json({ error: 'folder_not_found', path: selectedPath });
      return;
    }

    const session = createSession(selectedPath);
    res.status(201).json(serializeSession(session));
  } catch (error) {
    res.status(500).json({
      error: 'folder_picker_failed',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

app.patch('/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);

  if (!session) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }

  const name = normalizeSessionName(req.body?.name);
  const favicon = normalizeFavicon(req.body?.favicon);

  if (!name) {
    res.status(400).json({ error: 'invalid_session_name' });
    return;
  }

  if (!favicon || !isAllowedFavicon(favicon)) {
    res.status(400).json({ error: 'invalid_favicon' });
    return;
  }

  session.name = name;
  session.favicon = favicon;
  res.json(serializeSession(session));
});

app.delete('/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);

  if (!session) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }

  closeSession(session, 'deleted');
  res.status(204).end();
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const match = url.pathname.match(/^\/sessions\/([^/]+)\/terminal$/);

  if (!match) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req, match[1]);
  });
});

wss.on('connection', (ws, _req, sessionId) => {
  const session = sessions.get(sessionId);

  if (!session) {
    ws.send(JSON.stringify({ type: 'error', error: 'session_not_found' }));
    ws.close(1008, 'session_not_found');
    return;
  }

  if (session.client) {
    ws.send(JSON.stringify({ type: 'error', error: 'session_occupied' }));
    ws.close(1008, 'session_occupied');
    return;
  }

  session.client = ws;
  ws.send(JSON.stringify({ type: 'ready', session: serializeSession(session) }));

  if (session.replay) {
    ws.send(JSON.stringify({ type: 'output', data: session.replay }));
  }

  ws.on('message', raw => {
    let message;

    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (message.type === 'input' && typeof message.data === 'string') {
      session.pty.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      const cols = clampInteger(message.cols, 2, 500);
      const rows = clampInteger(message.rows, 2, 300);

      if (cols && rows) {
        session.pty.resize(cols, rows);
      }
    }
  });

  ws.on('close', () => {
    if (session.client === ws) {
      session.client = null;
    }
  });
});

if (isDev) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: 'spa'
  });

  app.use(vite.middlewares);
} else {
  const distDir = path.join(rootDir, 'dist');
  app.use(express.static(distDir));
  app.get(/.*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;

  printBanner(url);
});

server.on('error', error => {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
    console.error(`Browser CLI could not start because ${host}:${port} is already in use.`);
    console.error(`Set another port with PORT, for example: PORT=4000 browser-cli`);
    process.exit(1);
  }

  console.error(`Browser CLI failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function createSession(cwd) {
  const id = randomUUID();
  const shell = getDefaultShell();
  const child = pty.spawn(shell.file, shell.args, {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
  });

  const session = {
    id,
    name: cwd,
    favicon: getDefaultFavicon(),
    cwd,
    createdAt: new Date().toISOString(),
    exitCode: null,
    client: null,
    pty: child,
    replay: ''
  };

  child.onData(data => {
    session.replay = trimReplay(session.replay + data);

    if (session.client?.readyState === WebSocket.OPEN) {
      session.client.send(JSON.stringify({ type: 'output', data }));
    }
  });

  child.onExit(event => {
    session.exitCode = event.exitCode;

  if (session.client?.readyState === WebSocket.OPEN) {
      session.client.send(JSON.stringify({ type: 'exit', code: event.exitCode }));
    }
  });

  sessions.set(id, session);
  return session;
}

function closeSession(session, reason) {
  if (session.client?.readyState === WebSocket.OPEN) {
    session.client.send(JSON.stringify({ type: 'closed', reason }));
    session.client.close(1000, reason);
  }

  try {
    session.pty.kill();
  } catch {
    // The process may already be gone.
  }

  sessions.delete(session.id);
}

function serializeSession(session) {
  return {
    id: session.id,
    name: session.name,
    favicon: session.favicon || getDefaultFavicon(),
    cwd: session.cwd,
    createdAt: session.createdAt,
    status: session.exitCode === null ? 'running' : 'exited',
    exitCode: session.exitCode,
    occupied: Boolean(session.client)
  };
}

function normalizeSessionName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const name = value.trim();

  if (!name || name.length > 200) {
    return null;
  }

  return name;
}

function listFavicons() {
  if (!existsSync(faviconsDir)) {
    return [];
  }

  return readdirSync(faviconsDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(file => faviconExtensions.has(path.extname(file).toLowerCase()))
    .sort((left, right) => {
      const leftIndex = preferredFavicons.indexOf(left);
      const rightIndex = preferredFavicons.indexOf(right);

      if (leftIndex !== -1 || rightIndex !== -1) {
        return (leftIndex === -1 ? preferredFavicons.length : leftIndex)
          - (rightIndex === -1 ? preferredFavicons.length : rightIndex);
      }

      return left.localeCompare(right);
    });
}

function getDefaultFavicon() {
  const favicons = listFavicons();

  if (favicons.includes(defaultFavicon)) {
    return defaultFavicon;
  }

  return favicons[0] || '';
}

function normalizeFavicon(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const favicon = value.trim();

  if (!favicon || favicon.includes('/') || favicon.includes('\\') || favicon.includes('..')) {
    return null;
  }

  return favicon;
}

function isAllowedFavicon(value) {
  return listFavicons().includes(value);
}

function getDefaultShell() {
  if (process.env.SHELL_CMD) {
    return { file: process.env.SHELL_CMD, args: [] };
  }

  if (process.platform === 'win32') {
    return { file: 'powershell.exe', args: [] };
  }

  return { file: process.env.SHELL || '/bin/bash', args: [] };
}

async function pickFolder() {
  if (process.platform === 'win32') {
    return runPowerShellScript(`
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ModernFolderPicker
{
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_NOCHANGEDIR = 0x00000008;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

    public static string PickFolder(IntPtr owner, string title, string okButtonLabel)
    {
        var dialog = (IFileOpenDialog)new FileOpenDialog();
        dialog.SetOptions(FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR | FOS_PATHMUSTEXIST);
        dialog.SetTitle(title);
        dialog.SetOkButtonLabel(okButtonLabel);

        int result = dialog.Show(owner);
        if (result == ERROR_CANCELLED)
        {
            return null;
        }

        Marshal.ThrowExceptionForHR(result);

        IShellItem item;
        dialog.GetResult(out item);

        IntPtr path;
        item.GetDisplayName(SIGDN_FILESYSPATH, out path);

        try
        {
            return Marshal.PtrToStringUni(path);
        }
        finally
        {
            Marshal.FreeCoTaskMem(path);
        }
    }

    [ComImport]
    [Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog
    {
    }

    [ComImport]
    [Guid("D57C7288-D4AD-4768-BE02-9D969532D960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, uint fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }
}
"@

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$owner = New-Object System.Windows.Forms.Form
$owner.Text = "Browser CLI"
$owner.StartPosition = "CenterScreen"
$owner.Width = 1
$owner.Height = 1
$owner.FormBorderStyle = "FixedToolWindow"
$owner.ShowInTaskbar = $true
$owner.TopMost = $true
$owner.Add_Shown({ $owner.Activate(); $owner.BringToFront() })
$owner.Show()

try {
  $selectedPath = [ModernFolderPicker]::PickFolder($owner.Handle, "打开文件夹", "选择文件夹")
  if ($selectedPath) {
    Write-Output $selectedPath
  }
}
finally {
  $owner.Close()
  $owner.Dispose()
}
`);
  }

  if (process.platform === 'darwin') {
    return runCommand('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "选择终端启动目录")'
    ]);
  }

  return runCommand('zenity', ['--file-selection', '--directory', '--title=选择终端启动目录']);
}

function runPowerShellScript(script) {
  return runCommand('powershell.exe', [
    '-NoProfile',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ]);
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      reject(error);
    });
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout.trim() || null);
        return;
      }

      if (code === 1 && !stdout.trim()) {
        resolve(null);
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

function trimReplay(value) {
  if (Buffer.byteLength(value, 'utf8') <= maxReplayBytes) {
    return value;
  }

  return value.slice(-maxReplayBytes);
}

function clampInteger(value, min, max) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    return null;
  }

  return Math.max(min, Math.min(max, parsed));
}

function printBanner(url) {
  const colors = ['\x1b[38;5;81m', '\x1b[38;5;117m', '\x1b[38;5;159m', '\x1b[38;5;221m', '\x1b[38;5;215m'];
  const reset = '\x1b[0m';
  const banner = String.raw`
  ____                                             ____ _     ___ 
 | __ ) _ __ _____      _____  ___ _ __           / ___| |   |_ _|
 |  _ \| '__/ _ \ \ /\ / / __|/ _ \ '__|  _____  | |   | |    | | 
 | |_) | | | (_) \ V  V /\__ \  __/ |    |_____| | |___| |___ | | 
 |____/|_|  \___/ \_/\_/ |___/\___|_|             \____|_____|___|
`;

  console.log(
    banner
      .replace(/^\r?\n/, '')
      .replace(/\r?\n$/, '')
      .split('\n')
      .map((line, index) => `${colors[index % colors.length]}${line}${reset}`)
      .join('\n')
  );
  console.log(`\n${colors[1]}Browser CLI is running at ${url}${reset}`);
  console.log(`${colors[1]}Browser CLI 正在运行：${url}${reset}`);
  console.log(`\n${colors[3]}Keep this terminal open while using Browser CLI.${reset}`);
  console.log(`${colors[3]}使用 Browser CLI 时请不要关闭这个终端。${reset}`);
  console.log(`${colors[4]}Command output history is not kept after this terminal closes. Tools like Claude Code may save their own conversation history.${reset}`);
  console.log(`${colors[4]}关闭终端后命令记录不保留；Claude Code 等工具会自动保存自己的历史会话记录。${reset}\n`);
}

function shutdown() {
  for (const session of sessions.values()) {
    closeSession(session, 'server_shutdown');
  }

  server.close(() => {
    process.exit(0);
  });
}
