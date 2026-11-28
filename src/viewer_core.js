// viewer_core.js —— 阶段 3 查看器·纯逻辑层（2026-11-21）
// 不依赖 DOM / maplibre / editor.js：数据归一（线路聚合、站点平表、换乘组归并）、
// 搜索匹配、标签分级与可见性（全局开关/聚焦常显/调光隐藏/zoom 门槛）、单线导出
//（GeoJSON 对象 / KML 字符串）、调光纯逻辑（线路期次归类、调光线集计算）、
// 尺寸缩放冻结表达式构造、显示文案（起讫格式化、未名站占位）。
// 浏览器端挂 globalThis.VIEWER_CORE；node 端（tools/test_viewer_logic.js）走 module.exports。
// 数据契约：net/lines.geojson（每 feature＝线×分段）、net/stops.geojson（每 feature＝线×站）。
// 2026-11-21 增：出省箭头（stop.kind:'arrow'——非站，不进组/标签/摘要/导出；2026-11-22
// 改版后查看器不再画 glyph，arrow 站仅作 arrowFadePlan 的出省端判定输入）、
// ≥3 线同站组药丸链序（planGroupPillChain 贪心最近邻，与编辑器侧逐字节同规格）。
// 2026-11-22 增：GCJ02 显示变换三件套（outOfChina/wgs84ToGcj02＝src/geom.js 同源受控副本＋
// makeDispCoord 显示坐标工厂）——测试阶段底图（高德）对齐用，仅显示侧，权威数据不动。
// 2026-11-22 改版（用户八条指示）：渲染不再区分期次（删三档透明/远期虚线，导出同步纯色实线）、
// 分期四档＋聚焦双模式调光（computeDimmedSet）、标签可见性优先级（visibleLabels）、
// 普通站标签门槛 12→11、z<11 尺寸线性缩小（zoomInterp/scaledSize）、左栏类别过滤常量。
// 2026-11-22 增：联络线渐变接入端判定（connectorFadePlan——聚焦线绑定的联络线沿线渐变
// 透明，connects 无顺序语义、方向按几何最近端判；normalizeLines 同步保留 connects 字段）。
// 2026-11-22 增（用户需求 2「取消联络线颜色属性」）：connectorBlendPlan——有效联络线的
// 双端渐变取色（head/tailColor＝首/末端各自最近的目标线色，connects≥3 每端各取最近、
// 有效目标 <2 不出条目＝渲染层深灰兜底）；stopList/pinOfStop 保留 stroke 字段（flatten
// 产出的联络线站圈描边色＝最近端目标线色）。
// 2026-11-22 白罩定案（用户确认遮罩 70%、删全部对比开关与旧调光路径）：computeDimmedSet
// 的 hlMode 机制删除——聚焦不再贡献 dim（「全都不动」，高亮由渲染层白罩＋聚焦重画层呈现）；
// 分期与他省线恒调光照旧，focus 字段仅剩「调光场合激活位」一职（让他省线恒入调光集）。
// 2026-11-22 增（用户改版·出省箭头）：arrowFadePlan——按线内站序判定 arrow 站端属
//（首＝head/尾＝tail、非端点忽略），算 1km 渐变段的 line-progress 断点 cut（平面近似
// 总长、clamp [0,1]）；arrowFadeGradient——按端组合构造 line-gradient 渐变 stops 表达式。
// 2026-11-22 增（用户裁定·主支线合并）：一条线路的主线与支线在查看器眼中恒为一条线——
// buildLineGroups 双向并集归并（line.groupId 指向 ＋ 组记录 members；无 main 组防御不合并）、
// 列表合并行（layerGroups 增收 lineGroups——主线行显示名改组名、支线不出独立行）、组级
// 调光（computeDimmedSet 增收 lineGroups——期次/仅显示级以主线为准、聚焦豁免组全体成员）、
// 合并搜索条目（lineSearchEntries＋matchEntries 增 terms 附加搜索词——成员线名/别名/id 全
// 命中同一条目）、站牌组名显示（lineLabelOf/linesOfPin——组成员一律显组名，主/支线去重）；
// normalizeLines 同步保留 groupId 字段（net-index@2 的组信息与此双保险）。
// 2026-11-22 真机反馈改版：visibleLabels 恢复聚焦隐藏维度——聚焦时非聚焦线站名一律
// 隐藏、聚焦组成员（新入参 focusMembers 传成员线 id 数组，缺省退 [focus]）标签常显且
// 无视分期调光与 zoom 门槛（与渲染层站圈/药丸移罩下＋罩上复制配套，图形侧见 viewer.js）。
// 2026-11-22 真数据抓包（「单线站名不见了」）：删初版自设的 LABEL_CAP=800 与 cap 入参——
// 它数整份数据的标签总数而非同屏数，用户 58 线真数据 1040 个标签单元一超限，普通站名
// 就在一切 zoom 永不显示，与用户规则「普通站名 z≥11 显示」冲突；分级回归纯 zoom 门槛。
// 2026-11-23 增（用户裁定·嵌套换乘组）：换乘组可再把另一个组当成员（net-index@3 的 stationGroups
// 结构表，parseNetIndex 解读）。buildGroupTree 树化（查组/父组/子组/最外层组/叶站；未知子组、
// 成环、无站组防御）；buildStopView 改按「节点＝最外层组」出图——同站单元全部叶站合成一个符号
//（内层组不单独出图形与站名）、出闸单元直属站各自成圈＋各子组自成绘制单元递归套用、junction
// 成员递归取全部叶站；药丸线数改按逻辑线计（logicalLineCount：联络线不计、同一线组算一条，一切
// 同站单元适用）；groupRelations 嵌套关系描述（信息面板用；平铺组返回 null＝面板呈现不变）；
// 单线导出可选补嵌套节点信息。平铺数据下 pins/pills/labels 与旧版逐项一致（单测＋真数据对拍）。
// 2026-11-23 增：线路信息面板（parseLineInfo——lineinfo.md 用户手填的每线路介绍解析为
// { fields, bodyHtml, links }；轻量 md→HTML 白名单标签、一切文本先转义再标记替换、
// 链接 URL 只放行 http/https/相对路径，见该节注）。同日放宽节绑定＝「线组 id 或线 id」
//（lineInfoEntryOf 解析：有组线组节优先、查不到落线自身 id——没建组的单线同样能写介绍）。
// 2026-11-27 增：点击车站内核（isStopHitLayerId 站圈/药丸命中层判定；stationLinesOf/
// stationFocusOf 站·组→自然线路集合与车站页数据——联络线剔除〔只亮不列名〕、他省线
// 保留〔修正裁定〕、主支线算一条、lineOrder 排序、一站多名 calls 收集；focusBboxOfSet
// 多线取景 bbox〔各高亮线组员并集 ∪ 绑定联络线，focusBboxOf 同源口径〕）。
// 2026-11-27 增：线路页车站列表（lineStopSections——主线＋支线站序分段模型：stopIndex
// 站序含 arrow 行、支线/联络线接入位置＝junction 组精确〔对方站行〕＋几何投影近似〔端点
// 投影到成员线，≤150m 归站、否则行间——block 线路所 flatten 已剔除只能几何兜底，approx
// 标记〕；stopNodeGlyph 节点形态＝地图 buildStopView 同规则列表版；联络线自身名称绝不
// 进模型——标注只写「联络〈对方自然线路名〉」＋对方主线色）。
// 2026-11-28 增：环线与共线在车站列表的表达（normalizeLines 保留线级 sharedTracks
// 透传声明；lineStopSections 增 section.loop 与 row.shared——sharedTrackRowRange 纯函数
// ＝flatten shared_track_decls 同构的站区间口径：非环闭区间/环线沿站序前进弧跨环绕、
// 两端边界站含在内；对方线归一主线、组名优先主线色，共线≠换乘但取名取色同口径）。

