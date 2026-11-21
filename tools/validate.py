#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据校验器 —— 执行《架构方案-01》§1.7 的校验规则（v1.5）。

用法：
    python tools/validate.py [目标目录]     # 默认 data

退出码：0 = 通过；1 = 存在 ERROR。
输出文案：存量规则为英文；v1.5 分段（fmt/line@2）相关新文案为中文。
stdout 已 reconfigure 为 UTF-8（同 flatten.py 手法），Windows 管道/
重定向下中文输出不再受 ANSI 代码页影响。
仅用 Python 标准库。
"""

import json
import re
import sys
from pathlib import Path

# ---------- 常量（与架构方案 §1 保持一致） ----------

SEG_STATUS = {"existing", "approved", "future"}
ROLES = {"main", "branch", "connector", "standalone"}
GROUP_TYPES = {"same-station", "out-of-station", "junction"}  # v1.3 取消 passage；v1.4 增 junction（接轨站）
STOP_KINDS = {"block"}  # v1.4 线路所：kind 缺省＝普通站，仅 block 合法

RE_LINE_ID = re.compile(r"^l\d{4}$")
RE_STOP_ID = re.compile(r"^l\d{4}-s\d{2,}$")
RE_GROUP_ID = re.compile(r"^g\d{4}$")
RE_LINEGROUP_ID = re.compile(r"^lg\d{2,}$")
RE_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
RE_KEY_ASCII = re.compile(r"^[A-Za-z0-9_-]+$")
RE_NUMBER = re.compile(r"-?\d*\.?\d+(?:[eE][+-]?\d+)?")
RE_PATH_LETTERS = re.compile(r"^[MmZzLlHhVvCcSsQqTtAa]+$")
RE_CJK = re.compile(r"[一-鿿　-〿＀-￯]")

# 允许含中文的字段（文本内容）；info 子树整体放宽
CJK_OK_KEYS = {"name", "note", "sourceLayer", "aliases"}

errors = []
warnings = []


def err(fname, msg):
    errors.append(f"  [ERROR] {fname}: {msg}")


def warn(fname, msg):
    warnings.append(f"  [WARN]  {fname}: {msg}")


def load_json(path):
    raw = path.read_bytes()
    if raw.startswith(b"\xef\xbb\xbf"):
        warn(path.name, "file has UTF-8 BOM (should be none)")
    return json.loads(raw.decode("utf-8"))


def check_ascii_keys_and_cjk(node, fname, key="", in_info=False):
    """规则 10：字段名 ASCII；中文仅限文本内容字段与 info 子树。"""
    if isinstance(node, dict):
        for k, v in node.items():
            if not RE_KEY_ASCII.match(k):
                err(fname, f"non-ASCII object key: {k!r}")
            check_ascii_keys_and_cjk(v, fname, k, in_info or k == "info")
    elif isinstance(node, list):
        for item in node:
            check_ascii_keys_and_cjk(item, fname, key, in_info)
    elif isinstance(node, str):
        if RE_CJK.search(node) and not (in_info or key in CJK_OK_KEYS):
            err(fname, f"CJK text in structural field {key!r}: {node!r}")


def check_path_syntax(path_str, fname, loop):
    """规则 6：path 语法合法；环线闭合。语法级检查（几何解析在 flatten.py）。"""
    s = path_str.strip()
    letters = re.sub(r"[\s,]", "", re.sub(RE_NUMBER, "", s))
    if not s or not letters or letters[0] not in "Mm" or not RE_PATH_LETTERS.match(letters):
        err(fname, "path is not valid SVG path syntax")
        return
    if loop and "Z" not in letters and "z" not in letters:
        err(fname, "loop line path is not closed (missing Z/z)")


def check_segmentation(d, fname, stops, loop):
    """规则 2：分段与状态（v1.5 起 sections 为一等实体）。

    fmt/line@2（schema v1.5）：
      sections: [{name: str（可空）, status: existing/approved/future}]，
                name 空字符串＝无名段，status 挂整段；
      segments: 整数数组，元素＝站间段 i（站 i→站 i+1；环线环绕段＝最后
                一个）所属 section 的 0-based 索引；
      约束（逐条校验）：
        - 长度公式：站数>=2 时非环线=站数-1、环线=站数（环绕段在末位）；
          站数<2 时 sections=[]/segments=[]、状态挂线路级 status；
        - 索引均为整数且不越界 [0, sections.length)；
        - 每段至少被 1 个 segment 引用（无空段）；
        - 同一 section 的 segments 沿站序连续成块；环线允许从 seg[n-1]
          绕回 seg[0] 成块（首尾同索引的两块视为一块）。
    fmt/line@1（旧版，segments 为状态字符串数组）：旧有规则（长度公式、
      枚举）照旧检查不误报，另加 WARN 提示在编辑器重存转换。
    线路级 status 规则两版一致：仅站数<2 时必填，站数>=2 必须为 null。
    """
    schema = d.get("schema")
    segs = d.get("segments")
    if not isinstance(segs, list):
        err(fname, "segments must be a list")
        segs = []

    if schema not in ("fmt/line@1", "fmt/line@2"):
        err(fname, f"unknown schema {schema!r} (want fmt/line@1 or fmt/line@2)")
        # 已有 ERROR 兜底，按元素类型尽力继续：整数索引按 @2 查、字符串按 @1 查
        schema = ("fmt/line@2"
                  if any(isinstance(v, int) and not isinstance(v, bool) for v in segs)
                  else "fmt/line@1")

    # 长度公式：@2 站数<2 一律空数组（状态挂线路级）；@1 维持旧公式
    # （环线=站数，含 1 站环线的旧账），不改旧格式文件的判定
    if schema == "fmt/line@1" or len(stops) >= 2:
        expect = len(stops) if loop else max(len(stops) - 1, 0)
    else:
        expect = 0
    if len(segs) != expect:
        err(fname, f"segments length {len(segs)} != expected {expect} (stops={len(stops)}, loop={loop})")

    if schema == "fmt/line@1":
        warn(fname, "旧版 line@1：请在编辑器载入并重存转换为 @2")
        for i, sv in enumerate(segs):
            if sv not in SEG_STATUS:
                err(fname, f"segments[{i}] bad status: {sv!r} (want one of {sorted(SEG_STATUS)})")
    else:
        # ---- fmt/line@2：sections 结构 ----
        sections = d.get("sections")
        if sections is None:
            sections = []
        elif not isinstance(sections, list):
            err(fname, "sections must be a list")
            sections = []
        for k, sec in enumerate(sections):
            if not isinstance(sec, dict):
                err(fname, f"sections[{k}] must be an object")
                continue
            if not isinstance(sec.get("name", ""), str):
                err(fname, f"sections[{k}]: name must be a string (empty allowed), got {sec.get('name')!r}")
            if sec.get("status") not in SEG_STATUS:
                err(fname, f"sections[{k}]: bad status: {sec.get('status')!r} (want one of {sorted(SEG_STATUS)})")

        # ---- 索引整数性与越界 ----
        nsec = len(sections)
        for i, sv in enumerate(segs):
            if not isinstance(sv, int) or isinstance(sv, bool):
                err(fname, f"segments[{i}] must be an integer section index, got {sv!r}")
            elif not (0 <= sv < nsec):
                err(fname, f"segments[{i}]: section index {sv} out of range [0,{nsec})")

        # ---- 空段 / 空表约束 ----
        if len(stops) >= 2:
            if nsec == 0:
                err(fname, "line with >=2 stops must have >=1 section (sections is empty)")
        elif nsec:
            err(fname, "line with <2 stops must have empty sections (status belongs to line level)")
        used = {sv for sv in segs if isinstance(sv, int) and not isinstance(sv, bool)}
        for k in range(nsec):
            if k not in used:
                nm = sections[k].get("name") if isinstance(sections[k], dict) else None
                err(fname, f"section {k} ({nm!r}) 未被任何 segment 引用（空段）")

        # ---- 分离块：同一 section 的占有须沿站序连续 ----
        # 实现：segments 游程编码（RLE）后每个索引至多一个游程；
        # 环线先把首尾同索引的两个游程合并（seg[n-1] 绕回 seg[0] 成块），
        # 再查重复——例如环线 [1,0,1] 合法（1 占环绕弧）、非环线 [0,1,0] 非法。
        if segs and all(isinstance(sv, int) and not isinstance(sv, bool) for sv in segs):
            runs = []  # [sectionIndex, 起始 segment 位序, 游程长]
            for i, sv in enumerate(segs):
                if runs and runs[-1][0] == sv:
                    runs[-1][2] += 1
                else:
                    runs.append([sv, i, 1])
            if loop and len(runs) >= 2 and runs[0][0] == runs[-1][0]:
                runs[0][1] = runs[-1][1]   # 合并块起点取环绕段一侧
                runs[0][2] += runs[-1][2]
                runs.pop()
            blocks = {}  # sectionIndex -> [(起始, 长度)]
            for v, s, c in runs:
                blocks.setdefault(v, []).append((s, c))
            for v, spans in blocks.items():
                if len(spans) > 1:
                    desc = "、".join(f"[{s}..{s + c - 1}]" for s, c in spans)
                    err(fname, f"section {v} 的 segments 分离成 {len(spans)} 块（{desc}），须沿站序连续成块")

    # ---- 线路级 status（两版一致，规则不变）----
    status = d.get("status")
    if len(stops) < 2:
        if status not in SEG_STATUS:
            err(fname, f"line with <2 stops must set line-level status, got {status!r}")
    elif status is not None:
        err(fname, f"line-level status must be null when stops >= 2, got {status!r}")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        # v1.5 起新增中文文案：统一 UTF-8 输出，避免 Windows 管道/重定向下
        # 落到 ANSI 代码页（同 flatten.py 的处理）
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("data")
    if not target.is_dir():
        print(f"FAIL: target directory not found: {target}")
        return 1

    lines_dir = target / "lines"
    line_files = sorted(lines_dir.glob("l*.json")) if lines_dir.is_dir() else []
    print(f"Validating: {target}  ({len(line_files)} line files)")

    lines = {}         # line id -> data
    all_stop_ids = {}  # stop id -> line id
    stop_kinds = {}    # stop id -> kind（普通站为 None）

    # ---------- 线路文件 ----------
    for lf in line_files:
        fname = f"lines/{lf.name}"
        try:
            d = load_json(lf)
        except Exception as e:
            err(fname, f"cannot parse JSON: {e}")
            continue
        check_ascii_keys_and_cjk(d, fname)

        # 规则 1：id
        lid = d.get("id")
        if not isinstance(lid, str) or not RE_LINE_ID.match(lid):
            err(fname, f"bad line id: {lid!r}")
            continue
        if lid != lf.stem:
            err(fname, f"id {lid} does not match file name {lf.stem}")
        if lid in lines:
            err(fname, f"duplicate line id: {lid}")
            continue
        lines[lid] = d

        # 规则 5：role / groupId / connects
        role = d.get("role")
        if role not in ROLES:
            err(fname, f"bad role: {role!r}")
            role = None
        gid = d.get("groupId")
        if role in ("main", "branch") and not gid:
            err(fname, f"role {role} requires a groupId")
        if gid is not None and not RE_LINEGROUP_ID.match(gid or ""):
            err(fname, f"bad groupId: {gid!r}")
        connects = d.get("connects")
        if role == "connector":
            if not isinstance(connects, list) or len(connects) < 2:
                err(fname, "connector requires connects with >= 2 line ids")
        elif connects != []:
            err(fname, f"non-connector line must have empty connects, got {connects!r}")

        # 规则 7：color
        if not RE_COLOR.match(d.get("color") or ""):
            err(fname, f"bad color: {d.get('color')!r} (want #RRGGBB)")

        # 规则 6：path
        path_str = d.get("path")
        if not isinstance(path_str, str) or not path_str.strip():
            err(fname, "empty path")
        else:
            check_path_syntax(path_str, fname, bool(d.get("loop")))

        # 规则 3：stops / t / 站名
        stops = d.get("stops")
        if not isinstance(stops, list):
            err(fname, "stops must be a list")
            stops = []
        prev_t = None
        for st in stops:
            sid = st.get("id")
            if not isinstance(sid, str) or not RE_STOP_ID.match(sid):
                err(fname, f"bad stop id: {sid!r}")
            elif not sid.startswith(lid + "-s"):
                err(fname, f"stop id {sid} does not belong to line {lid}")
            elif sid in all_stop_ids:
                err(fname, f"duplicate stop id: {sid} (also in {all_stop_ids[sid]})")
            else:
                all_stop_ids[sid] = lid
                stop_kinds[sid] = st.get("kind")
            kind = st.get("kind")
            if kind is not None and kind not in STOP_KINDS:
                err(fname, f"stop {sid}: bad kind {kind!r} (only 'block' allowed)")
            if kind != "block" and (not isinstance(st.get("name"), str) or not st.get("name", "").strip()):
                err(fname, f"stop {sid}: empty name")
            t = st.get("t")
            if not isinstance(t, (int, float)) or not (0 <= t <= 1):
                err(fname, f"stop {sid}: t out of range [0,1]: {t!r}")
            elif prev_t is not None and t <= prev_t:
                err(fname, f"stop {sid}: t not strictly increasing ({prev_t} -> {t})")
            else:
                prev_t = t
            geo = st.get("geo")
            if geo is not None and (not isinstance(geo, list) or len(geo) != 2):
                err(fname, f"stop {sid}: geo must be null or [lon, lat]")

        # 规则 2：sections / segments / status（v1.5 分段一等实体；@1 兼容 WARN）
        check_segmentation(d, fname, stops, bool(d.get("loop")))

        # meta
        meta = d.get("meta")
        if not isinstance(meta, dict) or not isinstance(meta.get("archived"), bool):
            warn(fname, "meta.archived missing or not boolean")

    # ---------- groups.json ----------
    groups_path = target / "groups.json"
    line_group_ids = set()
    if not groups_path.is_file():
        err("groups.json", "file not found")
    else:
        try:
            g = load_json(groups_path)
        except Exception as e:
            err("groups.json", f"cannot parse JSON: {e}")
            g = {}
        check_ascii_keys_and_cjk(g, "groups.json")
        for lg in g.get("lineGroups") or []:
            lgid = lg.get("id")
            if not RE_LINEGROUP_ID.match(lgid or ""):
                err("groups.json", f"bad lineGroup id: {lgid!r}")
            else:
                line_group_ids.add(lgid)
            for m in lg.get("members") or []:
                if m not in lines:
                    err("groups.json", f"lineGroup {lgid}: unknown member line {m!r}")
        seen_stop = {}
        for sg in g.get("stationGroups") or []:
            sgid = sg.get("id")
            if not RE_GROUP_ID.match(sgid or ""):
                err("groups.json", f"bad stationGroup id: {sgid!r}")
            members = sg.get("stops") or []
            if len(members) < 2:
                err("groups.json", f"stationGroup {sgid}: needs >= 2 stops")
            for sid in members:
                if sid not in all_stop_ids:
                    err("groups.json", f"stationGroup {sgid}: unknown stop {sid!r}")
                elif sid in seen_stop:
                    err("groups.json", f"stop {sid} in two stationGroups ({seen_stop[sid]}, {sgid})")
                else:
                    seen_stop[sid] = sgid
            if sg.get("type") is not None and sg.get("type") not in GROUP_TYPES:
                err("groups.json", f"stationGroup {sgid}: bad type {sg.get('type')!r}")
            n_blk = sum(1 for sid in members if stop_kinds.get(sid) == "block")
            if n_blk and sg.get("type") != "junction":
                err("groups.json", f"stationGroup {sgid}: contains block stop(s) but type is not 'junction'")
            if 0 < n_blk < len(members):
                err("groups.json", f"stationGroup {sgid}: block and normal stops cannot be mixed")

    # ---------- 线路 ↔ 组/联络 引用交叉检查 ----------
    for lid, d in lines.items():
        gid = d.get("groupId")
        if gid is not None and gid not in line_group_ids:
            err(f"lines/{lid}.json", f"groupId {gid} not found in groups.json")
        for c in d.get("connects") or []:
            if c not in lines:
                err(f"lines/{lid}.json", f"connects target not found: {c!r}")

    # ---------- manifest.json ----------
    mf_path = target / "manifest.json"
    if not mf_path.is_file():
        err("manifest.json", "file not found")
    else:
        try:
            mf = load_json(mf_path)
            check_ascii_keys_and_cjk(mf, "manifest.json")
            mlines = {e.get("id"): e for e in mf.get("lines") or []}
            if set(mlines) != set(lines):
                err("manifest.json", f"manifest lines {sorted(mlines)} != data lines {sorted(lines)}")
            for a in mf.get("archived") or []:
                if a in lines:
                    err("manifest.json", f"archived id {a} is also an active line (id reuse forbidden)")
            for e in mf.get("lines") or []:
                lid = e.get("id")
                if lid in lines and isinstance(e.get("stops"), int):
                    actual = len(lines[lid].get("stops") or [])
                    if e["stops"] != actual:
                        warn("manifest.json", f"line {lid}: manifest stop count {e['stops']} != actual {actual}")
        except Exception as e:
            err("manifest.json", f"cannot parse JSON: {e}")

    # 规则 8：字形子集检查（make_glyphs.py 建立后启用）
    warn("__main__", "glyph subset check not enabled yet (waits for tools/make_glyphs.py)")

    # ---------- 汇总 ----------
    print(f"\nlines: {len(lines)}, stops: {len(all_stop_ids)}, "
          f"lineGroups: {len(line_group_ids)}")
    if warnings:
        print(f"\nWarnings ({len(warnings)}):")
        print("\n".join(warnings))
    if errors:
        print(f"\nFAIL - {len(errors)} error(s):")
        print("\n".join(errors))
        return 1
    print("\nPASS - all checks OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
