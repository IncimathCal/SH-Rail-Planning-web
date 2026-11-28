// viewer.js —— 新 UI 实装版（2026-11-26，源＝零散/新UI-demo/ 定稿 demo，经用户两轮目验
// 逐条确认；同日二轮 12+1 条反馈改版：①搜索态返回先清搜索回列表 ②线路页按来源返回
//（搜索来源保留词与结果） ③搜索线路条目色点＋副行分类 ⑥无字高德白罩 60/40 ⑦玻璃定稿
// 删对比控件 ⑨原生 title 全删 ⑬返回初始界面清聚焦分期——其余视觉条目在 index.html）。
// 2026-11-27 底图扩容＋按钮改版（用户终局裁定，研究报告
// 零散/底图研究-天地图卫星与用地图-261127.md）：①新增「用地」（planblock 规划用地图，
// 不透明底独立态）与「卫星」（shanghai_W 上海正射影像）两态，终态清单序
// 高德→无字高德→用地→卫星→OSM，carto 源保留代码后备不进清单；两源均 3857 标准 XYZ、
// WGS84 恒等（S.dispCoord 走恒等通道）、256px（planblock minzoom 10/maxzoom 18＝实际
// 缓存层界、shanghai_W maxzoom 20；卫星态另有 z12 双层结构——shanghai_W 实际缓存 z12
// 起，低 zoom 垫 Esri World Imagery，见 ensureBasemapLayers 卫星 source 注）；②底图按钮
// 循环退役——单点展开全部清单
//（#basemapMenu，短名＋色块＋当前态高亮；点选直达并收起／再点按钮收／点面板外收；
// 抽屉收起与离开主界面时自动收）；③白罩分档重构＝按底图明暗类归档 VEIL_BANDS
//（浅色矢量 60/40、carto 35/30、用地 32/27、卫星 32/22——后两档研究建议区间中值待
// 目验微调）；④署名补两态（用地＝市规资局、卫星＝市测绘院，惯例署名）。
// 2026-11-27 真机目验整改（三项）：①相机让位 padding 推广到一切相机动作——聚焦
// fitBounds（原有）＋初始 fitAll＋搜索车站 flyTo（用一次性 offset，见 cameraPadding 注），
// 左侧按面板态实时取（展开＝面板右缘＋24、收起＝24 默认呼吸量），抽屉收/展后续动作
// 自动跟随；②单击线路＝聚焦高亮（用户裁定，取代轻提示浮卡）：全局 map.on('click')＋
// e.point 查询式命中（queryRenderedFeatures 全层查询后按线身层过滤，不依赖层存在性、
// 不受动态层重建影响——per-layer 委托版真机单击无反应，弃），行为与列表点击完全同款
//（setFocus＋fitBounds＋面板线路页，来源恒 'list'）；分期态一律无效；联络线/他省线无
// 操作；轻提示浮卡整套删除（DOM/rAF 时钟/防抖/CSS）；cursor 悬停本地线身变 pointer
//（mousemove＋rAF 合帧，变化才写）。
// 2026-11-27 点击车站（用户裁定，推翻旧「点车站不触发面板」）：两入口（搜索结果点站＋
// 地图单击站圈/药丸，站圈优先于线身）一行为——flyTo 站坐标 zoom13＋波纹、白罩＋罩上
// 重画经过该站的全部自然线路（多线高亮内核＝veilFocusSkipSet/renderFocusCopyFC/
// updateFadeSet/updateLabels 泛化为集合；联络线只亮不列名＝conn-fade 渐变参与高亮）、
// 面板车站页（站名＋一行一自然线路＋一站多名逐行标注该线叫法）。同日修正裁定：车站页
// 线路行可点（高亮该线＋跳线路页，来源 'station'、逐级返回链）；他省线参与（进高亮集＋
// 列表行，渲染走聚焦态他省既有口径）；联络线守「技术线路名称不得出现在任何地方」钉死
// 规则不列名。分期态点车站＝解除分期进车站高亮；返回按进入来源回视图（search/line/
// list）并取消高亮。③7869eb1 随轻提示顺带修的两独立 bug 的等效防泄漏
// 承载：不再注册任何 per-layer 委托监听（监听累积从结构上消灭——全局 click/mousemove/
// mouseout 各恰一次）；不引入 setTimeout 链（hover 查询走 rAF 合帧，同 scheduleLabels）。
// 相对实装前查看器：地图画法/高亮语义/调光/白罩分档/分期语义（含 2026-11-25 他省纠正）
// 零改动，只重做 DOM/UI 层——移除顶栏/图例卡/站点面板/聚焦框/hover 提示/缩放数字，唯一
// 左侧面板（初始界面→主界面三选项卡列表→线路页）＋搜索占面板＋三循环按钮（显示线路/
// 站名/底图三态）＋抽屉收起＋右上公众号 logo＋车站定位 focus 动画。
// 高亮渐变：focus-veil 白罩常驻化（fill-opacity 0↔0.7 走 paint transition 渐入渐出）、
// basemap-veil 档位切换同挂 transition、站名标签 visibility 硬切改 opacity transition；
// 联络线 blend/fade 动态层与分期他省 dim 位的过渡未做（层全删全建/特征无稳定 id）。
// 2026-11-28 三项（用户需求）：①线路页车站列表环线表达（保持竖排不变）——环线段
//（section.loop，如 4 号线/26 号线）rail 一侧画 C 形细线从底部回接到顶部＋顶端箭头
// 示意循环＋段顶「环线」小字（环绕段＝末站开回首站，列表首末站不重复）；②共线区间
// 表达（sharedTracks 消费，flatten 线级透传＋V.lineStopSections row.shared）——区间
// 内站行加对方线色侧边条（逐行片段拼连续、区间首末行圆头，与地图共线双平行线同构）
// ＋区间首行「与〈对方名〉共线」小字（前置对方色小短条，与行尾可点的换乘「圆点＋
// 线名」视觉区分：共线≠换乘、静态不可点）；③换乘站（组站）标签去加粗——CSS
// .map-label.is-group 删 font-weight:600（字号档与描边宽度维持现状，用户只点名加粗）。
// 2026-11-27 动效改版（用户「所有动效都是硬切，希望改成滑动、平滑缩放到对应位置」）：
// ①面板四视图切换由 display 硬切改滑动过渡——视图绝对堆叠于 #panelViews 滑轨
//（CSS data-pos 三态，见 index.html），层级推挤方向（rank：splash<main<station<line）：
// 前进＝新视图自右滑入、旧视图退左淡出；返回反向。逐级返回链（列表→车站页→线路页）
// 方向自然正确；线路页状态下点站切车站高亮＝降级走返回向（侧向切换，视觉为「回到
// 车站层」）。搜索态展开/收起＝#viewMain.searching 驱动 #mainSwap 内交叉滑动（列表退左、
// 结果自右淡入）。视图常驻 DOM——滚动位置/搜索词/焦点零丢失。
// ②相机一律平滑：聚焦跳转 fitFocusLine 由 fitBounds 改 flyTo（cameraForBounds 按
// cameraPadding 解目标位——padding 只作解算输入、flyTo 不传 padding 选项，守「flyTo 的
// padding 写持久 transform 污染后续 fitBounds」既有裁定；duration 900）；车站交互
// enterStationByPin 与纯联络线站退路的 flyTo 同款。全部动画调用 essential:true——
// 2026-11-27 拆除「减少动态」降级：用户系统关闭动画效果时 reduce 分支把 flyTo 退化成
// 即时定位、面板过渡时长归零，与「要看到动画」的意愿相反（真机反馈「光速划走/瞬移」），
// essential:true＝MapLibre 语义下的必要动画、reduce 也不降级。唯二例外：首次加载
// fitAll 保持即时（首屏不闪，duration 0）；退出聚焦/车站页返回/面板返回不动相机（既有裁定）。
// 2026-11-27 深图态高亮策略（用户裁定）：浅色底图（高德/无字高德/OSM）白罩法照旧不变；
// 深图类两态（卫星 shanghai_W／用地 planblock）改为「降透明度法」——高亮任何东西（聚焦
// 单线/分期态/车站多线高亮）时白罩不动（底图遮罩 basemap-veil 恒常态档 0.32，VEIL_BANDS
// 的 focus 档数值保留定义但深图态不取＝veilOpacityFor 按态短路；高亮白罩 focus-veil 恒 0
// ＝syncFocusVeil 短路），高亮对比改用其他线路不透明度：非高亮线路（罩下那些）并入
// S.dimmed（dim 定义域从「联络线/他省」扩展到「全部非高亮线」——V.deepHighlightDimIds，
// 高亮成员照旧 veilSkip 豁免＋focus-copy 罩上重画全亮）→ line-opacity 0.5（DIM_OPACITY，
// 复用既有 dim case 通路不另起炉灶）；分期态段级 dim（V.deepPhaseDimBit：选中段 0 罩上
// 重画全亮、未选段 1，他省整线恒 1 照旧）。站名/标签联动沿用口径（updateLabels 分期态
// dimmedSet 换传他省集，防 dim 扩展误隐期次匹配标签）；退出高亮恢复 1.0＋常态档白罩；
// 底图切换时策略自动跟随（applyBasemapToMap 先重算 dim，切走无残留）。**浅色类三态行为
// 逐位不变**（isDeepVeilBand 不命中时一切照旧路径）。
// 实装路径对齐：数据 fetch＝net → build/net 依次回退（正式版原样）；省界底图＝仓库静态件
// basemap/provinces-wgs84.json（相对路径）。
// ——以下为原查看器头注（保留供对照）——
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
//（一切调光场合恒半透明）；⑤普通站名门槛 12→11；⑥全局站名开关；
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
// 2026-11-27 区级行政区划界线底图（用户需求「上海境内的区界（16 区）常驻，样式与省界
// 一样（细灰线）但用虚线，只要上海境内」）：与省界层同色同宽（#a8a8a8 / 1px）＋
// line-dasharray [4,3]（虚线；无 zoom 限制，与省界层同为常驻全档）。数据 basemap/
// districts-wgs84.json 由 tools/districts_basemap.py 生成——OSM 区级 relation（admin_level
// 实测＝6）经共边提取净化（区际共边＋区外缘，剔省界重叠与 OSM 假环；崇明以 18 乡镇联合
// 替代假包络；外缘＝三岛岸线等省界大包络不含的线——上海市界 relation 是含三岛水域的
// 大包络，区界外缘与省界并不完全重叠，此为本数据实际形态），来源/口径/许可见脚本头注。
// 与省界层同模式加载（loadDistricts 异步读仓库静态件，失败仅 console.warn 不阻断），
// renderDistrictsFC 过 S.dispCoord（高德态同通道重投影）；层序＝provinces 之上（虚线
// 空隙处若与省界叠合露出下方实线，视觉仍为实线省界）。
// 2026-11-23 遮罩分档（用户裁定「对于carto无字来讲，这个遮罩太厚了。仅carto正常情况改为35，
// 高亮情况下改为30」）：底图白色遮罩按底图态分档——carto 态常态 35%/聚焦 30%（Positron 本就浅，
// 60% 下几乎只剩水系轮廓），OSM／高德态维持 60%/40% 不变（用户点名仅 carto，字面执行）；
// VEIL_OPACITY/VEIL_OPACITY_FOCUS 改为按态查表（veilOpacityFor 取当态档位），syncBasemapVeil
// 与建层初始 paint 同表取值，聚焦进出（applyDimState）与底图切换（applyBasemapToMap）路径
// 自动换档；聚焦态恒比常态薄一档的旧语义不变。
// 2026-11-28 移动端适配第一批（窄屏 <768px＝bottom sheet，桌面零改动）＋一项通用改动：
// ①面板改全宽贴底三档 bottom sheet（隐藏[只露把手 30px]/半屏[默认]/全屏），把手 pointer
// 拖拽（拖拽中禁 transition、松手按 V.nearestSheetSnap 吸附最近档；点击把手＝收一档/展开），
// 桌面抽屉把手/展开条移动端退役、收起语义（S.panelCollapsed）两端互映射（syncViewportMode）；
// ②站名标签移动端整体放大一档（labelScale × V.MOBILE_LABEL_SCALE=1.25，桌面不乘）＋经纬
// 读数尺 SVG 字号 CSS 放大（index.html media 块）；③移动端线路聚焦相机＝bbox 居中＋zoom
// 直接 11（不 fitBounds、不算 padding/让位/站名余量；flyTo 900ms 保留；车站聚焦 zoom13 与
// 其他相机照旧——cameraPadding 移动端改算 bottom 让位）；④viewport meta 已有无需补；
// ⑤通用：线路页标题后加分类标签（主线 layer，.lp-layer-chip）。纯逻辑 V.viewportIsMobile/
// V.sheetSnapHeights/V.nearestSheetSnap 单测覆盖（tools/test_viewer_logic.js）。
// 2026-11-25 分期态他省线纠正（用户裁定）：他省线在任何情况下不得被期次高亮（不进
// 期次高亮集合、不被白罩压暗），也绝不因进入分期态而从图上消失——分期态照常显示，
// 口径＝聚焦态既有「恒调光」。实现：①渲染特征带 province 0/1 数字位（线/站圈/药丸，
// filter 一律显式 ==）；②分期态基础线两层 filter 追加 province=0（applyLineBaseFilters，
// 随 rebuildConnLayers 全删全建还原），他省线身由罩上专用层 lines-displayonly 接管
//（paint 与基础线层同款含 dim case——分期态他省线 dim 恒 1 → 0.5，与聚焦态同口径）；
// ③罩上符号复制层收「期次匹配 ∨ 他省」联合 filter、paint 分期态挂 dim case（本地选
// 中站 dim=0 → 1、他省站 dim=1 → 0.5），聚焦态维持恒 1「聚焦豁免一切」不变；④blend/
// arrow 动态层对他省线不按 segStatus 拆段——整线罩上恒调光；⑤phaseUnitMatches 他省
// 线的站不贡献期次匹配（站圈不亮）；⑥标签：他省纯单元不受分期过滤与调光隐藏
//（visibleLabels 新增 displayOnlyIds 放行，只走 zoom 门槛）；⑦聚焦他省线仍走 focus-copy
// 罩上恒原色重画（既有「聚焦豁免」不回退）。原 phaseHiddenLine「分期态整线不出图」
// 实现废弃（2026-11-23 会错意版本）。
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
    phase: 'none',                // 兼容旧标签/他省判定路径；多选态由 phases 持有
    phases: new Set(['existing', 'approved', 'future']), // 三档分期多选，初始全选＝总览不启用分期
    phaseActive: false,
    focus: null,                  // 聚焦线路 lineId（null＝未聚焦；双击左栏行切换、Esc 退出）
    // 2026-11-27 点击车站：车站页上下文（V.stationFocusOf 产物）。存在≠激活——激活渲染
    //（多线白罩高亮）仅在 S.focus==null 时（车站页↔线路页链中 S.station 保留供返回、
    // 高亮让位给线路聚焦）。S.ui.stationFrom＝进入来源（search/line/list）、
    // stationResumeFocus＝进入前的聚焦线（from='line' 返回时恢复、不跳相机）。
    station: null,
    namesOn: true,                // 全局站名开关（false＝一切站名不显示，优先级最高）
    dimmed: new Set(),            // 调光线集（computeDimmedSet 按 phase/focus 叠加算出）
    dimPending: false,            // 样式未就绪时切分期/聚焦的补应用标记（目标态恒存 S.phase/S.focus）
    labelPool: new Map(),         // 标签元素复用池 key → div
    labelFrame: 0,                // rAF 合帧令牌
    searchIdx: [],                // 搜索条目
    dropIndex: 0,                 // 搜索下拉键盘焦点序
    basemap: 'off',               // 测试阶段底图态：'off'|'osm'|'gaode'|'gaode-plain'|'carto'（后备）|'planblock'|'shanghai_W'（默认无＝零差别；不持久化；UI 初始在 wireUI 里置 'gaode'）
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
    // 2026-11-27 区级行政区划界线底图：同省界模式（loadDistricts 读 basemap/
    // districts-wgs84.json 回填；renderDistrictsFC 过 S.dispCoord）
    districtsFC: null,
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
    // ---------- 新 UI demo 状态（会话内不持久化，刷新回初始界面；与底图/分期同策） ----------
    ui: {
      view: 'splash',             // 'splash' 初始界面 | 'main' 主界面（列表） | 'station' 车站页 | 'line' 线路页（滑动层级见 VIEW_RANK）
      tab: '市区线',               // 主界面当前选项卡（市区线/市域线/预控通道；他省与联络线不进列表）
      searching: false,           // 搜索态：结果占据整个面板主体（顶条与署名行保留）
      sheetSnap: 'half',          // 移动端 bottom sheet 档位 'hidden'|'half'|'full'（2026-11-28；桌面不消费，跨断点与 collapsed 互映射）
      linePageId: null,           // 线路页当前线路（主线 id；setFocus 同源）
      linePageFrom: 'list',       // 线路页进入来源（'list'|'search'|'station'|'line'）——搜索来源返回保留词与结果；车站来源返回回车站页（2026-11-27 逐级返回链）；'line'＝站行换乘项跳转来源，返回回原线路页（2026-11-27 换乘链）
      linePagePrev: null,         // 换乘链栈（from='line' 时有效）：{ id, from, prev }——点换乘项前所在线路页及其来源，逐级返回（见 backFromLinePage）
      stationFrom: 'list',        // 车站页进入来源（'list'|'search'|'line'）
      stationResumeFocus: null,   // 进车站页前的聚焦线（from='line' 返回时恢复，不跳相机）
    },
    phaseCycle: 'all',            // 「显示线路」循环档：all→existing→approved→future→all（映射 S.phases/S.phaseActive）
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
  const NET_BASES = ['net', 'build/net'];   // 正式版数据回退链（发布 docs/ 有 net/；本地预览走 build/net）
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
  // 2026-11-27 点击车站：高亮成员集泛化——车站态（S.station 激活）＝车站各自然线路的
  // 组成员并集（stationFocusOf.memberIds），线路态照旧聚焦组成员。调用方（renderLinesFC
  // 的 veilSkip / memberMatchExpr / renderFocusCopyFC / 标签常显）一律经此取集。
  function veilFocusSkipSet() {
    if (S.station != null && S.focus == null) return new Set(S.station.memberIds || []);
    if (S.focus == null) return null;
    const grp = S.lineGroups.ofLine.get(S.focus);
    return new Set(grp ? grp.members : [S.focus]);
  }
  // 2026-11-25 用户纠正裁定：他省线在分期态**照常显示**——不进期次高亮集合（不亮）、
  // 不被白罩压暗（不暗），只保持与聚焦态同口径的「恒调光」（分期态 dim 位恒 1 →
  // line-opacity 0.5）。原「分期态他省完全不出图」实现（phaseHiddenLine 直接跳特征）
  // 废弃。判定集中在这三个 helper，与分期开关无关：
  function lineOtherProvince(line) { return V.lineLayerRank(line) === 'displayOnly'; }
  // 单元（pin/药丸/标签）的成员线全部为他省线 → 该单元按他省口径处理（罩上恒调光）；
  // 混合单元（本地＋他省成员）按本地规则走——组符号是本地主导。
  function otherProvinceOnlyIds(ids) {
    const valid = (ids || []).map((id) => S.linesMap.get(String(id))).filter(Boolean);
    return valid.length > 0 && valid.every(lineOtherProvince);
  }
  function pinOtherProvinceOnly(pin) {
    const ids = (pin && pin.kind === 'group' && Array.isArray(pin.lineIds) && pin.lineIds.length)
      ? pin.lineIds : (pin && pin.lineId ? [pin.lineId] : []);
    return otherProvinceOnlyIds(ids);
  }
  // 分期态他省线 id 集（标签放行与渲染判定用；非分期态无需——返回空数组）
  function displayOnlyLineIds() {
    const ids = [];
    for (const line of S.linesMap.values()) if (lineOtherProvince(line)) ids.push(line.lineId);
    return ids;
  }
  function renderLinesFC() {
    S.dispBbox = new Map();
    const dc = S.dispCoord;
    const veilSkip = veilFocusSkipSet();
    // 深图态分期段级调光（2026-11-27 裁定「未选期 0.5、选中段罩上重画全亮」的落点）：
    // feature 是段级的，dim 位按 V.deepPhaseDimBit 逐段覆写（选中段 0——罩上重画层同宽
    // 同色覆盖底线；未选段 1 → 0.5；他省线恒 1 照旧）。浅色态/非分期恒走线级 dim（逐位
    // 不变）。线级全集由 recomputeDimmed ③ 兜底。
    const deepSegDim = isDeepVeilBand() && S.phaseActive;
    const features = [];
    for (const line of S.linesMap.values()) {
      let bb = null;
      const lineDim = S.dimmed.has(line.lineId) ? 1 : 0;
      const province = lineOtherProvince(line) ? 1 : 0;   // 0/1 数字位（filter 显式 ==，勿用 '!'）
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
          properties: { lineId: line.lineId, name: line.name, color: line.color, segStatus: seg.segStatus, segIndex: seg.segIndex,
            dim: deepSegDim ? V.deepPhaseDimBit(line, seg.segStatus, S.phases) : lineDim,
            dash: V.lineDashed(line), province,
            // 共线段偏移（2026-11-27 方案 A）：normalizeLines 透传（普通段 0）
            sharedOffset: Number.isFinite(seg.sharedOffset) ? seg.sharedOffset : 0 },
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
  function phaseStopsForUnit(unit) {
    if (!unit) return [];
    const key = String(unit.key || '');
    const sid = unit.sid || (!key.startsWith('g:') ? key : '');
    // 出闸组的单站 pin（kind=stop、普通 key）只取自身；组符号和标签才展开组范围。
    if (unit.kind !== 'group' && sid) return S.stops.filter((stop) => stop.sid === sid);
    const groupId = unit.groupId || (key.startsWith('g:') ? key.slice(2) : '');
    // 出闸组标签只代表直属站；不能把其子组叶站的状态传播到外层标签。
    if (groupId && S.groupTree) {
      return unit.groupType === 'out-of-station'
        ? S.groupTree.directStops(groupId) : S.groupTree.leafStops(groupId);
    }
    return [];
  }
  function phaseUnitMatches(unit) {
    const stops = phaseStopsForUnit(unit);
    return stops.some((stop) => {
      const line = S.linesMap.get(stop.lineId);
      if (lineOtherProvince(line)) return false;   // 他省线的站不进期次高亮集合（2026-11-25 裁定）
      const status = V.stopPhaseOf(line, stop, S.stops);
      return status != null && S.phases.has(status);
    });
  }
  function pinDimmed(pin) {
    // 分期仅靠遮罩区分选中/未选段；基底站圈与药丸保持正常不透明度——唯他省单元例外：
    // 恒调光口径与聚焦态一致（2026-11-25 纠正裁定：分期态他省照常显示、dim 位恒 1）。
    if (S.phaseActive) return pinOtherProvinceOnly(pin) ? 1 : 0;
    if (S.focus == null && S.phase !== 'none' && pin.stopPhaseMembers) {
      return V.stopUnitMatchesPhase(pin.stopPhaseMembers, S.phase, S.dimmed) ? 0 : 1;
    }
    if (S.focus == null && S.phase !== 'none' && pin.stopStatus) return pin.stopStatus === S.phase ? 0 : 1;
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
        properties: { key: pin.key, name: pin.name, lineId: pin.lineId || '', big: pin.big ? 1 : 0, dark, stroke, dim: pinDimmed(pin), phaseMatch: S.phaseActive && phaseUnitMatches(pin) ? 1 : 0, province: pinOtherProvinceOnly(pin) ? 1 : 0, members: pinMembers(pin) },
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
          stopPhaseMembers: pill.pin && pill.pin.stopPhaseMembers || null,
          // 药丸成员线集（2026-11-22 真机反馈轮）：聚焦参与判定用（罩下 filter 追加/罩上
          // 复制层，见 memberMatchExpr）——与 dim 位同源的成员信息，任一成员在聚焦组即豁免
          members: (pill.lineIds || []).map(String),
          // 药丸调光规则：全成员线被调光才半透明（任一成员未调光则正常——2026-11-22 用户裁定；
          // 分期态他省纯成员药丸例外恒 1，2026-11-25 纠正裁定）
          dim: S.phaseActive && pill.pin ? (pinDimmed(pill.pin) ? 1 : 0)
            : ((pill.lineIds || []).length && pill.lineIds.every((id) => S.dimmed.has(id)) ? 1 : 0),
          phaseMatch: S.phaseActive && pill.pin && phaseUnitMatches(pill.pin) ? 1 : 0,
          province: otherProvinceOnlyIds(pill.lineIds) ? 1 : 0,
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
  // 共线段双平行线（2026-11-27 方案 A）：flatten 产出的段级可选属性 sharedOffset
  //（像素，仅共线范围内的小段携带，符号由 flatten 按「peer/本线 id 字典序＋两侧几何
  // 方向」确定性给出）。一切画线身的层统一挂数据驱动 line-offset＝['coalesce',
  // ['get','sharedOffset'], 0]——普通段无该属性 → coalesce 回 0，渲染行为与现状逐位
  // 一致（line-offset 0＝不偏移）。⚠ MapLibre 两条既有教训均不触：line-offset 是
  // paint 属性（不是 line-cap/line-join 的 layout 坑）；恒定像素、不与 zoom 插值复合
  //（数据驱动×zoom 复合真机不连续求值的坑）。数据驱动 paint 表达式对 line-offset
  // 合法（feature 属性读取）。
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
        'line-offset': ['coalesce', ['get', 'sharedOffset'], 0],
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
        'line-offset': ['coalesce', ['get', 'sharedOffset'], 0],   // 共线段偏移（见 lineLayerDef 注）
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
  // 站圈/药丸层交互（2026-11-27 改版）：点车站＝完整车站行为（flyTo＋多线高亮＋面板
  // 车站页）——入口收在全局 onMapClick（站圈优先于线身，见 stationPinOf）；本函数保留
  // 空实现占位（rebuildConnLayers 的旧调用点防御直通，per-layer 委托已全部退役）。
  function bindPinLayerInteraction(id) { /* 全局 click 查询式接管，见 onMapClick */ }

  // ---------- 地图单击线路＝聚焦高亮（2026-11-27 用户裁定，取代 2026-11-26 轻提示） ----------
  // 单击本地自然线身＝与列表点击完全同款：setFocus（白罩＋罩上重画＋相机 fitBounds 带
  // 面板让位 padding）＋面板进线路页（来源恒 'list'——保守裁定：地图点进不视为搜索来源，
  // 返回回线路列表）。
  // 实现＝全局 map.on('click')＋e.point 处 queryRenderedFeatures 查询式：不带 layers 参数
  // 查全部渲染层、取回后按 feature.layer.id 过滤线身层（VIEWER_CORE.isLineHitLayerId——
  // 不依赖层存在性、不受 rebuildConnLayers 全删全建影响；7869eb1 的 per-layer 委托版在
  // 真机单击无反应，委托注册/解绑与动态层生命周期交错无稳定复现，弃委托改查询式）。
  // 命中多条时取 queryRenderedFeatures 返回序的第一个线身层特征＝渲染最上层（用户视觉
  // 上点到的那条线；同层多特征取第一个）。
  // 无操作裁定：分期态（「显示线路」≠全部）单击一律无效（用户明令）；联络线（技术线路
  // 不可聚焦）与他省线（纯背景）无操作——判定收在 VIEWER_CORE.lineClickAction（单测
  // 覆盖）。分组口径与列表一致：支线命中归一到主线（mainOf）。
  // 双击边缘行为：双击线身＝两次单击＋原生缩放——第一击已聚焦（第二击 setFocus 幂等
  // 无感），随后原生 zoom 抢相机；不做防抖（单击即时响应优先，对齐列表点击手感）。
  // cursor：非分期态悬停本地线身变 pointer（提示可点）、移开/分期态/联络线/他省线恢复
  // 默认——mousemove＋rAF 合帧查询（每帧至多一次、不逐像素查询），pointer 态变化才写
  // canvas.style.cursor。
  // 防泄漏承载说明：7869eb1 随轻提示顺带修的两个独立真 bug——「removeLayer 不解绑
  // delegated listener 致监听累积」与「隐藏页 setTimeout 被抑制」——轻提示删除后以更强
  // 的结构等效保留：不再向 map 注册任何 per-layer 委托监听（监听累积无从发生——全局
  // click/mousemove/mouseout 各恰一次，不随层重建增减）；不引入 setTimeout 链（hover
  // 查询走 rAF 合帧，同 scheduleLabels 模式，隐藏页 rAF 停摆行为与页面一致）。
  function renderedFeaturesAt(point) {
    if (!S.map || !point) return null;
    try {
      return S.map.queryRenderedFeatures(point);   // 全层查询后按层过滤（见上注）
    } catch (e) { return null; }
  }
  function clickableMainOf(feats) {
    for (const f of Array.isArray(feats) ? feats : []) {
      const layerId = f && f.layer ? f.layer.id : '';
      if (!V.isLineHitLayerId(layerId)) continue;
      const line = S.linesMap.get(String((f.properties || {}).lineId || ''));
      if (!line || V.lineClickAction(line) !== 'focus') continue;
      return S.lineGroups.mainOf.get(line.lineId) || line.lineId;
    }
    return null;
  }
  function clickableMainAt(point) { return clickableMainOf(renderedFeaturesAt(point)); }
  // ---------- 地图单击车站（2026-11-27 用户裁定：点车站＝flyTo＋多线高亮＋面板车站页） ----------
  // 站圈/药丸符号命中（V.isStopHitLayerId）：站圈优先于线身（用户裁定「点击点同时命中
  // 站圈与线身时站圈优先」——显式先扫站圈层再扫线身层）。可点判定＝stationLinesOf 非空
  //（纯联络线站无自然线路→无操作；他省站可点——2026-11-27 修正裁定他省线参与）。
  // 分期态点车站同样有效（点击后解除分期进车站高亮——与列表点线路解除分期语义一致，
  // 保守口径报告备查）；splash 态不触发（初始页流程完整性，面板无来源视图可回）。
  function stationPinOf(feats) {
    for (const f of Array.isArray(feats) ? feats : []) {
      const layerId = f && f.layer ? f.layer.id : '';
      if (!V.isStopHitLayerId(layerId)) continue;
      const key = String((f.properties || {}).key || '');
      const pin = S.pinByKey.get(key);
      if (!pin) continue;
      if (!V.stationLinesOf(pin, S.linesMap, S.lineGroups, S.groupTree).length) continue;
      return pin;
    }
    return null;
  }
  function onMapClick(e) {
    const feats = renderedFeaturesAt(e && e.point);
    if (S.ui.view !== 'splash') {
      const pin = stationPinOf(feats);
      if (pin) { enterStationByPin(pin); return; }   // 站圈优先：命中即进车站页
    }
    if (S.phaseActive) return;               // 分期态：点线路一律无效（用户明令；点车站已在前面上车）
    const main = clickableMainOf(feats);
    if (main == null) return;
    setFocus(main);                          // 与列表点击同款（内含 fitBounds 相机跳转）
    openLinePage(main, 'list');              // 来源＝列表：返回回线路列表，不视为搜索来源
  }
  let hoverFrame = 0, hoverPoint = null, hoverPointerOn = false;
  function scheduleHover() {
    if (hoverFrame) return;
    hoverFrame = G.requestAnimationFrame(() => { hoverFrame = 0; updateHoverCursor(); });
  }
  function updateHoverCursor() {
    const map = S.map;
    if (!map) return;
    let on = false;
    if (hoverPoint != null && S.ui.view !== 'splash') {
      const feats = renderedFeaturesAt(hoverPoint);
      if (feats) {
        // 站圈可点即 pointer（分期态车站仍可点）；线身沿用非分期态判定
        if (stationPinOf(feats)) on = true;
        else on = !S.phaseActive && clickableMainOf(feats) != null;
      }
    }
    if (on === hoverPointerOn) return;   // 态变化才写 cursor（不逐帧 setStyle）
    hoverPointerOn = on;
    map.getCanvas().style.cursor = on ? 'pointer' : '';
  }
  function wireLineClick() {
    S.map.on('click', onMapClick);
    S.map.on('mousemove', (e) => {
      hoverPoint = e && Number.isFinite(e.point.x) ? [e.point.x, e.point.y] : null;
      scheduleHover();
    });
    S.map.on('mouseout', () => { hoverPoint = null; scheduleHover(); });   // 离开画布恢复默认
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
          // 区级行政区划界线底图 source（2026-11-27）：同省界模式（loadDistricts 异步读
          // basemap/districts-wgs84.json 后 setData；fetch 先于样式就绪时由 map 'load'
          // 处理器补应用，见 applyDistrictsToMap）。
          districts: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
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
          // 区级行政区划界线层（2026-11-27）：省界层之上（虚线空隙叠合省界处露实线，视觉
          // 仍为实线省界）、线路之下。同色同宽、仅加 line-dasharray [4,3]（4px 实/3px 空，
          // 1px 线宽下比预控通道 [2,2] 略疏——过密在 1px 下退化成点线）；色宽纹全常量，
          // 不搞数据驱动×zoom 复合（血泪教训同省界层注）。无 minzoom/maxzoom＝与省界层
          // 同为常驻全档。
          {
            id: 'districts', type: 'line', source: 'districts',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: { 'line-color': '#a8a8a8', 'line-width': 1, 'line-dasharray': [4, 3] },
          },
          ...LINE_LAYER_IDS.map(lineLayerDef),
          corridorLineLayerDef('lines-dash', 'lines'),   // 预控通道虚线（同 source 紧挨实线层——药丸之下罩下区，2026-11-23）
          ...PILL_LAYER_DEFS,          // 药丸垫在站圈之下（罩下区：聚焦时与站圈一起被白罩罩淡）
          ...STOP_LAYER_DEFS.map(stopLayerDef),   // 站圈按 big/dark 拆三层（常量档位；罩下区，层序见 rebuildConnLayers 注）
          // 白罩常驻层（demo 高亮渐变改造）：原实现随 rebuildConnLayers 全删全建＝硬切；改为
          // 常驻、fill-opacity 0↔0.7 走 paint transition 渐入渐出（syncFocusVeil 统一切换）。
          // 层位＝罩下静态五层之后：blend/arrow 的 addLow 插 pills 前（本层之下）、动态罩上层
          // （focus-copy 等 addTop）天然在本层之上——与旧层序等价。分期态与聚焦态共用此层。
          {
            id: 'focus-veil', type: 'fill', source: 'focus-veil',
            paint: {
              'fill-color': '#ffffff',
              'fill-opacity': 0,
              'fill-opacity-transition': { duration: 420 },
            },
          },
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
    // ——2026-11-27 用户裁定改版：单击线身＝聚焦高亮回启（查询式实现，见 wireLineClick
    // 段注；双击与原生缩放的冲突见该段「双击边缘行为」说明）。列表入口随新 UI 已是单击
    //（buildLineList），toggleFocus 仍供内部路径复用。
    //（站圈/药丸交互照旧——demo 新 UI 裁定点车站不触发任何面板，bindPinLayerInteraction
    // 为空实现占位；聚焦时的罩上复制层（*-focus）在 rebuildConnLayers 建层处同绑。）
    // 站圈三层（big/dark 拆层，filter 互斥）＋药丸两层（成员圈已隐去，药丸本体承接点选/
    // hover，两层同源内外均可命中）共绑同一组交互——行为与单层时代完全一致；聚焦时的
    // 罩上复制层（*-focus）在 rebuildConnLayers 建层处同绑（聚焦成员 feature 只在其上渲染）
    for (const id of STOP_LAYER_DEFS.map((d) => d.id).concat(['pills-inner', 'pills-outer'])) {
      bindPinLayerInteraction(id);
    }
    // 单击线路＝聚焦（2026-11-27 改版）：全局 click＋hover cursor（各恰一次注册，不随层重建增减）
    wireLineClick();
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
      // 区界底图同理（applyDistrictsToMap 幂等，S.districtsFC 未回填时是空 FC 重设）
      applyDistrictsToMap();
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
    // 2026-11-27 相机让位 padding 推广：初始全图 fit 同样扣左侧面板（面板在 splash 态也
    // 常驻显示），全图西端不再被面板压住
    //（2026-11-27 动效例外：首次加载的初始定位保持即时 duration 0——首屏不闪；仅在
    //  map 'load' 时调用一次，交互路径不走这里）
    if (bb) S.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: cameraPadding(), duration: 0, maxZoom: 12 });
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

  // ---------- 区级行政区划界线底图（常驻虚线灰线层，2026-11-27 用户需求） ----------
  // 与省界底图完全同模式（数据/加载/显示变换通道三同）：仓库静态件 basemap/districts-wgs84.json
  //（WGS84）——tools/districts_basemap.py 生成（OSM 区级 relation 共边提取净化＋60m DP 简化；
  // 崇明以 18 乡镇联合替代假包络、异地假环按上海包络 bbox 滤除、与省界重叠段已剔——上海市界
  // relation 是含三岛水域的大包络，区界「外缘」（三岛岸线/宝山北缘水界/海岸线）与省界并不
  // 重叠故保留；来源与许可口径见该脚本头注）。层序＝provinces 之上、线路之下；同色同宽
  // ＋ dasharray [4,3]；纯地理参照，不参与分期/聚焦/调光。坐标逐点过 S.dispCoord——高德
  // 底图态下与线路数据同一显示变换通道；OSM／CARTO／无底图态恒等即 WGS84 直出。
  function renderDistrictsFC() {
    const fc = S.districtsFC;
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
  // setData 补应用：与省界同双路（fetch 回填＋底图切换重投影），样式未就绪时直接返回——
  // map 'load' 处理器会再调一次兜底（同 applyProvincesToMap 的补应用模式）。
  function applyDistrictsToMap() {
    if (!S.map || !(S.styleReady || S.map.isStyleLoaded())) return;
    if (S.map.getSource('districts')) S.map.getSource('districts').setData(renderDistrictsFC());
  }
  function loadDistricts() {
    fetchJSON('basemap/districts-wgs84.json').then((fc) => {
      if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
        throw new Error('结构不符（须为 FeatureCollection）');
      }
      S.districtsFC = fc;
      applyDistrictsToMap();
    }).catch((e) => {
      // 装饰性底图缺了不阻断启动（线网本体照常）；显式告警（MapLibre 运行时错误不上控制台）
      console.warn('提示：区界底图加载失败（不影响线网显示）：' + (e && e.message ? e.message : e));
    });
  }

  // ---------- 测试阶段底图（2026-11-27 扩容：清单 5 态＋carto 代码后备） ----------
  // ⚠ 测试阶段功能（2026-11-22 用户指示的阶段性豁免）：早前用户曾裁定「查看器不放底图、
  // 零外部资源」，本段为测试期豁免，正式上线可能保留也可能移除（2026-11-23 用户裁定：打磨
  // 最后阶段移除白板/OSM/高德、只留 CARTO 并删切换按钮）——移除时删本段＋顶栏按钮＋
  // 图例卡署名行＋S 里三字段即可。默认 'off' 与无底图现状完全一致（不 addSource、零网络请求）；
  // 状态会话内不持久化（每次加载默认无底图）。
  // 对齐设计：OSM／CARTO（Positron 无字版）／用地（planblock）／卫星（shanghai_W）瓦片均
  // WGS84（3857 标准网格），与数据同基准直接叠（S.dispCoord 恒等直通）；高德瓦片 GCJ02——
  // 不动瓦片、只把显示用坐标过 S.dispCoord（WGS84→GCJ02），权威数据与 GeoJSON/KML 导出
  // 一律 WGS84 一个字节不动（编辑器是「逐瓦片常量偏移」动瓦片侧，查看器数据侧变换，
  // 各自单侧适配、殊途同归）。
  // 2026-11-27 扩容改版（用户终局裁定）：底图按钮循环退役——单点展开全部清单（终态序
  // 高德 → 无字高德 → 用地 → 卫星 → OSM），清单 UI 见 index.html #basemapMenu；carto 源
  // 保留代码后备不进清单（天地图 img_w+cia_w 官方渠道备选未接，需 tk key——研究报告 1 节）。
  // 无字高德（研究报告 零散/底图研究-无字高德百度-261126.md）：wprd0{1-4}＋scl=2&style=7
  // ＝完全无文字/路名/POI 的浅米白底（512×512 retina，tileSize 256 摆放即高清）；
  // 只有 wprd 域名支持 scl=2（webrd 返回错误页）；GCJ02 偏移与有字高德同源。
  // 用地／卫星（研究报告 零散/底图研究-天地图卫星与用地图-261127.md 2.2/2.4 节，实测结论）：
  // map4.shanghai-map.net ArcGIS REST 根级服务、/tile/{z}/{y}/{x}、3857 标准 XYZ、256px、
  // CORS 反射任意 Origin、无 token 无 Referer 校验；坐标偏移实测亚像素级＝WGS84 恒等直用
  //（planblock z12 陆家嘴与 OSM 程序化配准、黄浦江中带中位差 -0.5px）。内部端点直连的
  // 性质与高德 appmaptile 同类（无 SLA）；shanghai_W 无 key 无配额、1–2 米级分辨率。
  const BASEMAP_LABEL_ZH = { off: '无', osm: 'OSM', gaode: '高德', 'gaode-plain': '高德·无字',
    carto: 'CARTO无字', planblock: '用地', shanghai_W: '卫星' };
  const BASEMAP_ATTR_ZH = {
    osm: '底图 © OpenStreetMap 贡献者',
    gaode: '底图 © 高德',
    'gaode-plain': '底图 © 高德',   // 无字与有字同属高德服务，同一署名
    carto: '底图 © OpenStreetMap contributors © CARTO',   // CARTO 条款硬性署名（文字即可）
    planblock: '用地数据 © 上海市规划和自然资源局',   // 惯例署名（性质同省界：无硬性条款，礼貌标注）
    shanghai_W: '影像 © 上海市测绘院 · 低层影像 © Esri',   // shanghai_W＝上海测绘院正射影像；
    // 低层垫底（z<12）＝Esri World Imagery，其条款要求署名（同 CARTO 口径）——2026-11-27
    // 双层结构追加，署名行全 zoom 恒定不随层切换
  };
  // 底图白色遮罩不透明度——按「底图明暗类」归档取值（2026-11-27 扩容重构，研究报告
  // 零散/底图研究-天地图卫星与用地图-261127.md 3.3 节建议；旧的两张平铺查表
  // VEIL_OPACITY/VEIL_OPACITY_FOCUS 已删）：
  //   light 浅色矢量图（高德／无字高德／OSM）……常态 60%/聚焦 40%（2026-11-23 用户定档，
  //     历史：11-22 定值 40%、11-23 常态提亮 60% 唯聚焦保持 40%）
  //   pale  中浅色矢量图（CARTO Positron）……常态 35%/聚焦 30%（2026-11-23 用户裁定——
  //     Positron 本就浅，60% 下几乎只剩水系轮廓）
  //   dark  深图类·用地（planblock）……常态 32%/聚焦 27%＝研究建议区间（常态 30–35%、
  //     聚焦 25–30%）中值，待目验微调（用户 2026-11-27 终局裁定）
  //   darkSat 深图类·卫星（shanghai_W）……常态 32%/聚焦 22%＝研究建议区间（30–35%、
  //     20–25%）中值，影像纹理比用地更重、聚焦档再放薄，待目验微调。2026-11-27 双层
  //     结构后低 zoom（z<12）垫底 Esri 影像同为深色影像——档位全 zoom 段沿用 darkSat
  //     不分层（用户裁定按深图类即可）
  // 归类依据：浅色矢量＝白/米白底细线网，中浅＝Positron 特浅灰白，深图＝彩色地块饱和
  // （60% 白罩会洗没色彩）或深色影像纹理。聚焦态恒比常态薄——聚焦高亮已有 70% 白罩
  //（FOCUS_VEIL_OPACITY），底图遮罩再叠厚两层叠白会看不清。
  // 聚焦态判定＝现有 focusOrStation()（聚焦/车站高亮任一）|| S.phaseActive（分期），
  // 不新造状态；换档路径 syncBasemapVeil（applyDimState＝汇聚点＋applyBasemapToMap＝
  // 底图切换补一档）。
  // 2026-11-27 深图态高亮策略（用户裁定）：dark/darkSat 两档的 focus 数值**停用**（保留
  // 定义、深图态不取）——深图类高亮时白罩不动（底图遮罩恒常态档），对比改用其他线路
  // 不透明度（dim 通路扩展，见 recomputeDimmed 注）。
  const VEIL_BANDS = {
    light: { normal: 0.6, focus: 0.4 },
    pale: { normal: 0.35, focus: 0.30 },
    dark: { normal: 0.32, focus: 0.27 },
    darkSat: { normal: 0.32, focus: 0.22 },
  };
  const BASEMAP_VEIL_BAND = {
    gaode: 'light', 'gaode-plain': 'light', osm: 'light',
    carto: 'pale',
    planblock: 'dark', shanghai_W: 'darkSat',
  };
  // 深图类底图判定（dark/darkSat）：高亮策略按此分流——深图＝降透明度法、浅色＝白罩法
  //（2026-11-27 用户裁定；off／未知态兜底 light 档＝白罩法，纯防御）。改动点集中引用此
  // 一判：veilOpacityFor/syncFocusVeil/recomputeDimmed/renderLinesFC。
  function isDeepVeilBand() {
    const band = BASEMAP_VEIL_BAND[S.basemap];
    return band === 'dark' || band === 'darkSat';
  }
  // 取当态档位；off／未知态兜底取 light 档（veil 仅底图非 off 时可见，值不生效，纯防御）。
  // 深图态短路：focused 不生效、恒常态档（高亮时白罩不动，2026-11-27 裁定）。
  function veilOpacityFor(focused) {
    const band = VEIL_BANDS[BASEMAP_VEIL_BAND[S.basemap] || 'light'];
    if (isDeepVeilBand()) return band.normal;
    return focused ? band.focus : band.normal;
  }
  // 遮罩层未建（底图从未开过）防御跳过——样式未就绪期由 dimPending/basemapPending 补应用
  // 机制兜底（load 后两路径都会重进 applyDimState/applyBasemapToMap）。
  // 2026-11-27：聚焦/车站高亮任一激活＝调光场合激活位（白罩显示、底图遮罩换薄档、
  // computeDimmedSet 他省恒调光）——集中此一判，勿散落各处
  function focusOrStation() { return S.focus != null || S.station != null; }
  function syncBasemapVeil() {
    if (!S.map || !S.map.getLayer('basemap-veil')) return;
    S.map.setPaintProperty('basemap-veil', 'fill-opacity', veilOpacityFor(focusOrStation() || S.phaseActive));
  }
  // demo 新 UI：署名移进左侧面板最底部一行（#attrRow）＋收起态窄条竖排小字（#panelTabAttr）；
  // 底图按钮文案（当前态短名）同步。carto 文案保留在 BASEMAP_ATTR_ZH 备用。
  // 2026-11-27 改版：循环退役——按钮单点展开 #basemapMenu 清单（5 态短名＋色块、当前态
  // 高亮 .active），此处顺带同步清单高亮。
  function syncBasemapUI() {
    const b = $('btnCycleBasemap');
    if (b) b.textContent = BASEMAP_LABEL_ZH[S.basemap] || S.basemap;
    const text = BASEMAP_ATTR_ZH[S.basemap] || '';
    const attr = $('attrRow');
    if (attr) attr.textContent = text;
    const attrTab = $('panelTabAttr');
    if (attrTab) attrTab.textContent = text;
    const menu = $('basemapMenu');
    if (menu) menu.querySelectorAll('button[data-basemap]').forEach((btn) =>
      btn.classList.toggle('active', btn.dataset.basemap === S.basemap));
  }
  // 底图清单开合（2026-11-27）：open 态即 DOM class（会话内不持久化）；抽屉收起
  //（setLinePanelCollapsed）与离开主界面（showView 非 main）时收起——按钮不可见时
  // 清单状态不残留。函数声明提升，两处前置调用安全。
  function basemapMenuOpen() { const m = $('basemapMenu'); return !!(m && m.classList.contains('open')); }
  function openBasemapMenu() { const m = $('basemapMenu'); if (m) m.classList.add('open'); }
  function closeBasemapMenu() { const m = $('basemapMenu'); if (m) m.classList.remove('open'); }
  // 惰性建层：首次开底图才 addSource/addLayer（默认路径零请求）；raster＋白色遮罩插到首条
  // 线路图层之下——数据压瓦片、bg 背景层被瓦片盖住（无妨，瓦片即底色）。切回「无」只藏不删
  //（setLayoutProperty visibility none，source 保留——再开免重建）。
  // 瓦片 URL 与编辑器 src/editor.js 同源：OSM 同址；高德四子域 webrd01~04＋style=8——编辑器
  // 按 (tx+ty)%4 取子域，MapLibre 无子域模板语法，tiles 列 4 个完整 URL 由其内部轮询，等价。
  // CARTO（Positron 无字版，仅查看器有）单条官方 raster URL；key＝用户申请的免费 key，浏览器端
  // 公开属官方接受的用法，建议用户在 CARTO dashboard 配 referer 限制防盗用。
  // 2026-11-22 三批：瓦片 100% 不透明（旧 0.45 透明作废），提亮改走白色遮罩 fill 层——
  // 全世界矩形（Mercator ±85.0511，任何平移不出界），插在瓦片之上、线路之下，只洗底图
  // 不碰线网站名；不透明度＝按底图明暗类归档查表（见 VEIL_BANDS 注：浅色矢量 60/40、
  // carto 35/30、用地 32/27、卫星 32/22；2026-11-23 分档、2026-11-27 归档重构）。
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
    // 无字高德（demo 2026-11-26 追加）：wprd 子域＋scl=2&style=7（仅 wprd 支持 scl=2）；
    // 512×512 瓦片按 tileSize 256 摆放＝retina 高清（研究报告实测 CORS *、z3–20 可用）
    map.addSource('basemap-gaode-plain', {
      type: 'raster', tileSize: 256,
      tiles: [1, 2, 3, 4].map((n) =>
        'https://wprd0' + n + '.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=2&style=7&x={x}&y={y}&z={z}'),
    });
    map.addSource('basemap-carto', {
      type: 'raster', tileSize: 256,
      tiles: ['https://basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}.png?key=cb1_5e93_1_df67d9c33ed32773609298af'],
    });
    // 用地（planblock，2026-11-27 扩容）：上海规划用地图——不透明白底彩色地块、无文字注记。
    // 层级：LOD 表声称 0–23 但实际缓存 z10–18（z9/19/20 实测 404）——minzoom 10 免掉
    // 总览档的无谓 404 请求（z<10 用地层空白＝白底＋线网，用户终局裁定接受独立态）；
    // maxzoom 18＝更深处 overzoom 复用 18 级瓦片（MapLibre raster 语义）。市域外瓦片 404
    // 静默空白不阻断。坐标 WGS84 恒等（实测亚像素配准，研究报告 2.2 节）。
    map.addSource('basemap-planblock', {
      type: 'raster', tileSize: 256, minzoom: 10, maxzoom: 18,
      tiles: ['https://map4.shanghai-map.net/arcgis/rest/services/planblock/MapServer/tile/{z}/{y}/{x}'],
    });
    // 卫星（shanghai_W，2026-11-27 扩容）：上海正射航空影像（上海测绘院）——无文字、
    // 无 key 无配额、CORS 反射（研究报告 2.4 节）；maxzoom 20 同上 overzoom 语义。
    // ⚠ 实际缓存 z12 起（z11 及以下 404，LOD 表声称 z0–20 表实不符——2026-11-27 主窗口
    // 实测确诊「卫星态拉远空白」），故本态＝双层结构（2026-11-27 用户裁定修法）：
    //   垫底层 basemap-shanghai_W-underlay＝Esri World Imagery（下方新 source），
    //     layer maxzoom 12——z<12 渲染、z≥12 不渲染不请求；
    //   卫星层 basemap-shanghai_W＝layer minzoom 12——z≥12 才渲染、z<12 不再发 404 请求。
    // 交界 z=12 恰好卫星接管、垫底退场，无重叠无空档。天地图 img_w+cia_w（官方 key
    // 渠道）为后备未接。
    map.addSource('basemap-shanghai_W', {
      type: 'raster', tileSize: 256, maxzoom: 20,
      tiles: ['https://map4.shanghai-map.net/arcgis/rest/services/shanghai_W/MapServer/tile/{z}/{y}/{x}'],
    });
    // 卫星垫底（Esri World Imagery，2026-11-27 用户裁定）：卫星态低 zoom（z<12）的底图。
    // 选它不选无字高德的关键＝3857 标准 XYZ、WGS84 恒等——与 shanghai_W 同坐标系，
    // z12 交界底图零位置跳变（高德是 GCJ02 会跳 ~500m）；主窗口实测 z3/6/9/11 上海区域
    // 全 200、CORS *。256px 标准 LOD；服务层级覆盖远超 z12，无需 source 级 zoom 参数
    //（渲染边界全在 layer 级，见上方双层结构注）。署名＝卫星态文案追加「低层影像
    // © Esri」（Esri 服务条款要求署名，口径同 CARTO 硬性署名先例）。
    map.addSource('basemap-esri-imagery', {
      type: 'raster', tileSize: 256,
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
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
    map.addLayer({ id: 'basemap-gaode-plain', type: 'raster', source: 'basemap-gaode-plain',
      layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } }, before);
    map.addLayer({ id: 'basemap-carto', type: 'raster', source: 'basemap-carto',
      layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } }, before);
    map.addLayer({ id: 'basemap-planblock', type: 'raster', source: 'basemap-planblock',
      layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } }, before);
    // 卫星态双层（见上方 source 注）：垫底层 maxzoom 12（z≥12 不渲染不请求）＋卫星层
    // minzoom 12（z<12 不渲染不发请求，低 zoom 404 空白的根治）。两 layer 均只在
    // shanghai_W 态置 visible（applyBasemapToMap），zoom 分工交给 layer 级 min/maxzoom。
    map.addLayer({ id: 'basemap-shanghai_W-underlay', type: 'raster', source: 'basemap-esri-imagery',
      maxzoom: 12, layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } }, before);
    map.addLayer({ id: 'basemap-shanghai_W', type: 'raster', source: 'basemap-shanghai_W',
      minzoom: 12, layout: { visibility: 'none' }, paint: { 'raster-opacity': 1 } }, before);
    map.addLayer({ id: 'basemap-veil', type: 'fill', source: 'basemap-veil',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': '#ffffff', 'fill-opacity': veilOpacityFor(false),
        // demo 高亮渐变：底图白遮罩常态⇄聚焦档切换（60⇄40 / 35⇄30）走 transition 渐变
        'fill-opacity-transition': { duration: 420 },
      } }, before);
  }
  // 应用到地图：层可见性＋显示坐标变换＋四个 source 全量 setData 重渲染＋标签重排
  //（复用既有 render 函数，mode 变了自然产出变换后坐标）。箭头 icon-rotate 角度是 WGS84
  // 下算的——GCJ 常量级偏移（百米级）对方向角影响可忽略，不重算；fitAll/选中定位用的
  // dispBbox 已是显示坐标（与渲染同帧），不特殊处理。
  function applyBasemapToMap() {
    if (S.basemap !== 'off') ensureBasemapLayers();
    recomputeDimmed();   // 2026-11-27 深图态高亮策略：底图切换时 dim 集随明暗类重算（深图⇄浅色策略跟随、切走无残留——下方重设 source 读 S.dimmed）
    syncBasemapVeil();   // 遮罩档位随聚焦态与底图态（建层先落当态常态档，聚焦中开底图即刻换聚焦档；深图态恒常态档）
    const vis = (layerId, on) => {
      if (S.map.getLayer(layerId)) S.map.setLayoutProperty(layerId, 'visibility', on ? 'visible' : 'none');
    };
    vis('basemap-osm', S.basemap === 'osm');
    vis('basemap-gaode', S.basemap === 'gaode');
    vis('basemap-gaode-plain', S.basemap === 'gaode-plain');
    vis('basemap-carto', S.basemap === 'carto');
    vis('basemap-planblock', S.basemap === 'planblock');
    // 卫星态两 layer 同置 visible，zoom 分工在 layer 级 min/maxzoom（z12 分界，见
    // ensureBasemapLayers 双层结构注）；切走卫星态两 layer 一并隐藏、无残留
    vis('basemap-shanghai_W-underlay', S.basemap === 'shanghai_W');
    vis('basemap-shanghai_W', S.basemap === 'shanghai_W');
    // 遮罩随底图开关（不透明度＝veilOpacityFor 按底图明暗类归档取值：浅色矢量 60/40、
    // carto 35/30、用地 32/27、卫星 32/22——见 VEIL_BANDS 注）
    vis('basemap-veil', S.basemap !== 'off');
    // 显示坐标变换：gaode 与 gaode-plain 同走 GCJ02（同一偏移体系）；osm/carto/用地/卫星
    // 瓦片均 WGS84 恒等直通（carto 显式传 'carto'，makeDispCoord 恒等分支，与 none 同效）
    S.dispCoord = V.makeDispCoord((S.basemap === 'gaode' || S.basemap === 'gaode-plain') ? 'gaode'
      : (S.basemap === 'carto' ? 'carto' : 'none'));
    if (S.map.getSource('lines')) S.map.getSource('lines').setData(renderLinesFC());
    if (S.map.getSource('stops')) S.map.getSource('stops').setData(renderStopsFC());
    if (S.map.getSource('pills')) S.map.getSource('pills').setData(renderPillsFC());
    applyProvincesToMap();   // 省界与线路数据同一显示变换通道：gaode 态下坐标随 dispCoord 重投影
    applyDistrictsToMap();   // 区界同通道重投影（2026-11-27）
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
  // 调光线集计算（applyDimState 与 applyBasemapToMap 共用——底图切换时深图⇄浅色策略
  // 自动跟随、切走无残留，2026-11-27 深图态高亮策略）：
  //   ① computeDimmedSet（浅色口径）——focus/phase 任一激活时他省线恒入集；分期旧单选
  //      路径（S.phase 恒 'none'）现为空转；
  //   ② 分期态他省线恒入集（2026-11-25 裁定，浅色/深图同口径——罩上 lines-displayonly
  //      层 dim case → 0.5）；
  //   ③ 深图态高亮 dim 扩展（2026-11-27 裁定）：深图类底图（dark/darkSat）且高亮激活
  //      （聚焦/车站/分期任一）时，高亮豁免集（veilFocusSkipSet——聚焦/车站成员；分期态
  //      ＝null 即无豁免）之外的**全部线**并入 S.dimmed → line-opacity 0.5（DIM_OPACITY，
  //      复用既有 dim case）。高亮成员照旧 veilSkip 出基础层＋focus-copy 罩上重画全亮。
  //      分期态的「未选期 0.5」是**段级** dim（renderLinesFC 按 V.deepPhaseDimBit 覆写
  //      feature dim 位——严格按区段裁定），线级全集只是兜底；联络线（blend/arrow）走
  //      各自动态层，feature dim 位同样吃 S.dimmed → 非高亮联络线 0.5。浅色类不进此
  //      分支（③恒不触发），白罩法三态行为逐位不变。
  function recomputeDimmed() {
    // 2026-11-22 主支线合并：调光组级（lineGroups 传入——期次/仅显示级以主线为准；
    // S.focus 恒为主线 id，见 toggleFocus 归一）。
    // 2026-11-22 白罩定案：聚焦不贡献 dim（focus 仅作 displayOnly 激活位），无 hlMode。
    // 2026-11-27 车站高亮：computeDimmedSet 的 focus 位只用作「调光场合激活」判定（他省
    // 恒调光），不看具体 id——车站态传任一高亮主线 id 即可（lines 至少一条，空集不进车站态）。
    S.dimmed = V.computeDimmedSet(S.linesMap,
      { phase: S.phase,
        focus: S.focus != null ? S.focus
          : (S.station != null && S.station.lines && S.station.lines.length
            ? String(S.station.lines[0].mainId || '') || null : null),
        lineGroups: S.lineGroups });
    if (S.phaseActive) {
      // 分期态他省线恒入调光集（2026-11-25 纠正裁定：照常显示、罩上恒调光 0.5——与聚焦态
      // 他省线同口径）；本地线不进 dim（浅色态未选段由白罩压暗区分，不重复调光）
      for (const line of S.linesMap.values()) if (V.lineLayerRank(line) === 'displayOnly') S.dimmed.add(line.lineId);
    }
    // ③ 深图态高亮 dim 扩展（见上注；浅色类/非高亮态零变化）
    if (isDeepVeilBand() && (focusOrStation() || S.phaseActive)) {
      const skip = veilFocusSkipSet();
      for (const id of V.deepHighlightDimIds(S.linesMap, skip || [])) S.dimmed.add(id);
    }
  }
  // 调光应用：重算 S.dimmed 与联络线渐变集 → 四个 source 全量重设（渲染特征重带 dim 位、
  // fadeSet 线跳基础层）→ 渐变层重建 → 标签重排。与底图切换共用 render* 函数（互相独立、
  // 叠加不冲突——坐标变换与 dim 位各管各的）。样式未就绪时只置 pending 标记（同底图四态
  // 模式），on('load') 后补应用，点击不丢失。
  function applyDimState() {
    recomputeDimmed();
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
  // 2026-11-27 点击车站：fade 计划泛化——车站态对每条高亮自然线路各跑 connectorFadePlan、
  // 按 lineId 去重合并（先到先得：同一条联络线两端各接一条高亮线时，取首个命中的高亮线
  // 定渐变方向与基色——保守假设，报告备查）；每条目自带 color＝该高亮线的色（单线路径
  // 同补，渲染层统一吃 it.color）。联络线「只亮不列名」（修正裁定）：不进车站页、地图上
  // 以 conn-fade 渐变参与高亮。
  function updateFadeSet() {
    const plan = [];
    if (S.station != null && S.focus == null) {
      // S.station.lines 元素＝行对象（{mainId,…}），联络线判定循环取 mainId 字段
      const seen = new Set();
      for (const ln of S.station.lines || []) {
        const mainId = ln && ln.mainId != null ? String(ln.mainId) : '';
        if (!mainId) continue;
        const color = (S.linesMap.get(mainId) || {}).color;
        for (const it of V.connectorFadePlan(S.linesMap, mainId)) {
          if (seen.has(it.lineId)) continue;
          seen.add(it.lineId);
          plan.push({ lineId: it.lineId, attachEnd: it.attachEnd, color });
        }
      }
    } else if (S.focus != null) {
      const color = (S.linesMap.get(S.focus) || {}).color;
      for (const it of V.connectorFadePlan(S.linesMap, S.focus)) {
        plan.push({ lineId: it.lineId, attachEnd: it.attachEnd, color });
      }
    }
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
  function connLayerSkeleton(layerId, lineId, segIndex) {
    return {
      id: layerId, type: 'line', source: 'conn-fade',
      filter: segIndex == null ? ['==', ['get', 'lineId'], lineId]
        : ['all', ['==', ['get', 'lineId'], lineId], ['==', ['get', 'segIndex'], segIndex]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': V.zoomInterp(V.scaledSize(V.LINE_WIDTH_PX), V.LINE_WIDTH_PX),
        'line-offset': ['coalesce', ['get', 'sharedOffset'], 0],   // 共线段偏移（见 lineLayerDef 注；整线 feature 无段级属性 → 恒 0，分期拆段 feature 带）
      },
    };
  }
  // 分期态动态渐变按 segment 拆 feature/layer，但 line-progress 仍映射回全线原始区间，
  // 因此分段边界处颜色连续；正常总览/focus 路径仍使用原整线 source/layer。
  function remapGradientProgress(gradient, range) {
    if (!Array.isArray(gradient) || gradient[0] !== 'interpolate' || !(Array.isArray(gradient[2]) && gradient[2][0] === 'line-progress')) return gradient;
    const copy = gradient.slice();
    copy[2] = ['+', range.start, ['*', range.end - range.start, ['line-progress']]];
    return copy;
  }
  function phaseDynamicSegments(line, reverse) {
    const source = line.segments.map((seg) => (Array.isArray(seg.coords) ? seg.coords : [])
      .filter((pt) => pt && Number.isFinite(pt[0]) && Number.isFinite(pt[1]))
      .map((pt) => S.dispCoord(pt[0], pt[1])));
    const ranges = V.segmentProgressRanges(line.segments, source);
    const rangeByIndex = new Map(ranges.map((r) => [r.segIndex, r]));
    let segs = line.segments.slice();
    if (reverse) segs.reverse();
    return segs.map((seg) => {
      const range = rangeByIndex.get(seg.segIndex) || { start: 0, end: 1 };
      const phaseRange = reverse ? { start: 1 - range.end, end: 1 - range.start } : range;
      const coords = source[line.segments.indexOf(seg)].slice();
      if (reverse) coords.reverse();
      return { seg, range: phaseRange, coords };
    }).filter((item) => item.coords.length >= 2);
  }
  function addPhaseDynamicSegments(line, reverse, baseDef, layerPrefix, addLow, addTop, feats) {
    for (const item of phaseDynamicSegments(line, reverse)) {
      const seg = item.seg;
      const selected = V.phaseStatusSelected(seg.segStatus, S.phases);
      feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: item.coords },
        properties: { lineId: line.lineId, segIndex: seg.segIndex, segStatus: seg.segStatus,
          dim: selected ? 0 : (S.dimmed.has(line.lineId) ? 1 : 0),
          sharedOffset: Number.isFinite(seg.sharedOffset) ? seg.sharedOffset : 0 } });   // 共线段偏移（见 lineLayerDef 注）
      const def = Object.assign({}, baseDef, {
        id: layerPrefix + line.lineId + '-' + seg.segIndex,
        filter: ['all', ['==', ['get', 'lineId'], line.lineId], ['==', ['get', 'segIndex'], seg.segIndex]],
        layout: Object.assign({}, baseDef.layout),
        paint: Object.assign({}, baseDef.paint,
          { 'line-gradient': remapGradientProgress(baseDef.paint['line-gradient'], item.range) }),
      });
      // Selected segments are the only dynamic special geometry redrawn above the veil.
      if (selected) def.paint['line-opacity'] = 1;
      (selected ? addTop : addLow)(def);
    }
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
  // demo 高亮渐变：白罩常驻层切换（0↔0.7 走建层时的 fill-opacity-transition 渐入渐出）。
  // 显示条件与旧全删全建实现一致＝聚焦态 ∨ 分期态；幂等，样式未就绪时由 pending 机制兜底。
  // 2026-11-27 深图态高亮策略：深图类（dark/darkSat）白罩不出——高亮对比改用其他线路
  // 不透明度（S.dimmed 扩展），focus-copy 罩上重画层照旧（全亮、不被常态 0.32 底图遮罩
  // 压暗——层序本来就在白罩之上，白罩透明不影响）。层保留常驻透明（fill-opacity 恒 0），
  // 切回浅色类自动恢复白罩法。
  function syncFocusVeil() {
    if (!S.map || !S.map.getLayer('focus-veil')) return;
    S.map.setPaintProperty('focus-veil', 'fill-opacity',
      ((focusOrStation() || S.phaseActive) && !isDeepVeilBand()) ? FOCUS_VEIL_OPACITY : 0);
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
  // 罩上他省线层（2026-11-25 纠正裁定）：分期态他省线画在白罩之上——不被白罩压暗、也不进
  // 期次高亮（focus-copy 只收本地选中段），保持「恒调光」＝dim case（分期态他省线 dim 位
  // 恒 1 → 0.5，与聚焦态他省线同口径）。source 复用 'lines'（基础层特征已在，靠 filter 分流）；
  // filter 只按 province 位收（不带 dash 条件——meta.layer 单值下他省≠预控通道，数据上恒
  // 实线；脏数据若有他省虚线则在此层退化为实线可见，不静默丢失）。仅分期态创建。
  function displayOnlyLineLayerDef() {
    return {
      id: 'lines-displayonly', type: 'line', source: 'lines',
      filter: ['==', ['get', 'province'], 1],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        'line-opacity': ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1],
        'line-width': V.zoomInterp(V.scaledSize(V.LINE_WIDTH_PX), V.LINE_WIDTH_PX),
        'line-offset': ['coalesce', ['get', 'sharedOffset'], 0],   // 共线段偏移（见 lineLayerDef 注）
      },
    };
  }
  // 基础线两层 filter 切换（rebuildConnLayers 全删全建时随行）：分期态排除他省线（其特征
  // 由罩上 lines-displayonly 层接管，防双层叠画）；其余态还原原 filter（不残留 province
  // 条件）。0/1 数字位一律显式 ==（勿用 '!'——弃层坑见 STOP_LAYER_DEFS 注）。
  function applyLineBaseFilters(phaseActive) {
    const map = S.map;
    const linesDef = lineLayerDef();
    const dashDef = corridorLineLayerDef('lines-dash', 'lines');
    if (!map.getLayer('lines')) return;
    map.setFilter('lines', phaseActive
      ? ['all', linesDef.filter, ['==', ['get', 'province'], 0]] : linesDef.filter);
    if (map.getLayer('lines-dash')) {
      map.setFilter('lines-dash', phaseActive
        ? ['all', dashDef.filter, ['==', ['get', 'province'], 0]] : dashDef.filter);
    }
  }
  // 聚焦重画特征：聚焦组成员的渲染特征（renderLinesFC 同款构造）；blend/fade/arrow
  // 成员跳过（渐变层接管——防御：联络线/出省线被录进线组的罕见形态，避免双层重复画，
  // 各渐变层自身已在白罩之上）。不带 dim 位（层定义恒原色，见 focusCopyLayerDef 注）；
  // 带 dash 位（2026-11-23：预控通道被聚焦时罩上重画保持虚线身份，实/虚两层收——
  // focusCopyLayerDef/focusCopyDashLayerDef）。坐标过 S.dispCoord（底图切换 gaode 同帧）。
  function renderFocusCopyFC() {
    const members = S.phaseActive ? [...S.linesMap.keys()]
      : (S.station != null && S.focus == null ? S.station.memberIds
        : (S.focus != null ? (S.lineGroups.ofLine.get(S.focus) || { members: [S.focus] }).members : []));
    const dc = S.dispCoord;
    const features = [];
    for (const lid of members) {
      const line = S.linesMap.get(lid);
      // 分期态他省线不进本层（不进期次高亮集合——2026-11-25 裁定），走罩上恒调光专用层
      // （rebuildConnLayers 的 lines-displayonly）；聚焦态不受此限——聚焦他省线时仍由本层
      // 罩上恒原色重画（「聚焦豁免一切」既有语义，基础层已按 veilSkip 剔除、别处不画）。
      if (!line || (S.phaseActive && lineOtherProvince(line))) continue;
      // 特殊动态层在所有状态下接管整条几何；分期时也不能被普通 copy 再叠一遍。
      if (S.blendSet.has(lid) || S.fadeSet.has(lid) || S.arrowSet.has(lid)) continue;
      for (const seg of line.segments) {
        if (S.phaseActive && !S.phases.has(seg.segStatus)) continue;
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
          properties: { lineId: line.lineId, name: line.name, color: line.color, segStatus: seg.segStatus, segIndex: seg.segIndex, dash: V.lineDashed(line),
            sharedOffset: Number.isFinite(seg.sharedOffset) ? seg.sharedOffset : 0 },   // 共线段偏移（见 lineLayerDef 注）
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
  // 罩上站圈复制层定义：与 stopLayerDef 同 source 同 paint，唯 opacity 聚焦态恒 1
  //（不挂 dim case——聚焦成员的站圈罩上完整显示，「聚焦豁免一切」）；分期态挂 dim case
  //（本地期次匹配站 dim=0 → 1 完整显示；他省单元站 dim=1 → 0.5 恒调光，2026-11-25 裁定）
  function stopFocusLayerDef(d, memberExpr) {
    const dimCase = ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1];
    const op = S.phaseActive ? dimCase : 1;
    return {
      id: d.id + '-focus', type: 'circle', source: 'stops',
      filter: ['all', d.filter, memberExpr],
      paint: {
        'circle-color': '#ffffff',
        'circle-radius': V.zoomInterp(V.scaledSize(d.radius), d.radius),
        'circle-stroke-color': ['get', 'stroke'],
        'circle-stroke-width': V.zoomInterp(V.scaledSize(d.strokeW), d.strokeW),
        'circle-opacity': op,
        'circle-stroke-opacity': op,
      },
    };
  }
  // 罩上药丸复制层定义：与 PILL_LAYER_DEFS 同 source 同尺寸，唯 line-opacity 聚焦态恒 1
  //（「聚焦豁免一切」）、分期态挂 dim case（本地选中药丸 dim=0 → 1、他省药丸 dim=1 → 0.5
  // 恒调光，2026-11-25 裁定）；
  // ⚠ line-cap/line-join 是 layout 属性（放 paint 会拒载整个 style 全黑——本项目踩过的
  // 坑）；layout/paint 逐键新造对象，不复用常量层定义里的引用（防 addLayer 内部处理
  // 污染初始 style 定义）
  function pillFocusLayerDef(base, memberExpr) {
    return {
      id: base.id + '-focus', type: 'line', source: 'pills', filter: memberExpr,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': base.paint['line-color'],
        'line-opacity': S.phaseActive
          ? ['case', ['==', ['get', 'dim'], 1], V.DIM_OPACITY, 1] : 1,
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
    // 聚焦参与判定表达式（线路聚焦∨车站高亮时才非 null）：罩下五层追加 ['!', expr]、
    // 罩上复制层用 expr 本体（构造与合法性注释见 memberMatchExpr）
    const focusSkip = veilFocusSkipSet();
    const memberExpr = focusSkip != null ? memberMatchExpr([...focusSkip]) : null;
    // 分期态罩上符号收「期次匹配站 ∨ 他省单元」（他省站上罩不被白罩压暗、phaseMatch 恒 0
    // 不亮——2026-11-25 纠正裁定）；罩下五层对称排除两者，防双层叠画
    const phaseExpr = S.phaseActive ? ['==', ['get', 'phaseMatch'], 1] : null;
    const provinceExpr = S.phaseActive ? ['==', ['get', 'province'], 1] : null;
    const copyExpr = memberExpr
      || (phaseExpr && provinceExpr ? ['any', phaseExpr, provinceExpr] : (phaseExpr || provinceExpr));
    // 罩下基础站圈/药丸五层 filter 同帧切换（焦点成员或分期匹配站移至罩上复制层）
    applyFocusFilters(copyExpr);
    // 基础线两层同帧排除他省线（分期态；特征由罩上 lines-displayonly 接管）
    applyLineBaseFilters(S.phaseActive);
    // 白罩常驻层切换（demo 渐变改造，见 syncFocusVeil 注）；选中段的特殊渐变层插罩上，未选段插罩下。
    syncFocusVeil();
    // ① blend 形态联络线层（有效联络线中未被当前聚焦绑定的；聚焦绑定的走 fade
    //    形态插到白罩之上，故先跳过）
    const fadeIds = new Set((S.fadeConnPlan || []).map((it) => it.lineId));
    for (const it of S.blendPlan || []) {
      if (fadeIds.has(it.lineId)) continue;
      const line = S.linesMap.get(it.lineId);
      if (!line) continue;
      const baseDef = connBlendLayerDef('conn-blend-' + line.lineId, line.lineId, it.headColor, it.tailColor);
      if (S.phaseActive) {
        if (lineOtherProvince(line)) {
          // 他省联络线不按 segStatus 拆段（不参与期次）：整线罩上、恒调光（dim case 层定义自带）
          const coords = connCoords(line, false);
          if (coords) {
            feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
              properties: { lineId: line.lineId, dim: S.dimmed.has(line.lineId) ? 1 : 0 } });
            addTop(baseDef);
          }
        } else {
          addPhaseDynamicSegments(line, false, baseDef, 'conn-blend-seg-', addLow, addTop, feats);
        }
      } else {
        const coords = connCoords(line, false);
        if (!coords) continue;
        feats.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { lineId: line.lineId, dim: S.dimmed.has(line.lineId) ? 1 : 0 },
        });
        addLow(baseDef);
      }
    }
    // ② 聚焦重画层（线路聚焦∨车站高亮∨分期——白罩定案后唯一高亮形态；白罩本身已是常驻层，
    //    见 syncFocusVeil）
    if (S.focus != null || S.station != null || S.phaseActive) {
      const copySrc = map.getSource('focus-copy');
      if (copySrc) copySrc.setData(renderFocusCopyFC());
      addTop(focusCopyLayerDef());
      addTop(focusCopyDashLayerDef());   // 预控通道成员罩上保持虚线（2026-11-23）
      // 分期态他省线罩上恒调光层（2026-11-25）：不被白罩压暗、不进期次高亮——位置在
      // focus-copy（本地选中段）之后、罩上符号复制层之前（线在下、符号在上）
      if (S.phaseActive) addTop(displayOnlyLineLayerDef());
    }
    // ③ fade 形态联络线层（聚焦绑定：聚焦线色→透明；罩上＝渐变高亮不被罩压白；非聚焦无此层）
    //    2026-11-27 车站多线：基色逐条取 it.color（updateFadeSet 按「该联络线命中的高亮线」着色）
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
      addTop(connFadeLayerDef('conn-fade-' + line.lineId, line.lineId, it.color || focusColor));
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
        : (S.station != null && S.focus == null ? (S.station.memberIds || []).map(String) : []));
    for (const it of S.arrowPlan || []) {
      const line = S.linesMap.get(it.lineId);
      if (!line) continue;
      const def = arrowFadeLayerDef('arrow-fade-' + line.lineId, line.lineId, line.color, it.headCut, it.tailCut);
      if (!def) continue;
      if (S.phaseActive) {
        if (lineOtherProvince(line)) {
          // 他省出省线不按 segStatus 拆段（不参与期次）：整线罩上、恒调光（dim case 层定义自带）
          const coords = connCoords(line, false);
          if (coords) {
            feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
              properties: { lineId: line.lineId, dim: S.dimmed.has(line.lineId) ? 1 : 0 } });
            addTop(def);
          }
        } else {
          addPhaseDynamicSegments(line, false, def, 'arrow-fade-seg-', addLow, addTop, feats);
        }
      } else {
        const coords = connCoords(line, false);
        if (!coords) continue;
        feats.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: { lineId: line.lineId, dim: S.dimmed.has(line.lineId) ? 1 : 0 },   // 照常受调光规则
        });
        if (arrowFocusIds.has(String(line.lineId))) addTop(def); else addLow(def);
      }
    }
    // ⑤ 罩上符号复制层（2026-11-22 真机反馈轮：聚焦成员的站圈/药丸在罩上完整显示）——
    //    同 source 同尺寸、opacity 恒 1（去 dim case，对齐 focus-copy「聚焦豁免一切」
    //    裁定）；filter＝原条件 ∧ 聚焦参与。添加序 pills 先 stops 后（药丸垫底站圈
    //    盖上——与静态区相对序一致）；点选/hover 与基础层同绑（罩上 feature 只在这层
    //    渲染，事件绑定随层走）。退出聚焦＝层随全删全建消失、filter 还原。
    if (copyExpr) {
      for (const base of PILL_LAYER_DEFS) {
        const def = pillFocusLayerDef(base, copyExpr);
        addTop(def);
        bindPinLayerInteraction(def.id);
      }
      for (const d of STOP_LAYER_DEFS) {
        const def = stopFocusLayerDef(d, copyExpr);
        addTop(def);
        bindPinLayerInteraction(def.id);
      }
    }
    if (src) src.setData(feats.length ? { type: 'FeatureCollection', features: feats } : EMPTY_CONN_FC);
  }

  // ---------- 分期循环按钮（demo 新 UI：「显示线路」全部→既有→近期→远期→全部） ----------
  // 语义内核沿用旧复选框实现：全部＝三选（总览不启用分期）、单档＝S.phases 只含该期、
  // phaseActive＝非全选（严格按区段 segStatus 高亮）。切档退出聚焦（既有语义）。
  const PHASE_CYCLE_LABEL = { all: '全部', existing: '既有', approved: '近期', future: '远期' };
  const PHASE_CYCLE_ORDER = ['all', 'existing', 'approved', 'future'];
  function syncPhaseUI() {
    const b = $('btnCyclePhase');
    if (b) b.textContent = PHASE_CYCLE_LABEL[S.phaseCycle] || S.phaseCycle;
  }
  function resetPhaseSelection() {
    S.phaseCycle = 'all';
    S.phases = new Set(['existing', 'approved', 'future']);
    S.phaseActive = false;
    S.phase = 'none';
    syncPhaseUI();
    buildLineList();   // 解除分期变灰（点击线路/切档后列表态刷新）
    // 二轮⑬修复：独立调用路径（返回初始界面＝clearFocus 后 resetPhase）也须重算地图侧——
    // 否则分期白罩停留在 0.7 不归零（setFocus(id) 路径随后自有 applyDimState 覆盖，双调幂等）
    applyDimState();
  }
  function applyPhaseCycle(value) {
    S.phaseCycle = value;
    S.phases = value === 'all' ? new Set(['existing', 'approved', 'future']) : new Set([value]);
    S.phaseActive = value !== 'all';
    S.phase = 'none';
    syncPhaseUI();
    if (S.focus != null) setFocus(null);
    applyDimState();
    buildLineList();   // 分期单选态：变灰条目集随档位刷新
    scheduleHover();   // 2026-11-27：分期态切换重判 hover cursor（pointer 只在非分期态出现）
  }
  //（2026-11-22 定案轮删除：高亮方式切换 setHlMode/S.hlMode 与白罩不透明度五档
  //   cycleVeilOpacity/S.veilOpacity 两套对比开关——用户定案遮罩 70%，恒定值见
  //   FOCUS_VEIL_OPACITY，聚焦高亮不再有其他模式。）
  // 聚焦：双击列表行/双击地图线路切换（再双击同一对象退出、双击别的线切换）、Esc 退出；
  // 他省线与普通线路一样可聚焦（列表双击/搜索选中均经 setFocus）；其恒调光规则独立保留。
  // 2026-11-22 用户需求 1：进入聚焦时相机 fitBounds 跳到该线（退出聚焦
  // 绝对不动相机——用户明令「再次双击不必跳回之前的视图」）。
  function setFocus(lineId) {
    // 2026-11-22 晚交互改版：入口统一归一到主线（地图点选支线线身等效聚焦主线组；
    // toggleFocus/pickEntry 原地归一由此收口，幂等——同线重复进入不动）
    const raw = lineId || null;
    const id = raw != null ? (S.lineGroups.mainOf.get(raw) || raw) : null;
    if (id != null) resetPhaseSelection();
    S.focus = id;
    syncFocusRows();
    applyDimState();
    if (id != null) fitFocusLine(id);   // 需求 1：仅进入聚焦跳相机；setFocus(null) 不跳
  }
  // 2026-11-22 用户需求 1：聚焦线相机跳转——fitBounds 到该线渲染 bbox（S.dispBbox 与
  // 渲染特征同帧，gaode 底图下也正确）；bbox 不存在时静默不跳。maxZoom 13 与搜索定位同档。
  // 2026-11-22 主支线合并：bbox＝组全体成员渲染 bbox 联合（支线也是这条线的一部分）；
  // 单成员缺 bbox 跳过，全体缺失 → null 静默不跳（保留原行为）。
  // 2026-11-27 真机病灶①修复：bbox 另并入**聚焦绑定联络线**的渲染 bbox（V.focusBboxOf
  // ——联络线以 conn-fade 罩上渐变高亮呈现、视觉上属于聚焦呈现的一部分，但几何可延伸到
  // 线路本体 bbox 之外；用户抓包＝聚焦东西联络线时西衔嘉青松金线的联络线被切出画面。
  // 口径与 conn-fade 渲染判定同源＝S.fadeConnPlan（connectorFadePlan 产物），不另立关联
  // 规则；S.fadeConnPlan 已由本函数调用前的 applyDimState→updateFadeSet 与渲染同帧就绪）。
  function fitFocusLine(id) {
    const bb = V.focusBboxOf(S.dispBbox, S.lineGroups, id, S.fadeConnPlan);
    if (!bb || !S.map) return;
    // 移动端（2026-11-28 用户裁定）：高亮全线＝线路 bbox 居中＋zoom 直接 11——不 fitBounds、
    // 不算 padding/让位/站名余量（线两端超出屏幕无所谓，用户自己捏合看）；flyTo 动画保留
    //（900ms essential 同桌面）。仅线路聚焦如此——车站聚焦 zoom13 与其他相机行为照旧。
    if (isMobileViewport()) {
      S.map.flyTo({ center: [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2], zoom: 11, duration: 900, essential: true });
      return;
    }
    // 2026-11-27 动效改版：fitBounds 改 flyTo——目标位由 cameraForBounds 按 cameraPadding/
    // maxZoom 解出（vendored maplibre 的 fitBounds 内部同款「先解算再动画」模式），飞行缩放
    // 曲线观感更平滑；duration 600→900 与车站定位 800 同档。⚠ padding 只作解算输入，
    // flyTo 不传 padding 选项——它写持久 transform.padding 会污染后续 fitBounds 几何
    //（见 cameraPadding 注，与搜索车站 flyTo 用一次性 offset 同一裁定的两种实现）。
    // essential:true＝必要动画、「减少动态」系统偏好下也不降级（2026-11-27 拆除降级）；
    // cameraForBounds 异常防御
    // 回落旧 fitBounds 动画（同为平滑，行为不降级）。
    let cam = null;
    try {
      cam = S.map.cameraForBounds([[bb[0], bb[1]], [bb[2], bb[3]]],
        { padding: cameraPadding(), maxZoom: 13 });
    } catch (e) { cam = null; }
    if (cam && cam.center && Number.isFinite(cam.zoom)) {
      S.map.flyTo({ center: cam.center, zoom: cam.zoom, duration: 900, maxZoom: 13, essential: true });
    } else {
      S.map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]],
        { padding: cameraPadding(), duration: 600, maxZoom: 13 });
    }
  }
  // 面板可见性运行时探测（demo：唯一左侧面板 #panel；抽屉收起＝.collapsed 移出屏）：
  // !hidden 且 rect 在屏内（width>0 且 right>0——collapsed 态 transform 移出后 right<0）。
  function panelVisible(el) {
    if (!el || el.hidden || el.classList.contains('collapsed')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.right > 0;
  }
  // 2026-11-27 相机让位 padding（推广到一切相机动作）：左＝面板展开时其右缘＋24（面板宽
  // 295＋左边距 12 → 常态 331）；抽屉收起回落 24（与其他边同档的默认呼吸量，不给面板
  // 留位）。上/下 24、右 64（右下有缩放控件）。每次调用实时取面板 rect——收/展后续相机
  // 动作自动跟随。⚠ fitBounds 的 padding 选项是一次性几何输入（vendored 5.24.1 的实现
  // 与 transform 持久 padding 分账，fitBounds 从不写它）；但 flyTo 的 padding 选项**会**
  // 写持久 transform.padding，后续 fitBounds 几何会把两者叠扣——故搜索车站的 flyTo 用
  // 等效一次性 offset，不碰 padding 选项。
  // 2026-11-27 真机病灶②修复：站名标签余量。端点站名以站点居中左右伸展（HTML 标签
  // nowrap＋translate(-50%,-140%)，普通站 12px／组站 13px 加粗，zoom≥11 原尺寸——聚焦
  // 短线被 maxZoom 13 夹住时正是原尺寸），只给呼吸量会让西端点贴面板右缘、居中的站名被
  // 裁一半。水平余量按真数据最长站名实测定半宽（组站「上海国际旅游度假区」9 汉字 13px
  // ≈117px、普通站「蟠祥路·国家会计学院」≈114px → 半宽 ≤60px，含 3px 描边外扩取 70）；
  // 垂直站名向上伸 ≈13×1.2×1.4＋描边 ≈24px（取 26），top 补同量、bottom 无需（标签恒在
  // 站点上方）；右侧基线 64（缩放控件）与「呼吸＋半宽」94 取大——东端组站名右伸不被屏缘
  // 裁掉。原则：聚焦后线路全部几何＋两端站名完整可见。
  const LABEL_MARGIN_X = 70, LABEL_MARGIN_Y = 26;
  function cameraPadding() {
    const GAP = 24, RIGHT = 64;
    // 移动端（2026-11-28）：面板贴底——让位改算 bottom（面板可见高＋24；hidden 档＝收起只
    // 给呼吸量），其余边 24。消费方（车站聚焦 flyTo 的一次性 offset、fitAll 解算）随之把
    // 目标抬进可见上半屏。桌面路径逐位不变。
    if (isMobileViewport()) {
      const p = $('panel');
      const h = (S.ui.sheetSnap !== 'hidden' && p) ? p.getBoundingClientRect().height : 0;
      return { top: GAP, bottom: h > 0 ? h + GAP : GAP, left: GAP, right: GAP };
    }
    const lp = $('panel');
    const left = panelVisible(lp) ? lp.getBoundingClientRect().right + GAP + LABEL_MARGIN_X
      : GAP + LABEL_MARGIN_X;
    return { top: GAP + LABEL_MARGIN_Y, bottom: GAP, left, right: Math.max(RIGHT, GAP + LABEL_MARGIN_X) };
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
  //（demo 新 UI：原屏幕下方聚焦信息框 syncFocusBox 退役——线路页 openLinePage 取代，
  //   信息与 KML 下载都在左侧面板；导出仅 KML，不提供 GeoJSON。）
  // 全局站名开关（循环按钮「站名」显示⇄隐藏）：隐藏时一切站名不显示（优先级最高，
  // 只影响 HTML 标签、站圈符号保留）
  function syncNamesUI() {
    const b = $('btnCycleNames');
    if (b) b.textContent = S.namesOn ? '显示' : '隐藏';
  }
  function toggleNames() {
    S.namesOn = !S.namesOn;
    syncNamesUI();
    scheduleLabels();
  }

  // ---------- 移动端 bottom sheet（2026-11-28 适配第一批；桌面零改动） ----------
  // 断点判定＝matchMedia，与 index.html @media (max-width: 767px) 同串同值（768＝
  // VIEWER_CORE.MOBILE_BREAKPOINT；768px 平板竖屏归桌面——295px 左侧面板在该宽度仍可用）。
  // SHEET_HANDLE_H＝把手触摸区高，与 index.html #sheetHandle 的 height:30px 同值（两处同改）。
  const MQ_MOBILE = G.matchMedia ? G.matchMedia('(max-width: 767px)') : null;
  function isMobileViewport() { return !!(MQ_MOBILE && MQ_MOBILE.matches); }
  const SHEET_HANDLE_H = 30;
  // 三档标准高度（px）：hidden＝只露把手、half＝视口半高、full＝整个视口；视口高取
  // innerHeight（documentElement 兜底）。core 纯函数防御返回 null 时就地兜半屏。
  function sheetHeightsNow() {
    const vh = G.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    const h = V.sheetSnapHeights(vh, SHEET_HANDLE_H);
    return h || { hidden: SHEET_HANDLE_H, half: Math.round(vh / 2) || SHEET_HANDLE_H, full: vh || SHEET_HANDLE_H };
  }
  // 三档应用：写 #panel inline 高度＋data-sheetSnap（冒烟断言/CSS 钩子）；hidden ⇔
  // S.panelCollapsed 同步 true（相机让位与可见性判定消费同一「收起」语义）。instant＝直设
  // 不播过渡（初始/跨断点/resize 重贴）；常规档切换走 .3s height 过渡。只动面板高度，
  // 不碰聚焦/分期——收起不影响高亮，与桌面抽屉同语义。
  function applySheetSnap(snap, instant) {
    const panel = $('panel');
    if (!panel) return;
    const heights = sheetHeightsNow();
    if (!(snap in heights)) snap = 'half';
    S.ui.sheetSnap = snap;
    S.panelCollapsed = snap === 'hidden';
    if (instant) panel.classList.add('noanim');
    panel.style.height = heights[snap] + 'px';
    panel.dataset.sheetSnap = snap;
    if (instant) { void panel.offsetWidth; panel.classList.remove('noanim'); }
  }
  // 把手拖拽（pointer 事件，2026-11-28 需求）：拖拽中 .dragging 禁 transition、高度随指针
  // 直更（hidden～full 夹取）；松手按 V.nearestSheetSnap 吸附最近档并恢复过渡。位移 <6px
  // 视为点击＝收一档/展开（hidden→half、half→hidden、full→half）。move/up 挂 document 级
  // ——指针滑出把手区仍跟踪，不依赖 setPointerCapture。仅移动端生效（桌面把手 display:none
  // 不可达；防御上再判一次断点）。
  function wireSheetHandle() {
    const handle = $('sheetHandle');
    if (!handle) return;
    let dragging = false, startX = 0, startY = 0, startH = 0, lastX = 0, lastY = 0;
    handle.addEventListener('pointerdown', (e) => {
      if (!isMobileViewport()) return;
      if (e.button != null && e.button !== 0) return;   // 只认主键/触摸/笔
      dragging = true;
      startX = lastX = e.clientX; startY = lastY = e.clientY;
      startH = $('panel').getBoundingClientRect().height;
      $('panel').classList.add('dragging');
      e.preventDefault();   // 防触摸长按选字/鼠标拖选
    });
    document.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      lastX = e.clientX; lastY = e.clientY;
      const hh = sheetHeightsNow();
      const h = Math.min(hh.full, Math.max(hh.hidden, startH + (startY - e.clientY)));
      $('panel').style.height = h + 'px';
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      $('panel').classList.remove('dragging');
      const tap = Math.abs(lastY - startY) < 6 && Math.abs(lastX - startX) < 6;
      if (tap) {
        // 点击把手＝收一档/展开：hidden→half（展开）、half→hidden（收起，等价桌面收起按钮）、
        // full→half（收一档，骤然全隐太猛）
        applySheetSnap(S.ui.sheetSnap === 'full' ? 'half' : (S.ui.sheetSnap === 'hidden' ? 'half' : 'hidden'));
        return;
      }
      const snap = V.nearestSheetSnap($('panel').getBoundingClientRect().height, sheetHeightsNow());
      applySheetSnap(snap || S.ui.sheetSnap);
    };
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  }
  // 跨断点切换（旋转/拉宽拉窄窗口）：桌面抽屉态与移动 sheet 档互映射（collapsed⇔hidden），
  // 并清对端残留形态（inline 高度 / collapsed 类）。标签字号乘数随断点变——重排一轮。
  // ⚠ 映射判定只看**桌面权威形态**（.collapsed 类）：跨断点时 resize 事件可能先于 MQ change
  // 触发，resize handler 会按旧 snap 抢写面板（顺带改 S.panelCollapsed）——若消费该变量，
  // 「桌面展开→切回窄屏」会被污染成 hidden。类只有桌面路径（setLinePanelCollapsed）维护，
  // applySheetSnap 不碰它，两序（resize 先/后）均收敛。
  function syncViewportMode() {
    const panel = $('panel');
    if (!panel) return;
    if (isMobileViewport()) {
      const wasCollapsed = panel.classList.contains('collapsed');
      panel.classList.remove('collapsed');
      $('panelCollapse').classList.remove('stowed');
      $('panelTab').hidden = true;
      applySheetSnap(wasCollapsed ? 'hidden' : 'half', true);
    } else {
      panel.style.height = '';
      delete panel.dataset.sheetSnap;
      panel.classList.remove('dragging', 'noanim');
      setLinePanelCollapsed(S.ui.sheetSnap === 'hidden');
    }
    scheduleLabels();
  }
  // 初始化（wireUI 头部）：移动端首帧即半屏（instant 不闪）；MQ change＝跨断点同步；
  // resize＝移动端视口高变（地址栏收展/旋转）重贴当前档标准高度（拖拽中不抢）。
  function initViewportMode() {
    wireSheetHandle();
    if (MQ_MOBILE) {
      const onChange = () => syncViewportMode();
      if (MQ_MOBILE.addEventListener) MQ_MOBILE.addEventListener('change', onChange);
      else if (MQ_MOBILE.addListener) MQ_MOBILE.addListener(onChange);   // 旧 Safari
    }
    G.addEventListener('resize', () => {
      if (isMobileViewport() && S.ui.sheetSnap) applySheetSnap(S.ui.sheetSnap, true);
    });
    if (isMobileViewport()) applySheetSnap('half', true);
  }

  // ---------- 线路列表（demo 新 UI：三选项卡；自然线路；分期单选态变灰） ----------
  // 选项卡＝layer 精确匹配（市区线/市域线/预控通道）：他省与联络线不在三个类别里、自然
  // 不进列表（他省显示「直接舍弃」裁定）；未分类线不属于任何选项卡（真数据当前无未分类）。
  // 条目＝自然线路（有效线组按组名一条、独立线一条；支线不出独立行——layerGroups 已并入
  // 主线行）。排序沿用 lineOrder 自定义序。行内不再显示类别灰字注释（都在该分类里了）。
  // 分期单选态（显示线路≠全部）：该线（组＝全体成员并集）在选中期内没有任何区段 → 变灰
  // 不可点击；「只要高亮了一截甚至一站就算显示到了」＝严格按区段 segStatus 判。
  function tabLines() {
    for (const g of V.layerGroups(S.linesMap, S.lineOrder, S.lineGroups)) {
      if (g.layer === S.ui.tab) return g.lines;
    }
    return [];
  }
  function linePhaseHit(lineId) {
    const grp = S.lineGroups.ofLine.get(lineId);
    const ids = grp ? grp.members : [lineId];
    for (const lid of ids) {
      const line = S.linesMap.get(lid);
      if (!line) continue;
      for (const seg of line.segments) if (S.phases.has(seg.segStatus)) return true;
    }
    return false;
  }
  function buildLineList() {
    const host = $('lineList');
    if (!host) return;
    host.textContent = '';
    const lines = tabLines();
    if (!lines.length) {
      const tip = document.createElement('div');
      tip.className = 'panel-tip';
      tip.textContent = '（本分类暂无可列出的线路）';
      host.appendChild(tip);
      return;
    }
    for (const line of lines) {
      const item = document.createElement('div');
      item.className = 'line-item';
      item.dataset.line = line.lineId;
      const phaseOut = S.phaseActive && !linePhaseHit(line.lineId);
      if (phaseOut) item.classList.add('phase-out');
      const sw = document.createElement('span');
      sw.className = 'line-swatch'; sw.style.background = line.color;
      const nm = document.createElement('span');
      nm.className = 'line-name'; nm.textContent = line.name || line.lineId;
      item.append(sw, nm);
      if (!phaseOut) {
        item.addEventListener('click', () => {
          setFocus(line.lineId);          // 高亮＋跳转（进入即解除分期、仅高亮单线）
          openLinePage(line.lineId, 'list');   // 面板跳线路页（来源＝列表，二轮②）
        });
      }
      if (S.focus === line.lineId) item.classList.add('focused');
      host.appendChild(item);
    }
  }

  // ---------- 视图切换（初始界面 / 主界面 / 线路页 / 车站页；2026-11-27 动效：滑动过渡） ----------
  // 四视图绝对堆叠于 #panelViews（CSS data-pos 三态：center / off-left(-28% 淡) / off-right），
  // 层级 rank 推挤方向：rank {splash:0 < main:1 < station:2 < line:3}——前进＝新视图自右滑入、
  // 旧视图退左淡出；返回反向。覆盖链路：确认→main、列表/搜索→line、点站→station、车站页
  // 线路行→line、逐级返回 line→station→main→splash 全部自动推导正确；「线路页状态下点站」
  //（line→station，降级）走返回向——侧向切换视觉为「回到车站层」。视图常驻 DOM（不再
  // display 硬切），滚动位置/搜索词/焦点在切换间零丢失；动画期间非活动视图
  // pointer-events:none。时长/缓动＝index.html --slide-dur(420ms)/--slide-ease（与既有
  // 420ms 玻璃过渡同档）；noanim＝进场起始位瞬时跳转（reflow 生效后即移除）。
  const VIEW_RANK = { splash: 0, main: 1, station: 2, line: 3 };
  const VIEW_IDS = { splash: 'viewSplash', main: 'viewMain', station: 'viewStation', line: 'viewLine' };
  function viewEl(view) { return $(VIEW_IDS[view]); }
  // 初始化（wireUI 头部调用）：解除 HTML 的无 JS 降级 [hidden]，改挂 data-pos 滑轨位
  //（当前视图 center、其余 off-right；visibility 由 CSS 即时隐藏，同帧无闪烁）
  function initViewPositions() {
    for (const v of Object.keys(VIEW_IDS)) {
      const el = viewEl(v);
      el.hidden = false;
      el.dataset.pos = v === S.ui.view ? 'center' : 'off-right';
    }
    // 搜索结果容器的降级 [hidden] 一并解除——此后显隐全由 #viewMain.searching 类驱动
    const sr = $('searchResults');
    if (sr) sr.hidden = false;
  }
  function showView(view) {
    const prev = S.ui.view;
    S.ui.view = view;
    if (prev === view || !(view in VIEW_IDS) || !(prev in VIEW_IDS)) return;
    const fwd = VIEW_RANK[view] > VIEW_RANK[prev];
    const oldEl = viewEl(prev), newEl = viewEl(view);
    // 2026-11-27 用户裁定：splash↔main 双向均硬切（前进＝开屏「确认」瞬间进主界面、
    // 返回＝退回开屏同帧直达，都不滑动）。双视图同帧挂 noanim 直设终态、reflow 后即
    // 移除——visibility 延迟切换也被 noanim 盖住立即生效（真切换而非光速划过），无过渡
    // 类残留。终态停靠位与滑动语义同向：前进 splash 退左、返回 main 退右（off-right 是
    // 返回向旧视图的退场位），此后无论哪个方向再切，进/退场位都自然正确。
    if ((prev === 'splash' && view === 'main') || (prev === 'main' && view === 'splash')) {
      oldEl.classList.add('noanim');
      newEl.classList.add('noanim');
      oldEl.dataset.pos = view === 'main' ? 'off-left' : 'off-right';
      newEl.dataset.pos = 'center';
      void newEl.offsetWidth;
      oldEl.classList.remove('noanim');
      newEl.classList.remove('noanim');
      if (view !== 'main') closeBasemapMenu();   // 与滑动分支同口径：离开 main 即收底图清单
      return;
    }
    // 新视图瞬时跳到进场起始位（noanim 跳过过渡，强制 reflow 后恢复过渡能力）
    newEl.classList.add('noanim');
    newEl.dataset.pos = fwd ? 'off-right' : 'off-left';
    void newEl.offsetWidth;
    newEl.classList.remove('noanim');
    // 双视图同帧对滑（旧视图退场、新视图进场；visibility 由 CSS 按终态规则延迟切换）
    oldEl.dataset.pos = fwd ? 'off-left' : 'off-right';
    newEl.dataset.pos = 'center';
    if (view !== 'main') closeBasemapMenu();   // 2026-11-27：底图清单只在主界面（离开即收，防回主界面残留展开态）
  }

  // ---------- 线路页（demo 新 UI：lineinfo 或「无信息」；最下方 KML 下载） ----------
  // 二轮②：from＝进入来源（'list' 列表 / 'search' 搜索结果）——搜索来源返回时保留搜索词
  // 与结果（返回按钮回到 main 视图后搜索态 DOM 原样即恢复），列表来源维持回列表。
  // 2026-11-27 增 'station'：从车站页线路行进入——返回回车站页（逐级返回链）；非车站来源
  // 进入时清 S.station（跳出车站链，防聚焦清除后车站高亮残留）。
  // 2026-11-27 增 'line'：从线路页站行换乘项跳转进入——返回回原线路页（换乘链逐级返回，
  // linePagePrev 栈）。'line' 进入不清 S.station（原线路页可能来自车站链，返回后其
  // from='station' 语义要靠 S.station 存活）；非换乘来源进入＝新链起点，清 linePagePrev。
  function openLinePage(lineId, from) {
    S.ui.linePageId = lineId;
    S.ui.linePageFrom = from === 'search' ? 'search' : (from === 'station' ? 'station' : (from === 'line' ? 'line' : 'list'));
    if (from !== 'station' && from !== 'line') S.station = null;
    if (from !== 'line') S.ui.linePagePrev = null;
    showView('line');
    const body = $('lineBody');
    body.textContent = '';
    const line = S.linesMap.get(lineId);
    const grp = S.lineGroups.ofLine.get(lineId);
    const name = grp ? grp.name : (line ? (line.name || line.lineId) : lineId);
    const color = line ? line.color : '#888888';
    const head = document.createElement('div');
    head.className = 'lp-head';
    const sw = document.createElement('span');
    sw.className = 'lp-swatch'; sw.style.background = color;
    const nm = document.createElement('div');
    nm.className = 'lp-name'; nm.textContent = name;
    head.append(sw, nm);
    // 分类标签（2026-11-28 通用需求，手机电脑都要）：标题色块＋线路名后追加类别小标签
    //（市区线／市域线／预控通道等）。lineId 恒为主线 id（调用方已归一）——线组天然取主线
    // 分类，无组单线取自身 layer；无 layer 不出标签。样式＝小号灰字描边 chip（黑白灰一致）。
    const layer = line ? String(line.layer || '') : '';
    if (layer) {
      const chip = document.createElement('span');
      chip.className = 'lp-layer-chip';
      chip.textContent = layer;
      head.appendChild(chip);
    }
    body.appendChild(head);
    // lineinfo（既有口径 lineInfoEntryOf：先线组 id、落线自身 id）；无信息＝只显示名称＋
    // 标志色色块＋「无信息」提示（标题区即名称与色块）
    const hit = V.lineInfoEntryOf(lineId, S.linesMap, S.lineGroups, S.lineInfo);
    if (hit) {
      const sec = document.createElement('div');
      sec.className = 'lineinfo';
      appendLineInfo(sec, [hit.id], null);
      body.appendChild(sec);
    } else {
      const tip = document.createElement('div');
      tip.className = 'lp-none';
      tip.textContent = '无信息';
      body.appendChild(tip);
    }
    // 车站列表（2026-11-27）：信息（或「无信息」提示）下方——竖直线站序样式，主线段
    // ＋分割线＋每条支线一段；arrow 出省端画线端箭头＋「出省」小字；接入标注（往支线去向/
    // 往主线/联络对方线）＝V.lineStopSections 模型。lineinfo 有无与本列表无耦合。
    // 2026-11-27 增：站行 transfers（换乘信息，lineOrder 序与车站页一致）。
    const stopModel = V.lineStopSections(lineId, S.linesMap, S.stops, S.lineGroups, S.groupTree, S.lineOrder);
    if (stopModel) {
      // 信息区与车站列表之间的分割线（2026-11-27 用户需求）：lineinfo／「无信息」态
      //（名称＋色块＋虚线提示框）与下方列表目前无缝——复用 .lp-divider（支线分割同款
      // 灰色语言，与整体黑白灰一致）。
      const dv = document.createElement('div');
      dv.className = 'lp-divider';
      body.appendChild(dv);
      body.appendChild(buildStopSection(stopModel));
    }
  }
  // 线路页返回的统一行为（btnLineBack/Esc 共用，2026-11-27 换乘链改版抽函数）：
  // 'station' 来源 → 车站页（S.station 保留、clearFocus 不动相机）；'line' 来源（换乘项
  // 跳转进入）→ 原线路页（换乘链 linePagePrev 逐级弹回：openLinePage 重建页面内容，
  // 聚焦手动置回原线——不走 setFocus 防跳相机）；其余 → main（搜索来源自动恢复搜索态）。
  function backFromLinePage() {
    if (S.ui.linePageFrom === 'station' && S.station != null) {
      clearFocus();
      showView('station');
      return;
    }
    if (S.ui.linePageFrom === 'line' && S.ui.linePagePrev && S.ui.linePagePrev.id != null) {
      const p = S.ui.linePagePrev;
      S.ui.linePagePrev = p.prev || null;   // 弹栈：更早的链留给上一层返回用
      openLinePage(p.id, p.from);
      S.focus = p.id;                        // 恢复聚焦原线（不动相机）
      syncFocusRows();
      applyDimState();
      return;
    }
    clearFocus();
    showView('main');
  }

  // ---------- 线路页车站列表渲染（2026-11-27：竖直线站序；视觉常量与地图侧同源） ----------
  // 样式基准（2026-11-27 用户澄清）：参照本图地图侧的线宽/站圈/组圈视觉体系等比适配——
  // 竖线宽 7px＝LINE_WIDTH_PX、普通节点直径 11（r5.5）描边 1.2、黑边节点描边 1.32、
  // 换乘大圈直径 15（r7.5）、药丸高 15 黑边 2.2（pills 层 19.4/15 的列表等价），数值与
  // viewer.js 画布视觉参数注释一一对应，CSS 侧不再另立一套。节点形态由模型 glyph 给出
  //（stopNodeGlyph＝buildStopView 同规则）；黑白灰 UI 约束不破——彩色仅竖线/节点描边
  // /接入渐变短线的线路标志色，站名与标注文字恒黑。
  // 接入标注行为：branch（主线行「往〈支线去向〉」）＝滚动到支线段；toMain（支线接入
  // 端「往主线」）＝滚动回主线接入位置；conn（「联络〈对方自然线路名〉」＋对方线色）＝
  // 与列表点击线路同款跳转（setFocus 聚焦＋相机＋面板线路页）。直角短线统一向右（回避
  // 支线/联络方向未定义），渐变到透明。
  function markElOfStopList(mk) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lp-mark lp-mark-' + mk.type;
    const tail = document.createElement('span');
    tail.className = 'lp-mark-tail';
    tail.style.background = 'linear-gradient(90deg, ' + (mk.color || '#888888') + ', rgba(0,0,0,0))';
    const txt = document.createElement('span');
    txt.className = 'lp-mark-txt';
    txt.textContent = mk.label;
    b.append(tail, txt);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      handleStopListMark(mk);
    });
    return b;
  }
  function handleStopListMark(mk) {
    if (mk.type === 'conn' && mk.targetMainId) {
      setFocus(mk.targetMainId);               // 与列表点击线路同款：聚焦＋相机让位
      openLinePage(mk.targetMainId, 'list');   // 面板线路页（来源＝列表口径）
      return;
    }
    let target = null;
    if (mk.type === 'branch') {
      target = document.getElementById('lpsec-' + mk.targetSectionIdx);
    } else if (mk.type === 'toMain') {
      const ta = mk.targetAt;
      if (ta && ta.row != null) target = document.getElementById('lprow-' + mk.targetSectionIdx + '-' + ta.row);
      else if (ta && ta.after != null) target = document.getElementById('lpinter-' + mk.targetSectionIdx + '-' + ta.after);
      if (!target) target = document.getElementById('lpsec-' + mk.targetSectionIdx);
    }
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  // 换乘信息项（2026-11-27 用户需求：站行右侧「小色点＋线名」）：可点＝与车站页线路行
  // 一致的交互语言——高亮该线＋跳线路页；来源恒 'line'（返回回原线路页，换乘链逐级
  // 返回）。click stopPropagation 与站行点击（进车站页）区隔，lp-mark 同款。
  function xferElOfStopList(t) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lp-xfer-item';
    const dot = document.createElement('span');
    dot.className = 'lp-xfer-dot';
    dot.style.background = t.color || '#888888';
    const nm = document.createElement('span');
    nm.className = 'lp-xfer-name';
    nm.textContent = t.name;
    b.append(dot, nm);
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (t.mainId == null) return;
      // 换乘链栈：记住跳转前所在线路页（id＋其进入来源＋更早的链），返回时逐级弹回
      S.ui.linePagePrev = { id: S.ui.linePageId, from: S.ui.linePageFrom, prev: S.ui.linePagePrev || null };
      setFocus(t.mainId);               // 与列表点线路同款：聚焦＋相机让位
      openLinePage(t.mainId, 'line');   // 面板线路页（来源＝换乘，返回回原线路页）
    });
    return b;
  }
  function buildStopSection(model) {
    const wrap = document.createElement('div');
    wrap.className = 'lp-stops';
    model.sections.forEach((sec, si) => {
      if (si > 0) {   // 支线分割线（用户描述：主线站全部写完后「断一下」）
        const dv = document.createElement('div');
        dv.className = 'lp-divider';
        wrap.appendChild(dv);
      }
      const rowMarks = new Map(), interMarks = new Map();
      for (const mk of sec.marks || []) {
        if (mk.at.row != null) {
          if (!rowMarks.has(mk.at.row)) rowMarks.set(mk.at.row, []);
          rowMarks.get(mk.at.row).push(mk);
        } else if (mk.at.after != null) {
          if (!interMarks.has(mk.at.after)) interMarks.set(mk.at.after, []);
          interMarks.get(mk.at.after).push(mk);
        }
      }
      // 环线表达（2026-11-28 用户改版，真机目验裁定「C 形回环线诡异」）：只留段顶「环线」
      // 小字＋rail 头尾与出省端同款的线端箭头（首端朝上、末端朝下，朝列表两端外侧示意
      // 循环延续；复用 lp-rail-head/lp-rail-tail 三角，环线不出省，与 arrow 端并入同一
      // class 判定）。note 放 secEl 外（wrap 层、段之前）——secEl 内首子元素会推低 rail
      // 的绝对定位锚（rail top 按行区起算）。少于 2 行无环可示（防御）。
      const isLoop = !!sec.loop && sec.rows.length >= 2;
      if (isLoop) {
        const note = document.createElement('div');
        note.className = 'lp-loop-note';
        note.textContent = '环线';
        wrap.appendChild(note);
      }
      const secEl = document.createElement('div');
      secEl.className = 'lp-sec';
      secEl.id = 'lpsec-' + si;
      secEl.style.setProperty('--sec-color', sec.color || '#888888');
      const rail = document.createElement('div');
      const headArrow = sec.rows.length && sec.rows[0].kind === 'arrow';
      const tailArrow = sec.rows.length && sec.rows[sec.rows.length - 1].kind === 'arrow';
      // 箭头 class：出省端（arrow 行）与环线头尾同款三角——环线＝两端各一个，出省线＝仅
      // 出省端（真出省端另有「出省」小字区分，见下方 arrow 行）。
      rail.className = 'lp-rail'
        + (headArrow || isLoop ? ' lp-rail-head' : '')
        + (tailArrow || isLoop ? ' lp-rail-tail' : '');
      secEl.appendChild(rail);
      sec.rows.forEach((row, ri) => {
        const inter = interMarks.get(ri - 1);   // at.after=ri-1：画在上一行与本行之间
        if (inter) {
          const iv = document.createElement('div');
          iv.className = 'lp-inter';
          iv.id = 'lpinter-' + si + '-' + (ri - 1);
          for (const mk of inter) iv.appendChild(markElOfStopList(mk));
          secEl.appendChild(iv);
        }
        if (row.kind === 'arrow') {   // 出省端：线端箭头（rail 端三角）＋「出省」小字
          // （2026-11-28 防混淆：环线头尾也用同款箭头了，真出省端加二字标注区分；仍不写站名）
          const ar = document.createElement('div');
          ar.className = 'lp-row lp-row-arrow';
          const an = document.createElement('span');
          an.className = 'lp-arrow-note';
          an.textContent = '出省';
          ar.appendChild(an);
          secEl.appendChild(ar);
          return;
        }
        const r = document.createElement('div');
        r.className = 'lp-row';
        r.id = 'lprow-' + si + '-' + ri;
        // 共线区间标注（2026-11-28 用户需求，sharedTracks 消费）：区间内站行加对方线色
        // 侧边条（细竖条贴 rail 右缘，逐行片段拼连续、段首末行圆头——与地图共线段双
        // 平行线的表达同构）；连续行段＝相邻行同 shared.mainId 归并（环线环绕跨段自然
        // 拆两段，各自成条）。段首行加「与〈对方名〉共线」小字（前置对方色小短条），
        // 与换乘信息（行尾「圆点＋线名」可点）视觉区分：共线≠换乘、位置不同、形状不同
        //（短条 vs 圆点）、静态不可点。
        const sh = row.shared || null;
        const prevSh = ri > 0 ? (sec.rows[ri - 1].shared || null) : null;
        const nextSh = ri + 1 < sec.rows.length ? (sec.rows[ri + 1].shared || null) : null;
        const shFirst = sh && (!prevSh || prevSh.mainId !== sh.mainId);
        const shLast = sh && (!nextSh || nextSh.mainId !== sh.mainId);
        if (sh) {
          const bar = document.createElement('span');
          bar.className = 'lp-shared-bar' + (shFirst ? ' lp-shared-first' : '') + (shLast ? ' lp-shared-last' : '');
          bar.style.background = sh.color || '#888888';
          bar.dataset.sharedMain = sh.mainId;
          r.appendChild(bar);
        }
        const g = row.glyph || { kind: 'dot', stroke: null };
        const node = document.createElement('span');
        node.className = 'lp-node lp-node-' + g.kind;
        node.style.borderColor = g.stroke || sec.color || '#888888';
        r.appendChild(node);
        const nm = document.createElement('span');
        nm.className = 'lp-station';
        nm.textContent = row.name || V.stopDisplayName('');
        r.appendChild(nm);
        if (sh && shFirst) {
          const tag = document.createElement('span');
          tag.className = 'lp-shared-tag';
          tag.style.setProperty('--shared-color', sh.color || '#888888');
          tag.textContent = '与' + (sh.name || sh.mainId) + '共线';
          r.appendChild(tag);
        }
        for (const mk of rowMarks.get(ri) || []) r.appendChild(markElOfStopList(mk));
        // 换乘信息（2026-11-27）：站名/接入标注之后，行内右侧对齐收尾（margin-left:auto）；
        // 空集（单线站/junction 同组站）不建 DOM 不占位；真数据最多 6 条（上海南站），
        // 面板一行放不下时自然换行收紧（.lp-row 已 wrap、换乘区内部再 wrap）。
        if (Array.isArray(row.transfers) && row.transfers.length) {
          const xf = document.createElement('span');
          xf.className = 'lp-xfer';
          for (const t of row.transfers) xf.appendChild(xferElOfStopList(t));
          r.appendChild(xf);
        }
        // 站行可点（2026-11-27 用户需求）：与地图点该站同款行为——sid 反查绘制单元 pin
        //（stopPinKeyOf，口径＝emitUnit 出图）后走 enterStationByPin（flyTo 到站 zoom13＋
        // 波纹＋多线高亮＋面板车站页）。来源记忆按「点进去时面板是什么页面」：当前在线路
        // 页 → stationFrom='line'，返回回线路页（恢复聚焦、不动相机），与现行「线路页状态
        // 下点站」路径同语义（返回向滑动一致）。行内标注（lp-mark）click 已 stopPropagation，
        // 不误触本行跳转；pin 查不到（脏数据）静默不动作。
        r.addEventListener('click', () => {
          const stop = S.stops.find((s) => s.sid === row.sid);
          if (!stop) return;
          const key = V.stopPinKeyOf(stop, S.groupTree);
          const pin = key != null ? S.pinByKey.get(key) : null;
          if (pin) enterStationByPin(pin);
        });
        secEl.appendChild(r);
      });
      wrap.appendChild(secEl);
    });
    return wrap;
  }

  // ---------- 车站页（2026-11-27 点击车站：flyTo＋多线高亮＋面板车站页；两入口一行为） ----------
  // 行为三件套：①相机 flyTo 站坐标 zoom13（沿用搜索定位，含相机让位 offset）＋波纹叠加；
  // ②多线高亮＝白罩＋罩上重画经过该站的全部自然线路（veilFocusSkipSet/renderFocusCopyFC
  // 泛化为集合，相机让位 padding 沿用；高亮内核取景 bbox＝focusBboxOfSet〔core 纯函数，
  // 含联络线延伸段并入，当前相机走 flyTo 到站、bbox 为内核能力备查〕）；③面板车站页
  //（站名＋一行一自然线路；一站多名时每行附该线叫法；行可点——2026-11-27 修正裁定：
  // 点行＝高亮该线＋面板跳线路页，来源 'station'、逐级返回）。
  // 他省线参与（修正裁定）：进高亮集（渲染走聚焦态他省既有口径——罩上显示/恒调光、不进
  // 期次高亮）＋列表显示行＋行可点。联络线只亮不列名（钉死规则）：不进车站页任何文字，
  // 地图上按 connects∩高亮成员走 conn-fade 渐变（updateFadeSet 多线版）。
  // 来源记忆：进入时记面板当时视图（search/line/list）；返回回那个视图、地图高亮同时取消
  //（from='line' 恢复进入前聚焦线，不跳相机）。已在车站页换点他站不覆盖来源（链条保持）。
  function enterStationByPin(pin) {
    const st = V.stationFocusOf(pin, S.linesMap, S.lineGroups, S.groupTree, S.lineOrder);
    if (!st || !S.map) return false;
    if (S.ui.view !== 'station') {
      S.ui.stationFrom = S.ui.view === 'line' ? 'line' : (S.ui.searching ? 'search' : 'list');
      S.ui.stationResumeFocus = S.focus;   // from='line' 返回时恢复（不跳相机）
    }
    S.focus = null;       // 切换为车站高亮（「聚焦某线时点车站：切换为车站高亮」）
    S.station = st;
    resetPhaseSelection();   // 分期态点车站＝解除分期（按钮回「全部」，与列表点线路语义一致）
    syncFocusRows();
    applyDimState();
    openStationPage(st);
    scheduleHover();      // cursor 重判（车站态/分期解除）
    // 相机：flyTo 站坐标 zoom13＋相机让位一次性 offset（不碰 flyTo 的 padding 选项——
    // 它写持久 transform.padding 会污染后续 fitBounds 几何，见 cameraPadding 注）＋波纹
    //（2026-11-27 动效拆除降级：essential:true——「减少动态」系统偏好下也不再即时定位）
    const pad = cameraPadding();
    S.map.flyTo({
      center: S.dispCoord(st.lon, st.lat), zoom: 13, duration: 800, essential: true,
      offset: [(pad.left - pad.right) / 2, (pad.top - pad.bottom) / 2],
    });
    playStopFx(st.lon, st.lat);
    return true;
  }
  function openStationPage(st) {
    showView('station');
    const body = $('stationBody');
    body.textContent = '';
    const head = document.createElement('div');
    head.className = 'lp-head';
    const nm = document.createElement('div');
    nm.className = 'lp-name';
    nm.textContent = V.stopDisplayName(st.name);
    head.appendChild(nm);
    body.appendChild(head);
    const list = document.createElement('div');
    list.className = 'st-lines';
    for (const ln of st.lines) {
      const item = document.createElement('div');
      item.className = 'st-line';
      const sw = document.createElement('span');
      sw.className = 'line-swatch'; sw.style.background = ln.color;
      const nameEl = document.createElement('span');
      nameEl.className = 'st-line-name';
      nameEl.textContent = ln.name || ln.mainId;
      item.append(sw, nameEl);
      // 一站多名（multiName）才逐行标注该线叫法；该线多个叫法（同线多成员站）全列出
      if (st.multiName && ln.calls.length) {
        const call = document.createElement('span');
        call.className = 'st-line-call';
        call.textContent = '（' + ln.calls.map(V.stopDisplayName).join('、') + '）';
        item.appendChild(call);
      }
      // 行可点（2026-11-27 修正裁定）：高亮该线＋跳线路页（含相机 fitBounds，与列表点击
      // 同款）；来源 'station'——线路页返回回车站页（逐级返回链）
      item.addEventListener('click', () => {
        setFocus(ln.mainId);
        openLinePage(ln.mainId, 'station');
      });
      list.appendChild(item);
    }
    body.appendChild(list);
  }
  // 车站页返回：按记录的来源回那个视图（地图高亮同时取消）；from='line' 恢复进入前聚焦线
  //（手动置 S.focus＋applyDimState，不走 setFocus——其 fitFocusLine 会跳相机，违背
  //「退出/恢复聚焦不动相机」既有精神）
  function exitStationPage() {
    const from = S.ui.stationFrom;
    const resume = S.ui.stationResumeFocus;
    S.station = null;
    S.ui.stationResumeFocus = null;
    if (from === 'line' && resume != null) {
      S.focus = resume;
      syncFocusRows();
      applyDimState();
      showView('line');
      return;
    }
    applyDimState();   // 取消多线高亮（S.focus 已 null、分期已 all）
    showView('main');  // search 来源：搜索词与结果 DOM 保留，回 main 即恢复搜索态
  }

  // ---------- 信息行渲染（demo：站点面板退役，infoRow 仅供 lineinfo 字段区复用） ----------
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
  //（demo 新 UI：原站点面板 openStopPanel 整个退役——点车站（地图或搜索结果）不触发任何
  //   面板，任务书钉死；嵌套组关系描述等信息随面板一并移除，地图画法不受影响。）

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

  // ---------- 搜索（demo 新 UI：结果占据整个左侧面板主体；顶条与署名行保留） ----------
  // 钉死规则：技术线路（联络线/组内支线/他省线）不得在任何地方出现、名称不得出现——
  // 线路条目只收列表可见的自然线路（按主线 layer 过滤联络线/他省；支线本就并入组条目）；
  // 车站条目副行的所属线名过滤同口径。线路默认排在站点前（matchEntries 内核既有排序）。
  // 输入即自动搜索、清空自动恢复列表；无可点搜索按钮、回车不触发任何事。
  function buildSearchIndex() {
    const ents = [];
    for (const e of V.lineSearchEntries(S.linesMap, S.lineGroups)) {
      const line = S.linesMap.get(e.id);   // 条目 id＝主线（layerGroups 分类以主线为准）
      if (!line) continue;
      if (V.HIDDEN_LIST_LAYERS.indexOf(line.layer) >= 0 || V.lineLayerRank(line) === 'displayOnly') continue;
      e.ref = S.summaries.get(e.id) || null;
      ents.push(e);
    }
    for (const lb of S.dispLabels) {
      ents.push({ type: 'stop', id: lb.key, text: lb.name, aliases: [], ref: lb });
    }
    S.searchIdx = ents;
  }
  // 车站副行所属线名（过滤技术线路名称；显示名走 lineLabelOf 组归并口径并去重）
  function stopSubText(lb) {
    const out = [];
    for (const lid of (lb && lb.lineIds) || []) {
      const line = S.linesMap.get(lid);
      if (!line) continue;
      if (V.HIDDEN_LIST_LAYERS.indexOf(line.layer) >= 0 || V.lineLayerRank(line) === 'displayOnly') continue;
      const s = V.lineLabelOf(lid, S.linesMap, S.lineGroups, '');
      if (s && out.indexOf(s) < 0) out.push(s);
    }
    return out.join('、');
  }
  function currentHits() { return V.matchEntries($('searchInput').value, S.searchIdx, 30); }
  function renderSearchResults() {
    const host = $('searchResults');
    const input = $('searchInput');
    const searching = !!(input && input.value.trim());
    S.ui.searching = searching;
    // 2026-11-27 动效改版：搜索态展开/收起改 #viewMain.searching 类驱动交叉滑动过渡
    //（#mainBody 退左淡出、#searchResults 自右淡入，CSS 见 index.html #mainSwap 段），
    // 不再 hidden 硬切——搜索词与结果 DOM 在往返线路页/车站页之间照旧保留
    const vm = $('viewMain');
    if (vm) vm.classList.toggle('searching', searching);
    if (!host) return;
    if (!searching) return;   // 收起时保留结果 DOM（再次输入即重建，与旧 hidden 行为一致）
    host.textContent = '';
    const hits = currentHits();
    if (!hits.length) {
      const tip = document.createElement('div');
      tip.className = 'sr-empty';
      tip.textContent = '（没有匹配的线路或车站）';
      host.appendChild(tip);
      return;
    }
    // 线路在前、车站在后（任务书：线路默认排在站点前面——matchEntries 序内按类型分区）
    const renderGroup = (ents, type) => {
      if (!ents.length) return;
      const cap = document.createElement('div');
      cap.className = 'sr-cap';
      cap.textContent = type === 'line' ? '线路' : '车站';
      host.appendChild(cap);
      for (const ent of ents) {
        const item = document.createElement('div');
        item.className = 'sr-item';
        if (ent.type === 'line') {
          // 二轮③：线路条目加标志色色点（与列表一致，取主线色——例外色，黑白灰规则不适用）
          const line = S.linesMap.get(ent.id);
          const dot = document.createElement('span');
          dot.className = 'sr-dot';
          dot.style.background = line ? line.color : '#000';
          item.appendChild(dot);
        }
        const main = document.createElement('span');
        main.className = 'sr-main';
        main.textContent = ent.text || '(未命名)';
        const sub = document.createElement('span');
        sub.className = 'sr-sub';
        if (ent.type === 'line') {
          // 二轮③：副行不写「线路」，改显示该线分类（市区线/市域线/预控通道——技术线路
          // 本就不出条目，layer 恒在三类内；不展开 aliases——支线名不得出现）
          const line = S.linesMap.get(ent.id);
          sub.textContent = (line && line.layer) || '';
        } else {
          const t = stopSubText(ent.ref);
          sub.textContent = '车站' + (t ? ' · ' + t : '');
        }
        item.append(main, sub);
        item.addEventListener('mousedown', (ev) => { ev.preventDefault(); pickEntry(ent); });
        host.appendChild(item);
      }
    };
    renderGroup(hits.filter((e) => e.type === 'line'), 'line');
    renderGroup(hits.filter((e) => e.type === 'stop'), 'stop');
  }
  function pickEntry(ent) {
    if (ent.type === 'line') {
      // 二轮②：同列表点击进线路页，但**保留搜索词与结果**（不清空）——线路页返回时回搜索
      // 界面；视图切走前主体让位状态冻结在 viewMain 内，返回 main 即恢复搜索态
      $('searchInput').blur();
      setFocus(ent.id);
      openLinePage(ent.id, 'search');
    } else {
      const lb = ent.ref;
      if (!lb || !S.map) return;
      // 2026-11-27 点击车站改版：完整行为（flyTo zoom13＋波纹＋多线高亮＋面板车站页），
      // 搜索结果保留（返回回搜索态）。纯联络线站（无自然线路）退旧行为：仅 flyTo＋波纹。
      const pin = S.pinByKey.get(lb.key);
      if (pin && enterStationByPin(pin)) return;
      const pad = cameraPadding();
      S.map.flyTo({
        center: S.dispCoord(lb.lon, lb.lat), zoom: 13, duration: 800, essential: true,
        offset: [(pad.left - pad.right) / 2, (pad.top - pad.bottom) / 2],
      });
      playStopFx(lb.lon, lb.lat);
    }
  }
  function wireSearch() {
    const input = $('searchInput');
    input.addEventListener('input', renderSearchResults);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { input.value = ''; renderSearchResults(); input.blur(); }
      // 回车不触发任何事（任务书钉死）；方向键亦无动作
    });
  }

  // ---------- 车站定位 focus 动画（demo：搜索点车站的短暂扩散圆环指示） ----------
  // wrapper 每帧按 map.project 重定位（flyTo 途中环跟随站点）；内层两圈环＋圆点跑 CSS
  // 动画（1.15s＋0.3s 错峰），1.6s 后自清。符合总体浅色玻璃风格的强调色圆环。
  function playStopFx(lon, lat) {
    const host = $('focusFx');
    if (!host || !S.map) return;
    host.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'fx-item';
    const r1 = document.createElement('div'); r1.className = 'fx-ring';
    const r2 = document.createElement('div'); r2.className = 'fx-ring fx-ring-2';
    const dot = document.createElement('div'); dot.className = 'fx-dot';
    wrap.append(r1, r2, dot);
    host.appendChild(wrap);
    const t0 = performance.now();
    const tick = () => {
      let xy = null;
      try { xy = S.map.project(S.dispCoord(lon, lat)); } catch (e) { xy = null; }
      if (xy) wrap.style.transform = 'translate3d(' + xy.x.toFixed(1) + 'px,' + xy.y.toFixed(1) + 'px,0)';
      if (performance.now() - t0 < 1600 && wrap.isConnected) requestAnimationFrame(tick);
      else wrap.remove();
    };
    requestAnimationFrame(tick);
  }

  // ---------- HTML 中文标签叠加层（map.project + rAF 合帧） ----------
  function scheduleLabels() {
    if (S.labelFrame) return;
    S.labelFrame = G.requestAnimationFrame(() => { S.labelFrame = 0; updateLabels(); updateCoordinateRuler(); });
  }
  function updateCoordinateRuler() {
    const svg = $('coordinateRuler');
    const map = S.map;
    if (!svg || !map || !V.edgeTickPositions) return;

    const width = map.getCanvas().clientWidth;
    const height = map.getCanvas().clientHeight;
    if (width < 100 || height < 100) {
      svg.replaceChildren();
      return;
    }

    // map.unproject 返回当前底图显示坐标；高德态用既有 GCJ02 逆变换恢复 WGS84 读数。
    // 每条边分别采样，旋转/倾斜后经纬度沿单边可能非单调，不能用全视口跨度估步长。
    const inverseDisplay = (S.basemap === 'gaode' || S.basemap === 'gaode-plain') ? V.gcj02ToWgs84 : (lon, lat) => [lon, lat];
    const sampleEdge = (name, count = 64) => Array.from({ length: count + 1 }, (_, i) => {
      const t = i / count;
      let point;
      if (name === 'top') point = [20 + (width - 40) * t, 0];
      else if (name === 'bottom') point = [20 + (width - 40) * t, height];
      else if (name === 'left') point = [0, 20 + (height - 40) * t];
      else point = [width, 20 + (height - 40) * t];
      const displayed = map.unproject(point);
      const [lon, lat] = inverseDisplay(displayed.lng, displayed.lat);
      return { t, value: name === 'top' || name === 'bottom' ? lon : lat };
    });
    const edges = {
      top: sampleEdge('top'), bottom: sampleEdge('bottom'),
      left: sampleEdge('left'), right: sampleEdge('right'),
    };
    const longitudes = edges.top.concat(edges.bottom).map((sample) => sample.value);
    const latitudes = edges.left.concat(edges.right).map((sample) => sample.value);
    const edgeSpan = (samples) => Math.max(...samples.map((sample) => sample.value)) - Math.min(...samples.map((sample) => sample.value));
    const longitudeSpan = Math.max(edgeSpan(edges.top), edgeSpan(edges.bottom));
    const latitudeSpan = Math.max(edgeSpan(edges.left), edgeSpan(edges.right));
    const longitudeStep = V.niceTickStep(longitudeSpan, width - 40, 95);
    const latitudeStep = V.niceTickStep(latitudeSpan, height - 40, 62);
    const longitudeTicks = V.coordinateTicks(Math.min(...longitudes), Math.max(...longitudes), longitudeStep);
    const latitudeTicks = V.coordinateTicks(Math.min(...latitudes), Math.max(...latitudes), latitudeStep);
    const labels = [];
    const ticks = [];

    const addEdgeTicks = (axis, values, step, name) => {
      const horizontal = name === 'top' || name === 'bottom';
      const positions = V.edgeTickPositions(edges[name], values);
      for (const { value, t } of positions) {
        const x = horizontal ? 20 + (width - 40) * t : (name === 'left' ? 0 : width);
        const y = horizontal ? (name === 'top' ? 0 : height) : 20 + (height - 40) * t;
        const tick = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        if (horizontal) {
          const direction = name === 'top' ? 1 : -1;
          tick.setAttribute('d', `M${x},${name === 'top' ? 1 : height - 1}v${direction * 5}`);
          label.setAttribute('x', x);
          label.setAttribute('y', (name === 'top' ? 1 : height - 1) + direction * 8);
          label.setAttribute('text-anchor', 'middle');
          label.setAttribute('dominant-baseline', direction > 0 ? 'hanging' : 'auto');
        } else {
          const direction = name === 'left' ? 1 : -1;
          tick.setAttribute('d', `M${name === 'left' ? 1 : width - 1},${y}h${direction * 5}`);
          label.setAttribute('x', (name === 'left' ? 1 : width - 1) + direction * 8);
          label.setAttribute('y', y);
          label.setAttribute('text-anchor', direction > 0 ? 'start' : 'end');
          label.setAttribute('dominant-baseline', 'middle');
        }
        tick.setAttribute('stroke', '#9ca3af');
        tick.setAttribute('stroke-width', '1');
        tick.setAttribute('fill', 'none');
        label.textContent = V.formatCoordinate(value, axis, step);
        labels.push({ element: label, edge: name, x, y, horizontal });
        ticks.push(tick);
      }
    };
    addEdgeTicks('lon', longitudeTicks, longitudeStep, 'top');
    addEdgeTicks('lon', longitudeTicks, longitudeStep, 'bottom');
    addEdgeTicks('lat', latitudeTicks, latitudeStep, 'left');
    addEdgeTicks('lat', latitudeTicks, latitudeStep, 'right');

    // 先接入 SVG 取得实际文本宽度，再按各边可用的像素跨度过滤重叠；角落横纵标签也互检。
    svg.replaceChildren(...ticks, ...labels.map((item) => item.element));
    const svgRect = svg.getBoundingClientRect();
    const controls = Array.from(document.querySelectorAll('.maplibregl-ctrl')).map((control) => {
      const rect = control.getBoundingClientRect();
      return { x: rect.left - svgRect.left, y: rect.top - svgRect.top, width: rect.width, height: rect.height };
    });
    const accepted = [];
    for (const item of labels) {
      const box = item.element.getBBox();
      const candidate = { ...item, box };
      const overlaps = (otherBox) => box.x < otherBox.x + otherBox.width + 3 &&
        box.x + box.width + 3 > otherBox.x && box.y < otherBox.y + otherBox.height + 3 &&
        box.y + box.height + 3 > otherBox.y;
      if (controls.some(overlaps) || accepted.some((other) => overlaps(other.box))) item.element.remove();
      else accepted.push(candidate);
    }
  }
  // 车站态标签 key（2026-11-27 用户裁定「只有该站站名显示」）：单线站＝站 sid、同站/药丸
  // 组 pin＝'g:<组号>'，与 dispLabels 标签 key 天然同源。唯一例外＝出闸组（out-of-station）：
  // 成员站各自成圈（pin.key＝站 sid）而该单元标签是组级（key＝'g:<组号>'、位置在直属站
  // 均值）——按 pin 携带的组号回查组级标签（点出闸组的任一直属站圈，显示该组直属站标签）。
  function stationLabelKeyOf(st) {
    const key = st && st.key != null ? String(st.key) : '';
    if (!key) return null;
    const pin = S.pinByKey.get(key);
    if (pin && pin.groupType === 'out-of-station' && pin.groupId != null) return 'g:' + pin.groupId;
    return key;
  }
  function updateLabels() {
    const wrap = $('labelLayer');
    const map = S.map;
    if (!wrap || !map) return;
    // 站名可见性（优先级：全局站名开关 ＞ 聚焦常显·其余隐藏 ＞ 车站态单显 ＞ 被调光线隐藏
    // ＞ zoom 门槛；2026-11-22 真机反馈轮——聚焦时非聚焦线站名一律隐藏）。focusMembers＝
    // 聚焦组成员集（主支线合并：支线站的站名也是聚焦线站名，须常显；无组退 [S.focus]）。
    // stationKey＝车站态（2026-11-27 用户裁定）：只有被点站/组 pin 的标签显示且常显
    //（无视 zoom 门槛），其余一切站名隐藏——与聚焦互斥（车站页↔线路页链中 S.station
    // 保留但 S.focus 已置，此时走聚焦分支）
    let focusMembers = null;
    let stationKey = null;
    if (S.station != null && S.focus == null) stationKey = stationLabelKeyOf(S.station);
    if (focusMembers == null && S.focus != null) {
      const grp = S.lineGroups.ofLine.get(S.focus);
      focusMembers = grp && Array.isArray(grp.members) && grp.members.length ? grp.members : [S.focus];
    }
    // 分期态标签＝期次匹配单元＋他省纯单元（2026-11-25 纠正裁定：他省站名照常显示——
    // 只按 zoom 门槛，见 visibleLabels 的 displayOnlyIds 放行）；混合单元按本地成员期次判
    const labels = S.phaseActive ? S.dispLabels.filter((label) => otherProvinceOnlyIds(label.lineIds)
      || phaseUnitMatches({ kind: label.group ? 'group' : 'stop', key: label.key, groupId: label.groupId, groupType: label.groupType })) : S.dispLabels;
    // 分期态 dimmedSet 换传「他省集」（2026-11-27 深图态高亮策略：标签联动口径沿用）：
    // 浅色态分期 S.dimmed 本就只有他省（等价替换）；深图态分期 S.dimmed 被 dim 扩展成
    // 全量集，直传会把期次匹配标签经 labelShownUnderDim 误隐——分期态标签显隐已由上方
    // 「期次匹配∨他省」预过滤承担，dim 集在此只作兜底（他省纯单元另有 displayOnlyIds
    // 放行）。聚焦/车站态不看 dimmedSet（visibleLabels 优先级在前两分支 return），传
    // S.dimmed 照旧；总览态 S.dimmed 为空。
    const items = V.visibleLabels(labels, map.getZoom(),
      { hideAll: !S.namesOn, dimmedSet: S.phaseActive ? displayOnlyLineIds() : S.dimmed, focus: S.focus, focusMembers, stationKey, phase: S.phase,
        displayOnlyIds: S.phaseActive ? displayOnlyLineIds() : [] });
    const w = wrap.clientWidth, h = wrap.clientHeight, M = 60;   // 视口外裁剪边距
    // 站名文字随画布等比缩放（2026-11-22 用户指示「站名和站点也一样，以 z11 为界」）：
    // z≥11 恒 1、z<11 按 2^(z−11)——与线宽/站圈同一规则（V.labelScale），挂 transform 末尾
    // 随标签自身锚点缩不漂移；百分比偏移（-50%/-140%）基于自身盒子也同步缩小，自然贴近站点。
    // 移动端（2026-11-28）：整体放大一档＝labelScale 再乘断点乘数 V.MOBILE_LABEL_SCALE
    //（12px→15px、13px→16.25px，组站/普通站同乘）——桌面端不乘（zf 恒 ≤1，拼接行为逐位
    // 不变：z≥11 时 zf=1 不拼、z<11 时照旧）。
    const zf = V.labelScale(map.getZoom()) * (isMobileViewport() ? V.MOBILE_LABEL_SCALE : 1);
    const zfTxt = zf !== 1 ? ' scale(' + zf.toFixed(3) + ')' : '';
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
      // demo 高亮渐变：站名显隐走 opacity（.map-label 带 CSS transition）——分期/聚焦
      // 切换时站名渐隐渐显，替代原 visibility 硬切
      if (el.style.opacity !== '1') el.style.opacity = '1';
      el.style.transform = 'translate3d(' + xy.x.toFixed(1) + 'px,' + xy.y.toFixed(1) + 'px,0) translate(-50%,-140%)' + zfTxt;
    }
    for (const [k, el] of S.labelPool) {
      if (!seen.has(k)) el.style.opacity = '0';
    }
    if (S.labelPool.size > 3000) {   // 池膨胀时清掉隐藏元素
      for (const [k, el] of S.labelPool) {
        if (!seen.has(k)) { el.remove(); S.labelPool.delete(k); }
      }
    }
  }

  //（demo 新 UI：站点 hover 提示 showStopTip/hideStopTip 退役——界面元素总结口径只留
  //   左侧面板/缩放控件/右上 logo，hover 提示属突兀元素一并移除。）

  // ---------- 面板抽屉收起/展开（demo 新 UI） ----------
  // 收起＝#panel 平移出屏（.collapsed，带 transition 抽屉动画）、亮出左缘窄条 #panelTab
  // （展开把手＋常驻竖排小字底图署名）；右缘收起把手 #panelCollapse（body 级独立元素，
  // 见 index.html CSS 注——面板 overflow:hidden 裁溢出子元素）同步 .stowed 移出。
  // 高亮状态不受收起影响（只动 CSS，不碰 S.focus/分期）。会话内不持久化，刷新回展开。
  function setLinePanelCollapsed(collapsed) {
    // 移动端（2026-11-28）：桌面抽屉把手/展开条已 display:none，本函数正常不可达；防御
    // 转发到 sheet 档（hidden＝收起）。
    if (isMobileViewport()) { applySheetSnap(collapsed ? 'hidden' : 'half'); return; }
    S.panelCollapsed = collapsed;
    $('panel').classList.toggle('collapsed', collapsed);
    $('panelCollapse').classList.toggle('stowed', collapsed);
    $('panelTab').hidden = !collapsed;
    if (collapsed) closeBasemapMenu();   // 2026-11-27：抽屉收起＝底图按钮不可见，清单一并收起（防展开回来残留）
  }

  // ---------- 交互接线（demo 新 UI；二轮 1/2/7/13 改版） ----------
  function wireUI() {
    initViewPositions();   // 2026-11-27 动效：解除降级 [hidden]、四视图上滑轨（data-pos）
    initViewportMode();    // 2026-11-28 移动端：sheet 把手接线＋初始半屏＋跨断点/resize 同步
    // 视图切换：确认→主界面；主界面返回→（搜索态先清搜索回列表，二轮①）→清聚焦分期后回初始
    // 界面（二轮⑬）；线路页返回→main 视图（搜索来源自动恢复搜索态——二轮②，词与结果保留）
    $('btnConfirm').addEventListener('click', () => showView('main'));
    $('btnBackSplash').addEventListener('click', () => {
      // 二轮①：搜索激活时第一下＝清空搜索回列表；再点才走返回链路
      const input = $('searchInput');
      if (S.ui.searching || (input && input.value.trim())) {
        input.value = '';
        renderSearchResults();
        return;
      }
      // 二轮⑬：返回初始界面时清除地图聚焦与分期（循环按钮复位「全部」，不恢复旧分期选择）
      clearFocus();
      S.station = null;   // 车站链防御性收口（btnBackSplash 仅 main 态可见，此时理论已清）
      if (S.phaseCycle !== 'all') resetPhaseSelection();
      showView('splash');
    });
    // 线路页返回（btnLineBack 与 Esc 共用 backFromLinePage）：'station' 来源回车站页
    //（逐级返回链——列表→车站页→线路页逐级返回；车站页上下文 S.station 保留，clearFocus
    // 退出线路聚焦不动相机，高亮回到车站多线）；'line' 来源（站行换乘项跳转进入）回原
    // 线路页——换乘链逐级弹回（linePagePrev 栈：恢复页面内容与原聚焦线，聚焦手动置
    // S.focus 不走 setFocus——其 fitFocusLine 跳相机，违背「返回不动相机」精神，与
    // exitStationPage 的 resume 同款）；其余来源回 main（搜索来源自动恢复搜索态）。
    $('btnLineBack').addEventListener('click', () => { backFromLinePage(); });
    // 车站页返回：按记录来源回视图（exitStationPage），地图高亮同时取消
    $('btnStationBack').addEventListener('click', () => { exitStationPage(); });
    $('btnKml').addEventListener('click', () => {
      if (S.ui.linePageId != null) exportLine(S.ui.linePageId, 'kml');   // 仅 KML，不提供 GeoJSON
    });
    // 三选项卡（市区线/市域线/预控通道）——2026-11-27 动效：①激活细线 #tabIndicator 自旧
    // tab 位移/变宽过渡滑到新 tab（不再瞬跳，同步见 syncTabIndicator）；②列表内容按 tab 序
    // 滑动换页（前进自右入/反向自左入，--swap-dur 240ms 与搜索态同档；换页后滚动回顶属正常）。
    // 方向＝V.tabSwapDir（viewer_core 纯逻辑可单测，序取 HTML 按钮序）。搜索态下 tabs 仍可见
    // 可点：列表照常重建、滑动动画在退场容器内自行播放不碍事；分期态变灰走 buildLineList 既有
    // 逻辑不受影响（1709/1722 两处非 tab 触发的重建不带动画，语义正确）。初始同步 active 类
    // （原实现 HTML 静态无 active、JS 也不挂——初始三 tab 均无激活样式，本次顺带补齐）。
    const tabsBar = $('mainTabs');
    const tabBtns = Array.from(tabsBar.querySelectorAll('button'));
    const TAB_ORDER = tabBtns.map((b) => b.dataset.tab || '市区线');
    // 指示线对齐激活按钮（instant＝首挂瞬时定位，不播过渡）；无激活按钮则不动（保持原位）
    function syncTabIndicator(instant) {
      const ind = $('tabIndicator');
      const btn = tabsBar.querySelector('button.active');
      if (!ind || !btn) return;
      if (instant) ind.classList.add('noanim');
      ind.style.width = btn.offsetWidth + 'px';
      ind.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
      ind.style.opacity = '1';
      if (instant) { void ind.offsetWidth; ind.classList.remove('noanim'); }
    }
    // 列表换页滑动：一次性动画类（重挂前清旧类＋reflow 重启，快速连点不吞动画）
    function slideLineList(dir) {
      const host = $('lineList');
      if (!host || !dir) return;
      host.classList.remove('tab-in-r', 'tab-in-l');
      void host.offsetWidth;
      host.classList.add(dir > 0 ? 'tab-in-r' : 'tab-in-l');
    }
    tabBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const prevTab = S.ui.tab;
        S.ui.tab = btn.dataset.tab || '市区线';
        tabBtns.forEach((b2) => b2.classList.toggle('active', b2 === btn));
        buildLineList();
        if (S.ui.tab !== prevTab) {
          syncTabIndicator();
          slideLineList(V.tabSwapDir(TAB_ORDER, prevTab, S.ui.tab));
        }
      });
    });
    tabBtns.forEach((b2) => b2.classList.toggle('active', (b2.dataset.tab || '市区线') === S.ui.tab));
    syncTabIndicator(true);
    // 循环/清单按钮：显示线路（全部→既有→近期→远期）、站名（显示⇄隐藏）保持循环；
    // 底图按钮 2026-11-27 改版——循环退役，单点展开 #basemapMenu 全部清单（终态序
    // 高德→无字高德→用地→卫星→OSM 共 5 态，DOM 在 index.html 底图格内），再点收起。
    $('btnCyclePhase').addEventListener('click', () => {
      const i = PHASE_CYCLE_ORDER.indexOf(S.phaseCycle);
      applyPhaseCycle(PHASE_CYCLE_ORDER[((i < 0 ? 0 : i) + 1) % PHASE_CYCLE_ORDER.length]);
    });
    $('btnCycleNames').addEventListener('click', toggleNames);
    $('btnCycleBasemap').addEventListener('click', () => {
      if (basemapMenuOpen()) closeBasemapMenu(); else openBasemapMenu();
    });
    // 清单条目：点选直达并收起（setBasemap 内 syncBasemapUI 已同步按钮文案/署名/清单高亮）
    $('basemapMenu').querySelectorAll('button[data-basemap]').forEach((btn) => {
      btn.addEventListener('click', () => { setBasemap(btn.dataset.basemap); closeBasemapMenu(); });
    });
    // 点面板外收起清单（document 级一处；清单内与底图按钮上的点击不在此路径——按钮
    // 自身 click 已处理 toggle，closest 双排除防「点按钮开、冒泡到这里又立即关」）
    document.addEventListener('click', (ev) => {
      if (!basemapMenuOpen()) return;
      const t = ev.target;
      if (t && t.closest && (t.closest('#basemapMenu') || t.closest('#btnCycleBasemap'))) return;
      closeBasemapMenu();
    });
    // 抽屉收起/展开（高亮状态不受收起影响）
    $('panelCollapse').addEventListener('click', () => setLinePanelCollapsed(true));
    $('panelTab').addEventListener('click', () => setLinePanelCollapsed(false));
    //（二轮⑦：玻璃档位定稿 0.45＋blur20——#glassCtl 对比控件与 data-glass 机制已删，
    //   样式固化在 index.html .glass 规则）
    // Esc：车站页→按来源返回（取消高亮）；线路页→backFromLinePage（'station' 回车站页/
    // 'line' 回原线路页/其余回列表并取消高亮）；主界面→退出聚焦（分期不恢复旧选择，停在「全部」）
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (ev.target && (ev.target.tagName === 'INPUT' || ev.target.tagName === 'TEXTAREA')) return;
      if (S.ui.view === 'station') { exitStationPage(); }
      else if (S.ui.view === 'line') { backFromLinePage(); }
      else clearFocus();
    });
    wireSearch();
    syncPhaseUI();     // 与 phaseCycle 初始态（all）对齐：按钮文案「全部」
    syncNamesUI();     // 与 namesOn 初始态（true）对齐：按钮文案「显示」
    syncBasemapUI();
    // 底图初始＝高德（清单 5 态默认落在高德；「无」白板态退役、carto 后备不进清单）
    setBasemap('gaode');
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
    loadDistricts();   // 区界底图（2026-11-27，同省界模式，异步回填不阻塞）
    buildLineList();
    wireUI();
    hideCenter();
    scheduleLabels();
  }

  boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