(function (G) {
  'use strict';

  // ---------- 常量（结构字段与枚举全英文；中文仅显示文案） ----------
  // 2026-11-22 用户改版：渲染不再区分期次，三档透明/远期虚线全删。旧 SEG_STATUS_OPACITY
  //（existing 1 / approved .5 / future .85，编辑器画布同值）的「默认显示三档」使命终结，
  // 调光取值由它演化：DIM_OPACITY 沿用其中「已批复 0.5」作统一半透明系数（占位参数，
  // 用户目验后可调）。
  const DIM_OPACITY = 0.5;
  // 分段状态合法性名单＋线路期次归类的优先级（越大越「先进」）：线路期次＝全线最先进段
  //（existing ＞ approved ＞ future；既有线的远期延伸整线归「既有」——推定待用户确认）
  const SEG_STATUS_RANK = { existing: 3, approved: 2, future: 1 };
  const DEFAULT_LINE_COLOR = '#888888';
  const GROUP_TYPE_ZH = { 'same-station': '同站换乘', 'out-of-station': '出闸换乘', junction: '接轨站' };
  const ROLE_ZH = { main: '主线', branch: '支线', connector: '联络线', standalone: '独立线' };
  const SEG_STATUS_ZH = { existing: '既有', approved: '近期', future: '远期' };
  // 分期四档循环（顶栏按钮）：无 → 既有 → 已批复 → 远期 → 无
  const PHASE_CYCLE = ['none', 'existing', 'approved', 'future'];
  const PHASE_LABEL_ZH = { none: '无', existing: '既有', approved: '近期', future: '远期' };
  // 左栏线路列表隐藏的类别（2026-11-22 用户裁定：仅「联络线」隐藏；地图照画、搜索照收）
  const HIDDEN_LIST_LAYERS = ['联络线'];
  // 「仅显示」级类别（2026-11-22 用户裁定：他省线）——列表双击不聚焦、地图点选不开面板、
  // 一切调光场合（分期非「无」档/任何聚焦）恒在半透明侧（即便期次恰好匹配）
  const DISPLAY_ONLY_LAYERS = ['他省'];
  // 虚线渲染类别（2026-11-23 用户需求：预控通道画虚线）——分类判断集中于此（与上面两份
  // 名单同款集中式，勿散落 if）；命中类别的线特征带 dash 0/1 位，渲染层据此分虚实两层
  //（viewer.js corridorLineLayerDef）。
  const DASHED_LAYERS = ['预控通道'];
  // 线身渲染层 id 名单（2026-11-27 地图单击聚焦）：静态两层＋罩上重画/他省接管层＋动态
  // 渐变层族前缀（arrow-fade-*/conn-blend-*/conn-fade-*，分期拆段的 -seg- 变体天然被
  // 前缀匹配）。站圈/药丸/省界/白罩/底图不在内——点车站无操作（demo 裁定不变）。
  const LINE_HIT_LAYER_IDS = ['lines', 'lines-dash', 'lines-displayonly', 'focus-copy', 'focus-copy-dash'];
  const LINE_HIT_LAYER_PREFIXES = ['arrow-fade-', 'conn-blend-', 'conn-fade-'];
  // 标签只按 zoom 门槛分级，**不设标签总数上限**。组/换乘标签含出闸换乘成员，z≥10 渐显；
  // 普通单线站 z≥11 渐显，同屏数量由渲染层视口裁剪约束。
  const LABEL_ZOOM_GROUP = 10;  // 换乘组及出闸换乘标签最低 zoom
  const LABEL_ZOOM_STOP = 11;   // 普通单线站标签最低 zoom

  // 尺寸随缩放等比变化（2026-11-22 用户两次裁定：初次线性缩小案被推翻，改「等比缩＋向上封顶」）：
  // z≥SIZE_ZOOM_HOLD 各尺寸维持基准值（拉近不再变粗——封顶）；z<11 按 2^(z−11) 持续等比缩小
  //（每拉远一级减半，与画布同比例——「肉眼随画布缩小」），无下限地板（远景元素极小防结块；
  // 表达式低端锚 SIZE_ZOOM_MIN 以下恒为锚值——MapLibre interpolate 原生 clamp，锚值已趋近不可见）。
  // z=11 与普通站名门槛一致（用户指定）。
  const SIZE_ZOOM_MIN = 5;
  const SIZE_ZOOM_HOLD = 11;
  const SIZE_SCALE_EXP = 2;

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

  // ---------- 移动端视口纯逻辑（2026-11-28 移动端适配第一批） ----------
  // 断点 768：视口宽 <768（CSS 像素）＝移动端（index.html @media (max-width: 767px) 同值；
  // 768px 平板竖屏归桌面——295px 左侧面板在该宽度仍可用）。运行时判定走胶水层 matchMedia
  //（响应即时），本函数给单测与 JS/CSS 断点一致性锚点。
  const MOBILE_BREAKPOINT = 768;
  function viewportIsMobile(width) {
    return Number.isFinite(width) && width > 0 && width < MOBILE_BREAKPOINT;
  }
  // 站名标签移动端整体放大一档的乘数（复用 labelScale 机制：zf = labelScale(zoom) × 本乘数；
  // 12px→15px、13px→16.25px）。桌面端不乘（桌面回归零改动）。
  const MOBILE_LABEL_SCALE = 1.25;
  // bottom sheet 三档标准高度（px）：hidden＝只露把手（把手条高度，胶水层 CSS 常量同值）；
  // half＝视口一半（四舍五入）；full＝整个视口高。viewportH/handleH 非法输入返回 null（调用方兜底）。
  function sheetSnapHeights(viewportH, handleH) {
    if (!Number.isFinite(viewportH) || viewportH <= 0 || !Number.isFinite(handleH) || handleH <= 0) return null;
    return { hidden: handleH, half: Math.round(viewportH / 2), full: Math.round(viewportH) };
  }
  // 松手吸附：取距当前高度最近的档（等距平手按 hidden→half→full 定义序先到先得——
  // 下拉略过半即吸 half 的手感由「就近」保证，平手罕见不刻意偏置）。heights 缺档跳过、
  // 全缺/非法高度返回 null（调用方保持原档）。
  function nearestSheetSnap(height, heights) {
    if (!Number.isFinite(height) || !heights) return null;
    let best = null, bestDist = Infinity;
    for (const key of ['hidden', 'half', 'full']) {
      const v = heights[key];
      if (!Number.isFinite(v)) continue;
      const d = Math.abs(height - v);
      if (d < bestDist) { bestDist = d; best = key; }
    }
    return best;
  }

  // ---------- GCJ02 偏移（测试阶段底图·高德对齐用） ----------
  // ⚠ 与 src/geom.js 同源复制，测试阶段功能，勿单侧改动——查看器不能引 geom.js 整模块
  //（那会把编辑器几何库带进 Pages 部署面），故留受控副本；两份副本漂移由
  // tools/test_viewer_logic.js 的 geom.js 对拍守卫兜住（改一处必跑该测试同步另一处）。
  // 国测局加偏为公开近似式，单向：WGS84 → GCJ02（无精确逆式，本项目也用不到逆）。
  // 克拉索夫斯基椭球长半轴 a=6378245、第一偏心率平方 ee=0.00669342162296594323。
  const GCJ_A = 6378245.0;
  const GCJ_EE = 0.00669342162296594323;
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
  /** 中国境外判定（算法自带的粗略界守卫；true = 境外，恒等无偏移） */
  function outOfChina(lon, lat) {
    return !(lon > 72.004 && lon < 137.8347 && lat > 0.8293 && lat < 55.8271);
  }
  /** WGS84 → GCJ02：返回 [lon, lat]；境外或非有限输入恒等返回 */
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

  // 显示坐标变换工厂（测试阶段底图）：'none'|'osm'|'carto' → 恒等（OSM 与 CARTO 瓦片均
  // WGS84 与数据同基准，恒等直叠；CARTO＝Positron 无字版，2026-11-23 接入）；
  // 'gaode' → wgs84ToGcj02 包装（高德瓦片为 GCJ02，对齐＝仅显示用坐标做偏移——境外点恒等
  // 由 outOfChina 在 wgs84ToGcj02 内部处理）。⚠ 只喂渲染/标签定位/相机定位等显示侧；
  // 权威数据（linesMap/stops/摘要/搜索索引/导出）一律不过此函数。未知 mode 兜恒等（防御）。
  function makeDispCoord(mode) {
    if (mode === 'gaode') return (lon, lat) => wgs84ToGcj02(lon, lat);
    return (lon, lat) => [lon, lat];
  }

  // ---------- 视口经纬读数尺纯逻辑 ----------
  function niceTickStep(span, pixels, targetPx) {
    const raw = Math.abs(span) * targetPx / Math.max(1, pixels);
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    const power = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / power;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
  }
  function formatCoordinate(value, axis, step) {
    if (!Number.isFinite(value)) return '';
    const digits = Math.min(7, Math.max(0, -Math.floor(Math.log10(Math.abs(step) || 1))));
    const rounded = Number(Math.abs(value).toFixed(digits));
    let hemisphere;
    if (axis === 'lon') hemisphere = rounded === 0 || value >= 0 ? 'E' : 'W';
    else hemisphere = rounded === 0 || value >= 0 ? 'N' : 'S';
    return `${rounded.toFixed(digits)}°${hemisphere}`;
  }
  function edgeTickPositions(samples, values) {
    const positions = [];
    for (const value of values) {
      const hits = [];
      for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1];
        const b = samples[i];
        if (a.value === b.value || (value - a.value) * (value - b.value) > 0) continue;
        const t = a.t + (b.t - a.t) * (value - a.value) / (b.value - a.value);
        hits.push(t);
      }
      for (const t of hits) {
        const alreadyAdded = positions.some((position) =>
          position.value === value && Math.abs(position.t - t) < 1e-5);
        if (!alreadyAdded) positions.push({ value, t });
      }
    }
    return positions.sort((a, b) => a.t - b.t);
  }
  function coordinateTicks(min, max, step) {
    if (![min, max, step].every(Number.isFinite) || step <= 0) return [];
    const lo = Math.ceil(min / step - 1e-10);
    const hi = Math.floor(max / step + 1e-10);
    const ticks = [];
    for (let i = lo; i <= hi && ticks.length < 500; i++) {
      ticks.push(Number((i * step).toPrecision(12)));
    }
    return ticks;
  }

  function gcj02ToWgs84(lon, lat) {
    if (outOfChina(lon, lat)) return [lon, lat];
    let x = lon;
    let y = lat;
    for (let i = 0; i < 8; i++) {
      const transformed = wgs84ToGcj02(x, y);
      x -= transformed[0] - lon;
      y -= transformed[1] - lat;
    }
    return [x, y];
  }

  // ---------- 数据归一 ----------
  // lines.geojson → Map<lineId, line>；line.segments 按升序（稳定），
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
          // 联络线接轨对象线 id 列表（2026-11-22 用户需求 3：聚焦渐变高亮用）——
          // flatten 侧每段 feature 均带同值，此处首段建 line 对象时取一次即可
          connects: Array.isArray(p.connects) ? p.connects.filter((s) => typeof s === 'string' && s) : [],
          // 线组归属（2026-11-22 主支线合并）：flatten 每段 feature 均带同值（无组为空串，
          // 保持键齐——沿用 connects 的做法），首段建 line 对象时取一次；组名/成员并集
          // 在 buildLineGroups 与 net/index.json lineGroups 汇算
          groupId: typeof p.groupId === 'string' ? p.groupId : '',
          // 共线共轨声明（2026-11-28 线路页车站列表「与对方线共线」标注）：flatten 线级
          // 原样透传（每段 feature 同值，首段取一次）；结构防御过滤（peer 字符串、stops
          // 恰 2 个字符串——validate 是门禁，此处只兜脏数据），范围换算在 lineStopSections
          sharedTracks: Array.isArray(p.sharedTracks)
            ? p.sharedTracks
                .filter((sh) => sh && typeof sh.peer === 'string' && sh.peer
                  && Array.isArray(sh.stops) && sh.stops.length === 2
                  && sh.stops.every((s) => typeof s === 'string' && s))
                .map((sh) => ({ peer: sh.peer, stops: sh.stops.slice() }))
            : [],
          segments: [],
        };
        out.set(id, line);
      }
      line.segments.push({
        segIndex: Number.isFinite(p.segIndex) ? p.segIndex : line.segments.length,
        segStatus: Object.prototype.hasOwnProperty.call(SEG_STATUS_RANK, p.segStatus) ? p.segStatus : 'future',
        // 共线段双平行线偏移（2026-11-27 方案 A）：flatten 产出的可选属性 sharedOffset
        //（像素，仅共线范围内的小段携带；普通段缺省 0——渲染层 line-offset 数据驱动，
        // 导出/几何一律用 coords 原始坐标、offset 只影响屏幕画法）
        sharedOffset: Number.isFinite(p.sharedOffset) ? p.sharedOffset : 0,
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

  // ---------- 线组归并（2026-11-22 用户裁定：主线与支线在查看器眼中恒为一条线） ----------
  // buildLineGroups(linesMap, lineGroups)：lineGroups＝net/index.json 的 lineGroups 数组
  // （flatten 产出 {id,name,mainId,members}）。归属判定＝双向并集：组记录 members 列表
  // ＋ line.groupId 指向该组的线（两形态并存于真实数据：有的组 members 为空、仅靠
  // line.groupId 关联），去重且仅收 linesMap 已有线（归档线 flatten 已剔除，防御性再滤）。
  // 组内主线＝并集成员中 role==="main" 的第一个（members 声明序优先，groupId 方向按
  // linesMap 迭代序）；无 main 成员的组不合并——各组员照旧独立显示（防御：脏数据不吞线）。
  // connectors（联络线）与 displayOnly（他省线）若被录进组也按同一规则合并（现实罕见，
  // 防御即可）；组名缺失退主线名（不擅自造名）。孤儿 groupId（指向不存在的组记录）无法
  // 得知组名，不合并（保持独立显示）。
  // 返回 {groups:[{id,name,mainId,members}], ofLine:Map<lineId,组对象>, mainOf:Map<非主线成员,主线id>}；
  // 无组信息（旧快照 net-index@1）＝空结构，一切逐线独立＝旧行为。
  function buildLineGroups(linesMap, lineGroups) {
    const lookup = linesMap instanceof Map ? linesMap
      : (Array.isArray(linesMap)
        ? new Map(linesMap.filter(Boolean).map((l) => [String(l.lineId), l])) : null);
    const groups = [], ofLine = new Map(), mainOf = new Map();
    if (!lookup || !Array.isArray(lineGroups)) return { groups, ofLine, mainOf };
    for (const g of lineGroups) {
      if (!g) continue;
      const gid = g.id != null ? String(g.id) : '';
      if (!gid) continue;
      const seen = new Set();
      const members = [];
      const pushMember = (lid) => {
        const k = lid != null ? String(lid) : '';
        if (!k || seen.has(k) || !lookup.has(k)) return;
        seen.add(k); members.push(k);
      };
      for (const m of Array.isArray(g.members) ? g.members : []) pushMember(m);   // 方向一：members 列表
      for (const line of lookup.values()) {                                       // 方向二：line.groupId 指向
        if (line && line.groupId === gid) pushMember(line.lineId);
      }
      let mainId = null;
      for (const m of members) {
        if (lookup.get(m).role === 'main') { mainId = m; break; }
      }
      if (mainId == null) continue;   // 无 main 不合并（防御：组员照旧独立显示）
      const mainLine = lookup.get(mainId);
      const obj = {
        id: gid,
        // 组名以记录为准；记录未命名时退主线名（name/lineId 均为主线已有命名，非新造）
        name: typeof g.name === 'string' && g.name ? g.name : (mainLine.name || mainId),
        mainId, members,
      };
      groups.push(obj);
      for (const m of members) { ofLine.set(m, obj); if (m !== mainId) mainOf.set(m, mainId); }
    }
    return { groups, ofLine, mainOf };
  }

  // ---------- net/index.json 解读（fmt 严格校验；2026-11-23 增 net-index@3） ----------
  // parseNetIndex(idx)：三版都收 lineOrder（线路自定义显示序）；@2/@3 收 lineGroups（主支线合并）；
  // @3 另收 stationGroups（嵌套换乘组结构表，buildGroupTree 的输入）。校验风格沿用旧胶水层：
  // fmt 不在名单内＝整份 index 视同不存在（全 null）；字段类型不符＝该字段视同不存在。
  // 唯一例外＝@3 的 stationGroups 非数组：数据契约被破坏（嵌套组会被画成平铺），置 null 之外
  // 另以 problem 带回一句提示交胶水层 console.warn（不抛——启动期抛错＝整页黑屏）。
  // 返回 { indexOrder: [lineId]|null, lineGroups: []|null, stationGroups: []|null, problem: ''|提示 }。
  function parseNetIndex(idx) {
    const out = { indexOrder: null, lineGroups: null, stationGroups: null, problem: '' };
    const fmt = idx && typeof idx === 'object' ? idx.fmt : null;
    if (fmt !== 'net-index@1' && fmt !== 'net-index@2' && fmt !== 'net-index@3') return out;
    if (Array.isArray(idx.lineOrder)) out.indexOrder = idx.lineOrder.map(String);
    if (fmt !== 'net-index@1' && Array.isArray(idx.lineGroups)) out.lineGroups = idx.lineGroups;
    if (fmt === 'net-index@3') {
      if (Array.isArray(idx.stationGroups)) out.stationGroups = idx.stationGroups;
      else out.problem = 'fmt=net-index@3 但 stationGroups 不是数组，按无嵌套（各组顶层）处理';
    }
    return out;
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
        ...(Number.isInteger(p.stopIndex) && p.stopIndex >= 0 ? { stopIndex: p.stopIndex } : {}),
        groupId: p.groupId != null && p.groupId !== '' ? String(p.groupId) : null,
        groupType: Object.prototype.hasOwnProperty.call(GROUP_TYPE_ZH, p.groupType) ? p.groupType : null,
        kind: typeof p.kind === 'string' && p.kind ? p.kind : 'stop',
        ...(['existing', 'approved', 'future'].includes(p.stopStatus) ? { stopStatus: p.stopStatus } : {}),
        // 联络线站的描边色（2026-11-22 用户需求 2：flatten 产出＝最近端目标线色，
        // 仅 connector 线的站携带；其余站 null——渲染层退线色）。中转字段不参与
        // 任何几何/组归并逻辑
        stroke: typeof p.stroke === 'string' && p.stroke ? p.stroke : null,
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

  // ---------- 出省渐变计划（2026-11-22 用户改版：查看器以线身末端渐隐示意出省） ----------
  // arrowFadePlan(linesMap, stops)：对每条线找 stops 中 kind==='arrow' 的设站，按其在该线
  // 站序中的位置判端——站序＝该线全部设站（arrow 一并参与排序）按 t 升序、t 缺失排最后
  //（与 lineSummaries 同口径）：排首＝head 端（t≈0 侧）、排尾＝tail 端（t≈1 侧）；非首非尾
  // 的 arrow 忽略（防御：schema 上 arrow 只应设在端点）。t 缺失的站排最后——arrow 无 t 时
  // 天然落到尾位＝按 tail 端处理（防御性归位，现实数据 arrow 恒有 t）。站序与几何坐标序的
  // 一致性由编辑器数据保证（本函数从简：端属只看站序）。
  // 渐变段长恒 1km（ARROW_FADE_M）：cut＝ARROW_FADE_M / 全线平面近似总长——沿线逐段累积
  // dLat×111320m、dLng×111320×cos(lat0)，lat0＝全线首末有效点纬度均值（与
  // connectorFadePlan 的 planarOf 近似同档精度），clamp 到 [0,1]：线总长短于 1km 时该端
  // cut＝1＝整线渐变。无有效坐标或总长 ≤0 的线不出条目（防御）；无 arrow 的线不进 plan。
  // 返回 [{lineId, headCut, tailCut}]——对应端无 arrow 时该字段为 null。
  const ARROW_FADE_M = 1000;
  const M_PER_DEG_LAT = 111320;
  function arrowFadePlan(linesMap, stops) {
    const out = [];
    if (!(linesMap instanceof Map)) return out;
    const byLine = new Map();
    for (const s of Array.isArray(stops) ? stops : []) {
      if (!s || s.lineId == null) continue;
      const k = String(s.lineId);
      if (!byLine.has(k)) byLine.set(k, []);
      byLine.get(k).push(s);
    }
    const byT = (a, b) => (a.t == null ? 1 : 0) - (b.t == null ? 1 : 0) || num(a.t) - num(b.t);
    for (const line of linesMap.values()) {
      if (!line || line.lineId == null) continue;
      const sts = (byLine.get(String(line.lineId)) || []).slice().sort(byT);
      if (!sts.length) continue;
      const headArrow = sts[0].kind === 'arrow';
      const tailArrow = sts[sts.length - 1].kind === 'arrow';
      if (!headArrow && !tailArrow) continue;
      // 全线有效坐标（normalizeLines 已保证 segments 按 segIndex 升序）→ 参考纬度＋总长
      const pts = [];
      for (const seg of line.segments || []) {
        for (const pt of (seg && seg.coords) || []) {
          if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) pts.push(pt);
        }
      }
      if (pts.length < 2) continue;   // 无有效几何 → 渐变线无从画（不出条目）
      const lat0 = (pts[0][1] + pts[pts.length - 1][1]) / 2;   // 全线首末纬度均值
      const kLng = M_PER_DEG_LAT * Math.cos(lat0 * Math.PI / 180);
      let total = 0;
      for (let i = 1; i < pts.length; i++) {
        total += Math.hypot((pts[i][0] - pts[i - 1][0]) * kLng,
          (pts[i][1] - pts[i - 1][1]) * M_PER_DEG_LAT);
      }
      if (!(total > 0)) continue;   // 总长 0/NaN（防御）
      const cut = Math.min(1, ARROW_FADE_M / total);
      out.push({ lineId: String(line.lineId), headCut: headArrow ? cut : null, tailCut: tailArrow ? cut : null });
    }
    return out;
  }

  // arrowFadeGradient(color, headCut, tailCut)：按端组合构造 line-gradient 的渐变 stops
  // 表达式（line-progress 0→1；调用方＝渲染层 arrow-fade 动态层）。c＝线色（normalizeHex
  // 兜底默认灰），fade＝同色 alpha 0：
  //   仅 tail：[0, c, 1−t, c, 1, fade]（中段恒色、尾端渐隐）；
  //   仅 head：[0, fade, h, c, 1, c]（首端自渐隐起、中段恒色）；
  //   两端：[0, fade, h, c, 1−t, c, 1, fade]。
  // 边界防御（MapLibre interpolate 的 stop 输入必须严格递增，重键＝层级校验失败被静默
  // 弃载——本项目血泪教训同类）：单端 cut≥1（线总长短于 1km＝整线渐变）收成两 stop 形式；
  // 双端渐变段重叠（h＋t＞1，短于 1km 且两端均 arrow）按比例收缩保升序；恰衔接（和＝1）
  // 时中段退化并段。两端均 null → null（调用方跳过建层）。
  function arrowFadeGradient(color, headCut, tailCut) {
    const cl = (v) => Math.min(1, Math.max(0, Number(v)));
    const h = headCut == null ? null : cl(headCut);
    const t = tailCut == null ? null : cl(tailCut);
    if (h == null && t == null) return null;
    const hex = normalizeHex(color) || '#888888';
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const fade = 'rgba(' + r + ',' + g + ',' + b + ',0)';
    const I = ['interpolate', ['linear'], ['line-progress']];
    if (t == null) {
      if (h >= 1) return I.concat([0, fade, 1, hex]);                    // 整线渐变（<1km）
      return I.concat([0, fade, h, hex, 1, hex]);
    }
    if (h == null) {
      if (t >= 1) return I.concat([0, hex, 1, fade]);                    // 整线渐变（<1km）
      return I.concat([0, hex, 1 - t, hex, 1, fade]);
    }
    let hh = h, tt = t;
    if (hh + tt > 1) { const s = 1 / (hh + tt); hh *= s; tt *= s; }      // 重叠按比例收缩（保升序）
    if (1 - tt <= hh) return I.concat([0, fade, hh, hex, 1, fade]);      // 恰衔接：中段退化并段
    return I.concat([0, fade, hh, hex, 1 - tt, hex, 1, fade]);
  }

  // ---------- 嵌套换乘组结构（2026-11-23 用户裁定：换乘组可再把另一个组当成员） ----------
  // 数据契约：net/index.json（fmt net-index@3）顶层 stationGroups＝[{id, type, stops, groups}]——
  // groups＝子组 id 列表（缺省 []；type 可为 null；表内可含当前没有任何输出站点的组，如成员线
  // 已归档、全线路所组被上游剔除）。站 feature 的 groupId/groupType 仍＝直属组（不变）。
  // 旧产物（net-index@1/@2 无 stationGroups）传 null＝全部组都是顶层、无子组＝现行行为。
  // 成员归属一律取站 feature 的 groupId（直属组），结构表只提供层级与类型：站指向了、表里却
  // 没有的组＝合成一条记录（类型取首个成员站的 groupType；被某父组声明则挂其下，否则顶层）
  // ——站点不因表缺漏而丢；表里列了、却没有站指向它的组＝无成员，不出图形。
  // buildGroupTree(stationGroups, stops) → tree：
  //   order           全部组 id 的稳定序＝按「子树首个叶站在站表中的下标」升序（无叶站者排最后、
  //                   按 id 序）——与旧实现 byGroup 的插入序同构（平铺数据下 pins/labels 逐项同序）
  //   group(id)       组记录 {id, type, children, parentId}｜未知 id → null
  //   typeOf(id)      有效类型（未知/null → 'same-station'，沿用旧代码对 null 的处理）
  //   parentOf(id)    父组 id｜null（一子至多一父：多父脏数据取表序首个声明它的父）
  //   childrenOf(id)  子组 id 列表（声明序去重，只收「父组确为本组」者——与 parentOf 自洽）
  //   rootOf(id)      最外层组 id｜null（未知 id → null）
  //   subtreeIds(id)  自身＋全部子孙组 id（深度优先、每组至多一次——防重复声明/防环）
  //   directStops(id) 直属站数组（站表序；arrow 非站不入）
  //   leafStops(id)   全部叶站＝子树各组的直属站（站表序＝旧「成员序」，均值/链序/取名沿用旧算法）
  // 防御：成环（A∋B∋A）时 rootOf 取环上 id 最小者当根——环上各组仍只出一套图形、站不丢；
  // 表条目/类型/子组引用逐项判型，脏项跳过不抛（启动期抛错＝整页黑屏）。
  function buildGroupTree(stationGroups, stops) {
    const byId = new Map();       // id → {id, type, shape, children:[id], parentId:id|null, listed, typed}
    const tableOrder = [];        // 表内组 id（表序）
    const ensure = (id) => {
      let n = byId.get(id);
      if (!n) { n = { id, type: null, shape: null, children: [], parentId: null, listed: false, typed: false }; byId.set(id, n); }
      return n;
    };
    // ① 表内记录（重复 id 首条为准；type 非字符串按 null；groups 非数组按缺省 []）
    const listed = [];
    for (const g of Array.isArray(stationGroups) ? stationGroups : []) {
      if (!g || typeof g !== 'object' || g.id == null) continue;
      const id = String(g.id);
      if (!id) continue;
      const n = ensure(id);
      if (n.listed) continue;
      n.listed = true;
      n.type = typeof g.type === 'string' ? g.type : null;
      // shape（2026-11-23）：显式画法强制，现行仅同站组的 "pill"（平行线双线站大圆悬浮对策）；
      // 其他值按无强制处理（validate 门禁另行报错）
      n.shape = g.shape === 'pill' ? 'pill' : null;
      listed.push([n, Array.isArray(g.groups) ? g.groups : []]);
      tableOrder.push(id);
    }
    // ② 父子关系：子组至多一个父——多父脏数据取表序首个声明它的父；自指忽略
    for (const [n, refs] of listed) {
      for (const raw of refs) {
        if (raw == null) continue;
        const c = String(raw);
        if (!c || c === n.id) continue;
        ensure(c);
        if (n.children.indexOf(c) < 0) n.children.push(c);
        const cn = byId.get(c);
        if (cn.parentId == null) cn.parentId = n.id;
      }
    }
    // ③ 站表：直属站归组；站指向了、表里却没有的组＝合成记录（类型取首个成员站的 groupType）
    const direct = new Map();     // groupId → 直属站数组（站表序）
    const idxOf = new Map();      // sid → 站表下标
    const list = Array.isArray(stops) ? stops : [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s) continue;
      if (s.sid != null && !idxOf.has(s.sid)) idxOf.set(s.sid, i);
      const gid = s.groupId != null && s.groupId !== '' ? String(s.groupId) : null;
      if (s.kind === 'arrow' || !gid) continue;   // arrow 非站不入组（同 buildStopView）
      let arr = direct.get(gid);
      if (!arr) { arr = []; direct.set(gid, arr); }
      arr.push(s);
      const n = ensure(gid);
      if (!n.listed && !n.typed) { n.type = s.groupType || null; n.typed = true; }
    }
    const group = (id) => byId.get(id) || null;
    // 有效类型：未知/null → 'same-station'（沿用旧代码对 null 的处理）
    const typeOf = (id) => {
      const n = byId.get(id);
      return n && Object.prototype.hasOwnProperty.call(GROUP_TYPE_ZH, n.type) ? n.type : 'same-station';
    };
    const parentOf = (id) => { const n = byId.get(id); return n ? n.parentId : null; };
    // 子组列表只收「父组确为本组」者——与 parentOf 自洽（多父脏数据下子组不重复出图）
    const childrenOf = (id) => {
      const n = byId.get(id);
      return n ? n.children.filter((c) => byId.get(c).parentId === id) : [];
    };
    // 最外层组：沿父链上溯到头。成环（A∋B∋A）时取环上 id 最小者当根——环上各组仍只出一套
    // 图形、站不丢；未知 id → null
    function rootOf(id) {
      if (!byId.has(id)) return null;
      const path = [], seen = new Set();
      let cur = id;
      while (cur != null) {
        if (seen.has(cur)) return path.slice(path.indexOf(cur)).reduce((a, b) => (a < b ? a : b));
        seen.add(cur); path.push(cur);
        const n = byId.get(cur);
        cur = n && n.parentId != null && byId.has(n.parentId) ? n.parentId : null;
      }
      return path[path.length - 1];
    }
    // 自身＋全部子孙组（深度优先、每组至多一次——防重复声明/防环）
    function subtreeIds(id) {
      const out = [];
      const walk = (g) => {
        if (out.indexOf(g) >= 0) return;
        out.push(g);
        for (const c of childrenOf(g)) walk(c);
      };
      if (byId.has(id)) walk(id);
      return out;
    }
    const directStops = (id) => direct.get(id) || [];
    // 叶站＝子树各组的直属站，按站表序（＝旧实现的成员序：均值/取名/药丸链序沿用旧算法）
    const leafStops = (id) => {
      const out = [];
      for (const g of subtreeIds(id)) { const arr = direct.get(g); if (arr) for (const s of arr) out.push(s); }
      return out.length > 1 ? out.sort((a, b) => num(idxOf.get(a.sid)) - num(idxOf.get(b.sid))) : out;
    };
    // 稳定序＝按「子树首个叶站的站表下标」升序（无叶站者排最后、按 id 序）——与旧实现 byGroup
    // 的插入序同构（平铺数据下 pins/labels 逐项同序，标签叠放次序不因结构表而变）
    const order = [...byId.keys()]
      .map((id) => { const lf = leafStops(id); return { id, at: lf.length ? num(idxOf.get(lf[0].sid)) : Infinity }; })
      .sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((x) => x.id);
    return { byId, order, group, typeOf, parentOf, childrenOf, rootOf, subtreeIds, directStops, leafStops };
  }

  // ---------- 逻辑线数（药丸线数口径；2026-11-23 用户裁定「支线算一条，联络线不算线」） ----------
  // logicalLineCount(lineIds, linesMap, lineGroups)：按逻辑线去重计数——role === 'connector' 的线
  // 不计（联络线不算线）；同一有效线组（buildLineGroups 的 ofLine 归并——主线＋支线）内的线算
  // 一条；其余线各算一条。适用于一切 same-station 单元（含不嵌套的普通同站组），取代旧「按
  // distinct lineId 计」。linesMap 缺省、或线不在其中（孤站，角色未知）＝按独立一条计；
  // lineGroups 缺省＝不归并。
  function logicalLineCount(lineIds, linesMap, lineGroups) {
    const lg = lineGroups && lineGroups.ofLine instanceof Map ? lineGroups : null;
    const keys = new Set();
    for (const raw of Array.isArray(lineIds) ? lineIds : []) {
      const id = raw != null ? String(raw) : '';
      if (!id) continue;
      const line = linesMap instanceof Map ? linesMap.get(id) : null;
      if (line && line.role === 'connector') continue;
      const grp = lg ? lg.ofLine.get(id) : null;
      keys.add(grp ? 'g:' + grp.id : 'l:' + id);
    }
    return keys.size;
  }

  // 换乘组归并 + 渲染/标签视图（2026-11-23 改嵌套组规则；平铺数据下输出与旧版逐项一致）：
  //   节点＝最外层组（没有上级的组），画法由节点 type 决定；出闸节点的每个子组自成绘制单元、
  //   按它自己的 type 递归套用本规则。
  //   pins —— circle 图层的渲染与点击单元：
  //     无组站：kind 'stop'（白填充、线色描边）；
  //     same-station 单元（type null 同此）：全部叶站合成一个——逻辑线 ≥3 改画药丸（见 pills），
  //       否则合并一个「大圈」（叶站坐标均值，big=true，黑边）；内层组不单独出图形；
  //     上级组（带子组的同站／接轨单元，2026-11-23 用户裁定「无论有几个站圆都按多线站生成药丸」）：
  //       一律药丸、不论线数；
  //     junction 单元（平铺）：合并普通尺寸圈（big=false 不放大——接轨站不出大圈；描边色由渲染层按
  //       成员线角色优先级取，不用黑边），成员递归取全部叶站；
  //     out-of-station 单元：直属站各自普通尺寸圈（出闸换乘物理上是两个站，不并点，黑边），
  //       子组各自成单元；
  //     除出闸单元的直属站外，成员的个人小圈一律不再单独出现。
  //   pills —— 逻辑线 ≥3 的 same-station 单元的胶囊折线：叶站 geo 按 planGroupPillChain 链序
  //（渲染层双层 line＋圆头端帽即得白底黑边胶囊）。条目自带 pin（组级信息面板/hover 单元，
  // key 'g:<id>'，渲染层并入 pinByKey；不进 pins＝不渲染成圈）。
  //   labels —— HTML 标签与搜索条目单元：无组站各一；每个单元各一（均值位置，名取首个非空）；
  // 出闸单元的标签只对其直属站计算（无直属站则本单元不出自己的标签），子组另有自己的标签。
  //   lineIds —— pin/label 一律收单元内全部成员线的 lineId（调光/聚焦/站名可见性口径不变）。
  //（arrow 非站：此处一律跳过——不进组、不进 pin/label；其出省端属判定走 arrowFadePlan。）
  // opts（均可缺省）：{ linesMap, lineGroups, tree }——linesMap/lineGroups 供药丸逻辑线数判定
  //（缺省＝按 distinct lineId 计，旧行为）；tree＝buildGroupTree 产物（缺省＝按站的直属组现搭
  // 平铺树＝旧行为）。
  function buildStopView(stops, opts) {
    const o = opts || {};
    const list = Array.isArray(stops) ? stops : [];
    const linesMap = o.linesMap instanceof Map ? o.linesMap : null;
    const lineGroups = o.lineGroups && o.lineGroups.ofLine instanceof Map ? o.lineGroups : null;
    // 结构树：调用方给的是 buildGroupTree 产物就用它（面板的关系描述共用同一棵），否则按站的
    // 直属组现搭平铺树＝旧行为（全部组顶层、无子组）
    const tree = (o.tree && typeof o.tree.typeOf === 'function' && typeof o.tree.rootOf === 'function')
      ? o.tree : buildGroupTree(null, list);
    const singles = [];
    for (const s of list) {
      if (!s || s.kind === 'arrow') continue;   // 箭头不是站：不进组、不进 pin/label
      if (!s.groupId) singles.push(s);
    }
    const pins = [], pills = [], labels = [];
    const pinOfStop = (s, groupType) => ({
      kind: 'stop', key: s.sid, name: s.name, lineId: s.lineId,
      lineNames: s.lineName ? [s.lineName] : [], groupType: groupType || null,
      groupId: s.groupId || null,   // 出闸组成员各自成圈，但保留组号供「组内车站」查询
      // 联络线站描边色透传（stopList 保留字段，见其注；组 pin 不携带——组符号
      // 描边另有 junction 角色优先级色/黑边规则，不与联络线站圈规则混流）
      stroke: s.stroke || null,
      ...(s.stopStatus ? { stopStatus: s.stopStatus } : {}),
      big: false, lon: s.lon, lat: s.lat,
    });
    for (const s of singles) {
      pins.push(pinOfStop(s, null));
      // lineIds＝站名可见性判定用（全局开关/聚焦常显/调光隐藏，见 visibleLabels）
      labels.push({ key: s.sid, name: s.name, lon: s.lon, lat: s.lat, group: false, groupType: null,
        lineNames: s.lineName ? [s.lineName] : [], lineIds: s.lineId ? [s.lineId] : [], ...(s.stopStatus ? { stopStatus: s.stopStatus } : {}) });
    }
    // 单元公共量（旧算法原样，成员改喂叶站）：坐标＝成员均值；名取首个非空；成员线去重
    const unitOf = (members) => {
      const n = members.length || 1;
      return {
        lon: members.reduce((a, s) => a + num(s.lon), 0) / n,
        lat: members.reduce((a, s) => a + num(s.lat), 0) / n,
        name: (members.find((s) => s.name) || {}).name || '',
        lineNames: [...new Set(members.map((s) => s.lineName).filter(Boolean))],
        lineIds: [...new Set(members.map((s) => s.lineId).filter(Boolean))],
        ...(members.some((s) => s.stopStatus) ? { stopPhaseMembers: members.map((s) => ({ sid: s.sid || '', lineId: s.lineId || '', ...(s.stopStatus ? { status: s.stopStatus } : {}) })) } : {}),
      };
    };
    const unitLabel = (gid, type, u) => ({
      key: 'g:' + gid, name: u.name, lon: u.lon, lat: u.lat, group: true, groupType: type,
      lineNames: u.lineNames, lineIds: u.lineIds, ...(u.stopPhaseMembers ? { stopPhaseMembers: u.stopPhaseMembers } : {}),
    });
    // 一个组至多出一个绘制单元（成环/多父脏数据防御：重复到达直接返回）
    const emitted = new Set();
    const emitUnit = (gid) => {
      if (emitted.has(gid)) return;
      emitted.add(gid);
      const type = tree.typeOf(gid);
      const direct = tree.directStops(gid);
      if (type === 'out-of-station') {
        // 出闸单元：直属站各自成圈（不并点）；标签只对直属站算——无直属站则本单元不出标签；
        // 每个子组是它自己的绘制单元，按它自己的 type 递归
        for (const s of direct) pins.push(pinOfStop(s, 'out-of-station'));
        if (direct.length) labels.push(unitLabel(gid, type, unitOf(direct)));
        for (const c of tree.childrenOf(gid)) emitUnit(c);
        return;
      }
      const leaves = tree.leafStops(gid);
      if (!leaves.length) return;   // 无站组（成员线已归档、全线路所组被上游剔除等）：不出图形不出标签
      const u = unitOf(leaves);
      // shape:"pill"（2026-11-23 用户裁定）：同站组显式强制药丸——平行线双线站大圆悬浮对策，
      // 不论线数（仅 same-station 生效；validate 禁其他类型写 shape）；上级组（带子组的
      // 同站／接轨单元）一律药丸、不论线数；平铺组沿用逻辑线 ≥3
      const gn = tree.byId.get(gid);
      if ((gn && gn.shape === 'pill' && type === 'same-station') || tree.childrenOf(gid).length > 0
        || (type === 'same-station' && logicalLineCount(u.lineIds, linesMap, lineGroups) >= 3)) {
        // 药丸替代一切成员图形——成员个人小圈不再出现（药丸即换乘标识，
        // 2026-11-22 用户裁定）；组 pin 挂在药丸条目上（不进 pins＝不被渲染成圈），
        // 渲染层在药丸线上挂点选/hover，用同一 key 查 pinByKey
        const order = planGroupPillChain(leaves.map((s) => planarOf(s.lon, s.lat, u.lat)));   // 共享参考纬度＝叶站均值
        pills.push({
          key: 'g:' + gid, groupId: gid, lineIds: u.lineIds,
          chain: order.map((i) => [leaves[i].lon, leaves[i].lat]),
          pin: {
            kind: 'group', key: 'g:' + gid, groupId: gid, name: u.name, lineNames: u.lineNames,
            lineIds: u.lineIds, groupType: type, big: true, lon: u.lon, lat: u.lat,
            ...(u.stopPhaseMembers ? { stopPhaseMembers: u.stopPhaseMembers } : {}),
          },
        });
      } else {
        pins.push({
          kind: 'group', key: 'g:' + gid, groupId: gid, name: u.name, lineNames: u.lineNames,
          lineIds: u.lineIds,
          groupType: type, big: type === 'same-station', lon: u.lon, lat: u.lat,
          ...(u.stopPhaseMembers ? { stopPhaseMembers: u.stopPhaseMembers } : {}),
        });
      }
      labels.push(unitLabel(gid, type, u));
    };
    // 只从最外层组出发（子组由出闸单元递归带入；同站/junction 单元的内层组并入叶站不出图）
    for (const gid of tree.order) {
      if (tree.rootOf(gid) === gid) emitUnit(gid);
    }
    return { pins, pills, labels };
  }

  // ---------- 嵌套关系描述（信息面板用；2026-11-23 用户裁定·嵌套换乘组） ----------
  // groupRelations(groupId, isStop, tree, linesMap, lineGroups)：groupId＝pin 的所属组（直属组），
  // isStop＝点开的是直属站 pin（出闸单元的成员站）而非绘制单元（合并圈/药丸）的组 pin。
  // 返回 null（平铺组：所属组既是节点又无子组——面板呈现与旧版完全一致）或
  //   { nodeChain  换乘节点：自最外层组向下的链，每项「类型（组 id）」、' › ' 连接——它在哪个
  //                节点、哪一层。直属站视角链到所在组为止；组 pin 视角到直属上级为止（自身组
  //                的类型与 id 已有「换乘关系」「组 ID」两行，不重复）；直属节点本身时为空；
  //     nodeMembers 节点成员：节点的直属站「站名（线名）」＋各子组「类型：线路、线路」、'；'
  //                连接——仅组 pin 且节点含子组时非空（同节点还有谁、自己在哪一部分）；
  //     partners   换乘对端：出闸关系的另一端——直属站视角＝所在出闸单元的各子组「类型：
  //                线路、线路」（同单元其余直属站走既有「组内车站」行，不重复）；子组视角＝
  //                上级出闸单元的直属站「站名（线名）」＋其余兄弟子组；'；' 连接 }。
  // 类型名一律取 GROUP_TYPE_ZH（不新造术语）；线路显示名与「所属线路」行同源（linesOfPin——
  // 主支线合并后显示组名并去重）；没有输出站点的子组不出现在任何描述里。
  function groupRelations(groupId, isStop, tree, linesMap, lineGroups) {
    if (!tree || typeof tree.childrenOf !== 'function' || !groupId || !tree.group(groupId)) return null;
    const kids = tree.childrenOf(groupId).filter((c) => tree.leafStops(c).length > 0);   // 有输出站点的子组
    const parent = tree.parentOf(groupId);
    if (!kids.length && parent == null) return null;   // 平铺组
    const typeZh = (id) => GROUP_TYPE_ZH[tree.typeOf(id)] || tree.typeOf(id);
    const unitText = (id) => {
      const ids = [...new Set(tree.leafStops(id).map((s) => s.lineId).filter(Boolean))];
      return typeZh(id) + '：' + linesOfPin({ kind: 'group', lineIds: ids }, linesMap, lineGroups).join('、');
    };
    const stopsText = (sts) => sts
      .map((s) => stopDisplayName(s.name) + (s.lineName ? '（' + s.lineName + '）' : '')).join('、');
    const out = { nodeChain: '', nodeMembers: '', partners: '' };
    // 换乘节点链：自所属组向上收集（indexOf 防环），截到最外层组后倒成正序（自上而下）
    const up = [];
    for (let p = groupId; p != null && up.indexOf(p) < 0; p = tree.parentOf(p)) up.push(p);
    const at = up.indexOf(tree.rootOf(groupId));
    const chain = (at >= 0 ? up.slice(0, at + 1) : up).reverse();
    if (!isStop) chain.pop();
    out.nodeChain = chain.map((id) => typeZh(id) + '（组 ' + id + '）').join(' › ');
    // 节点成员（组 pin 且节点含子组）
    if (!isStop && kids.length) {
      const parts = [];
      const direct = tree.directStops(groupId);
      if (direct.length) parts.push(stopsText(direct));
      for (const c of kids) parts.push(unitText(c));
      out.nodeMembers = parts.join('；');
    }
    // 出闸对端
    if (isStop && tree.typeOf(groupId) === 'out-of-station') {
      out.partners = kids.map(unitText).join('；');
    } else if (!isStop && parent != null && tree.typeOf(parent) === 'out-of-station') {
      const parts = [];
      const ds = tree.directStops(parent);
      if (ds.length) parts.push(stopsText(ds));
      for (const c of tree.childrenOf(parent)) {
        if (c !== groupId && tree.leafStops(c).length > 0) parts.push(unitText(c));
      }
      out.partners = parts.join('；');
    }
    return out.nodeChain || out.nodeMembers || out.partners ? out : null;
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

  // ---------- 线路页车站列表（2026-11-27 用户需求：线路页信息下方加竖直线站序） ----------
  // lineStopSections(mainId, linesMap, stops, lineGroups, tree)：自然线路 → 站序分段模型，
  // 供胶水层渲染「竖直线站序图」——主线一段（含 arrow 出省端行）＋每条支线各一段；接入
  // 关系（支线↔主线、联络线↔本线）以 mark 形式挂在对应行/行间。全部为只读计算，不发数据。
  //
  // 接入位置的数据口径（2026-11-27 摸真数据定案）：
  //   ① 精确＝junction 组（接轨站）——支线端站与主线（或组内其他成员线）站在同一 junction
  //      组 → 接入点＝该成员站行。真数据 9 条联络线两端、7 个线组中 5 组的支线全有 junction。
  //   ② 近似＝几何投影（无 junction 表达时，如机场联络线 l0012、苏州11 支线 l0078）——
  //      支线/联络线拼接折线端点投影到本自然线路成员线折线最近点：距最近站 ≤150m
  //      （STATION_SNAP_M）算「接入该站」、否则按投影弧长落在两站之间（after 行间标记，
  //      对应「接入点在线路所」场景——block 站 flatten 已剔除、网页数据不可见，只能几何
  //      兜底）。此类 mark 带 approx:true，待数据支持（未来若加显式接入字段可替换）。
  //   联络线 connect 方向：connects 无顺序语义，哪端接哪条线按「两端点各自投影、近者归彼」
  //   （connectorFadePlan 同思路）；联络线端站在 junction 组时直接精确（对方站 sid）。
  // 钉死规则：联络线自身名称绝不进模型（mark 标注只写「联络〈对方自然线路名〉」＋对方
  // 主线色；跳转目标＝对方主线 id——mainOf 归一）。
  // 站序：stopIndex（flatten 原站序，含 block 占位防错位）升序、缺失退 t；arrow 站保留
  // （kind:'arrow' 行不写站名，渲染层画线端箭头）。
  // 防御：mainId 不在 linesMap → 返回 null；无组信息（旧快照）＝单主线一段；支线/联络线
  // 无坐标无站 → 无对应 mark，不影响其余输出。
  const STATION_SNAP_M = 150;
  const NODE_ROLE_PRI = { main: 4, standalone: 3, branch: 2, connector: 1 };
  function lineEndpointsOf(line) {
    let head = null, tail = null;
    for (const seg of (line && line.segments) || []) {
      for (const pt of (seg && seg.coords) || []) {
        if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
        if (head == null) head = pt;
        tail = pt;
      }
    }
    return { head, tail };
  }
  // 点到线路拼接折线的平面近似最近距离/弧长（米）：lat0＝输入点与线首末点纬度均值
  //（同一比较内同一常数，与 planarOf 注同口径）；x 米＝lon·cos(lat0)·111320。
  function nearestOnLineGeom(lon, lat, line) {
    const pts = [];
    for (const seg of (line && line.segments) || []) {
      for (const pt of (seg && seg.coords) || []) {
        if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) pts.push(pt);
      }
    }
    if (!pts.length) return null;
    const lat0 = (num(lat) + pts[0][1] + pts[pts.length - 1][1]) / 3;
    const kx = Math.cos(lat0 * Math.PI / 180) * M_PER_DEG_LAT;
    const px = num(lon) * kx, py = num(lat) * M_PER_DEG_LAT;
    if (pts.length === 1) {
      const dx = px - pts[0][0] * kx, dy = py - pts[0][1] * M_PER_DEG_LAT;
      return { dist: Math.sqrt(dx * dx + dy * dy), s: 0 };
    }
    let bestD2 = Infinity, bestS = 0, acc = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ax = pts[i][0] * kx, ay = pts[i][1] * M_PER_DEG_LAT;
      const bx = pts[i + 1][0] * kx, by = pts[i + 1][1] * M_PER_DEG_LAT;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
      let t = 0;
      if (len2 > 0) {
        t = ((px - ax) * dx + (py - ay) * dy) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
      }
      const qx = ax + t * dx, qy = ay + t * dy;
      const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
      if (d2 < bestD2) { bestD2 = d2; bestS = acc + t * len; }
      acc += len;
    }
    return { dist: Math.sqrt(bestD2), s: bestS };
  }
  // 线内站序（含 arrow）：stopIndex 升序、缺失排最后退 t 升序（与 lineSummaries 的 t 口径
  // 兼容——flatten 恒写 stopIndex，退路只为防御旧快照/手造数据）
  function stopsOfLineOrdered(lineId, stops) {
    const rows = [];
    for (const s of Array.isArray(stops) ? stops : []) {
      if (s && String(s.lineId) === String(lineId)) rows.push(s);
    }
    rows.sort((a, b) => {
      const ia = Number.isInteger(a.stopIndex) ? a.stopIndex : Infinity;
      const ib = Number.isInteger(b.stopIndex) ? b.stopIndex : Infinity;
      if (ia !== ib) return ia - ib;
      const ta = a.t == null ? Infinity : num(a.t), tb = b.t == null ? Infinity : num(b.t);
      return ta - tb;
    });
    return rows;
  }
  // junction 组桶（groupId → 成员站表，仅 groupType==='junction' 的非 arrow 站；
  // 嵌套安全——接轨关系的两站恒在同一直属组，与最外层结构无关）
  function junctionBuckets(stops) {
    const buckets = new Map();
    for (const s of Array.isArray(stops) ? stops : []) {
      if (!s || s.kind === 'arrow' || !s.groupId || s.groupType !== 'junction') continue;
      let arr = buckets.get(s.groupId);
      if (!arr) { arr = []; buckets.set(s.groupId, arr); }
      arr.push(s);
    }
    return buckets;
  }
  // 站序行的节点形态（列表版＝地图 buildStopView/renderStopsFC 同一规则的等价物：
  // 无组＝白心小圈线色描边；出闸直属站＝黑边小圈；同站/junction 单元＝大圈
  //（junction 描边取成员线角色优先级色——main＞standalone＞branch＞connector，
  // 与胶水层 junctionStroke 同源规则）；药丸条件（shape:"pill"/带子组/逻辑线≥3）
  // 同 buildStopView。返回 null（arrow 行无节点）或 { kind:'dot'|'dark'|'big'|'pill',
  // stroke:色值|null }——stroke null＝渲染层退段色（普通站）。
  function stopNodeGlyph(stop, tree, linesMap, lineGroups) {
    if (!stop || stop.kind === 'arrow') return null;
    const gid = stop.groupId;
    if (!gid || !tree || typeof tree.rootOf !== 'function') return { kind: 'dot', stroke: null };
    const root = tree.rootOf(gid);
    if (root == null) return { kind: 'dot', stroke: null };
    const glyphOfUnit = (g) => {
      const type = tree.typeOf(g);
      if (type === 'out-of-station') {
        // 出闸：直属站各自黑边小圈；成员站在子组的按子组自身类型递归（地图 emitUnit 同款）
        return gid === g ? { kind: 'dark', stroke: '#000000' } : glyphOfUnit(gid);
      }
      const leaves = tree.leafStops(g);
      if (!leaves.length) return { kind: 'dot', stroke: null };
      const lineIds = [...new Set(leaves.map((s) => s.lineId).filter(Boolean))];
      const gn = tree.byId.get(g);
      if ((gn && gn.shape === 'pill' && type === 'same-station') || tree.childrenOf(g).length > 0
        || (type === 'same-station' && logicalLineCount(lineIds, linesMap, lineGroups) >= 3)) {
        return { kind: 'pill', stroke: '#000000' };
      }
      if (type === 'junction') {
        let pri = -1, color = null;
        for (const lid of lineIds) {
          const line = linesMap instanceof Map ? linesMap.get(lid) : null;
          if (!line) continue;
          const p = Object.prototype.hasOwnProperty.call(NODE_ROLE_PRI, line.role) ? NODE_ROLE_PRI[line.role] : -1;
          if (p > pri) { pri = p; color = line.color || DEFAULT_LINE_COLOR; }
        }
        return { kind: 'big', stroke: color || '#555555' };
      }
      return { kind: 'big', stroke: '#000000' };
    };
    return glyphOfUnit(root);
  }
  // 支线「去向」标注文本：非接入端方向的末端具名站；无具名站（如整条只剩 arrow 的出省
  // 支线）退支线自身名（用户已命名，非新造）——「往〈去向〉」
  function branchDestLabel(rows, attachEnd, fallbackName) {
    const named = (s) => s && s.kind !== 'arrow' && typeof s.name === 'string' && s.name;
    if (attachEnd === 'head') {
      for (let i = rows.length - 1; i >= 0; i--) if (named(rows[i])) return rows[i].name;
    } else {
      for (let i = 0; i < rows.length; i++) if (named(rows[i])) return rows[i].name;
    }
    return fallbackName || '';
  }
  // 共线声明 → 站行区间（2026-11-28 线路页车站列表共线标注）：i/j＝sharedTracks 声明
  // 两端站在该段的行号。与 flatten shared_track_decls 的段范围同构的**站集合**口径：
  // 非环线＝闭区间（声明标反等价，重排 min/max）；环线＝沿站序前进弧——i>j 跨环绕
  // （行 i..n-1＋0..j，即环绕段一端的站也在区间内；标反即取补弧，数据侧须按本线
  // 站序给起止，validate 已要求双侧一致）。两端边界站含在内。越界/同点 → 空表。
  function sharedTrackRowRange(loop, n, i, j) {
    if (!Number.isInteger(i) || !Number.isInteger(j) || i === j) return [];
    if (i < 0 || j < 0 || i >= n || j >= n) return [];
    const out = [];
    if (loop && i > j) {
      for (let k = i; k < n; k++) out.push(k);
      for (let k = 0; k <= j; k++) out.push(k);
    } else {
      const a = Math.min(i, j), b = Math.max(i, j);
      for (let k = a; k <= b; k++) out.push(k);
    }
    return out;
  }
  // lineStopSections 主函数。返回：
  // { mainId, sections: [{ lineId, isMain, name, color, loop,
  //     rows: [{ sid, name, kind, t, glyph, transfers, shared }],
  //     marks: [{ at: {row:i}|{after:i}, type:'branch'|'toMain'|'conn',
  //               label, color, targetSectionIdx, targetAt, targetMainId, approx }] }] }
  //   mark 定位：at.row＝行内（该站行处）、at.after＝行间（画在第 i 行与 i+1 行之间）。
  //   branch/toMain 的滚动目标 targetAt＝{row}|{after}（目标段内定位）；conn 的跳转目标
  //   targetMainId＝对方主线 id。color：branch＝支线色 / toMain＝主线色 / conn＝对方主线色。
  //   transfers（2026-11-27 换乘信息）：该站还能换乘的其他自然线路
  //   [{ mainId, name, color }]，口径见「③ 换乘信息」注；arrow 行恒 []。
  //   loop（2026-11-28 环线表达）：该成员线 loop:true——渲染层主线段一侧画回环指示。
  //   shared（2026-11-28 共线表达）：该站行处于与本线共线共轨区间的对方自然线路
  //   { mainId, name, color }（两端边界站含在内；环线沿站序前进弧跨环绕），口径见
  //   「④ 共线区间标注」注；非共线行无该键。
  // lineOrder（可选第 6 参，2026-11-27 增）：换乘项排序（stationFocusOf 同款——自定义序
  // 优先、未列入者 lineId 升序 tie-break）；不传＝纯 lineId 升序。
  function lineStopSections(mainId, linesMap, stops, lineGroups, tree, lineOrder) {
    if (!(linesMap instanceof Map)) return null;
    const mid0 = mainId != null ? String(mainId) : '';
    const lg = lineGroups && lineGroups.mainOf instanceof Map ? lineGroups : null;
    const mainIdNorm = lg ? (lg.mainOf.get(mid0) || mid0) : mid0;
    const mainLine = linesMap.get(mainIdNorm);
    if (!mainLine) return null;
    const grp = lg ? lg.ofLine.get(mainIdNorm) : null;
    const members = grp ? grp.members.slice() : [mainIdNorm];
    const memberSet = new Set(members.map(String));
    const list = Array.isArray(stops) ? stops : [];
    const rowsByLine = new Map();               // lineId → 站序行（含 arrow）
    for (const lid of members) rowsByLine.set(lid, stopsOfLineOrdered(lid, list));
    const buckets = junctionBuckets(list);
    const secIndexOf = new Map(members.map((lid, i) => [String(lid), i]));
    const sections = [];
    for (const lid of members) {
      const line = linesMap.get(lid);
      sections.push({
        lineId: String(lid),
        isMain: String(lid) === mainIdNorm,
        name: line ? (line.name || '') : '',
        color: line ? line.color : DEFAULT_LINE_COLOR,
        // 环线标记（2026-11-28 线路页环线表达）：该成员线自身 loop——渲染层画回环指示
        loop: !!(line && line.loop),
        rows: [],
        marks: [],
      });
      for (const s of rowsByLine.get(lid)) {
        sections[sections.length - 1].rows.push({
          sid: s.sid, name: s.kind === 'arrow' ? '' : (s.name || ''),
          kind: s.kind === 'arrow' ? 'arrow' : 'stop', t: s.t == null ? null : num(s.t),
          glyph: stopNodeGlyph(s, tree, linesMap, lg),
        });
      }
    }
    // —— mark 通用追加（同段同位同标注去重） ——
    const pushMark = (lid, at, mk) => {
      const si = secIndexOf.get(String(lid));
      if (si == null) return;
      const sec = sections[si];
      for (const old of sec.marks) {
        const same = (old.at.row != null ? (at.row === old.at.row && old.at.row != null) : (at.after === old.at.after && old.at.after != null))
          && old.type === mk.type && old.label === mk.label;
        if (same) return;
      }
      sec.marks.push(Object.assign({ at }, mk));
    };
    const rowIndexBySid = (lid, sid) => {
      const rows = rowsByLine.get(lid) || [];
      for (let i = 0; i < rows.length; i++) if (rows[i].sid === sid) return i;
      return -1;
    };
    // 几何锚：外部点（支线/联络线端点）在本自然线路上的落位（站行或行间）。
    // excludeLid＝调用方自身线 id（支线几何近似时排除自己——否则支线端点落在自身
    // 折线上 dist=0 恒抢走锚，接不到主线）
    const geoAnchor = (lon, lat, excludeLid) => {
      let best = null;   // { lid, proj }
      for (const lid of members) {
        if (excludeLid != null && String(lid) === String(excludeLid)) continue;
        const line = linesMap.get(lid);
        const proj = line ? nearestOnLineGeom(lon, lat, line) : null;
        if (proj && (!best || proj.dist < best.proj.dist)) best = { lid: String(lid), proj };
      }
      if (!best) return null;
      const rows = rowsByLine.get(best.lid) || [];
      const line = linesMap.get(best.lid);
      // 最近站（平面距离，共享 lat0）
      const lat0 = num(lat);
      const kx = Math.cos(lat0 * Math.PI / 180) * M_PER_DEG_LAT;
      let bestIdx = -1, bestD = Infinity;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].kind === 'arrow') continue;
        const dx = num(lon) * kx - num(rows[i].lon) * kx;
        const dy = num(lat) * M_PER_DEG_LAT - num(rows[i].lat) * M_PER_DEG_LAT;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      if (bestIdx >= 0 && bestD <= STATION_SNAP_M) return { onLid: best.lid, at: { row: bestIdx }, approx: true, dist: best.proj.dist };
      // 行间：投影弧长与各站投影弧长比位（arrow 行不占锚位、行下标照含）
      let prev = -1;
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].kind === 'arrow') continue;
        const sp = line ? nearestOnLineGeom(rows[i].lon, rows[i].lat, line) : null;
        if (sp && sp.s >= best.proj.s) break;
        prev = i;
      }
      const last = rows.length - 1;
      const after = Math.min(Math.max(prev, 0), Math.max(last - 1, 0));
      return { onLid: best.lid, at: { after }, approx: true, dist: best.proj.dist };
    };
    // —— ① 支线接入主线 ——
    for (const lid of members) {
      if (String(lid) === mainIdNorm) continue;
      const rows = rowsByLine.get(lid) || [];
      const bline = linesMap.get(lid);
      const anchors = [];   // { at, onLid, end:'head'|'tail', approx }
      for (const st of rows) {
        if (st.kind === 'arrow' || st.groupType !== 'junction' || !st.groupId) continue;
        for (const y of buckets.get(st.groupId) || []) {
          if (String(y.lineId) === String(lid)) continue;
          if (!memberSet.has(String(y.lineId))) continue;
          const ri = rowIndexBySid(y.lineId, y.sid);
          if (ri < 0) continue;
          anchors.push({ at: { row: ri }, onLid: String(y.lineId), approx: false,
            end: rows.indexOf(st) <= (rows.length - 1) / 2 ? 'head' : 'tail' });
          break;
        }
      }
      if (!anchors.length && bline) {
        const ep = lineEndpointsOf(bline);
        const cands = [];
        for (const end of ['head', 'tail']) {
          const pt = ep[end];
          if (!pt) continue;
          const a = geoAnchor(pt[0], pt[1], lid);
          if (a) cands.push(Object.assign({ end }, a));
        }
        if (cands.length) {
          anchors.push(cands.reduce((m, c) => (Number.isFinite(c.dist) && (!Number.isFinite(m.dist) || c.dist < m.dist)) ? c : m, cands[0]));
        }
      }
      const destName = anchors.length ? branchDestLabel(rows, anchors[0].end, bline ? (bline.name || lid) : lid) : '';
      for (const a of anchors) {
        pushMark(a.onLid, a.at, {
          type: 'branch', label: destName ? '往' + destName : '支线',
          color: bline ? bline.color : DEFAULT_LINE_COLOR,
          targetSectionIdx: secIndexOf.get(String(lid)), targetAt: null, approx: a.approx,
        });
        // 支线接入端行（arrow 行退相邻具名行；全 arrow 退端行）
        let er = a.end === 'head' ? 0 : rows.length - 1;
        if (rows[er] && rows[er].kind === 'arrow') {
          const fwd = a.end === 'head';
          for (let i = fwd ? 0 : rows.length - 1; fwd ? i < rows.length : i >= 0; fwd ? i++ : i--) {
            if (rows[i].kind !== 'arrow') { er = i; break; }
          }
        }
        pushMark(String(lid), { row: er }, {
          type: 'toMain', label: '往主线',
          color: mainLine.color,
          targetSectionIdx: secIndexOf.get(a.onLid), targetAt: a.at, approx: a.approx,
        });
      }
    }
    // —— ② 联络线接入（本自然线路成员被 connects） ——
    const mainOfId = (lid) => (lg ? (lg.mainOf.get(String(lid)) || String(lid)) : String(lid));
    const naturalName = (lid) => {
      const g = lg ? lg.ofLine.get(String(lid)) : null;
      if (g) return g.name;
      const line = linesMap.get(String(lid));
      return line ? (line.name || String(lid)) : String(lid);
    };
    const naturalColor = (lid) => {
      const line = linesMap.get(mainOfId(lid));
      return line ? line.color : DEFAULT_LINE_COLOR;
    };
    for (const c of linesMap.values()) {
      if (!c || !Array.isArray(c.connects)) continue;
      if (memberSet.has(String(c.lineId))) continue;
      const hits = c.connects.map(String).filter((x) => memberSet.has(x));
      if (!hits.length) continue;
      const others = [...new Set(c.connects.map(String))]
        .filter((x) => !memberSet.has(x) && linesMap.has(x));
      if (!others.length) continue;
      const cRows = stopsOfLineOrdered(c.lineId, list);
      const anchors = [];
      for (const st of cRows) {
        if (st.kind === 'arrow' || st.groupType !== 'junction' || !st.groupId) continue;
        for (const y of buckets.get(st.groupId) || []) {
          if (String(y.lineId) === String(c.lineId)) continue;
          if (!memberSet.has(String(y.lineId))) continue;
          const ri = rowIndexBySid(y.lineId, y.sid);
          if (ri < 0) continue;
          anchors.push({ at: { row: ri }, onLid: String(y.lineId), approx: false });
          break;
        }
      }
      if (!anchors.length) {
        const ep = lineEndpointsOf(c);
        const cands = [];
        for (const end of ['head', 'tail']) {
          const pt = ep[end];
          if (!pt) continue;
          const a = geoAnchor(pt[0], pt[1]);
          if (a) cands.push(Object.assign({ end }, a));
        }
        if (cands.length) {
          anchors.push(cands.reduce((m, x) => (Number.isFinite(x.dist) && (!Number.isFinite(m.dist) || x.dist < m.dist)) ? x : m, cands[0]));
        }
      }
      for (const other of others) {
        for (const a of anchors) {
          pushMark(a.onLid, a.at, {
            type: 'conn', label: '联络' + naturalName(other),
            color: naturalColor(other),
            targetMainId: mainOfId(other), targetSectionIdx: null, targetAt: null, approx: a.approx,
          });
        }
      }
    }
    // —— ③ 换乘信息回填（2026-11-27 用户需求：线路页站行右侧「该站还能换乘哪些线」）——
    // 口径与 stationLinesOf/stationFocusOf 完全同源：站 → 最外层组全部叶站
    //（tree.rootOf＋leafStops，与「点站进车站页」的成员站口径一致；无组/树缺省退本站）
    // → 逐成员站本线归一到主线（主支线算一条）、**联络线剔除**（HIDDEN_LIST_LAYERS 或
    // connects 非空——技术线路名称禁令，换乘区绝不出现）、**他省线保留**（与车站页
    // 口径一致），再减去本自然线路（mainIdNorm——支线段站同样归一后减）。孤站线不在
    // linesMap 按普通线保留（防御不丢站）。name/color 取主线、组名优先（车站页线路行
    // 同款）；排序 lineOrder 自定义序优先、未列入者 lineId 升序（stationFocusOf 同
    // tie-break）。arrow 行恒 []（出省端无换乘信息）。
    const isTechnicalLine = (lid) => {
      const l = linesMap.get(lid);
      if (!l) return false;   // 孤站线不在 linesMap：按普通线保留（防御）
      const conn = Array.isArray(l.connects) ? l.connects : [];
      return HIDDEN_LIST_LAYERS.indexOf(l.layer) >= 0 || conn.length > 0;
    };
    const xferRank = new Map();
    if (Array.isArray(lineOrder)) {
      lineOrder.forEach((id, i) => { const k = String(id); if (!xferRank.has(k)) xferRank.set(k, i); });
    }
    const transferListOf = (s) => {
      let leaf = [s];
      const gid = s && s.groupId != null && s.groupId !== '' ? String(s.groupId) : null;
      if (gid && tree && typeof tree.group === 'function' && tree.group(gid)
          && typeof tree.leafStops === 'function' && typeof tree.rootOf === 'function') {
        const l = tree.leafStops(tree.rootOf(gid) || gid);   // 最外层组的全部叶站
        if (l.length) leaf = l;
      }
      const mids = [];
      const seen = new Set();
      for (const y of leaf) {
        const lid = y && y.lineId != null ? String(y.lineId) : '';
        if (!lid || isTechnicalLine(lid)) continue;
        const mid = String(mainOfId(lid));
        if (!mid || mid === mainIdNorm || seen.has(mid)) continue;
        seen.add(mid);
        mids.push(mid);
      }
      mids.sort((a, b) => {
        const ra = xferRank.has(a) ? xferRank.get(a) : Infinity, rb = xferRank.has(b) ? xferRank.get(b) : Infinity;
        return ra !== rb ? ra - rb : (a < b ? -1 : a > b ? 1 : 0);
      });
      return mids.map((mid) => {
        const grp = lg ? lg.ofLine.get(mid) : null;
        const line = linesMap.get(mid);
        return {
          mainId: mid,
          name: grp ? (grp.name || (line && line.name) || mid) : ((line && line.name) || mid),
          color: line ? line.color : DEFAULT_LINE_COLOR,
        };
      });
    };
    for (const sec of sections) {
      const srcRows = rowsByLine.get(sec.lineId) || [];
      for (let i = 0; i < sec.rows.length; i++) {
        sec.rows[i].transfers = srcRows[i] && srcRows[i].kind !== 'arrow' ? transferListOf(srcRows[i]) : [];
      }
    }
    // —— ④ 共线区间标注（2026-11-28 用户需求：sharedTracks 双边声明 → 站行「与对方线
    // 共线」）——口径＝flatten shared_track_decls 同构：声明两端站 id 在该成员线段内定位
    // 行号（定位失败防御跳过），站集合＝sharedTrackRowRange（非环闭区间/环线沿站序前进弧
    // 跨环绕；两端边界站含在内）。对方线归一到主线（mainOfId）、**组名优先＋主线色**
    //（transfers 同口径，共线≠换乘但取色取名一致）；对方不存在于 linesMap 或归一后仍是
    // 本自然线路（组内互标，脏数据）→ 不标。同一行被多条声明命中保留首条；arrow 行不是
    // 站、不标。row.shared＝{ mainId, name, color }（渲染层画对方线色侧边条＋区间首行
    // 「与〈对方名〉共线」小字）。
    const sharedInfoOf = (pid) => {
      const mid = mainOfId(pid);
      if (!mid || mid === mainIdNorm || !linesMap.has(mid)) return null;
      const grpS = lg ? lg.ofLine.get(mid) : null;
      const lineS = linesMap.get(mid);
      return {
        mainId: mid,
        name: grpS ? (grpS.name || (lineS && lineS.name) || mid) : ((lineS && lineS.name) || mid),
        color: lineS ? lineS.color : DEFAULT_LINE_COLOR,
      };
    };
    for (const lid of members) {
      const line = linesMap.get(lid);
      const decls = line && Array.isArray(line.sharedTracks) ? line.sharedTracks : [];
      if (!decls.length) continue;
      const rows = rowsByLine.get(lid) || [];
      const sec = sections[secIndexOf.get(String(lid))];
      if (!sec) continue;
      for (const sh of decls) {
        const info = sharedInfoOf(sh.peer);
        if (!info) continue;
        const i = rowIndexBySid(String(lid), sh.stops[0]);
        const j = rowIndexBySid(String(lid), sh.stops[1]);
        for (const k of sharedTrackRowRange(!!(line && line.loop), rows.length, i, j)) {
          if (rows[k].kind === 'arrow' || sec.rows[k].shared) continue;
          sec.rows[k].shared = info;
        }
      }
    }
    return { mainId: mainIdNorm, sections };
  }

  // 线路分类分组（layer 字段）。lineOrder（可选，线 id 数组＝编辑器排序面板定的自定义显示序，
  // 经 manifest.lineOrder → flatten → net/index.json 传入）：组内按自定义序、组序按组内最靠前
  // 成员——跨类交错的自定义序在分组展示下尽可能保真；未列入的线排在已列入者之后（tie-break
  // 与无序时一致）。无 lineOrder 时维持原行为：组名中文本地序、组内 lineId 升序、未分类恒最后。
  // lineGroups（可选，buildLineGroups 产物——2026-11-22 主支线合并）：有效组的主线承单行
  //（显示名改组名；行对象即主线浅拷贝，色块自然取主线自身 color——「色块用主线色」由
  // 「非主线成员不出行」天然保证），支线等非主线成员不出独立行——用户眼中就是一条线、
  // 不设展开子项；分类与排序位置亦天然按主线。缺省（旧快照无组信息）＝逐线旧行为。
  function layerGroups(linesMap, lineOrder, lineGroups) {
    const lg = lineGroups && lineGroups.ofLine instanceof Map ? lineGroups : null;
    const named = new Map(), unclassified = [];
    for (const raw of linesMap.values()) {
      let line = raw;
      const grp = lg ? lg.ofLine.get(raw.lineId) : null;
      if (grp) {
        if (raw.lineId !== grp.mainId) continue;               // 支线不出独立行（并入主线行）
        line = Object.assign({}, raw, { name: grp.name });     // 主线行显示名＝线组名称
      }
      if (typeof line.layer === 'string' && line.layer) {
        if (!named.has(line.layer)) named.set(line.layer, []);
        named.get(line.layer).push(line);
      } else unclassified.push(line);
    }
    const rank = new Map();
    if (Array.isArray(lineOrder)) {
      lineOrder.forEach((id, i) => { const k = String(id); if (!rank.has(k)) rank.set(k, i); });
    }
    const rOf = (l) => (rank.has(l.lineId) ? rank.get(l.lineId) : Infinity);
    const byOrder = (a, b) => {
      const ra = rOf(a), rb = rOf(b);
      return ra !== rb ? ra - rb : (a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0);
    };
    const gRank = (lines) => lines.reduce((m, l) => Math.min(m, rOf(l)), Infinity);
    // 组间排序：有自定义序的组按组内最靠前成员；全部无序（或并列 Infinity）时回落旧惯例
    // ——组名中文本地序、未分类恒最后（含未分类线被显式排序的情形：保真用户序优先于惯例）。
    const legacyCmp = (a, b) => {
      if (a.layer == null) return b.layer == null ? 0 : 1;
      if (b.layer == null) return -1;
      return a.layer.localeCompare(b.layer, 'zh');
    };
    const all = [...named.entries()].map(([layer, lines]) => ({ layer, lines }));
    if (unclassified.length) all.push({ layer: null, lines: unclassified });
    return all
      .sort((a, b) => (gRank(a.lines) - gRank(b.lines)) || legacyCmp(a, b))
      .map((g) => ({ layer: g.layer, lines: g.lines.slice().sort(byOrder) }));
  }

  // ---------- 联络线渐变接入端判定（2026-11-22 用户需求 3：聚焦高亮用） ----------
  // connectorFadePlan(linesMap, focusId)：找 linesMap 中 connects 含 focusId 的每条线 C
  //（联络线），返回 [{lineId, attachEnd}]——attachEnd∈{0,1} 表示接入聚焦线的一端是
  // C 全部 segments 按 segIndex 拼接折线的首端(0)还是末端(1)。
  // connects 无顺序语义（schema 未定义哪端对应哪个 id），方向靠几何最近端判定——
  // 联络线与主线在接轨点物理相接：取拼接折线的首点与末点，分别算到聚焦线全部坐标点的
  // 最小距离，近者为接入端；平手或任一方取不到有效坐标时兜底 0。
  // focusId 为空 / 聚焦线不在 linesMap / 聚焦线无有效坐标 → 返回 []。
  // 2026-11-22 主支线合并裁定：focusId 恒为主线 id（胶水层 toggleFocus 已归一），connects
  // 判定不扩展支线 id——现实数据无「联络线 connects 指向支线」形态，防御从简，不改本函数。
  function connectorFadePlan(linesMap, focusId) {
    const fid = focusId != null && focusId !== '' ? String(focusId) : null;
    if (!fid || !(linesMap instanceof Map)) return [];
    const focusLine = linesMap.get(fid);
    if (!focusLine) return [];
    const fpts = [];   // 聚焦线全部有效坐标点（接入端判定的靶点集）
    for (const seg of focusLine.segments || []) {
      for (const pt of (seg && seg.coords) || []) {
        if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) fpts.push(pt);
      }
    }
    if (!fpts.length) return [];
    const plan = [];
    for (const line of linesMap.values()) {
      if (!line || line.lineId == null) continue;
      const conn = Array.isArray(line.connects) ? line.connects.map(String) : [];
      if (conn.indexOf(fid) < 0) continue;   // connects 不含聚焦线 → 不参与
      // 拼接折线首末点（normalizeLines 已保证 segments 按 segIndex 升序；逐点过滤无效坐标）
      let head = null, tail = null;
      for (const seg of line.segments || []) {
        for (const pt of (seg && seg.coords) || []) {
          if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
          if (head == null) head = pt;
          tail = pt;
        }
      }
      if (head == null || tail == null) {   // 联络线自身无有效坐标 → 兜底 0（防御）
        plan.push({ lineId: String(line.lineId), attachEnd: 0 });
        continue;
      }
      // 距离用平面近似坐标（planarOf 共享参考纬度取首末两点纬度均值——同一比较内同一
      // 常数，只影响相对几何不影响结论；接入端与接轨点物理相接，远近悬殊不怕度量近似）
      const lat0 = (head[1] + tail[1]) / 2;
      const [hx, hy] = planarOf(head[0], head[1], lat0);
      const [tx, ty] = planarOf(tail[0], tail[1], lat0);
      let dHead = Infinity, dTail = Infinity;
      for (const pt of fpts) {
        const [px, py] = planarOf(pt[0], pt[1], lat0);
        const dh = (hx - px) * (hx - px) + (hy - py) * (hy - py);
        const dt = (tx - px) * (tx - px) + (ty - py) * (ty - py);
        if (dh < dHead) dHead = dh;
        if (dt < dTail) dTail = dt;
      }
      // 近者为接入端；平手（dHead === dTail，含全 Infinity 不可能——fpts 非空且有限）兜底 0
      plan.push({ lineId: String(line.lineId), attachEnd: dTail < dHead ? 1 : 0 });
    }
    return plan;
  }

  // ---------- 聚焦取景 bbox（2026-11-27 真机反馈轮：相机让位两病灶修复） ----------
  // focusBboxOf(dispBbox, lineGroups, focusId, fadeConnPlan)：聚焦相机取景 bbox ＝
  // 聚焦组全体成员（无组退单线；组 members 空亦退单线，与 updateLabels 的 focusMembers
  // 兜底同口径）渲染 bbox 联合 **∪ 聚焦绑定联络线（fadeConnPlan＝connectorFadePlan 产物，
  // connects 含聚焦线者）的渲染 bbox**。
  // 病灶①（用户真机抓包：聚焦「东西联络线」时，其西衔嘉青松金线的联络线 l0087 被切出
  // 画面）：联络线以 conn-fade 罩上渐变高亮呈现（聚焦线色→透明）、视觉上属于聚焦呈现的
  // 一部分，但其几何可延伸到线路本体 bbox 之外——取景必须并入。口径与 conn-fade 渲染
  // 判定完全一致＝直接吃 fadeConnPlan，不另立关联规则（conn-blend 常驻层是白罩下的背景，
  // 不并入；connects 指向支线 id 的形态 connectorFadePlan 本就防御从简不扩展，这里同口径）。
  // dispBbox：lineId → [minX,minY,maxX,maxY]（渲染同帧记账——渐变/重画接管的线跳
  // feature 不跳 bbox，联络线恒有记账）；lineGroups：buildLineGroups 产物 {ofLine:Map}；
  // 缺 bbox 的成员逐个跳过，全体缺失返回 null（调用方静默不跳相机，保持既有行为）。
  function focusBboxOf(dispBbox, lineGroups, focusId, fadeConnPlan) {
    if (focusId == null) return null;
    const into = (bb, id) => {
      const b = dispBbox instanceof Map && id != null ? dispBbox.get(id) : null;
      if (!b) return bb;
      if (!bb) return [b[0], b[1], b[2], b[3]];
      return [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])];
    };
    const grp = lineGroups && lineGroups.ofLine instanceof Map ? lineGroups.ofLine.get(focusId) : null;
    const ids = grp && Array.isArray(grp.members) && grp.members.length ? grp.members : [focusId];
    let bb = null;
    for (const id of ids) bb = into(bb, id);
    for (const it of fadeConnPlan || []) {
      if (it && it.lineId != null) bb = into(bb, it.lineId);
    }
    return bb;
  }

  // ---------- 联络线双端渐变取色（2026-11-22 用户需求 2：取消联络线颜色属性） ----------
  // connectorBlendPlan(linesMap)：找 linesMap 中全部「有效」联络线，返回
  // [{lineId, headColor, tailColor}]——head/tailColor＝该线拼接折线首/末端各自
  // 最近的「有效目标线」的 color（linesMap 的 line.color 已含 flatten 的组色合并，
  // 直接用；两端可为同一条线，此时双色相等＝自然退化为单色）。
  // 有效联络线判定：connects≥2 且其中 ≥2 个 id 存在于 linesMap 且这些目标线有
  // 有效坐标（<2 条有效目标＝信息未填写完全，查看器兜底深灰、不出渐变层）。
  // connects≥3 时每端各自取最近一条（2026-11-22 授权裁定：其余忽略——现实联络
  // 线 connects 恒为 2，≥3 属防御位，不做三色及以上的复杂渐变）。
  // 几何与 connectorFadePlan 同手法：segments 按 segIndex 拼接折线取首末点（只看
  // 首末点——联络线中途设站不影响本判定）、planarOf 平面近似（共享参考纬度＝首末
  // 两点纬度均值）、逐项防御（坏坐标过滤、自身无坐标直接跳过不出条目——head/tail
  // 色无从挂，与 fadePlan 的兜底 0 不同）。
  function connectorBlendPlan(linesMap) {
    const out = [];
    if (!(linesMap instanceof Map)) return out;
    // 有效坐标缓存（lineId → 点数组；目标线可能被多条联络线共用，惰性算一次）
    const ptsCache = new Map();
    const validPtsOf = (line) => {
      if (ptsCache.has(line.lineId)) return ptsCache.get(line.lineId);
      const pts = [];
      for (const seg of (line && line.segments) || []) {
        for (const pt of (seg && seg.coords) || []) {
          if (Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])) pts.push(pt);
        }
      }
      ptsCache.set(line.lineId, pts);
      return pts;
    };
    for (const line of linesMap.values()) {
      if (!line || line.lineId == null) continue;
      const conn = Array.isArray(line.connects) ? line.connects.map(String) : [];
      if (conn.length < 2) continue;
      const targets = [];   // 有效目标线（去重、存在且有坐标）
      const seen = new Set();
      for (const cid of conn) {
        if (seen.has(cid)) continue;
        seen.add(cid);
        const t = linesMap.get(cid);
        if (!t) continue;
        const pts = validPtsOf(t);
        if (!pts.length) continue;
        targets.push({ line: t, pts });
      }
      if (targets.length < 2) continue;   // 有效目标 <2 → 无效（兜底深灰由渲染层处理）
      // 本线拼接折线首末点（normalizeLines 已保证 segments 按 segIndex 升序）
      let head = null, tail = null;
      for (const seg of line.segments || []) {
        for (const pt of (seg && seg.coords) || []) {
          if (!Array.isArray(pt) || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
          if (head == null) head = pt;
          tail = pt;
        }
      }
      if (head == null || tail == null) continue;   // 自身无坐标 → 不出条目（防御）
      const lat0 = (head[1] + tail[1]) / 2;        // 共享参考纬度（同比较内同一常数）
      const [hx, hy] = planarOf(head[0], head[1], lat0);
      const [tx, ty] = planarOf(tail[0], tail[1], lat0);
      const nearestColor = (ax, ay) => {
        let bestColor = null, best = Infinity;
        for (const t of targets) {
          let d = Infinity;
          for (const pt of t.pts) {
            const [px, py] = planarOf(pt[0], pt[1], lat0);
            const dd = (ax - px) * (ax - px) + (ay - py) * (ay - py);
            if (dd < d) d = dd;
          }
          if (d < best) { best = d; bestColor = t.line.color; }
        }
        return bestColor || DEFAULT_LINE_COLOR;   // 脏色兜底（normalizeLines 实际已兜）
      };
      out.push({ lineId: String(line.lineId), headColor: nearestColor(hx, hy), tailColor: nearestColor(tx, ty) });
    }
    return out;
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
      // terms＝只参与匹配、不进下拉副行的附加搜索词（2026-11-22 主支线合并条目收成员线 id 用）
      for (const t of ent.terms || []) if (t != null && t !== '') cands.push(String(t));
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

  // 多选分期的纯逻辑：全选视作总览（不启用分期），其余集合按每段状态判断。
  const PHASE_VALUES = ['existing', 'approved', 'future'];
  function normalizePhaseSelection(values) {
    const src = values instanceof Set ? [...values] : (Array.isArray(values) ? values : []);
    return new Set(src.map(String).filter((v) => PHASE_VALUES.includes(v)));
  }
  function phaseSelectionActive(values) { return normalizePhaseSelection(values).size !== PHASE_VALUES.length; }
  function phaseStatusSelected(status, values) {
    const selected = normalizePhaseSelection(values);
    return selected.size === PHASE_VALUES.length || selected.has(String(status));
  }
  // 按原整线拼接几何的累计 WebMercator 长度，为各 segIndex 计算 line-progress 区间。
  // 可传入已变换坐标（如 dispCoord），使长度口径与实际绘制几何一致。
  function segmentProgressRanges(segments, transformedSegments) {
    const src = Array.isArray(segments) ? segments : [];
    const transformed = Array.isArray(transformedSegments) ? transformedSegments : null;
    const lengths = src.map((seg, index) => {
      const input = transformed ? transformed[index] : seg;
      const pts = Array.isArray(input) ? input : (input && Array.isArray(input.coords) ? input.coords : []);
      const valid = pts.filter((pt) => Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1]));
      let length = 0;
      for (let i = 1; i < valid.length; i++) {
        const latA = Math.max(-85.05112878, Math.min(85.05112878, valid[i - 1][1])) * Math.PI / 180;
        const latB = Math.max(-85.05112878, Math.min(85.05112878, valid[i][1])) * Math.PI / 180;
        const mercatorY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat / 2));
        length += Math.hypot((valid[i][0] - valid[i - 1][0]) * Math.PI / 180,
          mercatorY(latB) - mercatorY(latA));
      }
      return length;
    });
    const total = lengths.reduce((sum, length) => sum + length, 0);
    let offset = 0;
    return src.map((seg, i) => {
      const start = total > 0 ? offset / total : 0;
      offset += lengths[i];
      return { segIndex: seg && seg.segIndex != null ? seg.segIndex : i,
        start, end: total > 0 ? offset / total : 1 };
    });
  }
  function phaseSegments(segments, values) {
    return (Array.isArray(segments) ? segments : []).filter((seg) => phaseStatusSelected(seg && seg.segStatus, values));
  }
  // 站点状态：显式覆盖优先；否则取相邻区段中较早的分期。
  function stopPhaseOf(line, stop, stops) {
    if (stop && PHASE_VALUES.includes(stop.stopStatus)) return stop.stopStatus;
    if (!line || !stop || !Array.isArray(line.segments) || !line.segments.length) return null;
    let stopIndex = Number.isInteger(stop.stopIndex) && stop.stopIndex >= 0 ? stop.stopIndex : null;
    if (stopIndex == null) {
      // 旧版 net 缺 stopIndex 时，仅在线段数未受隐藏线路所影响时回推原始站序。
      const ordered = (Array.isArray(stops) ? stops : []).filter((s) => s && s.lineId === stop.lineId)
        .sort((a, b) => (a.t == null ? 1 : 0) - (b.t == null ? 1 : 0) || num(a.t) - num(b.t));
      const at = ordered.findIndex((s) => s.sid === stop.sid);
      if (at < 0) return null;
      const expected = line.loop ? ordered.length : Math.max(0, ordered.length - 1);
      if (line.segments.length !== expected) return null;
      stopIndex = at;
    }
    const byIndex = new Map(line.segments.map((seg) => [seg.segIndex, seg]));
    const adjacent = [];
    const outgoing = byIndex.get(stopIndex);
    if (outgoing) adjacent.push(outgoing);
    const incomingIndex = stopIndex - 1 >= 0 ? stopIndex - 1 : (line.loop ? line.segments.length - 1 : -1);
    const incoming = incomingIndex >= 0 ? byIndex.get(incomingIndex) : null;
    if (incoming) adjacent.push(incoming);
    if (!adjacent.length) return null;
    const rank = { existing: 0, approved: 1, future: 2 };
    adjacent.sort((a, b) => (Object.prototype.hasOwnProperty.call(rank, a.segStatus) ? rank[a.segStatus] : 3)
      - (Object.prototype.hasOwnProperty.call(rank, b.segStatus) ? rank[b.segStatus] : 3));
    return adjacent[0].segStatus;
  }

  // ---------- 标签分级（zoom 门槛层；上层优先级见 visibleLabels） ----------
  // 换乘组/出闸换乘标签 z≥10 渐显；普通单线站 z≥11 渐显。标签的 group/groupType
  // 来自结构关系字段，不依赖站名文字；不设总数上限，视口裁剪由渲染层处理。
  // 2026-11-22 删 cap 入参与 LABEL_CAP（见常量区注）：数据量再大也不砍普通站名。
  function filterLabels(labels, zoom) {
    const arr = Array.isArray(labels) ? labels : [];
    if (zoom >= LABEL_ZOOM_STOP) return arr;
    if (zoom >= LABEL_ZOOM_GROUP) return arr.filter((l) => l && (l.group || l.groupType));
    return [];
  }

  // ---------- 标签可见性（优先级：全局站名开关 ＞ 聚焦常显·其余隐藏 ＞ 车站态单显 ＞ 被调光线隐藏 ＞ zoom 门槛） ----------
  // state：{ hideAll: 全局站名开关（true＝一切站名不显示，优先级最高）,
  //          dimmedSet: Set<lineId> 被调光线集, focus: 聚焦 lineId|null,
  //          focusMembers: 聚焦组成员线 id 数组（可选——2026-11-22 主支线合并后支线站的
  //                        站名也是聚焦线站名，须常显；缺省/空/全脏退 [focus]）,
  //          stationKey: 车站态被点站/组标签 key（可选，2026-11-27 用户裁定——点击车站
  //                        高亮态：只有该 pin 的标签显示、常显无视 zoom 门槛与调光，其余
  //                        一切站名隐藏；与聚焦互斥〔胶水层仅在 S.station 激活且无聚焦时
  //                        传入〕；hideAll 全局开关仍压过它）,
  //          displayOnlyIds: 他省线 id 集（可选，2026-11-25 纠正裁定——分期态他省线站名
  //                        照常显示：全部成员线为他省的标签不受「被调光线隐藏」约束，
  //                        只走 zoom 门槛；混合单元仍按本地成员规则）}。
  // 2026-11-22 真机反馈改版（用户「站名也没有隐去」）：聚焦时非聚焦线的站名一律隐藏
  //（恢复旧调光模式的待遇——白罩只罩图形，站名维度由本函数承接）；聚焦组成员的标签
  // 常显且无视分期调光与 zoom 门槛。非聚焦时维持既有两级：调光隐藏
  //（组标签全部成员线被调光才隐藏，任一成员未调光则显示；无所属线信息的标签防御性
  // 不因调光隐藏）→ zoom 门槛。
  // 2026-11-27 车站态单显（用户裁定）：stationKey 命中的标签唯一显示（常显——zoom 门槛/
  // 调光/分期全让位），其余隐藏；进车站态时分期已解除（labelNotHidden 纯防御位，与聚焦
  // 分支同构）。
  function labelHasFocus(l, members) {
    const ids = Array.isArray(l.lineIds) ? l.lineIds : [];
    for (const m of members) if (ids.indexOf(m) >= 0) return true;   // 任一成员命中 → 聚焦参与
    return false;
  }
  function labelShownUnderDim(l, dimSet) {
    const ids = Array.isArray(l.lineIds) ? l.lineIds : [];
    if (!ids.length) return true;                              // 无所属线信息（防御）→ 不因调光隐藏
    for (const id of ids) if (!dimSet.has(id)) return true;    // 任一成员线未调光 → 显示
    return false;                                              // 全部成员线被调光 → 隐藏
  }
  function stopUnitMatchesPhase(stopPhaseMembers, phase, dimmedSet) {
    if (!phase || !Array.isArray(stopPhaseMembers) || !stopPhaseMembers.length) return null;
    const dimmed = dimmedSet instanceof Set ? dimmedSet : new Set(Array.isArray(dimmedSet) ? dimmedSet.map(String) : []);
    return stopPhaseMembers.some((m) => m && (m.status ? m.status === phase : !dimmed.has(String(m.lineId || ''))));
  }
  function visibleLabels(labels, zoom, state) {
    const st = state || {};
    if (st.hideAll) return [];
    const dimSet = st.dimmedSet instanceof Set ? st.dimmedSet
      : new Set(Array.isArray(st.dimmedSet) ? st.dimmedSet.map(String) : []);
    const arr = Array.isArray(labels) ? labels.filter(Boolean) : [];
    const focus = st.focus != null && st.focus !== '' ? String(st.focus) : null;
    const stationKey = st.stationKey != null && st.stationKey !== '' ? String(st.stationKey) : null;
    const phase = st.phase && st.phase !== 'none' ? st.phase : null;
    const hiddenLineIds = st.hiddenLineIds instanceof Set ? st.hiddenLineIds : new Set(Array.isArray(st.hiddenLineIds) ? st.hiddenLineIds.map(String) : []);
    const displayOnlySet = st.displayOnlyIds instanceof Set ? st.displayOnlyIds
      : new Set(Array.isArray(st.displayOnlyIds) ? st.displayOnlyIds.map(String) : []);
    const labelNotHidden = (l) => {
      const ids = Array.isArray(l.lineIds) ? l.lineIds : [];
      return !phase || !ids.length || ids.some((id) => !hiddenLineIds.has(String(id)));
    };
    // 他省纯单元（全部成员线为他省）：不受调光隐藏约束（2026-11-25——分期态他省线站名
    // 照常显示；无成员线信息的标签不算，防御位交给 labelShownUnderDim 的空 ids 分支）
    const labelDisplayOnly = (l) => {
      const ids = Array.isArray(l.lineIds) ? l.lineIds : [];
      return ids.length > 0 && ids.every((id) => displayOnlySet.has(String(id)));
    };
    const stopMatches = (l) => {
      if (l.stopPhaseMembers) return stopUnitMatchesPhase(l.stopPhaseMembers, phase, dimSet);
      if (l.stopStatus && phase) return l.stopStatus === phase;
      return null;
    };
    if (focus) {
      // 聚焦组成员集（脏项过滤；空集退 [focus]——S.focus 恒主线 id，胶水层无组时同此）
      let members = Array.isArray(st.focusMembers)
        ? st.focusMembers.map((m) => (m != null ? String(m) : '')).filter(Boolean) : [];
      if (!members.length) members = [focus];
      // 聚焦优先级：成员标签常显（无视分期调光与 zoom 门槛——分期态下聚焦组照显、
      // 其余隐藏，分期隐藏维度在聚焦时整体让位），其余标签一律隐藏
      return arr.filter((l) => labelHasFocus(l, members) && labelNotHidden(l));
    }
    // 车站态单显（2026-11-27 用户裁定）：只有被点站/组 pin 的标签显示——常显（无视
    // zoom 门槛与调光），其余一切站名隐藏。正常与聚焦互斥（胶水层不同时传）；
    // 二者并传时聚焦在前已 return，此处仅在无聚焦时到达（防御序：对齐优先级注释）。
    if (stationKey) return arr.filter((l) => String(l.key) === stationKey && labelNotHidden(l));
    return filterLabels(arr.filter((l) => labelNotHidden(l)
      && (labelDisplayOnly(l) || (stopMatches(l) === null ? labelShownUnderDim(l, dimSet) : stopMatches(l)))), zoom);
  }

  // ---------- 调光纯逻辑（2026-11-22 改版：分期四档＋聚焦双模式，任一条件调光即调光） ----------
  // 线路期次归类：全线最先进段（existing ＞ approved ＞ future；未知段状态 rank 最低）。
  // 无段的线返回 null（理论上 normalizeLines 产出的线至少一段，防御位）。
  function linePhaseOf(line) {
    let best = null, bestRank = -1;
    for (const seg of (line && line.segments) || []) {
      const r = Object.prototype.hasOwnProperty.call(SEG_STATUS_RANK, seg && seg.segStatus)
        ? SEG_STATUS_RANK[seg.segStatus] : 0;
      if (r > bestRank) { bestRank = r; best = seg.segStatus; }
    }
    return best;
  }

  // 线路分类层级（集中判断）：他省线仍参与普通聚焦与点击交互；其特殊规则仅由
  // computeDimmedSet 保留为调光场合恒半透明，不影响可见性、分类数据或其他交互行为。
  function lineLayerRank(line) {
    const layer = line && typeof line.layer === 'string' ? line.layer : '';
    return DISPLAY_ONLY_LAYERS.indexOf(layer) >= 0 ? 'displayOnly' : 'normal';
  }

  // 虚线位（2026-11-23 用户需求）：预控通道画虚线——0/1 数字位写入渲染特征属性 dash，
  // 滤镜一律显式 ['==', ['get','dash'], 0/1]（对齐 big/dark 的 0/1 数字约定；'!' 吃数字
  // 判类型错致静默弃层的坑，见 viewer.js STOP_LAYER_DEFS 注）。
  function lineDashed(line) {
    const layer = line && typeof line.layer === 'string' ? line.layer : '';
    return DASHED_LAYERS.indexOf(layer) >= 0 ? 1 : 0;
  }
  // ---------- 地图单击聚焦（2026-11-27 用户裁定，取代 2026-11-26 单击轻提示） ----------
  // 两个纯判定供胶水层 click/cursor 共用：
  // isLineHitLayerId——渲染层 id 是否线身层（见 LINE_HIT_LAYER_IDS 注）；
  // lineClickAction——线路是否可聚焦目标：联络线（类别名命中 HIDDEN_LIST_LAYERS 或带
  // **非空** connects——技术线路不可聚焦）与他省线（displayOnly——纯背景是既定裁定）
  // 一律 'silent'，其余 'focus'。⚠ 联络线判定必须「非空」：normalizeLines 对一切线保留
  // connects 键（flatten 键齐输出、非联络线为空数组），旧轻提示版按 Array.isArray 判——
  // 空数组也命中 → 真数据所有线被判联络线而静默＝2026-11-26 真机「单击线路无反应」的
  // 真根因（与委托/层生命周期无关）。分期态「单击一律无效」是会话态判定，留在胶水层
  //（不进纯逻辑）；支线→主线归一由胶水层 lineGroups.mainOf 承担。
  function isLineHitLayerId(layerId) {
    if (typeof layerId !== 'string') return false;
    if (LINE_HIT_LAYER_IDS.indexOf(layerId) >= 0) return true;
    for (let i = 0; i < LINE_HIT_LAYER_PREFIXES.length; i++) {
      if (layerId.indexOf(LINE_HIT_LAYER_PREFIXES[i]) === 0) return true;
    }
    return false;
  }
  function lineClickAction(line) {
    if (!line) return 'silent';
    const connects = Array.isArray(line.connects) ? line.connects : [];
    if (HIDDEN_LIST_LAYERS.indexOf(line.layer) >= 0 || connects.length > 0) return 'silent';
    if (lineLayerRank(line) === 'displayOnly') return 'silent';
    return 'focus';
  }

  // ---------- 地图单击车站（2026-11-27 用户裁定：点车站＝flyTo＋多线高亮＋面板车站页） ----------
  // 站圈/药丸渲染层 id 名单（基础五层＋罩上复制 -focus 变体）：点车站的命中层（「点击点
  // 同时命中站圈与线身时站圈优先」——胶水层先扫本名单再扫线身层）。白罩/线身/省界/底图
  // 不在内（线身层见 LINE_HIT_LAYER_IDS）。
  const STOP_HIT_LAYER_IDS = ['stops', 'stops-dark', 'stops-big', 'pills-outer', 'pills-inner',
    'stops-focus', 'stops-dark-focus', 'stops-big-focus', 'pills-outer-focus', 'pills-inner-focus'];
  function isStopHitLayerId(layerId) {
    return typeof layerId === 'string' && STOP_HIT_LAYER_IDS.indexOf(layerId) >= 0;
  }
  // 车站交互内核（2026-11-27 实装＋同日修正裁定：他省线参与、联络线只亮不列名）。
  // 成员站口径（统一，一个规则覆盖一切 pin 形态）：pin 带组（kind==='group' 或 groupId
  // 非空）→ **最外层组**的全部叶站（tree.leafStops(tree.rootOf(gid))——同站组/junction/
  // 嵌套组/出闸单元（含其直属站与各子组叶站）全覆盖：点组符号与点出闸单元的任何成员圈
  // 都是「整个换乘单元的线路集合」）；无组单站 → 本站（按 sid 从站表取，arrow 非站除外）。
  // 自然线路口径：每成员站的本线归一到主线（lineGroups——主支线算一条）；**联络线剔除**
  //（layer 命中 HIDDEN_LIST_LAYERS 或 connects 非空——「技术线路名称不得出现在任何地方」
  // 钉死规则，车站页不列名；其地图高亮由渲染层按 connects∩高亮成员另行走 conn-fade 渐变，
  // 不进本集合）；**他省线保留**（2026-11-27 修正裁定：进高亮集＋车站页列表行，渲染走
  // 聚焦态他省既有口径——罩上显示/恒调光、不进期次高亮）。孤站（lineId 不在 linesMap）
  // 按普通线保留（防御：站表与线表不同步时不丢站）。
  // 排序：lineOrder 自定义序优先、未列入者按 lineId 升序（与 layerGroups 同 tie-break）。
  function stationMemberStops(pin, tree) {
    if (!pin) return [];
    const key = pin.key != null ? String(pin.key) : '';
    const gid = (pin.groupId != null && pin.groupId !== '') ? String(pin.groupId) : null;
    const gidFromKey = key.indexOf('g:') === 0 ? key.slice(2) : null;
    const group = gid || gidFromKey;
    if (group && tree && typeof tree.group === 'function' && tree.group(group)
      && typeof tree.leafStops === 'function' && typeof tree.rootOf === 'function') {
      const leaf = tree.leafStops(tree.rootOf(group) || group);   // 最外层组的全部叶站
      if (leaf.length) return leaf;
    }
    if (gidFromKey) return [];   // 组 key 无 sid 可退（无叶站的组不出图形，防御空集）
    // 无组单站：从 pin 自身合成（name/lineId 即本站本线——站表不必在场）
    return [{ sid: key, name: typeof pin.name === 'string' ? pin.name : '',
      lineId: pin.lineId != null ? String(pin.lineId) : '' }];
  }
  // stopPinKeyOf(stop, tree) → 该站绘制单元的 pin key（2026-11-27 线路页站行点进车站页：
  // lineStopSections 的 row 只有 sid，需反查 pin 再走 enterStationByPin 同款行为）。
  // 口径与 buildStopView 的 emitUnit 出图完全一致：无组/组不在树 → 站 sid（单站 pin）；
  // 自最外层组沿祖先链向下模拟 emitUnit 递归——首个非出闸单元（same-station/junction，
  // 药丸与带子组单元整体一个符号、子组不独立出图）＝组 pin 'g:<组号>'；出闸单元只对
  // 直属站出单站 pin（sid），子组继续下钻。返回 null＝无 sid 防御（调用方静默不动作）。
  // 与渲染层 pinByKey 联用取回完整 pin。
  function stopPinKeyOf(stop, tree) {
    const sid = stop && stop.sid != null ? String(stop.sid) : null;
    if (!sid) return null;
    const gid = stop && stop.groupId != null && stop.groupId !== '' ? String(stop.groupId) : null;
    if (!gid || !tree || typeof tree.group !== 'function' || !tree.group(gid)
        || typeof tree.typeOf !== 'function' || typeof tree.parentOf !== 'function') return sid;
    const chain = [];   // 直属组 → … → 最外层组（parentOf 到顶即 root；环防御不重复入链）
    for (let p = gid; p != null && chain.indexOf(p) < 0; p = tree.parentOf(p)) chain.push(p);
    chain.reverse();
    let cur = chain[0];
    for (let i = 0; i < chain.length; i++) {
      if (tree.typeOf(cur) !== 'out-of-station') return 'g:' + cur;   // 整体绘制单元
      if (cur === gid) return sid;   // 出闸单元直属站＝单站圈
      cur = chain[i + 1];            // 站在子组内：下钻一层
    }
    return sid;
  }
  // stationLinesOf(pin, linesMap, lineGroups, tree) → 主线 id 数组（lineOrder 序不在本函数——
  // 排序是面板呈现口径，见 stationFocusOf；本函数返回 linesMap 迭代序的去重主线集，
  // 供点击判定/hover 等只关心「有没有、有哪几条」的场合）。空数组＝该站无自然线路
  //（纯联络线站/脏数据）→ 不可点。
  function stationLinesOf(pin, linesMap, lineGroups, tree) {
    const lg = lineGroups && lineGroups.ofLine instanceof Map ? lineGroups : null;
    const lookup = linesMap instanceof Map ? linesMap : null;
    const mainOf = (lid) => {
      if (lg) {
        const m = lg.mainOf.get(lid);
        if (m != null) return m;
        const g = lg.ofLine.get(lid);
        if (g) return g.mainId;
      }
      return lid;
    };
    const isTechnical = (lid) => {
      const l = lookup ? lookup.get(lid) : null;
      if (!l) return false;   // 孤站线不在 linesMap：按普通线保留（防御，不丢站）
      const conn = Array.isArray(l.connects) ? l.connects : [];
      return HIDDEN_LIST_LAYERS.indexOf(l.layer) >= 0 || conn.length > 0;
    };
    const out = [];
    const seen = new Set();
    for (const s of stationMemberStops(pin, tree)) {
      const lid = s && s.lineId != null ? String(s.lineId) : '';
      if (!lid || isTechnical(lid)) continue;
      const mid = String(mainOf(lid));
      if (!mid || seen.has(mid)) continue;
      seen.add(mid);
      out.push(mid);
    }
    return out;
  }
  // stationFocusOf(pin, linesMap, lineGroups, tree, lineOrder) → null | 车站页上下文：
  //   { key, name, lon, lat,
  //     lines: [{ mainId, name, color, members: [成员线 id…], calls: [该线对此站的叫法…] }]
  //        ——一行一自然线路（含他省线；联络线不出现），name/color 取主线（组名优先），
  //        calls＝该线组成员站的站名去重（一站多名时面板逐行标注，「全列出」），
  //     memberIds: [全部高亮线组成员并集]——渲染层 veilSkip/focus-copy/标签常显共用，
  //     multiName: 全部行的 calls 并集 >1 个不同名（单名站不标注） }
  // name＝pin.name（组 pin＝首个非空叶站名、单站＝本站名；空名由显示层 stopDisplayName 兜底）；
  // lon/lat＝pin 坐标（组 pin 已是成员均值）。lineOrder 排序＋tie-break 与 stationLinesOf 注同源。
  function stationFocusOf(pin, linesMap, lineGroups, tree, lineOrder) {
    const lg = lineGroups && lineGroups.ofLine instanceof Map ? lineGroups : null;
    const lookup = linesMap instanceof Map ? linesMap : null;
    const mainOf = (lid) => {
      if (lg) {
        const m = lg.mainOf.get(lid);
        if (m != null) return m;
        const g = lg.ofLine.get(lid);
        if (g) return g.mainId;
      }
      return lid;
    };
    const isTechnical = (lid) => {
      const l = lookup ? lookup.get(lid) : null;
      if (!l) return false;
      const conn = Array.isArray(l.connects) ? l.connects : [];
      return HIDDEN_LIST_LAYERS.indexOf(l.layer) >= 0 || conn.length > 0;
    };
    const byMain = new Map();   // mainId → { stops: [], lineIds: Set }
    for (const s of stationMemberStops(pin, tree)) {
      const lid = s && s.lineId != null ? String(s.lineId) : '';
      if (!lid || isTechnical(lid)) continue;
      const mid = String(mainOf(lid));
      let e = byMain.get(mid);
      if (!e) { e = { stops: [], lineIds: new Set() }; byMain.set(mid, e); }
      e.stops.push(s);
      e.lineIds.add(lid);
    }
    if (!byMain.size) return null;
    const rank = new Map();
    if (Array.isArray(lineOrder)) {
      lineOrder.forEach((id, i) => { const k = String(id); if (!rank.has(k)) rank.set(k, i); });
    }
    const ids = [...byMain.keys()].sort((a, b) => {
      const ra = rank.has(a) ? rank.get(a) : Infinity, rb = rank.has(b) ? rank.get(b) : Infinity;
      return ra !== rb ? ra - rb : (a < b ? -1 : a > b ? 1 : 0);
    });
    const lines = ids.map((mid) => {
      const e = byMain.get(mid);
      const grp = lg ? lg.ofLine.get(mid) : null;
      const line = lookup ? lookup.get(mid) : null;
      const members = grp && Array.isArray(grp.members) && grp.members.length ? grp.members.slice() : [mid];
      const calls = [];
      for (const s of e.stops) {
        if (typeof s.name === 'string' && s.name && calls.indexOf(s.name) < 0) calls.push(s.name);
      }
      return {
        mainId: mid,
        name: grp ? (grp.name || (line && line.name) || mid) : ((line && line.name) || mid),
        color: line ? line.color : DEFAULT_LINE_COLOR,
        members: members.map(String),
        calls,
      };
    });
    const allNames = new Set();
    for (const l of lines) for (const c of l.calls) allNames.add(c);
    const memberIds = [];
    const seenIds = new Set();
    for (const l of lines) {
      for (const x of l.members) {
        if (!seenIds.has(x)) { seenIds.add(x); memberIds.push(x); }
      }
    }
    return {
      key: pin.key != null ? String(pin.key) : '',
      name: typeof pin.name === 'string' ? pin.name : '',
      lon: num(pin && pin.lon), lat: num(pin && pin.lat),
      lines, memberIds,
      multiName: allNames.size > 1,
    };
  }
  // 多线（车站高亮）取景 bbox（2026-11-27）：各高亮线（组员并集）渲染 bbox 联合 ∪ 绑定
  // 联络线（fadeConnPlan）渲染 bbox——focusBboxOf 的集合版，联络线并入口径完全同源
  //（病灶①教训见 focusBboxOf 注）。当前相机动作＝flyTo 车站点（任务书行为 1），本函数为
  // 车站高亮内核的 bbox 能力（后续取景/验证用），单测覆盖。
  function focusBboxOfSet(dispBbox, lineGroups, focusIds, fadeConnPlan) {
    const lg = lineGroups && lineGroups.ofLine instanceof Map ? lineGroups : null;
    const seen = new Set();
    const ids = [];
    for (const raw of Array.isArray(focusIds) ? focusIds : []) {
      const id = raw != null ? String(raw) : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);   // 主线自身（组员循环的去重基准，勿并入其内）
      const grp = lg ? lg.ofLine.get(id) : null;
      const members = grp && Array.isArray(grp.members) && grp.members.length ? grp.members : [id];
      for (const m of members) {
        const k = String(m);
        if (!seen.has(k)) { seen.add(k); ids.push(k); }
      }
    }
    const into = (bb, id) => {
      const b = dispBbox instanceof Map && id != null ? dispBbox.get(id) : null;
      if (!b) return bb;
      if (!bb) return [b[0], b[1], b[2], b[3]];
      return [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])];
    };
    let bb = null;
    for (const id of ids) bb = into(bb, id);
    for (const it of fadeConnPlan || []) {
      if (it && it.lineId != null) bb = into(bb, it.lineId);
    }
    return bb;
  }


  // 调光线集：state＝{ phase: 'none'|'existing'|'approved'|'future', focus: lineId|null,
  //                   lineGroups: buildLineGroups 产物（可选，缺省＝逐线旧行为） }。
  // 2026-11-22 白罩定案（用户确认遮罩 70%、删全部对比开关与旧调光路径）：聚焦不再贡献
  // dim、也不再走组豁免——聚焦高亮恒由渲染层白罩＋聚焦重画层呈现（聚焦组成员从基础层
  // 剔除、罩上重画恒原色），非聚焦线不调光不隐站名（「全都不动」）。focus 字段仅剩一职：
  // 「调光场合激活位」——他省线（displayOnly）在任何调光场合（phase 或 focus 任一激活）
  // 恒入调光集（既有独立裁定，与高亮方式无关，即便期次恰好匹配）。
  // 分期非「无」档：期次不匹配的线调光——现唯一的 dim 源。默认态（无分期＋无聚焦）不调光，
  // displayOnly 正常显示。
  // 2026-11-22 主支线合并（用户裁定）：组级调光——有效组成员的期次态/仅显示级判定一律以
  // 主线为准（「其余没考虑到的都以主线为准」），组全体同调同不调。无 main 的组不经
  // lineGroups 进入（buildLineGroups 已滤），组员照旧逐线判定。
  function computeDimmedSet(linesMap, state) {
    const dim = new Set();
    const st = state || {};
    const phase = st.phase && st.phase !== 'none' ? st.phase : null;
    const focus = st.focus != null && st.focus !== '' ? String(st.focus) : null;
    if (!phase && !focus) return dim;
    const lines = linesMap instanceof Map ? [...linesMap.values()]
      : (Array.isArray(linesMap) ? linesMap : []);
    const lg = st.lineGroups && st.lineGroups.ofLine instanceof Map ? st.lineGroups : null;
    const getById = linesMap instanceof Map
      ? (id) => linesMap.get(id)
      : (id) => lines.find((l) => l && String(l.lineId) === id) || null;
    for (const line of lines) {
      if (!line || line.lineId == null) continue;
      const id = String(line.lineId);
      const grp = lg ? lg.ofLine.get(id) : null;
      const ref = grp ? (getById(grp.mainId) || line) : line;     // 组判定基准线＝主线
      if (lineLayerRank(ref) === 'displayOnly') { dim.add(id); continue; }
      if (phase && linePhaseOf(ref) !== phase) dim.add(id);   // 分期不匹配＝唯一 dim 源
    }
    return dim;
  }

  // ---------- 深图态高亮策略（2026-11-27 用户裁定：卫星/用地图两态改降透明度法） ----------
  // 浅色底图（高德/无字高德/OSM）的白罩法不变；深图类（planblock/shanghai_W）高亮时白罩
  // 不动（底图遮罩恒常态档、focus-veil 白罩不出），对比改用其他线路不透明度——非高亮线
  // line-opacity 0.5（＝DIM_OPACITY，复用既有 dim 通路，不另起炉灶）。两个纯逻辑：
  // ①deepHighlightDimIds——深图态高亮时 dim 定义域扩展：除「高亮豁免集」（聚焦/车站成员）
  //   外全部线 id 并入调光集；skipIds 空/null＝无豁免（分期态）。输入兼容 Map/数组（对齐
  //   computeDimmedSet），脏线（无 lineId）跳过。
  function deepHighlightDimIds(linesMap, skipIds) {
    const out = [];
    const lines = linesMap instanceof Map ? [...linesMap.values()]
      : (Array.isArray(linesMap) ? linesMap : []);
    const skip = skipIds instanceof Set ? skipIds
      : new Set(Array.isArray(skipIds) ? skipIds.map((m) => (m != null ? String(m) : '')).filter(Boolean) : []);
    for (const line of lines) {
      if (!line || line.lineId == null) continue;
      const id = String(line.lineId);
      if (!skip.has(id)) out.push(id);
    }
    return out;
  }
  // ②deepPhaseDimBit——深图态分期态的段级 dim 位（「严格按区段」裁定在深图态的落点）：
  //   选中期段 0（罩上重画层全亮覆盖底线）、未选段 1（0.5）；他省线不参与期次（恒调光
  //   2026-11-25 裁定照旧——整线各段恒 1，由线级 dim 兜底，此处显式返回防调用方漏判）。
  //   phases 兼容 Set/数组。
  function deepPhaseDimBit(line, segStatus, phases) {
    if (lineLayerRank(line) === 'displayOnly') return 1;
    const set = phases instanceof Set ? phases
      : new Set(Array.isArray(phases) ? phases.filter((p) => p != null) : []);
    return set.has(segStatus) ? 0 : 1;
  }

  // 分期四档循环推进：'none' → 'existing' → 'approved' → 'future' → 'none'（非法输入回 'none'）
  function nextPhase(cur) {
    const i = PHASE_CYCLE.indexOf(cur);
    return PHASE_CYCLE[((i < 0 ? 0 : i) + 1) % PHASE_CYCLE.length];
  }

  // 主界面三选项卡切换方向（2026-11-27 动效）：order＝tab 序（HTML 按钮序，市区线/市域线/
  // 预控通道），from/to＝tab 名。返回 1＝前进（新列表自右滑入）、-1＝反向（自左）、
  // 0＝同名或任一不在序表内（不动，防御他省/联络线等不进列表的类别名）。
  function tabSwapDir(order, from, to) {
    if (from === to) return 0;
    const i = order.indexOf(from), j = order.indexOf(to);
    if (i < 0 || j < 0) return 0;
    return j > i ? 1 : -1;
  }

  // ---------- 尺寸随缩放等比表达式（z≥11 恒基准封顶、z<11 按 2^(z−11) 等比缩小） ----------
  // zoomInterp(sizeLow, sizeHigh)：构造 ['interpolate',['exponential',2],['zoom'], 5, 低端, 11, 高端]；
  // 两端自动 clamp（z≤5 恒低端、z≥11 恒高端——高端即「向上封顶」，拉近不变粗）。
  // scaledSize(base)：基准 ×2^(5−11)＝基准/64，两位小数舍入防浮点噪声。
  function zoomInterp(sizeLow, sizeHigh) {
    return ['interpolate', ['exponential', SIZE_SCALE_EXP], ['zoom'],
      SIZE_ZOOM_MIN, sizeLow, SIZE_ZOOM_HOLD, sizeHigh];
  }
  function scaledSize(base) {
    return Math.round(base * Math.pow(SIZE_SCALE_EXP, SIZE_ZOOM_MIN - SIZE_ZOOM_HOLD) * 100) / 100;
  }
  // labelScale(zoom)：站名文字（HTML 标签）的同一缩放规则——z≥11 封顶 1、z<11 按 2^(z−11)
  // 等比（2026-11-22 用户指示「站名和站点也一样，以 z11 为界」；站点圈走 zoomInterp 同规则）。
  function labelScale(zoom) {
    if (zoom == null) return 1;
    var z = Number(zoom);
    if (!Number.isFinite(z)) return 1;
    return Math.min(1, Math.pow(SIZE_SCALE_EXP, z - SIZE_ZOOM_HOLD));
  }

  // ---------- 地图双击线路精确命中（2026-11-22 用户反馈：只认直接点到线体描边） ----------
  // 背景：dblclick 里 queryRenderedFeatures 对线层的命中带 MapLibre tile 几何 buffer，
  // 离线体较远的空白处双击也会触发聚焦跳转——粗筛只拿候选 features，最终命中以屏幕像素
  // 距离为准（胶水层把候选 feature 坐标逐点 map.project 后喂本段纯函数判定）。
  // 线宽基准常量：lineLayerDef / connFadeLayerDef 的 'line-width' 均为
  // zoomInterp(scaledSize(LINE_WIDTH_PX), LINE_WIDTH_PX)——数值唯一源在此处导出，
  // 渲染层引用之（严禁复制魔法数字造成两处漂移）。
  const LINE_WIDTH_PX = 7;
  // 双击命中容差（像素，占位可调）：命中阈值＝lineWidthAt(zoom)/2 ＋ 本容差
  const DBLCLICK_TOL_PX = 2;
  // lineWidthAt(zoom)：当前 zoom 的实际线宽像素，与 zoomInterp 表达式同源求值——低端锚
  // scaledSize（同两位小数舍入）、高端＝基准值、中间按 MapLibre exponential 插值同式
  //（interpolationFactor(base)＝(base^t−1)/(base−1)，base=2 即 2^t−1；t＝(z−zmin)/(zhold−zmin)，
  // 值＝lo＋factor×(hi−lo)），两端 clamp 与 interpolate 原生行为一致。异常输入退基准值（防御）。
  function lineWidthAt(zoom) {
    const hi = LINE_WIDTH_PX;
    // null/undefined/非数值退基准值（⚠ Number(null)＝0 会伪装成有效低 zoom，须先判空）
    const z = zoom == null ? NaN : Number(zoom);
    if (!Number.isFinite(z)) return hi;
    if (z <= SIZE_ZOOM_MIN) return scaledSize(hi);
    if (z >= SIZE_ZOOM_HOLD) return hi;
    const t = (z - SIZE_ZOOM_MIN) / (SIZE_ZOOM_HOLD - SIZE_ZOOM_MIN);
    const lo = scaledSize(hi);
    return lo + (Math.pow(SIZE_SCALE_EXP, t) - 1) * (hi - lo);
  }
  // pointToScreenPolylineDist(point, screenCoords)：点到折线的最小屏幕距离（像素）。
  // point＝{x,y}；screenCoords＝[[x,y],…]（候选 feature 坐标逐点 map.project 所得）。
  // 逐段取垂距，垂足夹到段内（t∈[0,1]——垂足落在段延长线外时自然退化为端点距离）；
  // 多段取全段最小。坏点（非数组/非有限数）跳过；仅一个有效点 → 到该点距离；
  // 无有效点 / point 非法 → Infinity（必然不命中，胶水层按阈值放行原生双击缩放）。
  function pointToScreenPolylineDist(point, screenCoords) {
    // ⚠ Number(null)＝0 会把 null point 伪装成 (0,0) 参与求距，须先判空（undefined 经
    // Number 得 NaN 自然落入下方非有限守卫；坐标分量同理）
    const px = point == null ? NaN : Number(point.x);
    const py = point == null ? NaN : Number(point.y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return Infinity;
    let best = Infinity;
    let ax = null, ay = null;   // 折线游标＝上一有效点
    for (const c of Array.isArray(screenCoords) ? screenCoords : []) {
      if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
      const bx = c[0], by = c[1];
      if (ax == null) { ax = bx; ay = by; continue; }
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.min(1, Math.max(0, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best) best = d;
      ax = bx; ay = by;
    }
    if (best === Infinity && ax != null) return Math.hypot(px - ax, py - ay);   // 单有效点退化
    return best;
  }

  // ---------- 左栏列表分组＋类别过滤 ----------
  // 在 layerGroups 之上套 HIDDEN_LIST_LAYERS 过滤（列表不显示、地图照画、搜索照收）；
  // 类别缺失（layer 为空串）不过滤。空隐藏集＝原样返回。lineGroups 透传（主支线合并行）。
  function visibleListGroups(linesMap, hiddenList, lineOrder, lineGroups) {
    const hid = new Set((Array.isArray(hiddenList) ? hiddenList : []).map(String));
    if (!hid.size) return layerGroups(linesMap, lineOrder, lineGroups);
    return layerGroups(linesMap, lineOrder, lineGroups)
      .map((g) => ({ layer: g.layer, lines: g.lines.filter((l) => !hid.has(String(l && l.layer || ''))) }))
      .filter((g) => g.lines.length);
  }

  // ---------- 主支线合并的搜索条目（2026-11-22 用户裁定：搜索命中同一条线） ----------
  // lineSearchEntries(linesMap, lineGroups)：线路搜索条目数组——无组/无效组线照旧
  // {type:'line', id, text:name, aliases}；有效组合并为一个条目：id＝主线 id（选中行为
  // ＝聚焦主线＋开信息面板），text＝组名，主线与支线的 name＋aliases 全部入 aliases
  //（可命中、且在下拉副行可见），成员线 id（主线＋支线）入 terms——只参与匹配不进副行
  //（id 列进副行会淹没有效信息），matchEntries 已支持 terms。非主线成员不单独出条目。
  // ref（summary）由胶水层回填。
  function lineSearchEntries(linesMap, lineGroups) {
    const lg = lineGroups && lineGroups.ofLine instanceof Map ? lineGroups : null;
    const lookup = linesMap instanceof Map ? linesMap
      : (Array.isArray(linesMap)
        ? new Map(linesMap.filter(Boolean).map((l) => [String(l.lineId), l])) : new Map());
    const ents = [];
    for (const line of lookup.values()) {
      const grp = lg ? lg.ofLine.get(line.lineId) : null;
      if (grp) {
        if (line.lineId !== grp.mainId) continue;   // 支线不单独出条目（并入主线条目）
        const aliases = [];
        const add = (s) => { if (typeof s === 'string' && s && aliases.indexOf(s) < 0) aliases.push(s); };
        for (const m of grp.members) {
          const ml = lookup.get(m);
          if (!ml) continue;
          add(ml.name);
          for (const a of Array.isArray(ml.aliases) ? ml.aliases : []) add(a);
        }
        ents.push({ type: 'line', id: grp.mainId, text: grp.name, aliases, terms: grp.members.slice(), ref: null });
      } else {
        ents.push({ type: 'line', id: line.lineId, text: line.name || line.lineId,
          aliases: (Array.isArray(line.aliases) ? line.aliases : []).slice(), ref: null });
      }
    }
    return ents;
  }

  // ---------- 线路显示名 / 站牌所属线路（2026-11-22 主支线合并改版） ----------
  // 线路显示名（站牌/信息面板 hover 用）：有效组成员一律显示组名（主线名恰为组名则不变；
  // 主线名≠组名时也显示组名——「显示名称为线组名称」），别名随主线（其余以主线为准）；
  // 无组/无效组照旧「名（又称 …）」。线不在 linesMap（孤站）退 fallback/id 原文。
  function lineLabelOf(lineId, linesMap, lineGroups, fallback) {
    const id = lineId != null ? String(lineId) : null;
    const l = id != null && linesMap instanceof Map ? linesMap.get(id) : null;
    if (!l) return fallback || (id != null ? id : '');
    const lg = lineGroups && lineGroups.ofLine instanceof Map ? lineGroups : null;
    const grp = lg ? lg.ofLine.get(l.lineId) : null;
    const main = grp ? (linesMap.get(grp.mainId) || l) : l;
    let s = grp ? (grp.name || main.name || main.lineId) : (l.name || l.lineId);
    const al = Array.isArray(main.aliases) ? main.aliases : [];
    if (al.length) s += '（又称 ' + al.join('、') + '）';
    return s;
  }
  // pin 的所属线路显示列表：组 pin 用成员线 lineIds、单站 pin 用本线（孤站退 lineName）；
  // 主支线合并后成员显示名同为组名 → 去重防重复（换乘站不再「1号线、1号线」双列）。
  function linesOfPin(pin, linesMap, lineGroups) {
    if (pin && pin.kind === 'group') {
      const out = [];
      for (const lid of pin.lineIds || []) {
        const s = lineLabelOf(lid, linesMap, lineGroups, '');
        if (s && out.indexOf(s) < 0) out.push(s);
      }
      return out.length ? out : (pin.lineNames || []);
    }
    const s = lineLabelOf(pin && pin.lineId, linesMap, lineGroups,
      (pin && pin.lineNames && pin.lineNames[0]) || '');
    return s ? [s] : [];
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

  // ---------- 线路信息面板（2026-11-23 增：lineinfo.md 用户手填介绍） ----------
  // 数据链：数据目录的 lineinfo.md（用户手填）→ flatten 原样透传进 net/ → 查看器按
  // lines.geojson 同款 net/ → build/net 回退拉取并解析。本函数只做解析：
  // parseLineInfo(md) → { [线组id或线id]: { fields:[[键,值]…]（原序）, bodyHtml, links:[{text,url}] } }。
  // md 约定（格式模板见 data/lineinfo.md）：
  //   ## <线组id或线id> <名>    二级标题绑定线路（id＝首个空白前 token：建了组的线路以
  //                            groups.json 的 lineGroups.id 为准，没建组的线以 lines/*.json
  //                            的线 id 为准——2026-11-23 放宽「绑线组 id 或线 id」，没建组的
  //                            单线同样是用户眼里的一条线路；标题名不参与绑定，同 id 多节
  //                            后者覆盖）
  //   标题行到第一个空行        形如「键: 值」的行＝固定显示项（半/全角冒号均可；键名开放
  //                            集合——解析器不做白名单，任意键照收照显，用户加新键零代码
  //                            改动；不成形的行按正文收，不丢字）
  //   空行后到下一个标题        自由正文，轻量 md：段落（空行分段、段内换行→<br>）／
  //                            无序列表（- 或 * 开头行）／粗体 **x**／斜体 *x*／
  //                            链接 [文字](url)
  //   ### 相关链接              链接列表区：该节下每行一个 md 链接；其余三级节名＝未来
  //                            扩展位，按正文处理
  // 没写信息的线路＝结果表无该键（查看器不显示信息节，不报错）；空文件/非字符串 → {}；
  // 只有标题、什么都没写的组同样从表中省去。
  // 安全（硬要求）：一切用户文本先 HTML 转义（xmlEscape）再做标记替换，产物只含受控
  // 白名单标签（a/strong/em/p/ul/li/br）——<script>/<img onerror> 等注入只落成转义后的
  // 文字；链接 URL 只放行 http/https 与相对路径（safeLinkUrl），被拒时正文内链接退纯
  // 文字（内容不丢）、相关链接区整行剔除。
  const LINK_MARKDOWN_RE = /\[([^\]]+)\]\(([^)]*)\)/g;
  // 链接 URL 白名单：http(s):// 放行（大小写不敏感）；无 scheme 的相对路径放行（含协议
  // 相对 //、根相对 /x、普通相对与纯锚 #x）——判定＝首个「:」不得出现在「/?#」之前，
  // javascript:/data:/vbscript: 等一切带 scheme 的其他形态一律拒绝；空串/非法 → null。
  function safeLinkUrl(url) {
    const u = String(url == null ? '' : url).trim();
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return u;
    const cut = u.search(/[/?#]/);
    if ((cut < 0 ? u : u.slice(0, cut)).indexOf(':') >= 0) return null;
    return u;
  }
  // 行内标记（粗体/斜体）：输入先转义再做替换——标记替换发生在转义后的纯文本上，
  // 产物不可能带未转义的标签（**x** → <strong>、*x* → <em>）
  function markupHtml(raw) {
    return xmlEscape(raw)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
  }
  // 行内渲染（链接＋粗体/斜体）：链接按结构切出（URL 校验在原始串上做），链接文本走
  // markupHtml（不支持嵌套链接），非链接片段同样 markupHtml；URL 被拒 → 该链接退纯文字
  function inlineHtml(raw) {
    const s = String(raw == null ? '' : raw);
    let out = '', last = 0, m;
    LINK_MARKDOWN_RE.lastIndex = 0;
    while ((m = LINK_MARKDOWN_RE.exec(s)) !== null) {
      out += markupHtml(s.slice(last, m.index));
      const url = safeLinkUrl(m[2]);
      if (url) {
        out += '<a href="' + xmlEscape(url) + '" target="_blank" rel="noopener noreferrer">'
          + markupHtml(m[1]) + '</a>';
      } else out += markupHtml(m[1]);
      last = m.index + m[0].length;
    }
    return out + markupHtml(s.slice(last));
  }
  // 正文块级渲染：段落（空行分段、段内逐行 inlineHtml 后以 <br> 连接）＋无序列表
  //（-/* 开头的连续行合成一个 <ul>）；段落与列表互斥，互相切入时先收前一块
  function bodyHtmlOf(lines) {
    const out = [];
    let para = null, list = null;
    const flush = () => {
      if (para) { out.push('<p>' + para.map(inlineHtml).join('<br>') + '</p>'); para = null; }
      if (list) { out.push('<ul>' + list.map((t) => '<li>' + inlineHtml(t) + '</li>').join('') + '</ul>'); list = null; }
    };
    for (const raw of Array.isArray(lines) ? lines : []) {
      const line = String(raw).replace(/[ \t]+$/, '');
      const li = line.match(/^\s*[-*][ \t]+(.*)$/);
      if (li) { if (para) flush(); if (!list) list = []; list.push(li[1]); continue; }
      if (!line.trim()) { flush(); continue; }
      if (list) flush();
      if (!para) para = [];
      para.push(line);
    }
    flush();
    return out.join('');
  }
  // 主解析：逐行状态机（head＝字段区 / body＝正文 / links＝相关链接节），见节首约定注
  function parseLineInfo(md) {
    const out = {};
    if (typeof md !== 'string') return out;
    const lines = md.replace(/\r\n?/g, '\n').split('\n');
    let cur = null;   // { id, fields, body, links, stage }
    const closeCur = () => {
      if (!cur) return;
      const bodyHtml = bodyHtmlOf(cur.body);
      if (cur.fields.length || bodyHtml || cur.links.length) {
        out[cur.id] = { fields: cur.fields, bodyHtml, links: cur.links };
      }
      cur = null;
    };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      let m = line.match(/^##(?!#)[ \t]*(.*)$/);
      if (m) {                                  // 二级标题＝新线组（无 id 的坏标题整节丢弃）
        closeCur();
        const id = m[1].trim().split(/\s+/)[0] || '';
        if (id) cur = { id, fields: [], body: [], links: [], stage: 'head' };
        continue;
      }
      if (!cur) continue;                       // 首个标题之前的散行（文件头说明等）忽略
      m = line.match(/^###[ \t]*(.*)$/);
      if (m) {                                  // 三级节：「相关链接」＝链接区，其余按正文
        cur.stage = m[1].trim() === '相关链接' ? 'links' : 'body';
        if (cur.stage === 'body') cur.body.push(line);
        continue;
      }
      if (cur.stage === 'links') {
        if (!line.trim()) continue;             // 空行＝分隔，链接节到下一标题为止
        const lk = line.trim().match(/^\[([^\]]+)\]\(([^)]*)\)$/);
        if (lk) {
          const url = safeLinkUrl(lk[2]);
          if (url) cur.links.push({ text: lk[1], url });
        }
        continue;                               // 非链接行／坏 URL 行剔除（链接区不留纯文字）
      }
      if (!line.trim()) { cur.stage = 'body'; continue; }     // 第一个空行＝字段区结束
      const fv = line.match(/^([^:：]+)[ \t]*[:：][ \t]*(.*)$/);
      if (fv && cur.stage === 'head') cur.fields.push([fv[1].trim(), fv[2].trim()]);
      else cur.body.push(line);                 // 字段区不成形的行按正文收（不丢字）
    }
    closeCur();
    return out;
  }
  // lineinfo 节绑定 id 解析（2026-11-23 放宽：节绑「线组 id 或线 id」）：给定一条线，先按
  // 其所属线组的 id 查节，查不到再按该线自身 id 查——没建组的单线（无支线的独立线）同样是
  // 「用户眼里的一条线路」，按线 id 写的介绍也能显示。返回 { id, name }｜null：name＝节题
  // 用名（组节→组名〔buildLineGroups 已兜主线名〕、线节→线名〔缺失退线 id〕）；两处都无节
  // → null（显示侧完全无痕）。「有节」判据与查看器 appendLineInfo 的显示判据同口径：
  // fields/links/bodyHtml 任一非空才算（只有标题的空节按无节处理）。
  function lineInfoEntryOf(lineId, linesMap, lineGroups, lineInfo) {
    const id = lineId != null ? String(lineId) : '';
    if (!id) return null;
    const info = lineInfo && typeof lineInfo === 'object' ? lineInfo : null;
    const hasSec = (k) => {
      const e = info ? info[k] : null;
      if (!e || typeof e !== 'object') return false;
      const f = Array.isArray(e.fields) ? e.fields : [];
      const lk = Array.isArray(e.links) ? e.links : [];
      const b = typeof e.bodyHtml === 'string' ? e.bodyHtml : '';
      return f.length > 0 || lk.length > 0 || b.length > 0;
    };
    const l = linesMap instanceof Map ? linesMap.get(id) : null;
    const lineName = (l && l.name) || id;
    const lg = lineGroups && lineGroups.ofLine instanceof Map ? lineGroups.ofLine.get(id) : null;
    if (lg && hasSec(lg.id)) return { id: String(lg.id), name: lg.name || lineName };
    if (hasSec(id)) return { id: id, name: lineName };
    return null;
  }

  // ---------- 单线导出 ----------
  // 嵌套节点补注（2026-11-23）：导出函数的 tree 入参可选——传入且该站所属组处在嵌套节点
  //（有上级，或有带输出站点的子组）时，GeoJSON 站属性补 nodeGroupId/nodeGroupType（最外层组
  // id/有效类型）、KML 描述追加「换乘节点：类型（组 id）」；平铺组或不传 tree＝导出与旧版
  // 逐字节一致。直属组 groupId/groupType 两字段照旧（如实＝直属关系，不改动）。
  function stopNodeOf(stop, tree) {
    if (!tree || typeof tree.rootOf !== 'function' || !stop || !stop.groupId || !tree.group(stop.groupId)) return null;
    const nested = tree.parentOf(stop.groupId) != null
      || tree.childrenOf(stop.groupId).some((c) => tree.leafStops(c).length > 0);
    if (!nested) return null;
    const root = tree.rootOf(stop.groupId);
    return root == null ? null : { id: root, type: tree.typeOf(root) };
  }
  // GeoJSON：线一条 Feature（MultiLineString，段序＝segIndex）＋每站一个 Point（站序＝t 升序）。
  function buildLineGeoJSON(lineId, linesMap, stops, tree) {
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
    for (const s of sts) {
      const node = stopNodeOf(s, tree);
      const props = { sid: s.sid, name: s.name, lineId: s.lineId, t: s.t, groupId: s.groupId, groupType: s.groupType };
      if (node) { props.nodeGroupId = node.id; props.nodeGroupType = node.type; }   // 仅嵌套节点补两键
      features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: props });
    }
    return { type: 'FeatureCollection', features };
  }

  // KML：手写模板。2026-11-22 改版：渲染不再区分期次，导出同步纯色实线、统一不透明——
  // 单一样式（线色 alpha=1），不再按三种分段状态拆 Style；Placemark 仍按段拆分、段名保留
  // 状态文字（信息性文字非样式，段状态数据同时保留在 GeoJSON 导出的 segStatuses）。
  // 所有文本经 xmlEscape；坐标 6 位小数。未知 lineId → null。坐标恒 WGS84 不动。
  // opts.tree（可选）＝嵌套节点补注，见 stopNodeOf。
  function buildLineKML(lineId, linesMap, stops, opts) {
    const line = linesMap.get(lineId != null ? String(lineId) : '');
    if (!line) return null;
    const o = opts || {};
    const docName = line.name || line.lineId;
    const kmlColor = hexToKmlColor(line.color, 1);   // 统一全不透明
    const sts = stops.filter((s) => s.kind !== 'arrow' && s.lineId === line.lineId)
      .sort((a, b) => (a.t == null ? 1 : 0) - (b.t == null ? 1 : 0) || num(a.t) - num(b.t));
    const L = [];
    L.push('<?xml version="1.0" encoding="UTF-8"?>');
    L.push('<kml xmlns="http://www.opengis.net/kml/2.2"><Document>');
    L.push('<name>' + xmlEscape(docName) + '</name>');
    L.push('<Style id="line"><LineStyle><color>' + kmlColor + '</color><width>'
      + (Number.isFinite(o.lineWidth) ? o.lineWidth : 3) + '</width></LineStyle></Style>');
    for (const seg of line.segments) {
      L.push('<Placemark><name>' + xmlEscape(docName + '（' + (SEG_STATUS_ZH[seg.segStatus] || seg.segStatus) + '段）') + '</name>');
      L.push('<styleUrl>#line</styleUrl>');
      L.push('<LineString><tessellate>1</tessellate><coordinates>');
      L.push(seg.coords.map((c) => num(c && c[0]).toFixed(6) + ',' + num(c && c[1]).toFixed(6) + ',0').join(' '));
      L.push('</coordinates></LineString></Placemark>');
    }
    for (const s of sts) {
      L.push('<Placemark><name>' + xmlEscape(s.name || s.sid) + '</name>');
      const rel = [];
      if (s.lineName) rel.push('所属：' + s.lineName);
      if (s.groupType) rel.push(GROUP_TYPE_ZH[s.groupType]);
      const node = stopNodeOf(s, o.tree);   // 嵌套节点才补注（平铺组/不传 tree＝旧版输出不变）
      if (node) rel.push('换乘节点：' + (GROUP_TYPE_ZH[node.type] || node.type) + '（组 ' + node.id + '）');
      if (rel.length) L.push('<description>' + xmlEscape(rel.join('；')) + '</description>');
      L.push('<Point><coordinates>' + num(s.lon).toFixed(6) + ',' + num(s.lat).toFixed(6) + ',0</coordinates></Point></Placemark>');
    }
    L.push('</Document></kml>');
    return L.join('\n');
  }

  // ---------- 导出 ----------
  const Core = {
    DIM_OPACITY, SEG_STATUS_RANK, DEFAULT_LINE_COLOR, GROUP_TYPE_ZH, ROLE_ZH, SEG_STATUS_ZH,
    PHASE_CYCLE, PHASE_LABEL_ZH, HIDDEN_LIST_LAYERS, DISPLAY_ONLY_LAYERS, DASHED_LAYERS,
    LABEL_ZOOM_GROUP, LABEL_ZOOM_STOP,
    SIZE_ZOOM_MIN, SIZE_ZOOM_HOLD, SIZE_SCALE_EXP, labelScale,
    MOBILE_BREAKPOINT, viewportIsMobile, MOBILE_LABEL_SCALE, sheetSnapHeights, nearestSheetSnap,
    UNNAMED_STOP_ZH, stopDisplayName, formatTerminals,
    xmlEscape, normalizeHex, hexToKmlColor,
    normalizeLines, lineBboxOf, stopList, buildStopView,
    parseNetIndex, buildGroupTree, logicalLineCount, groupRelations,
    planGroupPillChain, planarOf, lineSummaries, layerGroups, visibleListGroups,
    linePhaseOf, lineLayerRank, lineDashed, computeDimmedSet, deepHighlightDimIds, deepPhaseDimBit, nextPhase, tabSwapDir, normalizePhaseSelection, phaseSelectionActive, phaseStatusSelected, phaseSegments, segmentProgressRanges, stopPhaseOf, connectorFadePlan, focusBboxOf,
    LINE_HIT_LAYER_IDS, LINE_HIT_LAYER_PREFIXES, isLineHitLayerId, lineClickAction,
    STOP_HIT_LAYER_IDS, isStopHitLayerId,
    stationMemberStops, stationLinesOf, stationFocusOf, focusBboxOfSet,
    stopPinKeyOf,
    connectorBlendPlan, arrowFadePlan, arrowFadeGradient, ARROW_FADE_M,
    zoomInterp, scaledSize, LINE_WIDTH_PX, DBLCLICK_TOL_PX, lineWidthAt,
    pointToScreenPolylineDist,
    buildLineGroups, lineSearchEntries, lineLabelOf, linesOfPin,
    lineStopSections, stopNodeGlyph, nearestOnLineGeom, lineEndpointsOf,
    stopsOfLineOrdered, junctionBuckets, branchDestLabel, sharedTrackRowRange, STATION_SNAP_M,
    matchEntries, filterLabels, visibleLabels, stopUnitMatchesPhase,
    parseLineInfo, safeLinkUrl, lineInfoEntryOf,
    buildLineGeoJSON, buildLineKML,
    outOfChina, wgs84ToGcj02, gcj02ToWgs84, makeDispCoord,
    niceTickStep, formatCoordinate, coordinateTicks, edgeTickPositions,
  };
  G.VIEWER_CORE = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
