#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sync_workspace —— 用户工作区 → 仓库内副本 → 查看器数据（仅本地预览用，产物不入库）。

背景：录入在用户工作区（编辑器「保存工作区」直写目录，默认
~/Documents/远期图测试）进行；查看器只认 flatten 产物（net/ 不存在时回退
build/net/）。此前每回都要人工重跑 flatten——用户存盘后打开查看器看到的
还是旧数据（2026-11-22 抓包「你没有导入我的工作区里的数据，看到的还是
旧的」）。本工具把它做成一步：

  1. 复制：工作区的**数据文件**（lines/*.json、groups.json、manifest.json，
     如有 calibration.json）复制一份到仓库内 build/workspace/。用户原话
     「复制一份过去，我还正在编辑」——工作区仍是唯一录入位，本工具对它
     **只读、绝不写入**；副本落在 build/（gitignore），不进 git、不进发布；
  2. flatten：以副本为 --data 跑 tools/flatten.py → build/net/。先产出到
     build/net.new/，三件产物齐全后整组换入，查看器不会读到写了一半的文件；
  3. --watch：持续监视工作区（轮询文件指纹，默认 1 秒）。指纹变化且连续
     --settle 秒不再变（编辑器一次保存要重写全部线文件）才复制＋flatten。

健壮性：复制前逐文件读入内存并做 JSON 自检（读前读后比对指纹，排除正在
写盘的文件），任一文件读失败/解析失败即整轮放弃、稍后重试，不动上一份好
副本与上一份 build/net。

用法（项目根）：
  python -X utf8 tools/sync_workspace.py                    # 一次性：复制＋flatten
  python -X utf8 tools/sync_workspace.py --watch            # 持续同步（Ctrl+C 停）
  python -X utf8 tools/sync_workspace.py --validate         # 顺带对副本跑 validate
  python -X utf8 tools/sync_workspace.py --src "C:/Users/18916/Documents/远期图测试"
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SRC = Path.home() / "Documents" / "远期图测试"
ROOT_FILES = ("groups.json", "manifest.json", "calibration.json", "lineinfo.md")   # 根下数据文件（存在才复制）
NET_FILES = ("lines.geojson", "stops.geojson", "index.json")        # flatten 产物三件
#（lineinfo.md＝用户手填线路介绍，2026-11-23 增：一并同步，由 flatten 原样透传进
#  build/net——查看器「线路信息面板」的本地预览数据源。非 JSON 文件，复制自检免 json 解析）


def stamp():
    return time.strftime("%H:%M:%S")


def list_data_files(src):
    """工作区数据文件清单：lines/*.json ＋ 根下数据文件（存在才算）。"""
    lines_dir = src / "lines"
    files = sorted(lines_dir.glob("*.json")) if lines_dir.is_dir() else []
    files += [src / n for n in ROOT_FILES if (src / n).is_file()]
    return files


def fingerprint(src):
    """文件指纹 {相对路径: (mtime_ns, size)}——指纹不变即视为工作区没动。"""
    fp = {}
    for p in list_data_files(src):
        try:
            st = p.stat()
        except OSError:
            continue
        fp[p.relative_to(src).as_posix()] = (st.st_mtime_ns, st.st_size)
    return fp


def copy_data(src, dst):
    """工作区 → 副本。先整体读入内存并逐文件 JSON 自检，全部通过才落盘；
    任一步失败返回 None（不动既有副本）。成功返回 (文件数, 清理的旧线文件数)。"""
    blob = {}
    for p in list_data_files(src):
        rel = p.relative_to(src).as_posix()
        try:
            before = p.stat()
            data = p.read_bytes()
            after = p.stat()
            # JSON 自检只对 .json 做（lineinfo.md 是手填 markdown，原样透传不解析——
            # 但读前读后指纹比对照做，排除正在写盘的文件）
            if p.suffix == ".json":
                json.loads(data.decode("utf-8-sig"))
        except (OSError, ValueError) as e:
            print(f"[{stamp()}] 本轮跳过：{rel} 读取/解析失败（{e}）——编辑器可能正在写盘，稍后重试", flush=True)
            return None
        if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
            print(f"[{stamp()}] 本轮跳过：{rel} 读取期间仍在变化——稍后重试", flush=True)
            return None
        blob[rel] = data
    if not blob:
        print(f"[{stamp()}] 本轮跳过：{src} 下没有数据文件", flush=True)
        return None
    removed = 0
    lines_dst = dst / "lines"
    if lines_dst.is_dir():
        for old in lines_dst.glob("*.json"):
            if old.relative_to(dst).as_posix() not in blob:
                old.unlink()
                removed += 1
    # 工作区已删掉的 lineinfo.md 从副本摘除（groups.json/manifest.json 恒在、不在此列）——
    # 不摘的话副本里残留旧文件，flatten 会照旧透传，查看器预览永远去不掉旧介绍
    stale_li = dst / "lineinfo.md"
    if "lineinfo.md" not in blob and stale_li.is_file():
        stale_li.unlink()
        removed += 1
    for rel, data in blob.items():
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    return len(blob), removed


def run_tool(script, *args):
    """在仓库根跑 tools/ 下的脚本，返回 (退出码, 合并输出)。"""
    cmd = [sys.executable, "-X", "utf8", str(REPO / "tools" / script), *args]
    r = subprocess.run(cmd, cwd=str(REPO), capture_output=True,
                       text=True, encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def sync_once(src, dst, out, do_validate=False, always=False):
    """复制＋flatten 一轮。工作区指纹与上一轮相同且非 always 时直接跳过。"""
    global LAST_FP
    fp = fingerprint(src)
    if not always and fp and fp == LAST_FP:
        return True
    res = copy_data(src, dst)
    if res is None:
        return False
    n_files, removed = res
    stage = out.parent / (out.name + ".new")
    if stage.exists():
        shutil.rmtree(stage)
    code, log = run_tool("flatten.py", "--data", str(dst), "--out", str(stage))
    if code != 0 or not all((stage / n).is_file() for n in NET_FILES):
        print(f"[{stamp()}] flatten 失败（退出码 {code}）——{out} 保持上一份成功产物\n{log.strip()}", flush=True)
        shutil.rmtree(stage, ignore_errors=True)
        return False
    out.mkdir(parents=True, exist_ok=True)
    for name in NET_FILES:
        os.replace(stage / name, out / name)
    # lineinfo.md（可选产物，2026-11-23）：数据目录有则 flatten 已透传进 stage，一并换入；
    # 本轮没有（工作区删掉了该文件）则把上一轮的旧文件摘掉——查看器预览不残留旧介绍
    staged_li, out_li = stage / "lineinfo.md", out / "lineinfo.md"
    if staged_li.is_file():
        os.replace(staged_li, out_li)
    elif out_li.is_file():
        out_li.unlink()
    shutil.rmtree(stage, ignore_errors=True)
    LAST_FP = fp
    summary = next((ln for ln in log.splitlines() if ln.startswith("flatten 完成")), "flatten 完成")
    n_lines = sum(1 for k in fp if k.startswith("lines/"))
    print(f"[{stamp()}] 已同步：复制 {n_lines} 个线文件＋{n_files - n_lines} 个根文件"
          f"（清理旧线文件 {removed}）→ {summary}", flush=True)
    # flatten 的「警告：」「提示：」行原样转出（如归档表矛盾、段折线点数不足被跳过）——不吞
    for ln in log.splitlines():
        if ln.startswith(("警告：", "提示：")):
            print(f"    {ln}", flush=True)
    if do_validate:
        vcode, vlog = run_tool("validate.py", str(dst))
        tail = [ln for ln in vlog.strip().splitlines() if ln.strip()][-1:] or ["（无输出）"]
        print(f"[{stamp()}] validate：{'PASS' if vcode == 0 else 'FAIL'}｜{tail[0]}", flush=True)
    return True


LAST_FP = None


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(
        prog="sync_workspace.py",
        description="把用户工作区的数据复制一份到仓库内 build/workspace/，再 flatten 到 build/net/ "
                    "供查看器预览（对工作区只读）。--watch 持续监视，存盘后自动同步。")
    ap.add_argument("--src", default=str(DEFAULT_SRC),
                    help=f"用户工作区目录（默认 {DEFAULT_SRC}）")
    ap.add_argument("--dst", default="build/workspace", help="仓库内副本目录（默认 build/workspace）")
    ap.add_argument("--out", default="build/net", help="flatten 输出目录（默认 build/net）")
    ap.add_argument("--watch", action="store_true", help="持续监视工作区并自动同步")
    ap.add_argument("--poll", type=float, default=1.0, help="监视轮询间隔秒（默认 1.0）")
    ap.add_argument("--settle", type=float, default=1.0,
                    help="指纹变化后再静默多少秒才动手（编辑器一次保存重写全部文件；默认 1.0）")
    ap.add_argument("--validate", action="store_true", help="每次同步后对副本跑 validate 并打印结论")
    args = ap.parse_args()

    src = Path(args.src)
    dst = (REPO / args.dst).resolve()
    out = (REPO / args.out).resolve()
    if not src.is_dir():
        sys.exit(f"错误：工作区目录不存在：{src}")
    # 防呆：副本/输出目录绝不得与工作区相同或互相包含（清理旧文件只应发生在 build/ 内）
    s = src.resolve()
    for d in (dst, out):
        if d == s or d in s.parents or s in d.parents:
            sys.exit(f"错误：{d} 与工作区 {s} 相同或互相包含，拒绝执行")

    print(f"[{stamp()}] 工作区 {src}（只读）→ 副本 {dst} → 查看器数据 {out}", flush=True)
    ok = sync_once(src, dst, out, args.validate, always=True)
    if not args.watch:
        return 0 if ok else 1
    print(f"[{stamp()}] 监视中：每 {args.poll:g} 秒查一次，存盘后约 {args.settle:g} 秒同步；Ctrl+C 停止", flush=True)
    while True:
        time.sleep(args.poll)
        try:
            cur = fingerprint(src)
            if cur == LAST_FP:
                continue
            # 等写盘结束：指纹连续 settle 秒不再变才动手
            quiet = 0.0
            while quiet < args.settle:
                time.sleep(args.poll)
                again = fingerprint(src)
                if again != cur:
                    cur, quiet = again, 0.0
                else:
                    quiet += args.poll
            sync_once(src, dst, out, args.validate)
        except KeyboardInterrupt:
            raise
        except Exception as e:   # 单轮异常不拖垮监视
            print(f"[{stamp()}] 本轮异常（继续监视）：{e!r}", flush=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print(f"\n[{stamp()}] 已停止", flush=True)
        sys.exit(0)
