#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""上海区级行政区划界线底图生成：OSM relation 边界（WGS84）→ 共边净化 → 简化 GeoJSON。

用法：
    python -X utf8 tools/districts_basemap.py --src 零散/区界源件-OSM          # 离线从原始件目录重跑（推荐，幂等）
    python -X utf8 tools/districts_basemap.py --fetch --save-raw 零散/区界源件-OSM   # 在线拉取并按惯例名存档原始件
    python -X utf8 tools/districts_basemap.py --tol-m 60                       # 简化容差（米，默认 60）

来源与许可（报告口径，2026-11-27，同省界先例 tools/provinces_basemap.py）：
  源数据＝OpenStreetMap 行政边界（WGS84），全精度几何经 polygons.openstreetmap.fr
  取（get_geojson.py?id=<关系id>&params=0，无简化）。
  admin_level 实测结论（2026-11-27）：直辖市下辖区在上海为 **6**（16 区全部一致，非 8）。
  Overpass API 本机链路 406 不可用，验证改走「Wikidata P150 列上海下辖区 × P402 取关系
  id → OSM 主站 API /api/0.6/relations 直读标签」；崇明区下 18 乡镇级 relation
  （admin_level=8，16 镇 2 乡）同为该通道确认。
  关系 id（Wikidata P402）：黄浦区 371650／徐汇区 1278188／长宁区 398899／静安区 398353／
  普陀区 398886／虹口区 398351／杨浦区 398350／闵行区 1278189／宝山区 398374／嘉定区 1673543／
  浦东新区 398348／金山区 3292756／松江区 3293722／青浦区 3292760／奉贤区 3292751／
  崇明区 3292750（区级件仅存档不用于几何，见「崇明口径」）。乡镇 18 件见 TOWNS。
  原始件（含省界 osm_rel913067_上海市.geojson 副本）惯例存放 零散/区界源件-OSM/。
  OSM 数据许可 ODbL 1.0（© OpenStreetMap 贡献者）。用户 2026-11-23 对省界裁定网页不写署名
  （区界 2026-11-27 沿用同口径），本头注如实记录义务归属：落盘件属 OSM 衍生数据库，ODbL
  要求分发时以同许可发布并附 © OpenStreetMap contributors 署名——「不写署名」仅是用户裁定，
  不改变许可义务本身。区界属底图范畴而非地铁数据，经用户明示授权（省界先例同一授权范畴），
  不受「地铁数据不得引用外部源」禁令约束。

实测数据质量与提取口径（2026-11-27，逐项实测后定稿）：
  OSM 区级 relation 的 polygons 组装结果不可直接全环保留——
  ① 崇明区 relation 3292750 的 outer 是粗糙包络（含 69 km 人为直线，一环框三岛）；
    其精细边界在 18 个乡镇级 relation（岸线逐岛精细，乡镇间界即内部界线）。
    → 崇明口径：**崇明区几何＝18 乡镇 relation 联合**（owner 同记崇明区），区级件弃用。
  ② 宝山/静安等区 relation 混入异地假环（实测宝山件 11 环中 9 环位于江西/江苏
    118.6–120.75°E、33°N 一带，属成员 way 错误引用）。
    → 净化一：环 bbox 与上海市域包络（省界件 osm_rel913067 外环 bbox）无交集的整环丢弃。
  ③ 上海市界 relation 913067 本身是「包住三岛与长江口水域的大包络」，非逐岛岸线——
    区界外缘有相当部分不与省界重叠（如宝山北缘朝崇明水界、三岛岸线、海岸线）。
  提取规则（边粒度，无向顶点对、坐标 round 7 位精确匹配——两侧 relation 引用同一 way
  时 polygons 输出坐标一致，实测 6063 条共边、35 对区邻接与实际区划吻合）：
    区界边 ＝ 跨区共边（≥2 个不同区 owner，区际界线）
            ∨ 单侧边（唯一 owner，区的外缘——岸线/水界）
    丢弃边 ＝ 与省界件共边（省界层已画，虚线叠实线无增益且两侧各自简化会露虚线毛边）
            ∨ 同区内部共边（崇明乡镇间界线、区内洞环边界）
            ∨ 异地假环的全部边（净化一）
  该规则下 16 区边界完整（区际界＋各自外缘），崇明三岛岸线入图（省界大包络不含它），
  任务书「只要上海境内」由「与省界共边即丢」＋包络 bbox 过滤共同保证。

