// viewer_core.js —— 阶段 3 查看器·纯逻辑层（2026-11-21）
// 不依赖 DOM / maplibre / editor.js：数据归一（线路聚合、站点平表、换乘组归并）、
// 搜索匹配、标签分级、单线导出（GeoJSON 对象 / KML 字符串）、线层透明度表达式构造
//（单层 match 版＋按 segStatus 拆层版）、显示文案（起讫格式化、未名站占位）。
// 浏览器端挂 globalThis.VIEWER_CORE；node 端（tools/test_viewer_logic.js）走 module.exports。
// 数据契约：net/lines.geojson（每 feature＝线×分段）、net/stops.geojson（每 feature＝线×站）。
// 2026-11-21 增：出省箭头（stop.kind:'arrow'——非站，不进组/标签/摘要/导出，仅出 arrows 视图）、
// ≥3 线同站组药丸链序（planGroupPillChain 贪心最近邻，与编辑器侧逐字节同规格）。

(function (G) {
  'use strict';

  // ---------- 常量（结构字段与枚举全英文；中文仅显示文案） ----------
  const SEG_STATUS_OPACITY = { existing: 1.0, approved: 0.75, future: 0.45 };
  const DEFAULT_LINE_COLOR = '#888888';
  const GROUP_TYPE_ZH = { 'same-station': '同站换乘', 'out-of-station': '出闸换乘', junction: '接轨站' };
  const ROLE_ZH = { main: '主线', branch: '支线', connector: '联络线', standalone: '独立线' };
  const SEG_STATUS_ZH = { existing: '既有', approved: '已批复', future: '远期' };
  const LABEL_CAP = 800;        // 标签数量上限：超过则只显示换乘组标签（防低 zoom 糊屏）
  const LABEL_ZOOM_GROUP = 10;  // 换乘组标签最低 zoom
  const LABEL_ZOOM_STOP = 12;   // 普通站标签最低 zoom

  // ---------- 小工具 ----------
  // XML 文本转义（KML 用）
  function xmlEscape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  // '#rgb'/'#rrggbb'/'rrggbb' → '#rrggbb' 小写；非法输入返回 null
  function normalizeHex(hex) {
    if (typeof hex !== 'string') return null;
    let h = hex.trim().replace(/^#/, '');
    if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return '#' + h.toLowerCase();
  }
  // '#rrggbb' → KML 颜色 aabbggrr（alpha 默认 1）
  function hexToKmlColor(hex, alpha) {
    const h = normalizeHex(hex);
    if (!h) return 'ffffffff';
    const a = Math.round(255 * Math.min(Math.max(Number.isFinite(alpha) ? alpha : 1, 0), 1));
    return a.toString(16).padStart(2, '0') + h.slice(5, 7) + h.slice(3, 5) + h.slice(1, 3);
  }
  // 数值容差转字符串（坐标导出用，非数值兜底 0）
  function num(v) { return Number.isFinite(v) ? v : 0; }

  // ---------- 数据归一 ----------
  // lines.geojson → Map<lineId, line>；line.segments 按 segIndex 升序（稳定），
  // 非法 feature（无 lineId / 非 LineString / 坐标 <2 点）跳过不炸。
  function normalizeLines(fc) {
    const out = new Map();
    const feats = (fc && Array.isArray(fc.features)) ? fc.features : [];
    for (const f of feats) {
      const p = (f && f.properties) || {};
      const g = (f && f.geometry) || {};
      if (p.lineId == null || g.type !== 'LineString' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) continue;
      const id = String(p.lineId);
      let line = out.get(id);
      if (!line) {
        line = {
          lineId: id,
          name: typeof p.name === 'string' ? p.name : '',
          aliases: Array.isArray(p.aliases) ? p.aliases.filter((a) => typeof a === 'string' && a) : [],
          color: normalizeHex(p.color) || DEFAULT_LINE_COLOR,
          role: typeof p.role === 'string' ? p.role : '',
          layer: typeof p.layer === 'string' ? p.layer : '',
          loop: !!p.loop,
          segments: [],
        };
        out.set(id, line);
      }
      line.segments.push({
        segIndex: Number.isFinite(p.segIndex) ? p.segIndex : line.segments.length,
        segStatus: Object.prototype.hasOwnProperty.call(SEG_STATUS_OPACITY, p.segStatus) ? p.segStatus : 'future',
        coords: g.coordinates,
      });
    }
    for (const line of out.values()) {
      line.segments.sort((a, b) => a.segIndex - b.segIndex);
      line.bbox = lineBboxOf(line);
    }
    return out;
  }

  // 线 bbox [minLon,minLat,maxLon,maxLat]；无有效坐标 → null
  function lineBboxOf(line) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const seg of line.segments) {
      for (const pt of seg.coords) {
        const x = pt && pt[0], y = pt && pt[1];
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    return x0 === Infinity ? null : [x0, y0, x1, y1];
  }

  // stops.geojson → 站点平表（非 Point / 坐标缺失跳过；groupId 空串归 null；groupType 未知归 null；
  // kind 缺省归 'stop'——flatten 侧 arrow 站保留输出（block 已在上游剔除））
  function stopList(fc) {
    const out = [];
    const feats = (fc && Array.isArray(fc.features)) ? fc.features : [];
    for (const f of feats) {
      const p = (f && f.properties) || {};
      const g = (f && f.geometry) || {};
      if (g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      const lon = g.coordinates[0], lat = g.coordinates[1];
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      out.push({
        sid: p.sid != null ? String(p.sid) : '',
        name: typeof p.name === 'string' ? p.name : '',
        lineId: p.lineId != null ? String(p.lineId) : '',
        lineName: typeof p.lineName === 'string' ? p.lineName : '',
        t: Number.isFinite(p.t) ? p.t : null,
        groupId: p.groupId != null && p.groupId !== '' ? String(p.groupId) : null,
        groupType: Object.prototype.hasOwnProperty.call(GROUP_TYPE_ZH, p.groupType) ? p.groupType : null,
        kind: typeof p.kind === 'string' && p.kind ? p.kind : 'stop',
        lon, lat,
      });
    }
    return out;
  }

  // ---------- 多线换乘药丸链序（与编辑器侧逐字节同规格） ----------
  // planGroupPillChain(pts)：对每个起点 s∈[0,n) 各跑一次贪心最近邻——从 s 出发，每步从未访问
  // 点中取距链尾最近者（平手取原始下标小者），累计总长；得 n 条候选链。取总长最小者；
  // 平手取 order 序列字典序最小者。返回下标顺序数组（n 个点连 n−1 段，不是两两相连）。
  // 点形：[x,y] 数组或 {x,y} 对象。查看器侧喂投影平面坐标（planarOf 纬度校正近似——
  // 只影响选序不影响语义）。总长平手按浮点严格相等判定（对称几何下同序求和产生逐位一致的和）。
  function planGroupPillChain(pts) {
    const n = Array.isArray(pts) ? pts.length : 0;
    if (n === 0) return [];
    const px = new Array(n), py = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      if (Array.isArray(p)) { px[i] = num(p && p[0]); py[i] = num(p && p[1]); }
      else { px[i] = num(p && p.x); py[i] = num(p && p.y); }
    }
    const d2 = (a, b) => { const dx = px[a] - px[b], dy = py[a] - py[b]; return dx * dx + dy * dy; };
    const len = (a, b) => Math.sqrt(d2(a, b));
    const lexLess = (a, b) => {
      for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
      return false;
    };
    let bestOrder = null, bestTotal = Infinity;
    for (let s = 0; s < n; s++) {
      const used = new Array(n).fill(false);
      const order = [s]; used[s] = true;
      let total = 0, tail = s;
      while (order.length < n) {
        let pick = -1, pickD2 = Infinity;
        for (let j = 0; j < n; j++) {           // j 升序＋严格小于：步内平手恒取更小下标
          if (used[j]) continue;
          const dj = d2(tail, j);
          if (dj < pickD2) { pickD2 = dj; pick = j; }
        }
        used[pick] = true; order.push(pick);
        total += len(tail, pick); tail = pick;
      }
      if (total < bestTotal || (total === bestTotal && lexLess(order, bestOrder))) {
        bestTotal = total; bestOrder = order;
      }
    }
    return bestOrder;
  }

  // lng/lat → 平面近似坐标（局部等距圆柱校正：x＝经度×cos(lat0)、y＝纬度，lat0＝共享参考纬度）。
  // 只用于链序选点与方向推导，不作为真实投影。注意 lat0 必须对同一次比较/同一组点取同一常数：
  // 常因子不改变相对几何；若逐点各乘自己的 cos(lat)，高经度处（上海 lon≈121°）的微小纬差
  // 会被经度基数放大成伪形变（方向角可偏差数度），故调用方一律传组内/点对均值纬度。
  function planarOf(lon, lat, lat0) {
    const ref = Number.isFinite(lat0) ? num(lat0) : num(lat);
    return [num(lon) * Math.cos(ref * Math.PI / 180), num(lat)];
  }

  // ---------- 出省箭头视图（kind:'arrow'，非真实车站） ----------
  // 方向＝normalize(箭头位 − 同线真实邻站位)：邻站取该线按站序（t 序）与箭头相邻的真实站
  //（|Δt| 最小；平手取 t 较小者）；箭头无 t 或该线站全无 t 时退化为几何最近站（防御）。
  // angleDeg＝平面方向自北顺时针度数（icon-rotate 语义：0＝指北、90＝指东）；
  // 取不到邻站或与邻站重合 → angleDeg=null（渲染层退化为小圆点）。
  // 箭头不进 pins/labels（→不进搜索/hover/点选面板）、不进组、不算站数、不进导出。
  function buildArrowViews(stops) {
    const peersByLine = new Map();
    for (const s of stops) {
      if (s.kind === 'arrow') continue;
      if (!peersByLine.has(s.lineId)) peersByLine.set(s.lineId, []);
      peersByLine.get(s.lineId).push(s);
    }
    for (const arr of peersByLine.values()) {
      arr.sort((a, b) => (a.t == null ? 1 : 0) - (b.t == null ? 1 : 0) || num(a.t) - num(b.t));
    }
    const arrows = [];
    let seq = 0;
    for (const a of stops) {
      if (a.kind !== 'arrow') continue;
      const peers = peersByLine.get(a.lineId) || [];
      let nb = null;
      if (a.t != null) {
        let best = Infinity;
        for (const p of peers) {               // 已按 t 升序：严格小于 → |Δt| 平手取 t 较小者
          if (p.t == null) continue;
          const d = Math.abs(num(p.t) - num(a.t));
          if (d < best) { best = d; nb = p; }
        }
      }
      if (!nb && peers.length) {               // 防御兜底：几何最近邻（lat0 取箭头自身纬度作共享常因子）
        const [ax, ay] = planarOf(a.lon, a.lat, a.lat);
        let best2 = Infinity;
        for (const p of peers) {
          const [bx, by] = planarOf(p.lon, p.lat, a.lat);
          const dd = (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
          if (dd < best2) { best2 = dd; nb = p; }
        }
      }
      let angleDeg = null;
      if (nb) {
        const lat0 = (num(a.lat) + num(nb.lat)) / 2;   // 点对共享参考纬度
        const [ax, ay] = planarOf(a.lon, a.lat, lat0);
        const [bx, by] = planarOf(nb.lon, nb.lat, lat0);
        const dx = ax - bx, dy = ay - by;
        if (dx !== 0 || dy !== 0) angleDeg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
      }
      arrows.push({
        key: a.sid || 'arrow:' + (seq++), lineId: a.lineId, lineName: a.lineName || '',
        lon: a.lon, lat: a.lat, angleDeg, neighborSid: nb ? nb.sid : null,
      });
    }
    return arrows;
  }

  // 换乘组归并 + 渲染/标签视图：
  //   pins —— circle 图层的渲染与点击单元：
  //     无组站：kind 'stop'（白填充、线色描边）；
  //     same-station 组恰 2 线及以下：合并一个「大圈」（成员坐标均值，big=true，黑边）——现状不动；
  //     same-station 组 ≥3 线：改画药丸（见 pills），成员站圈照常各自出现叠在其上（线色描边保留）；
  //     junction 组：合并普通尺寸圈（big=false 不放大——接轨站不出大圈；描边色由渲染层按成员线角色优先级取，不用黑边）；
  //     out-of-station 组：成员各自普通尺寸圈（出闸换乘物理上是两个站，不并点，黑边）；
  //     除药丸组外，组成员的个人小圈一律不再单独出现。
  //   pills —— ≥3 线 same-station 组的胶囊折线：成员 geo 按 planGroupPillChain 链序串联
  //（渲染层双层 line＋圆头端帽即得白底黑边胶囊；恰 2 线组不出药丸）。
  //   arrows —— 出省箭头渲染单元（buildArrowViews 产物，非站）。
  //   labels —— HTML 标签与搜索条目单元：无组站各一；组（三种类型）各一（均值位置，同名取首个非空）。
  function buildStopView(stops) {
    const byGroup = new Map();   // groupId → {groupId,type,members}
    const singles = [];
    const arrows = buildArrowViews(stops);
    for (const s of stops) {
      if (s.kind === 'arrow') continue;   // 箭头不是站：不进组、不进 pin/label
      if (!s.groupId) { singles.push(s); continue; }
      let grp = byGroup.get(s.groupId);
      if (!grp) { grp = { groupId: s.groupId, type: s.groupType || 'same-station', members: [] }; byGroup.set(s.groupId, grp); }
      grp.members.push(s);
    }
    const pins = [], pills = [], labels = [];
    const pinOfStop = (s, groupType) => ({
      kind: 'stop', key: s.sid, name: s.name, lineId: s.lineId,
      lineNames: s.lineName ? [s.lineName] : [], groupType: groupType || null,
      groupId: s.groupId || null,   // 出闸组/药丸组成员各自成圈，但保留组号供「组内车站」查询
      big: false, lon: s.lon, lat: s.lat,
    });
    for (const s of singles) {
      pins.push(pinOfStop(s, null));
      labels.push({ key: s.sid, name: s.name, lon: s.lon, lat: s.lat, group: false, groupType: null, lineNames: s.lineName ? [s.lineName] : [] });
    }
    for (const grp of byGroup.values()) {
      const n = grp.members.length || 1;
      const lon = grp.members.reduce((a, s) => a + num(s.lon), 0) / n;
      const lat = grp.members.reduce((a, s) => a + num(s.lat), 0) / n;
      const name = (grp.members.find((s) => s.name) || {}).name || '';
      const lineNames = [...new Set(grp.members.map((s) => s.lineName).filter(Boolean))];
      const lineIds = [...new Set(grp.members.map((s) => s.lineId).filter(Boolean))];
      if (grp.type === 'out-of-station') {
        for (const s of grp.members) pins.push(pinOfStop(s, 'out-of-station'));
      } else if (grp.type === 'same-station' && lineIds.length >= 3) {
        // ≥3 线：药丸替代合并大圈；成员站圈照常叠在药丸上（白填充、线色描边）
        const lat0 = grp.members.reduce((acc, s) => acc + num(s.lat), 0) / n;   // 组内共享参考纬度
        const order = planGroupPillChain(grp.members.map((s) => planarOf(s.lon, s.lat, lat0)));
        pills.push({
          key: 'p:' + grp.groupId, groupId: grp.groupId, lineIds,
          chain: order.map((i) => [grp.members[i].lon, grp.members[i].lat]),
        });
        for (const s of grp.members) pins.push(pinOfStop(s, grp.type));
      } else {
        pins.push({
          kind: 'group', key: 'g:' + grp.groupId, groupId: grp.groupId, name, lineNames,
          lineIds,
          groupType: grp.type, big: grp.type === 'same-station', lon, lat,
        });
      }
      labels.push({ key: 'g:' + grp.groupId, name, lon, lat, group: true, groupType: grp.type, lineNames });
    }
    return { pins, pills, arrows, labels };
  }

  // 线路摘要（信息面板/搜索用）：站按 t 升序（t 缺失排最后），环线 terminals=null（无起讫）。
  // arrow 非站：不计数、不进起讫与站序。
  function lineSummaries(linesMap, stops) {
    const byLine = new Map();
    for (const s of stops) {
      if (s.kind === 'arrow') continue;
      if (!byLine.has(s.lineId)) byLine.set(s.lineId, []);
      byLine.get(s.lineId).push(s);
    }
    const byT = (a, b) => (a.t == null ? 1 : 0) - (b.t == null ? 1 : 0) || num(a.t) - num(b.t);
    const out = new Map();
    for (const line of linesMap.values()) {
      const sts = (byLine.get(line.lineId) || []).slice().sort(byT);
      const segCounts = { existing: 0, approved: 0, future: 0 };
      for (const seg of line.segments) segCounts[seg.segStatus]++;
      out.set(line.lineId, {
        lineId: line.lineId, name: line.name, aliases: line.aliases, color: line.color,
        role: line.role, layer: line.layer, loop: line.loop, bbox: line.bbox,
        stopCount: sts.length,
        firstStop: sts.length ? sts[0].name : '',
        lastStop: sts.length ? sts[sts.length - 1].name : '',
        terminals: line.loop ? null : [sts.length ? sts[0].name : '', sts.length ? sts[sts.length - 1].name : ''],
        stopsOrdered: sts,
        segCounts,
      });
    }
    return out;
  }

  // 线路分类分组（layer 字段）：组名按中文本地序，未分类恒最后，组内按 lineId 升序。
  function layerGroups(linesMap) {
    const named = new Map(), unclassified = [];
    for (const line of linesMap.values()) {
      if (typeof line.layer === 'string' && line.layer) {
        if (!named.has(line.layer)) named.set(line.layer, []);
        named.get(line.layer).push(line);
      } else unclassified.push(line);
    }
    const byId = (a, b) => (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);
    const groups = [...named.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
      .map(([layer, lines]) => ({ layer, lines: lines.slice().sort(byId) }));
    if (unclassified.length) groups.push({ layer: null, lines: unclassified.slice().sort(byId) });
    return groups;
  }

  // ---------- 搜索匹配 ----------
  // 条目：{type:'line', id, text, aliases, ref} / {type:'stop', id, text, ref}。
  // 命中：主名或别名（大小写不敏感）前缀(rank0) > 包含(rank1)；线路优先于站；再按名称本地序。
  function matchEntries(query, entries, limit) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return [];
    const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 12;
    const hits = [];
    for (const ent of entries || []) {
      if (!ent) continue;
      let rank = Infinity;
      const cands = [];
      if (ent.text != null && ent.text !== '') cands.push(String(ent.text));
      for (const a of ent.aliases || []) if (a != null && a !== '') cands.push(String(a));
      for (const sRaw of cands) {
        const s = sRaw.toLowerCase();
        const r = s.startsWith(q) ? 0 : (s.indexOf(q) >= 0 ? 1 : Infinity);
        if (r < rank) rank = r;
      }
      if (rank === Infinity) continue;
      hits.push({ ent, rank: rank * 2 + (ent.type === 'line' ? 0 : 1) });
    }
    hits.sort((a, b) => a.rank - b.rank || String(a.ent.text).localeCompare(String(b.ent.text)));
    return hits.slice(0, cap).map((h) => h.ent);
  }

  // ---------- 标签分级 ----------
  // z≥12 显示全部（超上限只显示换乘组）；z≥10 只显示换乘组；更低不显示。
  function filterLabels(labels, zoom, cap) {
    const arr = Array.isArray(labels) ? labels : [];
    const c = Number.isFinite(cap) && cap > 0 ? cap : LABEL_CAP;
    if (zoom >= LABEL_ZOOM_STOP) return arr.length <= c ? arr : arr.filter((l) => l && l.group);
    if (zoom >= LABEL_ZOOM_GROUP) return arr.filter((l) => l && l.group);
    return [];
  }

  // ---------- 线层透明度 paint 表达式 ----------
  // 优先级：选中集淡化（未选线 0.08）＞「突出既有」分段半透明（开关关闭＝全部 1.0）。
  // 单层 match 版（备用/文档语义；查看器现行按 segStatus 拆三层渲染，走 buildSegLayerOpacity）。
  function buildLineOpacity(selectedIds, emphasizeExisting) {
    const statusExpr = emphasizeExisting
      ? ['match', ['get', 'segStatus'], 'existing', 1.0, 'approved', 0.75, 'future', 0.45, 0.9]
      : 1.0;
    const sel = Array.isArray(selectedIds) ? [...new Set(selectedIds.filter(Boolean).map(String))] : [];
    if (!sel.length) return statusExpr;
    return ['case', ['in', ['get', 'lineId'], ['literal', sel]], statusExpr, 0.08];
  }

  // 分段图层（按 segStatus 拆层）透明度：单状态常量三档（开关关＝1.0），选中集外 0.08。
  // 拆层原因：line-dasharray 不支持数据驱动，远期虚线只能整层设。
  function statusOpacity(segStatus, emphasizeExisting) {
    if (!emphasizeExisting) return 1.0;
    return Object.prototype.hasOwnProperty.call(SEG_STATUS_OPACITY, segStatus) ? SEG_STATUS_OPACITY[segStatus] : 0.9;
  }
  function buildSegLayerOpacity(selectedIds, segStatus, emphasizeExisting) {
    const base = statusOpacity(segStatus, emphasizeExisting);
    const sel = Array.isArray(selectedIds) ? [...new Set(selectedIds.filter(Boolean).map(String))] : [];
    if (!sel.length) return base;
    return ['case', ['in', ['get', 'lineId'], ['literal', sel]], base, 0.08];
  }

  // ---------- 显示文案（中文仅此层，结构字段不受影响） ----------
  const UNNAMED_STOP_ZH = '（未命名站）';
  function stopDisplayName(name) {
    return typeof name === 'string' && name ? name : UNNAMED_STOP_ZH;
  }
  // 线路起讫文案：环线 → 「环线（无起讫）」；两端全空（零站线）→ '—'；
  // 单端无名 → 未名站占位；正常 → 'A — B'。
  function formatTerminals(sum) {
    if (!sum) return '—';
    if (sum.loop) return '环线（无起讫）';
    const t = Array.isArray(sum.terminals) ? sum.terminals : [];
    const a = typeof t[0] === 'string' ? t[0] : '';
    const b = typeof t[1] === 'string' ? t[1] : '';
    if (!a && !b) return '—';
    return stopDisplayName(a) + ' — ' + stopDisplayName(b);
  }

  // ---------- 单线导出 ----------
  // GeoJSON：线一条 Feature（MultiLineString，段序＝segIndex）＋每站一个 Point（站序＝t 升序）。
  function buildLineGeoJSON(lineId, linesMap, stops) {
    const line = linesMap.get(lineId != null ? String(lineId) : '');
    if (!line) return null;
    const sts = stops.filter((s) => s.kind !== 'arrow' && s.lineId === line.lineId)
      .sort((a, b) => (a.t == null ? 1 : 0) - (b.t == null ? 1 : 0) || num(a.t) - num(b.t));
    const features = [{
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: line.segments.map((sg) => sg.coords) },
      properties: {
        lineId: line.lineId, name: line.name, aliases: line.aliases, color: line.color,
        role: line.role, layer: line.layer, loop: line.loop,
        segStatuses: line.segments.map((sg) => sg.segStatus),
      },
    }];
    for (const s of sts) features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { sid: s.sid, name: s.name, lineId: s.lineId, t: s.t, groupId: s.groupId, groupType: s.groupType },
    });
    return { type: 'FeatureCollection', features };
  }

  // KML：手写模板。线按段分 Placemark，三种分段状态各一个 Style
  //（KML 颜色 alpha 恰可表达「突出既有」的半透明：existing ff / approved bf / future 73）。
  // 所有文本经 xmlEscape；坐标 6 位小数。未知 lineId → null。
  function buildLineKML(lineId, linesMap, stops, opts) {
    const line = linesMap.get(lineId != null ? String(lineId) : '');
    if (!line) return null;
    const o = opts || {};
    const docName = line.name || line.lineId;
    const flat = o.emphasizeExisting === false ? 1 : null;   // 传 false 可导出全不透明版
    const kmlColor = (status) => hexToKmlColor(line.color, flat != null ? flat : SEG_STATUS_OPACITY[status]);
    const sts = stops.filter((s) => s.kind !== 'arrow' && s.lineId === line.lineId)
      .sort((a, b) => (a.t == null ? 1 : 0) - (b.t == null ? 1 : 0) || num(a.t) - num(b.t));
    const L = [];
    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
    L.push('<name>' + xmlEscape(docName) + '</name>');
    for (const st of ['existing', 'approved', 'future']) {
      L.push('<Style id="seg-' + st + '"><LineStyle><color>' + kmlColor(st) + '</color><width>'
        + (Number.isFinite(o.lineWidth) ? o.lineWidth : 3) + '</width></LineStyle></Style>');
    }
    for (const seg of line.segments) {
      L.push('<Placemark><name>' + xmlEscape(docName + '（' + (SEG_STATUS_ZH[seg.segStatus] || seg.segStatus) + '段）') + '</name>');
      L.push('<styleUrl>#seg-' + seg.segStatus + '</styleUrl>');
      L.push('<LineString><tessellate>1</tessellate><coordinates>');
      L.push(seg.coords.map((c) => num(c && c[0]).toFixed(6) + ',' + num(c && c[1]).toFixed(6) + ',0').join(' '));
      L.push('</coordinates></LineString></Placemark>');
    }
    for (const s of sts) {
      L.push('<Placemark><name>' + xmlEscape(s.name || s.sid) + '</name>');
      const rel = [];
      if (s.lineName) rel.push('所属：' + s.lineName);
      if (s.groupType) rel.push(GROUP_TYPE_ZH[s.groupType]);
      if (rel.length) L.push('<description>' + xmlEscape(rel.join('；')) + '</description>');
      L.push('<Point><coordinates>' + num(s.lon).toFixed(6) + ',' + num(s.lat).toFixed(6) + ',0</coordinates></Point></Placemark>');
    }
    L.push('</Document></kml>');
    return L.join('\n');
  }

  // ---------- 导出 ----------
  const Core = {
    SEG_STATUS_OPACITY, DEFAULT_LINE_COLOR, GROUP_TYPE_ZH, ROLE_ZH, SEG_STATUS_ZH,
    LABEL_CAP, LABEL_ZOOM_GROUP, LABEL_ZOOM_STOP,
    UNNAMED_STOP_ZH, stopDisplayName, formatTerminals,
    xmlEscape, normalizeHex, hexToKmlColor,
    normalizeLines, lineBboxOf, stopList, buildStopView, buildArrowViews,
    planGroupPillChain, planarOf, lineSummaries, layerGroups,
    matchEntries, filterLabels, buildLineOpacity, statusOpacity, buildSegLayerOpacity,
    buildLineGeoJSON, buildLineKML,
  };
  G.VIEWER_CORE = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
