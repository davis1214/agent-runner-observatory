/* Agent Runner · 实时数据订阅
 * - HTTP 部署时订阅 /api/live/stream，磁盘日志变化后自动拉取新快照
 * - file:// 或桥接未启动时保持打包快照，不发请求
 */
(function () {
  'use strict';

  const FILE_MODE = location.protocol === 'file:';
  const API = 'api/live';
  const btn = document.getElementById('live-status');
  const state = {
    mode: FILE_MODE ? 'off' : 'connecting',
    revision: '', at: null, changes: 0, error: '',
  };
  let es = null, applying = false, dirty = false, lastRevision = '', booted = false;

  function paint() {
    if (!btn) return;
    const cls = state.mode === 'live' ? 'online'
      : state.mode === 'connecting' || state.mode === 'warn' ? 'warn'
      : 'offline';
    btn.className = 'bridge-state ' + cls;
    btn.dataset.state = state.mode;
    btn.dataset.revision = state.revision || '';
    const time = state.at ? new Date(state.at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
    const text = state.mode === 'live' ? `实时 · ${time || '已连接'}`
      : state.mode === 'connecting' ? '实时连接中'
      : state.mode === 'warn' ? '实时重连中'
      : '实时离线（快照）';
    btn.innerHTML = '<span class="bs-dot"></span><span class="bs-text"></span>';
    btn.querySelector('.bs-text').textContent = text;
    btn.title = state.mode === 'off'
      ? 'file:// 模式只显示打包快照；通过 Nginx 打开才会订阅磁盘变化'
      : `SSE ${API}/stream · revision ${state.revision || '—'}${state.error ? ' · ' + state.error : ''}`;
  }

  async function pull() {
    if (FILE_MODE) return;
    if (applying) { dirty = true; return; }
    applying = true;
    try {
      const res = await fetch(`${API}/dataset`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || !Array.isArray(data.tasks) || !Array.isArray(data.agents)) throw new Error('返回结构不正确');
      if (booted && data.revision && data.revision === lastRevision) return;
      if (window.__RUNNER_LIVE_APPLY) window.__RUNNER_LIVE_APPLY(data);
      lastRevision = data.revision || lastRevision;
      booted = true;
      state.revision = data.revision || '';
      state.at = data.servedAt || new Date().toISOString();
      state.error = '';
      paint();
    } catch (e) {
      state.error = e.message || '实时数据拉取失败';
      if (state.mode === 'live') state.mode = 'warn';
      paint();
    } finally {
      applying = false;
      if (dirty) { dirty = false; pull(); }
    }
  }

  function connect() {
    if (FILE_MODE) { paint(); return; }
    if (typeof EventSource === 'undefined') {
      state.mode = 'warn';
      state.error = '浏览器不支持 EventSource';
      paint();
      return;
    }
    try { es = new EventSource(`${API}/stream`); }
    catch (e) {
      state.mode = 'warn';
      state.error = e.message || 'EventSource 创建失败';
      paint();
      return;
    }
    es.addEventListener('ready', ev => {
      let data = {};
      try { data = JSON.parse(ev.data); } catch { /* 忽略坏帧 */ }
      state.mode = 'live';
      state.error = '';
      state.revision = data.revision || state.revision;
      state.at = data.at || new Date().toISOString();
      paint();
      pull();
    });
    es.addEventListener('change', ev => {
      let data = {};
      try { data = JSON.parse(ev.data); } catch { /* 忽略坏帧 */ }
      state.mode = 'live';
      state.changes++;
      state.revision = data.revision || state.revision;
      state.at = data.at || new Date().toISOString();
      paint();
      pull();
    });
    es.onopen = () => {
      state.error = '';
      if (state.mode !== 'live') paint();
    };
    es.onerror = () => {
      if (state.mode === 'live') state.mode = 'warn';
      state.error = '事件流断开，浏览器会自动重连';
      paint();
    };
  }

  if (btn) {
    btn.addEventListener('click', () => {
      if (FILE_MODE) return;
      lastRevision = '';
      pull();
    });
  }

  paint();
  pull();
  connect();
})();
