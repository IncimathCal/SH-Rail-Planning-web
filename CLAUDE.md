# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态（2026-11-23）

上海轨道交通远期规划图网页：编辑器（editor.html，仅本地、永不部署）＋查看器（index.html，GitHub Pages 从 /docs 发布）。**本文件夹已 git 化（分支 main，无远端）**，用户将发布为 **SH-Rail-Planning-web**。

- 阶段 0 标定 / 1 规范骨架：完成（标定已定案＝手动 TPS，见下）。
- 阶段 2 编辑器：MVP＋多轮加固＋性能治理（画布增量渲染）完成；仓库 `data/lines/` 仍为空。**录入在用户工作区 `C:\Users\18916\Documents\远期图测试` 进行**（2026-11-22 23:55 存盘 82 线 1182 站；只读扫描/校验可以，未经用户明示不得改动）。**查看器预览的数据来自工作区副本**：`python -X utf8 tools/sync_workspace.py --watch`（复制到 `build/workspace/` → flatten 到 `build/net/`，对工作区只读；存盘后约 2 秒自动同步，刷新 http://localhost:8000/index.html 即见）——用户说「看到的是旧数据」时，先核对该监视是否在跑、`build/net` 时间戳是否跟上工作区。**嵌套换乘组已实装（2026-11-23）**：编辑器可「编入上层组」，中华艺术宫／中辰路／上海金山三处由用户自行编。
- 阶段 3 查看器：MVP＋产品化＋显示规则八条改版＋白板字样改版完成，真数据目验中。

**⚠ 开工前必读**：《架构方案-01-Schema与目录与阶段.md》（实施基准 v1.5）＋**《进度状态-02-阶段总览.md》**（当前全量明细：编辑器/查看器逐轮功能与裁定、标定与 .ai 提取始末、踩坑教训、待办占位——CLAUDE.md 2026-11-22 已瘦身，细节以该文档为准）；讨论史《讨论记录-01~04》。过程文档均 gitignore 仅本地。

## 核心技术要点（高频；细节以架构方案与进度状态-02 为准）

