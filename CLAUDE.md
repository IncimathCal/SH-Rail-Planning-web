# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态（2026-11-20 阶段 0+1 完成，阶段 2 进行中）

**本文件夹已 git 化（分支 main，无远端）**，用户将以 GitHub 客户端发布为 **SH-Rail-Planning-web**。进度：

- 阶段 1（规范与骨架）完成：目录结构、`tools/validate.py`、`tools/fixtures/sample` 样例数据；
- 阶段 0（标定试验）完成：4 条线（6/14/15/23）SVG+KML 标定通过，单线横向 RMS 15~41 m、全局 80 m，见《标定试验-01-残差报告.md》（验收线建议已提请用户确认）；
- **阶段 2（编辑器 MVP + 首批录入）进行中**：编辑器 MVP 已建成——`editor.html` + `src/geom.js`（与 Python 版对拍一致）+ `src/editor.js`（纯逻辑层有 node 单测），支持载入导入记录/数据、点选加站记弧长 t（点击/吸附半径 40px）、**t 值可手改**（侧栏 6 位小数输入框，破坏递增即时标红）、拖动、改名、删站、**批量命名**（先点完全线设站再一次贴名，与逐站命名并存）、分段状态循环、换乘编组（**拉框直接建组**免确认，框内 ≥2 站即建、已在其他组的跳过；点选站圈攒待编组后点「编组」仍可用；就近提示仅视觉；同站组画合并黑边大圈——位置取距所有成员线最近点、出闸组站圈描黑边，**passage 已取消**）、线组管理、JSON 下载保存、localStorage 暂存、撤销、画布平移（选择/加站模式左键空白或线路上拖动、任何模式中键拖动；编组模式左键留给拉框）；经 http 服务打开时启动自动拉取 `data/` 与 `import/` 目录（file:// 打开则手动载入）；「底图 OSM」开关垫 OSM 瓦片（需 `data/calibration.json` 即 `georef.py --emit` 产物 + 网络，仅本地参考）。**待用户用编辑器录入首批 4 条线**（要求含环线/支线/共线/联络线各一例）。

实施基准见 **《架构方案-01-Schema与目录与阶段.md》**（v1.3），讨论历史见《讨论记录-01~03》，进度快照见《进度状态-01-阶段总览.md》。

