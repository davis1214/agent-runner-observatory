#!/usr/bin/env node
/* Agent Runner · 本机真实会话采集
 * 只读扫描 Qoder CN / Codex / WorkBuddy / Trae CN / Claude Code 的本地存储。
 * 列表只返回元数据，事件在 /api/live/task 按需读取，避免把数百 MB 日志塞进快照。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HOME = os.homedir();
const ACTIVE_MS = 15 * 60 * 1000;
const WORKBUDDY_ACTIVE_MS = 30 * 60 * 1000;
const EVENT_CAP = 4000;
const DETAIL_FULL_LIMIT = 12 * 1024 * 1024;

export const REAL_AGENTS = [
  { id: 'qoder-cn', name: 'Qoder CN', vendor: 'Qoder', accent: '#c792ea', desc: 'Qoder CN 桌面端会话，含 subagent 轨迹' },
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', accent: '#60a5fa', desc: 'Codex CLI 会话' },
  { id: 'workbuddy', name: 'WorkBuddy', vendor: 'WorkBuddy', accent: '#ffb86c', desc: 'WorkBuddy 会话元数据与命令审计' },
  { id: 'trae-cn', name: 'Trae CN', vendor: 'Trae', accent: '#a3e635', desc: 'Trae CN 工作区对话' },
  { id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', accent: '#f472b6', desc: 'Claude Code 本地会话' },
];

const ROOTS = {
  qoder: process.env.OBS_QODER_DIR || path.join(HOME, '.qoder-cn', 'projects'),
  codex: process.env.OBS_CODEX_DIR || path.join(HOME, '.codex', 'sessions'),
  workbuddyDb: process.env.OBS_WORKBUDDY_DB || path.join(HOME, '.workbuddy', 'workbuddy.db'),
  workbuddyAudit: process.env.OBS_WORKBUDDY_AUDIT || path.join(HOME, '.workbuddy', 'audit-log'),
  trae: process.env.OBS_TRAE_DIR || path.join(HOME, 'Library', 'Application Support', 'Trae CN', 'User', 'workspaceStorage'),
  claude: process.env.OBS_CLAUDE_DIR || path.join(HOME, '.claude', 'projects'),
};

const INJECTED = [
  /^# AGENTS\.md/m,
  /^# Context from:/m,
  /^<environment_context>/,
  /^<user_instructions>/,
  /^<turn_aborted>/,
  /^<external_/,
  /^<send_user_message_question_reply>/,
  /^<in-app-browser-context/,
  /^<user_message>/,
  /^The following is the Codex agent history/,
  /^>>> RETAINED USER INSTRUCTIONS/,
  /^You are running as a local coding agent/,
  /^You are an AI assistant accessed via an API/,
  /^\[Request interrupted by user\]/,
  /^Caveat: The messages below were generated/,
  /^# Tools$/m,
  /^# Codex agent history/,
];

const clip = (s, n = 200) => {
  const chars = Array.from(String(s ?? '').replace(/\s+/g, ' ').trim());
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
};
const textOf = content => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => {
      if (!b || typeof b !== 'object') return String(b ?? '');
      return b.text || b.content || (b.type === 'image' ? '[image]' : '');
    }).filter(Boolean).join('\n');
  }
  return content == null ? '' : String(content);
};
const isInjected = text => INJECTED.some(re => re.test(String(text || '').trim()));
const titleFrom = text => {
  const raw = String(text || '');
  if (!raw || isInjected(raw)) return '';
  return clip(raw, 54);
};
const parseTs = v => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(v);
  if (Number.isFinite(n) && n > 1e12) return n;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
};
const basename = p => {
  const s = String(p || '').replace(/\/+$/, '');
  return s ? path.basename(s) : '';
};
function normalizeWorkspace(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  const qoder = raw.indexOf('/Documents/Qoder/');
  if (qoder >= 0) return raw.slice(0, qoder + '/Documents/Qoder'.length);
  const wb = raw.match(/^(.*\/WorkBuddy)\/\d{4}-\d{2}-\d{2}-[^/]+/);
  if (wb) return wb[1];
  return raw;
}
const workspaceOf = p => {
  const raw = normalizeWorkspace(p);
  if (!raw) return { path: '', label: '默认工作区' };
  if (raw.endsWith('/WorkBuddy')) return { path: raw, label: 'WorkBuddy 默认工作区' };
  if (raw.endsWith('/Documents/Qoder')) return { path: raw, label: 'Qoder 默认工作区' };
  return { path: raw, label: basename(raw) || raw };
};

function readSlice(fd, start, len, maxLine, dropFirst, dropLast) {
  const buf = Buffer.alloc(Math.max(0, len));
  try { fs.readSync(fd, buf, 0, len, start); } catch { return []; }
  const raw = buf.toString('utf8').split('\n');
  if (dropFirst) raw.shift();
  if (dropLast) raw.pop();
  const lines = [];
  for (const line of raw) {
    if (!line || line.length > maxLine) continue;
    if (line.trim()) lines.push(line);
  }
  return lines;
}

function readLines(file, { head = 0, tail = 0, maxLine = 2 * 1024 * 1024 } = {}) {
  let st;
  try { st = fs.statSync(file); } catch { return { lines: [], size: 0, partial: false }; }
  if (!st.isFile()) return { lines: [], size: 0, partial: false };
  const full = !head && !tail;
  if (full || (!head && st.size <= tail)) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return { lines: [], size: st.size, partial: true }; }
    try { return { lines: readSlice(fd, 0, st.size, maxLine, false, false), size: st.size, partial: false }; }
    finally { try { fs.closeSync(fd); } catch {} }
  }
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return { lines: [], size: st.size, partial: true }; }
  try {
    if (head && tail) {
      if (st.size <= head + tail) return { lines: readSlice(fd, 0, st.size, maxLine, false, false), size: st.size, partial: false };
      const first = readSlice(fd, 0, head, maxLine, false, true);
      const last = readSlice(fd, st.size - tail, tail, maxLine, true, false);
      return { lines: [...first, ...last], size: st.size, partial: true };
    }
    if (tail) return { lines: readSlice(fd, st.size - tail, tail, maxLine, true, false), size: st.size, partial: true };
    return { lines: readSlice(fd, 0, Math.min(head, st.size), maxLine, false, true), size: st.size, partial: st.size > head };
  } finally { try { fs.closeSync(fd); } catch {} }
}

function walkFiles(root, ext) {
  const out = [];
  const visit = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) visit(p, depth + 1);
      else if (e.isFile() && (!ext || p.endsWith(ext))) out.push(p);
    }
  };
  visit(root, 0);
  return out;
}

function fileCacheGet(map, file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = map.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  return { st, miss: true };
}
function fileCacheSet(map, file, st, value) {
  map.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
  return value;
}

function toolArgText(name, input) {
  if (!input || typeof input !== 'object') return clip(input, 200);
  const pick = input.command || input.file_path || input.path || input.query || input.description
    || input.prompt || input.url || input.pattern || input.content || '';
  const text = typeof pick === 'string' ? pick : JSON.stringify(pick);
  return clip(text || JSON.stringify(input), 220);
}

function artifactPath(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/i.test(name || '')) return input.file_path || input.path || '';
  if (/apply_patch/i.test(name || '')) {
    const text = String(input.patch || input.input || input || '');
    const m = text.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/m);
    return m ? m[1].trim() : '';
  }
  return '';
}

function pushEvent(list, ts, seq, src, type, data) {
  if (!list) return;
  list.push({ ts: new Date(ts || Date.now()).toISOString(), seq, src: src || 'main', type, data: data || {} });
}

function normalizeToolResult(content) {
  const text = textOf(content);
  return clip(text, 600);
}

/* 附件只保留文件名和域名。Qoder 的图片 URL 带签名参数，不能进事件、页面或日志。 */
function attachmentInfo(block) {
  const src = block?.source || {};
  const kind = block?.type === 'document' ? '附件' : '图片';
  if (src.type === 'url' && src.url) {
    try {
      const u = new URL(src.url);
      const raw = u.pathname.split('/').filter(Boolean).pop() || '';
      let name = raw;
      try { name = decodeURIComponent(raw); } catch {}
      return { name: clip(name || kind, 80), host: u.host, kind };
    } catch { return null; }
  }
  if (src.type === 'base64' || block?.type === 'image') return { name: kind === '图片' ? '粘贴图片' : '附件', host: '', kind };
  return null;
}

