import pty, { type IPty } from 'node-pty';
import fs from 'node:fs';
import { TERM_COLS, TERM_ROWS } from '@af/shared';
import { bus } from '../bus.js';
import { config } from '../config.js';

const DONE_RE = /\x1b\]777;af-done;(\d+)\x07/;
const MAX_BUFFER = 256 * 1024;

export function stripAnsi(s: string) {
  return s
    .replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[=>]/g, '');
}

/** 模拟终端的 \r 覆盖行为（进度条等），把输出整理成 LLM 可读的纯文本 */
function cleanForLLM(raw: string) {
  const text = stripAnsi(raw)
    .split('\n')
    .map((line) => {
      const parts = line.split('\r').filter((p) => p.length);
      return parts.length ? parts[parts.length - 1] : '';
    })
    .join('\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  if (text.length <= 8000) return text;
  return text.slice(0, 1500) + `\n... [省略 ${text.length - 7500} 字符] ...\n` + text.slice(-6000);
}

interface Running {
  out: string;
  resolve: (r: { output: string; exitCode: number | null; timedOut: boolean }) => void;
}

class AgentTerminal {
  private pty: IPty;
  buffer = '';
  private running: Running | null = null;

  constructor(readonly agentId: string, name: string) {
    fs.mkdirSync(config.workspace, { recursive: true });
    const shell = fs.existsSync('/bin/bash') ? '/bin/bash' : 'sh';
    this.pty = pty.spawn(shell, ['--noprofile', '--norc', '--noediting', '-i'], {
      name: 'xterm-256color',
      cols: TERM_COLS,
      rows: TERM_ROWS,
      cwd: config.workspace,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'en_US.UTF-8',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
        CI: '1',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
        GIT_CEILING_DIRECTORIES: config.workspace,
        BASH_SILENCE_DEPRECATION_WARNING: '1',
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: `${agentId}@agent-factory.local`,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: `${agentId}@agent-factory.local`,
        PS1: `\\[\\e[1;32m\\]${agentId}@factory\\[\\e[0m\\]:\\[\\e[1;34m\\]\\W\\[\\e[0m\\]$ `,
        PROMPT_COMMAND: 'printf "\\033]777;af-done;%s\\007" $?',
      } as Record<string, string>,
    });
    this.pty.onData((d) => this.onData(d));
    this.pty.onExit(() => bus.log('warn', '终端进程退出', agentId));
  }

  private onData(data: string) {
    let visible = data;
    const m = DONE_RE.exec(data);
    if (m) visible = data.replace(DONE_RE, '');
    this.buffer += visible;
    if (this.buffer.length > MAX_BUFFER) this.buffer = this.buffer.slice(-MAX_BUFFER / 2);
    if (visible) bus.emit({ t: 'term', agentId: this.agentId, data: visible });
    if (this.running) {
      this.running.out += visible;
      if (m) {
        const r = this.running;
        this.running = null;
        r.resolve({ output: r.out, exitCode: Number(m[1]), timedOut: false });
      }
    }
  }

  get busy() {
    return this.running !== null;
  }

  async run(cmd: string, timeoutSec: number) {
    if (this.running) throw new Error('终端上一条命令还在运行。可以用 terminal_input 发送 Ctrl-C（"\\u0003"）结束它。');
    const line = cmd.includes('\n') ? `{\n${cmd}\n}` : cmd;
    const p = new Promise<{ output: string; exitCode: number | null; timedOut: boolean }>((resolve) => {
      this.running = { out: '', resolve };
    });
    this.pty.write(line + '\r');
    let timedOut = false;
    const timer = setTimeout(() => {
      // 超时：发 Ctrl-C 结束命令；若 3 秒内仍没回到提示符就直接返回
      const r = this.running;
      if (!r) return;
      timedOut = true;
      this.pty.write('\x03');
      setTimeout(() => {
        if (this.running === r) {
          this.running = null;
          r.resolve({ output: r.out, exitCode: null, timedOut: true });
        }
      }, 3000);
    }, timeoutSec * 1000);
    const res = await p;
    clearTimeout(timer);
    res.timedOut ||= timedOut;
    // 去掉回显的命令行本身
    const lines = cleanForLLM(res.output).split('\n');
    const echoLines = line.split('\n').length;
    const output = lines.slice(echoLines).join('\n').trim();
    return { ...res, output };
  }

  input(text: string) {
    this.pty.write(text);
  }

  kill() {
    this.pty.kill();
  }
}

const terminals = new Map<string, AgentTerminal>();

export function getTerminal(agentId: string, name: string) {
  let t = terminals.get(agentId);
  if (!t) {
    t = new AgentTerminal(agentId, name);
    terminals.set(agentId, t);
  }
  return t;
}

export function terminalBuffers() {
  return Object.fromEntries([...terminals].map(([k, v]) => [k, v.buffer]));
}

export function killAllTerminals() {
  for (const t of terminals.values()) t.kill();
  terminals.clear();
}