坐标系：源＝WGS84（OSM 原生），零转换落盘——与查看器「导出坐标恒 WGS84」一致；
高德底图态由查看器显示侧 S.dispCoord（WGS84→GCJ02）统一变换，与线路数据同一通道。

简化：共边匹配完成后（先匹配后简化，保证顶点对齐）对链做等距圆柱投影（逐链质心纬度
定长）Douglas–Peucker，容差 --tol-m（默认 60 m，与省界同档）；坐标四舍五入 5 位小数
（≈1.1 m）；链不足 2 点丢弃。链＝同一分组内边的串接（T 型交点断链，视觉无缝）；
分组键＝跨区对（between，如「嘉定区|普陀区」）或单侧 owner（owner+outer）。
输出 UTF-8 无 BOM、紧凑分隔，固定遍历序保证幂等复跑字节一致。
"""

import argparse
import json
import math
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_REL = "basemap/districts-wgs84.json"

# (单元名, OSM 关系 id, owner 区名)——15 区直接用区级 relation；崇明区以 18 乡镇联合替代
#（区级 3292750 是粗糙包络，见头注「崇明口径」）
DISTRICTS = [
    ("黄浦区", 371650, "黄浦区"),
    ("徐汇区", 1278188, "徐汇区"),
    ("长宁区", 398899, "长宁区"),
    ("静安区", 398353, "静安区"),
    ("普陀区", 398886, "普陀区"),
    ("虹口区", 398351, "虹口区"),
    ("杨浦区", 398350, "杨浦区"),
    ("闵行区", 1278189, "闵行区"),
    ("宝山区", 398374, "宝山区"),
    ("嘉定区", 1673543, "嘉定区"),
    ("浦东新区", 398348, "浦东新区"),
    ("金山区", 3292756, "金山区"),
    ("松江区", 3293722, "松江区"),
    ("青浦区", 3292760, "青浦区"),
    ("奉贤区", 3292751, "奉贤区"),
]
TOWNS = [
    ("横沙乡", 15708308, "崇明区"),
    ("长兴镇", 16469113, "崇明区"),
    ("向化镇", 18309973, "崇明区"),
    ("中兴镇", 18309974, "崇明区"),
    ("陈家镇", 18309975, "崇明区"),
    ("港沿镇", 18310005, "崇明区"),
    ("堡镇", 18310022, "崇明区"),
    ("新村乡", 18778245, "崇明区"),
    ("三星镇", 18778246, "崇明区"),
    ("绿华镇", 18778247, "崇明区"),
    ("城桥镇", 18778248, "崇明区"),
    ("新海镇", 18778249, "崇明区"),
    ("庙镇", 18778250, "崇明区"),
    ("港西镇", 18778251, "崇明区"),
    ("建设镇", 18778252, "崇明区"),
    ("新河镇", 18778253, "崇明区"),
    ("东平镇", 18778254, "崇明区"),
    ("竖新镇", 18778255, "崇明区"),
]
UNITS = DISTRICTS + TOWNS
PROV_SH = ("上海市", 913067)   # 省界件（大包络）：共边排除＋bbox 净化基准
FETCH_URL = "https://polygons.openstreetmap.fr/get_geojson.py?id=%d&params=0"


# ---------- 获取（fetch＋断点续拉，同省界惯例名存档） ----------
def load_raw(name, rel_id, src_dir, save_raw):
    """优先读本地原始件；--fetch 时缺件才拉取（含 3 次重试与存档）。"""
    p = Path(src_dir) / ("osm_rel%d_%s.geojson" % (rel_id, name))
    if p.is_file():
        return p.read_text(encoding="utf-8")
    url = FETCH_URL % rel_id
    raw = None
    for attempt in (1, 2, 3):
        try:
            print("$ GET " + url, flush=True)
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=240) as res:
                raw = res.read().decode("utf-8")
            break
        except Exception as e:
            print("  第 %d 次拉取失败（%s）" % (attempt, e), flush=True)
            if attempt < 3:
                time.sleep(5 * attempt)
    if raw is None:
        raise SystemExit("%s 拉取失败（已重试 3 次）：%s" % (name, url))
    if save_raw:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(raw, encoding="utf-8", newline="")   # 原样字节存档（UTF-8 无 BOM）
    return raw


def rings_of(geom):
    if geom["type"] == "Polygon":
        return list(geom["coordinates"])
    if geom["type"] == "MultiPolygon":
        return [r for poly in geom["coordinates"] for r in poly]
    raise SystemExit("几何类型异常：%s" % geom.get("type"))


def ring_bbox(ring):
    lons = [p[0] for p in ring]
    lats = [p[1] for p in ring]
    return min(lons), min(lats), max(lons), max(lats)


def bbox_overlap(a, b):
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


# ---------- 简化（等距圆柱投影＋Douglas–Peucker，与省界同款） ----------
def dp(points, tol):
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


def simplify_line(line, tol):
    lat0 = sum(p[1] for p in line) / len(line)
    k = math.cos(lat0 * math.pi / 180.0) * 111320.0
    pts = [(lon * k, lat * 110540.0) for lon, lat in line]
    idx = dp(pts, tol)
    if len(idx) < 2:
        return None
    out, last = [], None
    for i in idx:
        p = [round(line[i][0], 5), round(line[i][1], 5)]
        if last is None or p != last:
            out.append(p)
            last = p
    return out if len(out) >= 2 else None


def dist_m(a, b):
    kx = math.cos((a[1] + b[1]) / 2 * math.pi / 180.0) * 111320.0
    return math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * 110540.0)


# ---------- 共边提取与链组装 ----------
def edge_key(a, b):
    return (a, b) if a <= b else (b, a)


def main():
    ap = argparse.ArgumentParser(description="OSM 上海 16 区区界（WGS84）→ 共边净化＋简化 GeoJSON（查看器区级行政区划界线底图）")
    ap.add_argument("--src", default=str(ROOT / "零散" / "区界源件-OSM"), help="原始件目录（含 osm_rel<id>_<名>.geojson；默认 零散/区界源件-OSM）")
    ap.add_argument("--fetch", action="store_true", help="缺件时从 polygons.openstreetmap.fr 拉取（默认只读本地件）")
    ap.add_argument("--save-raw", dest="save_raw", action="store_true", help="fetch 时把原始件按惯例名落盘存档到 --src 目录")
    ap.add_argument("--out", default=str(ROOT / OUT_REL), help="输出路径（默认 basemap/districts-wgs84.json）")
    ap.add_argument("--tol-m", type=float, default=60.0, help="Douglas–Peucker 容差（米，默认 60）")
    args = ap.parse_args()
    src_dir = Path(args.src)

    # 省界件（大包络）：共边排除基准＋上海市域包络 bbox（净化异地假环）
    prov_geom = json.loads(load_raw(PROV_SH[0], PROV_SH[1], src_dir, args.save_raw if args.fetch else False))
    prov_edges = set()
    b0 = ring_bbox(rings_of(prov_geom)[0])   # poly0 外环 bbox＝上海全境包络（含三岛与长江口水域）
    sh_bbox = (b0[0] - 0.02, b0[1] - 0.02, b0[2] + 0.02, b0[3] + 0.02)
    for ring in rings_of(prov_geom):
        pts = [(round(x[0], 7), round(x[1], 7)) for x in ring]
        for a, b in zip(pts, pts[1:]):
            prov_edges.add(edge_key(a, b))

    # 边登记（一次遍历双结构）：edge → owner 区名集合（跨区判定）＋ (edge, owner) → 命中数
    #（同 owner 双侧命中≥2 ＝ 区内部界线，如崇明乡镇相邻环——须与跨区共边区分开）。
    # round 7 位精确匹配：两侧 relation 引用同一 way 时 polygons 输出坐标一致（实测吻合）。
    edge_owners = {}
    owner_hits = {}
    for unit_name, rel_id, owner in UNITS:
        geom = json.loads(load_raw(unit_name, rel_id, src_dir, args.save_raw if args.fetch else False))
        kept = 0
        for ring in rings_of(geom):
            bb = ring_bbox(ring)
            if not bbox_overlap(bb, sh_bbox):
                continue   # 异地假环：与上海全境包络无交集，整环丢弃（净化一）
            kept += 1
            pts = [(round(x[0], 7), round(x[1], 7)) for x in ring]
            for a, b in zip(pts, pts[1:]):
                k = edge_key(a, b)
                edge_owners.setdefault(k, set()).add(owner)
                owner_hits[(k, owner)] = owner_hits.get((k, owner), 0) + 1
        print("%s（%d）：界内环 %d 个" % (unit_name, rel_id, kept))

    # 边分类：区界边＝跨区共边 ∨ 单侧外缘；丢弃＝省界共边（省界层已画）∨ 同 owner 双侧
    #（区内部界线，如崇明乡镇间）
    final_edges = {}
    n_shared = n_outer = n_prov = n_inner = 0
    for e, owners in edge_owners.items():
        if e in prov_edges:
            n_prov += 1
            continue
        if any(owner_hits[(e, o)] >= 2 for o in owners):
            n_inner += 1
            continue
        if len(owners) >= 2:
            final_edges[e] = ("between", "|".join(sorted(owners)))
            n_shared += 1
        else:
            final_edges[e] = ("outer", next(iter(owners)))
            n_outer += 1
    print("边分类：跨区共边 %d｜单侧外缘 %d｜省界共边（丢） %d｜区内部共边（丢） %d"
          % (n_shared, n_outer, n_prov, n_inner))

    # 链组装：分组 → 组内邻接表 → 贪心走链（T 型交点处断链，视觉无缝）
    groups = {}
    for e, g in final_edges.items():
        groups.setdefault(g, []).append(e)
    feats_out = []
    total_m = 0.0
    for g in sorted(groups):
        edges = sorted(groups[g])
        adj = {}
        for a, b in edges:
            adj.setdefault(a, []).append(b)
            adj.setdefault(b, []).append(a)
        unused = set(edges)
        lines = []
        for start in edges:
            if start not in unused:
                continue
            # 从 (start) 任一端起走链
            chain = [start[0], start[1]]
            unused.discard(start)
            # 向两端各走一次：先从尾端续，再回头从头端续
            for direction in (1, 0):
                while True:
                    tip = chain[-1] if direction else chain[0]
                    nxt = None
                    for cand in adj.get(tip, []):
                        e2 = edge_key(tip, cand)
                        if e2 in unused:
                            nxt = cand
                            unused.discard(e2)
                            break
                    if nxt is None:
                        break
                    if direction:
                        chain.append(nxt)
                    else:
                        chain.insert(0, nxt)
            if len(chain) >= 2:
                lines.append(chain)
        # 简化（先匹配后简化，保证共边对齐不破坏）
        simp = []
        for chain in lines:
            s = simplify_line([[p[0], p[1]] for p in chain], args.tol_m)
            if s is not None:
                simp.append(s)
                total_m += sum(dist_m(a, b) for a, b in zip(s, s[1:]))
        if not simp:
            continue
        kind, who = g
        props = {"level": "district", kind: who}
        feats_out.append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "MultiLineString", "coordinates": simp},
        })
        print("  %s/%s：%d 链" % (kind, who, len(simp)))

    fc = {"type": "FeatureCollection", "features": feats_out}
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(fc, ensure_ascii=False, separators=(",", ":")) + "\n"
    out_path.write_text(text, encoding="utf-8", newline="")   # UTF-8 无 BOM
    print("落盘：%s  %s B（%d 要素，区界线总长约 %.0f km）"
          % (out_path, format(out_path.stat().st_size, ","), len(feats_out), total_m / 1000))


if __name__ == "__main__":
    main()
