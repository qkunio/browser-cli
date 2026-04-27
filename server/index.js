import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import * as pty from 'node-pty';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const host = '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const isDev = process.env.NODE_ENV !== 'production';
const maxReplayBytes = 1024 * 1024;

const app = express();
const server = createServer(app);
const sessions = new Map();

app.use(express.json());

app.get('/sessions', (_req, res) => {
  res.json([...sessions.values()].map(serializeSession));
});

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
  console.log(`Browser CLI listening at http://${host}:${port}`);
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
    name: path.basename(cwd) || cwd,
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
    cwd: session.cwd,
    createdAt: session.createdAt,
    status: session.exitCode === null ? 'running' : 'exited',
    exitCode: session.exitCode,
    occupied: Boolean(session.client)
  };
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
    return runCommand('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
        '$dialog.Description = "选择终端启动目录";',
        '$dialog.ShowNewFolderButton = $true;',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
        '  Write-Output $dialog.SelectedPath',
        '}'
      ].join(' ')
    ]);
  }

  if (process.platform === 'darwin') {
    return runCommand('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "选择终端启动目录")'
    ]);
  }

  return runCommand('zenity', ['--file-selection', '--directory', '--title=选择终端启动目录']);
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

function shutdown() {
  for (const session of sessions.values()) {
    closeSession(session, 'server_shutdown');
  }

  server.close(() => {
    process.exit(0);
  });
}
