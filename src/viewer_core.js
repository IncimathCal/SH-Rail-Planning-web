// viewer_core.js —— 阶段 3 查看器·纯逻辑层（2026-11-21）
// 不依赖 DOM / maplibre / editor.js：数据归一（线路聚合、站点平表、换乘组归并）、
// 搜索匹配、标签分级与可见性（全局开关/聚焦常显/调光隐藏/zoom 门槛）、单线导出
//（GeoJSON 对象 / KML 字符串）、调光纯逻辑（线路期次归类、调光线集计算）、
// 尺寸缩放冻结表达式构造、显示文案（起讫格式化、未名站占位）。
// 浏览器端挂 globalThis.VIEWER_CORE；node 端（tools/test_viewer_logic.js）走 module.exports。
// 数据契约：net/lines.geojson（每 feature＝线×分段）、net/stops.geojson（每 feature＝线×站）。
// 2026-11-21 增：出省箭头（stop.kind:'arrow'——非站，不进组/标签/摘要/导出，仅出 arrows 视图）、
// ≥3 线同站组药丸链序（planGroupPillChain 贪心最近邻，与编辑器侧逐字节同规格）。
// 2026-11-22 增：GCJ02 显示变换三件套（outOfChina/wgs84ToGcj02＝src/geom.js 同源受控副本＋
// makeDispCoord 显示坐标工厂）——测试阶段底图（高德）对齐用，仅显示侧，权威数据不动。
// 2026-11-22 改版（用户八条指示）：渲染不再区分期次（删三档透明/远期虚线，导出同步纯色实线）、
// 分期四档＋聚焦双模式调光（computeDimmedSet）、标签可见性优先级（visibleLabels）、
// 普通站标签门槛 12→11、z<11 尺寸线性缩小（zoomInterp/scaledSize）、左栏类别过滤常量。
// 2026-11-22 增：联络线渐变接入端判定（connectorFadePlan——聚焦线绑定的联络线沿线渐变
// 透明，connects 无顺序语义、方向按几何最近端判；normalizeLines 同步保留 connects 字段）。
// 2026-11-22 增（用户裁定·主支线合并）：一条线路的主线与支线在查看器眼中恒为一条线——
// buildLineGroups 双向并集归并（line.groupId 指向 ＋ 组记录 members；无 main 组防御不合并）、
// 列表合并行（layerGroups 增收 lineGroups——主线行显示名改组名、支线不出独立行）、组级
// 调光（computeDimmedSet 增收 lineGroups——期次/仅显示级以主线为准、聚焦豁免组全体成员）、
// 合并搜索条目（lineSearchEntries＋matchEntries 增 terms 附加搜索词——成员线名/别名/id 全
// 命中同一条目）、站牌组名显示（lineLabelOf/linesOfPin——组成员一律显组名，主/支线去重）；
// normalizeLines 同步保留 groupId 字段（net-index@2 的组信息与此双保险）。

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
  const SEG_STATUS_ZH = { existing: '既有', approved: '已批复', future: '远期' };
  // 分期四档循环（顶栏按钮）：无 → 既有 → 已批复 → 远期 → 无
  const PHASE_CYCLE = ['none', 'existing', 'approved', 'future'];
  const PHASE_LABEL_ZH = { none: '无', existing: '既有', approved: '已批复', future: '远期' };
  // 左栏线路列表隐藏的类别（2026-11-22 用户裁定：仅「联络线」隐藏；地图照画、搜索照收）
  const HIDDEN_LIST_LAYERS = ['联络线'];
  // 「仅显示」级类别（2026-11-22 用户裁定：他省线）——列表双击不聚焦、地图点选不开面板、
  // 一切调光场合（分期非「无」档/任何聚焦）恒在半透明侧（即便期次恰好匹配）
  const DISPLAY_ONLY_LAYERS = ['他省'];
  const LABEL_CAP = 800;        // 标签数量上限：超过则只显示换乘组标签（防低 zoom 糊屏）
  const LABEL_ZOOM_GROUP = 10;  // 换乘组标签最低 zoom（不动）
  const LABEL_ZOOM_STOP = 11;   // 普通站标签最低 zoom（2026-11-22 用户指示 12→11）
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

  // 显示坐标变换工厂（测试阶段底图）：'none'|'osm' → 恒等（OSM 瓦片即 WGS84，与数据同基准）；
  // 'gaode' → wgs84ToGcj02 包装（高德瓦片为 GCJ02，对齐＝仅显示用坐标做偏移——境外点恒等
  // 由 outOfChina 在 wgs84ToGcj02 内部处理）。⚠ 只喂渲染/标签定位/相机定位等显示侧；
  // 权威数据（linesMap/stops/摘要/搜索索引/导出）一律不过此函数。未知 mode 兜恒等（防御）。
  function makeDispCoord(mode) {
    if (mode === 'gaode') return (lon, lat) => wgs84ToGcj02(lon, lat);
    return (lon, lat) => [lon, lat];
  }

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
          // 联络线接轨对象线 id 列表（2026-11-22 用户需求 3：聚焦渐变高亮用）——
          // flatten 侧每段 feature 均带同值，此处首段建 line 对象时取一次即可
          connects: Array.isArray(p.connects) ? p.connects.filter((s) => typeof s === 'string' && s) : [],
          // 线组归属（2026-11-22 主支线合并）：flatten 每段 feature 均带同值（无组为空串，
          // 保持键齐——沿用 connects 的做法），首段建 line 对象时取一次；组名/成员并集
          // 在 buildLineGroups 与 net/index.json lineGroups 汇算
          groupId: typeof p.groupId === 'string' ? p.groupId : '',
          segments: [],
        };
        out.set(id, line);
      }
      line.segments.push({
        segIndex: Number.isFinite(p.segIndex) ? p.segIndex : line.segments.length,
        segStatus: Object.prototype.hasOwnProperty.call(SEG_STATUS_RANK, p.segStatus) ? p.segStatus : 'future',
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
  //     same-station 组 ≥3 线：改画药丸（见 pills），成员个人小圈不再出现（药丸即换乘标识）；
  //     junction 组：合并普通尺寸圈（big=false 不放大——接轨站不出大圈；描边色由渲染层按成员线角色优先级取，不用黑边）；
  //     out-of-station 组：成员各自普通尺寸圈（出闸换乘物理上是两个站，不并点，黑边）；
  //     除出闸组外，组成员的个人小圈一律不再单独出现。
  //   pills —— ≥3 线 same-station 组的胶囊折线：成员 geo 按 planGroupPillChain 链序串联
  //（渲染层双层 line＋圆头端帽即得白底黑边胶囊；恰 2 线组不出药丸）。条目自带 pin
  //（组级信息面板/hover 单元，key 'g:<id>'，渲染层并入 pinByKey；不进 pins＝不渲染成圈）。
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
      // lineIds＝站名可见性判定用（全局开关/聚焦常显/调光隐藏，见 visibleLabels）
      labels.push({ key: s.sid, name: s.name, lon: s.lon, lat: s.lat, group: false, groupType: null,
        lineNames: s.lineName ? [s.lineName] : [], lineIds: s.lineId ? [s.lineId] : [] });
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
        // ≥3 线：药丸替代一切成员图形——成员个人小圈不再出现（药丸即换乘标识，
        // 2026-11-22 用户裁定）；组 pin 挂在药丸条目上（不进 pins＝不被渲染成圈），
        // 渲染层在药丸线上挂点选/hover，用同一 key 查 pinByKey
        const lat0 = grp.members.reduce((acc, s) => acc + num(s.lat), 0) / n;   // 组内共享参考纬度
        const order = planGroupPillChain(grp.members.map((s) => planarOf(s.lon, s.lat, lat0)));
        pills.push({
          key: 'g:' + grp.groupId, groupId: grp.groupId, lineIds,
          chain: order.map((i) => [grp.members[i].lon, grp.members[i].lat]),
          pin: {
            kind: 'group', key: 'g:' + grp.groupId, groupId: grp.groupId, name, lineNames,
            lineIds, groupType: grp.type, big: true, lon, lat,
          },
        });
      } else {
        pins.push({
          kind: 'group', key: 'g:' + grp.groupId, groupId: grp.groupId, name, lineNames,
          lineIds,
          groupType: grp.type, big: grp.type === 'same-station', lon, lat,
        });
      }
      labels.push({ key: 'g:' + grp.groupId, name, lon, lat, group: true, groupType: grp.type, lineNames, lineIds });
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

  // ---------- 标签分级（zoom 门槛层；上层优先级见 visibleLabels） ----------
  // z≥11 显示全部（超上限只显示换乘组）；z≥10 只显示换乘组；更低不显示。
  //（普通站门槛 2026-11-22 由 12 降为 11，用户指定；组门槛 10 不动）
  function filterLabels(labels, zoom, cap) {
    const arr = Array.isArray(labels) ? labels : [];
    const c = Number.isFinite(cap) && cap > 0 ? cap : LABEL_CAP;
    if (zoom >= LABEL_ZOOM_STOP) return arr.length <= c ? arr : arr.filter((l) => l && l.group);
    if (zoom >= LABEL_ZOOM_GROUP) return arr.filter((l) => l && l.group);
    return [];
  }

  // ---------- 标签可见性（优先级：全局站名开关 ＞ 聚焦线常显 ＞ 被调光线隐藏 ＞ zoom 门槛） ----------
  // state：{ hideAll: 全局站名开关（true＝一切站名不显示，优先级最高）,
  //          dimmedSet: Set<lineId> 被调光线集, focus: 聚焦 lineId|null }。
  // 调光隐藏规则与药丸/大圈符号一致：组标签全部成员线被调光才隐藏（任一成员未调光则显示）；
  // 无所属线信息的标签（防御）不因调光隐藏。聚焦线的标签无视 zoom 门槛常显（也不占 LABEL_CAP）；
  // 按用户给的优先级序，聚焦常显高于调光隐藏——聚焦线即便因分期不匹配被调光，其站名仍常显。
  function labelHasLine(l, lineId) {
    return Array.isArray(l.lineIds) && l.lineIds.indexOf(lineId) >= 0;
  }
  function labelShownUnderDim(l, dimSet) {
    const ids = Array.isArray(l.lineIds) ? l.lineIds : [];
    if (!ids.length) return true;                              // 无所属线信息（防御）→ 不因调光隐藏
    for (const id of ids) if (!dimSet.has(id)) return true;    // 任一成员线未调光 → 显示
    return false;                                              // 全部成员线被调光 → 隐藏
  }
  function visibleLabels(labels, zoom, cap, state) {
    const st = state || {};
    if (st.hideAll) return [];
    const dimSet = st.dimmedSet instanceof Set ? st.dimmedSet
      : new Set(Array.isArray(st.dimmedSet) ? st.dimmedSet.map(String) : []);
    const arr = Array.isArray(labels) ? labels.filter(Boolean) : [];
    const focus = st.focus != null && st.focus !== '' ? String(st.focus) : null;
    if (!focus) return filterLabels(arr.filter((l) => labelShownUnderDim(l, dimSet)), zoom, cap);
    // 聚焦常显：含聚焦线的标签先捞出（无视调光与 zoom 门槛——优先级序在调光隐藏之前），
    // 其余标签走「调光隐藏 → zoom 门槛」；两类互斥不重复
    const always = arr.filter((l) => labelHasLine(l, focus));
    const rest = filterLabels(arr.filter((l) => !labelHasLine(l, focus) && labelShownUnderDim(l, dimSet)), zoom, cap);
    return always.concat(rest);
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

  // 线路可交互层级（集中判断，勿散落 if）：'displayOnly'＝仅显示（他省线，见 DISPLAY_ONLY_LAYERS）
  // ——列表双击不聚焦、地图点选不开面板、一切调光场合恒在半透明侧；'normal'＝可交互。
  function lineLayerRank(line) {
    const layer = line && typeof line.layer === 'string' ? line.layer : '';
    return DISPLAY_ONLY_LAYERS.indexOf(layer) >= 0 ? 'displayOnly' : 'normal';
  }

  // 调光线集：state＝{ phase: 'none'|'existing'|'approved'|'future', focus: lineId|null,
  //                   lineGroups: buildLineGroups 产物（可选，缺省＝逐线旧行为） }。
  // 分期非「无」档：期次不匹配的线调光；聚焦：非聚焦线调光；两者叠加取并集（任一命中即调光）。
  // 「仅显示」级（displayOnly）线在任何调光场合（phase 或 focus 任一激活）恒入调光集——
  // 即便期次恰好匹配（2026-11-22 用户裁定）。默认态（无分期＋无聚焦）不调光，displayOnly 正常显示。
  // 2026-11-22 主支线合并（用户裁定）：组级调光——有效组成员的期次态/仅显示级判定一律以
  // 主线为准（「其余没考虑到的都以主线为准」），组全体同调同不调；聚焦豁免＝组全体成员
  //（主线＋支线都不调光）。S.focus 恒为主线 id（胶水层 toggleFocus 已归一），但此处对
  // 直传支线 id 亦按其组豁免（防御）。无 main 的组不经 lineGroups 进入（buildLineGroups
  // 已滤），组员照旧逐线判定。
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
    const focusGrp = lg && focus ? lg.ofLine.get(focus) : null;   // 聚焦线（主线）所在组
    for (const line of lines) {
      if (!line || line.lineId == null) continue;
      const id = String(line.lineId);
      const grp = lg ? lg.ofLine.get(id) : null;
      const ref = grp ? (getById(grp.mainId) || line) : line;     // 组判定基准线＝主线
      if (lineLayerRank(ref) === 'displayOnly') { dim.add(id); continue; }
      if (phase && linePhaseOf(ref) !== phase) dim.add(id);   // 两条件独立叠加（并集）
      if (focus && id !== focus && !(focusGrp && focusGrp.members.indexOf(id) >= 0)) dim.add(id);
    }
    return dim;
  }

  // 分期四档循环推进：'none' → 'existing' → 'approved' → 'future' → 'none'（非法输入回 'none'）
  function nextPhase(cur) {
    const i = PHASE_CYCLE.indexOf(cur);
    return PHASE_CYCLE[((i < 0 ? 0 : i) + 1) % PHASE_CYCLE.length];
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

  // KML：手写模板。2026-11-22 改版：渲染不再区分期次，导出同步纯色实线、统一不透明——
  // 单一样式（线色 alpha=1），不再按三种分段状态拆 Style；Placemark 仍按段拆分、段名保留
  // 状态文字（信息性文字非样式，段状态数据同时保留在 GeoJSON 导出的 segStatuses）。
  // 所有文本经 xmlEscape；坐标 6 位小数。未知 lineId → null。坐标恒 WGS84 不动。
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
      if (rel.length) L.push('<description>' + xmlEscape(rel.join('；')) + '</description>');
      L.push('<Point><coordinates>' + num(s.lon).toFixed(6) + ',' + num(s.lat).toFixed(6) + ',0</coordinates></Point></Placemark>');
    }
    L.push('</Document></kml>');
    return L.join('\n');
  }

  // ---------- 导出 ----------
  const Core = {
    DIM_OPACITY, SEG_STATUS_RANK, DEFAULT_LINE_COLOR, GROUP_TYPE_ZH, ROLE_ZH, SEG_STATUS_ZH,
    PHASE_CYCLE, PHASE_LABEL_ZH, HIDDEN_LIST_LAYERS, DISPLAY_ONLY_LAYERS,
    LABEL_CAP, LABEL_ZOOM_GROUP, LABEL_ZOOM_STOP,
    SIZE_ZOOM_MIN, SIZE_ZOOM_HOLD, SIZE_SCALE_EXP, labelScale,
    UNNAMED_STOP_ZH, stopDisplayName, formatTerminals,
    xmlEscape, normalizeHex, hexToKmlColor,
    normalizeLines, lineBboxOf, stopList, buildStopView, buildArrowViews,
    planGroupPillChain, planarOf, lineSummaries, layerGroups, visibleListGroups,
    linePhaseOf, lineLayerRank, computeDimmedSet, nextPhase, connectorFadePlan,
    zoomInterp, scaledSize, LINE_WIDTH_PX, DBLCLICK_TOL_PX, lineWidthAt,
    pointToScreenPolylineDist,
    buildLineGroups, lineSearchEntries, lineLabelOf, linesOfPin,
    matchEntries, filterLabels, visibleLabels,
    buildLineGeoJSON, buildLineKML,
    outOfChina, wgs84ToGcj02, makeDispCoord,
  };
  G.VIEWER_CORE = Core;
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
})(typeof globalThis !== 'undefined' ? globalThis : this);
