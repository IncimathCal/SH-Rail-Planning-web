#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""中国省级界线底图生成：DataV GeoAtlas 全国省界（GCJ02）→ WGS84 简化 GeoJSON。

用法：
    python -X utf8 tools/provinces_basemap.py                    # 从 DataV 拉取 → basemap/provinces-wgs84.json
    python -X utf8 tools/provinces_basemap.py --in <raw.json>    # 用本地原始件重跑（离线可复现）
    python -X utf8 tools/provinces_basemap.py --tol-m 60         # 简化容差（米，默认 60）

来源与许可（报告口径）：
  源数据＝阿里云 DataV GeoAtlas 全国省界
  https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json
  ——GCJ02 坐标系，底层数据来自高德；官方未附开源许可证文本（公开网络服务产物）。
  本项目经用户 2026-11-23 明示授权作为地理底图使用：省界属底图范畴而非地铁数据，
  不受「地铁相关数据不得引用外部源」禁令约束。末位含 100000_JD（南海诸岛九段线）。
  备选源 Natural Earth admin-1（公有领域、精度较粗）未采用。

坐标系：源＝GCJ02，落盘前按公开正向算法（wgs84→gcj02 偏移模型）迭代反变换转 WGS84
  ——与查看器「导出坐标恒 WGS84」一致；查看器高德底图态走既有 S.dispCoord（WGS84→GCJ02）
  显示侧变换，与线路数据同一通道。迭代 3 次收敛残差 <1e-6°（≈0.1 m）；正向模型与真实
  GCJ02 的偏差通常在米级，均远低于本层显示精度。

简化：等距圆柱投影（逐要素质心纬度定长）下 Douglas–Peucker，容差 --tol-m（默认 60 m）；
  坐标四舍五入 5 位小数（≈1.1 m）；简化后不足 4 点的环丢弃、空要素丢弃；属性只留
  adcode/name/level（结构键全英文，name 值中文合法）。输出 UTF-8 无 BOM、紧凑分隔。
