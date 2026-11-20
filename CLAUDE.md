# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态（2026-11-20 阶段 0+1 完成，阶段 2 进行中）

**本文件夹已 git 化（分支 main，无远端）**，用户将以 GitHub 客户端发布为 **SH-Rail-Planning-web**。进度：

- 阶段 1（规范与骨架）完成：目录结构、`tools/validate.py`、`tools/fixtures/sample` 样例数据；
- 阶段 0（标定试验）完成：4 条线（6/14/15/23）SVG+KML 标定通过，单线横向 RMS 15~41 m、全局 80 m，见《标定试验-01-残差报告.md》（验收线建议已提请用户确认）；
- **阶段 2（编辑器 MVP + 首批录入）进行中**：编辑器 MVP 已建成——`editor.html` + `src/geom.js`（与 Python 版对拍一致）+ `src/editor.js`（纯逻辑层有 node 单测），支持载入导入记录/数据、点选加站记弧长 t、拖动、改名、删站、分段状态循环、换乘编组（就近提示仅视觉）、线组管理、JSON 下载保存、localStorage 暂存、撤销。**待用户用编辑器录入首批 4 条线**（要求含环线/支线/共线/联络线各一例）。用户另将提供 2~4 条地理边缘方向线路的 SVG+KML 做全图尺度标定决策（三阶 vs TPS）。

实施基准见 **《架构方案-01-Schema与目录与阶段.md》**（v1.2），讨论历史见《讨论记录-01~03》。

技术要点：MapLibre GL 地理化渲染；AI 源图仅导出线路 path（`svg_parse.py --import` 产出 `import/*.json` 即 fmt/import@1），设站站名纯手动录入（编辑器仅本地，入口 editor.html）；数据模块化（线路/设站/换乘节点组 + 线组绑定）；分段状态 `existing/approved/future`；标定头尾失准以 (ds,de) 弧长偏差建模校正；设站编号水位 `meta.stopSeq` 防复用；GitHub Pages 从 `/docs` 部署（publish.py 生成）。

## 常用命令

```bash
python tools/validate.py data                      # 数据校验（提交前必跑）
python tools/validate.py tools/fixtures/sample     # 对样例数据跑校验
python tools/svg_parse.py "源资产/xxx.svg" --import # 产出 import/xxx.json 供编辑器载入
python tools/georef.py "源资产/xxx.svg" "源资产/xxx.kmz"   # 标定试验（残差报告）
node tools/test_geom.js                            # geom.js 与 svg_parse.py 对拍
node tools/test_editor_logic.js                    # 编辑器纯逻辑单测
python -m http.server                              # 本地服务，开 http://localhost:8000/editor.html
```

## 硬性约束（用户明令，优先级最高）

- **地铁相关数据（线型、设站、站名、状态、关系等）一律由用户提供，不得引用任何外部数据源**——OSM、维基、第三方线路数据库一律禁止。
- 设站与站名**纯手动**录入，不自动读取 AI 源图中的圆与文本。
- 编辑器仅供本地使用，永不部署到 GitHub Pages。
- 换乘编组**绝不按站名自动合并**。
- **数据文件的结构字段与枚举值全英文**（existing/approved/future、main/branch/connector/standalone 等），中文仅限 name/aliases/info 值等文本内容；全部文件 UTF-8 无 BOM（编码顾虑，用户明令）。
- 遵循 Gall's Law 增量演进：每阶段出口必须是"能用的简单系统"。

## 约定（继承自上级工作区）

- 全中文工作：文件命名、注释、文档、与用户交流均用中文；**不重命名中文文件夹/文件**。
- Windows 11 + Git Bash：shell 中一律用正斜杠并给含中文的路径加引号，如 `"E:/10.项目/261120远期图网页/..."`。
- 不假设 Python 第三方包已安装；如需脚本处理数据，先检查依赖。