/* ---------------- Claude 风格（Qoder CN / Claude Code） ---------------- */

function scanClaude(file, { events = false, activeMs = ACTIVE_MS } = {}) {
  const st = fs.statSync(file);
  const useFull = !events || st.size <= DETAIL_FULL_LIMIT;
  const read = events
    ? readLines(file, useFull ? {} : { tail: 8 * 1024 * 1024 })
    : readLines(file);
  const evs = events ? [] : null;
  const artifacts = new Set();
  const artifactRows = [];
  const calls = new Map();
  let seq = 0;
  let firstTs = 0, lastTs = 0, lastHumanTs = 0, lastAssistantTs = 0;
  let lastStop = '', lastAssistantHadTool = false, lastAbortTs = 0, sawError = false;
  let title = '', lastPrompt = '', workspace = '', model = '';
  let tokens = 0, credits = 0, turns = 0, mainChain = false;

  for (const line of read.lines) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const ts = parseTs(j.timestamp) || lastTs;
    if (ts) {
      if (!firstTs) firstTs = ts;
      lastTs = ts;
    }
    if (j.cwd) workspace = j.cwd;
    if (j.type === 'workspace-directories') {
      const dirs = Array.isArray(j.directories) ? j.directories : [];
      if (dirs[0]) workspace = dirs[0];
      continue;
    }
    if (j.type === 'runtime-config') {
      if (j.model) model = j.model;
      continue;
    }
    if (j.type === 'last-prompt') {
      const lp = titleFrom(j.lastPrompt);
      if (lp) lastPrompt = lp;
      continue;
    }
    if (j.type === 'summary' && !title) {
      title = titleFrom(j.summary);
      continue;
    }
    if (j.type === 'user' || j.type === 'assistant') {
      if (j.isSidechain !== true) mainChain = true;
    }
    if (j.type === 'user') {
      const human = j.origin?.kind === 'human' || (!j.message?.content?.[0]?.type);
      const content = j.message?.content;
      const blocks = Array.isArray(content) ? content : [{ type: 'text', text: textOf(content) }];
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'image' || b.type === 'document') {
          const info = attachmentInfo(b);
          if (info) pushEvent(evs, ts, ++seq, 'main', 'attachment', info);
          continue;
        }
        if (b.type === 'tool_result') {
          const tool = calls.get(b.tool_use_id) || 'tool';
          pushEvent(evs, ts, ++seq, 'main', 'tool_result', {
            tool, status: b.is_error ? 'error' : 'ok', summary: normalizeToolResult(b.content), callId: b.tool_use_id || '',
          });
          if (b.is_error) sawError = true;
          continue;
        }
        const text = typeof b.text === 'string' ? b.text : '';
        if (!text) continue;
        if (/^\s*<turn_aborted>|^\s*\[Request interrupted by user\]/i.test(text)) lastAbortTs = ts;
        if (isInjected(text)) continue;
        if (!title) title = titleFrom(text);
        if (human || ts >= lastHumanTs) lastHumanTs = ts;
        pushEvent(evs, ts, ++seq, 'main', 'user_message', { text: clip(text, 2000) });
      }
      continue;
    }
    if (j.type === 'assistant') {
      const msg = j.message || {};
      if (msg.model) model = model || msg.model;
      const content = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: textOf(msg.content) }];
      let hasTool = false;
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text) {
          pushEvent(evs, ts, ++seq, 'main', 'assistant_message', { text: clip(b.text, 2000), model: msg.model || '' });
        } else if (b.type === 'thinking' && b.thinking) {
          pushEvent(evs, ts, ++seq, 'main', 'thinking', { text: clip(b.thinking, 800) });
        } else if (b.type === 'tool_use') {
          hasTool = true;
          calls.set(b.id, b.name || 'tool');
          pushEvent(evs, ts, ++seq, 'main', 'tool_call', {
            tool: b.name || 'tool', args: toolArgText(b.name, b.input), input: clip(JSON.stringify(b.input || {}), 1200), callId: b.id || '',
          });
          const p = artifactPath(b.name, b.input);
          if (p && !artifacts.has(p)) {
            artifacts.add(p);
            artifactRows.push({ path: p, ts });
            pushEvent(evs, ts, ++seq, 'main', 'result_emitted', {
              path: p, summary: `${/Write/i.test(b.name) ? '写入' : '编辑'}文件`, created_by: 'main',
            });
          }
        }
      }
      lastAssistantTs = ts;
      lastStop = msg.stop_reason || '';
      lastAssistantHadTool = hasTool;
      turns++;
      const u = msg.usage || {};
      const total = Number(u.input_tokens || 0) + Number(u.output_tokens || 0)
        + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0);
      if (total || u.credits) {
        tokens += total;
        credits += Number(u.credits) || 0;
        pushEvent(evs, ts, ++seq, 'main', 'token_usage', {
          input_tokens: Number(u.input_tokens || 0), output_tokens: Number(u.output_tokens || 0),
          total_tokens: total, credits: Number(u.credits) || 0,
        });
      }
      continue;
    }
    if (j.type === 'system') {
      const text = textOf(j.content || j.message?.content || '');
      if (/api error|rate limit|overloaded|error/i.test(j.subtype || '') || /api error/i.test(text)) {
        sawError = true;
        pushEvent(evs, ts, ++seq, 'main', 'error', { error: clip(text || j.subtype || 'API error', 300) });
      }
    }
  }

  const abortedNow = lastAbortTs > 0 && lastAbortTs >= Math.max(lastAssistantTs, lastHumanTs);
  const status = abortedNow ? 'canceled'
    : lastAssistantTs > 0 && lastHumanTs <= lastAssistantTs && (['end_turn', 'stop_sequence'].includes(lastStop) || (!lastStop && !lastAssistantHadTool))
      ? 'completed'
    : nowSince(lastTs) < activeMs ? 'running'
    : 'idle';

  return {
    title: lastPrompt || title, workspace, model, status,
    startedAt: firstTs || st.birthtimeMs || st.mtimeMs,
    endedAt: lastTs || st.mtimeMs,
    createdAt: st.birthtimeMs || firstTs || st.mtimeMs,
    updatedAt: st.mtimeMs,
    tokens, credits, turns,
    artifacts: artifactRows,
    events: evs,
    mainChain,
    partial: read.partial,
    lineCount: read.lines.length,
    transcript: file,
  };
}

