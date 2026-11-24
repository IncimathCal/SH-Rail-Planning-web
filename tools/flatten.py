#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""flatten —— 录入数据 → 查看器 GeoJSON 派生工具（阶段 3 渲染数据源）。

把 data/ 下的录入成果（SVG 画板坐标的贝塞尔 path + 弧长参数 t 设站）经
data/calibration.json（fmt/calibration@2，model:"tps"）正变换，flatten 为
WGS84 经纬度 GeoJSON（MapLibre / Web 墨卡托可直接消费）：

  <out>/lines.geojson  线路×分段，每 feature 一条 LineString
                        properties: lineId / name / aliases / color / role /
                        layer / loop / connects / groupId / segIndex /
                        segStatus / sectionName
                        （sectionName＝所属分段名，空名段省略该键；
                        layer＝线路 meta.layer，中文值合法，查看器左栏
                        类别过滤用；connects＝联络线接轨对象线 id 列表，
                        仅 role:"connector" 线携带、其余线为空数组——
                        2026-11-22 用户需求 3：查看器聚焦时绑定联络线
                        沿线渐变透明的方向判定用；groupId＝线组归属 id，
                        无组为空字符串保持键齐——2026-11-22 主支线合并：
                        查看器归并判定与 index.json lineGroups 双向并集。
                        color：connector 固定 '#555555' 深灰兜底——2026-11-22
                        用户需求 2「取消联络线颜色属性」：真实颜色由 connects
                        两端线决定（查看器渲染为双端渐变，flatten 侧万一下游
                        漏剔也渲染成深灰而非无色），非 connector 照旧
                        line.color 优先、缺省兜底组色）
  <out>/stops.geojson  设站，每 feature 一个 Point
                        properties: sid / name / lineId / lineName / t /
                        groupId / groupType（connector 线的站额外携带
                        stroke＝最近端目标线色——2026-11-22 用户需求 2：
                        站圈描边不再用线体深灰，取 connects 各目标线全部
                        加密坐标到本站的平面最近者的取色；有效目标 <2 条
                        时深灰兜底）；出省箭头（v1.5 kind:"arrow"，
                        非真正站点）保留输出并额外带 kind:"arrow" 键，
                        普通站不写该键（geo 定位与其他站同口径）；
                        kind:"block"（线路所）整条剔除——正式网页隐藏。
  <out>/stops.geojson  设站，每 feature 一个 Point
                        properties: sid / name / lineId / lineName / t /
                        groupId / groupType；出省箭头（v1.5 kind:"arrow"，
                        非真正站点）保留输出并额外带 kind:"arrow" 键，
                        普通站不写该键（geo 定位与其他站同口径）；
                        kind:"block"（线路所）整条剔除——正式网页隐藏。
  <out>/index.json     查看器左栏线路显示顺序＋线组索引＋换乘节点组结构表
                        （net-index@3）：
                        {"fmt":"net-index@3","lineOrder":[线id,...],
                         "lineGroups":[{id,name,mainId,members}],
                         "stationGroups":[{id,type,stops,groups[,shape]}]}。
                        lineOrder 顺序来源＝<data>/manifest.json 可选字段
                        lineOrder（编辑器顶栏「排序」面板维护）：列出的线
                        在前（按其顺序），未列出的按现有顺序排后；数组为
                        实际输出线（归档线剔除后）的完整顺序。feature 产出
                        顺序同此序。lineGroups＝groups.json 线组的主支线
                        归并索引（2026-11-22 用户裁定：主线与支线在查看器
                        眼中恒为一条线）：归属＝双向并集（groups.json
                        members 声明 ＋ 线文件 groupId 指向，均限实际输出
                        线）；mainId＝并集成员中 role=="main" 的第一个
                        （members 声明序优先，其后按输出序）；无 main 的组
                        照样输出（mainId=null，成员供查看器防御——其侧判定
                        不合并，组员照旧独立显示）。线携带孤儿 groupId（组
                        记录不存在）无法得知组名，不产出组记录。@2 升版
                        原因：查看器对 fmt 有严格校验（=== 比对），加字段
                        随版本走。
                        stationGroups＝groups.json 全部换乘节点组的**原样
                        结构表**（@3，2026-11-23 嵌套组增补）：每项
                        {id, type, stops, groups[, shape]}——type 为 null 输出 null；
                        stops＝该组**直属**设站；groups＝子组 id 列表
                        （可选字段，缺省输出 []）；shape＝显式画法强制
                        （可选，现行仅 same-station 组的 "pill"，写了才透传，
                        2026-11-23 平行线双线站大圆悬浮对策）；不按归档线过滤，
                        如实反映 groups.json。设站经子组间接属于上层节点，
                        stops.geojson 的 groupId/groupType 仍只带直属组，
                        节点归属由消费端据本表自最外层组还原。消费端同步收
                        @1（旧快照）/@2/@3。
  <out>/lineinfo.md    线路信息面板（2026-11-23）：数据目录下用户手填的每线路
                        介绍（格式约定与模板见 data/lineinfo.md）**原样透传**
                        （字节级拷贝；不解析、不进 GeoJSON——解析在查看器侧
                        VIEWER_CORE.parseLineInfo）。数据目录无此文件则不产出
                        （查看器静默无信息节）。

