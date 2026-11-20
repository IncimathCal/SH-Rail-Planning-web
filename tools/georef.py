#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""标定试验工具（阶段 0）：SVG → 经纬度 多项式变换拟合与残差报告。

方法：
    1. SVG path 与 KML 折线各自建立弧长参数化（KML 先投影到米制局部坐标系）
    2. 对齐：归一化弧长 t 相同的点视为对应点；自动尝试 KML 正反两个方向
    3. 头尾长度失准建模：t_kml = (t_svg - ds) / (1 - ds - de)，
       ds/de 为两端弧长偏差，网格搜索取残差最小者（正是用户所说的"头尾失准"）
    4. 最小二乘拟合多项式 lon=f(u,v), lat=g(u,v)（u,v 为归一化 SVG 坐标），
       阶次 1（仿射基准）/2/3，正规方程 + 高斯消元，纯标准库
    5. 残差以米计：总量误差 + 横向误差（到真实折线的垂直距离）

用法：
    python tools/georef.py <file.svg> <file.kml|.kmz> [--samples 241] [--trim 0.02]
控制台输出为英文（Windows 控制台编码兼容）。
"""

import argparse
import datetime
import json
import math
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from svg_parse import ArcPath, load_svg_paths  # noqa: E402

M_PER_DEG_LAT = 111320.0
KML_NS = "{http://www.opengis.net/kml/2.2}"


# ---------- KML / KMZ 读取 ----------

def load_kml(file):
    """读取 KML/KMZ → [(名称, [(lon,lat), ...]), ...]（仅 LineString 地标）。"""
    file = str(file)
    if file.lower().endswith(".kmz"):
        with zipfile.ZipFile(file) as z:
            inner = next(n for n in z.namelist() if n.lower().endswith(".kml"))
            root = ET.fromstring(z.read(inner))
    else:
        root = ET.parse(file).getroot()
    out = []
    for pm in root.iter(f"{KML_NS}Placemark"):
        cs = pm.find(f".//{KML_NS}LineString/{KML_NS}coordinates")
        if cs is None or not cs.text:
            continue
        pts = []
        for tok in cs.text.split():
            lon, lat, *_ = tok.split(",")
            pts.append((float(lon), float(lat)))
        if len(pts) >= 2:
            out.append((pm.findtext(f"{KML_NS}name") or "?", pts))
    return out


def line_key(name):
    """名称 → 线路编号键（'6号线(2007)'→'6'，'23号线一期'→'23'）。"""
    m = re.search(r"\d+", name)
    return m.group(0) if m else name


# ---------- 米制局部坐标系 ----------

class GeoArc:
    """KML 折线：经纬度 + 局部等距圆柱投影（米）双坐标，弧长参数化。"""

    def __init__(self, lonlat):
        self.lonlat = lonlat
        self.lat0 = sum(p[1] for p in lonlat) / len(lonlat)
        self.m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(self.lat0))
        self.arc = ArcPath([(p[0] * self.m_per_deg_lon, p[1] * M_PER_DEG_LAT) for p in lonlat])

    def at(self, t):
        """t → ((mx,my), (lon,lat))。"""
        mx, my = self.arc.point_at(t)
        return (mx, my), (mx / self.m_per_deg_lon, my / M_PER_DEG_LAT)

    def dist_to_path(self, mx, my):
        """点到真实折线的最近距离（米）= 横向误差。"""
        best = float("inf")
        pts = self.arc.pts
        for a, b in zip(pts, pts[1:]):
            ax, ay = a
            bx, by = b
            dx, dy = bx - ax, by - ay
            L2 = dx * dx + dy * dy
            if L2 < 1e-9:
                d2 = (mx - ax) ** 2 + (my - ay) ** 2
            else:
                s = max(0.0, min(1.0, ((mx - ax) * dx + (my - ay) * dy) / L2))
                d2 = (mx - ax - s * dx) ** 2 + (my - ay - s * dy) ** 2
            if d2 < best:
                best = d2
        return math.sqrt(best)


# ---------- 最小二乘（正规方程 + 高斯消元，部分主元） ----------

def solve_lstsq(A, b):
    """解 min ||Ax-b||：正规方程 (A'A)x = A'b。A: n×m，n≥m。"""
    n, m = len(A), len(A[0])
    N = [[sum(A[k][i] * A[k][j] for k in range(n)) for j in range(m)] +
         [sum(A[k][i] * b[k] for k in range(n))] for i in range(m)]
    for col in range(m):
        piv = max(range(col, m), key=lambda r: abs(N[r][col]))
        if abs(N[piv][col]) < 1e-12:
            raise ValueError("singular normal matrix")
        N[col], N[piv] = N[piv], N[col]
        for r in range(col + 1, m):
            f = N[r][col] / N[col][col]
            for c in range(col, m + 1):
                N[r][c] -= f * N[col][c]
    x = [0.0] * m
    for i in range(m - 1, -1, -1):
        s = N[i][m] - sum(N[i][j] * x[j] for j in range(i + 1, m))
        x[i] = s / N[i][i]
    return x


def features(u, v, deg):
    """多项式基：u^i v^j（i+j ≤ deg）。"""
    return [u ** i * v ** (j) for t in range(deg + 1) for i in range(t + 1) for j in [t - i]]


class PolyModel:
    """lon/lat 双通道多项式模型（u,v 归一化坐标 → 经纬度）。"""

    def __init__(self, cx, cy, scale, deg, c_lon, c_lat):
        self.cx, self.cy, self.scale, self.deg = cx, cy, scale, deg
        self.c_lon, self.c_lat = c_lon, c_lat

    def apply(self, x, y):
        u, v = (x - self.cx) / self.scale, (y - self.cy) / self.scale
        f = features(u, v, self.deg)
        return (sum(a * b for a, b in zip(self.c_lon, f)),
                sum(a * b for a, b in zip(self.c_lat, f)))


def fit_model(samples, deg, cx, cy, scale):
    """samples: [(x_svg, y_svg, lon, lat)] → PolyModel。"""
    A = [features((x - cx) / scale, (y - cy) / scale, deg) for x, y, _, _ in samples]
    c_lon = solve_lstsq(A, [lon for _, _, lon, _ in samples])
    c_lat = solve_lstsq(A, [lat for _, _, _, lat in samples])
    return PolyModel(cx, cy, scale, deg, c_lon, c_lat)


# ---------- 对应点采样与指标 ----------

def make_samples(svg, geo, ds, de, t_lo, t_hi, n):
    """按 t_svg ∈ [t_lo,t_hi] 均匀采样；t 经头尾偏差 (ds,de) 校正后查 KML。"""
    out = []
    for i in range(n):
        t = t_lo + (t_hi - t_lo) * i / (n - 1)
        tk = (t - ds) / (1 - ds - de)
        if not 0.0 <= tk <= 1.0:
            continue
        x, y = svg.point_at(t)
        _, lonlat = geo.at(tk)
        out.append((x, y, lonlat[0], lonlat[1], t))
    return out


def resid_stats(model, samples, geo):
    """返回 (rms, mean, p95, max, rms_cross, max_cross)，单位米。"""
    tot, cross = [], []
    for x, y, lon, lat, _ in samples:
        plon, plat = model.apply(x, y)
        dx = (plon - lon) * geo.m_per_deg_lon
        dy = (plat - lat) * M_PER_DEG_LAT
        tot.append(math.hypot(dx, dy))
        cross.append(geo.dist_to_path(plon * geo.m_per_deg_lon, plat * M_PER_DEG_LAT))
    tot_s, cross_s = sorted(tot), sorted(cross)

    def pct(a, p):
        return a[min(len(a) - 1, int(p * len(a)))]

    return (math.sqrt(sum(x * x for x in tot) / len(tot)),
            sum(tot) / len(tot),
            pct(tot_s, 0.95),
            tot_s[-1],
            math.sqrt(sum(x * x for x in cross) / len(cross)),
            cross_s[-1])


def fmt(stats):
    return (f"rms {stats[0]:7.1f}  mean {stats[1]:7.1f}  p95 {stats[2]:7.1f}  "
            f"max {stats[3]:8.1f}  |  cross rms {stats[4]:6.1f}  max {stats[5]:7.1f}")


# ---------- 单线实验 ----------

def orient_kml(svg, geo_fwd, geo_rev):
    """快速判向：中间 60% 采样 + 二阶拟合，取 RMS 小者。"""
    best = None
    for tag, geo in (("fwd", geo_fwd), ("rev", geo_rev)):
        s = make_samples(svg, geo, 0.0, 0.0, 0.2, 0.8, 61)
        cx = sum(p[0] for p in s) / len(s)
        cy = sum(p[1] for p in s) / len(s)
        model = fit_model([p[:4] for p in s], 2, cx, cy, 2000.0)
        r = resid_stats(model, s, geo)
        if best is None or r[0] < best[1][0]:
            best = (tag, r, geo)
    return best[0], best[2]


def search_warp(svg, geo, trim, n_fit):
    """网格搜索头尾弧长偏差 (ds,de)，返回 (ds, de)。"""
    best = None
    rng = [i / 100 for i in range(-4, 5)]  # -0.04 .. +0.04
    for ds in rng:
        for de in rng:
            s = make_samples(svg, geo, ds, de, trim, 1 - trim, n_fit)
            if len(s) < n_fit // 2:
                continue
            cx = sum(p[0] for p in s) / len(s)
            cy = sum(p[1] for p in s) / len(s)
            model = fit_model([p[:4] for p in s], 2, cx, cy, 2000.0)
            r = resid_stats(model, s, geo)[0]
            if best is None or r < best[0]:
                best = (r, ds, de)
    return best[1], best[2]


def eval_bins(model, svg, geo, ds, de, n=121):
    """按 t 十等分桶报告总误差 max（看头尾失准的空间分布）。"""
    rows = []
    for b in range(10):
        lo, hi = b / 10, (b + 1) / 10
        s = make_samples(svg, geo, ds, de, lo, hi, max(n // 10, 3))
        if not s:
            rows.append(None)
            continue
        rows.append(max(math.hypot((model.apply(x, y)[0] - lon) * geo.m_per_deg_lon,
                                   (model.apply(x, y)[1] - lat) * M_PER_DEG_LAT)
                        for x, y, lon, lat, _ in s))
    return rows


# ---------- 主流程 ----------

def build_all_samples(matched, warp_store, n):
    """全部匹配线路（含各自头尾偏差校正）的控制点合集。"""
    s_all = []
    for name, _, svg, geo in matched:
        ds, de = warp_store[name]
        s_all += make_samples(svg, geo, ds, de, 0.02, 0.98, n)
    return s_all


def emit_calibration(matched, warp_store, n, gx, gy, gsc, kml_name, out_path):
    """拟合全局 deg3（编辑器底图/geo 派生用）并写 fmt/calibration@1。"""
    s_all = build_all_samples(matched, warp_store, n)
    if not s_all:
        print("emit skipped: no matched lines")
        return
    deg3 = fit_model([p[:4] for p in s_all], 3, gx, gy, gsc)
    aff = fit_model([p[:4] for p in s_all], 1, gx, gy, gsc)
    geo0 = matched[0][3]
    tot = [math.hypot((deg3.apply(x, y)[0] - lon) * geo0.m_per_deg_lon,
                      (deg3.apply(x, y)[1] - lat) * M_PER_DEG_LAT)
           for x, y, lon, lat, _ in s_all]
    calib = {
        "schema": "fmt/calibration@1",
        "method": "poly3",
        "uv": {"cx": gx, "cy": gy, "scale": gsc},
        # coefOrder: [1, u, v, u^2, uv, v^2, u^3, u^2v, uv^2, v^3]
        #   u = (x_svg - cx)/scale, v = (y_svg - cy)/scale
        # affine*（deg1）用于 geo->svg 牛顿迭代的初值
        "coef": {
            "lon": deg3.c_lon, "lat": deg3.c_lat,
            "affineLon": aff.c_lon, "affineLat": aff.c_lat,
        },
        "residuals": {
            "n": len(s_all),
            "rms": round(math.sqrt(sum(v * v for v in tot) / len(tot)), 1),
            "mean": round(sum(tot) / len(tot), 1),
            "max": round(max(tot), 1),
        },
        "controlLines": [
            {"sourceLayer": name, "kml": kml_name,
             "warp": [round(warp_store[name][0], 4), round(warp_store[name][1], 4)]}
            for name, _, _, _ in matched
        ],
        "fitted": datetime.date.today().isoformat(),
        "note": "svg->lon/lat polynomial; editor basemap & geo derivation; "
                "refit when more GE control lines are added",
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(calib, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"calibration written: {out_path}  (n={len(s_all)}, "
          f"rms {calib['residuals']['rms']} m, max {calib['residuals']['max']} m)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("svg")
    ap.add_argument("kml")
    ap.add_argument("--samples", type=int, default=241)
    ap.add_argument("--emit", action="store_true",
                    help="fit global deg3 and write data/calibration.json (fmt/calibration@1)")
    args = ap.parse_args()

    svg_paths = load_svg_paths(args.svg)
    kml_lines = load_kml(args.kml)
    kml_by_key = {line_key(n): (n, pts) for n, pts in kml_lines}

    # 全局归一化基准（所有 SVG 点统一中心/尺度，保证全局模型可比）
    allx = [p[0] for *_, ap_ in svg_paths for p in ap_.pts]
    ally = [p[1] for *_, ap_ in svg_paths for p in ap_.pts]
    gx, gy = (min(allx) + max(allx)) / 2, (min(ally) + max(ally)) / 2
    gsc = max(max(allx) - min(allx), max(ally) - min(ally)) / 2

    matched = []
    print("=== Data ===")
    for _, name, color, ap in svg_paths:
        key = line_key(name)
        if key not in kml_by_key:
            print(f"  line {name}: no KML match (skipped)")
            continue
        kname, pts = kml_by_key[key]
        geo_fwd = GeoArc(pts)
        geo_rev = GeoArc(pts[::-1])
        tag, geo = orient_kml(ap, geo_fwd, geo_rev)
        matched.append((name, kname, ap, geo))
        print(f"  line {name} <-> KML '{kname}'  svg_len {ap.length:.0f}  "
              f"kml_len {geo.arc.length / 1000:.1f} km  kml_orient {tag}")

    N = args.samples
    if not matched:
        print("no matched lines, nothing to do")
        return 1
    print(f"\n=== Per-line fits (samples/fit = {N}, global normalization) ===")
    print(f"{'line':>4} {'cfg':<14} {'stats (meters)':>0}")
    warp_store = {}
    for name, kname, svg, geo in matched:
        # A. 恒等 t 对应 + 各阶次（不裁剪，留 2% 护边）
        for deg in (1, 2, 3):
            s = make_samples(svg, geo, 0, 0, 0.02, 0.98, N)
            model = fit_model([p[:4] for p in s], deg, gx, gy, gsc)
            print(f"{name:>4} {'A id-t deg' + str(deg):<14} {fmt(resid_stats(model, s, geo))}")
        # B. 裁剪两端 10% 后拟合，评估仍分三段
        s = make_samples(svg, geo, 0, 0, 0.10, 0.90, N)
        for deg in (2, 3):
            model = fit_model([p[:4] for p in s], deg, gx, gy, gsc)
            print(f"{name:>4} {'B trim.1 deg' + str(deg):<14} {fmt(resid_stats(model, s, geo))}")
        # C. 头尾偏差校正 (ds,de)：拟合带 2% 护边，评估全段
        ds, de = search_warp(svg, geo, 0.02, 121)
        warp_store[name] = (ds, de)
        s = make_samples(svg, geo, ds, de, 0.02, 0.98, N)
        model = fit_model([p[:4] for p in s], 3, gx, gy, gsc)
        print(f"{name:>4} {'C warp deg3':<14} {fmt(resid_stats(model, s, geo))}   "
              f"(ds {ds:+.2f} de {de:+.2f} -> end err "
              f"{ds * geo.arc.length / 1000:+.2f}/{de * geo.arc.length / 1000:+.2f} km)")
        # C 的 hold-out：偶数样本拟合，奇数样本评估
        s_all = make_samples(svg, geo, ds, de, 0.02, 0.98, N)
        tr = [p[:4] for p in s_all[::2]]
        ev = s_all[1::2]
        model = fit_model(tr, 3, gx, gy, gsc)
        print(f"{name:>4} {'C holdout d3':<14} {fmt(resid_stats(model, ev, geo))}")
        # t 分桶 max（deg3 + warp）：头尾 vs 中段
        s_fit = make_samples(svg, geo, ds, de, 0.02, 0.98, N)
        model = fit_model([p[:4] for p in s_fit], 3, gx, gy, gsc)
        bins = eval_bins(model, svg, geo, ds, de)
        pretty = " ".join(f"{v:.0f}" if v is not None else "-" for v in bins)
        print(f"{name:>4} {'t-decile max':<14} [{pretty}]  (head ... tail)")

    # ---------- 全局模型 ----------
    print("\n=== Global model (all lines, per-line warp applied) ===")
    s_all = build_all_samples(matched, warp_store, N)
    for deg in (2, 3):
        model = fit_model([p[:4] for p in s_all], deg, gx, gy, gsc)
        tot = []
        for x, y, lon, lat, _ in s_all:
            plon, plat = model.apply(x, y)
            geo0 = matched[0][3]
            tot.append(math.hypot((plon - lon) * geo0.m_per_deg_lon, (plat - lat) * M_PER_DEG_LAT))
        rms = math.sqrt(sum(v * v for v in tot) / len(tot))
        print(f"  deg{deg}: n {len(s_all)}  rms {rms:6.1f} m  "
              f"mean {sum(tot) / len(tot):6.1f}  max {max(tot):7.1f}")
    # leave-one-line-out
    print("  leave-one-line-out (deg3):")
    for skip in matched:
        tr = []
        skip_name = skip[0]
        for name, _, svg, geo in matched:
            ds, de = warp_store[name]
            s = make_samples(svg, geo, ds, de, 0.02, 0.98, N)
            if name != skip_name:
                tr.extend(p[:4] for p in s)
        model = fit_model(tr, 3, gx, gy, gsc)
        sg, gg = skip[2], skip[3]
        ds, de = warp_store[skip_name]
        ev_full = make_samples(sg, gg, ds, de, 0.02, 0.98, N)
        r = resid_stats(model, ev_full, gg)
        print(f"    hold {skip_name:>2}: {fmt(r)}")

    if args.emit:
        out = Path(__file__).resolve().parent.parent / "data" / "calibration.json"
        emit_calibration(matched, warp_store, N, gx, gy, gsc, Path(args.kml).name, out)

    print("\nDone.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
