import fs from 'node:fs';
import path from 'node:path';
import type { LogEntry, LogLevel, ServerMsg } from '@af/shared';
import { config } from './config.js';
import { db } from './db.js';

type Listener = (msg: ServerMsg) => void;

/** 全局事件总线：所有实时画面、状态变化、日志都经由这里推给前端 */
class Bus {
  private listeners = new Set<Listener>();
  private logSeq = 0;
  readonly logs: LogEntry[] = [];
  private logFile: fs.WriteStream;

  constructor() {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const file = path.join(config.dataDir, 'events.jsonl');
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(-500);
      for (const l of lines) {
        try {
          const e = JSON.parse(l) as LogEntry;
          this.logs.push(e);
          this.logSeq = Math.max(this.logSeq, e.id);
        } catch {}
      }
    }
    this.logFile = fs.createWriteStream(file, { flags: 'a' });
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(msg: ServerMsg) {
    for (const fn of this.listeners) fn(msg);
  }

  log(level: LogLevel, text: string, agentId: string | null = null, taskId: string | null = null) {
    const e: LogEntry = { id: ++this.logSeq, ts: Date.now(), level, agentId, taskId, text };
    this.logs.push(e);
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
    this.logFile.write(JSON.stringify(e) + '\n');
    db.insertEvent(e);
    this.emit({ t: 'log', d: e });
    const tag = agentId ? `[${agentId}]` : '[system]';
    if (level !== 'debug') console.log(`${new Date(e.ts).toLocaleTimeString()} ${level.toUpperCase().padEnd(7)} ${tag} ${text.slice(0, 200)}`);
  }
}

export const bus = new Bus();