复用（绝不重推导）：
  - tools/svg_parse.py  path_from_d（= parse_path + flatten + ArcPath）：
    path 解析、贝塞尔按平坦度容差自适应压平（FLAT_TOL=0.05 pt，段内加密
    即沿用该容差）、弧长参数化 point_at(t)；
  - tools/ge_convert.py  load_calibration / TpsTransform.forward：标定正变换
    (x,y)→(lon,lat)，纯标准库实现，公式与 src/editor.js 的 tpsForward 对拍过。

分段切分与 src/editor.js 的 renderWorld/segPathString 同口径：
  非环线 n 站 n-1 段（stops[i].t → stops[i+1].t）；
  环线 n 站 n 段，末段为环绕段（stops[n-1].t → stops[0].t，跨 1/0）；
  环线仅 1 站＝整条闭合路径；
  站数 < 2 的线（如零设站联络线）用线路级 status 输出整线单段。
状态派生（v1.5，fmt/line@2：分段一等实体）：
  站间段 i 的状态＝sections[segments[i]].status（segments[i] 为分段
  0-based 索引，非状态字符串），分段名写入 sectionName（空名省略）；
  站数 <2 时 sections/segments 必空，整线单段状态取线路级 status；
  段记录缺失（sections/segments 缺项）防御性兜底 "existing"。
  输入为 fmt/line@1 直接中文报错拒绝（不静默兼容），须先在编辑器
  载入重存为 @2。