function nowSince(ts) { return Date.now() - (ts || 0); }

function scanClaudeSubagents(projectDir, sessionId) {
  const dirs = [
    path.join(projectDir, sessionId, 'subagents'),
    path.join(projectDir, 'subagents'),
  ];
  const dir = dirs.find(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (!dir) return [];
  const rows = [];
  for (const file of fs.readdirSync(dir).filter(f => /^task-.*\.json$/.test(f))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const transcript = j.transcriptPath && fs.existsSync(j.transcriptPath) ? j.transcriptPath : '';
      rows.push({
        id: j.agentId || j.taskId || file.replace(/\.json$/, ''),
        label: clip(j.description || j.agentType || 'subagent', 46),
        type: j.agentType || 'subagent',
        model: j.resolvedModel || '',
        status: j.status || 'unknown',
        startedAt: parseTs(j.createdAt) || 0,
        endedAt: parseTs(j.updatedAt) || 0,
        summary: clip(j.result || j.summary || '', 400),
        transcript,
      });
    } catch {}
  }
  return rows.sort((a, b) => a.startedAt - b.startedAt);
}

/* ---------------- Codex ---------------- */

function scanCodex(file, { events = false, titleHint = '' } = {}) {
  const st = fs.statSync(file);
  const useFull = !events || st.size <= DETAIL_FULL_LIMIT;
  const read = events
    ? readLines(file, useFull ? {} : { tail: 8 * 1024 * 1024 })
    : readLines(file, st.size <= 1024 * 1024 ? {} : { head: 192 * 1024, tail: 192 * 1024 });
  const evs = events ? [] : null;
  const artifacts = new Set();
  const artifactRows = [];
  const calls = new Map();
  let seq = 0;
  let firstTs = 0, lastTs = 0, lastHumanTs = 0, lastAssistantTs = 0;
  let completed = false, aborted = false, sawError = false;
  let title = titleHint, workspace = '', model = '', sessionId = path.basename(file, '.jsonl');
  let tokens = 0, turns = 0;

  for (const line of read.lines) {
    if (line.includes('"encrypted_content"')) {
      const quick = line.match(/"timestamp":"([^"]+)"/);
      if (quick) { const t = parseTs(quick[1]); if (t) { if (!firstTs) firstTs = t; lastTs = t; } }
      continue;
    }
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const ts = parseTs(j.timestamp) || lastTs;
    if (ts) { if (!firstTs) firstTs = ts; lastTs = ts; }
    if (j.type === 'session_meta') {
      workspace = j.payload?.cwd || workspace;
      sessionId = j.payload?.id || sessionId;
      continue;
    }
    if (j.type === 'event_msg') {
      const p = j.payload || {};
      if (p.type === 'thread_settings_applied') model = p.thread_settings?.model || model;
      if (p.type === 'task_started') {
        aborted = false;
        pushEvent(evs, ts, ++seq, 'main', 'turn_started', { turn: clip(p.turn_id || '', 40), model: p.model || '' });
      }
      if (p.type === 'user_message' && p.message) {
        const text = String(p.message);
        if (!isInjected(text)) {
          if (!title) title = titleFrom(text);
          lastHumanTs = ts;
          pushEvent(evs, ts, ++seq, 'main', 'user_message', { text: clip(text, 2000) });
        }
      }
      if (p.type === 'token_count') {
        const total = p.info?.total_token_usage?.total_tokens || 0;
        const last = p.info?.last_token_usage || {};
        tokens = Math.max(tokens, Number(total) || 0);
        pushEvent(evs, ts, ++seq, 'main', 'token_usage', {
          input_tokens: Number(last.input_tokens || 0), output_tokens: Number(last.output_tokens || 0),
          total_tokens: Number(total) || 0, credits: 0,
        });
      }
      if (p.type === 'task_complete') { completed = true; aborted = false; }
      if (p.type === 'turn_aborted') { aborted = true; completed = false; }
      if (p.type === 'error') {
        sawError = true;
        pushEvent(evs, ts, ++seq, 'main', 'error', { error: clip(p.message || p.error || 'Codex error', 300) });
      }
      continue;
    }
    if (j.type === 'response_item') {
      const p = j.payload || {};
      if (p.type === 'message') {
        const text = textOf(p.content);
        if (!text) continue;
        if (p.role === 'user') {
          if (isInjected(text)) continue;
          if (!title) title = titleFrom(text);
          lastHumanTs = ts;
          pushEvent(evs, ts, ++seq, 'main', 'user_message', { text: clip(text, 2000) });
        } else if (p.role === 'assistant') {
          lastAssistantTs = ts;
          turns++;
          pushEvent(evs, ts, ++seq, 'main', 'assistant_message', { text: clip(text, 2000), model });
        }
        continue;
      }
      if (p.type === 'reasoning') {
        const summary = (p.summary || []).map(x => x.text || '').filter(Boolean).join('\n');
        if (summary) pushEvent(evs, ts, ++seq, 'main', 'thinking', { text: clip(summary, 800) });
        continue;
      }
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        let input = p.arguments ?? p.input ?? '';
        try { if (typeof input === 'string') input = JSON.parse(input); } catch {}
        const name = p.name || 'tool';
        calls.set(p.call_id || p.id, name);
        pushEvent(evs, ts, ++seq, 'main', 'tool_call', {
          tool: name, args: toolArgText(name, input), input: clip(JSON.stringify(input || {}), 1200), callId: p.call_id || p.id || '',
        });
        const artifact = artifactPath(name, input);
        if (artifact && !artifacts.has(artifact)) {
          artifacts.add(artifact);
          artifactRows.push({ path: artifact, ts });
          pushEvent(evs, ts, ++seq, 'main', 'result_emitted', { path: artifact, summary: '补丁写入', created_by: 'main' });
        }
        continue;
      }
      if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const output = textOf(p.output);
        const tool = calls.get(p.call_id) || 'tool';
        pushEvent(evs, ts, ++seq, 'main', 'tool_result', {
          tool, status: /error|failed|exit code [1-9]/i.test(output) ? 'error' : 'ok',
          summary: clip(output, 600), callId: p.call_id || '',
        });
      }
    }
  }

  const status = aborted ? 'canceled'
    : completed ? 'completed'
    : nowSince(lastTs) < ACTIVE_MS ? 'running'
    : 'idle';

  return {
    title, workspace, model, status,
    startedAt: firstTs || st.birthtimeMs || st.mtimeMs,
    endedAt: lastTs || st.mtimeMs,
    createdAt: st.birthtimeMs || firstTs || st.mtimeMs,
    updatedAt: st.mtimeMs,
    tokens, credits: 0, turns, sessionId,
    artifacts: artifactRows,
    events: evs,
    partial: read.partial,
    lineCount: read.lines.length,
    transcript: file,
  };
}

