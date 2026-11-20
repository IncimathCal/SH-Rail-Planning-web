// 编辑器主逻辑（阶段 2 MVP，仅本地使用，永不部署）。
// 数据纪律（见《架构方案-01》§0）：
//   - 换乘编组绝不按站名自动合并，就近提示仅视觉参考；
//   - 编号分配后永不复用（设站用 meta.stopSeq 水位，线/组用持久计数器）；
//   - 数据文件结构字段全英文，中文仅在 name/aliases/info/note/sourceLayer 值中。
(function (global) {
  'use strict';

  // ---------- 纯逻辑层（无 DOM 依赖，node 单测覆盖：tools/test_editor_logic.js） ----------
  const SEG_ORDER = ['existing', 'approved', 'future'];
  const SEG_LABEL = { existing: '既有', approved: '已批复', future: '远期' };
  const ROLE_LABEL = { standalone: '独立', main: '主线', branch: '支线', connector: '联络线' };
  const EPS = 1e-4;          // t 最小间隔

  /** 加站后的分段表调整（stops 已含新站，i 为其下标）。
   *  中间插入分裂原段（继承状态）；端部延伸新增段默认 existing；环线环绕段同理。
   *  判定一律以站数为准（段数不变量：非环线 = 站数-1，环线 = 站数）。 */
  function segInsert(line, i) {
    const segs = line.segments;
    const n = line.stops.length;   // 已含新站
    if (line.loop) {
      if (n === 1) segs.push('existing');
      else if (i === 0) segs.splice(segs.length - 1, 1, segs[segs.length - 1], segs[segs.length - 1]); // 分裂环绕段（两半均继承）
      else segs.splice(i - 1, 1, segs[i - 1], segs[i - 1]);
    } else {
      if (n === 1) { /* 非环线 1 站 = 0 段 */ }
      else if (i === 0) segs.unshift('existing');          // 首位延伸，新段在最前
      else if (i === n - 1) segs.push('existing');         // 末端延伸
      else segs.splice(i - 1, 1, segs[i - 1], segs[i - 1]);
    }
  }

  /** 删站前的分段表调整（stops 尚未移除，i 为待删下标）。
   *  相邻两段合并，保留 seg[i] 状态；环线 n=1 清空。 */
  function segRemove(line, i) {
    const segs = line.segments;
    const n = line.stops.length;
    if (line.loop) {
      if (n === 1) segs.length = 0;
      else {
        // seg[j] 连接 stop j → (j+1)%n；删 stop i 合并 seg[(i-1+n)%n] 与 seg[i]
        const other = (i - 1 + n) % n;
        const merged = segs[i];
        segs.splice(Math.max(i, other), 1);
        segs.splice(Math.min(i, other), 1, merged);
      }
    } else {
      if (i === 0) segs.shift();
      else if (i === n - 1) segs.pop();
      else { const merged = segs[i]; segs.splice(i - 1, 2, merged); }
    }
  }

  /** 分配下一个设站序号（水位 = max(meta.stopSeq, 现有最大后缀) + 1，编号永不复用） */
  function nextStopSeq(line) {
    let m = line.meta.stopSeq || 0;
    for (const st of line.stops) {
      const n = parseInt(st.id.split('-s')[1], 10);
      if (!isNaN(n) && n > m) m = n;
    }
    line.meta.stopSeq = m + 1;
    return line.meta.stopSeq;
  }

  /** 站数跨过 2 的边界时，线路级 status 字段自动修正 */
  function fixStatusField(line) {
    if (line.stops.length >= 2) line.status = null;
    else if (!line.status) line.status = 'future';
  }

  /** 保存前客户端自检（与 validate.py 规则对应的子集） */
  function lineIssues(l) {
    const issues = [];
    l.stops.forEach((st, i) => {
      if (!st.name || !st.name.trim()) issues.push(`${st.id} 站名为空`);
      if (i > 0 && st.t <= l.stops[i - 1].t) issues.push(`${st.id} t 未递增`);
    });
    const want = l.loop ? l.stops.length : Math.max(l.stops.length - 1, 0);
    if (l.segments.length !== want) issues.push(`segments 长度 ${l.segments.length} ≠ 应为 ${want}`);
    if (l.stops.length < 2 && !l.status) issues.push('站数<2 但未设线路级 status');
    if (l.stops.length >= 2 && l.status) issues.push('站数≥2 时 status 应为 null');
    if ((l.role === 'main' || l.role === 'branch') && !l.groupId) issues.push('main/branch 必须有线组');
    if (l.role === 'connector' && (!l.connects || l.connects.length < 2)) issues.push('connector 需 connects ≥ 2');
    if (l.role !== 'connector' && l.connects && l.connects.length) issues.push('非 connector 的 connects 应为空');
    return issues;
  }

  const SHLogic = { SEG_ORDER, SEG_LABEL, ROLE_LABEL, EPS, segInsert, segRemove,
    nextStopSeq, fixStatusField, lineIssues };
  global.SHEditorLogic = SHLogic;
  if (typeof module !== 'undefined' && module.exports) module.exports = SHLogic;

  // ---------- 以下需要浏览器 DOM（node 测试模式到此为止） ----------
  if (typeof document === 'undefined') return;

  const G = global.SHGeom;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const svg = $('view');
  const world = $('world');
  const statusEl = $('status');

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const LS_KEY = 'shrail.editor.v1';

  // ---------- 状态 ----------
  const S = {
    lines: new Map(),        // lid -> line 对象（fmt/line@1，可直接序列化）
    groups: null,            // fmt/groups@1 或 null（首份保存时初始化）
    manifest: null,          // fmt/manifest@1 或 null
    imports: [],             // {source, imported, paths:[{sourceLayer,color,path}]}
    arcs: new Map(),         // lid -> SHGeom.ArcPath
    view: null,              // {x,y,w,h}，null = 待适配内容
    mode: 'select',
    activeLine: null,        // lid
    selStop: null,           // sid
    selImport: null,         // {source, sourceLayer}
    pending: [],             // 编组模式待选 stop id 列表
    undo: [],                // 快照栈 {lines, groups, imports}
  };
  // 编号水位（含 localStorage 持久，防删除后复用）
  const counters = { nextL: 1, nextG: 1, nextLG: 1 };
  function loadCounters() {
    try {
      const c = JSON.parse(localStorage.getItem('shrail.counters') || '{}');
      Object.assign(counters, c);
    } catch (e) { /* 忽略 */ }
  }
  function saveCounters() {
    localStorage.setItem('shrail.counters', JSON.stringify(counters));
  }
  function bumpCounter(key, fmt, n) {
    const id = fmt + String(counters[key]).padStart(n, '0');
    counters[key]++;
    saveCounters();
    return id;
  }
  function syncCountersWithLoaded() {
    // 已载入的既有编号同步进水位（取 max，防旧会话分配的号被再用）
    for (const lid of S.lines.keys()) {
      const n = parseInt(lid.slice(1), 10);
      if (n >= counters.nextL) counters.nextL = n + 1;
    }
    if (S.manifest) {
      for (const a of S.manifest.archived || []) {
        const n = parseInt(String(a).slice(1), 10);
        if (!isNaN(n) && n >= counters.nextL) counters.nextL = n + 1;
      }
    }
    if (S.groups) {
      for (const g of S.groups.stationGroups || []) {
        const n = parseInt(g.id.slice(1), 10);
        if (n >= counters.nextG) counters.nextG = n + 1;
      }
      for (const lg of S.groups.lineGroups || []) {
        const n = parseInt(lg.id.slice(2), 10);
        if (n >= counters.nextLG) counters.nextLG = n + 1;
      }
    }
    saveCounters();
  }

  // ---------- 撤销（快照式） ----------
  function snapshot() {
    S.undo.push(JSON.stringify({
      lines: [...S.lines.values()],
      groups: S.groups, imports: S.imports,
    }));
    if (S.undo.length > 100) S.undo.shift();
  }
  function undo() {
    const snap = S.undo.pop();
    if (!snap) { setStatus('没有可撤销的操作。'); return; }
    const d = JSON.parse(snap);
    S.lines = new Map(d.lines.map((l) => [l.id, l]));
    S.groups = d.groups; S.imports = d.imports;
    S.arcs = new Map();
    if (!S.lines.has(S.activeLine)) S.activeLine = null;
    S.selStop = null; S.pending = [];
    renderAll(); setStatus('已撤销。');
  }

  // ---------- localStorage 暂存 ----------
  let lsTimer = null;
  function autosave() {
    clearTimeout(lsTimer);
    lsTimer = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          savedAt: Date.now(),
          lines: [...S.lines.values()],
          groups: S.groups, imports: S.imports, activeLine: S.activeLine,
        }));
      } catch (e) { /* 存储满等异常忽略 */ }
    }, 400);
  }
  function offerRestore() {
    let snap = null;
    try { snap = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { /* 忽略 */ }
    if (!snap || !snap.lines || !snap.lines.length) return;
    $('bannerTime').textContent = new Date(snap.savedAt).toLocaleString();
    $('banner').classList.add('show');
    $('btnRestore').onclick = () => {
      S.lines = new Map(snap.lines.map((l) => [l.id, l]));
      S.groups = snap.groups;
      // 导入记录：同名来源以刚从 import/ 磁盘载入的为准（可能比暂存新），其余保留暂存里的
      const diskSources = new Set(S.imports.map((i) => i.source));
      S.imports = (snap.imports || []).filter((i) => !diskSources.has(i.source)).concat(S.imports);
      S.activeLine = snap.activeLine && S.lines.has(snap.activeLine) ? snap.activeLine : null;
      $('banner').classList.remove('show');
      syncCountersWithLoaded(); renderAll(); setStatus('已恢复本地暂存。');
    };
    $('btnDiscard').onclick = () => {
      localStorage.removeItem(LS_KEY);
      $('banner').classList.remove('show');
    };
  }

  // ---------- 文件载入 ----------
  function readJsonFile(file) {
    return file.text().then((t) => JSON.parse(t));
  }

  function addImportRecord(rec) {
    // 同源重复载入：替换
    S.imports = S.imports.filter((i) => i.source !== rec.source);
    S.imports.push(rec);
  }

  function parseSvgText(text, fileName) {
    // 浏览器内直接解析 SVG（与 tools/svg_parse.py --import 等效）
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('SVG 解析失败');
    const styles = {};
    for (const st of doc.querySelectorAll('style')) {
      for (const m of st.textContent.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
        const c = m[2].match(/stroke\s*:\s*(#[0-9A-Fa-f]{3,8})/);
        if (c) styles[m[1]] = c[1].toUpperCase();
      }
    }
    const paths = [];
    for (const p of doc.querySelectorAll('path')) {
      const d = p.getAttribute('d');
      if (!d || !d.trim()) continue;
      const name = (p.getAttribute('data-name') || p.getAttribute('id') || '').replace(/^_+/, '');
      const cls = (p.getAttribute('class') || '').split(/\s+/);
      const color = cls.map((c) => styles[c]).find(Boolean) || '#888888';
      paths.push({ sourceLayer: name, color: color.toUpperCase(), path: d.replace(/\s+/g, ' ').trim() });
    }
    if (!paths.length) throw new Error('SVG 中没有 path');
    return { schema: 'fmt/import@1', source: fileName, imported: today(), paths };
  }

  function loadDataObject(obj, fileName) {
    if (obj && obj.schema === 'fmt/import@1') { addImportRecord(obj); return; }
    if (obj && obj.schema === 'fmt/line@1' && /^l\d{4}$/.test(obj.id || '')) {
      S.lines.set(obj.id, obj);
      S.arcs.delete(obj.id);
      if (!S.activeLine) S.activeLine = obj.id;
      return;
    }
    if (obj && obj.schema === 'fmt/groups@1') { S.groups = obj; return; }
    if (obj && obj.schema === 'fmt/manifest@1') { S.manifest = obj; return; }
    throw new Error(fileName + '：无法识别的数据文件（schema 不匹配）');
  }

  async function bootFetchData() {
    // 经 http 服务打开时自动尝试拉取 data/（file:// 打开时静默跳过）
    const get = async (u) => {
      try { const r = await fetch(u); if (!r.ok) return null; return await r.json(); } catch (e) { return null; }
    };
    const groups = await get('data/groups.json');
    if (groups) S.groups = groups;
    const manifest = await get('data/manifest.json');
    if (manifest) S.manifest = manifest;
    try {
      const r = await fetch('data/lines/');
      if (r.ok) {
        const html = await r.text();
        const names = [...html.matchAll(/href="(l\d{4}\.json)"/g)].map((m) => m[1]);
        for (const n of new Set(names)) {
          const obj = await get('data/lines/' + n);
          if (obj && obj.schema === 'fmt/line@1') {
            S.lines.set(obj.id, obj);
            if (!S.activeLine) S.activeLine = obj.id;
          }
        }
      }
    } catch (e) { /* file:// 等，忽略 */ }
    // import/ 目录：svg_parse --import 的产物自动载入（导入源开箱即见）
    try {
      const r = await fetch('import/');
      if (r.ok) {
        const html = await r.text();
        // 目录列表 href 为 URL 编码后的文件名（含中文），取单段 *.json、排除 ../ 等路径
        const hrefs = [...html.matchAll(/href="([^"/]+\.json)"/g)].map((m) => m[1]);
        for (const h of new Set(hrefs)) {
          const obj = await get('import/' + h);
          if (obj && obj.schema === 'fmt/import@1') addImportRecord(obj);
        }
      }
    } catch (e) { /* file:// 等，忽略 */ }
  }

  // ---------- 几何缓存 ----------
  function arcOf(lid) {
    if (!S.arcs.has(lid)) {
      const line = S.lines.get(lid);
      if (!line) return null;
      try { S.arcs.set(lid, G.pathFromD(line.path)); }
      catch (e) {
        setStatus(`线路 ${lid} path 解析失败：${e.message}`);
        S.arcs.set(lid, null);
      }
    }
    return S.arcs.get(lid);
  }

  // ---------- 视图（平移/缩放） ----------
  function worldPerPixel() {
    return S.view ? S.view.w / Math.max(svg.clientWidth, 1) : 1;
  }
  function fitView() {
    let bb = null;
    const merge = (b) => {
      bb = bb ? [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]
        : b.slice();
    };
    for (const ap of S.arcs.values()) if (ap) merge(ap.bbox());
    // 未建线的导入 path 也纳入初始视野
    const boundPaths = new Set([...S.lines.values()].map((l) => l.path));
    for (const imp of S.imports) {
      for (const p of imp.paths) {
        if (boundPaths.has(p.path)) continue;
        try { merge(G.pathFromD(p.path).bbox()); } catch (e) { /* 忽略坏 path */ }
      }
    }
    if (!bb) return;
    const pad = 0.05 * Math.max(bb[2] - bb[0], bb[3] - bb[1], 1);
    const w = (bb[2] - bb[0]) + 2 * pad;
    const h = (bb[3] - bb[1]) + 2 * pad;
    const ratio = svg.clientHeight / Math.max(svg.clientWidth, 1);
    S.view = { x: bb[0] - pad, y: bb[1] - pad, w: w, h: Math.max(h, w * ratio) };
  }
  function applyView() {
    if (!S.view) return;
    const ratio = svg.clientHeight / Math.max(svg.clientWidth, 1);
    S.view.h = S.view.w * ratio;
    svg.setAttribute('viewBox', `${S.view.x} ${S.view.y} ${S.view.w} ${S.view.h}`);
  }
  function toWorld(evt) {
    const pt = new DOMPoint(evt.clientX, evt.clientY);
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const w = pt.matrixTransform(m.inverse());
    return [w.x, w.y];
  }

  // ---------- 渲染 ----------
  function segPathString(ap, t1, t2) {
    const pts = ap.polylineBetween(t1, t2);
    if (!pts.length) return '';
    return 'M' + pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L');
  }

  function renderWorld() {
    world.textContent = '';
    const scale = S.view ? Math.max(svg.clientWidth, 1) / S.view.w : 1;
    const rStop = 5.5 / scale, ringR = 8.5 / scale, hintR = 12 / scale;

    // 未建线的导入 path（灰色虚线）
    const boundPaths = new Set([...S.lines.values()].map((l) => l.path));
    for (const imp of S.imports) {
      for (const p of imp.paths) {
        if (boundPaths.has(p.path)) continue;
        const path = el('path', { d: p.path, class: 'svg-line line-raw',
          stroke: '#666', 'vector-effect': 'non-scaling-stroke' }, world);
        path.dataset.impSource = imp.source;
        path.dataset.impLayer = p.sourceLayer;
      }
    }

    // 线路
    for (const [lid, line] of S.lines) {
      const ap = arcOf(lid);
      if (!ap) continue;
      const gLine = el('g', { class: 'svg-line' }, world);
      gLine.style.stroke = line.color;
      gLine.dataset.lid = lid;
      const active = lid === S.activeLine;

      // 底图：完整原始贝塞尔 path（弱化）
      const base = el('path', { d: line.path, class: 'line-base',
        'vector-effect': 'non-scaling-stroke' }, gLine);
      base.style.strokeWidth = active ? 7 : 5;
      base.style.opacity = active ? 0.42 : 0.22;
      base.dataset.lid = lid;

      const stops = line.stops;
      const segs = line.segments || [];
      const n = stops.length;
      const segCount = line.loop ? n : Math.max(n - 1, 0);
      for (let i = 0; i < segCount; i++) {
        const t1 = stops[i].t;
        let t2;
        if (line.loop) {
          t2 = (i + 1 === n) ? stops[0].t : stops[i + 1].t;  // 末段环绕
        } else {
          if (i + 1 >= n) break;
          t2 = stops[i + 1].t;
        }
        // 环线仅 1 站：环绕段 = 整条闭合路径
        const dstr = (line.loop && n === 1) ? line.path : segPathString(ap, t1, t2);
        if (!dstr) continue;
        const st = segs[i] || 'existing';
        el('path', { d: dstr, class: `seg-common seg-${st}`,
          'vector-effect': 'non-scaling-stroke' }, gLine);
        const hit = el('path', { d: dstr, class: 'seg-hit',
          'vector-effect': 'non-scaling-stroke' }, gLine);
        hit.dataset.lid = lid; hit.dataset.seg = i;
      }

      // 设站
      stops.forEach((st, idx) => {
        const [x, y] = ap.pointAt(st.t);
        const isSel = S.selStop === st.id && lid === S.activeLine;
        const isPend = S.pending.includes(st.id);
        if (isSel) el('circle', { cx: x, cy: y, r: ringR, class: 'stop-ring',
          'vector-effect': 'non-scaling-stroke' }, gLine);
        const c = el('circle', { cx: x, cy: y, r: rStop, class: 'stop-c' + (isPend ? ' pend' : ''),
          stroke: line.color, 'stroke-width': 2 / scale }, gLine);
        c.dataset.lid = lid; c.dataset.sid = st.id;
        const t = el('title', {}, c);
        t.textContent = `${idx + 1}. ${st.name || '（未命名）'}  t=${st.t.toFixed(4)}`;
      });
    }

    // 编组就近提示（纯视觉，绝不自动成组）
    if (S.mode === 'group' && S.pending.length) {
      const wpp = worldPerPixel();
      const hintWorld = 30 * wpp;
      const pendPts = [];
      for (const [lid, line] of S.lines) {
        const ap = arcOf(lid);
        if (!ap) continue;
        for (const sid of S.pending) {
          const st = line.stops.find((x) => x.id === sid);
          if (st) pendPts.push(ap.pointAt(st.t));
        }
      }
      if (pendPts.length) {
        for (const [lid, line] of S.lines) {
          const ap = arcOf(lid);
          if (!ap) continue;
          for (const st of line.stops) {
            if (S.pending.includes(st.id)) continue;
            const p = ap.pointAt(st.t);
            if (pendPts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= hintWorld)) {
              el('circle', { cx: p[0], cy: p[1], r: hintR, class: 'hint-ring',
                'vector-effect': 'non-scaling-stroke' }, world);
            }
          }
        }
      }
    }
  }

  // ---------- 侧栏渲染 ----------
  function renderImportList() {
    const box = $('impList');
    if (!S.imports.length) {
      box.innerHTML = '<div class="imp-src">用工具导入或工具栏载入。选中一条 path 后可建线。</div>';
      return;
    }
    const bound = new Set([...S.lines.values()].map((l) => l.path));
    let html = '';
    for (const imp of S.imports) {
      html += `<div class="imp-src">${esc(imp.source)}（${imp.imported}）</div>`;
      for (const p of imp.paths) {
        const isBound = bound.has(p.path);
        const sel = S.selImport && S.selImport.source === imp.source
          && S.selImport.sourceLayer === p.sourceLayer;
        html += `<div class="imp-row ${isBound ? 'bound' : ''} ${sel ? 'sel' : ''}"
          data-src="${esc(imp.source)}" data-layer="${esc(p.sourceLayer)}">
          <span class="chip" style="background:${esc(p.color)}"></span>
          <span class="nm" title="点击选中；再点「建线」创建线路">${esc(p.sourceLayer)}</span>
          ${isBound ? '<span class="badge">已建线</span>'
            : `<button class="mini" data-mk="1">建线</button>`}
        </div>`;
      }
    }
    box.innerHTML = html;
  }

  function renderLineList() {
    const box = $('lineList');
    if (!S.lines.size) { box.innerHTML = '<div style="color:var(--dim)">暂无线路。</div>'; return; }
    const arr = [...S.lines.values()].sort((a, b) => a.id < b.id ? -1 : 1);
    box.innerHTML = arr.map((l) => `
      <div class="line-row ${l.id === S.activeLine ? 'active' : ''}" data-lid="${l.id}">
        <span class="chip" style="background:${esc(l.color)}"></span>
        <span class="nm">${esc(l.name)} ${l.meta && l.meta.archived ? '<span class="badge arch">归档</span>' : ''}</span>
        <span class="id">${l.id} · ${l.stops.length}站</span>
      </div>`).join('');
  }

  function renderLineForm() {
    const box = $('lineform');
    const l = S.lines.get(S.activeLine);
    if (!l) { box.innerHTML = '<div style="color:var(--dim)">选择或新建一条线路后编辑属性。</div>'; return; }
    const lgs = (S.groups && S.groups.lineGroups) || [];
    const lgOpts = ['<option value="">（无）</option>'].concat(
      lgs.map((g) => `<option value="${g.id}" ${l.groupId === g.id ? 'selected' : ''}>${g.id} ${esc(g.name)}</option>`),
      ['<option value="__new__">＋ 新建线组…</option>']).join('');
    const needStatus = l.stops.length < 2;
    box.innerHTML = `
      <div class="fld"><label>id</label><input type="text" value="${l.id}" disabled></div>
      <div class="fld"><label>名称</label><input type="text" id="lfName" value="${esc(l.name)}"></div>
      <div class="fld"><label>颜色</label><input type="color" id="lfColor" value="${esc(l.color)}"></div>
      <div class="fld"><label>环线</label><input type="checkbox" id="lfLoop" ${l.loop ? 'checked' : ''}
        style="flex:1"><span style="color:var(--dim);font-size:11px">（path 闭合）</span></div>
      <div class="fld"><label>角色</label><select id="lfRole" style="flex:1">
        ${Object.entries(ROLE_LABEL).map(([r, lab]) =>
          `<option value="${r}" ${l.role === r ? 'selected' : ''}>${r}（${lab}）</option>`).join('')}
      </select></div>
      <div class="fld" id="lfGroupRow" style="display:${l.role === 'main' || l.role === 'branch' ? 'flex' : 'none'}">
        <label>线组</label><select id="lfGroup" style="flex:1">${lgOpts}</select></div>
      <div class="fld" id="lfConnRow" style="display:${l.role === 'connector' ? 'flex' : 'none'}">
        <label>联络</label><input type="text" id="lfConnects" placeholder="l0001,l0002"
          value="${esc((l.connects || []).join(','))}"></div>
      <div class="fld" id="lfStatusRow" style="display:${needStatus ? 'flex' : 'none'}">
        <label>状态</label><select id="lfStatus" style="flex:1">
        ${SEG_ORDER.map((s2) => `<option value="${s2}" ${l.status === s2 ? 'selected' : ''}>${SEG_LABEL[s2]}</option>`).join('')}
        </select><span style="color:var(--dim);font-size:11px">（站数&lt;2 时必填）</span></div>
      <div class="fld"><label>源图层</label><input type="text" value="${esc((l.meta && l.meta.sourceLayer) || '')}" disabled></div>
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
        <button class="mini" id="lfUpdatePath" ${S.selImport ? '' : 'disabled'}
          title="用当前选中的导入 path 替换本线 path（设站按弧长 t 保留）">更新path</button>
        <button class="mini ${l.meta && l.meta.archived ? '' : 'danger'}" id="lfArchive">
          ${l.meta && l.meta.archived ? '取消归档' : '归档'}</button>
      </div>`;
  }

  function renderStopList() {
    const box = $('stopList');
    const l = S.lines.get(S.activeLine);
    if (!l || !l.stops.length) {
      box.innerHTML = '<div style="color:var(--dim)">在「加站」模式下点击线路加站；站名在此录入。</div>';
      return;
    }
    box.innerHTML = l.stops.map((st, i) => `
      <div class="stop-row ${S.selStop === st.id ? 'sel' : ''} ${S.pending.includes(st.id) ? 'pend' : ''}" data-sid="${st.id}">
        <span class="idx">${i + 1}</span>
        <input type="text" value="${esc(st.name)}" data-ren="${st.id}"
          class="${st.name ? '' : 'warn'}" placeholder="（站名）">
        <span class="t">${st.t.toFixed(4)}</span>
        <button class="mini danger" data-del="${st.id}" title="删除设站">✕</button>
      </div>`).join('');
  }

  function stopLabel(sid) {
    for (const l of S.lines.values()) {
      const st = l.stops.find((x) => x.id === sid);
      if (st) return `${l.id} ${st.name || '（未命名）'}`;
    }
    return sid;
  }

  function renderGroupsPanel() {
    if (!S.groups) {
      S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    }
    // 待编组
    $('pendingBox').innerHTML = S.mode === 'group' ? `
      <div style="font-size:12px;margin-bottom:4px">待编组：<b>${S.pending.length}</b> 站
        <button class="mini primary" id="btnMkGroup" ${S.pending.length >= 2 ? '' : 'disabled'}>编组</button>
        <button class="mini" id="btnClearPend" ${S.pending.length ? '' : 'disabled'}>清空</button></div>
      <div style="font-size:11px;color:var(--dim)">黄色虚线圈=就近提示，仅供参考，绝不自动合并。</div>` : '';
    // 换乘节点组
    const sgs = S.groups.stationGroups || [];
    $('stationGroups').innerHTML = '<div style="margin-bottom:2px"><b>换乘节点组</b></div>' +
      (sgs.length ? sgs.map((g) => `
        <div class="grp-row" data-gid="${g.id}">
          <b>${g.id}</b>
          <select data-gtype="${g.id}">
            <option value="">type 未定</option>
            <option value="same-station" ${g.type === 'same-station' ? 'selected' : ''}>同站</option>
            <option value="passage" ${g.type === 'passage' ? 'selected' : ''}>通道</option>
            <option value="out-of-station" ${g.type === 'out-of-station' ? 'selected' : ''}>出闸</option>
          </select>
          <button class="mini danger" data-gdel="${g.id}">拆组</button>
          <div class="m">${g.stops.map((s2) => esc(stopLabel(s2))).join('；')}</div>
        </div>`).join('')
        : '<div style="color:var(--dim);font-size:12px">（暂无）</div>');
    // 线组
    const lgs = S.groups.lineGroups || [];
    $('lineGroups').innerHTML = (lgs.length ? lgs.map((g) => {
      const members = [...S.lines.values()].filter((l) => l.groupId === g.id);
      return `<div class="grp-row" data-lgid="${g.id}">
        <span class="chip" style="display:inline-block;width:11px;height:11px;background:${esc(g.color || '#888')};border-radius:3px"></span>
        <b>${g.id}</b> ${esc(g.name)}
        <button class="mini danger" data-lgdel="${g.id}" ${members.length ? 'disabled title="仍有成员线"' : ''}>删除</button>
        <div class="m">${members.length ? members.map((m) => `${m.id} ${esc(m.name)}`).join('；') : '（无成员）'}</div>
      </div>`;
    }).join('') : '<div style="color:var(--dim);font-size:12px">（暂无）</div>');
  }

  function renderAll() {
    if (!S.view) fitView();
    applyView();
    renderWorld();
    renderImportList();
    renderLineList();
    renderLineForm();
    renderStopList();
    renderGroupsPanel();
    autosave();
  }

  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.style.color = isErr ? 'var(--err)' : 'var(--dim)';
  }

  // ---------- 线路操作 ----------
  function allocLid() { return bumpCounter('nextL', 'l', 4); }

  function createLineFromImport(source, sourceLayer) {
    const imp = S.imports.find((i) => i.source === source);
    const p = imp && imp.paths.find((x) => x.sourceLayer === sourceLayer);
    if (!p) return;
    snapshot();
    const lid = allocLid();
    const line = {
      schema: 'fmt/line@1', id: lid, name: sourceLayer,
      groupId: null, role: 'standalone', color: p.color,
      loop: /z/i.test(p.path), path: p.path, connects: [],
      stops: [], segments: [], status: 'future',
      info: {},
      meta: { created: today(), updated: today(), archived: false,
        aliases: [], sourceLayer: sourceLayer, stopSeq: 0 },
    };
    S.lines.set(lid, line);
    S.activeLine = lid; S.selStop = null;
    renderAll();
    setStatus(`已建线 ${lid}（${line.name}）。切换到「加站」模式点击线路设站。`);
  }

  function updatePathFromImport() {
    const l = S.lines.get(S.activeLine);
    if (!l || !S.selImport) return;
    const imp = S.imports.find((i) => i.source === S.selImport.source);
    const p = imp && imp.paths.find((x) => x.sourceLayer === S.selImport.sourceLayer);
    if (!p) return;
    if (p.path === l.path) { setStatus('选中导入 path 与当前线路相同。'); return; }
    snapshot();
    l.path = p.path;
    l.meta.updated = today();
    S.arcs.delete(l.id);
    renderAll();
    setStatus(`已更新 ${l.id} 的 path（${l.stops.length} 站按弧长 t 保留，请目视核查站点位置）。`);
  }

  // ---------- 设站操作 ----------
  function addStop(lid, t) {
    const line = S.lines.get(lid);
    const ap = arcOf(lid);
    if (!line || !ap) return;
    t = Math.round(t * 1e6) / 1e6;
    // 找插入位置（t 严格递增）
    let i = 0;
    while (i < line.stops.length && line.stops[i].t < t) i++;
    const prevT = i > 0 ? line.stops[i - 1].t : null;
    const nextT = i < line.stops.length ? line.stops[i].t : null;
    if (prevT !== null && t - prevT < EPS) t = prevT + EPS;
    if (nextT !== null && nextT - t < EPS) t = nextT - EPS;
    if (t < 0 || t >= 1 || (prevT !== null && t <= prevT) || (nextT !== null && t >= nextT)) {
      setStatus('此处与相邻设站过近，未添加。', true); return;
    }
    snapshot();
    const seq = nextStopSeq(line);
    const sid = `${lid}-s${String(seq).padStart(2, '0')}`;
    const st = { id: sid, name: '', t: t, geo: null };
    line.stops.splice(i, 0, st);
    segInsert(line, i);
    fixStatusField(line);
    line.meta.updated = today();
    S.selStop = sid;
    renderAll();
    setStatus(`已加站 ${sid}（t=${t}）。请在左侧录入站名。`);
    const input = document.querySelector(`#stopList input[data-ren="${sid}"]`);
    if (input) input.focus();
  }

  function deleteStop(lid, sid) {
    const line = S.lines.get(lid);
    if (!line) return;
    const i = line.stops.findIndex((s) => s.id === sid);
    if (i < 0) return;
    snapshot();
    segRemove(line, i);
    line.stops.splice(i, 1);
    fixStatusField(line);
    line.meta.updated = today();
    // 从换乘节点组中移除引用，防止悬挂
    let grpNote = '';
    if (S.groups) {
      for (const g of S.groups.stationGroups || []) {
        if (g.stops.includes(sid)) {
          g.stops = g.stops.filter((x) => x !== sid);
          grpNote = `（已从 ${g.id} 移除）`;
        }
      }
      S.groups.stationGroups = (S.groups.stationGroups || []).filter((g) => g.stops.length >= 2);
    }
    if (S.selStop === sid) S.selStop = null;
    S.pending = S.pending.filter((x) => x !== sid);
    renderAll();
    setStatus(`已删站 ${sid}。${grpNote}`);
  }

  function moveStop(lid, sid, t) {
    const line = S.lines.get(lid);
    if (!line) return false;
    const i = line.stops.findIndex((s) => s.id === sid);
    if (i < 0) return false;
    const lo = i > 0 ? line.stops[i - 1].t + EPS : 0;
    const hi = i < line.stops.length - 1 ? line.stops[i + 1].t - EPS : 1 - EPS;
    if (t < lo) t = lo;
    if (t > hi) t = hi;
    t = Math.round(t * 1e6) / 1e6;
    if (Math.abs(t - line.stops[i].t) < 1e-7) return false;
    line.stops[i].t = t;
    line.meta.updated = today();
    return true;
  }

  // ---------- 交互 ----------
  let drag = null;    // {type:'pan',...} | {type:'stop', lid, sid, moved}
  let panning = null;

  function nearestLineAt(wx, wy) {
    const wpp = worldPerPixel();
    const maxD = 14 * wpp;
    let best = null;
    for (const [lid, line] of S.lines) {
      if (line.meta && line.meta.archived) continue;
      const ap = arcOf(lid);
      if (!ap) continue;
      const pr = ap.project(wx, wy);
      if (pr.d <= maxD && (!best || pr.d < best.pr.d)) best = { lid, pr };
    }
    return best;
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 1 || (e.button === 0 && e.target === svg)) {
      panning = { x: e.clientX, y: e.clientY, view: { ...S.view } };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    const stopEl = e.target.closest('.stop-c');
    if (stopEl && S.mode === 'select') {
      const sid = stopEl.dataset.sid, lid = stopEl.dataset.lid;
      S.activeLine = lid;
      S.selStop = sid;
      drag = { type: 'stop', lid, sid, moved: false,
        pre: JSON.stringify({ lines: [...S.lines.values()], groups: S.groups, imports: S.imports }) };
      svg.setPointerCapture(e.pointerId);
      renderStopList(); renderLineList(); renderLineForm();
      return;
    }
  });

  svg.addEventListener('pointermove', (e) => {
    if (panning && S.view) {
      const kx = S.view.w / svg.clientWidth;
      S.view.x = panning.view.x - (e.clientX - panning.x) * kx;
      S.view.y = panning.view.y - (e.clientY - panning.y) * kx;
      applyView();
      return;
    }
    if (drag && drag.type === 'stop') {
      const [wx, wy] = toWorld(e);
      if (moveStop(drag.lid, drag.sid, nearestTOnLine(drag.lid, wx, wy))) {
        drag.moved = true;
        renderWorld(); renderStopList();
      }
    }
  });

  svg.addEventListener('pointerup', (e) => {
    if (panning) { panning = null; return; }
    if (drag && drag.type === 'stop') {
      if (drag.moved) {
        S.undo.push(drag.pre);  // 用拖动前快照
        if (S.undo.length > 100) S.undo.shift();
        autosave();
      }
      drag = null;
      return;
    }
    const [wx, wy] = toWorld(e);

    if (S.mode === 'add') {
      const hit = nearestLineAt(wx, wy);
      if (hit) {
        addStop(hit.lid, hit.pr.t);
      } else {
        setStatus('点击位置不在任何线路附近（吸附半径 14px）。', true);
      }
      return;
    }

    if (S.mode === 'group') {
      const stopEl = e.target.closest('.stop-c');
      if (stopEl) {
        const sid = stopEl.dataset.sid;
        S.pending = S.pending.includes(sid) ? S.pending.filter((x) => x !== sid) : [...S.pending, sid];
        renderAll();
        return;
      }
    }

    // select 模式的点击
    const segEl = e.target.closest('.seg-hit');
    if (segEl) {
      const lid = segEl.dataset.lid, i = +segEl.dataset.seg;
      const line = S.lines.get(lid);
      if (line) {
        snapshot();
        line.segments[i] = SEG_ORDER[(SEG_ORDER.indexOf(line.segments[i]) + 1) % 3];
        line.meta.updated = today();
        S.activeLine = lid;
        setStatus(`${lid} 段 ${i + 1} → ${SEG_LABEL[line.segments[i]]}`);
        renderAll();
      }
      return;
    }
    if (e.target.closest('.stop-c')) return;  // 已在 pointerdown 处理
    const baseEl = e.target.closest('path');
    if (baseEl && baseEl.dataset.lid) {
      S.activeLine = baseEl.dataset.lid; S.selStop = null;
      renderLineList(); renderLineForm(); renderStopList(); renderWorld();
      return;
    }
    const impEl = e.target.closest && e.target.closest('path[data-imp-source]');
    if (impEl) {
      S.selImport = { source: impEl.dataset.impSource, sourceLayer: impEl.dataset.impLayer };
      renderImportList();
      setStatus(`选中导入 path：${impEl.dataset.impLayer}（${impEl.dataset.impSource}）`);
      return;
    }
    // 空白：取消选择
    S.selStop = null;
    renderStopList(); renderWorld();
  });

  function nearestTOnLine(lid, wx, wy) {
    const ap = arcOf(lid);
    return ap ? ap.project(wx, wy).t : 0;
  }

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!S.view) return;
    const [wx, wy] = toWorld(e);
    const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
    const nw = Math.min(Math.max(S.view.w * factor, 5), 1e6);
    const k = nw / S.view.w;
    S.view.x = wx - (wx - S.view.x) * k;
    S.view.y = wy - (wy - S.view.y) * k;
    S.view.w = nw;
    applyView(); renderWorld();
  }, { passive: false });

  // ---------- 侧栏事件（委托） ----------
  $('impList').addEventListener('click', (e) => {
    const row = e.target.closest('.imp-row');
    if (!row) return;
    S.selImport = { source: row.dataset.src, sourceLayer: row.dataset.layer };
    if (e.target.dataset.mk) { createLineFromImport(row.dataset.src, row.dataset.layer); return; }
    renderImportList(); renderLineForm();
    setStatus(`选中导入 path：${row.dataset.layer}（${row.dataset.src}）`);
  });

  $('lineList').addEventListener('click', (e) => {
    const row = e.target.closest('.line-row');
    if (!row) return;
    S.activeLine = row.dataset.lid; S.selStop = null;
    renderAll();
  });

  $('stopList').addEventListener('click', (e) => {
    const del = e.target.dataset.del;
    if (del) { deleteStop(S.activeLine, del); return; }
    const row = e.target.closest('.stop-row');
    if (row) { S.selStop = row.dataset.sid; renderStopList(); renderWorld(); }
  });
  $('stopList').addEventListener('input', (e) => {
    const sid = e.target.dataset.ren;
    if (!sid) return;
    const line = S.lines.get(S.activeLine);
    const st = line && line.stops.find((s) => s.id === sid);
    if (st) {
      st.name = e.target.value;
      line.meta.updated = today();
      e.target.classList.toggle('warn', !st.name);
      renderWorld(); autosave();
    }
  });

  $('lineform').addEventListener('input', (e) => {
    const l = S.lines.get(S.activeLine);
    if (!l) return;
    let touched = true;
    switch (e.target.id) {
      case 'lfName': l.name = e.target.value; break;
      case 'lfColor': l.color = e.target.value.toUpperCase(); break;
      case 'lfLoop':
        snapshot();
        toggleLoop(l, e.target.checked);
        break;
      case 'lfRole': {
        snapshot();
        l.role = e.target.value;
        if (l.role !== 'connector') l.connects = [];
        if ((l.role === 'main' || l.role === 'branch') && !l.groupId) {
          // 留待用户在下方线组下拉中选择
        }
        $('lfGroupRow').style.display = (l.role === 'main' || l.role === 'branch') ? 'flex' : 'none';
        $('lfConnRow').style.display = l.role === 'connector' ? 'flex' : 'none';
        break;
      }
      case 'lfGroup':
        if (e.target.value === '__new__') { newLineGroupFor(l); return; }
        l.groupId = e.target.value || null;
        break;
      case 'lfConnects':
        l.connects = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'lfStatus': l.status = e.target.value; break;
      default: touched = false;
    }
    if (touched) { l.meta.updated = today(); renderLineList(); renderWorld(); renderGroupsPanel(); autosave(); }
  });
  $('lineform').addEventListener('click', (e) => {
    if (e.target.id === 'lfUpdatePath') updatePathFromImport();
    if (e.target.id === 'lfArchive') {
      const l = S.lines.get(S.activeLine);
      if (!l) return;
      snapshot();
      l.meta.archived = !l.meta.archived;
      l.meta.updated = today();
      renderAll();
      setStatus(l.meta.archived ? `${l.id} 已标记归档（保存后保留在文件中，发布时剔除）。`
        : `${l.id} 已取消归档。`);
    }
  });

  function toggleLoop(l, loop) {
    const n = l.stops.length;
    l.loop = loop;
    const want = loop ? n : Math.max(n - 1, 0);
    while (l.segments.length > want) l.segments.pop();
    while (l.segments.length < want) l.segments.push('existing');
  }

  function newLineGroupFor(line) {
    const name = prompt('新线组名称（如：1号线）', line.name);
    if (!name) { renderLineForm(); return; }
    snapshot();
    const id = bumpCounter('nextLG', 'lg', 2);
    S.groups.lineGroups.push({ id, name, color: line.color,
      members: [], note: '' });
    line.groupId = id;
    if (line.role === 'standalone') line.role = 'main';
    renderAll();
    setStatus(`已建线组 ${id} 并将 ${line.id} 设为成员。`);
  }

  $('btnNewLineGroup').addEventListener('click', () => {
    const name = prompt('新线组名称');
    if (!name) return;
    snapshot();
    const id = bumpCounter('nextLG', 'lg', 2);
    S.groups.lineGroups.push({ id, name, color: '#888888', members: [], note: '' });
    renderAll();
  });

  $('lineGroups').addEventListener('click', (e) => {
    const gid = e.target.dataset.lgdel;
    if (!gid) return;
    S.groups.lineGroups = S.groups.lineGroups.filter((g) => g.id !== gid);
    for (const l of S.lines.values()) if (l.groupId === gid) l.groupId = null;
    renderAll();
  });

  $('stationGroups').addEventListener('click', (e) => {
    const gid = e.target.dataset.gdel;
    if (!gid) return;
    snapshot();
    S.groups.stationGroups = S.groups.stationGroups.filter((g) => g.id !== gid);
    renderAll();
  });
  $('stationGroups').addEventListener('change', (e) => {
    const gid = e.target.dataset.gtype;
    if (!gid) return;
    const g = S.groups.stationGroups.find((x) => x.id === gid);
    if (g) { g.type = e.target.value || null; autosave(); }
  });

  $('pendingBox').addEventListener('click', (e) => {
    if (e.target.id === 'btnClearPend') { S.pending = []; renderAll(); return; }
    if (e.target.id === 'btnMkGroup') {
      if (S.pending.length < 2) return;
      // 一设站至多一组：冲突即拒绝（人工先拆组）
      const conflict = [];
      for (const g of S.groups.stationGroups) {
        for (const sid of S.pending) if (g.stops.includes(sid)) conflict.push(`${sid} 已在 ${g.id}`);
      }
      if (conflict.length) {
        setStatus('冲突：' + conflict.join('；') + '。请先拆组。', true);
        return;
      }
      snapshot();
      const id = bumpCounter('nextG', 'g', 4);
      S.groups.stationGroups.push({ id, stops: [...S.pending], type: null, info: {} });
      S.pending = [];
      renderAll();
      setStatus(`已建换乘节点组 ${id}。`);
    }
  });

  // 折叠面板
  for (const h of document.querySelectorAll('section > h3')) {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  }

  // ---------- 模式与撤销 ----------
  const MODE_HINT = {
    select: '选择：点击设站选中（左侧改名）、拖动设站沿线移动、点击线段循环切换状态、点线路激活、滚轮缩放、拖空白平移。',
    add: '加站：点击线路附近即可加站（自动吸附到最近点，记录弧长 t）；站名在左侧列表录入。',
    group: '编组：点击设站加入/移出待编组（≥2 站后「编组」）；黄色虚线为就近提示，仅供参考。',
  };
  for (const btn of document.querySelectorAll('#toolbar [data-mode]')) {
    btn.addEventListener('click', () => {
      S.mode = btn.dataset.mode;
      for (const b of document.querySelectorAll('#toolbar [data-mode]')) {
        b.classList.toggle('primary', b === btn);
      }
      setStatus(MODE_HINT[S.mode]);
      $('canvasHint').textContent = MODE_HINT[S.mode];
      S.pending = [];
      renderAll();
    });
  }
  $('btnUndo').addEventListener('click', undo);
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
    if (e.key === 'Delete' && S.selStop && S.activeLine
        && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
      deleteStop(S.activeLine, S.selStop);
    }
    if (e.key === 'Escape') { S.selStop = null; S.pending = []; renderAll(); }
  });

  // ---------- 载入按钮 ----------
  $('btnLoadImport').onclick = () => $('fileImport').click();
  $('btnLoadSvg').onclick = () => $('fileSvg').click();
  $('btnLoadData').onclick = () => $('fileData').click();
  $('fileImport').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      try {
        const obj = await readJsonFile(f);
        if (obj.schema !== 'fmt/import@1') throw new Error('不是 fmt/import@1');
        addImportRecord(obj);
      } catch (err) { setStatus(`${f.name}：${err.message}`, true); }
    }
    e.target.value = '';
    renderAll();
  });
  $('fileSvg').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      try {
        addImportRecord(parseSvgText(await f.text(), f.name));
      } catch (err) { setStatus(`${f.name}：${err.message}`, true); }
    }
    e.target.value = '';
    renderAll();
  });
  $('fileData').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      try {
        loadDataObject(await readJsonFile(f), f.name);
      } catch (err) { setStatus(`${f.name}：${err.message}`, true); }
    }
    e.target.value = '';
    syncCountersWithLoaded();
    renderAll();
  });

  // ---------- 保存（下载） ----------
  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function saveLine(l) {
    const issues = lineIssues(l);
    if (issues.length) {
      setStatus(`保存失败 ${l.id}：${issues.join('；')}`, true);
      return false;
    }
    download(`${l.id}.json`, l);
    return true;
  }

  $('btnSaveLine').onclick = () => {
    const l = S.lines.get(S.activeLine);
    if (!l) { setStatus('没有当前线路。', true); return; }
    if (saveLine(l)) setStatus(`已下载 ${l.id}.json → 放入 data/lines/。`);
  };
  $('btnSaveAll').onclick = () => {
    let ok = 0, fail = 0;
    for (const l of S.lines.values()) { if (saveLine(l)) ok++; else fail++; }
    setStatus(`已下载 ${ok} 个线路 JSON${fail ? `，${fail} 个未通过检查（见上）` : ''} → 放入 data/lines/。`, !!fail);
  };
  $('btnSaveGroups').onclick = () => {
    if (!S.groups) S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    download('groups.json', S.groups);
    setStatus('已下载 groups.json → 放入 data/。');
  };
  $('btnSaveManifest').onclick = () => {
    const active = [...S.lines.values()].filter((l) => !l.meta.archived);
    const archivedIds = new Set(S.manifest ? S.manifest.archived || [] : []);
    for (const l of S.lines.values()) if (l.meta.archived) archivedIds.add(l.id);
    const mf = {
      schema: 'fmt/manifest@1',
      dataset: (S.manifest && S.manifest.dataset) || 'main',
      version: (S.manifest && S.manifest.version) || '0.1.0',
      updated: today(),
      lines: active.map((l) => ({ id: l.id, file: `lines/${l.id}.json`, name: l.name, stops: l.stops.length })),
      archived: [...archivedIds].sort(),
    };
    S.manifest = mf;
    download('manifest.json', mf);
    setStatus('已下载 manifest.json → 放入 data/（工具生成+人工确认）。');
  };

  // ---------- 启动 ----------
  window.addEventListener('resize', () => { applyView(); renderWorld(); });

  (async function boot() {
    loadCounters();
    await bootFetchData();
    syncCountersWithLoaded();
    offerRestore();
    if (!S.view) fitView();
    setStatus(MODE_HINT.select);
    $('canvasHint').textContent = MODE_HINT.select;
    renderAll();
  })();
})(typeof globalThis !== 'undefined' ? globalThis : this);
