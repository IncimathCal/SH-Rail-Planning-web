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
     assets/fonts/（UI 字体子集，index.html @font-face 引用；2026-11-23 增）、
     assets/logo.svg＋assets/qrcode-{gzh,bilibili}.png（新 UI 素材：favicon/初始页/右上
     logo 与两张二维码卡；2026-11-26 增）；另在 docs/ 根写空 .nojekyll（GitHub Pages
     关 Jekyll——防下划线开头文件被过滤；仓库无此源文件，白名单段直接产出）；
     随后往快照 index.html 注入临时测试版弹窗（2026-11-28 用户令，见 inject_beta_notice，
     正式源码零改动，下线＝删注入段重跑本脚本）。

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


# ⚠ 临时测试版弹窗（2026-11-28 用户令）——发布快照专用注入段，正式源码零改动。
# 文案与行为均为用户原令：进入网站即弹全屏遮罩＋玻璃卡片（黑白灰、居中），点「确认」
# 才解除；每次进入/刷新都弹（不记忆）。只写进 docs/ 发布产物，本地开发版（8000 根版
# index.html）不受影响。
# ★ 下线方法＝删除本函数＋main() 中标注「⚠ 临时测试版弹窗」的调用行，重跑
#   python -X utf8 tools/publish.py 即彻底恢复无弹窗快照（无需改任何正式源码）。
def inject_beta_notice(out_dir):
    """往发布快照 index.html 的 </body> 前注入自包含弹窗段（HTML+CSS+JS 一体、边界注释清晰）。"""
    snippet = """\
<!-- ==================== ⚠ 临时测试版弹窗（2026-11-28 用户令） ====================
     本段由 tools/publish.py 注入（发布快照专用；正式源码 index.html/src/ 不含此段）。
     弹窗进入即现，全屏遮罩挡住一切交互（含地图），点「确认」才解除；每次进入/刷新都弹
     （不记忆）。样式与站点视觉一致（黑白灰、玻璃卡片、居中）。
     下线＝删除 tools/publish.py 中的注入段，重跑 python -X utf8 tools/publish.py。
     ================================================================================ -->
<div id="betaNotice" role="dialog" aria-modal="true" aria-label="提示">
  <div id="betaNoticeCard">
    <div id="betaNoticeTitle">提示</div>
    <div id="betaNoticeText">测试版网页，南枫线、苏淀沪线信息过时</div>
    <button id="betaNoticeConfirm" type="button">确认</button>
  </div>
</div>
<style>
  /* 自包含样式（不复用站点 class，防正式源码改版牵连弹窗）；参数与站点定稿同源：
     玻璃＝白 0.45＋blur20 saturate1.7，卡片圆角 14/描边 rgba(0,0,0,.08)，按钮＝
     初始页「确认」同款（黑底白字、圆角 12、字距 6）；z-index 9999 压过全部界面层 */
  #betaNotice {
    position: fixed; inset: 0; z-index: 9999;
    display: flex; align-items: center; justify-content: center;
    background: rgba(255, 255, 255, 0.45);
    -webkit-backdrop-filter: blur(20px) saturate(1.7);
    backdrop-filter: blur(20px) saturate(1.7);
  }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    #betaNotice { background: rgba(248, 249, 251, 0.88); -webkit-backdrop-filter: none; backdrop-filter: none; }
  }
  #betaNoticeCard {
    width: min(320px, calc(100vw - 48px));
    border: 1px solid rgba(0, 0, 0, 0.08); border-radius: 14px;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.08);
    padding: 22px 20px 18px;
  }
  #betaNoticeTitle { text-align: center; font-size: 16px; font-weight: 600; letter-spacing: 2px; color: #000; }
  #betaNoticeText { margin-top: 10px; text-align: center; font-size: 14px; line-height: 1.7; color: #000; }
  #betaNoticeConfirm {
    display: block; width: 100%; margin-top: 16px; padding: 9px 0; cursor: pointer;
    font-size: 15px; font-weight: 600; letter-spacing: 6px; text-indent: 6px;
    color: #fff; background: #000; border: none; border-radius: 12px;
  }
  #betaNoticeConfirm:hover { background: #222; }
</style>
<script>
  (function () {
    var root = document.getElementById('betaNotice');
    var btn = document.getElementById('betaNoticeConfirm');
    if (!root || !btn) return;
    function blockKeys(e) {
      if (e.key === 'Enter' || e.key === ' ') return;   /* 放行键盘确认（按钮已自动聚焦） */
      e.preventDefault();
      e.stopImmediatePropagation();   /* 遮罩期间拦截页面级键盘（防穿透到地图键盘导航） */
    }
    document.addEventListener('keydown', blockKeys, true);
    btn.addEventListener('click', function () {
      document.removeEventListener('keydown', blockKeys, true);
      if (root.parentNode) root.parentNode.removeChild(root);
      root = null;
    });
    btn.focus();
  })();
</script>
<!-- ==================== ⚠ 临时测试版弹窗结束 ==================== -->
"""
    path = out_dir / "index.html"
    raw = path.read_bytes()
    if b'id="betaNotice"' in raw:
        print("错误：发布快照 index.html 已含临时弹窗标记，拒绝重复注入", file=sys.stderr)
        sys.exit(1)
    text = raw.decode("utf-8")
    idx = text.rfind("</body>")
    if idx < 0:
        print("错误：发布快照 index.html 无 </body>，无法注入临时弹窗", file=sys.stderr)
        sys.exit(1)
    # 行尾跟随宿主文件（仓库 autocrlf=true、工作区为 CRLF；字节级操作保证其余内容零改动）
    if b"\r\n" in raw:
        snippet = snippet.replace("\n", "\r\n")
    path.write_bytes((text[:idx] + snippet + text[idx:]).encode("utf-8"))
    print("已注入临时测试版弹窗（2026-11-28 用户令）→ " + (out_dir / "index.html").as_posix())


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
    cp("basemap")   # 界线底图静态件整目录（省界 provinces-wgs84.json＋区界 districts-wgs84.json；查看器运行时按相对路径只读此仓库内文件）
    cp("assets/fonts")   # UI 字体子集（2026-11-23 浅色改版随 @font-face 进发布）
    # 新 UI 素材（2026-11-26）：logo.svg＝favicon＋初始页 logo＋右上角 logo 三处引用；
    # 两张二维码卡（公众号纯图片、B 站链接新窗口打开）
    cp("assets/logo.svg")
    cp("assets/qrcode-gzh.png")
    cp("assets/qrcode-bilibili.png")
    # .nojekyll（GitHub Pages）：仓库根没有对应源文件，不走 cp——白名单段直接写空文件，
    # 汇总自检（下方 rglob）与其他产物同口径覆盖。防 Jekyll 把下划线开头文件当特殊件过滤。
    (out_dir / ".nojekyll").write_bytes(b"")
    copied.append(".nojekyll")

    # ⚠ 临时测试版弹窗（2026-11-28 用户令）：往快照 index.html 注入弹窗段（见上方
    # inject_beta_notice 注释——下线＝删函数＋删本调用行后重跑 publish）
    inject_beta_notice(out_dir)

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