/* ---------------- WorkBuddy ---------------- */

function openDb(file) {
  if (!fs.existsSync(file)) return null;
  try { return new DatabaseSync(file, { readOnly: true }); } catch { return null; }
}

function workbuddyRows() {
  const db = openDb(ROOTS.workbuddyDb);
  if (!db) return { rows: [], usage: new Map(), available: false };
  try {
    const rows = db.prepare(`SELECT id, cwd, title, custom_title, status, created_at, updated_at,
      last_activity_at, model, deleted_at FROM sessions
      WHERE deleted_at IS NULL OR deleted_at = -1
      ORDER BY COALESCE(last_activity_at, updated_at, created_at) DESC`).all();
    const usage = new Map();
    try {
      for (const u of db.prepare('SELECT session_id, used, size, updated_at, credit_json FROM session_usage').all()) {
        let credits = 0;
        try {
          const c = typeof u.credit_json === 'string' ? JSON.parse(u.credit_json) : u.credit_json;
          if (c && typeof c === 'object') credits = Object.values(c).reduce((n, v) => n + (Number(v) || 0), 0);
        } catch {}
        usage.set(u.session_id, { tokens: Number(u.used) || 0, size: Number(u.size) || 0, credits, updatedAt: Number(u.updated_at) || 0 });
      }
    } catch {}
    return { rows, usage, available: true };
  } finally {
    try { db.close(); } catch {}
  }
}

