# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态（2026-11-20 阶段 0+1 完成，阶段 2 进行中）

**本文件夹已 git 化（分支 main，无远端）**，用户将以 GitHub 客户端发布为 **SH-Rail-Planning-web**。进度：

- 阶段 1（规范与骨架）完成：目录结构、`tools/validate.py`、`tools/fixtures/sample` 样例数据；
- 阶段 0（标定试验）完成：4 条线（6/14/15/23）SVG+KML 标定通过，单线横向 RMS 15~41 m、全局 80 m，见《标定试验-01-残差报告.md》（验收线建议已提请用户确认）；
- **阶段 2（编辑器 MVP + 首批录入）进行中**：编辑器 MVP 已建成——`editor.html` + `src/geom.js`（与 Python 版对拍一致）+ `src/editor.js`（纯逻辑层有 node 单测），支持载入导入记录/数据、点选加站记弧长 t（点击/吸附半径 40px）、**t 值可手改**（侧栏 6 位小数输入框，破坏递增即时标红）、拖动、改名、删站、**批量命名**（先点完全线设站再一次贴名，与逐站命名并存）、**分段状态按站区间设定**（2026-11-21 用户要求改版：左栏「设站」面板从站→到站→状态一键应用，纯函数 applySegRange/segRangeSummary 有单测，环线支持 a>b 跨环绕段；**画布点段不再循环切状态**＝仅选中线路，旧交互已撤）、换乘编组（**拉框直接建组**免确认，框内 ≥2 站即建、已在其他组的跳过；点选站圈攒待编组后点「编组」仍可用；就近提示仅视觉；同站组画合并黑边大圈——位置取距所有成员线最近点、出闸组站圈描黑边，**passage 已取消**）、线组管理、JSON 下载保存、localStorage 暂存、撤销、画布平移（选择/加站模式左键空白或线路上拖动、任何模式中键拖动；编组模式左键留给拉框）；经 http 服务打开时启动自动拉取 `data/` 与 `import/` 目录（file:// 打开则手动载入）；「底图 OSM」开关垫 OSM 瓦片（需 `data/calibration.json` 即 `georef.py --emit` 产物 + 网络，仅本地参考）。2026-11-21 编辑器探索期五连改（schema v1.4 同步）：**设站 t 域 [0,1] 双闭**（开线终点站可精确落 1；环线 t=1≡t=0 勿重复设站）；**线路分类 `meta.layer`**（＝源图 Line 直属子图层名，建线自动继承 import path 的 `layer` 字段、属性面板可改、线路列表分组；词汇：市域线32/市区线30/联络线9/预控通道8/他省5）；**换乘节点组新增 junction（接轨站）**（支线/联络线用：并圆普通尺寸无黑边、描边取成员线角色优先级色 main＞standalone＞branch＞connector）；**线路所 `stop.kind:"block"`**（中途接轨点：虚线圆仅编辑器可见、正式网页隐藏不可点、站名可空、批量命名/建议名跳过、只与线路所编 junction 组——混选拒绝）；「采用全部建议名」一键贴空名站；未建线虚线提亮（灰 #666→#999；halo 垫底方案试后用户否决回退）＋加宽命中线＋选中态高亮；顶栏「重置」清暂存与编号水位。**当前节奏：用户先摸索完善编辑器，之后「新建空工作区」清零再大规模录入**（首批 4 条线要求含环线/支线/共线/联络线各一例）。**编辑器盲区加固完成（2026-11-21，六项）**：载入 line/groups 先快照＋同 id 覆盖 confirm（误选旧文件可撤销）；暂存/水位失败红字告警＋beforeunload 仅在存储已坏时拦截；「保存全部」＝线路+groups+manifest 成套下载（150ms 间隔＋进度对账——水位恢复依赖 manifest）；改名逐键仅更新站圈 title、属性面板 rAF 合帧按需重绘、拖站期间局部挪圆松手全量；OSM 瓦片 onerror 重试一次；编组模式按住站圈拖动＝平移（防误切待编组）；顶栏撤销按钮接线（此前是死按钮）。**载入导出重组（2026-11-21 晚，载入/保存七按钮→三按钮＋工作区概念）**：①「载入／新建工作区」——工作区文件夹与 data/ 同构（lines/*.json＋groups.json＋manifest.json），复制进 data/ 即提交，也可直接打开 data/ 本体保存即落盘；File System Access 目录直读写（Chrome/Edge），降级 webkitdirectory 只读＋保存走多文件下载；载入＝整体替换（一次快照可撤销；工作区缺 groups.json 时旧组清空防悬挂引用）；「新建空工作区」＝原「重置」（清暂存＋编号水位＋刷新）。②「导入线路」三合一：.ai→`tools/serve.py` 的 POST /api/ai-parse 代解析（浏览器解不了 zstd 压缩＋7 GB 解压流；serve.py subprocess 调 ai_parse 零改动复用，105 MB 尾部缓存命中时全流程约 104 s——真图 1.86 GB 上传占大头，编辑器流式上传不进内存）；.json（导入记录/站圆预置/数据）与 .svg 走原逻辑。③「保存工作区」成套直写：只碰 lines/＋groups.json＋manifest.json 三类自家产物（calibration 等一概不动），工作区里多余 lNNNN.json 删除并列出，直写失败自动降级多文件下载；「保存当前线」单线保存已砍（用户裁定）。

