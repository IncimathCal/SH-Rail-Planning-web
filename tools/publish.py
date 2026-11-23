#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""发布快照生成（阶段 3）：校验 → flatten 地理化 → 白名单拷贝到 docs/。

用法：
    python -X utf8 tools/publish.py                                    # 正式：data/ → docs/
    python -X utf8 tools/publish.py --data tools/fixtures/sample --out build/docs-test   # 冒烟测试

流程：
  1. validate.py 校验 <data>（不过即中止）；
  2. flatten.py 把 <data> 经 data/calibration.json 变换为 GeoJSON → <out>/net/
     （lines.geojson / stops.geojson / index.json＝线路显示顺序索引，随 net/ 整体产出；
     lineinfo.md＝用户手填线路介绍，数据目录里有则原样透传进 net/）；
  3. 白名单拷贝：index.html、src/viewer*.js、assets/vendor/（vendored MapLibre）、
     assets/fonts/（UI 字体子集，index.html @font-face 引用；2026-11-23 增）。

白名单恒定——editor.html、编辑器代码、过程文档、源资产、import/ 永不进入部署目录
（编辑器仅供本地使用，永不部署）。docs/ 为生成物，勿手改。
"""

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"


def run(cmd, **kw):
    """跑子进程，失败即中止（发布链路上任何一环失败都不产出半成品）。"""
    print("$ " + " ".join(str(c) for c in cmd), flush=True)
    r = subprocess.run([str(c) for c in cmd], **kw)
    if r.returncode != 0:
        print(f"失败（exit {r.returncode}）：{cmd[1] if len(cmd) > 1 else cmd}", file=sys.stderr)
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description="生成 docs/ 部署快照（校验门禁→地理化→白名单拷贝）")
    ap.add_argument("--data", default="data", help="权威数据目录（默认 data；冒烟可指 tools/fixtures/sample）")
    ap.add_argument("--out", default="docs", help="输出目录（默认 docs）")
    args = ap.parse_args()

    data_dir = (ROOT / args.data).resolve()
    out_dir = (ROOT / args.out).resolve()
    if not data_dir.is_dir():
        print(f"数据目录不存在：{data_dir}", file=sys.stderr)
        sys.exit(1)
    # 安全护栏：输出目录不得是仓库根/工具目录，也不得含 .git
    if out_dir in (ROOT, TOOLS) or (out_dir / ".git").exists():
        print(f"输出目录不合法：{out_dir}", file=sys.stderr)
        sys.exit(1)

    # 1. 校验门禁
    run([sys.executable, "-X", "utf8", TOOLS / "validate.py", data_dir])

    # 2. 地理化（flatten 自带 --calib 回退链：<data>/calibration.json → data/calibration.json）
    if out_dir.exists():
        shutil.rmtree(out_dir)
    run([sys.executable, "-X", "utf8", TOOLS / "flatten.py",
         "--data", data_dir, "--out", out_dir / "net"])
    # flatten 产物自检：线路显示顺序索引（net/index.json，查看器左栏序）必须随 net/ 整体产出
    # （防未来重构改逐文件白名单时漏带）
    if not (out_dir / "net" / "index.json").is_file():
        print("错误：net/index.json 缺失（flatten 未输出线路顺序索引）", file=sys.stderr)
        sys.exit(1)
    # lineinfo.md（线路信息面板，用户手填介绍）由 flatten 原样透传进 net/——net/ 整体来自
    # flatten，cp() 白名单只管仓库文件（加进去反而会落到 docs/data/ 错位）。故此处沿用
    # index.json 的自检模式：数据目录里有该文件，docs/net/ 里就必须有（数据目录没有＝
    # 合法的「无手填介绍」态，不检查）
    if ((data_dir / "lineinfo.md").is_file()
            and not (out_dir / "net" / "lineinfo.md").is_file()):
        print("错误：net/lineinfo.md 缺失（flatten 未透传线路手填介绍）", file=sys.stderr)
        sys.exit(1)

    # 3. 白名单拷贝
    copied = []

    def cp(src_rel):
        src = ROOT / src_rel
        if not src.exists():
            return
        dst = out_dir / src_rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        copied.append(src_rel)

    cp("index.html")
    for js in sorted(TOOLS.parent.glob("src/viewer*.js")):
        cp(js.relative_to(ROOT).as_posix())
    cp("assets/vendor")
    cp("basemap")   # 省级界线底图静态件（查看器运行时按相对路径只读此仓库内文件）
    cp("assets/fonts")   # UI 字体子集（2026-11-23 浅色改版随 @font-face 进发布）

    # 4. 汇总与自检
    total = 0
    print("\n=== 发布快照 ===")
    for p in sorted(out_dir.rglob("*")):
        if p.is_file():
            n = p.stat().st_size
            total += n
            print(f"  {p.relative_to(out_dir).as_posix():48s} {n:>10,} B")
    print(f"共 {sum(1 for p in out_dir.rglob('*') if p.is_file())} 个文件，{total:,} B → {out_dir}")

    # 部署红线自检：产物中不得出现编辑器引用
    for p in out_dir.rglob("*.html"):
        text = p.read_text(encoding="utf-8", errors="ignore")
        if "editor" in text.lower():
            print(f"警告：{p.name} 中出现 editor 引用，请检查是否误引编辑器代码。", file=sys.stderr)


if __name__ == "__main__":
    main()
