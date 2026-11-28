#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据校验器 —— 执行《架构方案-01》§1.7 的校验规则（v1.5）。

用法：
    python tools/validate.py [目标目录]     # 默认 data

退出码：0 = 通过；1 = 存在 ERROR。
输出文案：存量规则为英文；v1.5 分段（fmt/line@2）相关新文案为中文；
stationGroups 嵌套组（可选字段 groups，2026-11-23 增补——架构方案 §1.3 增补）
的文案沿用英文小写句式。
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
STOP_KINDS = {"block", "arrow"}  # v1.4 线路所 block；v1.5 出省箭头 arrow（kind 缺省＝普通站）

RE_LINE_ID = re.compile(r"^l\d{4}$")
RE_STOP_ID = re.compile(r"^l\d{4}-s\d{2,}$")
RE_GROUP_ID = re.compile(r"^g\d{4}$")
RE_LINEGROUP_ID = re.compile(r"^lg\d{2,}$")
RE_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")
RE_KEY_ASCII = re.compile(r"^[A-Za-z0-9_-]+$")
RE_NUMBER = re.compile(r"-?\d*\.?\d+(?:[eE][+-]?\d+)?")
RE_PATH_LETTERS = re.compile(r"^[MmZzLlHhVvCcSsQqTtAa]+$")
RE_CJK = re.compile(r"[一-鿿　-〿＀-￯]")

# 允许含中文的字段（文本内容）；info 子树整体放宽。
# layer＝源图 Line 直属子图层名原样转写（v1.4 meta.layer 自动继承 import 的 layer 字段，
# 值恒为用户源图词汇「市域线/市区线/联络线/预控通道/他省」），与 sourceLayer 同性质豁免
CJK_OK_KEYS = {"name", "note", "sourceLayer", "aliases", "layer"}

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