**阶段 3 查看器 MVP 骨架＋产品化一轮完成（2026-11-21 晚，待真数据目验）**：`index.html`＋`src/viewer_core.js`（纯逻辑，node 单测 `tools/test_viewer_logic.js`）＋`src/viewer.js`（MapLibre 渲染：无底图深色画布、segStatus 三档透明、搜索/线路多选高亮/信息面板/单线 GeoJSON·KML 导出；中文标签走 HTML 叠加——字形 PBF 未建时的备案路线，`make_glyphs.py` 待建）；MapLibre 5.24.1 vendored 于 `assets/vendor/`；`tools/flatten.py`（data/→`net/*.geojson`：复用 svg_parse 折线与 ge_convert TPS 正变换，block 站剔除、归档线剔除、`stops[].geo` 权威覆盖；junction 组描边取成员线角色优先级色与编辑器一致）、`tools/publish.py`（校验→flatten→白名单拷贝 docs/，编辑器永不部署红线自检）。**产品化一轮（2026-11-21 晚）**：加载/空/错三态中文指引（数据路径 `net`→`build/net` 相对回退——仓库根 serve.py 预览与 docs/ Pages 部署两开法都通，file:// 直开有专属提示）；左下状态图例卡（三档线样透明随「突出既有」联动；**远期虚线**——line-dasharray 不支持数据驱动故按 segStatus 拆三层，绘制序 future→approved→existing 既有压顶）；站点 hover 提示＋点选面板（所属线路含又称、出闸组列出组内其余车站、未名站占位、零站线起讫修复）；meta/favicon 全内联零外部资源。**底图选型定案：高德（2026-11-21 用户裁定）——属编辑器侧**（用户纠正：查看器不放底图，维持无底图深色画布、零外部资源；编辑器「底图」开关循环保留 OSM＋新增高德档，GCJ02 逐瓦片偏移对齐，实装随分段 v1.5 批次提交）。发布链冒烟 fixtures 全通过（快照 9 文件、编辑器红线无告警）。原底图调研建议序存档：天地图 CGCS2000≈WGS84 零偏移需免费 key ＞ 高德 GCJ02 免 key ＞ 百度三级坐标链＋自墨卡托成本最高。

实施基准见 **《架构方案-01-Schema与目录与阶段.md》**（v1.4），讨论历史见《讨论记录-01~03》，进度快照见《进度状态-01-阶段总览.md》。