let auditCache = { at: 0, sig: '', map: new Map() };
function workbuddyAudit() {
  const files = walkFiles(ROOTS.workbuddyAudit, '.jsonl');
  const sig = files.map(f => { try { const s = fs.statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return f; } }).join('|');
  if (Date.now() - auditCache.at < 30_000 && auditCache.sig === sig) return auditCache.map;
  const map = new Map();
  for (const file of files) {
    const { lines } = readLines(file, { maxLine: 512 * 1024 });
    for (const line of lines) {
      let j; try { j = JSON.parse(line); } catch { continue; }
      const sid = j.sessionId;
      if (!sid) continue;
      if (!map.has(sid)) map.set(sid, []);
      const list = map.get(sid);
      if (list.length >= 800) continue;
      list.push({
        ts: parseTs(j.timestamp) || 0,
        eventType: j.eventType || j.category || 'audit',
        category: j.category || '',
        command: clip(j.commandPreview || j.messageParams?.command || '', 300),
        decision: j.decision || '',
      });
    }
  }
  auditCache = { at: Date.now(), sig, map };
  return map;
}

function workbuddyStatus(row, usage) {
  const last = Number(row.last_activity_at || row.updated_at || row.created_at) || 0;
  const status = String(row.status || '').toLowerCase();
  if (status === 'completed') return 'completed';
  if (status === 'error' || status === 'failed') return 'failed';
  if (status === 'working' || status === 'running') return nowSince(last) < WORKBUDDY_ACTIVE_MS ? 'running' : 'idle';
  if (status === 'archived') return 'idle';
  return nowSince(last) < WORKBUDDY_ACTIVE_MS ? 'running' : 'idle';
}

/* ---------------- Trae CN ---------------- */

