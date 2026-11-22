# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态（2026-11-22）

上海轨道交通远期规划图网页：编辑器（editor.html，仅本地、永不部署）＋查看器（index.html，GitHub Pages 从 /docs 发布）。**本文件夹已 git 化（分支 main，无远端）**，用户将发布为 **SH-Rail-Planning-web**。

- 阶段 0 标定 / 1 规范骨架：完成（标定已定案＝手动 TPS，见下）。
- 阶段 2 编辑器：MVP＋多轮加固完成；**data/lines/ 仍为空，录入未开始**（首批 4 条线要求含环线/支线/共线/联络线各一例）。
- 阶段 3 查看器：MVP＋产品化＋显示规则八条改版＋白板字样改版完成，真数据目验中。

**⚠ 开工前必读**：《架构方案-01-Schema与目录与阶段.md》（实施基准 v1.5）＋**《进度状态-02-阶段总览.md》**（当前全量明细：编辑器/查看器逐轮功能与裁定、标定与 .ai 提取始末、踩坑教训、待办占位——CLAUDE.md 2026-11-22 已瘦身，细节以该文档为准）；讨论史《讨论记录-01~04》。过程文档均 gitignore 仅本地。

## 核心技术要点（高频；细节以架构方案与进度状态-02 为准）

- 数据链：`data/`（lines/*.json **fmt/line@2**＋groups.json＋manifest.json）→ `tools/flatten.py` → `net/*.geojson` → 查看器；编辑器 `editor.html`＋`src/editor.js`/`src/geom.js`（逻辑层有 node 单测）。AI 源图仅导出线路 path（`svg_parse.py --import`→`import/*.json`）；设站站名纯手动录入。
- schema v1.5：分段一等实体（`sections[{name,status}]` 铺满全线＋`segments` 整数索引，flatten 拒 @1）；组类型 same-station / out-of-station / junction（接轨站，描边取成员线角色优先级色 main＞standalone＞branch＞connector）；`stop.kind`: block（线路所，网页隐藏）/ arrow（出省箭头，网页显示）；联络线结构字段 `connects`（≥2 线 id）；设站编号水位 `meta.stopSeq` 防复用；线路分类 `meta.layer`（源图子图层名，中文合法：市域线/市区线/联络线/预控通道/他省…）。
- 查看器类别裁定：**联络线不出列表**（地图照画、搜索照收）；**他省线仅显示级**（不可聚焦、恒调光、点选无面板）。
- 标定：现行 `data/calibration.json`＝手动 TPS λ=1e5、38 控点（2026-11-21 用户验收定案，勿重拟合）；回滚＝calibration-autotps-backup.json / calibration-deg3-backup.json（编辑器「标定」按钮）/ git 历史。.ai 全量提取＝`tools/ai_parse.py`→`import/远期图-全量.json`（84 线，命名裁定见进度状态-02）。
- **MapLibre 血泪教训（改样式前必看）**：运行时错误默认不上控制台——层级校验失败是「弃层不弃 style」（filter `'!'` 吃 0/1 数字曾致站圈全没，**filter 一律显式 `['==',['get','x'],0/1]`**）；`line-cap`/`line-join` 是 layout 属性，放 paint 拒载整个 style 全黑；zoom 插值 stops 保持全常量、档位差异拆层做（数据驱动×zoom 复合真机不连续求值）；无头浏览器验证渲染不可靠（连 load 周期都不完成），排查走真实浏览器控制台＋一次性无头截图。

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
- **数据文件的结构字段与枚举值全英文**（existing/approved/future、main/branch/connector/standalone 等），中文仅限 name/aliases/info 值等文本内容（含源图命名原样转写字段 sourceLayer 与 meta.layer——validate 的 CJK 豁免名单已含）；全部文件 UTF-8 无 BOM（编码顾虑，用户明令）。
- 遵循 Gall's Law 增量演进：每阶段出口必须是"能用的简单系统"。
- **过程文档不入库**（2026-11-21 用户指示）：讨论记录-\*、进度状态-\*、标定试验-\*、源资产分析-\* 一律 gitignore 仅本地保留；入库的仅关键文档（CLAUDE.md、架构方案-\*、README）与代码/数据/工具。

## 约定（继承自上级工作区）

- 全中文工作：文件命名、注释、文档、与用户交流均用中文；**不重命名中文文件夹/文件**。
- Windows 11 + Git Bash：shell 中一律用正斜杠并给含中文的路径加引号，如 `"E:/10.项目/261120远期图网页/..."`。
- 不假设 Python 第三方包已安装；如需脚本处理数据，先检查依赖。