支线任务（2026-11-21 完成）：`源资产/远期.ai` 提取评估 + **A 类自动化已实装**——`tools/ai_parse.py` 从 .ai 一次导出全量线路（`import/远期图-全量.json`：84 条线路（74 描边＋10 **渐变网格线体** `render:"mesh"`），**原生权威化重导（2026-11-21，经用户验收纠错后的二版）**——sourceLayer＝用户源图命名 74 条（对象名/层链）/作者未命名保持 path-NN 10 条；隐藏层与隐藏对象零流入（通过不设站×3、相交关系×2、Station/临港1、Station/8B浦江线，及南汇市区线/8B浦江线/嘉松线太仓段等对象——隐藏标志可挂在外层包裹组 `1 Xw`）；**27 号线作者画了两份已去重**；闭合路径补 Z（仅 26 号线闭合）；预控通道 8 条 `category:reserved`、他省 5 条 `interprovincial`；hintNames＝站圆组证据建议、编辑器点选采用。**path-50/75 实为 27 号线两份而非 4号线**；26 号线＝path-51 唯一闭合环。**4号线＝市区线层名为"4"的渐变网格对象**（PDF 渲染为带状轮廓＋着色、无 S 描边，只取描边必漏；note 注明「与 3 号线共线，仅画不重复段」）；**南汇线＝主线（网格）`市域线/南汇线#1`＋支线 `#2`**（层内对象名"机场联络线"系复制残留，以层名为准）；**苏淀沪线与苏淀沪连接线是两条不同的线（2026-11-21 用户裁定）**——苏淀沪线＝市域线层长线（即示范区线支线，Station/苏淀沪线 3 圆 千灯/石浦/赵屯 全落线；原生对象名误作「苏淀沪连接线」，`ai_parse.py` USER_RENAMES 已改），苏淀沪连接线＝联络线层短线（石浦→示范区线#5 淀山湖段西端）；联络线层另有 7 条渐变连接线（漕泾联络线、上海金山联络线＋5 条作者未命名 path-76~80，经用户裁定保留）。解析器 `tools/ai_native.py` 关键坑：`%_` 前缀只有 2 字节（切片必须 `s[2:]`，用 `s[3:]` 会吃掉几何首字符使坐标飞出数千 pt）、`%_N` 空行须触发 flush、对象名挂在组级 XMLUID 与 `%_` 私有副本上而非 S 描边、层头 XMLUID 属于层——细节与勘误表见《源资产分析-02》。**教训：原生解析器对组/网格/复合对象的结论，必须以 PDF 侧几何或用户目视交叉验证后才能定论**）。**坐标基准已切换为 .ai 页面基准（12000×12000、SVG 朝向）**：旧框选导出基准与之为等比 1:1 平移 (+4684.9, +4040.53)；`data/calibration.json` 已在新基准重拟合（全局 deg3 RMS 80.0 m，与旧基准一字不差；**仅市中心 4 线拟合，郊区外推漂移已证实——曾试自动 TPS（4006 控点、自身全集 RMS 133 m，但用户目视验收西/西南偏差仍大：在手标 38 点上 RMS 824 m）→ 2026-11-21 手动标定定案（**用户目视验收通过：西部 1~2 km 修正生效，全图地理坐标映射就此定案**）**：用户 Google Earth 按 W5 的 30＋10 编号候选点标注（`源资产/手动标定.kmz`，02/B3 涉规划道路未标，回填 `data/manual-control-points.csv`），`tools/calib_manual_fit.py` LOO 选型（deg1/2/3＋TPS-λ 网格）→ **现行 `data/calibration.json`＝手动 TPS λ=1e5、38 控点、LOO RMS 108 m/max 318 m**（内圈 3 点与旧 deg3 互证 21~190 m；旧 deg3 外推外围崩至 RMS 3.1 km/max 7.1 km，印证全图控点必要性）。回滚三通道：`data/calibration-autotps-backup.json`（自动 TPS）/`data/calibration-deg3-backup.json`（编辑器「标定」按钮一键切回）/git 历史**）；旧 `import/6、14、15、23号线.json` 已挪 `零散/` 防混基准（几何对拍用其样张副本 `tools/fixtures/import4.json`）。标定 SVG 必须用「旧子段 path 平移」生成（.ai 全线含远期延伸，直接标定会劣化到 8 km 级）。坑与细节见《源资产分析-01-远期ai提取评估.md》§4（ICC CMYK 借色、隐式重复参数组、f 装饰剔除、24pt 线路名标签绑定）与《源资产分析-02-原生命名与可见性.md》。B 类站圆已用于**站圆预置**（`tools/station_extract.py` → `import/站圆预置-草稿.json`：50 组 497 站带 t 与站名建议，编辑器「从预置导入车站」批量落站、建议名点选采用、绝不自动建换乘组；站名匹配试做覆盖 97.6% 待用户验收）；`零散/` 两个 KMZ（上海全部建设规划、深化线网优化方案）与 .ai 是**不同版本规划**——只能作既有/批复段真值。

