// viewer.js —— 阶段 3 查看器·DOM/MapLibre 胶水层（2026-11-21）
// 职责：fetch net/{lines,stops}.geojson（相对路径 net → build/net 依次回退；加载/空/错三态
// 中文覆盖）→ 纯逻辑归一（VIEWER_CORE）→ 内联 style 渲染（无 glyphs、无文本 symbol——
// 纯深色画布）→ 搜索 / 聚焦（列表双击）·线路·车站信息面板 / 站点 hover 提示 / 单线导出 /
// 中文 HTML 标签叠加。
// 渲染坐标系＝WGS84（无底图设计，零外部资源）；S.linesMap/S.stops 即权威结构，
// GeoJSON/KML 导出与其同坐标。2026-11-22 增：测试阶段底图（用户阶段性豁免——早前
//「查看器不放底图」裁定在测试期让位，正式上线可能保留也可能移除；2026-11-23 三态扩四态：
// 无→OSM→高德→CARTO无字 循环）；高德为 GCJ02，对齐走显示侧坐标变换（S.dispCoord，
// 权威数据/导出一律 WGS84 不动；OSM/CARTO 瓦片均 WGS84，恒等直通）。
// 2026-11-22 改版（用户八条指示）：①渲染不再区分期次——单一线层纯色实线统一不透明
//（三档透明/远期虚线/按 segStatus 拆层全删）；②分期四档循环按钮（无→既有→已批复→远期），
// 非选中期的线半透明并隐站名；③左栏列表双击聚焦（其他线半透明隐站名、聚焦线站名常显、
// 屏幕下方居中信息框）；④左栏按类别过滤（HIDDEN_LIST_LAYERS）＋他省线「仅显示」级
//（不聚焦/不点选/一切调光场合恒半透明）；⑤普通站名门槛 12→11；⑥全局站名开关；
// ⑦z<11 尺寸线性缩小（zoomInterp 冻结表达式）；⑧图例卡三档线样与「突出既有」开关退役。
// 调光实现：S.dimmed＝computeDimmedSet 的线集，渲染特征带 dim 位，各层 paint 用
// ['case',['==',['get','dim'],1], DIM_OPACITY, 1]；调光线站圈/药丸/大圈同步半透明
//（组符号＝全成员被调光才半透明，任一成员未调光则正常）。
// 2026-11-21 增：①出省箭头（kind:'arrow'）——2026-11-22 改版后查看器 glyph 体系已删，
// 改为线身末端 1km 渐隐示意（见下方定案轮注；编辑器仍画线色三角不动）；
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
// 2026-11-22 定案轮（用户确认）：①白罩高亮定案——不透明度恒 70%（FOCUS_VEIL_OPACITY），
// 「高亮：遮罩⇄调光」「遮罩：N%」对比按钮与 S.hlMode/S.veilOpacity 全删，聚焦不再贡献
// dim（computeDimmedSet 无 hlMode），focus-copy 聚焦重画层不挂 dim case——聚焦线恒原色
//（语义对齐裁定：对齐旧「聚焦豁免一切调光」语义；原 veil 分支下聚焦线仍随分期半透明属
// 对比期临时行为，一并纠正——分期态下其他线由白罩压灰，聚焦组罩上恒原色）；②出省箭头
// 查看器改版——不再画三角 glyph（arrows source/layer、drawArrowImageData、
// styleimagemissing 注册全删），改为出省端末段 1km 线身沿线渐隐示意（V.arrowFadePlan
// 计划＋arrow-fade-<lineId> 动态渐变层，机制同联络线 conn-blend；编辑器 glyph 不动）。
// 2026-11-22 四项改版（用户需求）：①站圈描边宽度 ×0.6（2→1.2、黑边 2.2→1.32，药丸
// 黑边不动）；②取消联络线颜色属性——颜色由 connects 两端线决定：有效联络线常驻
//「双端渐变层」（blend 形态，conn-blend-*，head/tailColor＝VIEWER_CORE.connectorBlendPlan
// 首末端最近目标线色；信息不全 flatten/plan 双侧深灰兜底），站圈描边取 flatten 产出的
// stroke（最近端目标线色）；聚焦高亮的渐变方式不变但基色改取聚焦线色；③高亮方式改版：
// 默认 veil＝「全都不动，高亮线路和其他线路之间隔一层白色半透明遮罩」（白罩层 focus-veil
// ＋聚焦重画层 focus-copy，重建统一走 rebuildConnLayers；顶栏「高亮」按钮可切回旧 dim
// 调光——短期对比开关，定案后删）＋白罩不透明度五档循环（30%~70%，定值后删档位）；
// 分期调光与他省线恒调光是既有独立裁定、两种模式下维持不变；④健壮性（connectorBlendPlan
// 逐项防御、computeDimmedSet veil 模式，单测覆盖 tools/test_viewer_logic.js）。
// 2026-11-22 真机反馈轮（用户「白罩没罩住其他线路的设站、站名也没隐去」）：①站圈三层与
// 药丸两层移到白罩之下（聚焦时五层 filter 追加「非聚焦参与」、退出还原不残留）；②聚焦
// 成员的站圈/药丸由罩上复制层（stops-*-focus / pills-*-focus，opacity 恒 1 去 dim case
//——对齐 focus-copy「聚焦豁免一切」裁定）重画，全删全建并入 rebuildConnLayers；③站名标签
// 聚焦时非聚焦线一律隐藏（visibleLabels 恢复聚焦隐藏维度，聚焦组成员标签常显、胶水层传
// focusMembers＝主支线合并组全体成员）。聚焦参与判定＝feature 的 members 数组属性
//（renderStopsFC/renderPillsFC 补）与聚焦组成员集的交集，组符号（junction 合并圈/换乘
// 大圈/药丸）任一成员命中即豁免——对齐 pinDimmed 的组规则；filter 表达式 '!'/'any' 包
// 'in' 的布尔结果合法（与「'!' 吃 0/1 数字」弃层坑不同，见 memberMatchExpr 注）。
// 2026-11-23 嵌套换乘组（用户裁定）：换乘组可再把另一个组当成员——index.json 升 net-index@3
//（VIEWER_CORE.parseNetIndex 解读，顶层 stationGroups 结构表；@1/@2 旧产物照常＝各组顶层）。
// 节点＝最外层组：同站单元全部叶站合成一个符号（逻辑线 ≥3 药丸、否则合并黑边大圈；药丸线数
// 联络线不计、同一线组算一条）、内层组不单独出图形与站名；出闸单元直属站各自成圈、各子组
// 自成绘制单元递归套用；junction 成员递归取全部叶站（规则全在 VIEWER_CORE，本层只多传
// linesMap/lineGroups/结构树三样入参）。结构树 S.groupTree（buildGroupTree）由视图与站点面板
// 共用；站点面板对嵌套节点补「换乘节点／节点成员／换乘对端」行（平铺组一行不加，呈现与旧版
// 一致）；单线导出对嵌套节点的站补节点信息。
// 2026-11-23 渲染参数两项（用户需求，仅查看器渲染）：①底图白色遮罩常态提亮 40%→60%
//（VEIL_OPACITY），唯聚焦态保持 40%（VEIL_OPACITY_FOCUS——聚焦高亮已有 70% 白罩
// FOCUS_VEIL_OPACITY，底图遮罩再提亮两层叠白会看不清；聚焦态判定＝现有状态变量 S.focus，
// 切换挂 applyDimState/applyBasemapToMap 的 syncBasemapVeil）；②预控通道画虚线——分类
// 判断集中在 V.lineDashed/DASHED_LAYERS（meta.layer＝「预控通道」，viewer_core 纯逻辑可单测），
// 特征带 dash 0/1 位，实线层 filter 剔 dash=1、独立 lines-dash 虚线层收 dash=1（显式 ==
// 互斥，0/1 数字位勿用 '!'）；line-dasharray [2,2]＝段长与间隔相等（数值单位＝线宽倍数，
// 基准线宽 7px 下名义 14px/14px——圆头端帽各外扩半线宽，观感约 21px 实段/7px 空隙；
// z<11 线宽缩小时纹样随线宽等比缩小），颜色不变、常态基线不透明度 CORRIDOR_OPACITY=0.6
//（调光系数照旧叠乘 dim case）；相位「几何起点居实段中间」需 line-dashoffset，其不在
// MapLibre 样式规范（vendored maplibre-gl 5.24.1 bundle 亦无此属性字面量），退路＝从
// dash 边界起始（起点首现整段实段）。聚焦重画分实/虚两层（focus-copy/-dash——虚线身份
// 随线走，罩上 opacity 恒 1 的「聚焦豁免一切」语义不变）；分期调光/白罩叠加逻辑一律不动。
// 2026-11-23 增：线路信息面板（lineinfo.md 用户手填的每线路介绍）——fetch 随数据同回退
//（net/lineinfo.md → build/net/lineinfo.md，缺失/失败＝静默无信息，不影响地图），解析在
// VIEWER_CORE.parseLineInfo（文本全转义＋URL 白名单）；聚焦框与站点面板按成员线追加
// 信息节（固定字段区→正文→相关链接区，appendLineInfo），无数据的线完全无痕。同日放宽
// 节绑定＝「线组 id 或线 id」（VIEWER_CORE.lineInfoEntryOf 解析：先按所属线组 id 查节、
// 查不到再落线自身 id——没建组的单线按线 id 写的介绍同样显示）。
// 2026-11-23 省级界线底图（用户明示授权外部地理底图数据——省界属底图范畴，不受地铁数据
// 外部源禁令约束）：长三角省级界线（沪苏浙皖 bbox 裁剪，不要全国/九段线）常驻细灰线层。
// source 'provinces'（初始空 FC，loadProvinces 异步读仓库静态件 basemap/provinces-wgs84.json
// 后 setData——零外部请求原则，运行时只读仓库内落盘文件）；落盘件由 tools/provinces_basemap.py
// 生成（OSM admin_level=4 全精度 WGS84 零转换 → bbox 裁剪＋60m Douglas–Peucker 简化，
// 点距中位约 290m；首版 DataV 概化版 4.8km 已弃，来源与许可口径见脚本头注）。
// 层序在底图瓦片／白遮罩之上、线路之下（ensureBasemapLayers 的 before 指到本层）；只画线
// 不填充，低调灰常量 1px；纯地理参照，不参与分期/聚焦/调光。坐标逐点过 S.dispCoord
//（renderProvincesFC）——高德底图态下界线与线路数据同一显示变换通道，与瓦片同基准；
// OSM／无底图态 dispCoord＝恒等即 WGS84 直出。
// 2026-11-23 遮罩分档（用户裁定「对于carto无字来讲，这个遮罩太厚了。仅carto正常情况改为35，
// 高亮情况下改为30」）：底图白色遮罩按底图态分档——carto 态常态 35%/聚焦 30%（Positron 本就浅，
// 60% 下几乎只剩水系轮廓），OSM／高德态维持 60%/40% 不变（用户点名仅 carto，字面执行）；
// VEIL_OPACITY/VEIL_OPACITY_FOCUS 改为按态查表（veilOpacityFor 取当态档位），syncBasemapVeil
// 与建层初始 paint 同表取值，聚焦进出（applyDimState）与底图切换（applyBasemapToMap）路径
// 自动换档；聚焦态恒比常态薄一档的旧语义不变。
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
    groupTree: null,                // 换乘组结构树（VIEWER_CORE.buildGroupTree；节点＝最外层组。视图与站点面板共用，boot 填充；旧快照无结构表＝各组顶层）
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
    basemap: 'off',               // 测试阶段底图四态：'off'|'osm'|'gaode'|'carto'（默认无＝与现状零差别；不持久化）
    dispCoord: V.makeDispCoord('none'), // 显示坐标变换（gaode＝WGS84→GCJ02，osm/carto 恒等；仅显示侧，见下方底图段）
    basemapPending: false,        // 样式未就绪时点击的补应用标记（目标态恒存 S.basemap）
    styleReady: false,            // map 'load' 已触发（样式只建一次，就绪后 addSource/addLayer 恒可用）
    panelCollapsed: false,        // 线路面板收起态（2026-11-22 用户需求；会话内不持久化，刷新回展开——与底图四态等 UI 态同策）
    // 2026-11-22 出省渐变计划（用户改版）：arrowPlan＝V.arrowFadePlan 结果（boot 算一次，
    // 常驻不随聚焦变）；arrowSet＝含出省端 arrow 的线 id 集（基础层剔除、arrow-fade-*
    // 渐变层接管——查看器以线身末端 1km 渐隐示意出省，编辑器 glyph 不动）。
    arrowPlan: [],
    arrowSet: new Set(),
    // 2026-11-22 用户需求 2「取消联络线颜色属性」：blendPlan＝connectorBlendPlan 结果
    //（boot 算一次，常驻不随聚焦变）；blendSet＝有效联络线 lineId 集（基础层剔除、
    // 渐变层接管——联络线颜色由 connects 两端线的双端渐变决定）。
    blendPlan: [],
    blendSet: new Set(),
    // 2026-11-23 省级界线底图：仓库静态件原始 FC（WGS84 权威拷贝，loadProvinces 读
    // basemap/provinces-wgs84.json 回填；渲染特征经 renderProvincesFC 过 S.dispCoord）
    provincesFC: null,
    // 2026-11-22 用户需求 3：联络线渐变高亮——fadeSet＝当前聚焦的绑定联络线 lineId 集
    //（基础层跳 feature，防半透明底线垫在渐变尾端底下透出）；fadeConnPlan＝
    // connectorFadePlan 缓存（rebuildConnLayers 复用，避免重复几何判定）；
    // connLayerIds＝已加的动态层 id（联络线渐变层 conn-blend-/conn-fade-<lineId> ＋
    // 白罩 focus-veil ＋ 聚焦重画 focus-copy ＋ 出省渐隐层 arrow-fade-<lineId>，
    // 全删全建，见 rebuildConnLayers）。
    fadeSet: new Set(),
    fadeConnPlan: [],
    connLayerIds: [],
    lineInfo: {},                 // 线组id或线id → { fields, bodyHtml, links }（lineinfo.md 解析结果；boot 填充，缺失＝空表＝一切线路无信息节）
  };

  // ---------- 通用 ----------
  function fetchJSON(url, opts) {
    return fetch(url, opts).then((res) => {
      if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
      return res.json();
    });
  }
  function fetchText(url, opts) {
    return fetch(url, opts).then((res) => {
      if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
      return res.text();
    });
  }
  // 数据目录候选（相对路径，docs/ 项目页部署不破）：'net'＝发布快照位（publish 产物），
  // 'build/net'＝本地 flatten 默认输出位。stops 缺失按零站容错（只看线网也成立）；
  // lines 在所有候选位都取不到才算加载失败。index.json（线路自定义显示序＋线组索引，编辑器
  // 排序面板 → manifest.lineOrder → flatten 产出）缺失按「无自定义序/无线组」容错——旧快照/
  // 旧 flatten 产物照常工作。fmt 严格校验（有校验故随 flatten 升版）：@2＝含 lineGroups
  //（主支线合并）；@1＝仅 lineOrder（旧快照，无组信息＝逐线独立显示）。三版都收 lineOrder；
  // 2026-11-23 增 @3＝另含 stationGroups（嵌套换乘组结构表，喂 buildGroupTree）。解读与判型
  // 收在 VIEWER_CORE.parseNetIndex（单测覆盖）。lineinfo.md（线路手填介绍）同回退链
  //（2026-11-23 增）：缺失＝静默无信息节。
  const NET_BASES = ['net', 'build/net'];
  async function fetchNetFiles() {
    let lastErr = null;
    for (const base of NET_BASES) {
      // 本地预览位（build/net）每次向本地服务重新验证：python http.server 只发 Last-Modified
      // 不发 Cache-Control，浏览器按启发式新鲜度直接吃旧缓存——flatten 刚重生成、用户
      // 刷新后仍看到旧数据（2026-11-22 抓包）。发布位 net/ 保持默认，照常吃 CDN 缓存。
      const opts = base === 'build/net' ? { cache: 'no-cache' } : undefined;
      let linesFC;
      try {
        linesFC = await fetchJSON(base + '/lines.geojson', opts);
      } catch (e) { lastErr = e; continue; }
      let stopsFC = { type: 'FeatureCollection', features: [] };
      try {
        stopsFC = await fetchJSON(base + '/stops.geojson', opts);
      } catch (e) {
        console.warn('提示：' + base + '/stops.geojson 缺失，按零站处理（' + (e && e.message) + '）');
      }
      let indexOrder = null, lineGroups = null, stationGroups = null;
      try {
        const idx = await fetchJSON(base + '/index.json', opts);
        // fmt 名单外的 index 整份视同不存在、字段类型不符视同缺省；唯 @3 而 stationGroups 非数组
        //＝数据契约被破坏（嵌套组会被画成平铺），按无嵌套（各组顶层）处理并告警——不抛
        //（启动期抛错＝整页黑屏）
        const parsed = V.parseNetIndex(idx);
        indexOrder = parsed.indexOrder;
        lineGroups = parsed.lineGroups;
        stationGroups = parsed.stationGroups;
        if (parsed.problem) console.warn('提示：' + base + '/index.json ' + parsed.problem);
      } catch (e) { /* 无 index.json＝无自定义序/无线组/无换乘组结构，容错直通 */ }
      // lineinfo.md（用户手填的每线组介绍，flatten 原样透传）：缺失/失败＝静默无信息，
      // 不影响地图（连 console 都不打——没写信息是常态，不是异常）
      let lineInfo = null;
      try {
        lineInfo = V.parseLineInfo(await fetchText(base + '/lineinfo.md', opts));
      } catch (e) { /* 无 lineinfo.md＝一切线组无信息节 */ }
      return { linesFC, stopsFC, base, indexOrder, lineGroups, stationGroups, lineInfo };
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
  // 'off'/'osm'/'carto' 恒等直通、'gaode' 变 GCJ02）——bbox 也按显示坐标记账（fitAll/选中定位与
  // 渲染同帧一致；与 WGS84 差数百米，全图 fit 无感）。导出走权威结构，不经此处。
  // 2026-11-22 改版：特征带 dim 位（S.dimmed 调光线集），各图层 paint 据此半透明
  //（分期四档/聚焦两模式共用；调光状态下重设 source 即刷新）。
  // 2026-11-22 用户需求 3＋2＋定案轮：基础线层跳 feature 规则汇总（bbox 记账照旧——
  // 只跳 feature 不跳线，fitBounds/搜索定位不受影响）：
  //   ① fadeSet（聚焦绑定联络线）——渐变高亮层接管，半透明底线会垫在渐变尾端底下
  //      透出，违反「另一端 alpha 0」；
  //   ② blendSet（有效联络线，常驻）——双端渐变层接管（颜色由 connects 两端线决定）；
  //   ③ arrowSet（含出省端 arrow 的线，常驻）——arrow-fade 渐变层接管（线身末端 1km
  //      渐隐示意出省，2026-11-22 用户改版）；
  //   ④ 聚焦时的聚焦组成员——focus-copy 重画层接管（画在白罩之上，维持原色不被罩
  //      压白——白罩定案后聚焦高亮唯一形态）。
  function veilFocusSkipSet() {
    if (S.focus == null) return null;
    const grp = S.lineGroups.ofLine.get(S.focus);
    return new Set(grp ? grp.members : [S.focus]);
  }
  function renderLinesFC() {
    S.dispBbox = new Map();
    const dc = S.dispCoord;
    const veilSkip = veilFocusSkipSet();
    const features = [];
    for (const line of S.linesMap.values()) {
      let bb = null;
      const dim = S.dimmed.has(line.lineId) ? 1 : 0;
      const skip = S.fadeSet.has(line.lineId) || S.blendSet.has(line.lineId)
        || S.arrowSet.has(line.lineId)
        || (veilSkip != null && veilSkip.has(line.lineId));
      for (const seg of line.segments) {
        const coords = [];
        for (const pt of seg.coords) {
          if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
          const p = dc(pt[0], pt[1]);
          coords.push(p);
          bb = mergeBbox(bb, [p[0], p[1], p[0], p[1]]);
        }
        if (coords.length < 2) continue;
        if (skip) continue;   // 渐变/重画层接管的线不进基础线层（bbox 已记账，见上注）
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { lineId: line.lineId, name: line.name, color: line.color, segStatus: seg.segStatus, segIndex: seg.segIndex, dim, dash: V.lineDashed(line) },
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
  // 站圈聚焦成员集（2026-11-22 真机反馈轮）：单站＝[本线]、组符号（junction 合并圈/
  // 换乘大圈）＝成员线 lineIds——与 pinDimmed 同源规则（任一成员在聚焦组即「聚焦参与」，
  // 罩上完整显示；出闸组成员各自独立成圈，按本线各自判定）。写入 feature 的 members
  // 属性供 filter 表达式判定（见 memberMatchExpr）。
  function pinMembers(pin) {
    const ids = (pin.kind === 'group' && Array.isArray(pin.lineIds) && pin.lineIds.length)
      ? pin.lineIds : (pin.lineId ? [pin.lineId] : []);
    return ids.map(String);
  }
  function renderStopsFC() {
    // pin → circle：白填充；描边＝无组站取线色（联络线站优先 pin.stroke＝最近端
    // 目标线色——2026-11-22 用户需求 2，flatten 产出经 stopList/pinOfStop 透传）、
    // 同站组/出闸成员黑边（换乘语义）、junction 组取成员线角色优先级色；big（同站
    // 大圈）与 dark（黑边加粗）为渲染开关位。坐标过 S.dispCoord（同 renderLinesFC）。
    S.dispStopsBbox = null;
    const dc = S.dispCoord;
    const features = [];
    for (const pin of S.view.pins) {
      let stroke, dark = 0;
      if (pin.kind === 'group' && pin.groupType === 'junction') { stroke = junctionStroke(pin.lineIds); }
      else if (pin.kind === 'group' || pin.groupType === 'out-of-station') { stroke = '#000000'; dark = 1; }
      else {
        const line = S.linesMap.get(pin.lineId);
        stroke = pin.stroke || (line ? line.color : '#999999');
      }
      const p = dc(pin.lon, pin.lat);
      S.dispStopsBbox = mergeBbox(S.dispStopsBbox, [p[0], p[1], p[0], p[1]]);
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p[0], p[1]] },
        properties: { key: pin.key, name: pin.name, lineId: pin.lineId || '', big: pin.big ? 1 : 0, dark, stroke, dim: pinDimmed(pin), members: pinMembers(pin) },
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
          // 药丸成员线集（2026-11-22 真机反馈轮）：聚焦参与判定用（罩下 filter 追加/罩上
          // 复制层，见 memberMatchExpr）——与 dim 位同源的成员信息，任一成员在聚焦组即豁免
          members: (pill.lineIds || []).map(String),
          // 药丸调光规则：全成员线被调光才半透明（任一成员未调光则正常——2026-11-22 用户裁定）
          dim: (pill.lineIds || []).length && pill.lineIds.every((id) => S.dimmed.has(id)) ? 1 : 0,
        },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  // ---------- 地图 ----------
  // 画布视觉参数＝编辑器同值常量（2026-11-22 用户裁定：查看器风格未定前复用编辑器画布）：
  // 线宽 7px 圆帽、药丸厚度 15（＝2×大圈半径 7.5）＋黑边 2.2、站圈 5.5/大圈 7.5、
  // 描边 2→1.2、黑边 2.2→1.32（2026-11-22 用户裁定：站圈描边宽度 ×0.6；药丸黑边不动）。
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
  // 预控通道虚线（2026-11-23 用户需求）：①line-dasharray 数值单位＝线宽倍数——CORRIDOR_DASHARRAY
  // [2,2]＝段长与间隔相等，基准线宽 7px 下名义 14px/14px（圆头端帽各外扩半线宽，观感约
  // 21px 实段/7px 空隙）；纹样以线宽计、随 line-width 等比缩放，z<11 线宽缩小时视觉一致。
  // ②常态基线不透明度 CORRIDOR_OPACITY＝0.6，调光系数照旧叠乘（dim case 取乘积 0.5×0.6）；
  // 颜色不变（['get','color']）。③相位：line-dashoffset 不在 MapLibre 样式规范（本项目
  // vendored maplibre-gl 5.24.1 的 bundle 无此属性字面量——line-* 属性名都在规范表里），
  // 「几何起点居实段中间」无从实现，退路＝从 dash 边界起始（每条通道起点首现整段实段）。
  const CORRIDOR_DASHARRAY = [2, 2];
  const CORRIDOR_OPACITY = 0.6;
  function lineLayerDef() {
    return {
      id: 'lines', type: 'line', source: 'lines',
      filter: ['==', ['get', 'dash'], 0],   // 实线层：剔虚线位线（预控通道走 lines-dash，互斥见 corridorLineLayerDef）
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
  // 预控通道虚线层定义（lines-dash / focus-copy-dash 共用骨架）：布局/线宽/颜色/调光机制
  // 与实线层同源，唯 line-dasharray＋常态基线 0.6；filter 显式 == 1 与实线层 == 0 互斥
  //（0/1 数字位，勿用 '!'——弃层坑见 STOP_LAYER_DEFS 注）。dasharray 数组逐次新建
  //（slice，防 addLayer 内部处理共享引用污染初始 style 定义——对齐 pillFocusLayerDef 同款谨慎）。
  function corridorLineLayerDef(id, source) {
    return {
      id, type: 'line', source,
      filter: ['==', ['get', 'dash'], 1],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-dasharray': CORRIDOR_DASHARRAY.slice(),
        'line-opacity': ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY * CORRIDOR_OPACITY, CORRIDOR_OPACITY],
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
  // 站圈层：按 big/dark 拆三层、各层尺寸全常量（编辑器同值：普通站圈 r5.5、出闸组成员
  // r5.5、换乘大圈 r7.5——.stop-c/.stop-merge；描边宽 2026-11-22 用户裁定 ×0.6：
  // 描边 2→1.2、黑边 2.2→1.32，见 STOP_LAYER_DEFS）。2026-11-22 修复：此前用
  // ['case'] 档位值作 zoom 插值 stops（数据驱动×zoom 复合表达式），真机目验两轮「线缩圆不缩」
  //（线层同助手常量 stops 正常）——拆层后每层 stops 全常量、与已验证的线宽层同一机制。
  // filter 三层互斥全覆盖：big⇒黑边大圈（same-station ≤2 线合并，dark 恒 1）、
  // dark&&!big⇒出闸组成员（各自成圈不并点）、其余＝普通站＋junction 组（描边色仍逐站
  // ['get','stroke'] 取线色/角色优先级色——颜色数据驱动不带 zoom，不受此坑影响）。
  // ⚠ filter 一律显式 ['==', ['get','x'], 0/1]：表达式 '!' 要求布尔输入，而 GeoJSON 属性
  // big/dark 是数字——'!' 数字判类型错，所在层被 MapLibre 静默弃载（c07360d「站圆全没」
  // 根因：无 filter 的药丸/线层照常渲染，三个站圈层全弃；错误只进 console 不上画面）。
  const STOP_LAYER_DEFS = [
    // 描边宽 2026-11-22 用户裁定 ×0.6：2→1.2、黑边 2.2→1.32（仅站圈三层；药丸
    // 黑边 pills-outer 19.4 不动）
    { id: 'stops', filter: ['all', ['==', ['get', 'big'], 0], ['==', ['get', 'dark'], 0]], radius: 5.5, strokeW: 1.2 },
    { id: 'stops-dark', filter: ['all', ['==', ['get', 'big'], 0], ['==', ['get', 'dark'], 1]], radius: 5.5, strokeW: 1.32 },
    { id: 'stops-big', filter: ['==', ['get', 'big'], 1], radius: 7.5, strokeW: 1.32 },
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
  // 站圈/药丸层交互绑定（点选开站点面板＋hover 提示＋pointer 光标）：基础静态五层与
  // 罩上复制层（*-focus，2026-11-22 真机反馈轮）共用一套——聚焦时聚焦成员 feature 只在
  // 罩上层渲染，事件绑定必须随层走；removeLayer 自动解绑旧层，全删全建后随建随绑。
  function bindPinLayerInteraction(id) {
    const map = S.map;
    map.on('click', id, (e) => {
      const p = e.features && e.features[0] && e.features[0].properties;
      if (p && p.key) openStopPanel(String(p.key));
    });
    map.on('mouseenter', id, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', id, () => { map.getCanvas().style.cursor = ''; hideStopTip(); });
    map.on('mousemove', id, showStopTip);
  }
  function buildMap() {
    const map = new G.maplibregl.Map({
      container: 'map',
      // 内联 style：无 glyphs、无底图 sources、无任何 symbol 层（中文标签走 HTML 叠加层；
      // 2026-11-22 定案轮后 arrows 图标层已删——出省示意改线身渐隐，见 rebuildConnLayers）。
      // 测试阶段底图不在 style 里声明——惰性 addSource，
      // 保证默认（无底图）路径零外部资源零网络请求。
      style: {
        version: 8,
        sources: {
          lines: { type: 'geojson', data: renderLinesFC() },
          stops: { type: 'geojson', data: renderStopsFC() },
          pills: { type: 'geojson', data: renderPillsFC() },
          // 联络线渐变＋出省渐隐共用 source（2026-11-22 用户需求 3＋定案轮）：lineMetrics:true
          // 是 line-gradient 的前置要求；初始空 FC，由 rebuildConnLayers 动态填数＋逐线加层。
          // 渐变图层不进初始 layers——按需才建（见 rebuildConnLayers）。
          'conn-fade': { type: 'geojson', lineMetrics: true, data: { type: 'FeatureCollection', features: [] } },
          // 省级界线底图 source（2026-11-23）：初始空 FC——loadProvinces 异步读仓库静态件
          // basemap/provinces-wgs84.json 后 setData（fetch 先于样式就绪时由 map 'load'
          // 处理器补应用，见 applyProvincesToMap）。
          provinces: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
          // 白罩高亮 source（2026-11-22 用户需求 3）：focus-veil＝全世界矩形 Polygon
          //（数据常量——任何平移不出界；层动态建删，非聚焦态不建）；focus-copy＝聚焦
          // 重画层 source（初始空 FC，veil＋聚焦时填聚焦组成员特征）。层均不进初始 layers。
          'focus-veil': {
            type: 'geojson',
            data: {
              type: 'Feature', properties: {},
              geometry: { type: 'Polygon', coordinates: [[
                [-180, -85], [-180, 85], [180, 85], [180, -85], [-180, -85],
              ]] },
            },
          },
          'focus-copy': { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
        },
        layers: [
          { id: 'bg', type: 'background', paint: { 'background-color': '#ffffff' } },   // 2026-11-22 三批：黑板→白板
          // 省级界线层（2026-11-23）：bg 之上、线路之下；底图瓦片／白遮罩由 ensureBasemapLayers
          // 插到本层之下（界线浮在遮罩上不被盖住）。只画线不填充，低调灰常量 1px（⚠ 血泪教训：
          // line-join 属 layout 属性放 paint 会拒载整个 style；色宽恒常量，不搞数据驱动×zoom 复合）。
          {
            id: 'provinces', type: 'line', source: 'provinces',
            layout: { 'line-join': 'round' },
            paint: { 'line-color': '#a8a8a8', 'line-width': 1 },
          },
          ...LINE_LAYER_IDS.map(lineLayerDef),
          corridorLineLayerDef('lines-dash', 'lines'),   // 预控通道虚线（同 source 紧挨实线层——药丸之下罩下区，2026-11-23）
          ...PILL_LAYER_DEFS,          // 药丸垫在站圈之下（罩下区：聚焦时与站圈一起被白罩罩淡）
          ...STOP_LAYER_DEFS.map(stopLayerDef),   // 站圈按 big/dark 拆三层（常量档位；罩下区，层序见 rebuildConnLayers 注）
        ],
      },
      center: [121.48, 31.22], zoom: 9.5,
      attributionControl: false,
    });
    S.map = map;
    map.addControl(new G.maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

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
    // 站圈三层（big/dark 拆层，filter 互斥）＋药丸两层（成员圈已隐去，药丸本体承接点选/
    // hover，两层同源内外均可命中）共绑同一组交互——行为与单层时代完全一致；聚焦时的
    // 罩上复制层（*-focus）在 rebuildConnLayers 建层处同绑（聚焦成员 feature 只在其上渲染）
    for (const id of STOP_LAYER_DEFS.map((d) => d.id).concat(['pills-inner', 'pills-outer'])) {
      bindPinLayerInteraction(id);
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
      // 省界底图：fetch 先于样式就绪完成时由此补 setData（applyProvincesToMap 幂等，
      // S.provincesFC 未回填时是空 FC 重设，无副作用）
      applyProvincesToMap();
      // 常驻 blend 层首次建立（联络线双端渐变不依赖聚焦——两条 pending 路径各自
      // 已调过 rebuildConnLayers，此处幂等重跑一次兜底，全删全建无副作用）
      rebuildConnLayers();
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

  // ---------- 省级界线底图（常驻，2026-11-23 用户明示授权外部底图数据） ----------
  // 数据：仓库静态件 basemap/provinces-wgs84.json（WGS84）——tools/provinces_basemap.py 生成
  //（OSM admin_level=4 全精度 WGS84 零转换 → 长三角 bbox 裁剪＋60m Douglas–Peucker 简化；
  // 来源与许可口径见该脚本头注）。零外部请求原则：运行时只读仓库内落盘文件，不向任何外网拉数据。
  // 层序：底图瓦片／白遮罩之上、线路之下（ensureBasemapLayers 的 before 指到 'provinces'）；
  // 纯地理参照，不参与分期/聚焦/调光，颜色线宽全常量。坐标逐点过 S.dispCoord——高德底图态下
  // 界线与线路数据同一显示变换通道（与瓦片同基准）；OSM／CARTO／无底图态 dispCoord＝恒等即 WGS84 直出。
  function renderProvincesFC() {
    const fc = S.provincesFC;
    if (!fc || !Array.isArray(fc.features)) return { type: 'FeatureCollection', features: [] };
    const dc = S.dispCoord;
    const mapC = (c) => (Array.isArray(c[0]) ? c.map(mapC) : dc(c[0], c[1]));
    return {
      type: 'FeatureCollection',
      features: fc.features.map((f) => ({
        type: 'Feature',
        properties: f.properties || {},
        geometry: { type: f.geometry.type, coordinates: mapC(f.geometry.coordinates) },
      })),
    };
  }
  // setData 补应用：fetch 回填（loadProvinces）与底图切换（applyBasemapToMap）两条路都走这里；
  // 样式未就绪时直接返回——map 'load' 处理器会再调一次兜底（同 basemapPending/dimPending
  // 的补应用模式，界线无独立目标态：S.provincesFC 一旦有值，load 后调本函数即完成回放）。
  function applyProvincesToMap() {
    if (!S.map || !(S.styleReady || S.map.isStyleLoaded())) return;
    if (S.map.getSource('provinces')) S.map.getSource('provinces').setData(renderProvincesFC());
  }
  function loadProvinces() {
    fetchJSON('basemap/provinces-wgs84.json').then((fc) => {
      if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
        throw new Error('结构不符（须为 FeatureCollection）');
      }
      S.provincesFC = fc;
      applyProvincesToMap();
    }).catch((e) => {
      // 装饰性底图缺了不阻断启动（线网本体照常）；显式告警（MapLibre 运行时错误不上控制台）
      console.warn('提示：省界底图加载失败（不影响线网显示）：' + (e && e.message ? e.message : e));
    });
  }

  // ---------- 测试阶段底图（四态：无 → OSM → 高德 → CARTO无字 → 无 循环） ----------
  // ⚠ 测试阶段功能（2026-11-22 用户指示的阶段性豁免）：早前用户曾裁定「查看器不放底图、
  // 零外部资源」，本段为测试期豁免，正式上线可能保留也可能移除（2026-11-23 用户裁定：打磨
  // 最后阶段移除白板/OSM/高德、只留 CARTO 并删切换按钮）——移除时删本段＋顶栏按钮＋
  // 图例卡署名行＋S 里三字段即可。默认 'off' 与无底图现状完全一致（不 addSource、零网络请求）；
  // 状态会话内不持久化（每次加载默认无底图）。
  // 对齐设计：OSM 与 CARTO（Positron 无字版，2026-11-23 接入，瓦片 WGS84）与数据同基准
  // 直接叠（S.dispCoord 恒等直通）；高德瓦片 GCJ02——不动瓦片、只把显示用坐标
  // 过 S.dispCoord（WGS84→GCJ02），权威数据与 GeoJSON/KML 导出一律 WGS84 一个字节不动
  //（编辑器是「逐瓦片常量偏移」动瓦片侧，查看器数据侧变换，各自单侧适配、殊途同归）。
  const BASEMAP_LABEL_ZH = { off: '无', osm: 'OSM', gaode: '高德', carto: 'CARTO无字' };
  const BASEMAP_ATTR_ZH = {
    osm: '底图 © OpenStreetMap 贡献者',
    gaode: '底图 © 高德',
    carto: '底图 © OpenStreetMap contributors © CARTO',   // CARTO 条款硬性署名（文字即可）
  };
  // 底图白色遮罩不透明度按底图态分档（2026-11-23 用户裁定「对于carto无字来讲，这个遮罩太厚了。
  // 仅carto正常情况改为35，高亮情况下改为30」）：carto 态常态 35%/聚焦 30%——Positron 本就浅，
  // 60% 下几乎只剩水系轮廓；OSM／高德态维持 60%/40% 不变（用户点名仅 carto，字面执行）。
  // 聚焦态恒比常态薄一档——聚焦高亮已有 70% 白罩（FOCUS_VEIL_OPACITY），底图遮罩再叠厚
  // 两层叠白会看不清。历史档位：2026-11-22 用户档位测试定值 40%（临时下拉控件已删，调值改
  // 此处）；2026-11-23 常态提亮 60%、唯聚焦态保持 40%；同日 carto 态再降档为查表分档。
  // 聚焦态判定＝现有状态变量 S.focus（null＝未聚焦），不新造状态；随聚焦进出与底图切换
  // 换档走 syncBasemapVeil（applyDimState＝分期/聚焦两条路径的汇聚点＋applyBasemapToMap＝
  // 底图开启时补一档）。
  const VEIL_OPACITY = { osm: 0.6, gaode: 0.6, carto: 0.35 };
  const VEIL_OPACITY_FOCUS = { osm: 0.4, gaode: 0.4, carto: 0.30 };
  // 取当态档位；off／未知态兜底取 osm 档（veil 仅底图非 off 时可见，值不生效，纯防御）
  function veilOpacityFor(focused) {
    const t = focused ? VEIL_OPACITY_FOCUS : VEIL_OPACITY;
    return t[S.basemap] != null ? t[S.basemap] : t.osm;
  }
  // 遮罩层未建（底图从未开过）防御跳过——样式未就绪期由 dimPending/basemapPending 补应用
  // 机制兜底（load 后两路径都会重进 applyDimState/applyBasemapToMap）。
  function syncBasemapVeil() {
    if (!S.map || !S.map.getLayer('basemap-veil')) return;
    S.map.setPaintProperty('basemap-veil', 'fill-opacity', veilOpacityFor(S.focus != null));
  }
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
  // CARTO（Positron 无字版，仅查看器有）单条官方 raster URL；key＝用户申请的免费 key，浏览器端
  // 公开属官方接受的用法，建议用户在 CARTO dashboard 配 referer 限制防盗用。
  // 2026-11-22 三批：瓦片 100% 不透明（旧 0.45 透明作废），提亮改走白色遮罩 fill 层——
  // 全世界矩形（Mercator ±85.0511，任何平移不出界），插在瓦片之上、线路之下，只洗底图
  // 不碰线网站名；不透明度＝按底图态分档查表（见 VEIL_OPACITY 注：carto 35%/聚焦 30%、
  // 其余 60%/40%；2026-11-23 用户裁定）。
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
    map.addSource('basemap-carto', {
      type: 'raster', tileSize: 256,
      tiles: ['https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png?key=cb1_5e93_1_df67d9c33ed32773609298af'],
    });
    map.addSource('basemap-veil', {
      type: 'geojson',
      data: {
        type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[
          [-180, -85.0511], [-180, 85.0511], [180, 85.0511], [180, -85.0511], [-180, -85.0511],
        ]] },
      },
    });
    // 省界层在底图之上、线路之下（2026-11-23）：raster＋白遮罩插到省界层之下（界线浮在
    // 遮罩与瓦片上不被盖住）；省界层异常缺失时回落旧行为＝插到首条线路层之下。
    const before = map.getLayer('provinces') ? 'provinces'
      : (map.getLayer(LINE_LAYER_IDS[0]) ? LINE_LAYER_IDS[0] : undefined);
    map.addLayer({ id: 'basemap-osm', type: 'raster', source: 'basemap-osm',
      layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } }, before);
    map.addLayer({ id: 'basemap-gaode', type: 'raster', source: 'basemap-gaode',
      layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } }, before);
    map.addLayer({ id: 'basemap-carto', type: 'raster', source: 'basemap-carto',
      layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } }, before);
    map.addLayer({ id: 'basemap-veil', type: 'fill', source: 'basemap-veil',
      layout: { visibility: 'none' }, paint: { 'fill-color': '#ffffff', 'fill-opacity': veilOpacityFor(false) } }, before);
  }
  // 应用到地图：层可见性＋显示坐标变换＋四个 source 全量 setData 重渲染＋标签重排
  //（复用既有 render 函数，mode 变了自然产出变换后坐标）。箭头 icon-rotate 角度是 WGS84
  // 下算的——GCJ 常量级偏移（百米级）对方向角影响可忽略，不重算；fitAll/选中定位用的
  // dispBbox 已是显示坐标（与渲染同帧），不特殊处理。
  function applyBasemapToMap() {
    if (S.basemap !== 'off') ensureBasemapLayers();
    syncBasemapVeil();   // 遮罩档位随聚焦态与底图态（建层先落当态常态档，聚焦中开底图即刻换聚焦档）
    const vis = (layerId, on) => {
      if (S.map.getLayer(layerId)) S.map.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none');
    };
    vis('basemap-osm', S.basemap === 'osm');
    vis('basemap-gaode', S.basemap === 'gaode');
    vis('basemap-carto', S.basemap === 'carto');
    // 遮罩随底图开关（不透明度＝veilOpacityFor 按底图态分档：carto 35%/聚焦 30%、其余
    // 60%/40%，无其他运行时档位；2026-11-23 用户裁定——Positron 本就浅，仅 carto 降档）
    vis('basemap-veil', S.basemap !== 'off');
    // 显示坐标变换：gaode 变 GCJ02；osm/carto 瓦片均 WGS84 恒等直通（carto 显式传 'carto'，
    // makeDispCoord 恒等分支，与 osm 同类）
    S.dispCoord = V.makeDispCoord(S.basemap === 'gaode' ? 'gaode' : (S.basemap === 'carto' ? 'carto' : 'none'));
    if (S.map.getSource('lines')) S.map.getSource('lines').setData(renderLinesFC());
    if (S.map.getSource('stops')) S.map.getSource('stops').setData(renderStopsFC());
    if (S.map.getSource('pills')) S.map.getSource('pills').setData(renderPillsFC());
    applyProvincesToMap();   // 省界与线路数据同一显示变换通道：gaode 态下坐标随 dispCoord 重投影
    rebuildConnLayers();   // 渐变/重画特征坐标必须同帧过 S.dispCoord（2026-11-22 用户需求 3）
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
  // 叠加不冲突——坐标变换与 dim 位各管各的）。样式未就绪时只置 pending 标记（同底图四态
  // 模式），on('load') 后补应用，点击不丢失。
  function applyDimState() {
    // 2026-11-22 主支线合并：调光组级（lineGroups 传入——期次/仅显示级以主线为准；
    // S.focus 恒为主线 id，见 toggleFocus 归一）。
    // 2026-11-22 白罩定案：聚焦不贡献 dim（focus 仅作 displayOnly 激活位），无 hlMode。
    S.dimmed = V.computeDimmedSet(S.linesMap,
      { phase: S.phase, focus: S.focus, lineGroups: S.lineGroups });
    updateFadeSet();   // fadeSet 须在 renderLinesFC 之前就绪（基础层跳 feature 依赖它）
    if (!S.map || !(S.styleReady || S.map.isStyleLoaded())) { S.dimPending = true; return; }
    S.dimPending = false;
    if (S.map.getSource('lines')) S.map.getSource('lines').setData(renderLinesFC());
    if (S.map.getSource('stops')) S.map.getSource('stops').setData(renderStopsFC());
    if (S.map.getSource('pills')) S.map.getSource('pills').setData(renderPillsFC());
    rebuildConnLayers();   // 联络线渐变层＋白罩＋聚焦重画层＋出省渐隐层（全删全建）
    syncBasemapVeil();     // 底图白遮罩随聚焦态换档（按底图态分档：carto 30%⇄35%、其余 40%⇄60%，2026-11-23）
    scheduleLabels();
  }
  // ---------- 联络线渐变层＋白罩高亮（2026-11-22 用户需求 2＋3） ----------
  // 技术约束（MapLibre，血泪教训）：line-gradient 不能数据驱动（不能引用 feature
  // 属性）、要求 source 开 lineMetrics:true、feature 为单条 LineString——故全部联络
  // 线渐变共享一个 source（'conn-fade'）、每条线动态 addLayer 一个层，各自
  // line-gradient 用常量色插值，并以 filter ['==',['get','lineId'],…] 只渲染自己的
  // feature（层间互不串色）。
  // 两种形态、同一层族按态切 paint（rebuildConnLayers 全删全建）：
  //   · blend 形态（常驻，非聚焦或未被聚焦绑定）：line-gradient＝headColor→tailColor
  //     双端渐变（connectorBlendPlan 取色——颜色由 connects 两端线决定，全不透明），
  //     挂 line-opacity 的 dim case（feature 带 dim 位——联络线也受分期调光与他省
  //     规则；veil 模式下非聚焦线不进 dimmed＝不调光，自然全不透明）。坐标不反转
  //    （headColor 即拼接折线首端色）。
  //   · fade 形态（聚焦绑定，connects 含聚焦线）：「聚焦线色→透明」沿线渐变（基色
  //     ＝聚焦线在 linesMap 的 color——2026-11-22 用户需求 2 改：不再用联络线自身色），
  //     attachEnd===1 时 reverse 坐标保证「首端＝接入聚焦线的一端」，高亮态不挂 dim。
  // 渐变层不绑任何点击/hover（联络线本体的点选开面板走 'lines' 层——被剔除后渐变
  // 层上点不到就算了，可接受，与既有裁定一致）。
  // fadeSet 重算（纯数据，不碰地图）：必须在任何 renderLinesFC 之前执行——基础线层
  // 跳 feature 依赖它。plan 缓存进 S.fadeConnPlan 供 rebuildConnLayers 复用。
  function updateFadeSet() {
    const plan = S.focus != null ? V.connectorFadePlan(S.linesMap, S.focus) : [];
    S.fadeConnPlan = plan;
    S.fadeSet = new Set(plan.map((it) => it.lineId));
  }
  const EMPTY_CONN_FC = { type: 'FeatureCollection', features: [] };
  // 拼接 LineString 坐标（segments 按 segIndex 拼接 → 过滤有限坐标 → 逐点过
  // S.dispCoord 显示变换——与四 source 同帧，底图切换 gaode 下渐变坐标才不漂）；
  // 不足 2 点返回 null（全无效坐标的线本就不进基础层，这里同样不进渐变）
  function connCoords(line, reverse) {
    const dc = S.dispCoord;
    const coords = [];
    for (const seg of line.segments) {   // normalizeLines 已保证按 segIndex 升序
      for (const pt of seg.coords) {
        if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
        coords.push(dc(pt[0], pt[1]));
      }
    }
    if (coords.length < 2) return null;
    if (reverse) coords.reverse();   // fade 形态方向定向：恒「首端＝接入聚焦线的一端」
    return coords;
  }
  // 渐变层公共骨架：line-cap/line-join 是 layout 属性（⚠ 放 paint 会整个 style 拒载
  // 全黑——本项目踩过的坑）；线宽与线层同宽同缩放（V.zoomInterp(V.scaledSize(7),7)）。
  function connLayerSkeleton(layerId, lineId) {
    return {
      id: layerId, type: 'line', source: 'conn-fade',
      filter: ['==', ['get', 'lineId'], lineId],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': V.zoomInterp(V.scaledSize(V.LINE_WIDTH_PX), V.LINE_WIDTH_PX),
      },
    };
  }
  // blend 形态层定义：双端渐变全不透明（hex 直用，不带 alpha）＋dim case
  function connBlendLayerDef(layerId, lineId, headColor, tailColor) {
    const def = connLayerSkeleton(layerId, lineId);
    def.paint['line-gradient'] = ['interpolate', ['linear'], ['line-progress'],
      0, V.normalizeHex(headColor) || '#555555',
      1, V.normalizeHex(tailColor) || '#555555'];
    def.paint['line-opacity'] = ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1];
    return def;
  }
  // fade 形态层定义：聚焦线色 → alpha 0（rgba 串插值）
  function connFadeLayerDef(layerId, lineId, color) {
    const hex = V.normalizeHex(color) || '#888888';
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const def = connLayerSkeleton(layerId, lineId);
    def.paint['line-gradient'] = ['interpolate', ['linear'], ['line-progress'],
      0, 'rgba(' + r + ',' + g + ',' + b + ',1)',
      1, 'rgba(' + r + ',' + g + ',' + b + ',0)'];
    return def;
  }
  // arrow 渐变形态层定义：出省端末段 1km 线身沿线渐隐（2026-11-22 用户改版——查看器不再
  // 画三角 glyph，编辑器不动）。渐变 stops＝V.arrowFadeGradient（headCut/tailCut 端组合，
  // 线色取 linesMap 的 color——已含 flatten 组色合并）；挂 line-opacity 的 dim case
  //（feature 带 dim 位——arrow 线照常受分期调光与他省规则）。
  function arrowFadeLayerDef(layerId, lineId, color, headCut, tailCut) {
    const grad = V.arrowFadeGradient(color, headCut, tailCut);
    if (!grad) return null;   // 两端均无 arrow（防御：plan 不产这种条目）
    const def = connLayerSkeleton(layerId, lineId);
    def.paint['line-gradient'] = grad;
    def.paint['line-opacity'] = ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1];
    return def;
  }
  // ---------- 白罩高亮（2026-11-22 用户需求 3；同日定案轮收口） ----------
  // 裁定（用户原话要点）：高亮方式由「不变高亮线路半透明其他」改为「全都不动，在
  // 高亮线路和其他线路之间隔一层白色半透明遮罩」。白罩只管聚焦高亮的呈现；分期
  // 调光（其余半透明＋隐站名）与他省线恒调光是既有独立裁定，维持 opacity 行为不变。
  // 不透明度＝FOCUS_VEIL_OPACITY＝0.7（2026-11-22 用户确认定案值；对比期的「高亮/遮罩」
  // 两按钮与五档循环已删，调值改此处）。聚焦显示/退出撤除＝层随 rebuildConnLayers
  // 全删全建（存在即显示，等价 visibility 切换）。
  const FOCUS_VEIL_OPACITY = 0.7;
  function focusVeilLayerDef() {
    return {
      id: 'focus-veil', type: 'fill', source: 'focus-veil',
      paint: { 'fill-color': '#ffffff', 'fill-opacity': FOCUS_VEIL_OPACITY },
    };
  }
  // 聚焦重画层：layout/paint 与基础线层一致、唯 line-opacity 恒 1——不挂 dim case
  //（2026-11-22 定案轮语义对齐裁定：聚焦线恒原色，对齐旧「聚焦豁免一切调光」语义；
  // 原 veil 分支下聚焦线仍随分期半透明属对比期临时行为，一并纠正——分期态下其他线
  // 由白罩压灰、聚焦组罩上恒原色）。特征＝聚焦组全体成员（renderFocusCopyFC），画在
  // 白罩之上＝维持原色不被罩压白。
  function focusCopyLayerDef() {
    const def = lineLayerDef();
    def.id = 'focus-copy';
    def.source = 'focus-copy';
    def.filter = ['==', ['get', 'dash'], 0];   // 实线成员（虚线成员走 focus-copy-dash，互斥同基础层）
    def.paint['line-opacity'] = 1;   // 恒原色（不挂 dim case，见上注）
    return def;
  }
  // 罩上虚线重画层（2026-11-23）：预控通道被聚焦时罩上保持虚线身份——虚线是其画法本体，
  // 聚焦只豁免调光不改画法；opacity 恒 1（对齐 focus-copy「聚焦豁免一切」裁定，60% 基线
  // 是常态值、聚焦态罩上恒原色不受其约束）。
  function focusCopyDashLayerDef() {
    const def = corridorLineLayerDef('focus-copy-dash', 'focus-copy');
    def.paint['line-opacity'] = 1;
    return def;
  }
  // 聚焦重画特征：聚焦组成员的渲染特征（renderLinesFC 同款构造）；blend/fade/arrow
  // 成员跳过（渐变层接管——防御：联络线/出省线被录进线组的罕见形态，避免双层重复画，
  // 各渐变层自身已在白罩之上）。不带 dim 位（层定义恒原色，见 focusCopyLayerDef 注）；
  // 带 dash 位（2026-11-23：预控通道被聚焦时罩上重画保持虚线身份，实/虚两层收——
  // focusCopyLayerDef/focusCopyDashLayerDef）。坐标过 S.dispCoord（底图切换 gaode 同帧）。
  function renderFocusCopyFC() {
    const grp = S.lineGroups.ofLine.get(S.focus);
    const members = grp ? grp.members : [S.focus];
    const dc = S.dispCoord;
    const features = [];
    for (const lid of members) {
      const line = S.linesMap.get(lid);
      if (!line) continue;
      if (S.blendSet.has(lid) || S.fadeSet.has(lid) || S.arrowSet.has(lid)) continue;
      for (const seg of line.segments) {
        const coords = [];
        for (const pt of seg.coords) {
          if (!pt || !Number.isFinite(pt[0]) || !Number.isFinite(pt[1])) continue;
          const p = dc(pt[0], pt[1]);
          coords.push(p);
        }
        if (coords.length < 2) continue;
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { lineId: line.lineId, name: line.name, color: line.color, segStatus: seg.segStatus, segIndex: seg.segIndex, dash: V.lineDashed(line) },
        });
      }
    }
    return { type: 'FeatureCollection', features };
  }
  // ---------- 罩下基础层 filter 切换＋罩上符号复制层（2026-11-22 真机反馈轮） ----------
  // 需求（用户真机反馈）：白罩没罩住其他线路的设站（站圈/药丸）。解法＝静态站圈三层＋
  // 药丸两层的层序本身就在白罩之下（见 rebuildConnLayers 层序注），聚焦时五层 filter
  // 追加「非聚焦参与」（把聚焦成员 feature 排除出罩下层——防罩上复制层双层叠画），退出
  // 聚焦还原原 filter（不残留 in 条件）；聚焦成员的 feature 由罩上复制层
  //（stops-*-focus / pills-*-focus）重画——同 source 同尺寸、唯 opacity 恒 1（去 dim
  // case，对齐 focus-copy「聚焦豁免一切」裁定）。
  // 「聚焦参与」判定：feature 的 members 属性（renderStopsFC/renderPillsFC 补的成员线
  // id 数组）与聚焦组成员集（veilFocusSkipSet——主支线合并组全体）有交集；组符号
  //（junction 合并圈/换乘大圈/药丸）与药丸同「任一成员命中即豁免」规则（对齐 pinDimmed），
  // 单站＝本线。
  // 聚焦成员判定表达式：['any', ['in', '<成员线 id>', ['get','members']], …]（转置形态：
  // needle＝聚焦成员字面量、haystack＝feature 的数组属性——不用 lineId-in-literal 形态的
  // 原因：组 pin 的 lineId 属性是空串，判不了组符号，成员线集合必须整体存进数组属性）。
  // ⚠ 表达式 filter 中 '!'/'any' 包 'in' 的布尔结果是合法用法——与「'!' 吃 0/1 数字判
  // 类型错致弃层」的坑不同：in/any 产出的就是布尔，恰是 '!' 要求的输入；数字坑的规避
  // 仍是恒用显式 ['==', ['get', 'x'], 0/1]。空成员集返回 null（调用方跳过建层、不追加
  // filter——理论不可达，S.focus 非空则聚焦组至少含其自身）。
  function memberMatchExpr(members) {
    const arr = (Array.isArray(members) ? members : [])
      .map((m) => (m != null ? String(m) : '')).filter(Boolean);
    if (!arr.length) return null;
    return ['any'].concat(arr.map((m) => ['in', m, ['get', 'members']]));
  }
  // 罩下五层（站圈三层＋药丸两层）filter 同帧切换：聚焦＝原条件 ∧ 非(聚焦参与)；非聚焦
  // ＝原样还原（药丸两层原本无 filter → setFilter(null) 清除）。样式未就绪时不可达
  //（调用链 pending 机制兜底），层缺失防御跳过。
  function applyFocusFilters(memberExpr) {
    const map = S.map;
    for (const d of STOP_LAYER_DEFS) {
      if (!map.getLayer(d.id)) continue;
      map.setFilter(d.id, memberExpr ? ['all', d.filter, ['!', memberExpr]] : d.filter);
    }
    for (const id of ['pills-outer', 'pills-inner']) {
      if (!map.getLayer(id)) continue;
      map.setFilter(id, memberExpr ? ['!', memberExpr] : null);
    }
  }
  // 罩上站圈复制层定义：与 stopLayerDef 同 source 同 paint，唯 circle-opacity/
  // circle-stroke-opacity 恒 1（不挂 dim case——聚焦成员的站圈罩上完整显示）
  function stopFocusLayerDef(d, memberExpr) {
    return {
      id: d.id + '-focus', type: 'circle', source: 'stops',
      filter: ['all', d.filter, memberExpr],
      paint: {
        'circle-color': '#ffffff',
        'circle-radius': V.zoomInterp(V.scaledSize(d.radius), d.radius),
        'circle-stroke-color': ['get', 'stroke'],
        'circle-stroke-width': V.zoomInterp(V.scaledSize(d.strokeW), d.strokeW),
        'circle-opacity': 1,
        'circle-stroke-opacity': 1,
      },
    };
  }
  // 罩上药丸复制层定义：与 PILL_LAYER_DEFS 同 source 同尺寸，唯 line-opacity 恒 1；
  // ⚠ line-cap/line-join 是 layout 属性（放 paint 会拒载整个 style 全黑——本项目踩过的
  // 坑）；layout/paint 逐键新造对象，不复用常量层定义里的引用（防 addLayer 内部处理
  // 污染初始 style 定义）
  function pillFocusLayerDef(base, memberExpr) {
    return {
      id: base.id + '-focus', type: 'line', source: 'pills', filter: memberExpr,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': base.paint['line-color'],
        'line-opacity': 1,
        'line-width': base.paint['line-width'],
      },
    };
  }
  // ---------- 动态层统一重建（全删全建） ----------
  // 挂接点：applyDimState 与 applyBasemapToMap 末尾（调光/聚焦与底图切换都重设 source
  // 坐标）；样式未就绪的 pending 路径由既有 dimPending/basemapPending 补应用机制自然覆盖。
  // 层序总排布（自下而上；2026-11-22 真机反馈轮——站圈/药丸移罩下＋罩上符号复制层）：
  //   bg/basemap → lines 基础层 → lines-dash（预控通道虚线，2026-11-23）→ conn-blend（未被聚焦绑定的联络线渐变）→（静态五层）
  //   pills-outer/inner → stops/stops-dark/stops-big（以上全部罩下；聚焦时这五层 filter
  //   追加「非聚焦参与」——聚焦成员 feature 只上罩上层，不双层叠画，见 applyFocusFilters）
  //   → focus-veil 白罩 → focus-copy 聚焦重画（实/虚两层，2026-11-23 预控通道虚线随线走）→ conn-fade 渐变高亮 → arrow 渐隐层 →
  //   pills-outer-focus/pills-inner-focus → stops-focus/stops-dark-focus/stops-big-focus
  //（罩上符号复制：聚焦成员的药丸/站圈恒原色完整显示）→ HTML 站名标签（聚焦时仅聚焦
  //   组成员的标签显示，见 visibleLabels）。
  //   非聚焦：无罩上层族、五层 filter 还原（不残留 in 条件），blend/arrow 层位置与旧
  //   层序完全一致（紧挨线层之上、药丸之下）。
  // 两个插入位点：addLow＝插在 'pills-outer' 之前（罩下线区顶——blend/非聚焦 arrow）；
  // addTop＝加到最顶（罩上层族按添加序自下而上叠放）。全删全建模式下按序添加即层序，
  // 无 before 锚漂移；静态 pills/stops 五层永在此函数外（初始 style），只切 filter 不重建。
  function rebuildConnLayers() {
    const map = S.map;
    if (!map) return;
    for (const id of S.connLayerIds) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    S.connLayerIds = [];
    const src = map.getSource('conn-fade');
    const feats = [];
    const addLow = (def) => {
      map.addLayer(def, map.getLayer('pills-outer') ? 'pills-outer' : undefined);
      S.connLayerIds.push(def.id);
    };
    const addTop = (def) => {
      map.addLayer(def);
      S.connLayerIds.push(def.id);
    };
    // 聚焦参与判定表达式（聚焦时才非 null）：罩下五层追加 ['!', expr]、罩上复制层用
    // expr 本体（构造与合法性注释见 memberMatchExpr）
    const memberExpr = S.focus != null ? memberMatchExpr([...veilFocusSkipSet()]) : null;
    // 罩下基础站圈/药丸五层 filter 同帧切换（与罩上层全删全建同一周期，退出聚焦还原）
    applyFocusFilters(memberExpr);
    // ① blend 形态联络线层（有效联络线中未被当前聚焦绑定的；聚焦绑定的走 fade
    //    形态插到白罩之上，故先跳过）
    const fadeIds = new Set((S.fadeConnPlan || []).map((it) => it.lineId));
    for (const it of S.blendPlan || []) {
      if (fadeIds.has(it.lineId)) continue;
      const line = S.linesMap.get(it.lineId);
      if (!line) continue;
      const coords = connCoords(line, false);
      if (!coords) continue;
      feats.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { lineId: line.lineId, dim: S.dimmed.has(line.lineId) ? 1 : 0 },
      });
      addLow(connBlendLayerDef('conn-blend-' + line.lineId, line.lineId, it.headColor, it.tailColor));
    }
    // ② 白罩＋聚焦重画层（仅聚焦——白罩定案后唯一高亮形态）
    if (S.focus != null) {
      addTop(focusVeilLayerDef());
      const copySrc = map.getSource('focus-copy');
      if (copySrc) copySrc.setData(renderFocusCopyFC());
      addTop(focusCopyLayerDef());
      addTop(focusCopyDashLayerDef());   // 预控通道成员罩上保持虚线（2026-11-23）
    }
    // ③ fade 形态联络线层（聚焦绑定：聚焦线色→透明；罩上＝渐变高亮不被罩压白；非聚焦无此层）
    const focusColor = (S.linesMap.get(S.focus) || {}).color;
    for (const it of S.fadeConnPlan || []) {
      const line = S.linesMap.get(it.lineId);
      if (!line) continue;
      const coords = connCoords(line, it.attachEnd === 1);
      if (!coords) continue;
      feats.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { lineId: line.lineId, dim: 0 },   // 高亮态不挂 dim
      });
      addTop(connFadeLayerDef('conn-fade-' + line.lineId, line.lineId, focusColor));
    }
    // ④ arrow 渐隐层（出省端末段 1km；常驻不依赖聚焦）：**该线为聚焦组成员时**才加罩上
    //    （渐隐段是聚焦线的一部分，不被罩压白；2026-11-22 修复：原「只要存在聚焦就上罩」
    //    致非聚焦的 arrow 线——如沪乍线——全线浮在白罩上，用户真机抓包），且在罩上符号
    //    复制层之下（线在下、符号在上——与静态区相对序一致）；其余（非聚焦成员/无聚焦）
    //    加罩下（blend 之上、药丸之下——与旧层序完全一致）。联络线不出省（无 arrow 站），
    //    fade/blend/arrow 三个跳过集合在 renderLinesFC 取并集，天然容错互斥之外的脏数据。
    const arrowFocusIds = new Set(
      S.focus != null
        ? (S.lineGroups.ofLine.get(S.focus) || { members: [S.focus] }).members.map(String)
        : []);
    for (const it of S.arrowPlan || []) {
      const line = S.linesMap.get(it.lineId);
      if (!line) continue;
      const coords = connCoords(line, false);
      if (!coords) continue;
      const def = arrowFadeLayerDef('arrow-fade-' + line.lineId, line.lineId, line.color, it.headCut, it.tailCut);
      if (!def) continue;
      feats.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { lineId: line.lineId, dim: S.dimmed.has(line.lineId) ? 1 : 0 },   // 照常受分期调光与他省规则
      });
      if (arrowFocusIds.has(String(line.lineId))) addTop(def); else addLow(def);
    }
    // ⑤ 罩上符号复制层（2026-11-22 真机反馈轮：聚焦成员的站圈/药丸在罩上完整显示）——
    //    同 source 同尺寸、opacity 恒 1（去 dim case，对齐 focus-copy「聚焦豁免一切」
    //    裁定）；filter＝原条件 ∧ 聚焦参与。添加序 pills 先 stops 后（药丸垫底站圈
    //    盖上——与静态区相对序一致）；点选/hover 与基础层同绑（罩上 feature 只在这层
    //    渲染，事件绑定随层走）。退出聚焦＝层随全删全建消失、filter 还原。
    if (S.focus != null && memberExpr) {
      for (const base of PILL_LAYER_DEFS) {
        const def = pillFocusLayerDef(base, memberExpr);
        addTop(def);
        bindPinLayerInteraction(def.id);
      }
      for (const d of STOP_LAYER_DEFS) {
        const def = stopFocusLayerDef(d, memberExpr);
        addTop(def);
        bindPinLayerInteraction(def.id);
      }
    }
    if (src) src.setData(feats.length ? { type: 'FeatureCollection', features: feats } : EMPTY_CONN_FC);
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
  //（2026-11-22 定案轮删除：高亮方式切换 setHlMode/S.hlMode 与白罩不透明度五档
  //   cycleVeilOpacity/S.veilOpacity 两套对比开关——用户定案遮罩 70%，恒定值见
  //   FOCUS_VEIL_OPACITY，聚焦高亮不再有其他模式。）
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
    // 线路介绍（lineinfo.md 用户手填，2026-11-23 增；同日放宽节绑定「线组 id 或线 id」）：
    // 聚焦线先按所属线组 id 查节、查不到再落线自身 id（没建组的单线按线 id 写也能显示），
    // 一条线至多一节（组节优先）；节内顺序＝固定字段区→正文→相关链接区，插在导出按钮
    // 之前——阅读顺序＝摘要行→介绍→导出操作；无数据的线完全无痕（本框与原状逐像素一致）
    const liHit = V.lineInfoEntryOf(S.focus, S.linesMap, S.lineGroups, S.lineInfo);
    appendLineInfo(body, liHit ? [liHit.id] : [], () => '线路介绍');
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
    // 嵌套换乘节点（2026-11-23 用户裁定）：关系描述如实反映结构——换乘节点（自最外层组向下的
    // 链：它在哪个节点、哪一层）、节点成员（节点的直属站＋各子组）、换乘对端（出闸关系的另一端）。
    // 纯逻辑在 VIEWER_CORE.groupRelations；平铺组返回 null＝此处一行不加，面板与旧版完全一致
    const rel = pin.groupId
      ? V.groupRelations(pin.groupId, pin.kind === 'stop', S.groupTree, S.linesMap, S.lineGroups) : null;
    if (rel) {
      if (rel.nodeChain) infoRow(body, '换乘节点', rel.nodeChain);
      if (rel.nodeMembers) infoRow(body, '节点成员', rel.nodeMembers);
      if (rel.partners) infoRow(body, '换乘对端', rel.partners);
    }
    infoRow(body, pin.kind === 'group' ? '组 ID' : '站 ID', pin.kind === 'group' ? pin.groupId : pin.key);
    // 线路介绍（lineinfo.md 用户手填，2026-11-23 增；同日放宽节绑定「线组 id 或线 id」）：
    // 每条成员线先按其线组 id 查节、查不到再落线自身 id（没建组的单线也能显示），一条线
    // 至多一节（组节优先；同组的主线支线解析到同组 → 合为一节）；节题＝组名或线名（与
    // 「所属线路」行同源），节内顺序＝固定字段区→正文→相关链接区；无数据的线完全无痕
    //（行序＝pin.lineIds 即成员线序，去重）
    const pinSecs = [];
    const seenSec = new Set();
    for (const lid of pin.lineIds || []) {
      const hit = V.lineInfoEntryOf(lid, S.linesMap, S.lineGroups, S.lineInfo);
      if (hit && !seenSec.has(hit.id)) { seenSec.add(hit.id); pinSecs.push(hit); }
    }
    appendLineInfo(body, pinSecs.map((h) => h.id),
      (gid) => (pinSecs.find((h) => h.id === gid) || {}).name || gid);
  }

  // ---------- 线路信息节（lineinfo.md 用户手填介绍；2026-11-23 增） ----------
  // appendLineInfo(host, ids, captionOf)：按节绑定 id（线组 id 或线 id，2026-11-23 放宽）序
  // 在面板尾部追加信息节——节题（captionOf(gid) 给出，返回空串则不出节题行）→ 固定字段区
  //（键值对，复用 .info-row 低调样式）→ 正文（parseLineInfo 预渲染的受控 HTML，见 core 侧
  // 安全注）→ 相关链接区。没有 lineinfo 数据的 id 完全无痕（不建节点不占位）。字段与链接
  // 文本一律 textContent（解析结果里的原文），只有 bodyHtml 走 innerHTML（解析侧已全量
  // 转义＋白名单标签）。
  function appendLineInfo(host, ids, captionOf) {
    const seen = new Set();
    for (const raw of Array.isArray(ids) ? ids : []) {
      const gid = raw != null ? String(raw) : '';
      if (!gid || seen.has(gid)) continue;
      seen.add(gid);
      const info = S.lineInfo ? S.lineInfo[gid] : null;
      if (!info) continue;
      const fields = Array.isArray(info.fields) ? info.fields : [];
      const links = Array.isArray(info.links) ? info.links : [];
      const bodyHtml = typeof info.bodyHtml === 'string' ? info.bodyHtml : '';
      if (!fields.length && !links.length && !bodyHtml) continue;
      const sec = document.createElement('div');
      sec.className = 'lineinfo';
      const cap = captionOf ? captionOf(gid) : '';
      if (cap) {
        const capEl = document.createElement('div');
        capEl.className = 'lineinfo-cap';
        capEl.textContent = cap;
        sec.appendChild(capEl);
      }
      for (const fv of fields) {
        if (!Array.isArray(fv)) continue;
        infoRow(sec, String(fv[0] == null ? '' : fv[0]), String(fv[1] == null ? '' : fv[1]));
      }
      if (bodyHtml) {
        const b = document.createElement('div');
        b.className = 'lineinfo-body';
        b.innerHTML = bodyHtml;   // 解析侧已转义＋白名单标签（VIEWER_CORE.parseLineInfo 安全注）
        sec.appendChild(b);
      }
      if (links.length) {
        const ul = document.createElement('ul');
        ul.className = 'lineinfo-links';
        for (const lk of links) {
          if (!lk || !safeHref(lk.url)) continue;
          const li = document.createElement('li');
          const a = document.createElement('a');
          a.textContent = typeof lk.text === 'string' && lk.text ? lk.text : lk.url;
          a.href = lk.url;   // 解析侧 safeLinkUrl 已限 http/https/相对路径
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          li.appendChild(a);
          ul.appendChild(li);
        }
        if (ul.children.length) sec.appendChild(ul);
      }
      host.appendChild(sec);
    }
  }
  // 链接区渲染前的最后一道闸（与 core 侧 safeLinkUrl 同规则——纵深防御，改一处必同步另一处）
  function safeHref(url) {
    const u = String(url == null ? '' : url).trim();
    if (!u) return false;
    if (/^https?:\/\//i.test(u)) return true;
    const cut = u.search(/[/?#]/);
    return (cut < 0 ? u : u.slice(0, cut)).indexOf(':') < 0;
  }
  function exportLine(lineId, kind) {
    const line = S.linesMap.get(lineId);
    const base = line && line.name ? line.name : lineId;
    if (kind === 'geojson') {
      const obj = V.buildLineGeoJSON(lineId, S.linesMap, S.stops, S.groupTree);   // 结构树：嵌套节点的站补节点信息
      if (!obj) return;
      downloadText(base + '.geojson', JSON.stringify(obj, null, 2), 'application/geo+json');
    } else {
      const kml = V.buildLineKML(lineId, S.linesMap, S.stops, { tree: S.groupTree });
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
    // 站名可见性（优先级：全局站名开关 ＞ 聚焦常显·其余隐藏 ＞ 被调光线隐藏 ＞ zoom 门槛；
    // 2026-11-22 真机反馈轮——聚焦时非聚焦线站名一律隐藏）。focusMembers＝聚焦组成员
    // 集（主支线合并：支线站的站名也是聚焦线站名，须常显；无组退 [S.focus]）
    let focusMembers = null;
    if (S.focus != null) {
      const grp = S.lineGroups.ofLine.get(S.focus);
      focusMembers = grp && Array.isArray(grp.members) && grp.members.length ? grp.members : [S.focus];
    }
    const items = V.visibleLabels(S.dispLabels, map.getZoom(),
      { hideAll: !S.namesOn, dimmedSet: S.dimmed, focus: S.focus, focusMembers });
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
  // 会话内不持久化，刷新回展开（与底图四态等 UI 态一致）。
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
    // 测试阶段底图四态循环：无 → OSM → 高德 → CARTO无字 → 无（不持久化，刷新回默认「无」）
    $('btnBasemap').addEventListener('click', () => {
      setBasemap(S.basemap === 'off' ? 'osm'
        : (S.basemap === 'osm' ? 'gaode' : (S.basemap === 'gaode' ? 'carto' : 'off')));
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
    S.lineInfo = net.lineInfo || {};   // 线路手填介绍（线组id → 信息；缺失＝空表＝全部无信息节）
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
    // 联络线双端渐变取色（2026-11-22 用户需求 2：颜色由 connects 两端线决定）——
    // 数据加载后算一次、常驻不随聚焦变（blendSet 供 renderLinesFC 基础层剔除）
    S.blendPlan = V.connectorBlendPlan(S.linesMap);
    S.blendSet = new Set(S.blendPlan.map((it) => it.lineId));
    // 出省渐变计划（2026-11-22 用户改版）：arrow 站端属判定＋1km 渐变段 cut——boot 算
    // 一次常驻，不随聚焦变（arrowSet 供 renderLinesFC 基础层剔除，层在 rebuildConnLayers）
    S.arrowPlan = V.arrowFadePlan(S.linesMap, S.stops);
    S.arrowSet = new Set(S.arrowPlan.map((it) => it.lineId));
    // 换乘组结构树（2026-11-23 嵌套换乘组）：net/index.json 的 stationGroups（@3）× 站的直属组
    //（groupId）；旧快照（@1/@2 无结构表）＝各组顶层、无子组＝旧行为。视图与站点面板共用这一棵
    S.groupTree = V.buildGroupTree(net.stationGroups, S.stops);
    // 视图按「节点＝最外层组」出图；linesMap/lineGroups 供药丸逻辑线数判定（联络线不计、同一线组
    // 算一条——不传则退回按 distinct lineId 计的旧行为）
    S.view = V.buildStopView(S.stops, { linesMap: S.linesMap, lineGroups: S.lineGroups, tree: S.groupTree });
    S.dispLabels = S.view.labels;   // WGS84 直通（仅进 map.project 定位）
    S.pinByKey = new Map(S.view.pins.map((p) => [p.key, p]));
    for (const pill of S.view.pills || []) if (pill.pin) S.pinByKey.set(pill.pin.key, pill.pin);
    buildSearchIndex();

    buildMap();
    loadProvinces();   // 省界底图（仓库静态件，异步回填，不阻塞线网启动）
    buildLineList();
    wireUI();
    hideCenter();
    scheduleLabels();
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
