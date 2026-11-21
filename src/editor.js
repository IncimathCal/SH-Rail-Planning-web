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

  /** 批量命名规划：names 每行一个，按序配给 line.stops 中站名为空（含纯空白）的站；
   *  已命名的站跳过不动——「先点完设站再一次贴名」与逐站命名两种方式并存。
   *  返回 {pairs:[[stop,name]...], total}；写入由调用方执行（便于先快照后改）。 */
  function planBulkFill(line, names) {
    const clean = (names || []).map((s) => String(s).trim()).filter(Boolean);
    const pairs = [];
    let k = 0;
    for (const st of line.stops) {
      if (st.name && st.name.trim()) continue;
      if (k >= clean.length) break;
      pairs.push([st, clean[k++]]);
    }
    return { pairs, total: clean.length };
  }

  /** 站圆预置批量落站规划（fmt/stations-import@1；node 单测覆盖）。
   *  preset stops（tools/station_extract.py 产物，t 6 位小数）逐个判定：
   *  与「原有站」|Δt| < dtEps → 跳过（exists，用户已设过的不动）；
   *  与「原有站或已接纳预置站」间隔 < eps → 跳过（conflict，如环线自交/共线重叠圆）；
   *  其余接纳。返回 {inserts:[t...], skippedExist, skippedConflict, total}。
   *  写入由 applyStopImport 执行（调用方先做整批快照，撤销一次回退整批）。 */
  function planStopImport(line, stops, dtEps = 0.002, eps = EPS) {
    const cand = (stops || []).map((s) => Math.round(s.t * 1e6) / 1e6)
      .filter((t) => t >= 0 && t < 1).sort((a, b) => a - b);
    const out = { inserts: [], skippedExist: 0, skippedConflict: 0, total: cand.length };
    const orig = line.stops.map((s) => s.t);          // 原有站（exists 只对照这些）
    const ts = orig.slice().sort((a, b) => a - b);    // 原有 + 已接纳（conflict 对照）
    for (const t of cand) {
      if (orig.some((u) => Math.abs(u - t) < dtEps)) { out.skippedExist++; continue; }
      let i = 0;
      while (i < ts.length && ts[i] < t) i++;
      const prevT = i > 0 ? ts[i - 1] : null;
      const nextT = i < ts.length ? ts[i] : null;
      if ((prevT !== null && t - prevT < eps) || (nextT !== null && nextT - t < eps)) {
        out.skippedConflict++;
        continue;
      }
      ts.splice(i, 0, t);
      out.inserts.push(t);
    }
    return out;
  }

  /** 执行批量落站（plan 来自 planStopImport）。name 一律留空——预置站名建议绝不自动写入。 */
  function applyStopImport(line, plan) {
    const added = [];
    for (const t of plan.inserts) {
      let i = 0;
      while (i < line.stops.length && line.stops[i].t < t) i++;
      const seq = nextStopSeq(line);
      const st = { id: `${line.id}-s${String(seq).padStart(2, '0')}`, name: '', t, geo: null };
      line.stops.splice(i, 0, st);
      segInsert(line, i);
      added.push(st);
    }
    fixStatusField(line);
    return added;
  }

  /** 站点 t 就近取预置站名建议（|Δt| ≤ dtEps）；返回 {name, dist} 或 null。仅展示用，点选才写入。 */
  function suggestForStop(item, t, dtEps = 0.002) {
    if (!item) return null;
    let best = null;
    for (const s of item.stops || []) {
      if (!s.nameSuggestion) continue;
      const d = Math.abs(s.t - t);
      if (d <= dtEps && (!best || d < best.d)) best = { name: s.nameSuggestion, dist: s.suggestDist, d };
    }
    return best;
  }

  // ---------- 标定变换与瓦片数学（fmt/calibration@1 deg3 / fmt/calibration@2 tps；node 单测覆盖往返与 Python 对拍） ----------
  // 多项式基次序与 tools/georef.py 的 features(deg=3) 一致：1,u,v,u²,uv,v²,u³,u²v,uv²,v³
  function poly3Basis(u, v) {
    return [1, u, v, u * u, u * v, v * v, u * u * u, u * u * v, u * v * v, v * v * v];
  }
  function calibEval(c, u, v) {
    const w = poly3Basis(u, v);
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i] * w[i];
    return s;
  }
  /** deg3 正向：SVG 世界坐标 → [lon, lat] */
  function poly3Forward(calib, x, y) {
    const u = (x - calib.uv.cx) / calib.uv.scale;
    const v = (y - calib.uv.cy) / calib.uv.scale;
    return [calibEval(calib.coef.lon, u, v), calibEval(calib.coef.lat, u, v)];
  }
  /** deg3 反向：[lon, lat] → SVG。仿射初值 + 牛顿迭代（数值雅可比）；不收敛返回 null */
  function poly3Inverse(calib, lon, lat) {
    const a0 = calib.coef.affineLon[0], a1 = calib.coef.affineLon[1], a2 = calib.coef.affineLon[2];
    const b0 = calib.coef.affineLat[0], b1 = calib.coef.affineLat[1], b2 = calib.coef.affineLat[2];
    const det = a1 * b2 - a2 * b1;
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
    const gl = lon - a0, gt = lat - b0;
    let u = (gl * b2 - gt * a2) / det;
    let v = (gt * a1 - gl * b1) / det;
    for (let it = 0; it < 30; it++) {
      const fl = calibEval(calib.coef.lon, u, v) - lon;
      const ft = calibEval(calib.coef.lat, u, v) - lat;
      if (Math.hypot(fl, ft) < 1e-11) break;
      const h = 1e-6, cL = calib.coef.lon, cT = calib.coef.lat;
      const fl_u = (calibEval(cL, u + h, v) - calibEval(cL, u - h, v)) / (2 * h);
      const fl_v = (calibEval(cL, u, v + h) - calibEval(cL, u, v - h)) / (2 * h);
      const ft_u = (calibEval(cT, u + h, v) - calibEval(cT, u - h, v)) / (2 * h);
      const ft_v = (calibEval(cT, u, v + h) - calibEval(cT, u, v - h)) / (2 * h);
      const J = fl_u * ft_v - fl_v * ft_u;
      if (!isFinite(J) || Math.abs(J) < 1e-18) return null;
      u -= (fl * ft_v - ft * fl_v) / J;
      v -= (ft * fl_u - fl * ft_u) / J;
      if (!isFinite(u) || !isFinite(v)) return null;
    }
    return [u * calib.uv.scale + calib.uv.cx, v * calib.uv.scale + calib.uv.cy];
  }
  // ---- TPS（fmt/calibration@2，tools/calib2_fit.py 产物；与 零散/calib2_lib.py 同式）----
  // f(x,y) = affine(uk,vk) + Σ w_i·U(d2)，U(r2)=r2·ln r2（d2 为 km² 坐标距离，km = svg×scaleToKm）
  const TPS_CACHE = new WeakMap();   // calib 对象 → 展平缓存（不随 JSON 序列化）
  function tpsCache(calib) {
    let c = TPS_CACHE.get(calib);
    if (!c) {
      const cps = calib.controlPoints || [];
      const n = cps.length;
      const kx = new Float64Array(n), ky = new Float64Array(n);
      const wl = new Float64Array(n), wt = new Float64Array(n);
      const k = (calib.kernel && calib.kernel.scaleToKm) || 0.00972;
      for (let i = 0; i < n; i++) {
        kx[i] = cps[i][0] * k; ky[i] = cps[i][1] * k;
        wl[i] = cps[i][2]; wt[i] = cps[i][3];
      }
      c = { n, kx, ky, wl, wt, k, aL: calib.affine.lon, aT: calib.affine.lat };
      TPS_CACHE.set(calib, c);
    }
    return c;
  }
  /** TPS 正向：SVG 世界坐标 → [lon, lat] */
  function tpsForward(calib, x, y) {
    const c = tpsCache(calib);
    const uk = x * c.k, vk = y * c.k;
    let lon = c.aL[0] + c.aL[1] * uk + c.aL[2] * vk;
    let lat = c.aT[0] + c.aT[1] * uk + c.aT[2] * vk;
    for (let i = 0; i < c.n; i++) {
      const dx = uk - c.kx[i], dy = vk - c.ky[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > 1e-12) { const U = d2 * Math.log(d2); lon += c.wl[i] * U; lat += c.wt[i] * U; }
    }
    return [lon, lat];
  }
  /** TPS 反向：[lon, lat] → SVG。affine 初值 + 牛顿迭代（解析雅可比，dU/dd2 = ln d2 + 1）；不收敛返回 null */
  function tpsInverse(calib, lon, lat) {
    const c = tpsCache(calib);
    const det = c.aL[1] * c.aT[2] - c.aL[2] * c.aT[1];
    if (!isFinite(det) || Math.abs(det) < 1e-15) return null;
    const gl = lon - c.aL[0], gt = lat - c.aT[0];
    let uk = (gl * c.aT[2] - gt * c.aL[2]) / det;
    let vk = (gt * c.aL[1] - gl * c.aT[1]) / det;
    for (let it = 0; it < 50; it++) {
      let fl = c.aL[0] + c.aL[1] * uk + c.aL[2] * vk - lon;
      let ft = c.aT[0] + c.aT[1] * uk + c.aT[2] * vk - lat;
      let fl_u = c.aL[1], fl_v = c.aL[2], ft_u = c.aT[1], ft_v = c.aT[2];
      for (let i = 0; i < c.n; i++) {
        const dx = uk - c.kx[i], dy = vk - c.ky[i];
        const d2 = dx * dx + dy * dy;
        if (d2 > 1e-12) {
          const lg = Math.log(d2), U = d2 * lg, g = 2 * (lg + 1);
          fl += c.wl[i] * U; ft += c.wt[i] * U;
          fl_u += c.wl[i] * g * dx; fl_v += c.wl[i] * g * dy;
          ft_u += c.wt[i] * g * dx; ft_v += c.wt[i] * g * dy;
        }
      }
      if (Math.hypot(fl, ft) < 1e-12) break;
      const J = fl_u * ft_v - fl_v * ft_u;
      if (!isFinite(J) || Math.abs(J) < 1e-18) return null;
      uk -= (fl * ft_v - ft * fl_v) / J;
      vk -= (ft * fl_u - fl * ft_u) / J;
      if (!isFinite(uk) || !isFinite(vk)) return null;
    }
    return [uk / c.k, vk / c.k];
  }
  /** 标定正向（按 model 分派）：SVG 世界坐标 → [lon, lat] */
  function calibForward(calib, x, y) {
    return calib.model === 'tps' ? tpsForward(calib, x, y) : poly3Forward(calib, x, y);
  }
  /** 标定反向（按 model 分派）：[lon, lat] → SVG 世界坐标；不收敛返回 null */
  function calibInverse(calib, lon, lat) {
    return calib.model === 'tps' ? tpsInverse(calib, lon, lat) : poly3Inverse(calib, lon, lat);
  }
  // ---- Web Mercator 瓦片数学 ----
  function lonToTileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function latToTileY(lat, z) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }
  function tileXToLon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function tileYToLat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  const SHLogic = { SEG_ORDER, SEG_LABEL, ROLE_LABEL, EPS, segInsert, segRemove,
    nextStopSeq, fixStatusField, lineIssues, planBulkFill,
    planStopImport, applyStopImport, suggestForStop,
    calibForward, calibInverse, tpsForward, tpsInverse, poly3Forward, poly3Inverse,
    lonToTileX, latToTileY, tileXToLon, tileYToLat };
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
    stationPresets: [],      // fmt/stations-import@1 的 items（站圆预置，只读参考数据，不进撤销/暂存）
    calibTps: null,          // fmt/calibration@2（model:"tps"；svg→经纬度，边缘标定 v2）
    calibDeg3: null,         // fmt/calibration@1（旧全局 deg3；data/calibration-deg3-backup.json）
    calibChoice: 'tps',      // 当前标定方案 'tps' | 'deg3'（偏好存 localStorage）
    get calib() { return this.calibChoice === 'deg3' ? this.calibDeg3 : this.calibTps; },
    basemapOn: false,        // OSM 底图开关（偏好存 localStorage）
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

  /** 站圆预置（fmt/stations-import@1）载入：items 并入 S.stationPresets，同源替换。只读参考数据。
   *  去重键用 obj.source（内容级标识）——boot 自动拉取与手动载入同一文件不会重复堆积。 */
  function addStationPreset(obj, fileName) {
    const src = obj.source || fileName || '（未知来源）';
    S.stationPresets = S.stationPresets.filter((it) => it.presetSource !== src);
    for (const it of obj.items || []) {
      S.stationPresets.push(Object.assign({}, it, { presetSource: src }));
    }
    return (obj.items || []).length;
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

  /** 标定文件归槽：@2/model:"tps" → calibTps，@1(deg3) → calibDeg3。
   *  当前所选方案仍缺文件时自动切到已有方案（首次启动/备份缺失场景）。 */
  function takeCalibration(obj) {
    if (obj && obj.model === 'tps' && obj.schema === 'fmt/calibration@2') {
      S.calibTps = obj;
    } else if (obj && obj.schema === 'fmt/calibration@1') {
      S.calibDeg3 = obj;
    } else {
      return false;
    }
    if (!S.calib) S.calibChoice = S.calibTps ? 'tps' : 'deg3';
    basemapEpoch++;
    if (typeof refreshCalibBtn === 'function') refreshCalibBtn();
    return true;
  }
  function calibLabel(obj) {
    return obj && obj.model === 'tps' ? 'TPS 边缘标定 v2' : 'deg3 旧全局三阶';
  }

  function loadDataObject(obj, fileName) {
    if (obj && obj.schema === 'fmt/import@1') { addImportRecord(obj); return; }
    if (obj && obj.schema === 'fmt/stations-import@1') {
      const n = addStationPreset(obj, fileName);
      renderLineForm(); renderStopList();
      setStatus(`已载入站圆预置 ${n} 条（${fileName || obj.source}）——在线路属性面板「从预置导入车站」。`);
      return;
    }
    if (obj && obj.schema === 'fmt/line@1' && /^l\d{4}$/.test(obj.id || '')) {
      S.lines.set(obj.id, obj);
      S.arcs.delete(obj.id);
      if (!S.activeLine) S.activeLine = obj.id;
      return;
    }
    if (obj && obj.schema === 'fmt/groups@1') { S.groups = obj; return; }
    if (obj && obj.schema === 'fmt/manifest@1') { S.manifest = obj; return; }
    if (obj && (obj.schema === 'fmt/calibration@1' || obj.schema === 'fmt/calibration@2')) {
      takeCalibration(obj);
      $('btnBasemap').classList.toggle('primary', S.basemapOn);
      renderWorld();
      setStatus('已载入标定参数（' + calibLabel(obj) + '），底图可用。');
      return;
    }
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
    // 标定两方案都拉取（新 TPS 主用 + 旧 deg3 备份，供「标定方案」切换/回退）
    const calib = await get('data/calibration.json');
    if (calib && (calib.schema === 'fmt/calibration@1' || calib.schema === 'fmt/calibration@2')) {
      takeCalibration(calib);
    }
    const calibOld = await get('data/calibration-deg3-backup.json');
    if (calibOld && calibOld.schema === 'fmt/calibration@1') takeCalibration(calibOld);
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
          else if (obj && obj.schema === 'fmt/stations-import@1') addStationPreset(obj);
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

  // ---------- OSM 底图（瓦片垫层，仅本地参考；需标定 fmt/calibration@1/@2） ----------
  let basemapG = null;
  const basemapTiles = new Map();   // "z/x/y" -> <image>
  let basemapEpoch = 0;             // 标定方案/参数变化计数：瓦片 transform 只在跨 epoch 重算
  let basemapTimer = null;
  function scheduleBasemap() {
    clearTimeout(basemapTimer);
    basemapTimer = setTimeout(updateBasemap, 120);
  }
  function updateBasemap() {
    if (!basemapG) return;
    if (!S.basemapOn || !S.calib || !S.view) {
      basemapTiles.clear();
      basemapG.textContent = '';
      $('osmAttr').style.display = 'none';
      return;
    }
    $('osmAttr').style.display = 'block';
    // 视野四角 → 经纬度范围（标定前向）
    const cs = [[S.view.x, S.view.y], [S.view.x + S.view.w, S.view.y],
      [S.view.x, S.view.y + S.view.h], [S.view.x + S.view.w, S.view.y + S.view.h]];
    const geoC = cs.map((p) => calibForward(S.calib, p[0], p[1]));
    const lonMin = Math.min(...geoC.map((g) => g[0])), lonMax = Math.max(...geoC.map((g) => g[0]));
    const latMin = Math.min(...geoC.map((g) => g[1])), latMax = Math.max(...geoC.map((g) => g[1]));
    // zoom：自高向低取首个"中心处单瓦片屏幕宽 ≥140px"的层级（平衡清晰度与瓦片数）
    const cLon = (lonMin + lonMax) / 2, cLat = (latMin + latMax) / 2;
    const wpp = worldPerPixel();
    let z = 3;
    for (let zz = 19; zz >= 3; zz--) {
      z = zz;
      const dlon = 360 / Math.pow(2, zz);
      const p1 = calibInverse(S.calib, cLon - dlon / 2, cLat);
      const p2 = calibInverse(S.calib, cLon + dlon / 2, cLat);
      const px = p1 && p2 ? Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / wpp : Infinity;
      if (px >= 140) break;
    }
    // 可见瓦片数超过 80 就降层重算
    let x0, y0, x1, y1;
    for (let k = 0; k < 5; k++) {
      x0 = Math.floor(lonToTileX(lonMin, z)); x1 = Math.floor(lonToTileX(lonMax, z));
      y0 = Math.floor(latToTileY(latMax, z)); y1 = Math.floor(latToTileY(latMin, z));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 80) break;
      z--;
    }
    const need = new Set();
    const nT = Math.pow(2, z);
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = Math.max(0, y0); ty <= Math.min(y1, nT - 1); ty++) {
        const key = `${z}/${tx}/${ty}`;
        need.add(key);
        let img = basemapTiles.get(key);
        if (!img) {
          img = el('image', { width: 256, height: 256, class: 'basemap-tile' }, basemapG);
          img.setAttribute('href', `https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`);
          basemapTiles.set(key, img);
        }
        // 瓦片像素 → SVG 世界：三点仿射（(0,0)(256,0)(0,256)），标定在小范围内近似线性；
        // transform 只在标定方案变化（跨 epoch）时重算（TPS 反演较贵，避免平移高频重算）
        if (img.dataset.epoch !== String(basemapEpoch)) {
          const lonW = tileXToLon(tx, z), lonE = tileXToLon(tx + 1, z);
          const latN = tileYToLat(ty, z), latS = tileYToLat(ty + 1, z);
          const p00 = calibInverse(S.calib, lonW, latN);
          const p10 = calibInverse(S.calib, lonE, latN);
          const p01 = calibInverse(S.calib, lonW, latS);
          if (!p00 || !p10 || !p01) continue;
          const a = (p10[0] - p00[0]) / 256, b = (p01[0] - p00[0]) / 256;
          const d = (p10[1] - p00[1]) / 256, e2 = (p01[1] - p00[1]) / 256;
          img.setAttribute('transform', `matrix(${a} ${d} ${b} ${e2} ${p00[0]} ${p00[1]})`);
          img.dataset.epoch = String(basemapEpoch);
        }
      }
    }
    for (const [key, img] of basemapTiles) {
      if (!need.has(key)) { img.remove(); basemapTiles.delete(key); }
    }
  }

  // ---------- 渲染 ----------
  function segPathString(ap, t1, t2) {
    const pts = ap.polylineBetween(t1, t2);
    if (!pts.length) return '';
    return 'M' + pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L');
  }

  function renderWorld() {
    // 底图组跨渲染持久保留（否则打字等高频重绘会反复清空瓦片造成闪烁）
    if (basemapG && basemapG.parentNode === world) world.removeChild(basemapG);
    world.textContent = '';
    if (!basemapG) basemapG = el('g', { id: 'basemap' });
    world.insertBefore(basemapG, world.firstChild);
    scheduleBasemap();
    const scale = S.view ? Math.max(svg.clientWidth, 1) / S.view.w : 1;
    const rStop = 5.5 / scale, ringR = 8.5 / scale, hintR = 12 / scale;

    // 换乘组索引：同站组隐藏成员小圈（画合并圈）；出闸组成员圈描黑边
    const stationGroups = (S.groups && S.groups.stationGroups) || [];
    const grpOf = new Map();               // sid -> 组对象
    const mergedHidden = new Set();        // 同站组成员 sid
    for (const g of stationGroups) {
      for (const sid of g.stops) grpOf.set(sid, g);
      if (g.type === 'same-station') for (const sid of g.stops) mergedHidden.add(sid);
    }

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

      // 设站（同站换乘组成员的独立小圈不画，统一画合并圈；出闸换乘描黑边）
      stops.forEach((st, idx) => {
        if (mergedHidden.has(st.id)) return;
        const [x, y] = ap.pointAt(st.t);
        const isSel = S.selStop === st.id && lid === S.activeLine;
        const isPend = S.pending.includes(st.id);
        const grp = grpOf.get(st.id);
        const oos = grp && grp.type === 'out-of-station';
        if (isSel) el('circle', { cx: x, cy: y, r: ringR, class: 'stop-ring',
          'vector-effect': 'non-scaling-stroke' }, gLine);
        const c = el('circle', { cx: x, cy: y, r: rStop, class: 'stop-c' + (isPend ? ' pend' : ''),
          stroke: oos ? '#000' : line.color, 'stroke-width': 2 / scale }, gLine);
        c.dataset.lid = lid; c.dataset.sid = st.id;
        const t = el('title', {}, c);
        t.textContent = `${idx + 1}. ${st.name || '（未命名）'}  t=${st.t.toFixed(4)}`
          + (oos ? `  ${grp.id}（出闸换乘）` : '');
      });
    }

    // 同站换乘合并圈：位置取距所有成员线路最近点（投影质心迭代收敛）
    for (const g of stationGroups) {
      if (g.type !== 'same-station') continue;
      const members = [];
      for (const sid of g.stops) {
        for (const [lid2, line2] of S.lines) {
          const st = line2.stops.find((x) => x.id === sid);
          if (st) {
            const ap2 = arcOf(lid2);
            if (ap2) members.push({ ap: ap2, st });
          }
        }
      }
      if (!members.length) continue;
      let px = 0, py = 0;
      for (const m of members) { const p = m.ap.pointAt(m.st.t); px += p[0]; py += p[1]; }
      px /= members.length; py /= members.length;
      for (let it = 0; it < 12; it++) {
        let sx = 0, sy = 0;
        for (const m of members) {
          const pr = m.ap.project(px, py);
          sx += pr.p[0]; sy += pr.p[1];
        }
        const nx = sx / members.length, ny = sy / members.length;
        const moved = Math.hypot(nx - px, ny - py);
        px = nx; py = ny;
        if (moved < 1e-3) break;
      }
      const anyPend = g.stops.some((sid) => S.pending.includes(sid));
      const c = el('circle', { cx: px, cy: py, r: 7.5 / scale,
        class: 'stop-merge' + (anyPend ? ' pend' : ''),
        stroke: '#000', 'stroke-width': 2.2 / scale }, world);
      c.dataset.grp = g.id;
      const t = el('title', {}, c);
      t.textContent = `${g.id} 同站换乘：${g.stops.map((sid) => stopLabel(sid)).join('；')}`;
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
          ${(p.hintNames && p.hintNames.length)
            ? `<span class="imp-hint" title="自动就近匹配的源图文字，仅供参考，不保证正确">≈${esc(p.hintNames.join(' / '))}</span>` : ''}
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

  // 本线 path 对应的导入建议名（自动就近匹配的源图文字，仅供参考）
  function importHintsFor(l) {
    if (!l || !l.path) return [];
    for (const imp of S.imports) {
      const p = imp.paths.find((x) => x.path === l.path);
      if (p && p.hintNames && p.hintNames.length) return p.hintNames;
    }
    return [];
  }

  /** 线路 → 匹配的站圆预置项（fmt/stations-import@1）。
   *  绑定优先级：① path 字符串精确命中导入记录 → 按 sourceLayer 对名（W1 真名期）；
   *  ② 几何签名（首点/bbox/弧长，容差 0.5pt/2pt/0.5%——补 Z 等不改变几何的重导不受影响）。
   *  预置项 signature 由 tools/station_extract.py 从 import path 计算，与 path-NN 命名无关。 */
  function matchPresetForLine(l) {
    if (!l || !l.path || !S.stationPresets.length) return null;
    for (const imp of S.imports) {
      const p = imp.paths.find((x) => x.path === l.path);
      if (p) {
        const byName = S.stationPresets.find((it) => it.sourceLayer === p.sourceLayer);
        if (byName) return byName;
        break;   // path 已精确命中但预置无同名项（旧预置×新导入混用）→ 落到几何签名
      }
    }
    const ap = arcOf(l.id);
    if (!ap || !ap.pts.length) return null;
    const bb = ap.bbox();
    for (const it of S.stationPresets) {
      const sg = it.signature;
      if (!sg || !sg.first || !sg.bbox) continue;
      if (Math.hypot(sg.first[0] - ap.pts[0][0], sg.first[1] - ap.pts[0][1]) > 0.5) continue;
      if (Math.abs(sg.bbox[0] - bb[0]) > 2 || Math.abs(sg.bbox[1] - bb[1]) > 2 ||
        Math.abs(sg.bbox[2] - bb[2]) > 2 || Math.abs(sg.bbox[3] - bb[3]) > 2) continue;
      if (Math.abs(sg.length - ap.length) > Math.max(2, 0.005 * ap.length)) continue;
      return it;
    }
    return null;
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
      ${importHintsFor(l).length ? `
      <div class="fld"><label>建议名</label><span class="hintline" style="flex:1">
        ${importHintsFor(l).map((n) => `<span class="namehint" data-namehint="${esc(n)}"
          title="源图附近自动匹配的文字，仅供参考；点击采用">${esc(n)}</span>`).join('')}
        <span style="color:var(--dim);font-size:10px">（自动匹配，不保证正确）</span>
      </span></div>` : ''}
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
      ${(() => {
        const it = matchPresetForLine(l);
        if (!it) return `<div class="fld"><label>站圆预置</label><span style="flex:1;color:var(--dim);font-size:11px">（无匹配${S.stationPresets.length ? '' : '——未载入预置文件'}）</span></div>`;
        const ns = it.stops.filter((s) => s.nameSuggestion).length;
        return `<div class="fld"><label>站圆预置</label><span style="flex:1" class="preset-line">
          <button class="mini primary" id="lfImportStops" title="按站圆圆心的弧长投影 t 批量落站；已有站 |Δt|<0.002 跳过；撤销一次回退整批">从预置导入车站</button>
          <span style="color:var(--dim);font-size:11px">${esc(it.stationGroup)} · ${it.stops.length} 圆${ns ? ` · ${ns} 带站名建议` : ''}</span>
        </span></div>`;
      })()}
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
    const preset = matchPresetForLine(l);   // 站名建议来源（无匹配则无 chips）
    box.innerHTML = l.stops.map((st, i) => {
      const prev = i > 0 ? l.stops[i - 1].t : null;
      const next = i < l.stops.length - 1 ? l.stops[i + 1].t : null;
      const tBad = st.t < 0 || st.t >= 1 || (prev !== null && st.t <= prev) || (next !== null && st.t >= next);
      // 站名建议 chip：仅空名站展示（源图就近文字，点选才写入；绝不自动命名）
      const sug = preset && !(st.name && st.name.trim()) ? suggestForStop(preset, st.t) : null;
      return `
      <div class="stop-row ${S.selStop === st.id ? 'sel' : ''} ${S.pending.includes(st.id) ? 'pend' : ''}" data-sid="${st.id}">
        <span class="idx">${i + 1}</span>
        <input type="text" value="${esc(st.name)}" data-ren="${st.id}"
          class="${st.name ? '' : 'warn'}" placeholder="（站名）">
        ${sug ? `<span class="namehint stop-suggest" data-sugsid="${st.id}" data-sugname="${esc(sug.name)}"
          title="源图就近文字（距站圆 ${sug.dist}pt），仅供参考、不保证正确；点击采用">${esc(sug.name)}</span>` : ''}
        <input type="text" value="${st.t.toFixed(6)}" data-tedit="${st.id}"
          class="tin${tBad ? ' warn' : ''}" title="弧长位置 t∈[0,1)，可手改（如起点改 0）">
        <button class="mini danger" data-del="${st.id}" title="删除设站">✕</button>
      </div>`;
    }).join('');
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
            <option value="same-station" ${g.type === 'same-station' ? 'selected' : ''}>同站</option>
            <option value="out-of-station" ${g.type === 'out-of-station' ? 'selected' : ''}>出闸</option>
            <option value="" ${!g.type ? 'selected' : ''}>type 未定</option>
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
      // name 留空待人工录入（不擅自命名）；源图匹配文字只作属性面板里的建议名
      schema: 'fmt/line@1', id: lid, name: '',
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
    setStatus(`已建线 ${lid}。请在属性面板命名（导入匹配文字仅作建议），再到「加站」模式点击线路设站。`);
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

  /** 站圆预置批量落站：一次快照、整批插入、撤销一次回退整批。
   *  站名一律不写入（预置 nameSuggestion 仅作 chips 建议点选采用）；不自动建换乘编组。 */
  function importStopsFromPreset() {
    const l = S.lines.get(S.activeLine);
    if (!l) return;
    const item = matchPresetForLine(l);
    if (!item) { setStatus('当前线路没有匹配的站圆预置（预置按几何签名绑定，与 path-NN 命名无关）。', true); return; }
    const plan = planStopImport(l, item.stops);
    if (!plan.total) { setStatus('该预置项没有站圆。', true); return; }
    if (!plan.inserts.length) {
      setStatus(`预置 ${plan.total} 圆位置均已有站（|Δt|<0.002），本次未导入。`);
      return;
    }
    snapshot();
    const added = applyStopImport(l, plan);
    l.meta.updated = today();
    renderAll();
    setStatus(`站圆预置导入「${item.stationGroup}」：新增 ${added.length} 站`
      + `、跳过 ${plan.skippedExist}（已有站在位）`
      + (plan.skippedConflict ? `、${plan.skippedConflict}（位置过近冲突）` : '')
      + `、预置共 ${plan.total} 圆。站名未写入——空名站旁的建议 chips 点选采用；撤销一次回退整批。`);
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
  let drag = null;     // {type:'stop', lid, sid, moved, pre}
  let panning = null;  // {x,y,sx,sy,view,moved}；点按位移 ≤4px 视为点击而非拖动
  let rubber = null;   // 编组模式拉框 {x0,y0,x1,y1,sx,sy,moved}（世界坐标）

  function startPan(e) {
    panning = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY,
      view: { ...S.view }, moved: false };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  }

  function nearestLineAt(wx, wy) {
    const wpp = worldPerPixel();
    const maxD = 40 * wpp;
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
    if (e.button === 1) { startPan(e); return; }          // 中键：任何位置、任何模式平移
    if (e.button !== 0) return;
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
    if (S.mode === 'group') {
      if (stopEl) return;                                  // 站圈点按：pointerup 切换待编组
      const [wx, wy] = toWorld(e);                         // 其余任意处起拉：拉框直接建组
      rubber = { x0: wx, y0: wy, x1: wx, y1: wy, sx: e.clientX, sy: e.clientY, moved: false };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    startPan(e);   // 选择/加站：空白或线路上左键拖动平移；未移动的松手仍按点击处理
  });

  svg.addEventListener('pointermove', (e) => {
    if (panning && S.view) {
      if (Math.hypot(e.clientX - panning.sx, e.clientY - panning.sy) > 4) panning.moved = true;
      const kx = S.view.w / svg.clientWidth;
      S.view.x = panning.view.x - (e.clientX - panning.x) * kx;
      S.view.y = panning.view.y - (e.clientY - panning.y) * kx;
      applyView();
      scheduleBasemap();   // 平移只改 viewBox 不重绘，底图需单独补瓦片
      return;
    }
    if (rubber) {
      const [wx, wy] = toWorld(e);
      rubber.x1 = wx; rubber.y1 = wy;
      if (Math.hypot(e.clientX - rubber.sx, e.clientY - rubber.sy) > 4) rubber.moved = true;
      const r = $('rubber');
      r.style.display = '';
      r.setAttribute('x', Math.min(rubber.x0, rubber.x1).toFixed(2));
      r.setAttribute('y', Math.min(rubber.y0, rubber.y1).toFixed(2));
      r.setAttribute('width', Math.abs(rubber.x1 - rubber.x0).toFixed(2));
      r.setAttribute('height', Math.abs(rubber.y1 - rubber.y0).toFixed(2));
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
    if (panning) {
      const wasPan = panning.moved;
      panning = null;
      svg.classList.remove('panning');
      if (wasPan) return;          // 确实拖动过：这是平移，吞掉点击语义
    }
    if (rubber) {
      const rb = rubber;
      rubber = null;
      $('rubber').style.display = 'none';
      if (rb.moved) { boxSelectStops(rb); return; }
    }
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
        setStatus('点击位置不在任何线路附近（吸附半径 40px）。', true);
      }
      return;
    }

    if (S.mode === 'group') {
      const mgEl = e.target.closest('.stop-merge');
      if (mgEl) {
        const g = S.groups.stationGroups.find((x) => x.id === mgEl.dataset.grp);
        if (g) {
          const allIn = g.stops.every((sid) => S.pending.includes(sid));
          S.pending = allIn ? S.pending.filter((sid) => !g.stops.includes(sid))
            : [...new Set([...S.pending, ...g.stops])];
          renderAll();
          setStatus(allIn ? `已将 ${g.id} 全员移出待编组。` : `已将 ${g.id} 全员加入待编组。`);
        }
        return;
      }
      const stopEl = e.target.closest('.stop-c');
      if (stopEl) {
        const sid = stopEl.dataset.sid;
        S.pending = S.pending.includes(sid) ? S.pending.filter((x) => x !== sid) : [...S.pending, sid];
        renderAll();
        return;
      }
    }

    // select 模式的点击
    const mgSel = e.target.closest('.stop-merge');
    if (mgSel) {
      const g = S.groups.stationGroups.find((x) => x.id === mgSel.dataset.grp);
      if (g) setStatus(`${g.id} 同站换乘组：${g.stops.map((sid) => stopLabel(sid)).join('；')}`);
      return;
    }
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

  /** 编组模式拉框收尾：框内 ≥2 站直接建组（免确认）；已在其他组的站跳过并提示 */
  function boxSelectStops(rb) {
    const x0 = Math.min(rb.x0, rb.x1), x1 = Math.max(rb.x0, rb.x1);
    const y0 = Math.min(rb.y0, rb.y1), y1 = Math.max(rb.y0, rb.y1);
    const inside = [];
    for (const [lid, line] of S.lines) {
      if (line.meta && line.meta.archived) continue;
      const ap = arcOf(lid);
      if (!ap) continue;
      for (const st of line.stops) {
        const p = ap.pointAt(st.t);
        if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1) inside.push(st.id);
      }
    }
    if (!inside.length) { setStatus('框内没有设站。', true); return; }
    // 一设站至多一组：已在其他组的站跳过（要改先拆组），不阻断其余建组
    const grouped = new Set();
    for (const g of (S.groups && S.groups.stationGroups) || []) {
      for (const sid of g.stops) grouped.add(sid);
    }
    const skipped = inside.filter((sid) => grouped.has(sid));
    const fresh = inside.filter((sid) => !grouped.has(sid));
    if (fresh.length < 2) {
      setStatus(`框内 ${inside.length} 站中可建组的仅 ${fresh.length} 站`
        + (skipped.length ? `（${skipped.length} 站已在其他组，先拆组再框）` : '') + '，不足 2 站，未建组。', true);
      return;
    }
    if (!S.groups) S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    snapshot();
    const id = bumpCounter('nextG', 'g', 4);
    S.groups.stationGroups.push({ id, stops: fresh, type: 'same-station', info: {} });
    S.pending = S.pending.filter((sid) => !fresh.includes(sid));   // 已入组的不再留在待编组
    renderAll();
    setStatus(`拉框已建换乘节点组 ${id}（${fresh.length} 站，默认同站；可改出闸/未定）`
      + (skipped.length ? `；跳过 ${skipped.length} 站（已在其他组）。` : '。'));
  }

  svg.addEventListener('pointercancel', () => {
    panning = null; rubber = null; drag = null;
    svg.classList.remove('panning');
    $('rubber').style.display = 'none';
  });

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
    const sugEl = e.target.closest('[data-sugsid]');   // 站名建议 chip：点选采用（人工确认写入）
    if (sugEl) {
      const line = S.lines.get(S.activeLine);
      const st = line && line.stops.find((s) => s.id === sugEl.dataset.sugsid);
      if (st) {
        snapshot();
        st.name = sugEl.dataset.sugname;
        line.meta.updated = today();
        renderAll();
        setStatus(`已采用建议站名「${st.name}」（可继续修改）。`);
      }
      return;
    }
    const row = e.target.closest('.stop-row');
    if (!row) return;
    if (S.selStop === row.dataset.sid) return;   // 已选中：不动，避免打断输入框
    S.selStop = row.dataset.sid;
    // 只切换高亮，不重建列表（重建会销毁正在交互的输入框导致失焦）
    for (const r of $('stopList').querySelectorAll('.stop-row')) {
      r.classList.toggle('sel', r.dataset.sid === S.selStop);
    }
    renderWorld();
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

  $('stopList').addEventListener('change', (e) => {
    const sid = e.target.dataset.tedit;
    if (!sid) return;
    const line = S.lines.get(S.activeLine);
    const st = line && line.stops.find((s) => s.id === sid);
    if (!st) return;
    const v = parseFloat(e.target.value);
    if (!isFinite(v) || v < 0 || v >= 1) {
      e.target.value = st.t.toFixed(6);
      e.target.classList.add('warn');
      setStatus('t 需为 [0,1) 内的数字，已还原。', true);
      return;
    }
    const nv = Math.round(v * 1e6) / 1e6;
    if (nv !== st.t) {
      snapshot();
      st.t = nv;
      line.meta.updated = today();
      renderWorld(); autosave();
    }
    // 与邻站比较给出即时告警（保存仍由 lineIssues/validate 把关）
    const i = line.stops.indexOf(st);
    const prev = i > 0 ? line.stops[i - 1].t : null;
    const next = i < line.stops.length - 1 ? line.stops[i + 1].t : null;
    const bad = (prev !== null && st.t <= prev) || (next !== null && st.t >= next);
    e.target.classList.toggle('warn', bad);
    e.target.value = st.t.toFixed(6);
    if (bad) setStatus('警告：t 未严格递增（保存线路时会被拦截）。', true);
    else setStatus(`t 已更新为 ${st.t}。`);
  });

  // 批量命名：先点完全线设站、再一次贴入名字（与逐站命名并存，互不破坏）
  $('btnBulkFill').addEventListener('click', () => {
    const line = S.lines.get(S.activeLine);
    if (!line) { setStatus('没有当前线路，无法批量命名。', true); return; }
    const plan = planBulkFill(line, $('bulkNames').value.split(/\r?\n/));
    if (!plan.total) { setStatus('批量命名：每行一个站名，当前没有可用的名字。', true); return; }
    if (!plan.pairs.length) {
      setStatus(`当前线没有站名为空的设站（${plan.total} 个名字未用）。`, true);
      return;
    }
    snapshot();
    for (const [st, nm] of plan.pairs) st.name = nm;
    line.meta.updated = today();
    const stillEmpty = line.stops.filter((s) => !s.name || !s.name.trim()).length;
    renderAll();
    setStatus(`已按序填入 ${plan.pairs.length} 个站名`
      + (plan.total > plan.pairs.length ? `（${plan.total - plan.pairs.length} 个多余未用）` : '')
      + (stillEmpty ? `；仍有 ${stillEmpty} 站未命名。` : '；当前线全部站已命名。'));
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
    if (e.target.dataset.namehint !== undefined) {   // 建议名：点选采用（人工确认后才写入）
      const l = S.lines.get(S.activeLine);
      if (!l) return;
      snapshot();
      l.name = e.target.dataset.namehint;
      l.meta.updated = today();
      renderLineForm(); renderLineList(); renderWorld(); autosave();
      setStatus(`已采用建议名「${l.name}」为 ${l.id} 命名（可继续在名称框修改）。`);
      return;
    }
    if (e.target.id === 'lfUpdatePath') updatePathFromImport();
    if (e.target.id === 'lfImportStops') importStopsFromPreset();
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
    if (g) { g.type = e.target.value || null; renderWorld(); autosave(); }
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
      S.groups.stationGroups.push({ id, stops: [...S.pending], type: 'same-station', info: {} });
      S.pending = [];
      renderAll();
      setStatus(`已建换乘节点组 ${id}（默认同站：合并为一个黑边大圈；可在列表改出闸/未定）。`);
    }
  });

  // 折叠面板
  for (const h of document.querySelectorAll('section > h3')) {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  }

  // ---------- 模式与撤销 ----------
  S.basemapOn = localStorage.getItem('shrail.basemap') === '1';
  $('btnBasemap').addEventListener('click', () => {
    if (!S.basemapOn && !S.calib) {
      setStatus('无标定参数：先运行 python tools/calib2_fit.py（TPS）或 python tools/georef.py <svg> <kml> --emit'
        + ' 生成 data/calibration.json（或用「数据文件」按钮载入），再开底图。', true);
      return;
    }
    S.basemapOn = !S.basemapOn;
    localStorage.setItem('shrail.basemap', S.basemapOn ? '1' : '0');
    $('btnBasemap').classList.toggle('primary', S.basemapOn);
    renderWorld();
    setStatus(S.basemapOn
      ? `底图已开启：© OpenStreetMap contributors（${calibLabel(S.calib)}；对位精度≈标定残差`
        + (S.calib && S.calib.model === 'tps' ? '：全图 133 m / 郊区明显改善）' : ' 80 m，仅中4线控区）') + '。'
      : '底图已关闭。');
  });

  // 标定方案切换（TPS v2 ↔ 旧 deg3）：可视化 A/B 与回退通道；偏好记 localStorage
  S.calibChoice = localStorage.getItem('shrail.calib') === 'deg3' ? 'deg3' : 'tps';
  function refreshCalibBtn() {
    $('btnCalib').textContent = S.calibChoice === 'deg3' ? '标定 deg3' : '标定 TPS';
    $('btnCalib').classList.toggle('primary', S.calibChoice === 'tps');
    $('btnCalib').disabled = !S.calibTps && !S.calibDeg3;   // 两方案都缺才禁用
  }
  $('btnCalib').addEventListener('click', () => {
    const other = S.calibChoice === 'tps' ? 'deg3' : 'tps';
    const target = other === 'deg3' ? S.calibDeg3 : S.calibTps;
    if (!target) {
      setStatus(`标定方案「${other === 'tps' ? 'TPS' : 'deg3'}」的文件未载入`
        + (other === 'deg3' ? '（data/calibration-deg3-backup.json 缺失？用「数据文件」载入或 git 历史找回）'
          : '（data/calibration.json 不是 fmt/calibration@2？运行 python tools/calib2_fit.py 重生成）'), true);
      return;
    }
    S.calibChoice = other;
    localStorage.setItem('shrail.calib', other);
    basemapEpoch++;
    basemapTiles.clear();
    if (basemapG) basemapG.textContent = '';   // 旧方案瓦片全部作废（epoch 已变）
    refreshCalibBtn();
    renderWorld();
    setStatus(`标定方案已切换为「${calibLabel(target)}」` + (S.basemapOn ? '，底图已按新方案重摆。' : '。')
      + (other === 'deg3' ? '（回退通道：旧模型仅中4线控区准，郊区漂移 km 级）' : '（边缘标定 v2：郊区大幅改善，中4线 33~105 m）'));
  });
  refreshCalibBtn();

  const MODE_HINT = {
    select: '选择：点击设站选中（左侧改名）、拖动设站沿线移动、点击线段循环切换状态；左键拖动平移、滚轮缩放。',
    add: '加站：点击线路附近即可加站（吸附半径 40px，自动记弧长 t）。可以先一路点完，再展开「批量命名」一次贴入站名。',
    group: '编组：任意处拉框直接建组（框内 ≥2 站即建，已在其他组的跳过）；也可点选站圈攒待编组后点「编组」；中键拖动平移。',
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
        if (obj.schema === 'fmt/import@1') addImportRecord(obj);
        else if (obj.schema === 'fmt/stations-import@1') {
          const n = addStationPreset(obj, f.name);
          setStatus(`已载入站圆预置 ${n} 条（${f.name}）。`);
        }
        else throw new Error('不是 fmt/import@1 或 fmt/stations-import@1');
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
    $('btnBasemap').classList.toggle('primary', S.basemapOn && !!S.calib);
    refreshCalibBtn();
    offerRestore();
    if (!S.view) fitView();
    setStatus(MODE_HINT.select);
    $('canvasHint').textContent = MODE_HINT.select;
    renderAll();
  })();
})(typeof globalThis !== 'undefined' ? globalThis : this);
