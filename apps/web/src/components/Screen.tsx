import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { BROWSER_H, BROWSER_W, TERM_COLS, TERM_ROWS, type ScreenMode } from '@af/shared';
import { cursors, editors, frames, terms, thoughts, useChannel } from '../lib/live';
import { highlight } from '../lib/highlight';
import { useStore } from '../lib/store';

/** 3D 显示器上的屏幕逻辑分辨率（整体缩放贴到显示器表面） */
export const SCREEN_W = 720;
export const SCREEN_H = 450;

/**
 * 屏幕。默认 720×450 逻辑分辨率再整体缩放（3D 显示器用）；
 * 传 width/height + large 时按实际像素排版（全屏大屏用），字号正常、一屏能显示更多内容。
 */
export function Screen({ agentId, scale, forceMode, width = SCREEN_W, height = SCREEN_H, large }: { agentId: string; scale: number; forceMode?: ScreenMode; width?: number; height?: number; large?: boolean }) {
  const agent = useStore((s) => s.agents[agentId]);
  const mode = forceMode ?? agent?.screen ?? 'idle';
  return (
    <div className="screen-outer" style={{ width: width * scale, height: height * scale }}>
      <div className={`screen-inner ${large ? 'screen-large' : ''}`} style={{ width, height, transform: `scale(${scale})` }}>
        {mode === 'terminal' && <TerminalView agentId={agentId} fontSize={large ? 13 : 11} />}
        {mode === 'browser' && <BrowserView agentId={agentId} width={width} height={height} />}
        {mode === 'editor' && <EditorView agentId={agentId} />}
        {mode === 'thinking' && <ThinkingView agentId={agentId} />}
        {mode === 'idle' && <IdleView agentId={agentId} />}
      </div>
    </div>
  );
}

// ---------------- 终端：真实 PTY 字节流 ----------------
function TerminalView({ agentId, fontSize }: { agentId: string; fontSize: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const term = new Terminal({
      cols: TERM_COLS,
      rows: TERM_ROWS,
      fontSize,
      lineHeight: 1.12,
      fontFamily: '"JetBrains Mono", Menlo, Consolas, monospace',
      theme: { background: '#0d1021', foreground: '#d8dee9', cursor: '#06d6a0', green: '#06d6a0', blue: '#73a7ff', red: '#ef476f', yellow: '#ffd166' },
      disableStdin: true,
      cursorBlink: true,
      scrollback: 2000,
      allowProposedApi: true,
    });
    term.open(ref.current!);
    term.write(terms.get(agentId));
    const off = terms.subscribe(agentId, (chunk) => term.write(chunk));
    return () => {
      off();
      term.dispose();
    };
  }, [agentId, fontSize]);
  return (
    <div className="term-view">
      <div className="win-bar">
        <i className="dot r" />
        <i className="dot y" />
        <i className="dot g" />
        <span>bash — {agentId}@factory</span>
      </div>
      <div ref={ref} className="term-host" />
    </div>
  );
}

// ---------------- 浏览器：CDP 屏幕流 ----------------
function BrowserView({ agentId, width, height }: { agentId: string; width: number; height: number }) {
  const frame = useChannel(frames, agentId);
  const cursor = useChannel(cursors, agentId);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!cursor) return;
    const t = setTimeout(() => tick((n) => n + 1), 1600);
    return () => clearTimeout(t);
  }, [cursor]);
  const showCursor = cursor && Date.now() - cursor.ts < 1500;
  const barH = 30;
  const ih = height - barH;
  const scale = Math.min(width / BROWSER_W, ih / BROWSER_H);
  return (
    <div className="browser-view">
      <div className="browser-bar">
        <span className="nav">◀ ▶ ⟳</span>
        <div className="url">{frame?.url || 'about:blank'}</div>
      </div>
      <div className="browser-body" style={{ height: ih }}>
        {frame ? <img src={`data:image/jpeg;base64,${frame.data}`} alt="" draggable={false} /> : <div className="browser-empty">正在启动浏览器…</div>}
        {showCursor && (
          <div
            key={cursor.ts}
            className={`browser-cursor ${cursor.action}`}
            style={{ left: (width - BROWSER_W * scale) / 2 + cursor.x * scale, top: cursor.y * scale }}
          />
        )}
      </div>
    </div>
  );
}

// ---------------- 编辑器：代码随模型生成逐字出现 ----------------
function EditorView({ agentId }: { agentId: string }) {
  const ed = useChannel(editors, agentId);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (ed && !ed.done) el.scrollTop = el.scrollHeight;
  }, [ed]);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [ed?.path]);
  if (!ed) return <div className="editor-view empty">（还没有打开文件）</div>;
  const lines = ed.content.split('\n');
  const html = highlight(ed.content, ed.path);
  return (
    <div className="editor-view">
      <div className="editor-tabs">
        <span className="tab active">
          {fileIcon(ed.path)} {ed.path}
          {!ed.done && <i className="dirty">●</i>}
        </span>
        <span className="editor-state">{ed.done ? `${lines.length} 行` : '正在写入…'}</span>
      </div>
      <div className="editor-body" ref={ref}>
        <pre className="gutter">{lines.map((_, i) => i + 1).join('\n')}</pre>
        <pre className="code">
          <code dangerouslySetInnerHTML={{ __html: html }} />
          {!ed.done && <span className="caret" />}
        </pre>
      </div>
    </div>
  );
}

function fileIcon(p: string) {
  if (p.endsWith('/')) return '📁';
  if (/\.(md|txt)$/.test(p)) return '📝';
  if (/\.(html?)$/.test(p)) return '🌐';
  if (/\.(css)$/.test(p)) return '🎨';
  if (/\.json$/.test(p)) return '🧾';
  return '📄';
}

// ---------------- 思考：模型输出流 ----------------
function ThinkingView({ agentId }: { agentId: string }) {
  const text = useChannel(thoughts, agentId);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  return (
    <div className="thinking-view" ref={ref}>
      <div className="thinking-head">◆ 正在思考</div>
      <div className="thinking-text">
        {text}
        <span className="caret" />
      </div>
    </div>
  );
}

function IdleView({ agentId }: { agentId: string }) {
  const agent = useStore((s) => s.agents[agentId]);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="idle-view">
      <div className="idle-logo">
        <span>AGENT</span>
        <span>FACTORY</span>
      </div>
      <div className="idle-clock">{now.toLocaleTimeString('zh-CN', { hour12: false })}</div>
      <div className="idle-sub">{agent?.paused ? '⏸ 已暂停' : '等待任务中…'}</div>
    </div>
  );
}
