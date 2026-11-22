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
// 2026-11-22 三项增补（用户需求）：①聚焦跳转——setFocus 进入聚焦时 fitBounds 到该线
// 渲染 bbox、四边留白按实时布局动态取（顶栏/左栏/聚焦框/信息面板各让位＋24px 呼吸），
// 退出聚焦绝对不动相机（「再次双击不必跳回」）；②地图画布双击线路同样触发聚焦（与左栏
// 行双击同一 toggle 语义，命中且非「仅显示」级才 preventDefault 阻止原生双击缩放）；
// ③聚焦线绑定的联络线沿线渐变透明——接聚焦线一端不透明、另一端 alpha 0（方向＝几何
// 最近端判定，见 VIEWER_CORE.connectorFadePlan；MapLibre line-gradient 不能数据驱动，
// 故每条联络线一个动态图层共享 conn-fade source，方向靠坐标序定向）。
// 2026-11-22 三批（用户指示，仅查看器）：背景黑板改白（#fff）；站名黑字＋白色外描边
//（paint-order:stroke fill 先描后填＝描边只露外侧，外扩＝字号 1/8——12px 字 3px 描边可见
// 1.5px；CSS 见 index.html）＋站名缩放锚定站点（transform-origin 与 translate(-50%,-140%)
// 同参考点，拉远文字朝站点收拢、不再上浮漂移）；底图瓦片 100% 不透明＋其上白色遮罩 fill 层
//（全世界矩形、插在瓦片之上线路之下，只洗底图不碰线网站名；不透明度用户档测定值 40%
// VEIL_OPACITY，临时下拉控件已删）；站圈等比缩放改按 big/dark 拆三常量档位层（同轮
// filter 曾用 '!' 吃数字被判类型错、三层静默弃载即「站圆全没」——已改显式 == 比较，教训
// 见 STOP_LAYER_DEFS 注）。
// 2026-11-22 主支线合并（用户裁定：主线与支线在任何情况下视为一条线）：左栏列表合并行
//（显示名＝线组名称、色块＝主线色、归类与排序按主线、支线不出独立行）；聚焦存主线 id
//（双击支线线身经 toggleFocus 归一到主线）、调光豁免与 fitBounds 跳转均按组全体成员；
// 分期调光组级（期次/仅显示级以主线为准）；搜索合并条目（成员线名/别名/id 全命中主线）；
// 信息面板/聚焦框/站牌显组名、内容与导出按主线。组信息来自 net/index.json lineGroups
//（fmt net-index@2；@1 旧快照无组信息＝逐线独立旧行为）。
// 2026-11-22 增（用户反馈）：地图双击线路精确命中——queryRenderedFeatures 只作粗筛拿候选，
// 命中以屏幕像素距离为准（候选坐标逐点 map.project → VIEWER_CORE.pointToScreenPolylineDist，
// 阈值＝lineWidthAt(zoom)/2＋DBLCLICK_TOL_PX），只有直接点到线体描边上才聚焦并
// preventDefault，全部超阈值＝未命中放行原生双击缩放。
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
    lineGroups: { groups: [], ofLine: new Map(), mainOf: new Map() },  // 线组归并（主支线合并；boot 填充，缺省空结构＝逐线独立）
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
    dispCoord: V.makeDispCoord('none'), // 显示坐标变换（gaode＝WGS84→GCJ02；仅显示侧，见下方底图段）
    basemapPending: false,        // 样式未就绪时点击的补应用标记（目标态恒存 S.basemap）
    styleReady: false,            // map 'load' 已触发（样式只建一次，就绪后 addSource/addLayer 恒可用）
    panelCollapsed: false,        // 线路面板收起态（2026-11-22 用户需求；会话内不持久化，刷新回展开——与底图三态等 UI 态同策）
    // 2026-11-22 用户需求 3：联络线渐变高亮——fadeSet＝当前聚焦的绑定联络线 lineId 集
    //（renderLinesFC 据此跳过基础线层 feature，防半透明底线垫在渐变尾端底下透出）；
    // fadeConnPlan＝connectorFadePlan 缓存（rebuildConnFade 复用，避免重复几何判定）；
    // connFadeLayerIds＝已加的动态渐变层 id（conn-fade-<lineId>，退出聚焦时移除）。
    fadeSet: new Set(),
    fadeConnPlan: [],
    connFadeLayerIds: [],
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
  // lines 在所有候选位都取不到才算加载失败。index.json（线路自定义显示序＋线组索引，编辑器
  // 排序面板 → manifest.lineOrder → flatten 产出）缺失按「无自定义序/无线组」容错——旧快照/
  // 旧 flatten 产物照常工作。fmt 严格校验（有校验故随 flatten 升版）：@2＝含 lineGroups
  //（主支线合并）；@1＝仅 lineOrder（旧快照，无组信息＝逐线独立显示）。两版都收 lineOrder。
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
      let indexOrder = null, lineGroups = null;
      try {
        const idx = await fetchJSON(base + '/index.json');
        if (idx && (idx.fmt === 'net-index@2' || idx.fmt === 'net-index@1')) {
          if (Array.isArray(idx.lineOrder)) indexOrder = idx.lineOrder.map(String);
          if (idx.fmt === 'net-index@2' && Array.isArray(idx.lineGroups)) lineGroups = idx.lineGroups;
        }
      } catch (e) { /* 无 index.json＝无自定义序/无线组，容错直通 */ }
      return { linesFC, stopsFC, base, indexOrder, lineGroups };
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
  // 2026-11-22 用户需求 3：fadeSet 中的联络线不再产出 'lines' 层 feature——渐变图层
  // 接管其显示后，半透明底线会垫在渐变尾端底下透出，违反「另一端 alpha 0」；
  // 但 S.dispBbox 记账照旧（只跳 feature 不跳 bbox——fitBounds/搜索定位不受影响）。
  function renderLinesFC() {
    S.dispBbox = new Map();
    const dc = S.dispCoord;
    const features = [];
    for (const line of S.linesMap.values()) {
      let bb = null;
      const dim = S.dimmed.has(line.lineId) ? 1 : 0;
      const fade = S.fadeSet.has(line.lineId);
      for (const seg of line.segments) {
        const coords = [];
        for (const pt of seg.coords) {
          if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
          const p = dc(pt[0], pt[1]);
          coords.push(p);
          bb = mergeBbox(bb, [p[0], p[1], p[0], p[1]]);
        }
        if (coords.length < 2) continue;
        if (fade) continue;   // 渐变联络线不进基础线层（bbox 已记账，见上注）
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
        // 2026-11-22 双击精确命中：线宽基准常量收敛到 V.LINE_WIDTH_PX（与 V.lineWidthAt
        // 同一数值源，防两处漂移——胶水层命中阈值按它算）
        'line-width': V.zoomInterp(V.scaledSize(V.LINE_WIDTH_PX), V.LINE_WIDTH_PX),
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
  // ⚠ filter 一律显式 ['==', ['get','x'], 0/1]：表达式 '!' 要求布尔输入，而 GeoJSON 属性
  // big/dark 是数字——'!' 数字判类型错，所在层被 MapLibre 静默弃载（c07360d「站圆全没」
  // 根因：药丸/线/箭头层无 filter 照常渲染，三个站圈层全弃；错误只进 console 不上画面）。
  const STOP_LAYER_DEFS = [
    { id: 'stops', filter: ['all', ['==', ['get', 'big'], 0], ['==', ['get', 'dark'], 0]], radius: 5.5, strokeW: 2 },
    { id: 'stops-dark', filter: ['all', ['==', ['get', 'big'], 0], ['==', ['get', 'dark'], 1]], radius: 5.5, strokeW: 2.2 },
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
          // 联络线渐变 source（2026-11-22 用户需求 3）：lineMetrics:true 是 line-gradient
          // 的前置要求；初始空 FC，聚焦时由 rebuildConnFade 动态填数＋逐线加层。
          // 渐变图层不进初始 layers——聚焦才建（见 rebuildConnFade）。
          'conn-fade': { type: 'geojson', lineMetrics: true, data: { type: 'FeatureCollection', features: [] } },
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
    // 2026-11-22 晚终裁（用户）：地图线路上的一切点击聚焦交互撤除——单击聚焦与双击原生
    // 缩放抢相机（click 有动作则双击必叠加抖动），preventDefault 亦拦不住 MapLibre 双击
    // 缩放（当轮真机实证：MapLibre 不检查 defaultPrevented，此前「验证过有效」系仅查了
    // API 类型未实测，教训记档）。聚焦入口只留左栏列表行双击（toggleFocus）；线路线身
    // 单/双击＝无动作，双击线路与双击空白一律原生缩放。精确命中工具链（lineWidthAt /
    // pointToScreenPolylineDist / DBLCLICK_TOL_PX）保留在 VIEWER_CORE 供日后回启，此处
    // 不再引用；hover 也不设 pointer 光标（不可点即不暗示可点）。
    //（站圈/药丸交互照旧——点选开站点面板，见下。）
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
  // 底图白色遮罩不透明度：2026-11-22 用户档位测试后定值 40%（临时下拉控件已删，调值改此处）
  const VEIL_OPACITY = 0.4;
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
  // 不碰线网站名；不透明度＝VEIL_OPACITY（用户档位测试定值 40%，临时下拉已删）。
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
      layout: { visibility: 'none' }, paint: { 'fill-color': '#ffffff', 'fill-opacity': VEIL_OPACITY } }, before);
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
    // 遮罩随底图开关（不透明度定值 VEIL_OPACITY，无运行时档位）
    vis('basemap-veil', S.basemap !== 'off');
    S.dispCoord = V.makeDispCoord(S.basemap === 'gaode' ? 'gaode' : 'none');
    if (S.map.getSource('lines')) S.map.getSource('lines').setData(renderLinesFC());
    if (S.map.getSource('stops')) S.map.getSource('stops').setData(renderStopsFC());
    if (S.map.getSource('pills')) S.map.getSource('pills').setData(renderPillsFC());
    if (S.map.getSource('arrows')) S.map.getSource('arrows').setData(renderArrowsFC());
    rebuildConnFade();   // 渐变特征坐标必须同帧过 S.dispCoord（2026-11-22 用户需求 3）
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
  // 调光应用：重算 S.dimmed 与联络线渐变集 → 四个 source 全量重设（渲染特征重带 dim 位、
  // fadeSet 线跳基础层）→ 渐变层重建 → 标签重排。与底图切换共用 render* 函数（互相独立、
  // 叠加不冲突——坐标变换与 dim 位各管各的）。样式未就绪时只置 pending 标记（同底图三态
  // 模式），on('load') 后补应用，点击不丢失。
  function applyDimState() {
    // 2026-11-22 主支线合并：调光组级（lineGroups 传入——期次/仅显示级以主线为准，
    // 聚焦豁免组全体成员；S.focus 恒为主线 id，见 toggleFocus 归一）
    S.dimmed = V.computeDimmedSet(S.linesMap, { phase: S.phase, focus: S.focus, lineGroups: S.lineGroups });
    updateFadeSet();   // fadeSet 须在 renderLinesFC 之前就绪（基础层跳 feature 依赖它）
    if (!S.map || !(S.styleReady || S.map.isStyleLoaded())) { S.dimPending = true; return; }
    S.dimPending = false;
    if (S.map.getSource('lines')) S.map.getSource('lines').setData(renderLinesFC());
    if (S.map.getSource('stops')) S.map.getSource('stops').setData(renderStopsFC());
    if (S.map.getSource('pills')) S.map.getSource('pills').setData(renderPillsFC());
    if (S.map.getSource('arrows')) S.map.getSource('arrows').setData(renderArrowsFC());
    rebuildConnFade();
    scheduleLabels();
  }
  // ---------- 联络线渐变高亮（2026-11-22 用户需求 3：聚焦线的绑定联络线沿线渐变透明） ----------
  // 聚焦线 L 时，connects 含 L 的每条联络线渲染为：接 L 的一端不透明 → 沿线贝塞尔插值
  // 降低透明度 → 另一端 alpha 0。技术约束：MapLibre 的 line-gradient 不能数据驱动
  //（不能引用 feature 属性），且要求 source 开 lineMetrics:true、feature 为单条
  // LineString——故共享一个 source（'conn-fade'）、每条绑定联络线动态 addLayer 一个层，
  // 各自 line-gradient 用常量色（该线颜色）从 alpha1 渐到 alpha0，并以 filter
  // ['==',['get','lineId'],…] 只渲染自己的 feature（层间互不串色）。几何方向靠坐标序
  // 定向：拼接时 attachEnd===1 就反转坐标数组，保证梯度恒为「首端(接入端)不透明 →
  // 末端 0」。渐变层不绑任何点击/hover（联络线本体的点选开面板走 'lines' 层——被
  // fadeSet 排除后渐变层上点不到就算了，可接受）。
  // fadeSet 重算（纯数据，不碰地图）：必须在任何 renderLinesFC 之前执行——基础线层
  // 跳 feature 依赖它。plan 缓存进 S.fadeConnPlan 供 rebuildConnFade 复用。
  function updateFadeSet() {
    const plan = S.focus != null ? V.connectorFadePlan(S.linesMap, S.focus) : [];
    S.fadeConnPlan = plan;
    S.fadeSet = new Set(plan.map((it) => it.lineId));
  }
  const EMPTY_CONN_FC = { type: 'FeatureCollection', features: [] };
  // 渐变层定义：line-cap/line-join 是 layout 属性（⚠ 放 paint 会整个 style 拒载全黑——
  // 本项目踩过的坑）；线宽与线层同宽同缩放（V.zoomInterp(V.scaledSize(7),7)）。
  function connFadeLayerDef(layerId, lineId, color) {
    const hex = V.normalizeHex(color) || '#888888';
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    return {
      id: layerId, type: 'line', source: 'conn-fade',
      filter: ['==', ['get', 'lineId'], lineId],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-gradient': ['interpolate', ['linear'], ['line-progress'],
          0, 'rgba(' + r + ',' + g + ',' + b + ',1)',
          1, 'rgba(' + r + ',' + g + ',' + b + ',0)'],
        'line-width': V.zoomInterp(V.scaledSize(V.LINE_WIDTH_PX), V.LINE_WIDTH_PX),
      },
    };
  }
  // 重建渐变层：先移除旧动态层（getLayer 判断）；无聚焦或 plan 空 → fadeSet 清空、
  // source 置空 FC；否则逐条产出拼接 LineString（segments 按 segIndex 拼接 → 过滤
  // 有限坐标 → 逐点过 S.dispCoord 显示变换——与四 source 同帧，底图切换 gaode 下渐变
  // 坐标才不漂）并 addLayer（插在 'pills-outer' 之前＝紧挨线层之上、药丸之下）。
  // 挂接点：applyDimState 与 applyBasemapToMap 末尾（调光与底图切换都重设 source 坐标）；
  // 样式未就绪的 pending 路径由既有 dimPending/basemapPending 补应用机制自然覆盖。
  function rebuildConnFade() {
    const map = S.map;
    if (!map) return;
    for (const id of S.connFadeLayerIds) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    S.connFadeLayerIds = [];
    const src = map.getSource('conn-fade');
    const plan = S.fadeConnPlan || [];
    if (!plan.length) {
      if (src) src.setData(EMPTY_CONN_FC);
      return;
    }
    const dc = S.dispCoord;
    const feats = [];
    for (const it of plan) {
      const line = S.linesMap.get(it.lineId);
      if (!line) continue;
      const coords = [];
      for (const seg of line.segments) {   // normalizeLines 已保证按 segIndex 升序
        for (const pt of seg.coords) {
          if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
          coords.push(dc(pt[0], pt[1]));
        }
      }
      if (coords.length < 2) continue;   // 全无效坐标的线本就不进基础层，这里同样不进渐变
      if (it.attachEnd === 1) coords.reverse();   // 方向定向：恒「首端＝接入聚焦线的一端」
      feats.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { lineId: line.lineId, color: line.color },
      });
      const layerId = 'conn-fade-' + line.lineId;
      const before = map.getLayer('pills-outer') ? 'pills-outer' : undefined;
      map.addLayer(connFadeLayerDef(layerId, line.lineId, line.color), before);
      S.connFadeLayerIds.push(layerId);
    }
    if (src) src.setData({ type: 'FeatureCollection', features: feats });
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
  // 聚焦：双击列表行/双击地图线路切换（再双击同一对象退出、双击别的线切换）、Esc 退出；
  // 「仅显示」级（他省线）不可聚焦——setFocus 入口统一拦截（列表双击/地图双击/搜索选中
  // 都走这里）。2026-11-22 用户需求 1：进入聚焦时相机 fitBounds 跳到该线（退出聚焦
  // 绝对不动相机——用户明令「再次双击不必跳回之前的视图」）。
  function setFocus(lineId) {
    // 2026-11-22 晚交互改版：入口统一归一到主线（地图点选支线线身等效聚焦主线组；
    // toggleFocus/pickEntry 原地归一由此收口，幂等——同线重复进入不动）
    const raw = lineId || null;
    const id = raw != null ? (S.lineGroups.mainOf.get(raw) || raw) : null;
    if (id != null) {
      const line = S.linesMap.get(id);
      if (line && V.lineLayerRank(line) === 'displayOnly') return;
    }
    S.focus = id;
    syncFocusRows();
    syncFocusBox();        // 先把聚焦框显示出来——focusPadding 量其 offsetHeight 才拿得到
    applyDimState();
    if (id != null) fitFocusLine(id);   // 需求 1：仅进入聚焦跳相机；setFocus(null) 不跳
  }
  // 2026-11-22 用户需求 1：聚焦线相机跳转——fitBounds 到该线渲染 bbox（S.dispBbox 与
  // 渲染特征同帧，gaode 底图下也正确）；bbox 不存在时静默不跳。maxZoom 13 与搜索定位同档。
  // 2026-11-22 主支线合并：bbox＝组全体成员渲染 bbox 联合（支线也是这条线的一部分）；
  // 单成员缺 bbox 跳过，全体缺失 → null 静默不跳（保留原行为）。
  function fitFocusLine(id) {
    const grp = S.lineGroups.ofLine.get(id);
    let bb = null;
    if (grp) {
      for (const m of grp.members) bb = mergeBbox(bb, S.dispBbox.get(m));
    } else {
      bb = S.dispBbox.get(id);
    }
    if (!bb || !S.map) return;
    S.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]],
      { padding: focusPadding(), duration: 600, maxZoom: 13 });
  }
  // 面板可见性运行时探测：!el.hidden 且 rect.width>0（另有并行改动在做面板收起——
  // 读实时状态即可自然兼容，不依赖静态假设，也不去改面板代码）。
  function panelVisible(el) {
    if (!el || el.hidden) return false;
    return el.getBoundingClientRect().width > 0;
  }
  // 2026-11-22 用户需求 1：聚焦跳转的四边动态留白（线路相对界面四边保留合理距离居中，
  // 线路面板显示时左侧边缘以线路面板为界）：
  //   上＝#topbar 底缘＋24；左＝#linePanel 可见时其右缘＋24、否则 64；
  //   下＝#focusBox 展开后的 offsetHeight＋24（syncFocusBox 已先显示，offsetHeight
  //        强制布局拿得到）；右＝#infoPanel 可见时其宽度＋24、否则 64。
  function focusPadding() {
    const GAP = 24, FALLBACK = 64;
    const topEl = $('topbar');
    const topRect = topEl ? topEl.getBoundingClientRect() : null;
    const top = topRect ? topRect.bottom + GAP : GAP;
    const lp = $('linePanel');
    const left = panelVisible(lp) ? lp.getBoundingClientRect().right + GAP : FALLBACK;
    const fb = $('focusBox');
    const bottom = fb && !fb.hidden ? fb.offsetHeight + GAP : GAP;
    const ip = $('infoPanel');
    const right = panelVisible(ip) ? ip.getBoundingClientRect().width + GAP : FALLBACK;
    return { top, bottom, left, right };
  }
  // 2026-11-22 主支线合并：双击支线线身等效双击主线——入口先归一到主线 id 再 toggle
  //（列表行已合并为主线行，支线 id 实际来源＝地图线身双击；pickEntry 走 setFocus 的
  // 条目 id 本就是主线）。
  function toggleFocus(lineId) {
    const main = S.lineGroups.mainOf.get(lineId) || lineId;
    setFocus(S.focus === main ? null : main);
  }
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
    // 2026-11-22 主支线合并：标题＝线组名称（S.focus＝主线 id；组名缺失时 buildLineGroups
    // 已退主线名）；内容照旧按主线 summary（其余以主线为准）
    const grp = S.lineGroups.ofLine.get(S.focus);
    $('focusTitle').textContent = grp ? grp.name : (sum.name || sum.lineId);
    const body = $('focusBody');
    body.textContent = '';
    infoRow(body, '类别', sum.layer || '未分类');
    infoRow(body, '分段状态', '既有 ' + sum.segCounts.existing + ' 段 · 已批复 ' + sum.segCounts.approved + ' 段 · 远期 ' + sum.segCounts.future + ' 段');
    infoRow(body, '车站数', String(sum.stopCount));
    infoRow(body, '起讫站', V.formatTerminals(sum));
    // 2026-11-22 晚改版：原右上线路信息面板退役，导出按钮迁到这里（.info-actions 样式
    // 全局类直接复用）；S.focus 恒主线 id（setFocus 入口归一），导出即导主线
    const bar = document.createElement('div');
    bar.className = 'info-actions';
    const bG = document.createElement('button');
    bG.textContent = '导出 GeoJSON';
    bG.addEventListener('click', () => exportLine(S.focus, 'geojson'));
    const bK = document.createElement('button');
    bK.textContent = '导出 KML';
    bK.addEventListener('click', () => exportLine(S.focus, 'kml'));
    bar.append(bG, bK);
    body.appendChild(bar);
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
    const groups = V.visibleListGroups(S.linesMap, V.HIDDEN_LIST_LAYERS, S.lineOrder, S.lineGroups);
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
  // pin 的所属线路显示列表：纯逻辑在 VIEWER_CORE.linesOfPin（2026-11-22 主支线合并——
  // 有效组成员一律显示组名、别名随主线、组 pin 去重），此处只喂本页权威结构与线组归并结果
  function linesOfPin(pin) {
    return V.linesOfPin(pin, S.linesMap, S.lineGroups);
  }
  //（2026-11-22 晚改版删除 openLinePanel：右上线路信息面板退役——线路点选改为直接聚焦，
  //   信息与导出按钮收敛到下方聚焦框 syncFocusBox；本 infoPanel 容器此后仅站点面板使用）
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
    // 2026-11-22 主支线合并：线路条目走 core 合并逻辑（有效组一个条目：text＝组名、
    // 主线与支线的 name＋aliases＋id 全部作为搜索词命中同一条目；支线无独立条目），
    // ref 回填主线 summary（displayOnly 定位兜底用）；车站条目照旧
    const ents = V.lineSearchEntries(S.linesMap, S.lineGroups).map((e) => {
      e.ref = S.summaries.get(e.id) || null;
      return e;
    });
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
      // 仅飞过去看（与地图点选/列表双击的「仅显示、无交互」裁定一致）——保持自带
      // fitBounds padding 80 定位。非「仅显示」级走 setFocus（2026-11-22 用户需求 1
      // 起聚焦自带动态留白跳转），不再单独 fitBounds——避免双重跳转。
      const line = S.linesMap.get(ent.id);
      const displayOnly = !!line && V.lineLayerRank(line) === 'displayOnly';
      if (displayOnly) {
        const bb = S.dispBbox.get(ent.id) || (ent.ref && ent.ref.bbox);
        if (bb) {
          S.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: 80, duration: 600, maxZoom: 13 });
        }
      } else {
        setFocus(ent.id);   // 2026-11-22 晚改版：原另开右上线路信息面板已删，聚焦即全部
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

  // ---------- 线路面板收起/展开（2026-11-22 用户需求） ----------
  // 收起＝藏 #linePanel、亮出左缘「线路」半出药丸 #linePanelTab；点药丸恢复面板。
  // ⚠ #linePanel 的 display:flex 会压过 UA 样式表的 [hidden]{display:none}，index.html 已
  // 显式补 #linePanel[hidden]{display:none}（legendPanel 注释同款坑），此处只管切 hidden。
  // 会话内不持久化，刷新回展开（与底图三态等 UI 态一致）。
  //（聚焦跳转 focusPadding() 运行时探测 linePanel 可见性，收起后左留白自动回 64，无需在此联动）
  function setLinePanelCollapsed(collapsed) {
    S.panelCollapsed = collapsed;
    $('linePanel').hidden = collapsed;
    $('linePanelTab').hidden = !collapsed;
  }

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
    syncPhaseUI();     // 与 S.phase 初始态（'none'）对齐：按钮文案「分期：无」
    syncNamesUI();     // 与 S.namesOn 初始态（true）对齐：按钮文案「站名：显示」
    syncBasemapUI();   // 与 S.basemap 初始态（'off'）对齐：按钮文案「底图：无」、署名隐藏
    $('infoClose').addEventListener('click', () => { $('infoPanel').hidden = true; });
    // 线路面板收起/展开（2026-11-22 用户需求）：面板头按钮收起、左缘药丸展开
    $('linePanelCollapse').addEventListener('click', () => setLinePanelCollapsed(true));
    $('linePanelTab').addEventListener('click', () => setLinePanelCollapsed(false));
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
    // 主支线线组归并（2026-11-22 用户裁定）：net/index.json lineGroups × line.groupId
    // 双向并集；无组信息（旧快照 @1）＝空结构，一切逐线独立＝旧行为
    S.lineGroups = V.buildLineGroups(S.linesMap, net.lineGroups || []);
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
