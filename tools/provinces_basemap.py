#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""长三角省级界线底图生成：OSM admin_level=4（WGS84）→ bbox 裁剪 → 简化 GeoJSON。

用法：
    python -X utf8 tools/provinces_basemap.py                    # 从 polygons.openstreetmap.fr 拉取 → basemap/provinces-wgs84.json
    python -X utf8 tools/provinces_basemap.py --in <目录>        # 用本地原始件目录重跑（离线可复现，见下）
    python -X utf8 tools/provinces_basemap.py --tol-m 60         # 简化容差（米，默认 60）

来源与许可（报告口径，2026-11-23）：
  源数据＝OpenStreetMap 省级行政边界（admin_level=4），经 polygons.openstreetmap.fr
  取全精度几何（get_geojson.py?id=<关系id>&params=0，无简化）：
      上海市 relation 913067 ／ 江苏省 913012 ／ 浙江省 553302 ／ 安徽省 913011
  （关系 id 取自 Wikidata P402「OpenStreetMap 关系 ID」。四省 fetch 原始件
  osm_rel<id>_<省名>.geojson 惯例存放 零散/省界源件-OSM/，--in 即指该目录。）
  OSM 数据许可 ODbL 1.0（© OpenStreetMap 贡献者）。用户 2026-11-23 裁定网页不写署名，
  本头注如实记录义务归属：落盘件属 OSM 衍生数据库，ODbL 要求分发时以同许可发布并
  附 © OpenStreetMap contributors 署名——「不写署名」仅是用户裁定，不改变许可义务本身。
  省界属底图范畴而非地铁数据，经用户明示授权，不受「地铁数据不得引用外部源」禁令约束。

范围（2026-11-23 用户裁定：长三角一小块，宁略大勿小，不要全国、不要九段线）：
  固定裁剪 bbox ＝ 经 117.5°E–123.5°E、纬 27.5°N–34.5°N
  （西至合肥东侧／北至盐城—蚌埠一线／南至温州以北／东至舟山群岛以东海域）。
  环按 bbox 裁成折线段后输出 MultiLineString（不再闭合，不产生沿 bbox 边缘的假边）；
  裁剪交点取 bbox 边界精确值。

坐标系：源＝WGS84（OSM 原生），零转换落盘——与查看器「导出坐标恒 WGS84」一致；
  高德底图态由查看器显示侧 S.dispCoord（WGS84→GCJ02）统一变换，与线路数据同一通道，
  无需在数据侧预转换。

简化：等距圆柱投影（逐要素质心纬度定长）下 Douglas–Peucker，容差 --tol-m（默认 60 m
  ≈ z10 下 0.5 px，只削共线抖动不牺牲形状）；坐标四舍五入 5 位小数（≈1.1 m）；裁后
  折线不足 2 点的丢弃。源点距中位 28–76 m，DP60 后约 290 m（z10 ≈2.2 px，平滑曲线感；
  上一版 DataV 概化版 bbox 内点距中位 4.8 km）。输出 UTF-8 无 BOM、紧凑分隔。
