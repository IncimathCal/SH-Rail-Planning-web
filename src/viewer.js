// viewer.js —— 阶段 3 查看器·DOM/MapLibre 胶水层（2026-11-21）
// 职责：fetch net/{lines,stops}.geojson（相对路径 net → build/net 依次回退；加载/空/错三态
// 中文覆盖）→ 纯逻辑归一（VIEWER_CORE）→ 内联 style 渲染（无 glyphs、无文本 symbol——
// 纯深色画布）→ 搜索 / 聚焦（列表双击）·线路·车站信息面板 / 站点 hover 提示 / 单线导出 /
// 中文 HTML 标签叠加。
// 渲染坐标系＝WGS84（无底图设计，零外部资源）；S.linesMap/S.stops 即权威结构，
// GeoJSON/KML 导出与其同坐标。2026-11-22 增：测试阶段底图三态（无→OSM→高德循环，
// 用户阶段性豁免——早前「查看器不放底图」裁定在测试期让位，正式上线可能保留也可能移除）；
// 高德为 GCJ02，对齐走显示侧坐标变换（S.dispCoord，权威数据/导出一律 WGS84 不动）。
// 2026-11-22 改版（用户八条指示）：①渲染不再区分期次——单一线层纯色实线统一不透明
//（三档透明/远期虚线/按 segStatus 拆层全删）；②分期四档循环按钮（无→既有→已批复→远期），
// 非选中期的线半透明并隐站名；③左栏列表双击聚焦（其他线半透明隐站名、聚焦线站名常显、
// 屏幕下方居中信息框）；④左栏按类别过滤（HIDDEN_LIST_LAYERS）＋他省线「仅显示」级
//（不聚焦/不点选/一切调光场合恒半透明）；⑤普通站名门槛 12→11；⑥全局站名开关；
// ⑦z<11 尺寸线性缩小（zoomInterp 冻结表达式）；⑧图例卡三档线样与「突出既有」开关退役。
// 调光实现：S.dimmed＝computeDimmedSet 的线集，渲染特征带 dim 位，各层 paint 用
// ['case',['==',['get','dim'],1], DIM_OPACITY, 1]；调光线站圈/药丸/大圈/箭头同步半透明
//（组符号＝全成员被调光才半透明，任一成员未调光则正常）。
// 2026-11-21 增：①出省箭头（kind:'arrow'）——线色三角 glyph 指向线路外侧（方向在
// VIEWER_CORE 按 t 序邻站推导；icon-rotate 数据驱动旋转；图标 canvas 本地绘制＋
// styleimagemissing 按需注册，零外部资源零网络请求；不进搜索/hover/点选面板）；
// ②≥3 线同站组药丸——沿贪心最近邻链序画双层折线（外黑内白＋圆头端帽＝白底黑边胶囊，
// 厚度＝双线换乘大圈直径视觉等宽）；恰 2 线组维持合并大圈不动。
// 2026-11-22 三批（用户指示，仅查看器）：背景黑板改白（#fff）；站名黑字＋白色外描边
//（paint-order:stroke fill 先描后填＝描边只露外侧，外扩＝字号 1/8——12px 字 3px 描边可见
// 1.5px；CSS 见 index.html）＋站名缩放锚定站点（transform-origin 与 translate(-50%,-140%)
// 同参考点，拉远文字朝站点收拢、不再上浮漂移）；底图瓦片 100% 不透明＋其上白色遮罩 fill 层
//（全世界矩形、插在瓦片之上线路之下，只洗底图不碰线网站名；临时档位 30~70% 顶栏下拉、
// 测试定值后删）；站圈等比缩放改按 big/dark 拆三常量档位层——数据驱动 case 值作 zoom 插值
// stops（复合表达式）在真机不随缩放连续求值（线层同助手常量 stops 正常，「线缩圆不缩」
// 两轮目验未愈即此因），拆层后与线宽层同一机制。
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
    phase: 'none',                // 分期四档：'none'|'existing'|'approved'|'future'（默认无＝全部正常）
    focus: null,                  // 聚焦线路 lineId（null＝未聚焦；双击左栏行切换、Esc 退出）
    namesOn: true,                // 全局站名开关（false＝一切站名不显示，优先级最高）
    dimmed: new Set(),            // 调光线集（computeDimmedSet 按 phase/focus 叠加算出）
    dimPending: false,            // 样式未就绪时切分期/聚焦的补应用标记（目标态恒存 S.phase/S.focus）
    labelPool: new Map(),         // 标签元素复用池 key → div
    labelFrame: 0,                // rAF 合帧令牌
    searchIdx: [],                // 搜索条目
    dropIndex: 0,                 // 搜索下拉键盘焦点序
    basemap: 'off',               // 测试阶段底图三态：'off'|'osm'|'gaode'（默认无＝与现状零差别；不持久化）
    veil: 0.5,                     // 底图白色遮罩不透明度（2026-11-22 三批临时测试档：0/0.3~0.7，定值后随下拉一起删）
    dispCoord: V.makeDispCoord('none'), // 显示坐标变换（gaode＝WGS84→GCJ02；仅显示侧，见下方底图段）
    basemapPending: false,        // 样式未就绪时点击的补应用标记（目标态恒存 S.basemap）
    styleReady: false,            // map 'load' 已触发（样式只建一次，就绪后 addSource/addLayer 恒可用）
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
  // lines 在所有候选位都取不到才算加载失败。index.json（线路自定义显示序，编辑器排序面板
  // → manifest.lineOrder → flatten 产出）缺失按「无自定义序」容错——旧快照/旧 flatten 产物照常工作。
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
      let indexOrder = null;
      try {
        const idx = await fetchJSON(base + '/index.json');
        if (idx && idx.fmt === 'net-index@1' && Array.isArray(idx.lineOrder)) {
          indexOrder = idx.lineOrder.map(String);
        }
      } catch (e) { /* 无 index.json＝无自定义序，容错直通 */ }
      return { linesFC, stopsFC, base, indexOrder };
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

  // ---------- 渲染数据（由归一结果重建，保证 paint 属性干净齐全） ----------
  // 权威结构（S.linesMap/S.stops）恒 WGS84；渲染特征逐坐标过 S.dispCoord（测试阶段底图：
  // 'off'/'osm' 恒等直通、'gaode' 变 GCJ02）——bbox 也按显示坐标记账（fitAll/选中定位与
  // 渲染同帧一致；与 WGS84 差数百米，全图 fit 无感）。导出走权威结构，不经此处。
  // 2026-11-22 改版：特征带 dim 位（S.dimmed 调光线集），各图层 paint 据此半透明
  //（分期四档/聚焦两模式共用；调光状态下重设 source 即刷新）。
  function renderLinesFC() {
    S.dispBbox = new Map();
    const dc = S.dispCoord;
    const features = [];
    for (const line of S.linesMap.values()) {
      let bb = null;
      const dim = S.dimmed.has(line.lineId) ? 1 : 0;
      for (const seg of line.segments) {
        const coords = [];
        for (const pt of seg.coords) {
          if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
          const p = dc(pt[0], pt[1]);
          coords.push(p);
          bb = mergeBbox(bb, [p[0], p[1], p[0], p[1]]);
        }
        if (coords.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { lineId: line.lineId, name: line.name, color: line.color, segStatus: seg.segStatus, segIndex: seg.segIndex, dim },
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
  // pin 调光位：单站按本线；组符号（合并大圈/junction 圈）按「全成员被调光才半透明，
  // 任一成员未调光则正常」（与药丸同规则；出闸组成员是各自独立的单站圈，按本线各自调光）
  function pinDimmed(pin) {
    const ids = (pin.kind === 'group' && Array.isArray(pin.lineIds) && pin.lineIds.length)
      ? pin.lineIds : (pin.lineId ? [pin.lineId] : []);
    if (!ids.length) return 0;
    return ids.every((id) => S.dimmed.has(id)) ? 1 : 0;
  }
  function renderStopsFC() {
    // pin → circle：白填充；描边＝无组站取线色、同站组/出闸成员黑边（换乘语义）、
    // junction 组取成员线角色优先级色；big（同站大圈）与 dark（黑边加粗）为渲染开关位。
    // 坐标过 S.dispCoord（同 renderLinesFC，显示侧变换）。
    S.dispStopsBbox = null;
    const dc = S.dispCoord;
    const features = [];
    for (const pin of S.view.pins) {
      let stroke, dark = 0;
      if (pin.kind === 'group' && pin.groupType === 'junction') { stroke = junctionStroke(pin.lineIds); }
      else if (pin.kind === 'group' || pin.groupType === 'out-of-station') { stroke = '#000000'; dark = 1; }
      else {
        const line = S.linesMap.get(pin.lineId);
        stroke = line ? line.color : '#999999';
      }
      const p = dc(pin.lon, pin.lat);
      S.dispStopsBbox = mergeBbox(S.dispStopsBbox, [p[0], p[1], p[0], p[1]]);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p[0], p[1]] },
        properties: { key: pin.key, name: pin.name, lineId: pin.lineId || '', big: pin.big ? 1 : 0, dark, stroke, dim: pinDimmed(pin) },
      });
    }
    return { type: 'FeatureCollection', features };
  }
  // ≥3 线同站组药丸折线（view.pills 的 chain 已是贪心最近邻链序；成员圈已隐去、药丸即换乘标识）。
  // 特性携带 pin 的 key（渲染层据此查 pinByKey 开面板/hover）；坐标并入站点 bbox 供 fitAll 兜底；
  // 单点退化（共点组）复制端点保 LineString 合法——round 端帽渲染为圆点。
  function renderPillsFC() {
    const dc = S.dispCoord;
    const features = [];
    for (const pill of S.view.pills || []) {
      const coords = (pill.chain || [])
        .filter((c) => c && Number.isFinite(c[0]) && Number.isFinite(c[1]))
        .map((c) => dc(c[0], c[1]));
      if (!coords.length) continue;
      if (coords.length === 1) coords.push(coords[0]);
      for (const c of coords) S.dispStopsBbox = mergeBbox(S.dispStopsBbox, [c[0], c[1], c[0], c[1]]);
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: {
          key: pill.key, name: (pill.pin && pill.pin.name) || '',
          // 药丸调光规则：全成员线被调光才半透明（任一成员未调光则正常——2026-11-22 用户裁定）
          dim: (pill.lineIds || []).length && pill.lineIds.every((id) => S.dimmed.has(id)) ? 1 : 0,
        },
      });
    }
    return { type: 'FeatureCollection', features };
  }
  // 出省箭头（view.arrows，非站）：icon 名按线色区分（arrow-xxxxxx 三角 / arrowdot-xxxxxx 退化小圆点），
  // angle＝自北顺时针度数（icon-rotate 语义）。坐标并入站点 bbox 供 fitAll 兜底。
  function renderArrowsFC() {
    const dc = S.dispCoord;
    const features = [];
    for (const a of S.view.arrows || []) {
      const line = S.linesMap.get(a.lineId);
      const color = line && line.color ? line.color : '#999999';
      const icon = (a.angleDeg == null ? 'arrowdot-' : 'arrow-') + color.slice(1);
      const p = dc(a.lon, a.lat);
      S.dispStopsBbox = mergeBbox(S.dispStopsBbox, [p[0], p[1], p[0], p[1]]);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p[0], p[1]] },
        properties: { key: a.key, icon, angle: Math.round((a.angleDeg || 0) * 10) / 10, dim: S.dimmed.has(a.lineId) ? 1 : 0 },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  // ---------- 地图 ----------
  // 画布视觉参数＝编辑器同值常量（2026-11-22 用户裁定：查看器风格未定前复用编辑器画布）：
  // 线宽 7px 圆帽、药丸厚度 15（＝2×大圈半径 7.5）＋黑边 2.2、箭头 icon-size 1.0（glyph 24px
  // 画布 ≈ 编辑器 18×12 三角）、站圈 5.5/大圈 7.5/描边 2、黑边 2.2。
  // 2026-11-22 改版①⑦：渲染不再区分期次——单一线层、纯色实线、统一不透明（默认 dim=0 → 1.0；
  // 调光表达式恒挂，dim 位由渲染特征携带）；三档透明与远期虚线删除，无需按 segStatus 拆层。
  // 尺寸随缩放等比（2026-11-22 二次裁定「等比缩＋向上封顶」）：z≥11 恒基准（拉近不变粗）、
  // z<11 按 2^(z−11) 与画布同比例持续缩小、无下限地板（V.zoomInterp/V.scaledSize）；
  // z=11 与普通站名门槛一致（用户指定）。
  // 调光：line-opacity＝['case',['==',['get','dim'],1], DIM_OPACITY, 1]——被调光线（分期
  // 非选中/非聚焦/他省线）半透明；DIM_OPACITY＝0.5（旧「突出既有」档数值演化，占位待调）。
  // ⚠ line-cap/line-join 是 layout 属性——放 paint 会被样式校验判非法、整个 style 拒载
  //（2026-11-22 黑屏根因：药丸层初版起就放错在 paint，全部图层因此一个都不渲染）。
  const LINE_LAYER_IDS = ['lines'];
  function lineLayerDef() {
    return {
      id: 'lines', type: 'line', source: 'lines',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1],
        'line-width': V.zoomInterp(V.scaledSize(7), 7),
      },
    };
  }
  // 药丸：外黑宽＝2×7.5＋2×2.2＝19.4、内白宽 15（编辑器 grp-pill thick/border 同值）；圆帽即胶囊。
  // 调光与线层同规则（全成员被调光才半透明）；宽度同套缩放冻结。
  const PILL_LAYER_DEFS = [
    {
      id: 'pills-outer', type: 'line', source: 'pills',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#000000',
        'line-opacity': ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1],
        'line-width': V.zoomInterp(V.scaledSize(19.4), 19.4),
      },
    },
    {
      id: 'pills-inner', type: 'line', source: 'pills',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-opacity': ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1],
        'line-width': V.zoomInterp(V.scaledSize(15), 15),
      },
    },
  ];
  // 箭头 glyph：canvas 本地绘制（无 sprite 文件、零网络请求），icon-rotate 数据驱动旋转；
  // 不挂 click/mouseenter → 不触发 hover 提示与信息面板（搜索侧已无条目）。
  // icon-size 同套缩放冻结；icon-opacity 随所属线调光（调光线的出省箭头一并半透明）。
  const ARROWS_LAYER_DEF = {
    id: 'arrows', type: 'symbol', source: 'arrows',
    layout: {
      'icon-image': ['get', 'icon'],
      'icon-rotate': ['get', 'angle'],
      'icon-size': V.zoomInterp(V.scaledSize(1.0), 1.0),
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1] },
  };
  // 站圈层：按 big/dark 拆三层、各层尺寸全常量（编辑器同值：普通站圈 r5.5/描边2、出闸组成员
  // r5.5/黑边2.2、换乘大圈 r7.5/黑边2.2——.stop-c/.stop-merge）。2026-11-22 修复：此前用
  // ['case'] 档位值作 zoom 插值 stops（数据驱动×zoom 复合表达式），真机目验两轮「线缩圆不缩」
  //（线层同助手常量 stops 正常）——拆层后每层 stops 全常量、与已验证的线宽层同一机制。
  // filter 三层互斥全覆盖：big⇒黑边大圈（same-station ≤2 线合并，dark 恒 1）、
  // dark&&!big⇒出闸组成员（各自成圈不并点）、其余＝普通站＋junction 组（描边色仍逐站
  // ['get','stroke'] 取线色/角色优先级色——颜色数据驱动不带 zoom，不受此坑影响）。
  const STOP_LAYER_DEFS = [
    { id: 'stops', filter: ['all', ['!', ['get', 'big']], ['!', ['get', 'dark']]], radius: 5.5, strokeW: 2 },
    { id: 'stops-dark', filter: ['all', ['!', ['get', 'big']], ['get', 'dark']], radius: 5.5, strokeW: 2.2 },
    { id: 'stops-big', filter: ['==', ['get', 'big'], 1], radius: 7.5, strokeW: 2.2 },
  ];
  function stopLayerDef(d) {
    return {
      id: d.id, type: 'circle', source: 'stops', filter: d.filter,
      paint: {
        // 尺寸与线层同一套等比缩放（V.zoomInterp——z≥11 封顶、z<11 按 2^(z−11)）；
        // 被调光线的站圈半透明（同系数，填充与描边一起）
        'circle-color': '#ffffff',
        'circle-radius': V.zoomInterp(V.scaledSize(d.radius), d.radius),
        'circle-stroke-color': ['get', 'stroke'],
        'circle-stroke-width': V.zoomInterp(V.scaledSize(d.strokeW), d.strokeW),
        'circle-opacity': ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1],
        'circle-stroke-opacity': ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1],
      },
    };
  }
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
      // 内联 style：无 glyphs、无底图 sources、无文本 symbol（中文标签走 HTML 叠加层；
      // arrows 为纯图标 symbol，不涉及字形）。测试阶段底图不在 style 里声明——惰性 addSource，
      // 保证默认（无底图）路径零外部资源零网络请求。
      style: {
        version: 8,
        sources: {
          lines: { type: 'geojson', data: renderLinesFC() },
          stops: { type: 'geojson', data: renderStopsFC() },
          pills: { type: 'geojson', data: renderPillsFC() },
          arrows: { type: 'geojson', data: renderArrowsFC() },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },   // 2026-11-22 三批：黑板→白板
          ...LINE_LAYER_IDS.map(lineLayerDef),
          ...PILL_LAYER_DEFS,          // 药丸垫在站圈之下
          ...STOP_LAYER_DEFS.map(stopLayerDef),   // 站圈按 big/dark 拆三层（常量档位，见 stopLayerDef 注）
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
        if (p && p.lineId != null && p.lineId !== '') {
          // 「仅显示」级（他省线）点选不开线路信息面板（2026-11-22 用户裁定：仅显示，无交互）；
          // hover 光标为层粒度技术所限保留 pointer（见文件头说明），点选无动作即无交互
          const line = S.linesMap.get(String(p.lineId));
          if (line && V.lineLayerRank(line) === 'displayOnly') return;
          openLinePanel(String(p.lineId));
        }
      });
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; });
    }
    // 站圈三层（big/dark 拆层，filter 互斥）共绑同一组交互——行为与单层时代完全一致
    for (const id of STOP_LAYER_DEFS.map((d) => d.id)) {
      map.on('click', id, (e) => {
        const p = e.features && e.features[0] && e.features[0].properties;
        if (p && p.key) openStopPanel(String(p.key));
      });
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; hideStopTip(); });
      map.on('mousemove', id, showStopTip);
    }
    // 药丸层交互（成员圈已隐去，药丸本体承接点选/hover；两层同源，绑内层＋外层黑边均可命中）
    for (const id of ['pills-inner', 'pills-outer']) {
      map.on('click', id, (e) => {
        const p = e.features && e.features[0] && e.features[0].properties;
        if (p && p.key) openStopPanel(String(p.key));
      });
      map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; hideStopTip(); });
      map.on('mousemove', id, showStopTip);
    }
    map.on('error', (e) => {
      // MapLibre 运行时错误默认不上控制台（2026-11-22 黑屏排查教训：吞错害人）——显式转发
      console.error('map error:', e && e.error ? e.error.message || e.error : e);
    });
    map.on('load', () => {
      S.styleReady = true;
      // 补应用样式未就绪期间点的底图目标态（目标恒存 S.basemap，此处只补地图侧动作）
      if (S.basemapPending) { S.basemapPending = false; applyBasemapToMap(); }
      // 同理补应用提前切换的分期/聚焦调光（目标态恒存 S.phase/S.focus）
      if (S.dimPending) { S.dimPending = false; applyDimState(); }
      fitAll(); scheduleLabels();
      console.info('viewer map loaded: layers=' + (map.getStyle().layers || []).length
        + ', center=' + JSON.stringify(map.getCenter()) + ', zoom=' + map.getZoom().toFixed(2)
        + ', rendered=' + map.queryRenderedFeatures({ validate: false }).length);
    });
  }
  function fitAll() {
    const bb = totalBbox();
    if (bb) S.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 60, duration: 0, maxZoom: 12 });
  }

  // ---------- 测试阶段底图（三态：无 → OSM → 高德 → 无 循环） ----------
  // ⚠ 测试阶段功能（2026-11-22 用户指示的阶段性豁免）：早前用户曾裁定「查看器不放底图、
  // 零外部资源」，本段为测试期豁免，正式上线可能保留也可能移除——移除时删本段＋顶栏按钮＋
  // 图例卡署名行＋S 里三字段即可。默认 'off' 与无底图现状完全一致（不 addSource、零网络请求）；
  // 状态会话内不持久化（每次加载默认无底图）。
  // 对齐设计：OSM 瓦片 WGS84 与数据同基准直接叠；高德瓦片 GCJ02——不动瓦片、只把显示用坐标
  // 过 S.dispCoord（WGS84→GCJ02），权威数据与 GeoJSON/KML 导出一律 WGS84 一个字节不动
  //（编辑器是「逐瓦片常量偏移」动瓦片侧，查看器数据侧变换，各自单侧适配、殊途同归）。
  const BASEMAP_LABEL_ZH = { off: '无', osm: 'OSM', gaode: '高德' };
  const BASEMAP_ATTR_ZH = { osm: '底图 © OpenStreetMap 贡献者', gaode: '底图 © 高德' };
  function syncBasemapUI() {
    const b = $('btnBasemap');
    if (b) b.textContent = '底图：' + (BASEMAP_LABEL_ZH[S.basemap] || S.basemap);
    const attr = $('basemapAttr');
    let text = '';
    if (attr) {
      text = BASEMAP_ATTR_ZH[S.basemap] || '';
      attr.textContent = text;
      attr.hidden = !text;   // 「无」时隐藏（attributionControl:false，此行即署名载体）
    }
    // 2026-11-22 改版：三档线样说明与「突出既有」开关已删，图例卡只剩署名行——
    // 无底图时整卡隐藏，有底图才现身（避免空卡片悬在左下角）
    const panel = $('legendPanel');
    if (panel) panel.hidden = !text;
  }
  // 惰性建层：首次开底图才 addSource/addLayer（默认路径零请求）；raster＋白色遮罩插到首条
  // 线路图层之下——数据压瓦片、bg 背景层被瓦片盖住（无妨，瓦片即底色）。切回「无」只藏不删
  //（setLayoutProperty visibility none，source 保留——再开免重建）。
  // 瓦片 URL 与编辑器 src/editor.js 同源：OSM 同址；高德四子域 webrd01~04＋style=8——编辑器
  // 按 (tx+ty)%4 取子域，MapLibre 无子域模板语法，tiles 列 4 个完整 URL 由其内部轮询，等价。
  // 2026-11-22 三批：瓦片 100% 不透明（旧 0.45 透明作废），提亮改走白色遮罩 fill 层——
  // 全世界矩形（Mercator ±85.0511，任何平移不出界），插在瓦片之上、线路之下，只洗底图
  // 不碰线网站名；不透明度＝S.veil（临时测试档 30~70% 顶栏下拉，定值后连下拉一起删）。
  function ensureBasemapLayers() {
    const map = S.map;
    if (!map || map.getSource('basemap-osm')) return;
    map.addSource('basemap-osm', {
      type: 'raster', tileSize: 256,
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    });
    map.addSource('basemap-gaode', {
      type: 'raster', tileSize: 256,
      tiles: [1, 2, 3, 4].map((n) =>
        'https://webrd0' + n + '.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}'),
    });
    map.addSource('basemap-veil', {
      type: 'geojson',
      data: {
        type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[
          [-180, -85.0511], [-180, 85.0511], [180, 85.0511], [180, -85.0511], [-180, -85.0511],
        ]] },
      },
    });
    const before = map.getLayer(LINE_LAYER_IDS[0]) ? LINE_LAYER_IDS[0] : undefined;
    map.addLayer({ id: 'basemap-osm', type: 'raster', source: 'basemap-osm',
      layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } }, before);
    map.addLayer({ id: 'basemap-gaode', type: 'raster', source: 'basemap-gaode',
      layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } }, before);
    map.addLayer({ id: 'basemap-veil', type: 'fill', source: 'basemap-veil',
      layout: { visibility: 'none' }, paint: { 'fill-color': '#ffffff', 'fill-opacity': S.veil } }, before);
  }
  // 应用到地图：层可见性＋显示坐标变换＋四个 source 全量 setData 重渲染＋标签重排
  //（复用既有 render 函数，mode 变了自然产出变换后坐标）。箭头 icon-rotate 角度是 WGS84
  // 下算的——GCJ 常量级偏移（百米级）对方向角影响可忽略，不重算；fitAll/选中定位用的
  // dispBbox 已是显示坐标（与渲染同帧），不特殊处理。
  function applyBasemapToMap() {
    if (S.basemap !== 'off') ensureBasemapLayers();
    const vis = (layerId, on) => {
      if (S.map.getLayer(layerId)) S.map.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none');
    };
    vis('basemap-osm', S.basemap === 'osm');
    vis('basemap-gaode', S.basemap === 'gaode');
    // 遮罩只在底图开启且档位非零时现身（fill-opacity 建层时取 S.veil，档位变化走 setPaintProperty）
    vis('basemap-veil', S.basemap !== 'off' && S.veil > 0);
    S.dispCoord = V.makeDispCoord(S.basemap === 'gaode' ? 'gaode' : 'none');
    if (S.map.getSource('lines')) S.map.getSource('lines').setData(renderLinesFC());
    if (S.map.getSource('stops')) S.map.getSource('stops').setData(renderStopsFC());
    if (S.map.getSource('pills')) S.map.getSource('pills').setData(renderPillsFC());
    if (S.map.getSource('arrows')) S.map.getSource('arrows').setData(renderArrowsFC());
    scheduleLabels();
  }
  // 目标态恒存 S.basemap（按钮文案/署名即时跟随）；样式未就绪（buildMap 前/样式加载中）只置
  // pending 标记、on('load') 后补应用，点击不丢失。isStyleLoaded 在地图 idle 时也可能返回
  // false，故叠加自记 styleReady（本页样式只建一次、永不 setStyle，就绪后恒可安全加层）。
  function setBasemap(mode) {
    S.basemap = mode;
    syncBasemapUI();
    if (!S.map || !(S.styleReady || S.map.isStyleLoaded())) { S.basemapPending = true; return; }
    S.basemapPending = false;
    applyBasemapToMap();
  }

  // ---------- 分期四档 / 聚焦 / 调光 / 全局站名开关 ----------
  // 调光应用：重算 S.dimmed → 四个 source 全量重设（渲染特征重带 dim 位）→ 标签重排。
  // 与底图切换共用 render* 函数（互相独立、叠加不冲突——坐标变换与 dim 位各管各的）。
  // 样式未就绪时只置 pending 标记（同底图三态模式），on('load') 后补应用，点击不丢失。
  function applyDimState() {
    S.dimmed = V.computeDimmedSet(S.linesMap, { phase: S.phase, focus: S.focus });
    if (!S.map || !(S.styleReady || S.map.isStyleLoaded())) { S.dimPending = true; return; }
    S.dimPending = false;
    if (S.map.getSource('lines')) S.map.getSource('lines').setData(renderLinesFC());
    if (S.map.getSource('stops')) S.map.getSource('stops').setData(renderStopsFC());
    if (S.map.getSource('pills')) S.map.getSource('pills').setData(renderPillsFC());
    if (S.map.getSource('arrows')) S.map.getSource('arrows').setData(renderArrowsFC());
    scheduleLabels();
  }
  // 分期四档循环：无 → 既有 → 已批复 → 远期 → 无（「无」＝全部正常显示）
  function syncPhaseUI() {
    const b = $('btnPhase');
    if (b) b.textContent = '分期：' + (V.PHASE_LABEL_ZH[S.phase] || S.phase);
  }
  function setPhase(mode) {
    S.phase = mode;
    syncPhaseUI();
    applyDimState();
  }
  // 聚焦：双击列表行切换（再双击同一行退出、双击别的行切换）、Esc 退出；
  // 「仅显示」级（他省线）不可聚焦——setFocus 入口统一拦截（列表双击/搜索选中都走这里）
  function setFocus(lineId) {
    const id = lineId || null;
    if (id != null) {
      const line = S.linesMap.get(id);
      if (line && V.lineLayerRank(line) === 'displayOnly') return;
    }
    S.focus = id;
    syncFocusRows();
    syncFocusBox();
    applyDimState();
  }
  function toggleFocus(lineId) { setFocus(S.focus === lineId ? null : lineId); }
  function clearFocus() { if (S.focus != null) setFocus(null); }
  // 列表行聚焦态高亮（行上 .focused 类）
  function syncFocusRows() {
    document.querySelectorAll('#lineList .line-item').forEach((el) => {
      el.classList.toggle('focused', S.focus != null && el.dataset.line === S.focus);
    });
  }
  // 屏幕下方居中聚焦信息框（占位内容，用户稍后定）：线名、类别、分段状态统计、车站数、起讫站
  function syncFocusBox() {
    const box = $('focusBox');
    if (!box) return;
    const sum = S.focus != null ? S.summaries.get(S.focus) : null;
    if (!sum) { box.hidden = true; return; }
    $('focusTitle').textContent = sum.name || sum.lineId;
    const body = $('focusBody');
    body.textContent = '';
    infoRow(body, '类别', sum.layer || '未分类');
    infoRow(body, '分段状态', '既有 ' + sum.segCounts.existing + ' 段 · 已批复 ' + sum.segCounts.approved + ' 段 · 远期 ' + sum.segCounts.future + ' 段');
    infoRow(body, '车站数', String(sum.stopCount));
    infoRow(body, '起讫站', V.formatTerminals(sum));
    box.hidden = false;
  }
  // 全局站名开关：隐藏时一切站名不显示（优先级最高，只影响 HTML 标签、站圈符号保留）
  function syncNamesUI() {
    const b = $('btnNames');
    if (b) b.textContent = '站名：' + (S.namesOn ? '显示' : '隐藏');
  }
  function toggleNames() {
    S.namesOn = !S.namesOn;
    syncNamesUI();
    scheduleLabels();
  }

  // ---------- 线路列表面板（按 layer 分组；双击聚焦；类别过滤＋「仅显示」级禁用态） ----------
  // 2026-11-22 改版：复选框与多选高亮整套删除；双击行＝聚焦该线（再双击/Esc 退出）。
  // HIDDEN_LIST_LAYERS 类别（默认「联络线」）不出现在列表（地图照画、搜索照收）；
  // 「仅显示」级（他省线）行加禁用态样式且双击不聚焦。类别在行上以 chip 小字展示。
  function buildLineList() {
    const host = $('lineList');
    host.textContent = '';
    const groups = V.visibleListGroups(S.linesMap, V.HIDDEN_LIST_LAYERS, S.lineOrder);
    if (!groups.length) {
      const tip = document.createElement('div');
      tip.className = 'panel-tip';
      tip.textContent = '（没有可列出的线路：net/lines.geojson 为空，或全部被左栏类别隐藏设置过滤）';
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
        const item = document.createElement('div');
        item.className = 'line-item';
        item.dataset.line = line.lineId;
        const sw = document.createElement('span');
        sw.className = 'line-swatch'; sw.style.background = line.color;
        const nm = document.createElement('span');
        nm.className = 'line-name'; nm.textContent = line.name || line.lineId;
        item.append(sw, nm);
        if (line.layer) {   // 类别 chip（小字展示；分组头已示类别，此为行级冗余展示）
          const chip = document.createElement('span');
          chip.className = 'line-chip'; chip.textContent = line.layer;
          item.appendChild(chip);
        }
        const displayOnly = V.lineLayerRank(line) === 'displayOnly';
        if (displayOnly) {   // 「仅显示」级：双击不聚焦（setFocus 亦有兜底拦截），视觉弱化
          item.classList.add('display-only');
          item.title = '他省线（仅显示）：不参与聚焦与分期高亮';
        } else {
          item.title = '双击聚焦该线路（再双击同一行或按 Esc 退出）';
          item.addEventListener('dblclick', () => toggleFocus(line.lineId));
        }
        if (S.focus === line.lineId) item.classList.add('focused');
        gEl.appendChild(item);
      }
      host.appendChild(gEl);
    }
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
      const kml = V.buildLineKML(lineId, S.linesMap, S.stops);
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
      // 搜索选中线路＝聚焦（多选高亮已删）；「仅显示」级（他省线）不聚焦不开面板，
      // 仅飞过去看（与地图点选/列表双击的「仅显示、无交互」裁定一致）
      const line = S.linesMap.get(ent.id);
      const displayOnly = !!line && V.lineLayerRank(line) === 'displayOnly';
      const bb = S.dispBbox.get(ent.id) || (ent.ref && ent.ref.bbox);
      if (bb) {
        S.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 80, duration: 600, maxZoom: 13 });
      }
      if (!displayOnly) {
        setFocus(ent.id);
        openLinePanel(ent.id);
      }
    } else {
      const lb = ent.ref;
      if (!lb) return;
      // 相机定位取显示坐标（与渲染/标签同帧——gaode 下飞 WGS84 会偏半公里；搜索条目本身不动）
      S.map.flyTo({ center: S.dispCoord(lb.lon, lb.lat), zoom: Math.max(S.map.getZoom(), 13.5), duration: 800 });
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
    // 站名可见性（优先级：全局站名开关 ＞ 聚焦线常显 ＞ 被调光线隐藏 ＞ zoom 门槛）
    const items = V.visibleLabels(S.dispLabels, map.getZoom(), V.LABEL_CAP,
      { hideAll: !S.namesOn, dimmedSet: S.dimmed, focus: S.focus });
    const w = wrap.clientWidth, h = wrap.clientHeight, M = 60;   // 视口外裁剪边距
    // 站名文字随画布等比缩放（2026-11-22 用户指示「站名和站点也一样，以 z11 为界」）：
    // z≥11 恒 1、z<11 按 2^(z−11)——与线宽/站圈同一规则（V.labelScale），挂 transform 末尾
    // 随标签自身锚点缩不漂移；百分比偏移（-50%/-140%）基于自身盒子也同步缩小，自然贴近站点。
    const zf = V.labelScale(map.getZoom());
    const zfTxt = zf < 1 ? ' scale(' + zf.toFixed(3) + ')' : '';
    const seen = new Set();
    for (const it of items) {
      let xy;
      // 标签定位过 S.dispCoord（显示侧变换：gaode 下与瓦片同帧；S.dispLabels 本身恒 WGS84）
      try { xy = map.project(S.dispCoord(it.lon, it.lat)); } catch (e) { continue; }
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
      el.style.transform = 'translate3d(' + xy.x.toFixed(1) + 'px,' + xy.y.toFixed(1) + 'px,0) translate(-50%,-140%)' + zfTxt;
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

  // ---------- 顶栏 / 面板交互 ----------
  //（2026-11-22 改版：图例联动段删除——三档线样与「突出既有」开关退役，图例卡只剩底图署名行）
  function wireUI() {
    // 分期四档循环：无 → 既有 → 已批复 → 远期 → 无（不持久化，刷新回默认「无」）
    $('btnPhase').addEventListener('click', () => setPhase(V.nextPhase(S.phase)));
    // 全局站名开关：显示 ⇄ 隐藏（优先级最高——隐藏时一切站名不显示，站圈符号保留）
    $('btnNames').addEventListener('click', toggleNames);
    // 测试阶段底图三态循环：无 → OSM → 高德 → 无（不持久化，刷新回默认「无」）
    $('btnBasemap').addEventListener('click', () => {
      setBasemap(S.basemap === 'off' ? 'osm' : (S.basemap === 'osm' ? 'gaode' : 'off'));
    });
    // 白色遮罩档位（⚠ 临时测试控件，2026-11-22 用户指示做档测试效果、定值后删——
    // HTML 里的 #selVeil 与 S.veil 一并移除）：底图未开时只存值，开底图时按存值建层生效
    $('selVeil').addEventListener('change', () => {
      S.veil = parseFloat($('selVeil').value) || 0;
      if (S.map && S.map.getLayer('basemap-veil')) {
        S.map.setPaintProperty('basemap-veil', 'fill-opacity', S.veil);
        S.map.setLayoutProperty('basemap-veil', 'visibility',
          S.basemap !== 'off' && S.veil > 0 ? 'visible' : 'none');
      }
    });
    syncPhaseUI();     // 与 S.phase 初始态（'none'）对齐：按钮文案「分期：无」
    syncNamesUI();     // 与 S.namesOn 初始态（true）对齐：按钮文案「站名：显示」
    syncBasemapUI();   // 与 S.basemap 初始态（'off'）对齐：按钮文案「底图：无」、署名隐藏
    $('infoClose').addEventListener('click', () => { $('infoPanel').hidden = true; });
    $('focusClose').addEventListener('click', clearFocus);
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
      clearFocus();                    // Esc 退出聚焦（输入框内的 Esc 归搜索框自己处理）
      $('infoPanel').hidden = true;
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
    S.lineOrder = net.indexOrder || null;   // 线路列表自定义显示序（无则组内 id 升序）
    if (!S.linesMap.size && !S.stops.length) {
      showCenter('暂无数据', '已读取 ' + net.base + '/，但其中没有可显示的线路或车站。'
        + '请确认编辑器已录入数据，并重新运行 flatten（或 publish）。');
      return;
    }
    S.summaries = V.lineSummaries(S.linesMap, S.stops);
    S.view = V.buildStopView(S.stops);
    S.dispLabels = S.view.labels;   // WGS84 直通（仅进 map.project 定位）
    S.pinByKey = new Map(S.view.pins.map((p) => [p.key, p]));
    for (const pill of S.view.pills || []) if (pill.pin) S.pinByKey.set(pill.pin.key, pill.pin);
    buildSearchIndex();

    buildMap();
    buildLineList();
    wireUI();
    hideCenter();
    scheduleLabels();
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