def manifest_line_path(data_dir, entry):
    """Return the same line file the validator scans and flatten reads."""
    lid = entry.get("id") if isinstance(entry, dict) else None
    if not isinstance(lid, str) or not RE_LINE_ID.fullmatch(lid):
        raise ValueError(f"bad manifest line id: {lid!r}")
    expected = Path("lines", f"{lid}.json")
    file = entry.get("file")
    if not isinstance(file, str) or Path(file.replace("\\", "/")) != expected:
        raise ValueError(f"line {lid}: file must point to {expected.as_posix()}, got {file!r}")
    path = data_dir / expected
    if not path.is_file():
        raise ValueError(f"line {lid}: file {expected.as_posix()} not found")
    return path


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
    # sharedTracks（2026-11-27 方案 A：共线共轨标注，如 3/4 号线虹桥路~宝山路）：
    # 线文件顶层可选字段 [{peer: 对方线 id, stops: [本线起站 id, 本线止站 id]}]，双侧各自标注。
    # 结构校验在逐线循环内（下方）；跨线对称性（A 标 B 则 B 标 A 且范围一致）须全表
    # 收集后查——见「线路 ↔ 组/联络 引用交叉检查」段的 sharedTracks 对称检查。
    # 收集口径：peer 格式合法且非自身的声明（结构有错也收，对称段自会防御跳过）。
    shared_decls = {}   # line id -> [(peer, stops)]（文件声明序）

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

        # 规则 7：color（2026-11-22 用户裁定：联络线取消颜色属性——颜色由 connects
        # 两端线决定：查看器渲染为双端渐变，信息不全时深灰兜底；flatten 侧输出色
        # 固定 #555555、站圈描边取最近端目标线色）。connector 带 color 即报错
        #（缺失或空串均合法）；非 connector 仍必填 #RRGGBB
        if role == "connector":
            if d.get("color"):
                err(fname, "connector must not define color (color is derived from connects)")
        elif not RE_COLOR.match(d.get("color") or ""):
            err(fname, f"bad color: {d.get('color')!r} (want #RRGGBB)")

        # 规则 6：path
        path_str = d.get("path")
        if not isinstance(path_str, str) or not path_str.strip():
            err(fname, "empty path")
        else:
            check_path_syntax(path_str, fname, bool(d.get("loop")))

        # 规则 3：stops / t / 站名（loop 供 arrow 端点约束与规则 2 复用）
        loop = bool(d.get("loop"))
        stops = d.get("stops")
        if not isinstance(stops, list):
            err(fname, "stops must be a list")
            stops = []
        prev_t = None
        for idx, st in enumerate(stops):
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
            if "status" in st and st.get("status") not in SEG_STATUS:
                err(fname, f"stop {sid}: bad status {st.get('status')!r} (want one of {sorted(SEG_STATUS)})")
            if kind is not None and kind not in STOP_KINDS:
                err(fname, f"stop {sid}: bad kind {kind!r} (want one of {sorted(STOP_KINDS)})")
            # 站名必填仅对普通站（kind 缺省）；block / arrow 名可空
            if kind not in STOP_KINDS and (not isinstance(st.get("name"), str) or not st.get("name", "").strip()):
                err(fname, f"stop {sid}: empty name")
            # v1.5 出省箭头：仅非环线的首站（下标 0）或尾站（最末）可为 arrow；
            # 环线（无端点）与中间位置均非法。@1/@2 同查。
            if kind == "arrow":
                if loop:
                    err(fname, f"stop {sid}: kind 'arrow' 不允许出现在环线（出省箭头只在非环线端点）")
                elif idx not in (0, len(stops) - 1):
                    err(fname, f"stop {sid}: kind 'arrow' 只允许在首站或尾站"
                               f"（当前为第 {idx + 1} 站，共 {len(stops)} 站）")
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
        check_segmentation(d, fname, stops, loop)

        # sharedTracks（2026-11-27 方案 A：共线共轨标注）结构校验——可选、数组、
        # 每项 peer 是合法线 id 格式（≠自身、同 peer 至多一条）、stops 恰 2 个且
        # 都是**本线**站 id 且两站不同。跨线对称性（peer 存在＋双侧范围一致）在
        # 全表收集后的交叉检查段查（此处只见本线）。connector 线禁用（联络线＝
        # 技术线路，双线渲染不适用；其线身走渐变层、不进共线双线体系）。
        shared = d.get("sharedTracks")
        if shared is not None:
            if role == "connector":
                err(fname, "connector lines must not declare sharedTracks")
            if not isinstance(shared, list):
                err(fname, "sharedTracks must be a list")
                shared = []
            seen_peers = set()
            for k, sh in enumerate(shared):
                if not isinstance(sh, dict):
                    err(fname, f"sharedTracks[{k}] must be an object")
                    continue
                peer = sh.get("peer")
                if not isinstance(peer, str) or not RE_LINE_ID.match(peer):
                    err(fname, f"sharedTracks[{k}]: bad peer line id: {peer!r}")
                elif peer == lid:
                    err(fname, f"sharedTracks[{k}]: peer must not be the line itself")
                elif peer in seen_peers:
                    err(fname, f"sharedTracks[{k}]: duplicate sharedTracks entry for peer {peer}")
                else:
                    seen_peers.add(peer)
                    shared_decls.setdefault(lid, []).append((peer, sh.get("stops")))
                sids = sh.get("stops")
                if not isinstance(sids, list) or len(sids) != 2:
                    err(fname, f"sharedTracks[{k}]: stops must be a list of exactly 2 stop ids")
                else:
                    for sid in sids:
                        if not isinstance(sid, str) or not RE_STOP_ID.match(sid):
                            err(fname, f"sharedTracks[{k}]: bad stop id: {sid!r}")
                        elif all_stop_ids.get(sid) != lid:
                            err(fname, f"sharedTracks[{k}]: stop {sid} does not belong to line {lid}")
                    if isinstance(sids[0], str) and sids[0] == sids[1]:
                        err(fname, f"sharedTracks[{k}]: stops must be two distinct stop ids")

        # meta
        meta = d.get("meta")
        if not isinstance(meta, dict) or not isinstance(meta.get("archived"), bool):
            warn(fname, "meta.archived missing or not boolean")

    # ---------- groups.json ----------
    groups_path = target / "groups.json"
    line_group_ids = set()
    # groups.json 缺失时下面 else 不跑，这两个表兜底为空（sharedTracks 对称检查引用）
    seen_stop = {}   # stop id -> 直属组 id
    parent_of = {}   # 子组 id -> 父组 id（最外层归并用）
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
        group_ids = set()   # 全部节点组 id（子组引用存在性用——子组可定义在父组之后，故先收集后查）
        dup_reported = set()  # 已报过的重复 stationGroup id（每个重复 id 只报一条）
        group_refs = []     # [(父组 id, 子组 id 列表)]：父属唯一／无环检查用
        for sg in g.get("stationGroups") or []:
            sgid = sg.get("id")
            if not RE_GROUP_ID.match(sgid or ""):
                err("groups.json", f"bad stationGroup id: {sgid!r}")
            if isinstance(sgid, str):
                if sgid in group_ids:
                    # id 重复（2026-11-23 裁定补查——嵌套后父子引用依赖 id 唯一）：每个重复
                    # id 只报一条；重复记录整条跳过（同线路 id 重复的既有做法），其 stops/
                    # groups 不参与成员/父子/环校验，免连锁误报——以首次出现的记录为准
                    if sgid not in dup_reported:
                        err("groups.json", f"duplicate stationGroup id: {sgid}")
                        dup_reported.add(sgid)
                    continue
                group_ids.add(sgid)   # 格式不合格的 id 已报错，仍收进来免得其子组再报「不存在」
            members = sg.get("stops") or []
            # 嵌套组（2026-11-23 增补）：可选字段 groups＝子组 id 列表（缺省视为 []）；
            # stops 仍是本组的**直属**设站，外层组 type＝直属站与每个子组（整体）之间的关系。
            # 非数组同 sections 的既有处理：报错并按 [] 继续查
            sub_groups = sg.get("groups")
            if sub_groups is None:
                sub_groups = []
            elif not isinstance(sub_groups, list):
                err("groups.json", f"stationGroup {sgid}: groups must be a list of stationGroup ids")
                sub_groups = []
            sub_ok = []      # 合法且不重复的子组 id（保持文件顺序）
            for c in sub_groups:
                if not isinstance(c, str):
                    err("groups.json", f"stationGroup {sgid}: bad groups entry: {c!r}")
                elif c in sub_ok:
                    err("groups.json", f"stationGroup {sgid}: duplicate groups entry: {c!r}")
                else:
                    sub_ok.append(c)
                    if c == sgid:
                        err("groups.json", f"stationGroup {sgid}: cannot list itself in groups")
            group_refs.append((sgid, sub_ok))
            # 成员单位总数（直属站数＋子组数）≥ 2：嵌套后直属站可为 0（只有子组）
            if len(members) + len(sub_ok) < 2:
                err("groups.json",
                    f"stationGroup {sgid}: needs >= 2 members (direct stops + child groups)")
            for sid in members:
                if sid not in all_stop_ids:
                    err("groups.json", f"stationGroup {sgid}: unknown stop {sid!r}")
                elif sid in seen_stop:
                    err("groups.json", f"stop {sid} in two stationGroups ({seen_stop[sid]}, {sgid})")
                else:
                    seen_stop[sid] = sgid
            if sg.get("type") is not None and sg.get("type") not in GROUP_TYPES:
                err("groups.json", f"stationGroup {sgid}: bad type {sg.get('type')!r}")
            # shape（2026-11-23 增补）：显式画法强制，现行仅 same-station 组可写 "pill"
            # （平行线双线站大圆悬浮对策；不写＝按线数自动）
            shape = sg.get("shape")
            if shape is not None:
                if shape != "pill":
                    err("groups.json", f"stationGroup {sgid}: bad shape {shape!r} (only 'pill')")
                if sg.get("type") != "same-station":
                    err("groups.json",
                        f"stationGroup {sgid}: shape only allowed on same-station groups")
            n_blk = sum(1 for sid in members if stop_kinds.get(sid) == "block")
            if n_blk and sg.get("type") != "junction":
                err("groups.json", f"stationGroup {sgid}: contains block stop(s) but type is not 'junction'")
            if 0 < n_blk < len(members):
                err("groups.json", f"stationGroup {sgid}: block and normal stops cannot be mixed")

        # ---------- 嵌套组引用（全表收集后查：子组可定义在父组之后）----------
        parent_of = {}   # 子组 id -> 父组 id（至多一个）
        for sgid, subs in group_refs:
            for c in subs:
                if c not in group_ids:
                    err("groups.json", f"stationGroup {sgid}: unknown stationGroup {c!r} in groups")
                elif c in parent_of and parent_of[c] != sgid:
                    # 同一父组内重复列出已由 duplicate groups entry 报过，此处不重复
                    err("groups.json",
                        f"stationGroup {c} in two stationGroups as a child ({parent_of[c]}, {sgid})")
                elif c != sgid:
                    parent_of[c] = sgid   # 自引已单独报错，不入父链（免得环检查再报一遍）
        # 无环：自子组沿父链上溯，回到本次走查已过的组即成环；已查明的无环节点
        # 记入 done 不再重走，每个环只报一次
        done = set()
        for start in parent_of:
            path, on_path = [], set()
            cur = start
            while cur in parent_of and cur not in done:
                if cur in on_path:
                    cyc = path[path.index(cur):] + [cur]
                    err("groups.json", "stationGroup cycle (child -> parent): "
                        + " -> ".join(str(x) for x in cyc))
                    break
                path.append(cur)
                on_path.add(cur)
                cur = parent_of[cur]
            done.update(path)

    # ---------- 线路 ↔ 组/联络 引用交叉检查 ----------
    for lid, d in lines.items():
        gid = d.get("groupId")
        if gid is not None and gid not in line_group_ids:
            err(f"lines/{lid}.json", f"groupId {gid} not found in groups.json")
        for c in d.get("connects") or []:
            if c not in lines:
                err(f"lines/{lid}.json", f"connects target not found: {c!r}")

    # ---------- sharedTracks 跨线对称检查（2026-11-27 方案 A） ----------
    # A 标 B ⇒ B 必须标 A 且范围一致。范围一致性口径＝**共线范围站序列比对**：
    # 把 A 声明范围（含两端站，沿站序 stops[0] → stops[1]；环线 i>j 跨环绕段走
    # 站序前进弧，非环线反向声明视作同一闭区间）内每站映射到其所属 stationGroup
    # 的**最外层**组 id（沿 parent_of 上溯；无组＝该站自身不可跨线归并），B 侧同；
    # 两侧序列相等或互为反转（行进方向相反）＝范围一致。站序列一致 ⇔ 端点一致
    #（同一线内范围由两端唯一确定），环线互补弧靠序列长度/内容区分。任一站未
    # 编组（无法跨线归并）则该对范围比对降级为存在性检查、不报错——编组完备性
    # 由用户数据侧保证，validate 不强求；**绝不按站名归并**（用户明令）。
    def shared_node_seq(lid_, sids):
        """声明范围站 id 序列 → 最外层组 id 序列；结构坏/定位失败/含未编组站返回 None。"""
        if not isinstance(sids, list) or len(sids) != 2:
            return None
        ldata = lines.get(lid_) or {}
        lstops = ldata.get("stops") or []
        idx_of = {st.get("id"): k for k, st in enumerate(lstops) if isinstance(st, dict)}
        i, j = idx_of.get(sids[0]), idx_of.get(sids[1])
        if i is None or j is None or i == j:
            return None
        n = len(lstops)
        if ldata.get("loop"):
            order = list(range(i, j + 1)) if i < j else list(range(i, n)) + list(range(0, j + 1))
        else:
            a, b = (i, j) if i < j else (j, i)
            order = list(range(a, b + 1))
        seq = []
        for k in order:
            g = seen_stop.get(lstops[k].get("id"))
            if g is None:
                return None
            top = g
            seen = set()
            while top in parent_of and top not in seen:
                seen.add(top)
                top = parent_of[top]
            seq.append(top)
        return seq

    for lid, decls in shared_decls.items():
        for peer, sids in decls:
            if peer not in lines:
                err(f"lines/{lid}.json", f"sharedTracks peer not found: {peer!r}")
                continue
            back = [b for b in shared_decls.get(peer, []) if b[0] == lid]
            if not back:
                err(f"lines/{lid}.json",
                    f"sharedTracks peer {peer} does not declare {lid} back (must be bilateral)")
                continue
            seq_a = shared_node_seq(lid, sids)
            seq_b = shared_node_seq(peer, back[0][1])
            if seq_a is not None and seq_b is not None \
                    and seq_a != seq_b and seq_a != seq_b[::-1]:
                err(f"lines/{lid}.json",
                    f"sharedTracks range mismatch with {peer}: {lid} covers "
                    f"{' -> '.join(seq_a)}, {peer} covers {' -> '.join(seq_b)}")

    # ---------- manifest.json ----------
    mf_path = target / "manifest.json"
    if not mf_path.is_file():
        err("manifest.json", "file not found")
    else:
        try:
            mf = load_json(mf_path)
            check_ascii_keys_and_cjk(mf, "manifest.json")
            entries = mf.get("lines", [])
            if not isinstance(entries, list):
                err("manifest.json", "lines must be a list")
                entries = []
            mlines = {}
            for entry in entries:
                try:
                    manifest_line_path(target, entry)
                except ValueError as e:
                    err("manifest.json", str(e))
                    continue
                lid = entry["id"]
                if lid in mlines:
                    err("manifest.json", f"duplicate manifest line id: {lid}")
                mlines[lid] = entry
            # 归档线（编辑器「归档」）：文件保留在 lines/（meta.archived=true），不进 manifest.lines、
            # 须列入 manifest.archived，flatten/publish 剔除。active＝未归档的线路文件——
            # manifest 对账只比 active（此前把归档文件也算在用线，归档过的数据集必 FAIL）
            archived_files = {lid for lid, d in lines.items()
                              if (d.get("meta") or {}).get("archived") is True}
            active_files = set(lines) - archived_files
            mf_archived = {a for a in (mf.get("archived") or []) if isinstance(a, str)}
            if set(mlines) != active_files:
                err("manifest.json", f"manifest lines {sorted(mlines)} != active data lines {sorted(active_files)}")
            for a in mf.get("archived") or []:
                if a in active_files:
                    err("manifest.json", f"archived id {a} is also an active line (id reuse forbidden)")
            for a in sorted(archived_files):
                if a not in mf_archived:
                    err(f"lines/{a}.json", "archived line file is not listed in manifest.json archived")
            for lid, e in mlines.items():
                if lid in lines and isinstance(e.get("stops"), int):
                    actual = len(lines[lid].get("stops") or [])
                    if e["stops"] != actual:
                        warn("manifest.json", f"line {lid}: manifest stop count {e['stops']} != actual {actual}")
            # 可选字段 lineOrder（v1.5 增补，2026-11-22 需求 5）：查看器左栏显示顺序，
            # 线 id 数组；缺失＝回退 id 升序。结构校验（存在才查，不影响既有数据）：
            # 元素须为合法线 id 格式、不得重复；不在线路表/归档表中的 id 仅 WARN
            # （编辑器/flatten 侧自会忽略，防手改残留阻断发布链）
            lo = mf.get("lineOrder")
            if lo is not None:
                if not isinstance(lo, list):
                    err("manifest.json", "lineOrder must be a list of line ids")
                else:
                    arch_ids = {a for a in (mf.get("archived") or []) if isinstance(a, str)}
                    seen_lo = set()
                    for x in lo:
                        if not isinstance(x, str) or not RE_LINE_ID.match(x):
                            err("manifest.json", f"bad lineOrder entry: {x!r}")
                        elif x in seen_lo:
                            err("manifest.json", f"duplicate lineOrder entry: {x!r}")
                        else:
                            seen_lo.add(x)
                            if x not in lines and x not in arch_ids:
                                warn("manifest.json", f"lineOrder id {x} not found among lines (ignored)")
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