"""

import argparse
import json
import math
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_REL = "basemap/provinces-wgs84.json"

# (省名, OSM admin_level=4 关系 id)——全精度几何经 polygons.openstreetmap.fr 取
SOURCES = [
    ("上海市", 913067),
    ("江苏省", 913012),
    ("浙江省", 553302),
    ("安徽省", 913011),
]
FETCH_URL = "https://polygons.openstreetmap.fr/get_geojson.py?id=%d&params=0"

# 长三角裁剪范围（经西, 纬南, 经东, 纬北）——口径见头注「范围」节
BBOX = (117.5, 27.5, 123.5, 34.5)


# ---------- bbox 裁剪（环 → 界内折线段） ----------
def edge_cross(a, b, bbox):
    """线段 a→b 与 bbox 边界的交点（恰穿越时恰一个；无则 None）。"""
    x0, y0, x1, y1 = bbox
    for X in (x0, x1):
        if (a[0] - X) * (b[0] - X) <= 0 and a[0] != b[0]:
            t = (X - a[0]) / (b[0] - a[0])
            if 0 <= t <= 1:
                y = a[1] + t * (b[1] - a[1])
                if y0 <= y <= y1:
                    return [X, y]
    for Y in (y0, y1):
        if (a[1] - Y) * (b[1] - Y) <= 0 and a[1] != b[1]:
            t = (Y - a[1]) / (b[1] - a[1])
            if 0 <= t <= 1:
                x = a[0] + t * (b[0] - a[0])
                if x0 <= x <= x1:
                    return [x, Y]
    return None


def clip_line(pts, bbox):
    """闭环裁成 bbox 内折线段列表。

    全在界内 → 原环（闭合）单股返回；否则把环旋转到界外顶点起步（杜绝跨数组
    首尾的界内股被拆断），再沿边走一圈：界内连续段成股，出入界各补一个边界交点。
    重入界（界外→界内）时必须先把上一股落袋再开新股——否则上一股被直接覆盖丢弃
    （实测踩坑：江苏主环在北界恰有单点出界段，17234 点的大股因此整体丢失）。
    """
    x0, y0, x1, y1 = bbox
    inside = lambda p: x0 <= p[0] <= x1 and y0 <= p[1] <= y1
    ring = pts[:-1] if pts[0] == pts[-1] else list(pts)
    n = len(ring)
    outs = [i for i in range(n) if not inside(ring[i])]
    if not outs:
        return [list(pts)]
    order = [ring[(outs[0] + i) % n] for i in range(n)]
    runs, cur = [], None
    for i in range(n):
        a, b = order[i], order[(i + 1) % n]
        ia, ib = inside(a), inside(b)
        if ia and ib:
            if cur is None:
                cur = [a]
            cur.append(b)
        elif ia:                      # 界内 → 界外：补交点（股自然收束于交点）
            x = edge_cross(a, b, bbox)
            if x is None:
                if cur:
                    runs.append(cur)
                cur = None
            else:
                if cur is None:
                    cur = [a]
                cur.append(x)
        elif ib:                      # 界外 → 界内：先落袋上一股，再补交点开新股
            if cur:
                runs.append(cur)
            x = edge_cross(a, b, bbox)
            cur = None if x is None else [x, b]
        elif cur:                     # 界外 → 界外：一股收束
            runs.append(cur)
            cur = None
    if cur:
        runs.append(cur)
    return runs


# ---------- 简化（等距圆柱投影＋Douglas–Peucker） ----------
def dp(points, tol):
    """points＝投影后 (x, y) 平面点列；返回保留的下标集。"""
    keep = [0, len(points) - 1]
    stack = [(0, len(points) - 1)]
    tol2 = tol * tol
    while stack:
        i0, i1 = stack.pop()
        x0, y0 = points[i0]
        x1, y1 = points[i1]
        dx, dy = x1 - x0, y1 - y0
        seg2 = dx * dx + dy * dy
        best_d2, best_i = -1.0, -1
        for i in range(i0 + 1, i1):
            px, py = points[i]
            if seg2 == 0.0:
                d2 = (px - x0) ** 2 + (py - y0) ** 2
            else:
                t = ((px - x0) * dx + (py - y0) * dy) / seg2
                t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
                qx, qy = x0 + t * dx, y0 + t * dy
                d2 = (px - qx) ** 2 + (py - qy) ** 2
            if d2 > best_d2:
                best_d2, best_i = d2, i
        if best_d2 > tol2 and best_i > 0:
            keep.append(best_i)
            stack.append((i0, best_i))
            stack.append((best_i, i1))
    return sorted(set(keep))


def dedupe(pts):
    """连续重复点压缩（裁剪交点与四舍五入都可能并点）。"""
    return [p for i, p in enumerate(pts) if i == 0 or pts[i - 1] != p]


def simplify_line(line, tol, lat0):
    k = math.cos(lat0 * math.pi / 180.0) * 111320.0
    pts = [(lon * k, lat * 110540.0) for lon, lat in line]
    idx = dp(pts, tol)
    if len(idx) < 2:
        return None
    out = dedupe([[round(line[i][0], 5), round(line[i][1], 5)] for i in idx])
    return out if len(out) >= 2 else None


def rings_of(geom):
    """Polygon / MultiPolygon → 逐环。"""
    if geom["type"] == "Polygon":
        yield from geom["coordinates"]
    elif geom["type"] == "MultiPolygon":
        for poly in geom["coordinates"]:
            yield from poly


def centroid_lat(coords):
    """任意深度嵌套坐标的纬度均值（逐要素定投影纬度）。"""
    total, n = 0.0, 0

    def walk(c):
        nonlocal total, n
        if isinstance(c[0], (int, float)):
            total += c[1]
            n += 1
            return
        for x in c:
            walk(x)

    walk(coords)
    return total / n if n else 0.0


def count_coords(coords):
    n = 0

    def walk(c):
        nonlocal n
        if isinstance(c[0], (int, float)):
            n += 1
            return
        for x in c:
            walk(x)

    walk(coords)
    return n


def median_seg_m(lines):
    """折线集合的相邻点距中位（米，等距圆柱近似）。"""
    segs = []
    for line in lines:
        for a, b in zip(line, line[1:]):
            kx = math.cos((a[1] + b[1]) / 2 * math.pi / 180.0) * 111320.0
            segs.append(math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540.0))
    if not segs:
        return 0.0
    segs.sort()
    return segs[len(segs) // 2]


def main():
    ap = argparse.ArgumentParser(description="OSM 长三角省界（WGS84）→ bbox 裁剪＋简化 GeoJSON（查看器省级界线底图）")
    ap.add_argument("--in", dest="src", help="本地原始件目录（含 osm_rel<id>_<省名>.geojson 四件；缺省从 polygons.openstreetmap.fr 拉取）")
    ap.add_argument("--out", default=str(ROOT / OUT_REL), help="输出路径（默认 basemap/provinces-wgs84.json）")
    ap.add_argument("--tol-m", type=float, default=60.0, help="Douglas–Peucker 容差（米，默认 60）")
    args = ap.parse_args()

    feats_out = []
    for name, rel_id in SOURCES:
        if args.src:
            matches = sorted(Path(args.src).glob("osm_rel%d_*.geojson" % rel_id))
            if not matches:
                raise SystemExit("--in 目录缺原始件：%s（osm_rel%d_*.geojson）" % (name, rel_id))
            raw_text = matches[0].read_text(encoding="utf-8")
            src_desc = str(matches[0])
        else:
            url = FETCH_URL % rel_id
            print("$ GET " + url, flush=True)
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=240) as res:
                raw_text = res.read().decode("utf-8")
            src_desc = url
        geom = json.loads(raw_text)
        if geom.get("type") not in ("Polygon", "MultiPolygon"):
            raise SystemExit("%s 几何类型异常：%s" % (name, geom.get("type")))

        # 裁剪 → 简化（环逐个裁成界内折线，DP 只削共线抖动）
        lat0 = centroid_lat(geom["coordinates"])
        lines = []
        n_raw = n_kept = 0
        for ring in rings_of(geom):
            for run in clip_line(ring, BBOX):
                n_raw += len(run)
                line = simplify_line(run, args.tol_m, lat0)
                if line is not None:
                    lines.append(line)
                    n_kept += len(line)
        if not lines:
            print("%s：bbox 内无几何，跳过" % name)
            continue
        feats_out.append({
            "type": "Feature",
            "properties": {"name": name, "level": "province", "osmRelation": rel_id},
            "geometry": {"type": "MultiLineString", "coordinates": lines},
        })
        print("%s：裁后 %s 点 → DP%g 后 %s 点（折线 %d 股，点距中位 %.0f m）"
              % (name, format(n_raw, ","), args.tol_m, format(n_kept, ","), len(lines), median_seg_m(lines)))

    fc = {"type": "FeatureCollection", "features": feats_out}
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(fc, ensure_ascii=False, separators=(",", ":")) + "\n"
    out_path.write_text(text, encoding="utf-8", newline="")   # UTF-8 无 BOM
    print("落盘：%s  %s B（%d 要素）" % (out_path, format(out_path.stat().st_size, ","), len(feats_out)))


if __name__ == "__main__":
    main()
