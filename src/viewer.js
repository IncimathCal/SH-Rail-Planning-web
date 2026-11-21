// viewer.js —— 阶段 3 查看器·DOM/MapLibre 胶水层（2026-11-21）
// 职责：fetch net/{lines,stops}.geojson（相对路径 net → build/net 依次回退；加载/空/错三态
// 中文覆盖）→ 纯逻辑归一（VIEWER_CORE）→ 内联 style 渲染（无 glyphs、无文本 symbol——
// 纯深色画布）→ 搜索 / 多选高亮 / 线·站信息面板 / 状态图例＋「突出既有」开关 / 站点 hover
// 提示 / 单线导出 / 中文 HTML 标签叠加。
// 渲染坐标系＝WGS84（无底图设计，零外部资源）；S.linesMap/S.stops 即权威结构，
// GeoJSON/KML 导出与其同坐标。
// 线层按 segStatus 拆三层（远期虚线只能整层设——line-dasharray 不支持数据驱动）。
// 2026-11-21 增：①出省箭头（kind:'arrow'）——线色三角 glyph 指向线路外侧（方向在
// VIEWER_CORE 按 t 序邻站推导；icon-rotate 数据驱动旋转；图标 canvas 本地绘制＋
// styleimagemissing 按需注册，零外部资源零网络请求；不进搜索/hover/点选面板）；
// ②≥3 线同站组药丸——沿贪心最近邻链序画双层折线（外黑内白＋圆头端帽＝白底黑边胶囊，
// 厚度＝双线换乘大圈直径视觉等宽），成员站圈照常叠于其上；恰 2 线组维持合并大圈不动。
// 与编辑器完全独立：不加载 editor.js 的任何代码。中文标签走 HTML 叠加（架构方案 §6 备案路线）。