- 数据链：`data/`（lines/*.json **fmt/line@2**＋groups.json＋manifest.json）→ `tools/flatten.py` → `net/*.geojson` → 查看器；编辑器 `editor.html`＋`src/editor.js`/`src/geom.js`（逻辑层有 node 单测）。AI 源图仅导出线路 path（`svg_parse.py --import`→`import/*.json`）；设站站名纯手动录入。
- schema v1.5：分段一等实体（`sections[{name,status}]` 铺满全线＋`segments` 整数索引，flatten 拒 @1）；组类型 same-station / out-of-station / junction（接轨站，描边取成员线角色优先级色 main＞standalone＞branch＞connector）；`stop.kind`: block（线路所，网页隐藏）/ arrow（出省箭头，网页显示）；联络线结构字段 `connects`（≥2 线 id）；设站编号水位 `meta.stopSeq` 防复用；线路分类 `meta.layer`（源图子图层名，中文合法：市域线/市区线/联络线/预控通道/他省…）。
- **嵌套换乘组（2026-11-23 用户确认）**：stationGroups 加可选 `groups: [子组 id]`（为空不写出；一组至多一个父组、无环；一站至多是一个组的直属成员）；外层组类型＝其直属站与子组整体的关系；画法由**最外层关系**决定（外层同站＝整个节点一个符号、内层不出图形；外层出闸＝直属站各自黑边圈、子组照常）。**带子组的上级组（同站／接轨单元）不论线数一律药丸**（2026-11-23 用户裁定；编辑器 `unitIsPill`）。**药丸线数按逻辑线计：同一线组的主线与支线算一条、联络线不算**（适用于全部同站单元；须有 main 的线组才算一条，编辑器 `logicalLineCount` 与查看器 `buildLineGroups` 同口径）。**shape:"pill"（2026-11-23 用户确认）**：stationGroups 可选字段，同站组显式强制画药丸不论线数（平行线双线站大圆悬浮对策）；仅 same-station 可写（validate 禁其他类型）；flatten 结构表写了才透传（fmt 不升版）；编辑器组行「自动／药丸」下拉＋组列表「两站分离」筛选（双线同站、两站心经标定相距 >50m 的候选清单，行内 Δ 米数；纯逻辑 `isSplitGroup`/`groupSplitMeters`/`haversineM` 可单测）。index.json 为 `net-index@3`（加 `stationGroups` 结构表；查看器收 @1/@2/@3）。编辑器：组列表顶层组行「编入上层组」／Shift＋点换乘符号＝整组待编入；上级组不足 2 个单位时级联拆组。联络线一律不带 `color` 落盘。
- **线路介绍 lineinfo.md（2026-11-23）**：数据目录 `lineinfo.md`（用户手填，每条线路一节）→ flatten 原样透传 → 查看器聚焦框/站点面板追加信息节（`parseLineInfo` 解析，全转义＋URL 白名单）。**节标题 `## <id> <名>` 绑定「线组 id 或线 id」**（2026-11-23 放宽）：建了组的线绑组 id，没建组的单线绑该线自身 id——没建任何线组时编辑器列表也不能是空的。编辑器「线路介绍」面板列表＝全部线路（组一行＋未入组线各一行，纯逻辑 `lineInfoTargets` 可单测）；查看器兜底查找＝`lineInfoEntryOf`（先按所属线组 id 查节、查不到落线自身 id，一条线至多一节、组节优先）；编辑侧保真替换 `replaceLineInfoSection`（只动被编辑节、其余字节原样）。
- 查看器类别裁定：**联络线不出列表**（地图照画、搜索照收）；**他省线仅显示级**（不可聚焦、恒调光、点选无面板）。
- 打磨期显示与外观（用户裁定 2026-11-23）：底图白色遮罩**按底图态分档**——OSM/高德常态 **60%**（聚焦态 40%——双层罩叠底图会看不清），carto 态常态 **35%**（聚焦 30%，Positron 本就浅 60% 下只剩水系轮廓；viewer `VEIL_OPACITY`/`VEIL_OPACITY_FOCUS` 为按态查表）；**预控通道画虚线**（dash[2,2] 等长、圆头、颜色不变、60% 基线、调光叠乘；`meta.layer=="预控通道"`，viewer `DASHED_LAYERS`/`CORRIDOR_DASHARRAY`；line-dashoffset maplibre 不支持，起点相位从 dash 边界起始）。**底图源定 CARTO Positron 无字**（免费 key 已申请、硬编码 viewer.js，打磨完成后提醒用户在 CARTO dashboard 加 referer 限制；过渡期白板/OSM/高德带字与新态并存循环；**打磨最后阶段移除白板/OSM/高德并删除切换按钮，届时网站必有底图**；CARTO 态图例卡有条款硬性署名「© OpenStreetMap contributors © CARTO」，与省界署名不写不同，勿删）；**经纬网只做视口边缘读数标注（四边刻度尺），不做网格线**（用户裁定「只要视口边缘读数」，勿扩回网格方案）。
- 查看器站名门槛：换乘组及出闸换乘站标签 z≥10 渐显，普通单线站标签 z≥11 渐显；聚焦例外保持常显；**不设标签总数上限**（2026-11-22 删初版自设的 LABEL_CAP=800——它数整份数据而非同屏数，用户真数据一超 800 个标签单元，单线站名就在一切缩放级别全灭，被用户抓包「单线站名不见了」）；同屏数量只由视口裁剪约束。教训：**自设的保险丝/数量阈值必须拿真数据规模过一遍；它与用户规则冲突时删保险丝，不动用户规则**。
- 编辑器画布＝**增量渲染**（2026-11-22 性能治理）：每线 `<g>` 跨渲染持久，`lineStale` 逐字段比对「画法输入」决定是否重建；当前线／选中站／待编组是瞬态，只原地切 class、挪选中环；缩放只原地改屏幕恒定尺寸。**给线路绘制新增数据依赖时，必须同步补进 `lineStale`（或换乘组单元 `groupUnitSig`、逐站 `stopGroupKey`、`syncHints` 判据）的比对项**，否则改了数据画布不更新。
- 编辑器「归档」的线：文件留在 `lines/`（`meta.archived: true`）、须列入 `manifest.archived`、不进 `manifest.lines`；validate 对账只比未归档线，flatten/publish 剔除。**取消归档时必须从 `manifest.archived` 摘除**（纯逻辑 `archivedIdList`；2026-11-22 抓包：取消归档后仍留在表里 → validate 报错、flatten 把这条线整条剔除、查看器不见；flatten 现对归档表与线文件矛盾按未归档输出并警告，不静默丢线）。
- 标定：现行 `data/calibration.json`＝手动 TPS λ=1e5、38 控点（2026-11-21 用户验收定案，勿重拟合）；回滚＝calibration-autotps-backup.json / calibration-deg3-backup.json（编辑器「标定」按钮）/ git 历史。.ai 全量提取＝`tools/ai_parse.py`→`import/远期图-全量.json`（84 线，命名裁定见进度状态-02）。
- **MapLibre 血泪教训（改样式前必看）**：运行时错误默认不上控制台——层级校验失败是「弃层不弃 style」（filter `'!'` 吃 0/1 数字曾致站圈全没，**filter 一律显式 `['==',['get','x'],0/1]`**）；`line-cap`/`line-join` 是 layout 属性，放 paint 拒载整个 style 全黑；zoom 插值 stops 保持全常量、档位差异拆层做（数据驱动×zoom 复合真机不连续求值）；无头浏览器验证**交互手感**不可靠，排查走真实浏览器控制台；但**截图与跑通逻辑可用**——此前「连 load 周期都不完成」出现在 `--virtual-time-budget` 虚拟时间下，改实时运行＋挂起请求推迟 load 事件即正常：`chrome --headless=new --user-data-dir=<临时目录> --window-size=1600,900 --dump-dom <url>`（探针页＝真实 index.html＋只读脚本：截获 `maplibregl.Map.prototype.on` 取 map 实例、`jumpTo` 逐级采样数 `.map-label`，探针跑完再放行 load 后 dump；2026-11-22 靠它前后对照定位 LABEL_CAP）。无头下 rAF 是合成 60Hz 节拍（时间戳与回调实际间隔都恒 16.66ms），**帧开销量不出来**，勿据此下性能结论。**例外——编辑器纯 SVG/DOM 层**可用本机 Chrome 无头（`chrome --headless=new --disable-gpu --user-data-dir=<临时目录> --dump-dom <file://页面>`，勿用用户默认 profile）做实测：JS＋强制样式/布局可同步量；逐帧整帧量测要 rAF 循环＋挂起连接推迟 load 事件；改动渲染前后用**差分验证**（旧实现为标准答案，同一数据同一操作序列逐步比对）＋随机操作模糊测试。帧间隔按 16.7ms 量化、软件渲染，数值只作相对比较（做法见进度状态-02「画布增量渲染」节）。

- **编辑器整页冒烟的可复用做法**（2026-11-23 嵌套组合入时一次跑通；脚本在 `零散/编辑器冒烟-嵌套组/`）：临时站点副本（跟踪文件＋`build/workspace` 的数据拷进 `data/`）＋自写静态服务（目录给 json 清单；`/__hold` 挂起到探针放行，推迟 load 事件）＋**只在副本** `editor.js` 末尾挂 `global.__ed` 调试钩子（源码是 IIFE，内部函数外部取不到）＋合成 `pointerdown/pointerup` 驱动画布点击（按下的目标即 `downHit`，不需要真实命中）→ 结果写 `<pre id="probeOut">` 后 `--dump-dom` 取回。查看器同理（探针插在 viewer_core.js 与 viewer.js 之间截获 `Map.prototype.on`）。
- **工作方式（2026-11-23 用户定案）：主窗口零写码——一切代码修改一律派 worker，不论大小**。主窗口只做：澄清需求 → 派发任务书（能并行则并行）→ 验收交付报告 → 合入 → 全量测试 → commit → 更新文档。例外线划死：只有**不读源码就能定位**的一次性小改（改一句文档、跑一条命令）主窗口直接做，凡需读码定位的一律派（防滑坡回亲自改码）。worker 隔离一律 **git worktree**（Agent `isolation: "worktree"`，替代旧手工私人副本 `git ls-files | cp --parents` 做法；本仓库无远端，基线注意取 HEAD 而非 origin/main），主窗口对 diff 验收后合入、worktree 即弃——正式工作树全程不被 worker 碰（用户用着 8000 线上服务也安全）。worker 交付报告固定四项：**改动文件／实现说明／测试结果／未决事项**。任务书轻量化：派发提示写清目标／可改范围／验收标准／先读哪节文档几行即可，不建正式计划文档；worker 的共享记忆＝CLAUDE.md＋进度状态-02，让 worker 自己读，主窗口不转述背景。互相依赖的板块（如 flatten 与查看器的 index fmt）必须同批合入。

## 常用命令

```bash
python tools/validate.py data                      # 数据校验（提交前必跑）
python tools/validate.py tools/fixtures/sample     # 对样例数据跑校验
python -X utf8 tools/ai_parse.py "源资产/远期.ai" --out "import/远期图-全量.json" --verify "源资产/6、14、15、23号线.svg" --calib "6,14,15,23" --svg-out "源资产/远期图-标定4线.svg" --line-note "4=与 3 号线共线，仅画不重复段" --line-note "苏淀沪线=即示范区线支线；原生对象名误作「苏淀沪连接线」（2026-11-21 用户裁定，与联络线层的苏淀沪连接线为两条不同的线）"   # .ai 全量提取线路（对拍+平移版标定 SVG；每条 path 含 layer＝源图 Line 直属子图层名；依赖 PyMuPDF）
python tools/svg_parse.py "源资产/xxx.svg" --import # 产出 import/xxx.json 供编辑器载入
python -X utf8 tools/station_extract.py --layers 零散/ai_layer_paths.json --import import/远期图-全量.json --out import/站圆预置-草稿.json --ai 源资产/远期.ai   # 站圆预置再生成（单线站圆＋Trans 层换乘标：24×24 大圆=双线、药丸=多线，中心跨线投影并入各线 stops 带 transfer 标记，transfers 全表供人工编组参考；含站名建议；schema stations-import@2）
python -X utf8 tools/calib_manual_pick.py           # 手动标定选点（30+10 候选＋叠加图＋CSV 回填模板；重跑幂等）
python tools/georef.py "源资产/xxx.svg" "源资产/xxx.kmz"   # 标定试验（残差报告）
python tools/georef.py "源资产/xxx.svg" "源资产/xxx.kmz" --emit   # 并重拟合导出 data/calibration.json
node tools/test_geom.js                            # geom.js 与 svg_parse.py 对拍
node tools/test_editor_logic.js                    # 编辑器纯逻辑单测
node tools/test_calib.js                           # 标定 JS/Python 对拍（TPS 正反向）
python -X utf8 tools/calib2_fit.py                 # 自动 TPS 标定重拟合（旧通道，控点在 零散/ 本地件；--lambda/--dry）
python -X utf8 tools/calib_manual_fit.py           # 手动标定重拟合（GE 标注控点 CSV；LOO 选型；--dry 试算）
python -X utf8 tools/ge_convert.py to-ge import/远期图-全量.json --out 检视.kmz   # 图→GE：线路导出 KMZ 目视核对（--layer 子串过滤）
python -X utf8 tools/ge_convert.py from-ge 源资产/xxx.kmz --out 点位.csv          # GE→图：地标经纬度反变换为画板 x,y
python -X utf8 tools/flatten.py --data data --out build/net            # 录入成果→GeoJSON（查看器数据源；正式发布由 publish.py 代跑）
python -X utf8 tools/sync_workspace.py --watch --validate   # 工作区→build/workspace 副本→build/net，持续监视、存盘后自动同步（查看器预览数据源；对工作区只读；不带 --watch 为一次性；--validate 顺带跑校验并打印结论）
python -X utf8 tools/flatten.py --data "C:/Users/18916/Documents/远期图测试" --out build/net   # 把用户当前工作区载入查看器预览（查看器 net/ 不存在时回退 build/net；工作区无 calibration.json 时自动取 data/calibration.json；归档线剔除）
python -X utf8 tools/publish.py                                        # 发布快照：校验→flatten→白名单拷贝 docs/（冒烟：--data tools/fixtures/sample --out build/docs-test）
node tools/test_viewer_logic.js                                        # 查看器纯逻辑单测
python -X utf8 tools/serve.py                       # 本地开发服务（仓库根静态＋POST /api/ai-parse 代解析 .ai），开 http://localhost:8000/editor.html；替代 python -m http.server——8000 被旧服务占用时拒启（先停旧服务，或 --port 显式换口）
```

## 硬性约束（用户明令，优先级最高）

- **地铁相关数据（线型、设站、站名、状态、关系等）一律由用户提供，不得引用任何外部数据源**——OSM、维基、第三方线路数据库一律禁止。
- 设站与站名**纯手动**录入，不自动读取 AI 源图中的圆与文本。
- 编辑器仅供本地使用，永不部署到 GitHub Pages。
- 换乘编组**绝不按站名自动合并**。
- **不得擅自给数据起名**（2026-11-21 用户明令）：自动化产物一律用中性编号（如 path-NN）；自动匹配出的文字（hintNames 等）只能以「建议」形式展示、人工点选采用，绝不直接写入 name 等字段。用户在源图中已有的命名（图层链/路径对象名）可原样转写入 sourceLayer，不算擅自命名；作者未命名的对象保持 path-NN。
- **数据文件的结构字段与枚举值全英文**（existing/approved/future、main/branch/connector/standalone 等），中文仅限 name/aliases/info 值等文本内容（含源图命名原样转写字段 sourceLayer 与 meta.layer——validate 的 CJK 豁免名单已含）；全部文件 UTF-8 无 BOM（编码顾虑，用户明令）。
- **不主动做性能检查/量测/调优**（2026-11-22 用户明令「不要浪费大量时间在检查性能上，我感觉性能不好自己会说的」）：用户报了卡顿再查，手感以用户真机为准。
- **简单请求先做完、先汇报**（2026-11-22 教训：「导入个数据」被拖 23 分钟、占 82% 上下文）：同一消息里的简单事项（导入/重跑/看一眼）几分钟内做完并**立即告知**，再处理其余；顺带发现的 bug 先报备、用户点头再修；设计题的大规模读码单独起一轮或发 worker。
- 遵循 Gall's Law 增量演进：每阶段出口必须是"能用的简单系统"。
- **过程文档不入库**（2026-11-21 用户指示）：讨论记录-\*、进度状态-\*、标定试验-\*、源资产分析-\* 一律 gitignore 仅本地保留；入库的仅关键文档（CLAUDE.md、架构方案-\*、README）与代码/数据/工具。

## 约定（继承自上级工作区）

- 全中文工作：文件命名、注释、文档、与用户交流均用中文；**不重命名中文文件夹/文件**。
- Windows 11 + Git Bash：shell 中一律用正斜杠并给含中文的路径加引号，如 `"E:/10.项目/261120远期图网页/..."`。
- 不假设 Python 第三方包已安装；如需脚本处理数据，先检查依赖。
