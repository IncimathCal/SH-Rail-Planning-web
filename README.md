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

# 录入数据 → 查看器渲染数据（默认输出 build/net）
python -X utf8 tools/flatten.py --data data --out build/net

# 本地开发服务（编辑器/查看器共用，替代 python -m http.server）
python -X utf8 tools/serve.py        # http://localhost:8000

# 查看器纯逻辑单测（node）
node tools/test_viewer_logic.js
```

## 本地预览（查看器）

`index.html` 以**相对路径**依次拉取 `net/lines.geojson`、`net/stops.geojson`（第一候选
`net/` 为发布快照位，取不到回退 `build/net/` 即本地 flatten 默认输出位），因此仓库根与
`docs/` 部署快照两种打开方式都通：

```bash
python -X utf8 tools/flatten.py --data data --out build/net   # ① 生成查看器数据
python -X utf8 tools/serve.py                                 # ② 起服务后打开 http://localhost:8000/index.html
```

必须经 HTTP 服务打开（`file://` 直开时浏览器禁止读取数据文件，页面会给出中文指引）。

查看器无底图（设计如此：纯深色画布、零外部资源）；底图功能在编辑器侧（OSM/高德，仅本地）。

站点符号约定：同站换乘恰 2 线画合并大圈（黑边）；≥3 线画白底黑边「药丸」（成员站圈隐去，
药丸即换乘标识，链序按最近邻贪心串联；点击药丸开组信息面板）；线路出省端点画线色箭头指向线路
外侧（方向按站序邻站推导；属线路标志而非车站，不参与搜索、悬停与点选）。

## 部署

GitHub Pages 从 `main` 分支 `/docs` 目录发布；`docs/` 由 `tools/publish.py` 生成
（校验 → flatten → 白名单拷贝，含 `net/` 数据，编辑器永不入产物），不手工编辑。
