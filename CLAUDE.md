# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目状态（2026-11-20 阶段 1 完成）

**本文件夹已 git 化（分支 main，无远端）**，用户将以 GitHub 客户端发布为 **SH-Rail-Planning-web**。阶段 1（规范与骨架）已完成：目录结构、`tools/validate.py` 校验器、`tools/fixtures/sample` 样例数据（含环线/支线/联络线/换乘组用例）校验通过。

**下一步：阶段 0（标定试验）**——等待用户提供 1~2 条线路的 AI 导出 SVG + 同线 GE 描线 KML，放入 `源资产/`（已 gitignore）。实施基准见 **《架构方案-01-Schema与目录与阶段.md》**（v1.1），讨论历史见《讨论记录-01~03》。

技术要点：MapLibre GL 地理化渲染；AI 源图仅导出线路 path，设站站名纯手动录入（编辑器仅本地，入口 editor.html）；数据模块化（线路/设站/换乘节点组 + 线组绑定主线支线联络线）；分段状态 `existing/approved/future`；GitHub Pages 从 `/docs` 部署（publish.py 生成）。

## 常用命令

```bash
python tools/validate.py data                      # 数据校验（提交前必跑）
python tools/validate.py tools/fixtures/sample     # 对样例数据跑校验
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
