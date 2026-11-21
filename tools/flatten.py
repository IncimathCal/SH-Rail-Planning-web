#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""flatten —— 录入数据 → 查看器 GeoJSON 派生工具（阶段 3 渲染数据源）。

把 data/ 下的录入成果（SVG 画板坐标的贝塞尔 path + 弧长参数 t 设站）经
data/calibration.json（fmt/calibration@2，model:"tps"）正变换，flatten 为
WGS84 经纬度 GeoJSON（MapLibre / Web 墨卡托可直接消费）：

  <out>/lines.geojson  线路×分段，每 feature 一条 LineString
                        properties: lineId / name / aliases / color / role /
                        layer / loop / segIndex / segStatus
  <out>/stops.geojson  设站，每 feature 一个 Point
                        properties: sid / name / lineId / lineName / t /
                        groupId / groupType
                        kind:"block"（线路所）整条剔除——正式网页隐藏。

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
  站数 < 2 的线（如零设站联络线）用线路级 status 输出整线单段；
  段无记录（segments 缺项）按 "existing"。

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
            if e.get("id") in archived:
                continue
            if e.get("file"):
                files.append(data / e["file"])
        if not files:
            print("警告：manifest.json 存在但 lines 为空（或全被剔除）")
    else:
        files = sorted((data / "lines").glob("*.json"))
    return files


def load_groups(data_dir):
    """读 groups.json → (线组色映射, 设站→节点组映射)。缺文件则空映射。"""
    data = Path(data_dir)
    gp = data / "groups.json"
    if not gp.is_file():
        print("提示：未找到 groups.json，groupId/groupType 全为 null、组色兜底不可用")
        return {}, {}
    g = json.loads(gp.read_text(encoding="utf-8"))
    group_color = {lg.get("id"): lg.get("color")
                   for lg in (g.get("lineGroups") or [])}
    stop_group = {}
    for sg in (g.get("stationGroups") or []):
        for sid in (sg.get("stops") or []):
            # 一设站至多一组（validate 门禁保证），此处重复时后者覆盖不致命
            stop_group[sid] = (sg.get("id"), sg.get("type"))
    return group_color, stop_group


# ------------------------------------------------------------- 单线展开 --

def flatten_line(line, ap, tps, group_color, stop_group):
    """单条线路 → (分段 LineString feature 列表, 设站 Point feature 列表)。"""
    lid = line.get("id")
    stops = line.get("stops") or []
    segs = line.get("segments") or []
    n = len(stops)
    loop = bool(line.get("loop"))
    meta = line.get("meta") or {}

    base_props = {
        "lineId": lid,
        "name": line.get("name") or "",
        "aliases": list(meta.get("aliases") or []),
        # 线路色优先取本线，缺省兜底线组色（schema：组色成员可继承）
        "color": line.get("color") or group_color.get(line.get("groupId")),
        "role": line.get("role"),
        "layer": meta.get("layer"),   # 无则 null
        "loop": loop,
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
            # 整线单段：优先线路级 status，无则 segments[0]，再缺省 existing
            status = line.get("status") or (segs[0] if segs else None) or "existing"
        else:
            status = segs[i] if i < len(segs) and segs[i] else "existing"
        props = dict(base_props)
        props["segIndex"] = i
        props["segStatus"] = status
        line_feats.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "LineString", "coordinates": coords},
        })

    # ---- 设站（线路所 kind:"block" 整条剔除）----
    stop_feats = []
    for st in stops:
        if st.get("kind") == "block":
            continue
        geo = st.get("geo")
        if geo:
            lon, lat = float(geo[0]), float(geo[1])   # 权威覆盖值
        else:
            lon, lat = to_lonlat(*ap.point_at(st["t"]))
        gid, gtype = stop_group.get(st["id"], (None, None))
        stop_feats.append({
            "type": "Feature",
            "properties": {
                "sid": st["id"],
                "name": st.get("name") or "",
                "lineId": lid,
                "lineName": line.get("name") or "",
                "t": st["t"],
                "groupId": gid,
                "groupType": gtype,
            },
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
                    "WGS84 GeoJSON（lines.geojson + stops.geojson），供阶段 3 查看器渲染。")
    ap.add_argument("--data", default="data", help="权威数据目录（默认 data）")
    ap.add_argument("--calib", default=None,
                    help="标定 JSON 路径（默认 <data>/calibration.json，"
                         "取不到再 data/calibration.json；fmt/calibration@2 tps）")
    ap.add_argument("--out", default="build/net", help="输出目录（默认 build/net）")
    args = ap.parse_args()

    calib_path = args.calib or default_calib(args.data)
    tps = load_calibration(calib_path)          # 复用 ge_convert（含格式校验）
    group_color, stop_group = load_groups(args.data)

    line_feats, stop_feats = [], []
    n_archived = 0
    files = collect_line_files(args.data)
    if not files:
        sys.exit(f"错误：{args.data} 下未找到任何线路文件")
    for lf in files:
        line = json.loads(lf.read_text(encoding="utf-8"))
        if (line.get("meta") or {}).get("archived"):
            n_archived += 1
            continue
        # 空白规范化：svg_parse 的词法把空格误当命令字符（真实 AI 导出 d 串为
        # 压缩格式无空格，仅手写样张含空格），此处统一换成逗号——SVG path 语法
        # 中空白与逗号同为分隔符，语义等价且与 src/geom.js（忽略空白）口径一致
        d_norm = re.sub(r"\s+", ",", line["path"].strip())
        arc = path_from_d(d_norm)                # 解析+压平+弧长参数化（复用 svg_parse）
        lf_, sf_ = flatten_line(line, arc, tps, group_color, stop_group)
        line_feats += lf_
        stop_feats += sf_

    out = Path(args.out)
    sz1 = write_geojson(out / "lines.geojson", line_feats)
    sz2 = write_geojson(out / "stops.geojson", stop_feats)

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
    return 0


if __name__ == "__main__":
    sys.exit(main())