技术要点：MapLibre GL 地理化渲染；AI 源图仅导出线路 path（`svg_parse.py --import` 产出 `import/*.json` 即 fmt/import@1），设站站名纯手动录入（编辑器仅本地，入口 editor.html）；数据模块化（线路/设站/换乘节点组 + 线组绑定）；分段状态 `existing/approved/future`；标定头尾失准以 (ds,de) 弧长偏差建模校正；设站编号水位 `meta.stopSeq` 防复用；GitHub Pages 从 `/docs` 部署（publish.py 生成）。

## 常用命令

```bash
python tools/validate.py data                      # 数据校验（提交前必跑）
python tools/validate.py tools/fixtures/sample     # 对样例数据跑校验
python -X utf8 tools/ai_parse.py "源资产/远期.ai" --out "import/远期图-全量.json" --verify "源资产/6、14、15、23号线.svg" --calib "6,14,15,23" --svg-out "源资产/远期图-标定4线.svg" --line-note "4=与 3 号线共线，仅画不重复段" --line-note "苏淀沪线=即示范区线支线；原生对象名误作「苏淀沪连接线」（2026-11-21 用户裁定，与联络线层的苏淀沪连接线为两条不同的线）"   # .ai 全量提取线路（对拍+平移版标定 SVG；每条 path 含 layer＝源图 Line 直属子图层名；依赖 PyMuPDF）
python tools/svg_parse.py "源资产/xxx.svg" --import # 产出 import/xxx.json 供编辑器载入
python -X utf8 tools/station_extract.py --layers 零散/ai_layer_paths.json --import import/远期图-全量.json --out import/站圆预置-草稿.json --ai 源资产/远期.ai   # 站圆预置再生成（含站名建议）
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
- **数据文件的结构字段与枚举值全英文**（existing/approved/future、main/branch/connector/standalone 等），中文仅限 name/aliases/info 值等文本内容；全部文件 UTF-8 无 BOM（编码顾虑，用户明令）。
- 遵循 Gall's Law 增量演进：每阶段出口必须是"能用的简单系统"。
- **过程文档不入库**（2026-11-21 用户指示）：讨论记录-\*、进度状态-\*、标定试验-\*、源资产分析-\* 一律 gitignore 仅本地保留；入库的仅关键文档（CLAUDE.md、架构方案-\*、README）与代码/数据/工具。

## 约定（继承自上级工作区）

- 全中文工作：文件命名、注释、文档、与用户交流均用中文；**不重命名中文文件夹/文件**。
- Windows 11 + Git Bash：shell 中一律用正斜杠并给含中文的路径加引号，如 `"E:/10.项目/261120远期图网页/..."`。
- 不假设 Python 第三方包已安装；如需脚本处理数据，先检查依赖。
