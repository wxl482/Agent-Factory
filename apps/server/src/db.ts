import pg from 'pg';
import type { Approval, LogEntry, Meeting, Task } from '@af/shared';
import { config } from './config.js';
import type { ChatMessage } from './llm/types.js';

const { Pool } = pg;

export interface PersistedJob {
  id: string;
  agentId: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  title: string;
  prompt: string;
  taskId: string | null;
  createdAt: number;
}

class Database {
  pool: pg.Pool | null = null;
  ready = false;

  async init(): Promise<boolean> {
    if (!config.databaseUrl) return false;
    try {
      const pool = new Pool({
        connectionString: config.databaseUrl,
        max: 10,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      });
      await pool.query('SELECT 1');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS af_tasks (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          parent_id TEXT,
          priority TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          data JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_af_tasks_parent ON af_tasks(parent_id);
        CREATE INDEX IF NOT EXISTS idx_af_tasks_status ON af_tasks(status);

        CREATE TABLE IF NOT EXISTS af_approvals (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          kind TEXT NOT NULL,
          task_id TEXT,
          created_at BIGINT NOT NULL,
          data JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_af_approvals_status ON af_approvals(status);

        CREATE TABLE IF NOT EXISTS af_conversations (
          task_key TEXT PRIMARY KEY,
          updated_at BIGINT NOT NULL,
          messages JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS af_meetings (
          id TEXT PRIMARY KEY,
          created_at BIGINT NOT NULL,
          data JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS af_jobs (
          id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          priority TEXT NOT NULL,
          task_id TEXT,
          created_at BIGINT NOT NULL,
          data JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS af_kv (
          key TEXT PRIMARY KEY,
          updated_at BIGINT NOT NULL,
          val JSONB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS af_events (
          id BIGINT PRIMARY KEY,
          ts BIGINT NOT NULL,
          level TEXT NOT NULL,
          agent_id TEXT,
          task_id TEXT,
          text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_af_events_ts ON af_events(ts DESC);
      `);
      this.pool = pool;
      this.ready = true;
      return true;
    } catch (e: any) {
      console.warn(`[db] PostgreSQL 连接失败 (${e?.message ?? e})，降级为本地原子文件存储`);
      this.pool = null;
      this.ready = false;
      return false;
    }
  }

  async loadState(): Promise<{
    tasks: Task[];
    approvals: Approval[];
    conversations: Record<string, ChatMessage[]>;
    meetings: Meeting[];
    jobs: PersistedJob[];
  } | null> {
    if (!this.pool) return null;
    const [tasksRes, appRes, convRes, meetRes, jobsRes] = await Promise.all([
      this.pool.query('SELECT data FROM af_tasks ORDER BY created_at ASC'),
      this.pool.query('SELECT data FROM af_approvals ORDER BY created_at ASC'),
      this.pool.query('SELECT task_key, messages FROM af_conversations'),
      this.pool.query('SELECT data FROM af_meetings ORDER BY created_at ASC LIMIT 50'),
      this.pool.query('SELECT data FROM af_jobs ORDER BY created_at ASC'),
    ]);
    const conversations: Record<string, ChatMessage[]> = {};
    for (const r of convRes.rows) conversations[r.task_key] = r.messages;
    return {
      tasks: tasksRes.rows.map((r) => r.data as Task),
      approvals: appRes.rows.map((r) => r.data as Approval),
      conversations,
      meetings: meetRes.rows.map((r) => r.data as Meeting),
      jobs: jobsRes.rows.map((r) => r.data as PersistedJob),
    };
  }

  upsertTask(t: Task) {
    if (!this.pool) return;
    this.pool
      .query(
        `INSERT INTO af_tasks (id, kind, status, parent_id, priority, created_at, updated_at, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           parent_id = EXCLUDED.parent_id,
           priority = EXCLUDED.priority,
           updated_at = EXCLUDED.updated_at,
           data = EXCLUDED.data`,
        [t.id, t.kind, t.status, t.parentId, t.priority, t.createdAt, t.updatedAt, JSON.stringify(t)],
      )
      .catch((e) => console.error('[db] upsertTask error:', e.message));
  }

  upsertApproval(a: Approval) {
    if (!this.pool) return;
    this.pool
      .query(
        `INSERT INTO af_approvals (id, status, kind, task_id, created_at, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status,
           data = EXCLUDED.data`,
        [a.id, a.status, a.kind, a.taskId, a.createdAt, JSON.stringify(a)],
      )
      .catch((e) => console.error('[db] upsertApproval error:', e.message));
  }

  saveConversation(taskKey: string, messages: ChatMessage[]) {
    if (!this.pool) return;
    this.pool
      .query(
        `INSERT INTO af_conversations (task_key, updated_at, messages)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (task_key) DO UPDATE SET
           updated_at = EXCLUDED.updated_at,
           messages = EXCLUDED.messages`,
        [taskKey, Date.now(), JSON.stringify(messages)],
      )
      .catch((e) => console.error('[db] saveConversation error:', e.message));
  }

  deleteConversation(taskKey: string) {
    if (!this.pool) return;
    this.pool.query('DELETE FROM af_conversations WHERE task_key = $1', [taskKey]).catch(() => {});
  }

  upsertMeeting(m: Meeting) {
    if (!this.pool) return;
    this.pool
      .query(
        `INSERT INTO af_meetings (id, created_at, data)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [m.id, m.createdAt, JSON.stringify(m)],
      )
      .catch((e) => console.error('[db] upsertMeeting error:', e.message));
  }

  upsertJob(j: PersistedJob) {
    if (!this.pool) return;
    this.pool
      .query(
        `INSERT INTO af_jobs (id, agent_id, priority, task_id, created_at, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [j.id, j.agentId, j.priority, j.taskId, j.createdAt, JSON.stringify(j)],
      )
      .catch((e) => console.error('[db] upsertJob error:', e.message));
  }

  deleteJob(id: string) {
    if (!this.pool) return;
    this.pool.query('DELETE FROM af_jobs WHERE id = $1', [id]).catch(() => {});
  }

  async getKv<T>(key: string): Promise<T | null> {
    if (!this.pool) return null;
    try {
      const r = await this.pool.query('SELECT val FROM af_kv WHERE key = $1', [key]);
      return r.rows[0]?.val ?? null;
    } catch {
      return null;
    }
  }

  setKv(key: string, val: unknown) {
    if (!this.pool) return;
    this.pool
      .query(
        `INSERT INTO af_kv (key, updated_at, val)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (key) DO UPDATE SET updated_at = EXCLUDED.updated_at, val = EXCLUDED.val`,
        [key, Date.now(), JSON.stringify(val)],
      )
      .catch((e) => console.error(`[db] setKv(${key}) error:`, e.message));
  }

  insertEvent(e: LogEntry) {
    if (!this.pool) return;
    this.pool
      .query(
        `INSERT INTO af_events (id, ts, level, agent_id, task_id, text)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [e.id, e.ts, e.level, e.agentId, e.taskId, e.text],
      )
      .catch(() => {});
  }
}

export const db = new Database();