function traeSessions() {
  const base = ROOTS.trae;
  if (!fs.existsSync(base)) return { rows: [], available: false };
  const rows = [];
  let available = true;
  for (const hash of fs.readdirSync(base)) {
    const dbFile = path.join(base, hash, 'state.vscdb');
    if (!fs.existsSync(dbFile)) continue;
    let folder = '';
    try { folder = JSON.parse(fs.readFileSync(path.join(base, hash, 'workspace.json'), 'utf8')).folder || ''; } catch {}
    if (folder.startsWith('file://')) {
      try { folder = decodeURIComponent(folder.replace(/^file:\/\//, '')); } catch {}
    }
    const db = openDb(dbFile);
    if (!db) continue;
    try {
      const keys = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'memento/icube-ai-ng-chat-storage%'").all();
      const seen = new Set();
      for (const k of keys) {
        let data;
        try { data = JSON.parse(typeof k.value === 'string' ? k.value : k.value.toString('utf8')); } catch { continue; }
        for (const s of data.list || []) {
          if (!s || !s.sessionId || seen.has(s.sessionId)) continue;
          seen.add(s.sessionId);
          const messages = Array.isArray(s.messages) ? s.messages : [];
          if (!messages.length) continue;
          const times = messages.map(m => Number(m.timestamp) || 0).filter(Boolean);
          const first = times[0] || 0, last = times[times.length - 1] || 0;
          const firstUser = messages.find(m => m.role === 'user');
          const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
          const model = (lastAssistant && lastAssistant.displayModelName) || (firstUser && firstUser.displayModelName) || '';
          const status = lastAssistant && ['canceled', 'cancelled', 'error'].includes(String(lastAssistant.status || '').toLowerCase())
            ? 'canceled' : 'completed';
          rows.push({
            id: `trae-${s.sessionId}`,
            source: { kind: 'trae-cn', label: 'Trae CN', file: dbFile, sessionId: s.sessionId, workspace: folder },
            title: titleFrom(firstUser?.content) || clip(s.sessionId, 40),
            workspace: folder, model, status,
            startedAt: first || 0, endedAt: last || first || 0,
            createdAt: first || 0, updatedAt: last || first || 0,
            messages,
          });
        }
      }
    } catch { available = false; } finally { try { db.close(); } catch {} }
  }
  return { rows, available };
}

function traeSessionById(id) {
  const { rows } = traeSessions();
  return rows.find(r => r.id === id) || null;
}

/* ---------------- 统一任务 ---------------- */

function makeTask({ id, agent, title, workspace, model, status, startedAt, endedAt, createdAt, updatedAt, tokens, credits, results, subCount, agentCount, source, partial }) {
  const ws = workspaceOf(workspace);
  const total = Array.isArray(results) ? results.length : Number(results) || 0;
  const start = startedAt || createdAt || Date.now();
  const end = Math.max(start, endedAt || updatedAt || start);
  const counts = { pass: 0, fail: 0, pending: total, total };
  const preview = {
    status, startedAt: start, endedAt: end, durationMs: end - start,
    createdAt: createdAt || start, updatedAt: updatedAt || end,
    tokens: Number(tokens) || 0, credits: Number(credits) || 0,
    cost: 0, costUnit: credits ? 'credits' : 'usd',
    counts, agentCount: agentCount || 1, subCount: subCount || 0,
    partial: !!partial,
  };
  return {
    id, agent, title: title || '未命名任务', repo: ws.label,
    workspace: ws.path, workspaceLabel: ws.label, workspacePath: ws.path,
    model: model || '—', status, startedAt: start, endedAt: end,
    durationMs: end - start, createdAt: preview.createdAt, updatedAt: preview.updatedAt,
    cost: 0, credits: preview.credits, costUnit: preview.costUnit,
    tokens: preview.tokens, counts, agentCount: preview.agentCount, subCount: preview.subCount,
    preview, source, real: true,
  };
}

/* 兜底：任何来源出现重复 id 都按文件路径加稳定短哈希，避免详情按 id 查错任务。 */
function shortHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

function uniqueTaskIds(tasks) {
  const counts = new Map();
  for (const t of tasks) counts.set(t.id, (counts.get(t.id) || 0) + 1);
  for (const t of tasks) {
    if ((counts.get(t.id) || 0) < 2) continue;
    t.id = `${t.id}-${shortHash(t.source?.file || t.id)}`;
  }
  return tasks;
}

function qoderTasks(files, cache) {
  const out = [];
  for (const { file } of files) {
    const projectDir = path.dirname(file);
    const sessionId = path.basename(file, '.jsonl');
    const scan = fileCacheGet(cache, file);
    let meta;
    if (scan && scan.miss) {
      try {
        meta = scanClaude(file, { events: false });
        fileCacheSet(cache, file, scan.st, meta);
      } catch { continue; }
    } else if (scan) meta = scan;
    else continue;
    const subs = scanClaudeSubagents(projectDir, sessionId);
    const stateFile = path.join(projectDir, sessionId, 'state.json');
    let state = null;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    const createdAt = parseTs(state?.createdAt) || meta.createdAt;
    const updatedAt = parseTs(state?.updatedAt) || meta.updatedAt;
    const status = meta.status;
    out.push(makeTask({
      id: `qcn-${sessionId}`, agent: 'qoder-cn',
      title: meta.title || `${basename(projectDir)} · ${sessionId.slice(0, 8)}`,
      workspace: meta.workspace, model: meta.model, status,
      startedAt: meta.startedAt, endedAt: meta.endedAt, createdAt, updatedAt,
      tokens: meta.tokens, credits: meta.credits,
      results: meta.artifacts, subCount: subs.length, agentCount: 1 + subs.length,
      source: { kind: 'qoder-cn', label: 'Qoder CN', file, sessionId },
      partial: meta.partial,
    }));
  }
  return out;
}

function codexTasks(files, cache) {
  const out = [];
  for (const file of files) {
    const scan = fileCacheGet(cache, file);
    let meta;
    if (scan && scan.miss) {
      try {
        meta = scanCodex(file);
        fileCacheSet(cache, file, scan.st, meta);
      } catch { continue; }
    } else if (scan) meta = scan;
    else continue;
    const fallback = `${basename(meta.workspace) || 'Codex'} · ${new Date(meta.startedAt).toISOString().slice(5, 16).replace('T', ' ')}`;
    /* Codex 恢复会话会新建 rollout 文件但沿用原 session id；文件名里的第二个 UUID
     * 才是该次恢复的唯一标识，不加后缀会让多个任务共用 id、详情互相串线。 */
    const resume = path.basename(file, '.jsonl').split('_')[1] || '';
    out.push(makeTask({
      id: `codex-${meta.sessionId}${resume ? `-${resume.slice(0, 8)}` : ''}`, agent: 'codex',
      title: meta.title || fallback, workspace: meta.workspace, model: meta.model, status: meta.status,
      startedAt: meta.startedAt, endedAt: meta.endedAt, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
      tokens: meta.tokens, credits: 0, results: meta.artifacts, subCount: 0, agentCount: 1,
      source: { kind: 'codex', label: 'Codex', file, sessionId: meta.sessionId },
      partial: meta.partial,
    }));
  }
  return out;
}

function claudeTasks(files, cache) {
  const out = [];
  for (const file of files) {
    const hit = fileCacheGet(cache, file);
    let meta;
    if (hit && hit.miss) {
      try {
        meta = scanClaude(file, { events: false });
        fileCacheSet(cache, file, hit.st, meta);
      } catch { continue; }
    } else if (hit) meta = hit;
    else continue;
    if (!meta.mainChain) continue;
    const sessionId = path.basename(file, '.jsonl');
    const fallback = `${basename(meta.workspace) || 'Claude Code'} · ${new Date(meta.startedAt).toISOString().slice(5, 16).replace('T', ' ')}`;
    out.push(makeTask({
      id: `cc-${sessionId}`, agent: 'claude-code',
      title: meta.title || fallback, workspace: meta.workspace, model: meta.model, status: meta.status,
      startedAt: meta.startedAt, endedAt: meta.endedAt, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
      tokens: meta.tokens, credits: meta.credits, results: meta.artifacts, subCount: 0, agentCount: 1,
      source: { kind: 'claude-code', label: 'Claude Code', file, sessionId },
      partial: meta.partial,
    }));
  }
  return out;
}

function workbuddyTasks() {
  const { rows, usage, available } = workbuddyRows();
  const audit = workbuddyAudit();
  return {
    available,
    tasks: rows.map(row => {
      const u = usage.get(row.id) || {};
      const last = Number(row.last_activity_at || row.updated_at || row.created_at) || 0;
      return makeTask({
        id: `wb-${row.id}`, agent: 'workbuddy',
        title: titleFrom(row.custom_title || row.title) || clip(row.id, 40),
        workspace: row.cwd || '', model: row.model || '', status: workbuddyStatus(row, u),
        startedAt: Number(row.created_at) || last, endedAt: last, createdAt: Number(row.created_at) || last, updatedAt: last,
        tokens: u.tokens || 0, credits: u.credits || 0, results: [], subCount: 0, agentCount: 1,
        source: { kind: 'workbuddy', label: 'WorkBuddy', sessionId: row.id, file: ROOTS.workbuddyDb },
        partial: true,
      });
    }),
  };
}

function traeTasks() {
  const { rows, available } = traeSessions();
  return {
    available,
    tasks: rows.map(s => makeTask({
      id: s.id, agent: 'trae-cn', title: s.title, workspace: s.workspace, model: s.model, status: s.status,
      startedAt: s.startedAt, endedAt: s.endedAt, createdAt: s.createdAt, updatedAt: s.updatedAt,
      tokens: 0, credits: 0, results: 0, subCount: 0, agentCount: 1,
      source: { kind: 'trae-cn', label: 'Trae CN', file: s.source.file, sessionId: s.source.sessionId },
      partial: false,
    })),
  };
}

/* ---------------- 详情事件 ---------------- */

function detailClaudeLike(task, { subs = false } = {}) {
  const file = task.source.file;
  const scan = scanClaude(file, { events: true });
  let events = scan.events || [];
  if (subs) {
    const projectDir = path.dirname(file);
    const subRows = scanClaudeSubagents(projectDir, task.source.sessionId);
    let i = 0;
    for (const sub of subRows) {
      i++;
      const subId = `sub-${sub.id}`;
      pushEvent(events, sub.startedAt || task.startedAt, 0, 'main', 'agent_spawned', {
        agent: subId, role: 'subagent', label: sub.label, model: sub.model || scan.model,
        task: sub.label, step: i,
      });
      if (sub.transcript) {
        try {
          const inner = scanClaude(sub.transcript, { events: true });
          for (const e of inner.events || []) {
            if (e.type === 'session_start') continue;
            events.push({ ...e, src: subId });
          }
          for (const a of inner.artifacts) {
            if (!events.some(e => e.type === 'result_emitted' && e.data?.path === a.path)) {
              pushEvent(events, a.ts, 0, subId, 'result_emitted', { path: a.path, summary: 'subagent 产物', created_by: subId });
            }
          }
        } catch {}
      }
      pushEvent(events, sub.endedAt || scan.endedAt, 0, 'main', 'agent_finished', {
        agent: subId, status: String(sub.status || 'done').toLowerCase() === 'completed' ? 'done' : sub.status || 'done',
      });
    }
  }
  return finalize(events, task, scan);
}

function detailCodex(task) {
  const scan = scanCodex(task.source.file, { events: true, titleHint: task.title });
  return finalize(scan.events || [], task, scan);
}

function detailWorkbuddy(task) {
  const events = [];
  pushEvent(events, task.startedAt, 0, 'main', 'session_start', {
    task: task.title, model: task.model, workspace: task.workspace, source: 'WorkBuddy',
  });
  pushEvent(events, task.startedAt, 0, 'main', 'notice', {
    text: 'WorkBuddy 本地库只保存会话元数据、用量与命令审计，聊天正文没有落库；这里展示可读到的审计线索。',
  });
  const audit = workbuddyAudit().get(String(task.source.sessionId)) || [];
  for (const a of audit) {
    if (a.command) {
      pushEvent(events, a.ts, 0, 'main', 'tool_call', { tool: a.category || 'shell', args: a.command, callId: '' });
      pushEvent(events, a.ts + 1, 0, 'main', 'tool_result', { tool: a.category || 'shell', status: a.decision === 'denied' ? 'error' : 'ok', summary: a.decision || a.eventType, callId: '' });
    }
  }
  return finalize(events, task, { status: task.status, endedAt: task.endedAt });
}

function detailTrae(task) {
  const row = traeSessionById(task.id);
  const events = [];
  if (!row) {
    pushEvent(events, task.startedAt, 0, 'main', 'notice', { text: 'Trae CN 会话已不在当前数据库中。' });
    return finalize(events, task, { status: task.status, endedAt: task.endedAt });
  }
  for (const m of row.messages) {
    const ts = Number(m.timestamp) || task.startedAt;
    if (m.role === 'user') {
      if (!isInjected(m.content)) pushEvent(events, ts, 0, 'main', 'user_message', { text: clip(m.content, 2000) });
    } else if (m.role === 'assistant') {
      pushEvent(events, ts, 0, 'main', 'assistant_message', { text: clip(m.content, 2000), model: m.displayModelName || row.model });
    }
  }
  return finalize(events, task, { status: task.status, endedAt: task.endedAt });
}

function finalize(raw, task, scan) {
  let events = raw.filter(Boolean);
  events.sort((a, b) => (parseTs(a.ts) - parseTs(b.ts)) || String(a.src).localeCompare(String(b.src)));
  while (events.length > EVENT_CAP) {
    const head = Math.floor(EVENT_CAP * 0.15);
    events = [...events.slice(0, head), ...events.slice(-(EVENT_CAP - head))];
  }
  const status = task.status || scan.status || 'idle';
  if (!events.some(e => e.type === 'session_start')) {
    events.unshift({
      ts: new Date(task.startedAt).toISOString(), seq: 0, src: 'main', type: 'session_start',
      data: { task: task.title, model: task.model, workspace: task.workspace, source: task.source?.label || '' },
    });
  }
  if (status !== 'running' && !events.some(e => e.type === 'agent_finished' && (e.data?.agent === 'main' || (!e.data?.agent && e.src === 'main')))) {
    events.push({
      ts: new Date(task.endedAt).toISOString(), seq: 0, src: 'main', type: 'agent_finished',
      data: { agent: 'main', status },
    });
  }
  events = events.map((e, i) => ({ ...e, seq: i + 1 }));
  if (scan?.partial) {
    events.push({
      ts: new Date(task.endedAt).toISOString(), seq: events.length + 1, src: 'main', type: 'notice',
      data: { text: '原始日志较大，详情只载入最近的事件；更早的工具调用与产物可能未列出。' },
    });
  }
  return { events, transcript: scan?.transcript || task.source?.file || '', partial: !!scan?.partial, lines: scan?.lineCount || 0 };
}

/* ---------------- 对外接口 ---------------- */

export function createRealSource() {
  const qoderCache = new Map(), codexCache = new Map(), claudeCache = new Map();
  let cache = { at: 0, sig: '', value: null };

  const qoderFiles = () => {
    const out = [];
    if (!fs.existsSync(ROOTS.qoder)) return out;
    for (const project of fs.readdirSync(ROOTS.qoder)) {
      const dir = path.join(ROOTS.qoder, project);
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const f of entries) {
        if (f.endsWith('.jsonl')) out.push({ file: path.join(dir, f), kind: 'qoder' });
      }
    }
    return out;
  };

  function sourceSignature() {
    const files = [
      ...qoderFiles().map(x => x.file),
      ...walkFiles(ROOTS.codex, '.jsonl'),
      ...walkFiles(ROOTS.claude, '.jsonl'),
      ROOTS.workbuddyDb,
      ...walkFiles(ROOTS.workbuddyAudit, '.jsonl'),
      ...walkFiles(ROOTS.trae, 'state.vscdb'),
    ];
    let total = 0, max = 0, count = 0;
    for (const f of files) {
      try { const s = fs.statSync(f); if (!s.isFile()) continue; total += s.size; max = Math.max(max, s.mtimeMs); count++; } catch {}
    }
    return `${count}-${total}-${max.toFixed(3)}`;
  }

  function build() {
    const qFiles = qoderFiles();
    const codexFiles = walkFiles(ROOTS.codex, '.jsonl').filter(f => !f.includes('/archived_sessions/'));
    const claudeFiles = walkFiles(ROOTS.claude, '.jsonl');
    const qoder = qoderTasks(qFiles, qoderCache);
    const codex = codexTasks(codexFiles, codexCache);
    const claude = claudeTasks(claudeFiles, claudeCache);
    const wb = workbuddyTasks();
    const trae = traeTasks();
    const tasks = uniqueTaskIds([...qoder, ...codex, ...wb.tasks, ...trae.tasks, ...claude]);
    const counts = {
      'qoder-cn': qoder.length, codex: codex.length, workbuddy: wb.tasks.length,
      'trae-cn': trae.tasks.length, 'claude-code': claude.length,
    };
    const sources = REAL_AGENTS.map(a => ({
      id: a.id, name: a.name, count: counts[a.id] || 0,
      available: a.id === 'workbuddy' ? wb.available
        : a.id === 'trae-cn' ? trae.available
        : a.id === 'qoder-cn' ? fs.existsSync(ROOTS.qoder)
        : a.id === 'codex' ? fs.existsSync(ROOTS.codex)
        : fs.existsSync(ROOTS.claude),
      path: a.id === 'qoder-cn' ? ROOTS.qoder
        : a.id === 'codex' ? ROOTS.codex
        : a.id === 'workbuddy' ? ROOTS.workbuddyDb
        : a.id === 'trae-cn' ? ROOTS.trae
        : ROOTS.claude,
    }));
    const workspaces = new Map();
    for (const t of tasks) {
      const key = t.workspacePath || '__default__';
      const w = workspaces.get(key) || { path: t.workspacePath || '', label: t.workspaceLabel || '默认工作区', count: 0, agents: new Set() };
      w.count++; w.agents.add(t.agent);
      workspaces.set(key, w);
    }
    return {
      tasks,
      sources,
      workspaces: [...workspaces.values()].map(w => ({ ...w, agents: [...w.agents] }))
        .sort((a, b) => (a.path ? 1 : -1) - (b.path ? 1 : -1) || b.count - a.count),
      builtAt: new Date().toISOString(),
      revision: sourceSignature(),
    };
  }

  function catalog() {
    const sig = sourceSignature();
    if (cache.value && Date.now() - cache.at < 5000 && cache.sig === sig) return cache.value;
    const value = build();
    cache = { at: Date.now(), sig: value.revision, value };
    return value;
  }

  function revision() {
    return catalog().revision;
  }

  function readTask(id) {
    const cat = catalog();
    const task = cat.tasks.find(t => t.id === id);
    if (!task) return null;
    let detail;
    if (task.agent === 'qoder-cn') detail = detailClaudeLike(task, { subs: true });
    else if (task.agent === 'claude-code') detail = detailClaudeLike(task, { subs: true });
    else if (task.agent === 'codex') detail = detailCodex(task);
    else if (task.agent === 'workbuddy') detail = detailWorkbuddy(task);
    else if (task.agent === 'trae-cn') detail = detailTrae(task);
    else detail = { events: [] };
    return {
      task: { ...task, preview: { ...task.preview } },
      ...detail,
      servedAt: new Date().toISOString(),
    };
  }

  return { catalog, revision, readTask, roots: ROOTS };
}
