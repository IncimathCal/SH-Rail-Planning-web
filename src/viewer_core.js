// viewer_core.js —— 阶段 3 查看器·纯逻辑层（2026-11-21）
// 不依赖 DOM / maplibre / editor.js：数据归一（线路聚合、站点平表、换乘组归并）、
// 搜索匹配、标签分级、单线导出（GeoJSON 对象 / KML 字符串）、线层透明度表达式构造
//（单层 match 版＋按 segStatus 拆层版）、显示文案（起讫格式化、未名站占位）。
// 浏览器端挂 globalThis.VIEWER_CORE；node 端（tools/test_viewer_logic.js）走 module.exports。
// 数据契约：net/lines.geojson（每 feature＝线×分段）、net/stops.geojson（每 feature＝线×站）。

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

  // stops.geojson → 站点平表（非 Point / 坐标缺失跳过；groupId 空串归 null；groupType 未知归 null）
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
        lon, lat,
      });
    }
    return out;
  }

  // 换乘组归并 + 渲染/标签视图：
  //   pins  —— circle 图层的渲染与点击单元：
  //     无组站：kind 'stop'（白填充、线色描边）；
  //     same-station 组：合并一个「大圈」（成员坐标均值，big=true，黑边）；
  //     junction 组：合并普通尺寸圈（big=false 不放大——接轨站不出大圈；描边色由渲染层按成员线角色优先级取，不用黑边）；
  //     out-of-station 组：成员各自普通尺寸圈（出闸换乘物理上是两个站，不并点，黑边）；
  //     组成员的个人小圈一律不再单独出现。
  //   labels —— HTML 标签与搜索条目单元：无组站各一；组（三种类型）各一（均值位置，同名取首个非空）。
  function buildStopView(stops) {
    const byGroup = new Map();   // groupId → {groupId,type,members}
    const singles = [];
    for (const s of stops) {
      if (!s.groupId) { singles.push(s); continue; }
      let grp = byGroup.get(s.groupId);
      if (!grp) { grp = { groupId: s.groupId, type: s.groupType || 'same-station', members: [] }; byGroup.set(s.groupId, grp); }
      grp.members.push(s);
    }
    const pins = [], labels = [];
    const pinOfStop = (s, groupType) => ({
      kind: 'stop', key: s.sid, name: s.name, lineId: s.lineId,
      lineNames: s.lineName ? [s.lineName] : [], groupType: groupType || null,
      groupId: s.groupId || null,   // 出闸组成员各自成圈，但保留组号供「组内车站」查询
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
      if (grp.type === 'out-of-station') {
        for (const s of grp.members) pins.push(pinOfStop(s, 'out-of-station'));
      } else {
        pins.push({
          kind: 'group', key: 'g:' + grp.groupId, groupId: grp.groupId, name, lineNames,
          lineIds: [...new Set(grp.members.map((s) => s.lineId).filter(Boolean))],
          groupType: grp.type, big: grp.type === 'same-station', lon, lat,
        });
      }
      labels.push({ key: 'g:' + grp.groupId, name, lon, lat, group: true, groupType: grp.type, lineNames });
    }
    return { pins, labels };
  }

  // 线路摘要（信息面板/搜索用）：站按 t 升序（t 缺失排最后），环线 terminals=null（无起讫）。
  function lineSummaries(linesMap, stops) {
    const byLine = new Map();
    for (const s of stops) {
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

  // ---------- GCJ02 偏移（高德底图对齐） ----------
  // 国家标准加密偏移的通用近似算法（纯数学公式，不引用任何外部数据）：WGS84 → GCJ02。
  // 只用于渲染侧（线路/站点喂 MapLibre 前的渲染拷贝，与高德瓦片同平面）；
  // GeoJSON / KML 导出一律保持 WGS84 原坐标——变换绝不写回权威数据结构。
  const GCJ_A = 6378245.0;                // 克拉索夫斯基椭球长半轴
  const GCJ_EE = 0.00669342162296594323;  // 第一偏心率平方
  function gcjTransformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }
  function gcjTransformLon(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
  }
  // 中国境外无偏移（粗略界；本项目数据均在境内，此为算法自带的守卫）
  function outOfChina(lon, lat) {
    return !(lon > 72.004 && lon < 137.8347 && lat > 0.8293 && lat < 55.8271);
  }
  function wgs84ToGcj02(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [lon, lat];
    if (outOfChina(lon, lat)) return [lon, lat];
    let dLat = gcjTransformLat(lon - 105.0, lat - 35.0);
    let dLon = gcjTransformLon(lon - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - GCJ_EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
    dLon = (dLon * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lon + dLon, lat + dLat];
  }

  // ---------- 单线导出 ----------
  // GeoJSON：线一条 Feature（MultiLineString，段序＝segIndex）＋每站一个 Point（站序＝t 升序）。
  function buildLineGeoJSON(lineId, linesMap, stops) {
    const line = linesMap.get(lineId != null ? String(lineId) : '');
    if (!line) return null;
    const sts = stops.filter((s) => s.lineId === line.lineId)
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
    const sts = stops.filter((s) => s.lineId === line.lineId)
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
    outOfChina, wgs84ToGcj02,
    xmlEscape, normalizeHex, hexToKmlColor,
    normalizeLines, lineBboxOf, stopList, buildStopView, lineSummaries, layerGroups,
    matchEntries, filterLabels, buildLineOpacity, statusOpacity, buildSegLayerOpacity,
    buildLineGeoJSON, buildLineKML,
  };
  G.VIEWER_CORE = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
