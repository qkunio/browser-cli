import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

type Session = {
  id: string;
  name: string;
  cwd: string;
  createdAt: string;
  status: 'running' | 'exited';
  exitCode: number | null;
  occupied: boolean;
};

const app = document.querySelector<HTMLDivElement>('#app');

if (!app) {
  throw new Error('App root not found');
}

const appRoot = app;

const route = window.location.pathname;
const terminalMatch = route.match(/^\/terminal\/([^/]+)$/);

if (terminalMatch) {
  renderTerminal(decodeURIComponent(terminalMatch[1]));
} else {
  renderManager();
}

function renderManager() {
  appRoot.innerHTML = `
    <main class="shell">
      <section class="toolbar">
        <div>
          <h1>Browser CLI</h1>
          <p class="muted">本机会话管理</p>
        </div>
        <button class="primary" id="new-session" type="button" title="新建会话">
          <span aria-hidden="true">+</span>
          <span>新建会话</span>
        </button>
      </section>
      <section class="status-line" id="status-line">正在加载会话...</section>
      <section class="session-list" id="session-list" aria-live="polite"></section>
    </main>
  `;

  const newSessionButton = getElement<HTMLButtonElement>('new-session');
  const statusLine = getElement<HTMLElement>('status-line');
  const sessionList = getElement<HTMLElement>('session-list');

  newSessionButton.addEventListener('click', async () => {
    newSessionButton.disabled = true;
    setStatus(statusLine, '正在打开系统文件夹选择器...');

    try {
      const response = await fetch('/sessions', { method: 'POST' });

      if (response.status === 400) {
        const body = await response.json().catch(() => null);
        if (body?.error === 'folder_selection_cancelled') {
          setStatus(statusLine, '已取消新建会话。');
          return;
        }
      }

      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || body?.error || '创建会话失败');
      }

      const session = (await response.json()) as Session;
      window.location.href = `/terminal/${encodeURIComponent(session.id)}`;
    } catch (error) {
      setStatus(statusLine, error instanceof Error ? error.message : String(error), true);
    } finally {
      newSessionButton.disabled = false;
      void loadSessions(sessionList, statusLine);
    }
  });

  void loadSessions(sessionList, statusLine);
  window.setInterval(() => void loadSessions(sessionList, statusLine, true), 2500);
}

async function loadSessions(sessionList: HTMLElement, statusLine: HTMLElement, quiet = false) {
  try {
    const response = await fetch('/sessions');

    if (!response.ok) {
      throw new Error('会话列表加载失败');
    }

    const sessions = (await response.json()) as Session[];
    sessionList.innerHTML = '';

    if (!sessions.length) {
      sessionList.innerHTML = `
        <div class="empty">
          <h2>暂无会话</h2>
          <p>新建一个会话，选择目录后就可以在浏览器里使用完整终端。</p>
        </div>
      `;

      if (!quiet) {
        setStatus(statusLine, '没有正在运行的会话。');
      }

      return;
    }

    for (const session of sessions) {
      sessionList.appendChild(createSessionRow(session));
    }

    setStatus(statusLine, `${sessions.length} 个会话`);
  } catch (error) {
    setStatus(statusLine, error instanceof Error ? error.message : String(error), true);
  }
}

function createSessionRow(session: Session) {
  const row = document.createElement('article');
  row.className = 'session-row';

  const createdAt = new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(session.createdAt));

  row.innerHTML = `
    <div class="session-main">
      <div class="session-title">
        <span>${escapeHtml(session.name)}</span>
        <span class="badge ${session.occupied ? 'busy' : ''}">
          ${session.occupied ? '占用中' : session.status === 'running' ? '运行中' : `已退出 ${session.exitCode ?? ''}`}
        </span>
      </div>
      <div class="path" title="${escapeHtml(session.cwd)}">${escapeHtml(session.cwd)}</div>
      <div class="meta">创建于 ${createdAt}</div>
    </div>
    <div class="actions">
      <button class="icon-button enter" type="button" title="进入会话" ${session.occupied || session.status !== 'running' ? 'disabled' : ''}>↗</button>
      <button class="icon-button close" type="button" title="关闭会话">×</button>
    </div>
  `;

  row.querySelector<HTMLButtonElement>('.enter')?.addEventListener('click', () => {
    window.location.href = `/terminal/${encodeURIComponent(session.id)}`;
  });

  row.querySelector<HTMLButtonElement>('.close')?.addEventListener('click', async () => {
    await fetch(`/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
    row.remove();

    if (!document.querySelector('.session-row')) {
      renderManager();
    }
  });

  return row;
}

async function renderTerminal(sessionId: string) {
  appRoot.innerHTML = `
    <main class="terminal-page">
      <header class="terminal-bar">
        <button class="icon-button" id="back" type="button" title="返回会话管理">←</button>
        <div class="terminal-title">
          <strong id="terminal-name">连接中...</strong>
          <span id="terminal-path"></span>
        </div>
        <span class="connection" id="connection">正在连接</span>
      </header>
      <section class="terminal-host" id="terminal-host"></section>
    </main>
  `;

  getElement<HTMLButtonElement>('back').addEventListener('click', () => {
    window.location.href = '/';
  });

  const host = getElement<HTMLElement>('terminal-host');
  const connection = getElement<HTMLElement>('connection');
  const terminalName = getElement<HTMLElement>('terminal-name');
  const terminalPath = getElement<HTMLElement>('terminal-path');
  const term = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace',
    fontSize: 14,
    lineHeight: 1.15,
    theme: {
      background: '#101214',
      foreground: '#e8edf2',
      cursor: '#f4ce46',
      selectionBackground: '#2e5f8a'
    }
  });
  const fitAddon = new FitAddon();
  let socket: WebSocket | null = null;
  let ready = false;

  term.loadAddon(fitAddon);
  term.open(host);
  fitAddon.fit();
  term.focus();

  const connect = () => {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/sessions/${encodeURIComponent(sessionId)}/terminal`);

    socket.addEventListener('open', () => {
      connection.textContent = '已连接';
      ready = true;
      sendResize();
    });

    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));

      if (message.type === 'ready') {
        const session = message.session as Session;
        terminalName.textContent = session.name;
        terminalPath.textContent = session.cwd;
        return;
      }

      if (message.type === 'output') {
        term.write(message.data);
        return;
      }

      if (message.type === 'exit') {
        connection.textContent = `已退出 ${message.code ?? ''}`;
        return;
      }

      if (message.type === 'closed') {
        connection.textContent = '会话已关闭';
        term.write('\r\n[session closed]\r\n');
        return;
      }

      if (message.type === 'error') {
        connection.textContent = message.error === 'session_occupied' ? '会话占用中' : '连接失败';
        term.write(`\r\n[${message.error}]\r\n`);
      }
    });

    socket.addEventListener('close', () => {
      ready = false;
      if (connection.textContent === '已连接') {
        connection.textContent = '已断开';
      }
    });
  };

  term.onData(data => {
    if (ready && socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  });

  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
    sendResize();
  });

  resizeObserver.observe(host);
  window.addEventListener('beforeunload', () => {
    socket?.close();
  });

  connect();

  function sendResize() {
    if (socket?.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify({
      type: 'resize',
      cols: term.cols,
      rows: term.rows
    }));
  }
}

function setStatus(element: HTMLElement, message: string, error = false) {
  element.textContent = message;
  element.classList.toggle('error', error);
}

function getElement<T extends HTMLElement>(id: string) {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing element #${id}`);
  }

  return element as T;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, char => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };

    return entities[char];
  });
}