"""

import argparse
import json
import math
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_URL = "https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json"
OUT_REL = "basemap/provinces-wgs84.json"


# ---------- GCJ02 ⇄ WGS84（公开偏移模型，迭代反变换） ----------
def _off_lat(x, y):
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320.0 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _off_lon(x, y):
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def in_china(lon, lat):
    return 72.004 <= lon <= 137.8347 and 0.8293 <= lat <= 55.8271


def wgs84_to_gcj02(lon, lat):
    if not in_china(lon, lat):
        return lon, lat
    dlat = _off_lat(lon - 105.0, lat - 35.0)
    dlon = _off_lon(lon - 105.0, lat - 35.0)
    radlat = lat / 180.0 * math.pi
    magic = math.sin(radlat)
    magic = 1 - 0.00669342162296594323 * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((6378245.0 * (1 - 0.00669342162296594323)) / (magic * sqrtmagic) * math.pi)
    dlon = (dlon * 180.0) / (6378245.0 / sqrtmagic * math.cos(radlat) * math.pi)
    return lon + dlon, lat + dlat


def gcj02_to_wgs84(lon, lat):
    """迭代反变换（正向模型固定点迭代），3 次后残差 <1e-6°。"""
    if not in_china(lon, lat):
        return lon, lat
    wlon, wlat = lon, lat
    for _ in range(3):
        glon, glat = wgs84_to_gcj02(wlon, wlat)
        wlon += lon - glon
        wlat += lat - glat
    return wlon, wlat


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
    """连续重复点压缩（源数据含显式重复点；四舍五入也可能并点）。"""
    return [p for i, p in enumerate(pts) if i == 0 or pts[i - 1] != p]


def simplify_ring(ring, tol, lat0):
    """单环：投影→DP（开环）→5 位小数→去重→补闭合。投影用质心纬度定长的等距圆柱。"""
    k = math.cos(lat0 * math.pi / 180.0) * 111320.0
    pts = [(lon * k, lat * 110540.0) for lon, lat in ring]
    idx = dp(pts, tol)
    out = dedupe([[round(ring[i][0], 5), round(ring[i][1], 5)] for i in idx])
    # 补闭合（DP 在开环上做；原环首尾相等）
    if out and (out[0][0] != out[-1][0] or out[0][1] != out[-1][1]):
        out.append(list(out[0]))
    return out if len(out) >= 4 else None


def simplify_ringseq(parts, tol, lat0, close=True):
    """Polygon rings / MultiPolygon rings 逐层走 simplify_ring；空环丢弃。"""
    out = []
    for part in parts:
        r = simplify_ring(part, tol, lat0) if close else simplify_line(part, tol, lat0)
        if r is not None:
            out.append(r)
    return out or None


def simplify_line(line, tol, lat0):
    k = math.cos(lat0 * math.pi / 180.0) * 111320.0
    pts = [(lon * k, lat * 110540.0) for lon, lat in line]
    idx = dp(pts, tol)
    if len(idx) < 2:
        return None
    out = dedupe([[round(line[i][0], 5), round(line[i][1], 5)] for i in idx])
    return out if len(out) >= 2 else None


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


def convert_geom_coords(geom):
    """GCJ02 → WGS84：任意深度坐标逐点迭代反变换（必须在简化前做）。"""

    def conv(c):
        if isinstance(c[0], (int, float)):
            return list(gcj02_to_wgs84(c[0], c[1]))
        return [conv(x) for x in c]

    return {"type": geom["type"], "coordinates": conv(geom["coordinates"])}


def simplify_geom(geom, tol):
    gtype = geom["type"]
    lat0 = centroid_lat(geom["coordinates"])
    if gtype == "Polygon":
        rings = simplify_ringseq(geom["coordinates"], tol, lat0)
        return {"type": "Polygon", "coordinates": rings} if rings else None
    if gtype == "MultiPolygon":
        polys = []
        for poly in geom["coordinates"]:
            rings = simplify_ringseq(poly, tol, lat0)
            if rings:
                polys.append(rings)
        return {"type": "MultiPolygon", "coordinates": polys} if polys else None
    if gtype in ("LineString", "MultiLineString"):
        if gtype == "LineString":
            line = simplify_line(geom["coordinates"], tol, lat0)
            return {"type": "LineString", "coordinates": line} if line else None
        lines = simplify_ringseq(geom["coordinates"], tol, lat0, close=False)
        return {"type": "MultiLineString", "coordinates": lines} if lines else None
    return None


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


def main():
    ap = argparse.ArgumentParser(description="DataV 省界（GCJ02）→ WGS84 简化 GeoJSON（查看器省级界线底图）")
    ap.add_argument("--in", dest="src", help="本地原始件路径（缺省从 DataV 拉取）")
    ap.add_argument("--out", default=str(ROOT / OUT_REL), help="输出路径（默认 basemap/provinces-wgs84.json）")
    ap.add_argument("--tol-m", type=float, default=60.0, help="Douglas–Peucker 容差（米，默认 60）")
    args = ap.parse_args()

    if args.src:
        raw_text = Path(args.src).read_text(encoding="utf-8")
        src_desc = args.src
    else:
        print("$ GET " + SOURCE_URL, flush=True)
        with urllib.request.urlopen(SOURCE_URL, timeout=120) as res:
            raw_text = res.read().decode("utf-8")
        src_desc = SOURCE_URL

    raw = json.loads(raw_text)
    feats_out = []
    n_before = n_after = 0
    dropped = []
    for f in raw.get("features", []):
        geom = f.get("geometry")
        if not geom or not geom.get("coordinates"):
            continue
        p = f.get("properties", {}) or {}
        geom = convert_geom_coords(geom)   # GCJ02 → WGS84（先转换后简化）
        n0 = count_coords(geom["coordinates"])
        g2 = simplify_geom(geom, args.tol_m)
        if g2 is None:
            dropped.append(str(p.get("adcode")))
            continue
        n1 = count_coords(g2["coordinates"])
        n_before += n0
        n_after += n1
        props = {"adcode": p.get("adcode"), "name": p.get("name", "")}
        if p.get("level"):
            props["level"] = p["level"]
        feats_out.append({"type": "Feature", "properties": props, "geometry": g2})

    fc = {"type": "FeatureCollection", "features": feats_out}
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(fc, ensure_ascii=False, separators=(",", ":")) + "\n"
    out_path.write_text(text, encoding="utf-8", newline="")   # UTF-8 无 BOM

    print(f"来源：{src_desc}")
    print(f"要素：{len(feats_out)} 个（丢弃空要素 {len(dropped)} 个{'：' + '、'.join(dropped) if dropped else ''}）")
    print(f"坐标：{n_before:,} → {n_after:,} 点（容差 {args.tol_m:g} m）")
    print(f"落盘：{out_path}  {out_path.stat().st_size:,} B")


if __name__ == "__main__":
    main()