(function (G) {
  'use strict';
  const V = G.VIEWER_CORE;
  const $ = (id) => document.getElementById(id);

  // ---------- 状态 ----------
  const S = {
    map: null,
    linesMap: new Map(),          // lineId → line（归一后，WGS84 权威——导出用）
    stops: [],                    // 站点平表（WGS84 权威——导出用）
    view: { pins: [], labels: [] }, // 渲染/标签视图（组已归并；坐标 WGS84）
    dispBbox: new Map(),          // lineId → 渲染 bbox（fitBounds 用，与渲染特征同帧）
    dispStopsBbox: null,          // 站点渲染 bbox（无线时的兜底视野）
    dispLabels: [],               // 标签列表（map.project 定位用，WGS84）
    summaries: new Map(),         // lineId → 摘要
    pinByKey: new Map(),
    selected: new Set(),          // 高亮线路（空＝不高亮、全部正常显示）
    emphasize: true,              // 「突出既有」开关（默认开）
    labelPool: new Map(),         // 标签元素复用池 key → div
    labelFrame: 0,                // rAF 合帧令牌
    searchIdx: [],                // 搜索条目
    dropIndex: 0,                 // 搜索下拉键盘焦点序
  };

  // ---------- 通用 ----------
  function fetchJSON(url) {
    return fetch(url).then((res) => {
      if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
      return res.json();
    });
  }
  // 数据目录候选（相对路径，docs/ 项目页部署不破）：'net'＝发布快照位（publish 产物），
  // 'build/net'＝本地 flatten 默认输出位。stops 缺失按零站容错（只看线网也成立）；
  // lines 在所有候选位都取不到才算加载失败。
  const NET_BASES = ['net', 'build/net'];
  async function fetchNetFiles() {
    let lastErr = null;
    for (const base of NET_BASES) {
      let linesFC;
      try {
        linesFC = await fetchJSON(base + '/lines.geojson');
      } catch (e) { lastErr = e; continue; }
      let stopsFC = { type: 'FeatureCollection', features: [] };
      try {
        stopsFC = await fetchJSON(base + '/stops.geojson');
      } catch (e) {
        console.warn('提示：' + base + '/stops.geojson 缺失，按零站处理（' + (e && e.message) + '）');
      }
      return { linesFC, stopsFC, base };
    }
    throw lastErr || new Error('net/lines.geojson 与 build/net/lines.geojson 均不可用');
  }
  function showCenter(msg, detail) {
    $('centerMsgText').textContent = msg;
    $('centerMsgDetail').textContent = detail || '';
    $('centerMsg').hidden = false;
  }
  function hideCenter() { $('centerMsg').hidden = true; }
  function mergeBbox(a, b) {
    if (!b) return a;
    if (!a) return [b[0], b[1], b[2], b[3]];
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  }
  function totalBbox() {
    let bb = null;
    for (const b of S.dispBbox.values()) bb = mergeBbox(bb, b);
    if (!bb) bb = S.dispStopsBbox;
    return bb;
  }
  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------- 渲染数据（由归一结果重建，保证 paint 属性干净齐全；WGS84 直通） ----------
  function renderLinesFC() {
    S.dispBbox = new Map();
    const features = [];
    for (const line of S.linesMap.values()) {
      let bb = null;
      for (const seg of line.segments) {
        const coords = [];
        for (const pt of seg.coords) {
          if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
          coords.push([pt[0], pt[1]]);
          bb = mergeBbox(bb, [pt[0], pt[1], pt[0], pt[1]]);
        }
        if (coords.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { lineId: line.lineId, name: line.name, color: line.color, segStatus: seg.segStatus, segIndex: seg.segIndex },
        });
      }
      S.dispBbox.set(line.lineId, bb);
    }
    return { type: 'FeatureCollection', features };
  }
  // 接轨站（junction）描边：取成员线角色优先级色 main > standalone > branch > connector
  // （与编辑器 junctionStroke 语义一致——黑边是换乘语义，junction 不用黑边）
  const ROLE_PRI = { main: 4, standalone: 3, branch: 2, connector: 1 };
  function junctionStroke(lineIds) {
    let best = null, pri = -1;
    for (const lid of lineIds || []) {
      const l = S.linesMap.get(lid);
      if (!l || !l.color) continue;
      const p = ROLE_PRI[l.role] || 0;
      if (p > pri) { pri = p; best = l.color; }
    }
    return best || '#000000';
  }
  function renderStopsFC() {
    // pin → circle：白填充；描边＝无组站取线色、同站组/出闸成员黑边（换乘语义）、
    // junction 组取成员线角色优先级色；big（同站大圈）与 dark（黑边加粗）为渲染开关位。
    // 坐标 WGS84 直通（同 renderLinesFC）。
    S.dispStopsBbox = null;
    const features = [];
    for (const pin of S.view.pins) {
      let stroke, dark = 0;
      if (pin.kind === 'group' && pin.groupType === 'junction') { stroke = junctionStroke(pin.lineIds); }
      else if (pin.kind === 'group' || pin.groupType === 'out-of-station') { stroke = '#000000'; dark = 1; }
      else {
        const line = S.linesMap.get(pin.lineId);
        stroke = line ? line.color : '#999999';
      }
      S.dispStopsBbox = mergeBbox(S.dispStopsBbox, [pin.lon, pin.lat, pin.lon, pin.lat]);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pin.lon, pin.lat] },
        properties: { key: pin.key, name: pin.name, lineId: pin.lineId || '', big: pin.big ? 1 : 0, dark, stroke },
      });
    }
    return { type: 'FeatureCollection', features };
  }
  // ≥3 线同站组药丸折线（view.pills 的 chain 已是贪心最近邻链序；退化共点组画不出胶囊，
  // 成员圈照常渲染）。胶囊本体是装饰层：不挂任何交互。
  function renderPillsFC() {
    const features = [];
    for (const pill of S.view.pills || []) {
      const coords = (pill.chain || []).filter((c) => c && Number.isFinite(c[0]) && Number.isFinite(c[1]));
      if (coords.length < 2) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { key: pill.key },
      });
    }
    return { type: 'FeatureCollection', features };
  }
  // 出省箭头（view.arrows，非站）：icon 名按线色区分（arrow-xxxxxx 三角 / arrowdot-xxxxxx 退化小圆点），
  // angle＝自北顺时针度数（icon-rotate 语义）。坐标并入站点 bbox 供 fitAll 兜底。
  function renderArrowsFC() {
    const features = [];
    for (const a of S.view.arrows || []) {
      const line = S.linesMap.get(a.lineId);
      const color = line && line.color ? line.color : '#999999';
      const icon = (a.angleDeg == null ? 'arrowdot-' : 'arrow-') + color.slice(1);
      S.dispStopsBbox = mergeBbox(S.dispStopsBbox, [a.lon, a.lat, a.lon, a.lat]);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
        properties: { key: a.key, icon, angle: Math.round((a.angleDeg || 0) * 10) / 10 },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  // ---------- 地图 ----------
  // 分段线层：按 segStatus 拆三份（绘制序 future → approved → existing，既有压顶）。
  // line-dasharray 不支持数据驱动，远期虚线只能整层设；透明度走 buildSegLayerOpacity。
  const LINE_LAYER_IDS = ['lines-future', 'lines-approved', 'lines-existing'];
  function lineLayerDef(id) {
    const status = id.replace(/^lines-/, '');
    const paint = {
      'line-color': ['get', 'color'],
      'line-opacity': V.buildSegLayerOpacity([], status, S.emphasize),
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 13, 4, 16, 8],
    };
    if (status === 'future') paint['line-dasharray'] = [2, 2];
    return { id, type: 'line', source: 'lines', filter: ['==', ['get', 'segStatus'], status], paint };
  }
  // 药丸厚度与双线换乘大圈直径视觉等宽：大圈半径 z8/13/16＝3.2/7/11、黑边 1.4/2.4/3.0，
  // 外层黑宽＝2×半径＋黑边，内层白宽＝2×半径；line-cap round 端帽即得胶囊形。
  const PILL_LAYER_DEFS = [
    {
      id: 'pills-outer', type: 'line', source: 'pills',
      paint: {
        'line-color': '#000000',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 7.8, 13, 16.4, 16, 25],
        'line-cap': 'round',
      },
    },
    {
      id: 'pills-inner', type: 'line', source: 'pills',
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6.4, 13, 14, 16, 22],
        'line-cap': 'round',
      },
    },
  ];
  // 箭头 glyph：canvas 本地绘制（无 sprite 文件、零网络请求），icon-rotate 数据驱动旋转；
  // 不挂 click/mouseenter → 不触发 hover 提示与信息面板（搜索侧已无条目）。
  const ARROWS_LAYER_DEF = {
    id: 'arrows', type: 'symbol', source: 'arrows',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-rotate': ['get', 'angle'],
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 13, 0.8, 16, 1.0],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  };
  // 箭头 glyph 本地绘制（24×24 逻辑尺寸，2 倍像素密度抗锯齿；canvas → ImageData）：
  // 'arrow'＝指北实心三角（风筝形箭头，旋转交给 icon-rotate），'dot'＝无邻站可定向的退化小圆点。
  function drawArrowImageData(shape, color) {
    const PX = 2, W = 24 * PX;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = W;
    const ctx = cv.getContext('2d');
    ctx.scale(PX, PX);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (shape === 'arrow') {
      ctx.moveTo(12, 2.5);    // 顶点（北）
      ctx.lineTo(20, 20.5);   // 右翼
      ctx.lineTo(12, 16.5);   // 尾部内凹
      ctx.lineTo(4, 20.5);    // 左翼
    } else {
      ctx.arc(12, 12, 3.2, 0, Math.PI * 2);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return ctx.getImageData(0, 0, W, W);
  }
  function buildMap() {
    const map = new G.maplibregl.Map({
      container: 'map',
      // 内联 style：无 glyphs、无 sources 底图、无文本 symbol（中文标签走 HTML 叠加层；
      // arrows 为纯图标 symbol，不涉及字形）。
      style: {
        version: 8,
        sources: {
          lines: { type: 'geojson', data: renderLinesFC() },
          stops: { type: 'geojson', data: renderStopsFC() },
          pills: { type: 'geojson', data: renderPillsFC() },
          arrows: { type: 'geojson', data: renderArrowsFC() },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#101216' } },
          ...LINE_LAYER_IDS.map(lineLayerDef),
          ...PILL_LAYER_DEFS,          // 药丸垫在站圈之下
          {
            id: 'stops', type: 'circle', source: 'stops',
            paint: {
              'circle-color': '#ffffff',
              'circle-radius': ['interpolate', ['linear'], ['zoom'],
                8, ['case', ['get', 'big'], 3.2, 2.0],
                13, ['case', ['get', 'big'], 7.0, 4.5],
                16, ['case', ['get', 'big'], 11.0, 7.5]],
              'circle-stroke-color': ['get', 'stroke'],
              'circle-stroke-width': ['interpolate', ['linear'], ['zoom'],
                8, ['case', ['get', 'dark'], 1.4, 1.0],
                16, ['case', ['get', 'dark'], 3.0, 2.0]],
            },
          },
          ARROWS_LAYER_DEF,            // 箭头压顶（线端标志，盖过站圈不被遮挡）
        ],
      },
      center: [121.48, 31.22], zoom: 9.5,
      attributionControl: false,
    });
    S.map = map;
    map.addControl(new G.maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    // 图标按需注册：渲染时缺哪张补哪张（icon 名＝arrow-<hex>/arrowdot-<hex>，颜色集有限）
    map.on('styleimagemissing', (e) => {
      const m = /^arrow(dot)?-([0-9a-f]{6})$/.exec(e && e.id ? e.id : '');
      if (!m) return;
      map.addImage(e.id, drawArrowImageData(m[1] ? 'dot' : 'arrow', '#' + m[2]), { pixelRatio: 2 });
    });

    map.on('move', scheduleLabels);
    map.on('resize', scheduleLabels);
    for (const id of LINE_LAYER_IDS) {
      map.on('click', id, (e) => {
        const p = e.features && e.features[0] && e.features[0].properties;
        if (p && p.lineId != null && p.lineId !== '') openLinePanel(String(p.lineId));
      });
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
    map.on('click', 'stops', (e) => {
      const p = e.features && e.features[0] && e.features[0].properties;
      if (p && p.key) openStopPanel(String(p.key));
    });
    map.on('mouseenter', 'stops', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'stops', () => { map.getCanvas().style.cursor = ''; hideStopTip(); });
    map.on('mousemove', 'stops', showStopTip);
    map.on('load', () => { fitAll(); scheduleLabels(); });
  }
  function fitAll() {
    const bb = totalBbox();
    if (bb) S.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, duration: 0, maxZoom: 12 });
  }

  // ---------- 高亮 / 突出既有 ----------
  function applyLinePaint() {
    if (!S.map) return;
    for (const id of LINE_LAYER_IDS) {
      if (!S.map.getLayer(id)) continue;
      S.map.setPaintProperty(id, 'line-opacity',
        V.buildSegLayerOpacity([...S.selected], id.replace(/^lines-/, ''), S.emphasize));
    }
  }
  function setSelected(ids) {
    S.selected = new Set(ids);
    syncChecks();
    applyLinePaint();
  }
  function syncChecks() {
    document.querySelectorAll('#lineList input[type="checkbox"]').forEach((cb) => {
      cb.checked = S.selected.has(cb.dataset.line);
    });
  }

  // ---------- 线路列表面板（按 layer 分组、多选高亮） ----------
  function buildLineList() {
    const host = $('lineList');
    host.textContent = '';
    const groups = V.layerGroups(S.linesMap);
    if (!groups.length) {
      const tip = document.createElement('div');
      tip.className = 'panel-tip';
      tip.textContent = '（net/lines.geojson 中没有可列出的线路）';
      host.appendChild(tip);
      return;
    }
    for (const grp of groups) {
      const gEl = document.createElement('div');
      gEl.className = 'line-group';
      const head = document.createElement('div');
      head.className = 'line-group-head';
      head.textContent = grp.layer == null ? '未分类' : grp.layer;
      head.title = '收起/展开本组';
      head.addEventListener('click', () => gEl.classList.toggle('collapsed'));
      gEl.appendChild(head);
      for (const line of grp.lines) {
        const lab = document.createElement('label');
        lab.className = 'line-item';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.dataset.line = line.lineId;
        const sw = document.createElement('span');
        sw.className = 'line-swatch'; sw.style.background = line.color;
        const nm = document.createElement('span');
        nm.className = 'line-name'; nm.textContent = line.name || line.lineId;
        lab.append(cb, sw, nm);
        lab.title = '单击勾选高亮，双击查看线路信息';
        lab.addEventListener('dblclick', () => openLinePanel(line.lineId));
        gEl.appendChild(lab);
      }
      host.appendChild(gEl);
    }
    host.addEventListener('change', () => {   // 勾选变化 → 收集选中集
      const sel = new Set();
      host.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => sel.add(cb.dataset.line));
      S.selected = sel;
      applyLinePaint();
    });
  }

  // ---------- 信息面板 ----------
  function openPanel(title) {
    $('infoTitle').textContent = title;
    const body = $('infoBody');
    body.textContent = '';
    $('infoPanel').hidden = false;
    return body;
  }
  function infoRow(body, k, v) {
    const r = document.createElement('div');
    r.className = 'info-row';
    const key = document.createElement('span');
    key.className = 'info-key'; key.textContent = k;
    const val = document.createElement('span');
    val.className = 'info-val'; val.textContent = v;
    r.append(key, val);
    body.appendChild(r);
  }
  // 线路显示名（信息面板/hover 用）：名（又称 …）；线不在 linesMap（孤站）退 lineName/ID 原文
  function lineLabelOf(lineId, fallback) {
    const l = lineId != null ? S.linesMap.get(lineId) : null;
    if (!l) return fallback || (lineId != null ? String(lineId) : '');
    let s = l.name || l.lineId;
    if (l.aliases.length) s += '（又称 ' + l.aliases.join('、') + '）';
    return s;
  }
  // pin 的所属线路显示列表：组 pin 用成员线 lineIds；单站 pin 用本线（孤站退 lineName）
  function linesOfPin(pin) {
    if (pin.kind === 'group') {
      const out = (pin.lineIds || []).map((lid) => lineLabelOf(lid, '')).filter(Boolean);
      return out.length ? out : (pin.lineNames || []);
    }
    const s = lineLabelOf(pin.lineId, (pin.lineNames && pin.lineNames[0]) || '');
    return s ? [s] : [];
  }
  function openLinePanel(lineId) {
    const sum = S.summaries.get(lineId);
    if (!sum) return;
    const body = openPanel(sum.name || lineId);
    if (sum.aliases.length) infoRow(body, '别名', sum.aliases.join('、'));
    infoRow(body, 'ID', sum.lineId);
    infoRow(body, '类别', sum.layer || '未分类');
    infoRow(body, '角色', V.ROLE_ZH[sum.role] || sum.role || '—');
    infoRow(body, '起讫站', V.formatTerminals(sum));
    infoRow(body, '车站数', String(sum.stopCount));
    infoRow(body, '分段状态', '既有 ' + sum.segCounts.existing + ' 段 · 已批复 ' + sum.segCounts.approved + ' 段 · 远期 ' + sum.segCounts.future + ' 段');

    const bar = document.createElement('div');
    bar.className = 'info-actions';
    const bG = document.createElement('button');
    bG.textContent = '导出 GeoJSON';
    bG.addEventListener('click', () => exportLine(lineId, 'geojson'));
    const bK = document.createElement('button');
    bK.textContent = '导出 KML';
    bK.addEventListener('click', () => exportLine(lineId, 'kml'));
    bar.append(bG, bK);
    body.appendChild(bar);
  }
  function openStopPanel(key) {
    const pin = S.pinByKey.get(key);
    if (!pin) return;
    const body = openPanel(V.stopDisplayName(pin.name));
    const ls = linesOfPin(pin);
    infoRow(body, '所属线路', ls.length ? ls.join('、') : '—');
    infoRow(body, '换乘关系', pin.groupType ? (V.GROUP_TYPE_ZH[pin.groupType] || pin.groupType) : '无');
    // 出闸换乘物理上是两个站、药丸组（≥3 线）成员各自成圈：列出同组其余车站让换乘关系可读
    //（药丸组原先由合并大圈承载的「几线交汇」信息由成员圈的组内车站行补回）
    if (pin.kind === 'stop' && pin.groupId
      && (pin.groupType === 'out-of-station' || pin.groupType === 'same-station')) {
      const others = S.stops.filter((s) => s.kind !== 'arrow' && s.groupId === pin.groupId && s.sid !== pin.key)
        .map((s) => V.stopDisplayName(s.name) + (s.lineName ? '（' + s.lineName + '）' : ''));
      if (others.length) infoRow(body, '组内车站', others.join('、'));
    }
    infoRow(body, pin.kind === 'group' ? '组 ID' : '站 ID', pin.kind === 'group' ? pin.groupId : pin.key);
  }
  function exportLine(lineId, kind) {
    const line = S.linesMap.get(lineId);
    const base = line && line.name ? line.name : lineId;
    if (kind === 'geojson') {
      const obj = V.buildLineGeoJSON(lineId, S.linesMap, S.stops);
      if (!obj) return;
      downloadText(base + '.geojson', JSON.stringify(obj, null, 2), 'application/geo+json');
    } else {
      const kml = V.buildLineKML(lineId, S.linesMap, S.stops, { emphasizeExisting: S.emphasize });
      if (!kml) return;
      downloadText(base + '.kml', kml, 'application/vnd.google-earth.kml+xml');
    }
  }

  // ---------- 搜索 ----------
  function buildSearchIndex() {
    const ents = [];
    for (const sum of S.summaries.values()) {
      ents.push({ type: 'line', id: sum.lineId, text: sum.name || sum.lineId, aliases: sum.aliases, ref: sum });
    }
    for (const lb of S.dispLabels) {
      ents.push({ type: 'stop', id: lb.key, text: lb.name, aliases: [], ref: lb });
    }
    S.searchIdx = ents;
  }
  function currentHits() { return V.matchEntries($('searchInput').value, S.searchIdx, 12); }
  function renderDrop(hits) {
    const drop = $('searchDrop');
    drop.textContent = '';
    if (!hits.length) { drop.hidden = true; return; }
    hits.forEach((ent, i) => {
      const li = document.createElement('li');
      if (i === S.dropIndex) li.classList.add('active');
      const main = document.createElement('span');
      main.className = 'drop-main';
      main.textContent = ent.text || '(未命名)';
      const sub = document.createElement('span');
      sub.className = 'drop-sub';
      sub.textContent = ent.type === 'line'
        ? '线路' + (ent.aliases && ent.aliases.length ? ' · ' + ent.aliases.join('、') : '')
        : '车站' + (ent.ref && ent.ref.lineNames && ent.ref.lineNames.length ? ' · ' + ent.ref.lineNames.join('、') : '');
      li.append(main, sub);
      li.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickEntry(ent); });
      drop.appendChild(li);
    });
    drop.hidden = false;
  }
  function closeDrop() {
    $('searchDrop').hidden = true;
    S.dropIndex = 0;
  }
  function pickEntry(ent) {
    closeDrop();
    const input = $('searchInput');
    input.value = '';
    input.blur();
    if (ent.type === 'line') {
      setSelected([ent.id]);
      const bb = S.dispBbox.get(ent.id) || (ent.ref && ent.ref.bbox);
      if (bb) {
        S.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 80, duration: 600, maxZoom: 13 });
      }
      openLinePanel(ent.id);
    } else {
      const lb = ent.ref;
      if (!lb) return;
      S.map.flyTo({ center: [lb.lon, lb.lat], zoom: Math.max(S.map.getZoom(), 13.5), duration: 800 });
      openStopPanel(lb.key);
    }
  }
  function wireSearch() {
    const input = $('searchInput');
    input.addEventListener('input', () => { S.dropIndex = 0; renderDrop(currentHits()); });
    input.addEventListener('focus', () => { if (input.value.trim()) renderDrop(currentHits()); });
    input.addEventListener('blur', () => setTimeout(closeDrop, 150));
    input.addEventListener('keydown', (ev) => {
      const hits = $('searchDrop').hidden ? [] : currentHits();
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
        if (!hits.length) return;
        ev.preventDefault();
        S.dropIndex = (S.dropIndex + (ev.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
        renderDrop(hits);
      } else if (ev.key === 'Enter') {
        if (hits.length) pickEntry(hits[S.dropIndex] || hits[0]);
      } else if (ev.key === 'Escape') {
        closeDrop();
        input.blur();
      }
    });
  }

  // ---------- HTML 中文标签叠加层（map.project + rAF 合帧） ----------
  function scheduleLabels() {
    if (S.labelFrame) return;
    S.labelFrame = G.requestAnimationFrame(() => { S.labelFrame = 0; updateLabels(); });
  }
  function updateLabels() {
    const wrap = $('labelLayer');
    const map = S.map;
    if (!wrap || !map) return;
    const items = V.filterLabels(S.dispLabels, map.getZoom(), V.LABEL_CAP);
    const w = wrap.clientWidth, h = wrap.clientHeight, M = 60;   // 视口外裁剪边距
    const seen = new Set();
    for (const it of items) {
      let xy;
      try { xy = map.project([it.lon, it.lat]); } catch (e) { continue; }
      if (!xy) continue;
      if (xy.x < -M || xy.y < -M || xy.x > w + M || xy.y > h + M) continue;
      seen.add(it.key);
      let el = S.labelPool.get(it.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'map-label' + (it.group ? ' is-group' : '');
        el.textContent = it.name || '';
        wrap.appendChild(el);
        S.labelPool.set(it.key, el);
      }
      if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
      el.style.transform = 'translate3d(' + xy.x.toFixed(1) + 'px,' + xy.y.toFixed(1) + 'px,0) translate(-50%,-140%)';
    }
    for (const [k, el] of S.labelPool) {
      if (!seen.has(k)) el.style.visibility = 'hidden';
    }
    if (S.labelPool.size > 3000) {   // 池膨胀时清掉隐藏元素
      for (const [k, el] of S.labelPool) {
        if (!seen.has(k)) { el.remove(); S.labelPool.delete(k); }
      }
    }
  }

  // ---------- 站点 hover 提示（复用单一浮层，随 mousemove 更新） ----------
  function showStopTip(e) {
    const p = e.features && e.features[0] && e.features[0].properties;
    const pin = p && p.key ? S.pinByKey.get(String(p.key)) : null;
    const tip = $('stopTip');
    if (!pin) { tip.hidden = true; return; }
    $('stopTipName').textContent = V.stopDisplayName(pin.name);
    const ls = linesOfPin(pin);
    const rel = pin.groupType ? (V.GROUP_TYPE_ZH[pin.groupType] || pin.groupType) : '';
    $('stopTipSub').textContent = (ls.length ? ls.join('、') : '（无所属线路）') + (rel ? ' · ' + rel : '');
    tip.hidden = false;
    const x = Math.min(e.point.x + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = Math.max(x, 8) + 'px';
    tip.style.top = Math.max(e.point.y - 10, 6) + 'px';
  }
  function hideStopTip() { $('stopTip').hidden = true; }

  // ---------- 状态图例（三档线样与「突出既有」开关同处；透明度随开关联动） ----------
  const LEGEND_SWATCHES = [['swExisting', 'existing'], ['swApproved', 'approved'], ['swFuture', 'future']];
  function updateLegend() {
    for (const [id, st] of LEGEND_SWATCHES) {
      const el = $(id);
      if (el) el.style.opacity = V.statusOpacity(st, S.emphasize);
    }
  }

  // ---------- 顶栏 / 面板交互 ----------
  function wireUI() {
    $('emphasisToggle').addEventListener('change', (ev) => {
      S.emphasize = ev.target.checked;
      applyLinePaint();
      updateLegend();
    });
    $('infoClose').addEventListener('click', () => { $('infoPanel').hidden = true; });
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
      $('infoPanel').hidden = true;   // 输入框内的 Esc 归搜索框自己处理
    });
    wireSearch();
  }

  // ---------- 启动 ----------
  async function boot() {
    showCenter('正在加载数据…', '');
    if (typeof G.maplibregl === 'undefined') {
      showCenter('地图引擎未加载', 'assets/vendor/maplibre-gl.js 缺失或页面未通过 HTTP 服务打开（file:// 直开无法加载脚本）。');
      return;
    }
    if (G.location && G.location.protocol === 'file:') {
      showCenter('请通过 HTTP 服务打开本页',
        'file:// 直开时浏览器禁止读取本地数据文件。本地预览：python -X utf8 tools/serve.py 后访问 http://localhost:8000/index.html。');
      return;
    }
    let net;
    try {
      net = await fetchNetFiles();
    } catch (err) {
      showCenter('数据加载失败', (err && err.message ? err.message : String(err))
        + '。本地预览请先生成数据：python -X utf8 tools/flatten.py --data data --out build/net，'
        + '再经 HTTP 服务打开（python -X utf8 tools/serve.py → http://localhost:8000/index.html）；'
        + '正式发布由 python -X utf8 tools/publish.py 生成 docs/ 快照。');
      return;
    }
    S.linesMap = V.normalizeLines(net.linesFC);
    S.stops = V.stopList(net.stopsFC);
    if (!S.linesMap.size && !S.stops.length) {
      showCenter('暂无数据', '已读取 ' + net.base + '/，但其中没有可显示的线路或车站。'
        + '请确认编辑器已录入数据，并重新运行 flatten（或 publish）。');
      return;
    }
    S.summaries = V.lineSummaries(S.linesMap, S.stops);
    S.view = V.buildStopView(S.stops);
    S.dispLabels = S.view.labels;   // WGS84 直通（仅进 map.project 定位）
    S.pinByKey = new Map(S.view.pins.map((p) => [p.key, p]));
    buildSearchIndex();

    buildMap();
    buildLineList();
    wireUI();
    updateLegend();
    hideCenter();
    scheduleLabels();
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
