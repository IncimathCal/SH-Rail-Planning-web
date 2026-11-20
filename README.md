# SH-Rail-Planning-web

上海轨道交通远期规划图 · 交互式网页。以 Illustrator 绘制的远期规划图（约 60 条线路、近 2000 车站）为数据来源，构建 MapLibre 地理化渲染的静态交互线网图，部署于 GitHub Pages。

## 当前状态

阶段 1（规范与骨架）完成：仓库结构、数据 schema v1、校验器与样例数据就绪。后续按《架构方案-01-Schema与目录与阶段.md》的阶段划分推进（阶段 0 标定试验 → 编辑器 → 查看器上线）。

## 目录

| 路径 | 说明 |
|---|---|
| `架构方案-01-*.md`、`讨论记录-*.md` | 实施基准与决策历史（先读架构方案） |
| `data/` | 权威数据：每线一份 `lines/l####.json`、`groups.json`（线组+换乘节点库）、`manifest.json` |
| `import/` | `svg_parse.py` 从 AI 导出 SVG 提取的线路 path |
| `tools/` | Python 离线工具链（校验、标定、加密、字形、发布） |
| `src/` | 查看器/编辑器共享前端代码 |
| `index.html` / `editor.html` | 查看器入口（发布源）/ 编辑器入口（仅本地，永不部署） |
| `docs/` | GitHub Pages 部署目录（`publish.py` 生成，勿手改） |
| `源资产/` | 用户提供的 SVG/KML 原始文件（本地保留，已 gitignore） |

## 数据纪律

本项目全部线网数据（线型、设站、站名、状态、关系）**一律由作者提供，不引用任何外部数据源**（OSM、维基、第三方数据库等一律不使用）。设站与站名纯手动录入。

## 常用命令

```bash
# 数据校验（提交前必跑；目标目录默认 data）
python tools/validate.py data

# 对样例数据跑校验
python tools/validate.py tools/fixtures/sample
```

## 部署

GitHub Pages 从 `main` 分支 `/docs` 目录发布；`docs/` 由 `tools/publish.py` 生成，不手工编辑。