线路清单：优先 <data>/manifest.json 的 lines[].file（剔除 archived 列表中的
线），无 manifest 则 glob <data>/lines/*.json；单线文件 meta.archived=true 剔除。
站点 geo 覆盖：stops[].geo 非 null 时为权威 [lon, lat]（schema §1.2 个别点位
精度兜底），直接采用；否则取 t 处点经 TPS 变换。

用法（项目根，Windows 下建议 -X utf8；publish.py 将以子进程调用）：
  python -X utf8 tools/flatten.py --data data --calib data/calibration.json --out build/net
"""

import argparse
import json
import math
import re
import sys
from pathlib import Path

# 复用同目录工具（svg_parse / ge_convert 均为纯标准库且 import 无副作用）
sys.path.insert(0, str(Path(__file__).resolve().parent))
from svg_parse import path_from_d  # noqa: E402
from ge_convert import load_calibration  # noqa: E402

# 经纬度输出小数位（7 位 ≈ 1 cm，远高于标定精度）
LONLAT_DECIMALS = 7


# ------------------------------------------------------------- 折线裁取 --

def polyline_between(ap, t1, t2):
    """弧长区间 [t1,t2] 内的折线点列（含两端插值点）。

    语义同 src/geom.js 的 ArcPath.polylineBetween（编辑器分段渲染共用逻辑）：
    t1 > t2 时视为环线环绕段，拆成 [t1,1] 与 [0,t2] 两截拼接。
    """
    if t1 > t2:
        return polyline_between(ap, t1, 1.0) + polyline_between(ap, 0.0, t2)
    out = [ap.point_at(t1)]
    s1, s2 = t1 * ap.length, t2 * ap.length
    # 二分定位 s1 所在子区间（与 point_at 同手法），收集其间整点
    lo, hi = 0, len(ap.cum) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if ap.cum[mid] <= s1:
            lo = mid
        else:
            hi = mid
    for i in range(lo + 1, len(ap.cum)):
        if ap.cum[i] >= s2:
            break
        out.append(ap.pts[i])
    out.append(ap.point_at(t2))
    return out


# ------------------------------------------------------------- 线路清单 --

def collect_line_files(data_dir):
    """线路文件清单：manifest.lines[].file 优先（剔除 archived），否则 glob。"""
    data = Path(data_dir)
    mf = data / "manifest.json"
    files = []
    if mf.is_file():
        mf_js = json.loads(mf.read_text(encoding="utf-8"))
        # archived 为 id 列表（防编号复用；兼容字典项取其 id）
        archived = {a if isinstance(a, str) else a.get("id")
                    for a in (mf_js.get("archived") or [])}
        for e in mf_js.get("lines") or []:
            lid = e.get("id")
            if lid in archived:
                # 归档表与线文件矛盾（线文件说未归档）：按未归档输出并提示，不替用户丢掉一条
                # 明明在用的线（2026-11-22 抓包：编辑器取消归档后没从归档表摘除，l0061 被
                # 整条剔除、查看器不见）。此时 validate 会报「archived id is also an active
                # line」——发布通道有 validate 把门，此处只是本地预览不静默丢线。
                try:
                    lp = data / e["file"]
                    live = not (json.loads(lp.read_text(encoding="utf-8")).get("meta") or {}).get("archived")
                except (OSError, ValueError, KeyError, TypeError):
                    live = False
                if not live:
                    continue
                print(f"警告：{lid} 同时列在 manifest.lines 与 manifest.archived（线文件为未归档）"
                      f"——按未归档输出；请在编辑器重新保存工作区（validate 会报错）")
            if e.get("file"):
                files.append(data / e["file"])
        if not files:
            print("警告：manifest.json 存在但 lines 为空（或全被剔除）")
    else:
        files = sorted((data / "lines").glob("*.json"))
    return files


def read_manifest_order(data_dir):
    """读 manifest.json 可选字段 lineOrder（查看器左栏显示顺序；线 id 数组）。
    缺失/非数组/无 manifest 返回 None（＝无自定义顺序，按现有顺序输出）。"""
    mf = Path(data_dir) / "manifest.json"
    if not mf.is_file():
        return None
    lo = json.loads(mf.read_text(encoding="utf-8")).get("lineOrder")
    if not isinstance(lo, list):
        return None
    return [x for x in lo if isinstance(x, str)]


def load_groups(data_dir):
    """读 groups.json → (线组色映射, 设站→节点组映射, 线组记录列表, 换乘节点组结构表)。缺文件则空。"""
    data = Path(data_dir)
    gp = data / "groups.json"
    if not gp.is_file():
        print("提示：未找到 groups.json，groupId/groupType 全为 null、组色兜底不可用")
        return {}, {}, [], []
    g = json.loads(gp.read_text(encoding="utf-8"))
    line_groups = [lg for lg in (g.get("lineGroups") or [])
                   if isinstance(lg, dict) and lg.get("id")]
    group_color = {lg.get("id"): lg.get("color") for lg in line_groups}
    stop_group = {}
    for sg in (g.get("stationGroups") or []):
        for sid in (sg.get("stops") or []):
            # 一设站至多一组（validate 门禁保证），此处重复时后者覆盖不致命
            stop_group[sid] = (sg.get("id"), sg.get("type"))
    # 换乘节点组结构表（index.json 顶层 stationGroups，net-index@3）：全部组原样输出
    # {id, type, stops（直属设站）, groups（子组 id，缺省 []）}，不按归档线过滤。
    # 嵌套组（2026-11-23）：设站经子组间接属于上层节点，消费端据本表自最外层组
    # 还原节点。非字典/无 id 的坏项跳过、非数组按 []（validate 门禁另行报错）
    station_groups = []
    for sg in (g.get("stationGroups") or []):
        if not isinstance(sg, dict) or not sg.get("id"):
            continue
        stops = sg.get("stops")
        subs = sg.get("groups")
        entry = {
            "id": sg["id"],
            "type": sg.get("type"),
            "stops": list(stops) if isinstance(stops, list) else [],
            "groups": list(subs) if isinstance(subs, list) else [],
        }
        # shape（2026-11-23）：显式画法强制（现行仅 same-station 组的 "pill"），写了才透传
        if sg.get("shape"):
            entry["shape"] = sg["shape"]
        station_groups.append(entry)
    return group_color, stop_group, line_groups, station_groups


# ------------------------------------------------------------- 单线展开 --

def flatten_line(line, ap, tps, group_color, stop_group, conn_target_index=None):
    """单条线路 → (分段 LineString feature 列表, 设站 Point feature 列表)。

    conn_target_index＝主流程预建的全局索引 {lid: {"pts": 画板加密坐标列表,
    "color": 非 connector 取色口径}}，供 connector 线的站圈描边查「connects
    指向的线」的几何与取色（2026-11-22 用户需求 2）；缺省 None＝该功能退化
    深灰兜底（不影响其余输出）。
    """
    lid = line.get("id")
    stops = line.get("stops") or []
    sections = line.get("sections") or []
    segs = line.get("segments") or []
    n = len(stops)
    loop = bool(line.get("loop"))
    meta = line.get("meta") or {}
    is_conn = line.get("role") == "connector"

    base_props = {
        "lineId": lid,
        "name": line.get("name") or "",
        "aliases": list(meta.get("aliases") or []),
        # 线路色：connector 固定 '#555555' 深灰兜底（2026-11-22 用户需求 2「取消
        # 联络线颜色属性」——真实颜色由 connects 两端线决定，查看器渲染双端渐变、
        # 此处兜底保证万一下游漏剔也渲染成深灰而非无色）；其余线优先取本线，
        # 缺省兜底线组色（schema：组色成员可继承）
        "color": "#555555" if is_conn
        else (line.get("color") or group_color.get(line.get("groupId"))),
        "role": line.get("role"),
        "layer": meta.get("layer"),   # 无则 null
        "loop": loop,
        # 联络线接轨对象（2026-11-22 用户需求 3：查看器聚焦渐变高亮用）。仅
        # role:"connector" 线在 schema 里携带（≥2 个线 id，无顺序语义——方向
        # 由查看器按几何最近端判定）；非联络线 get 落空 → 输出空数组保持键齐
        "connects": list(line.get("connects") or []),
        # 线组归属 id（2026-11-22 主支线合并：查看器归并用）。无组为空字符串
        # 保持键齐（沿用 connects 的做法——net 消费端不必判键存在）
        "groupId": line.get("groupId") or "",
    }

    def to_lonlat(x, y):
        lon, lat = tps.forward(x, y)
        return [round(lon, LONLAT_DECIMALS), round(lat, LONLAT_DECIMALS)]

    # ---- 分段区间（与 editor.js renderWorld 同口径）----
    # (t1, t2, segIndex, whole)：whole=True 表示整条路径（环线 1 站 / 站数<2）
    intervals = []
    if loop and n == 1:
        intervals.append((None, None, 0, True))
    elif n >= 2:
        for i in range(n if loop else n - 1):
            t1 = stops[i]["t"]
            t2 = stops[0]["t"] if (loop and i + 1 == n) else stops[i + 1]["t"]
            intervals.append((t1, t2, i, False))
    else:
        # 站数 <2（零设站联络线等）：线路级 status 出整线单段
        intervals.append((None, None, 0, True))

    line_feats = []
    for t1, t2, i, whole in intervals:
        pts = ap.pts if whole else polyline_between(ap, t1, t2)
        coords = [to_lonlat(x, y) for x, y in pts]
        if len(coords) < 2:
            print(f"警告：{lid} 段 {i} 折线点数不足 2，跳过")
            continue
        if whole:
            # 整线单段（环线 1 站 / 站数<2）：@2 下 sections/segments 必空，
            # 状态取线路级 status，缺省 existing
            status = line.get("status") or "existing"
            sec = None
        else:
            # 站间段 i 的状态＝所属 section 的 status（v1.5：segments[i] 为
            # section 的 0-based 索引）；记录缺失时防御性兜底 existing
            idx = segs[i] if i < len(segs) else None
            sec = (sections[idx]
                   if isinstance(idx, int) and 0 <= idx < len(sections)
                   and isinstance(sections[idx], dict) else None)
            status = (sec.get("status") if sec else None) or "existing"
        props = dict(base_props)
        props["segIndex"] = i
        props["segStatus"] = status
        # 分段名：空字符串/缺失省略该键（查看器信息面板按需读取）
        if sec and sec.get("name"):
            props["sectionName"] = sec["name"]
        line_feats.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    # ---- 设站（线路所 kind:"block" 整条剔除；出省箭头 kind:"arrow" 保留输出）----
    # 联络线站圈描边色（2026-11-22 用户需求 2）：取「最近端目标线色」——对
    # connects 中每个存在于本次数据的线，算其全部加密 arc 坐标（画板系，主流程
    # 预建索引）到本站坐标的平面距离，取最近者的取色（取色逻辑＝非 connector
    # 的现有口径：line.color or 组色）。有效目标线 <2 条（或本线 connects<2）
    # → 深灰兜底 '#555555'（与线体兜底一致——「信息未填写完全时显示深灰色」）。
    # 本站坐标用 t 处画板点（point_at）：geo 权威覆盖的站也按此近似——stroke
    # 只是视觉建议层，TPS 画板→经纬度非线性对「哪条线更近」的判定几乎无影响
    #（geo 覆盖本身极罕见）。
    def conn_stop_stroke(t_val):
        connects = [c for c in (line.get("connects") or []) if isinstance(c, str)]
        targets = [conn_target_index[c] for c in connects
                   if conn_target_index and c in conn_target_index]
        if len(connects) < 2 or len(targets) < 2:
            return "#555555"
        px, py = ap.point_at(t_val)
        best, best_d = None, None
        for tgt in targets:
            for tx, ty in tgt["pts"]:
                d = (px - tx) ** 2 + (py - ty) ** 2
                if best_d is None or d < best_d:
                    best_d, best = d, tgt
        return (best or {}).get("color") or "#555555"

    stop_feats = []
    for stop_index, st in enumerate(stops):
        if st.get("kind") == "block":
            continue
        geo = st.get("geo")
        if geo:
            lon, lat = float(geo[0]), float(geo[1])   # 权威覆盖值
        else:
            lon, lat = to_lonlat(*ap.point_at(st["t"]))
        gid, gtype = stop_group.get(st["id"], (None, None))
        props = {
            "sid": st["id"],
            "stopIndex": stop_index,
            "name": st.get("name") or "",
            "lineId": lid,
            "lineName": line.get("name") or "",
            "t": st["t"],
            "groupId": gid,
            "groupType": gtype,
        }
        # 出省箭头（v1.5，非真正站点）：仅 arrow 写 kind 键，普通站无该键
        if st.get("kind") == "arrow":
            props["kind"] = "arrow"
        # 站点级显式分期覆盖（缺省不写，消费端可继续沿用邻接区段语义）。
        if st.get("status") in ("existing", "approved", "future"):
            props["stopStatus"] = st["status"]
        # 联络线站圈描边＝最近端目标线色（仅 connector 线的站携带，见上注）
        if is_conn:
            props["stroke"] = conn_stop_stroke(st["t"])
        stop_feats.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "Point",
                         "coordinates": [round(lon, LONLAT_DECIMALS),
                                         round(lat, LONLAT_DECIMALS)]},
        })
    return line_feats, stop_feats


# ------------------------------------------------------------- 写出 --

def write_geojson(path, features):
    """FeatureCollection → 紧凑 JSON 文件（UTF-8 无 BOM）。"""
    out = {"type": "FeatureCollection", "features": features}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "\n",
                    encoding="utf-8")
    return path.stat().st_size


# ------------------------------------------------------------- 主流程 --

def default_calib(data_dir):
    """--calib 缺省：优先 <data>/calibration.json，取不到用 data/calibration.json。"""
    p = Path(data_dir) / "calibration.json"
    return str(p) if p.is_file() else "data/calibration.json"


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(
        prog="flatten.py",
        description="录入数据（SVG 画板坐标贝塞尔 path）→ 经标定 TPS 正变换 → "
                    "WGS84 GeoJSON（lines.geojson + stops.geojson）＋显示顺序索引 index.json，"
                    "供阶段 3 查看器渲染。")
    ap.add_argument("--data", default="data", help="权威数据目录（默认 data）")
    ap.add_argument("--calib", default=None,
                    help="标定 JSON 路径（默认 <data>/calibration.json，"
                         "取不到再 data/calibration.json；fmt/calibration@2 tps）")
    ap.add_argument("--out", default="build/net", help="输出目录（默认 build/net）")
    args = ap.parse_args()

    calib_path = args.calib or default_calib(args.data)
    tps = load_calibration(calib_path)          # 复用 ge_convert（含格式校验）
    group_color, stop_group, line_groups, station_groups = load_groups(args.data)

    line_feats, stop_feats = [], []
    n_archived = 0
    files = collect_line_files(args.data)
    if not files:
        sys.exit(f"错误：{args.data} 下未找到任何线路文件")
    # 先整体读入（含 schema/归档过滤），再按显示顺序排列——顺序影响 feature
    # 产出次序与 index.json，须在读入全部线 id 之后才能定序
    loaded = []   # [(Path, line)]
    for lf in files:
        line = json.loads(lf.read_text(encoding="utf-8"))
        if (line.get("meta") or {}).get("archived"):
            n_archived += 1
            continue
        # v1.5 分段一等实体：只消费 fmt/line@2；@1 明确报错拒绝（不静默兼容，
        # 也不自行猜测转换——编辑器载入重存才是权威转换通道）
        schema = line.get("schema")
        if schema == "fmt/line@1":
            sys.exit(f"错误：{lf.name} 为 line@1，请先在编辑器载入重存为 @2（v1.5 分段一等实体）")
        if schema != "fmt/line@2":
            sys.exit(f"错误：{lf.name} 的 schema {schema!r} 不是 fmt/line@2，拒绝处理")
        loaded.append((lf, line))

    # 显示顺序（查看器左栏序）：manifest.lineOrder 列出的线在前（按其顺序），
    # 未列出的按现有顺序排后（稳定排序保持 manifest 清单序/文件名序不变）
    manifest_order = read_manifest_order(args.data)
    if manifest_order:
        rank = {lid: i for i, lid in enumerate(manifest_order)}
        n_rank = len(rank)
        loaded.sort(key=lambda it: rank.get(it[1].get("id"), n_rank))

    emitted_order = []   # 实际输出线的 id 顺序（index.json 内容）

    # 第一遍：解析全部线路几何＋预建联络线目标索引（2026-11-22 用户需求 2）。
    # flatten_line 是逐线函数，而 connector 的站圈描边判定需查 connects 指向的
    # 线的全量几何与取色——故先统一解析（arc 复用第二遍），再二次遍历产出。
    # 索引取色口径＝非 connector 的现有逻辑（line.color or 组色，缺省深灰兜底）；
    # connector 线的 color 已在 schema 层禁写，若 connects 误指联络线，其索引色
    # 自然落组色或深灰，不炸。
    def parse_arc(line):
        # 空白规范化：svg_parse 的词法把空格误当命令字符（真实 AI 导出 d 串为
        # 压缩格式无空格，仅手写样张含空格），此处统一换成逗号——SVG path 语法
        # 中空白与逗号同为分隔符，语义等价且与 src/geom.js（忽略空白）口径一致
        d_norm = re.sub(r"\s+", ",", line["path"].strip())
        return path_from_d(d_norm)               # 解析+压平+弧长参数化（复用 svg_parse）

    arc_by_id = {}
    conn_target_index = {}
    for lf, line in loaded:
        lid = line.get("id")
        arc = parse_arc(line)
        arc_by_id[lid] = arc
        conn_target_index[lid] = {
            "pts": arc.pts,   # 画板系加密坐标（压平产物，站描边最近端判定用）
            "color": line.get("color") or group_color.get(line.get("groupId"))
            or "#555555",
        }

    for lf, line in loaded:
        arc = arc_by_id[line.get("id")]
        lf_, sf_ = flatten_line(line, arc, tps, group_color, stop_group,
                                conn_target_index)
        line_feats += lf_
        stop_feats += sf_
        emitted_order.append(line.get("id"))

    out = Path(args.out)
    sz1 = write_geojson(out / "lines.geojson", line_feats)
    sz2 = write_geojson(out / "stops.geojson", stop_feats)
    # 线组索引（2026-11-22 主支线合并）：归属＝双向并集（groups.json members 声明 ＋
    # 线文件 groupId 指向，均限实际输出线 emitted_order/loaded）；mainId＝并集成员中
    # role=="main" 的第一个（members 声明序优先，其后按输出序）；无 main 的组照样输出
    #（mainId=null 供查看器防御——其侧判定不合并）。孤儿 groupId（组记录不存在）无法
    # 得知组名，不产出组记录。
    line_by_id = {line.get("id"): line for _, line in loaded}
    index_line_groups = []
    for lg in line_groups:
        gid = lg.get("id")
        members = []
        for m in (lg.get("members") or []):
            # 方向一：members 声明（限实际输出线，去重保序）
            if isinstance(m, str) and m in line_by_id and m not in members:
                members.append(m)
        for lid in emitted_order:
            # 方向二：线文件 groupId 指向本组（按输出序补并集，同样限已输出线）
            if line_by_id.get(lid, {}).get("groupId") == gid and lid not in members:
                members.append(lid)
        main_id = next((m for m in members
                        if (line_by_id.get(m) or {}).get("role") == "main"), None)
        index_line_groups.append({
            "id": gid,
            "name": lg.get("name") or "",   # 原样输出（不擅自造名；空名由查看器退主线名）
            "mainId": main_id,
            "members": members,
        })
    # 顺序索引（结构字段全英文；线 id 本身为英文）——查看器左栏排序＋线组归并数据源。
    # fmt 升 net-index@3（加顶层 stationGroups 换乘节点组结构表，2026-11-23 嵌套组；
    # 查看器对 fmt 严格校验故随版本走，消费端收 @1/@2/@3）
    out.mkdir(parents=True, exist_ok=True)
    (out / "index.json").write_text(
        json.dumps({"fmt": "net-index@3", "lineOrder": emitted_order,
                    "lineGroups": index_line_groups,
                    "stationGroups": station_groups},
                   ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8")
    sz3 = (out / "index.json").stat().st_size

    # lineinfo.md（线路信息面板，用户手填的每线路介绍，2026-11-23）：数据目录下有则
    # 原样透传进输出目录（字节级拷贝，不解析、不进 GeoJSON——解析在查看器侧
    # VIEWER_CORE.parseLineInfo）；数据目录无此文件则跳过（查看器静默无信息节）
    li_src = Path(args.data) / "lineinfo.md"
    li_size = None
    if li_src.is_file():
        (out / "lineinfo.md").write_bytes(li_src.read_bytes())
        li_size = (out / "lineinfo.md").stat().st_size

    # 汇总（含有限性抽检：任一坐标非有限数即报错；兼容 LineString/Point 两层结构）
    n_pts = sum(len(f["geometry"]["coordinates"]) for f in line_feats)
    for f in line_feats + stop_feats:
        for item in f["geometry"]["coordinates"]:
            vals = item if isinstance(item, list) else [item]
            if not all(math.isfinite(v) for v in vals):
                sys.exit(f"错误：输出含非有限坐标，feature={f['properties']!r}")
    print(f"flatten 完成：线路文件 {len(files)} 个（剔除归档 {n_archived}）→ "
          f"线路分段 {len(line_feats)} 条（折线 {n_pts} 点）、设站 {len(stop_feats)} 个"
          f"（线路所已剔除）")
    print(f"written: {out / 'lines.geojson'}（{sz1 / 1024:.0f} KB）")
    print(f"written: {out / 'stops.geojson'}（{sz2 / 1024:.0f} KB）")
    print(f"written: {out / 'index.json'}（{sz3} B，lineOrder {len(emitted_order)} 线、"
          + f"lineGroups {len(index_line_groups)} 组（其中含 main {sum(1 for g in index_line_groups if g['mainId'])} 组）"
          + f"、stationGroups {len(station_groups)} 组"
          + (f"，自定义序前 {len(set(manifest_order or []))} 列" if manifest_order else "，无自定义顺序") + "）")
    if li_size is not None:
        print(f"written: {out / 'lineinfo.md'}（{li_size} B，线路手填介绍原样透传）")
    else:
        print("提示：数据目录下没有 lineinfo.md（线路手填介绍），查看器一切线路无信息节")
    return 0


if __name__ == "__main__":
    sys.exit(main())