支线任务（2026-11-21 完成）：`源资产/远期.ai` 提取评估 + **A 类自动化已实装**——`tools/ai_parse.py` 从 .ai 一次导出全量线路（`import/远期图-全量.json`：84 条线路（74 描边＋10 **渐变网格线体** `render:"mesh"`），**原生权威化重导（2026-11-21，经用户验收纠错后的二版）**——sourceLayer＝用户源图命名 74 条（对象名/层链）/作者未命名保持 path-NN 10 条；隐藏层与隐藏对象零流入（通过不设站×3、相交关系×2、Station/临港1、Station/8B浦江线，及南汇市区线/8B浦江线/嘉松线太仓段等对象——隐藏标志可挂在外层包裹组 `1 Xw`）；**27 号线作者画了两份已去重**；闭合路径补 Z（仅 26 号线闭合）；预控通道 8 条 `category:reserved`、他省 5 条 `interprovincial`；hintNames＝站圆组证据建议、编辑器点选采用。**path-50/75 实为 27 号线两份而非 4号线**；26 号线＝path-51 唯一闭合环。**4号线＝市区线层名为"4"的渐变网格对象**（PDF 渲染为带状轮廓＋着色、无 S 描边，只取描边必漏；note 注明「与 3 号线共线，仅画不重复段」）；**南汇线＝主线（网格）`市域线/南汇线#1`＋支线 `#2`**（层内对象名"机场联络线"系复制残留，以层名为准）；**苏淀沪线与苏淀沪连接线是两条不同的线（2026-11-21 用户裁定）**——苏淀沪线＝市域线层长线（即示范区线支线，Station/苏淀沪线 3 圆 千灯/石浦/赵屯 全落线；原生对象名误作「苏淀沪连接线」，`ai_parse.py` USER_RENAMES 已改），苏淀沪连接线＝联络线层短线（石浦→示范区线#5 淀山湖段西端）；联络线层另有 7 条渐变连接线（漕泾联络线、上海金山联络线＋5 条作者未命名 path-76~80，经用户裁定保留）。解析器 `tools/ai_native.py` 关键坑：`%_` 前缀只有 2 字节（切片必须 `s[2:]`，用 `s[3:]` 会吃掉几何首字符使坐标飞出数千 pt）、`%_N` 空行须触发 flush、对象名挂在组级 XMLUID 与 `%_` 私有副本上而非 S 描边、层头 XMLUID 属于层——细节与勘误表见《源资产分析-02》。**教训：原生解析器对组/网格/复合对象的结论，必须以 PDF 侧几何或用户目视交叉验证后才能定论**）。**坐标基准已切换为 .ai 页面基准（12000×12000、SVG 朝向）**：旧框选导出基准与之为等比 1:1 平移 (+4684.9, +4040.53)；`data/calibration.json` 已在新基准重拟合（全局 deg3 RMS 80.0 m，与旧基准一字不差；**仅市中心 4 线拟合，郊区外推漂移已证实——曾试自动 TPS（4006 控点、自身全集 RMS 133 m，但用户目视验收西/西南偏差仍大：在手标 38 点上 RMS 824 m）→ 2026-11-21 手动标定定案（**用户目视验收通过：西部 1~2 km 修正生效，全图地理坐标映射就此定案**）**：用户 Google Earth 按 W5 的 30＋10 编号候选点标注（`源资产/手动标定.kmz`，02/B3 涉规划道路未标，回填 `data/manual-control-points.csv`），`tools/calib_manual_fit.py` LOO 选型（deg1/2/3＋TPS-λ 网格）→ **现行 `data/calibration.json`＝手动 TPS λ=1e5、38 控点、LOO RMS 108 m/max 318 m**（内圈 3 点与旧 deg3 互证 21~190 m；旧 deg3 外推外围崩至 RMS 3.1 km/max 7.1 km，印证全图控点必要性）。回滚三通道：`data/calibration-autotps-backup.json`（自动 TPS）/`data/calibration-deg3-backup.json`（编辑器「标定」按钮一键切回）/git 历史**）；旧 `import/6、14、15、23号线.json` 已挪 `零散/` 防混基准（几何对拍用其样张副本 `tools/fixtures/import4.json`）。标定 SVG 必须用「旧子段 path 平移」生成（.ai 全线含远期延伸，直接标定会劣化到 8 km 级）。坑与细节见《源资产分析-01-远期ai提取评估.md》§4（ICC CMYK 借色、隐式重复参数组、f 装饰剔除、24pt 线路名标签绑定）与《源资产分析-02-原生命名与可见性.md》。B 类站圆已用于**站圆预置**（`tools/station_extract.py` → `import/站圆预置-草稿.json`：50 组 497 站带 t 与站名建议，编辑器「从预置导入车站」批量落站、建议名点选采用、绝不自动建换乘组；站名匹配试做覆盖 97.6% 待用户验收）；`零散/` 两个 KMZ（上海全部建设规划、深化线网优化方案）与 .ai 是**不同版本规划**——只能作既有/批复段真值。

技术要点：MapLibre GL 地理化渲染；AI 源图仅导出线路 path（`svg_parse.py --import` 产出 `import/*.json` 即 fmt/import@1），设站站名纯手动录入（编辑器仅本地，入口 editor.html）；数据模块化（线路/设站/换乘节点组 + 线组绑定）；分段状态 `existing/approved/future`；标定头尾失准以 (ds,de) 弧长偏差建模校正；设站编号水位 `meta.stopSeq` 防复用；GitHub Pages 从 `/docs` 部署（publish.py 生成）。

## 常用命令

```bash
python tools/validate.py data                      # 数据校验（提交前必跑）
python tools/validate.py tools/fixtures/sample     # 对样例数据跑校验
python -X utf8 tools/ai_parse.py "源资产/远期.ai" --out "import/远期图-全量.json" --verify "源资产/6、14、15、23号线.svg" --calib "6,14,15,23" --svg-out "源资产/远期图-标定4线.svg" --line-note "4=与 3 号线共线，仅画不重复段" --line-note "苏淀沪线=即示范区线支线；原生对象名误作「苏淀沪连接线」（2026-11-21 用户裁定）"   # .ai 全量提取线路（对拍+平移版标定 SVG；依赖 PyMuPDF）
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
python -m http.server                              # 本地服务，开 http://localhost:8000/editor.html
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
