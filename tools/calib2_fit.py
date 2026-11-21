# -*- coding: utf-8 -*-
"""calib2_fit —— 边缘标定 TPS 落地拟合（标定试验-02 推荐方案 M3 的可复跑脚本）。

模型：svg(x,y) → [lon,lat] = affine(km 坐标) + Σ w_i · U(|p-p_i|²)，
      U(r2) = r2·ln(r2)（kernel 坐标 km = svg × scaleToKm=0.00972），pdeg=1，λ=100。

控制集（与 标定试验-02 §4.1 口径一致，AB 主集 4006 点 / 22 线）：
  - 21 条配对线控制点：零散/calib2_pairs.json（W3 的 calib2_match/pairs 产物，只读；
    本地 gitignore，缺失时按 标定试验-02 附录 A 重生成：
    cd 零散 && python -X utf8 calib2_match.py && python -X utf8 calib2_pairs.py）；
    点级 tier 取 A/B（既有/近期批复）。
  - 中 4 线（6/14/15/23，tier C4）：由 旧SVG + 同名 KMZ + deg3 标定的头尾 warp 重建
    （采样 n=241 / trim 0.02，平移 +4684.90,+4040.53 至 .ai 页面基准）——warp 必须从
    旧 deg3 标定文件读（--legacy），被替换后的 data/calibration.json 已无 controlLines。

输出：
  --out   新标定 JSON（fmt/calibration@2，model:"tps"；坐标 6 位小数、权重 12 位有效数字）
  --check node 对拍真值 tools/fixtures/calib_check.json（新旧模型 forward/inverse 各若干点）

用法（项目根）：
  python -X utf8 tools/calib2_fit.py                       # 默认全参数
  python -X utf8 tools/calib2_fit.py --lambda 100 --dry    # 只评估不写文件
"""

import argparse
import datetime
import json
import math
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))          # svg_parse
sys.path.insert(0, str(ROOT / "零散"))           # calib2_lib（只读使用）
import svg_parse  # noqa: E402
import calib2_lib as L  # noqa: E402  W3 共享库：fit_tps / TruthGroup / 分级（只读）

# 旧框选基准 → .ai 页面基准 平移（与 calib2_lib.SHIFT_AI 一致）
SHIFT_AI = (4684.90, 4040.53)
LAM_DEFAULT = 100.0
PDEG = 1
TIERS_MAIN = ("A", "B", "C4")


# ------------------------------------------------ 中 4 线重建（warp 来自 legacy） --

def rebuild_central4(legacy_js):
    """与 calib2_lib.rebuild_central4 同构，唯 warp 取自 legacy（旧 deg3）标定 JSON。
    返回 [(line, x_ai, y_ai, lon, lat)]。"""
    warp = {c["sourceLayer"]: tuple(c["warp"]) for c in legacy_js["controlLines"]}
    svg_paths = {re.search(r"\d+", name).group(0): ap
                 for _, name, _c, ap in svg_parse.load_svg_paths(str(ROOT / "源资产/6、14、15、23号线.svg"))}
    kml = {re.search(r"\d+", n).group(0): pts for n, pts
           in L.load_kml_placemarks(ROOT / "源资产/6、14、15、23号线.kmz")}
    out = []
    for name, (ds, de) in warp.items():
        key = re.search(r"\d+", name).group(0)
        ap, pts = svg_paths[key], kml[key]
        lat0 = sum(p[1] for p in pts) / len(pts)
        k = L.m_per_deg(lat0)
        geo_fwd = svg_parse.ArcPath([(p[0] * k, p[1] * L.M_PER_DEG_LAT) for p in pts])
        # 判向（同 W3）：中间 60% 采样 + 单线 deg2，取 RMS 小者
        cand = []
        for geo in (geo_fwd, svg_parse.ArcPath(geo_fwd.pts[::-1])):
            s = []
            for i in range(61):
                t = 0.2 + 0.6 * i / 60
                tk = (t - ds) / (1 - ds - de)
                if not 0.0 <= tk <= 1.0:
                    continue
                x, y = ap.point_at(t)
                mx, my = geo.point_at(tk)
                s.append((x, y, mx / k, my / L.M_PER_DEG_LAT))
            xs = np.array([p[0] for p in s]); ys = np.array([p[1] for p in s])
            cx, cy = xs.mean(), ys.mean()
            b = L._basis((xs - cx) / 2000.0, (ys - cy) / 2000.0, 2)
            z = np.array([[p[2], p[3]] for p in s])
            c, *_ = np.linalg.lstsq(b, z, rcond=None)
            r = np.hypot((b @ c - z)[:, 0] * k, (b @ c - z)[:, 1] * L.M_PER_DEG_LAT)
            cand.append((float(np.sqrt((r ** 2).mean())), geo))
        geo = min(cand, key=lambda c: c[0])[1]
        n = 241
        for i in range(n):
            t = 0.02 + 0.96 * i / (n - 1)
            tk = (t - ds) / (1 - ds - de)
            if not 0.0 <= tk <= 1.0:
                continue
            x, y = ap.point_at(t)
            mx, my = geo.point_at(tk)
            out.append((name, x + SHIFT_AI[0], y + SHIFT_AI[1],
                        mx / k, my / L.M_PER_DEG_LAT))
    return out


# ------------------------------------------------------------- 控制集组装 --

def load_control_sets(pairs_path, legacy_js):
    """{key: {group, xy, ll, tiers, tg}}，key = 'path-NN:组名' / 'C4:线名'。
    与 零散/calib2_fit.py::load_control_sets 同构。"""
    pairs = json.loads(Path(pairs_path).read_text(encoding="utf-8"))
    groups, _ = L.load_truth_groups()
    tgs = {g: L.TruthGroup(g, groups[g]["segs"]) for g in groups}
    per_line = {}
    for pk, rec in pairs.items():
        if rec.get("failed") or not rec.get("cps"):
            continue
        gname = rec["group"]
        seg_tiers = [s["tier"] for s in groups[gname]["segs"]]
        cps = rec["cps"]
        gi = np.array([c[4] for c in cps], int)
        per_line[f"{pk}:{gname}"] = {
            "group": gname, "path": pk, "tg": tgs[gname],
            "xy": np.array([[c[0], c[1]] for c in cps]),
            "ll": np.array([[c[2], c[3]] for c in cps]),
            "tiers": np.array([seg_tiers[g] for g in gi])}
    c4 = rebuild_central4(legacy_js)
    for name in ("6号线", "14号线", "15号线", "23号线"):
        pts = [p for p in c4 if p[0] == name]
        per_line[f"C4:{name}"] = {
            "group": name, "path": "旧SVG", "tg": None,
            "xy": np.array([[p[1], p[2]] for p in pts]),
            "ll": np.array([[p[3], p[4]] for p in pts]),
            "tiers": np.array(["C4"] * len(pts))}
    return per_line


def line_mask(e, tiers):
    return np.isin(e["tiers"], list(tiers))


def eval_model(model, per_line, keys, tiers):
    """逐线 + 汇总残差（米；总误差 + 对真值折线的横向误差）。"""
    rows, allr = [], []
    for k in keys:
        e = per_line[k]
        m = line_mask(e, tiers)
        if not m.any():
            continue
        xy, ll = e["xy"][m], e["ll"][m]
        r = L.resid_m(model, xy, ll)
        cross = None
        if e.get("tg") is not None:
            pred = model.apply(xy)
            tg = e["tg"]
            qm = np.stack([pred[:, 0] * tg.k, pred[:, 1] * L.M_PER_DEG_LAT], axis=1)
            cross, _, _ = tg.nearest(qm)
        tt = "/".join(sorted(set(e["tiers"][m])))
        rows.append((k, tt, L.stats(r), None if cross is None else L.stats(cross)))
        allr.append(r)
    return rows, L.stats(np.concatenate(allr))


# ------------------------------------------------------------- TPS 求值/反演 --

def deg3_inverse_safe(cal, lonlat, iters=30):
    """L.Calib.inverse 的带保护版（W3 库只读；外推点牛顿可能奇异，失败返回当前值）。"""
    lonlat = np.asarray(lonlat, float)
    uv = cal._affine_inv(lonlat)
    for _ in range(iters):
        b = L._basis(uv[0:1], uv[1:2], 3)[0]
        f = np.array([b @ cal.c_lon, b @ cal.c_lat])
        J = np.empty((2, 2))
        for j in range(2):
            e = np.zeros(2); e[j] = 1e-6
            bp = L._basis((uv + e)[0:1], (uv + e)[1:2], 3)[0]
            # 注意：calib2_lib.Calib.inverse 的同段差分漏除步长 h（W3 只用正向未暴露），
            # 此处按编辑器 src/editor.js 的正确口径（差分 / h）实现
            J[:, j] = (np.array([bp @ cal.c_lon, bp @ cal.c_lat]) - f) / 1e-6
        try:
            step = np.linalg.solve(J, lonlat - f)
        except np.linalg.LinAlgError:
            break
        uv = uv + step
        if not (np.isfinite(uv).all()):
            return None
        if abs(step).max() < 1e-12:
            break
    return np.array([uv[0] * cal.sc + cal.cx, uv[1] * cal.sc + cal.cy])


def tps_apply_exported(cp, affine, scale_to_km, xy):
    """按导出 JSON 的（已舍入）系数求值——round-trip 质检用，与 src/editor.js 同式。"""
    xy = np.atleast_2d(np.asarray(xy, float))
    km = xy * scale_to_km
    pkm = np.asarray(cp)[:, :2] * scale_to_km
    w = np.asarray(cp)[:, 2:4]
    d2 = ((km[:, None, :] - pkm[None, :, :]) ** 2).sum(-1)
    U = np.zeros_like(d2)
    msk = d2 > 1e-12
    U[msk] = d2[msk] * np.log(d2[msk])
    B = np.stack([np.ones(len(km)), km[:, 0], km[:, 1]], axis=1)
    return U @ w + B @ np.asarray(affine).T        # affine:[2,3] → [c0,c1,c2]×[lon,lat]


def tps_inverse(model, lonlat, iters=50, tol=1e-12):
    """TPS 反演：affine 种子 + 牛顿迭代（解析雅可比）。单点 [lon,lat] → [x,y]（svg）。"""
    a = model.c                      # (3,2) 仿射系数 [c0,c1,c2]×[lon,lat]
    lon, lat = float(lonlat[0]), float(lonlat[1])
    det = a[1, 0] * a[2, 1] - a[2, 0] * a[1, 1]
    if abs(det) < 1e-15:
        return None
    u = ((lon - a[0, 0]) * a[2, 1] - (lat - a[0, 1]) * a[2, 0]) / det
    v = ((lat - a[0, 1]) * a[1, 0] - (lon - a[0, 0]) * a[1, 1]) / det
    k = model.SCALE_TO_KM
    w = model.w                       # (n,2)
    pkm = model.Pkm                   # (n,2) km
    for _ in range(iters):
        d = np.array([u, v]) - pkm    # (n,2)
        d2 = (d * d).sum(1)
        lp = np.log(np.where(d2 > 1e-12, d2, 1.0)) + 1.0    # dU/dd2 = ln(d2)+1
        lp = np.where(d2 > 1e-12, lp, 0.0)
        f = np.array([w[:, 0] @ (d2 * np.log(np.where(d2 > 1e-12, d2, 1.0)) * (d2 > 1e-12))
                      + a[0, 0] + a[1, 0] * u + a[2, 0] * v,
                      w[:, 1] @ (d2 * np.log(np.where(d2 > 1e-12, d2, 1.0)) * (d2 > 1e-12))
                      + a[0, 1] + a[1, 1] * u + a[2, 1] * v])
        g = f - np.array([lon, lat])
        if np.hypot(*g) < tol:
            break
        J = np.empty((2, 2))          # ∂f/∂(u,v) = Σ w·(ln d2+1)·2d + [c1,c2]
        for o in range(2):
            J[o, 0] = (w[:, o] * lp * 2 * d[:, 0]).sum() + a[1, o]
            J[o, 1] = (w[:, o] * lp * 2 * d[:, 1]).sum() + a[2, o]
        try:
            step = np.linalg.solve(J, g)
        except np.linalg.LinAlgError:
            return None
        u, v = u - step[0], v - step[1]
        if not (np.isfinite(u) and np.isfinite(v)):
            return None
    return np.array([u / k, v / k])


# ------------------------------------------------------------------- 主流程 --

def stats_s(s):
    return f"rms {s['rms']:7.1f} mean {s['mean']:7.1f} max {s['max']:8.1f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--legacy", default=None,
                    help="旧 deg3 标定（读 controlLines warp 重建中4线）；默认自动探测")
    ap.add_argument("--pairs", default=str(ROOT / "零散" / "calib2_pairs.json"))
    ap.add_argument("--out", default=str(ROOT / "data" / "calibration.json"))
    ap.add_argument("--check", default=str(ROOT / "tools" / "fixtures" / "calib_check.json"))
    ap.add_argument("--lambda", dest="lam", type=float, default=LAM_DEFAULT)
    ap.add_argument("--dry", action="store_true", help="只拟合评估，不写任何文件")
    args = ap.parse_args()

    legacy_path = Path(args.legacy) if args.legacy else next(
        (p for p in (ROOT / "data" / "calibration-deg3-backup.json", ROOT / "data" / "calibration.json")
         if p.exists() and "controlLines" in json.loads(p.read_text(encoding="utf-8"))), None)
    if legacy_path is None:
        sys.exit("找不到旧 deg3 标定（--legacy；需含 controlLines）")
    legacy_js = json.loads(legacy_path.read_text(encoding="utf-8"))
    m0 = L.Calib(legacy_js)
    print(f"legacy(deg3): {legacy_path}")

    per_line = load_control_sets(args.pairs, legacy_js)
    keys_all = sorted(per_line)
    keys_main = [k for k in keys_all if line_mask(per_line[k], TIERS_MAIN).any()]
    keys_c4 = [k for k in keys_all if k.startswith("C4:")]

    xy = np.vstack([per_line[k]["xy"][line_mask(per_line[k], TIERS_MAIN)] for k in keys_main])
    ll = np.vstack([per_line[k]["ll"][line_mask(per_line[k], TIERS_MAIN)] for k in keys_main])
    print(f"控制集：{len(keys_main)} 线 {len(xy)} 点（tier {'/'.join(TIERS_MAIN)}）")

    # ---- M0 旧标定（对照） ----
    rows0, tot0 = eval_model(m0, per_line, keys_main, TIERS_MAIN)
    print(f"\n== M0 旧 deg3（对照）==  {stats_s(tot0)}")
    c40 = dict((k.split(":")[1], s) for k, _t, s, _c in eval_model(m0, per_line, keys_c4, TIERS_MAIN)[0])
    print("  中4线 RMS: " + "  ".join(f"{n} {c40[n]['rms']:.1f}" for n in ("14号线", "15号线", "23号线", "6号线")))

    # ---- M3 拟合（推荐方案） ----
    m3 = L.fit_tps(xy, ll, args.lam, PDEG)
    rows3, tot3 = eval_model(m3, per_line, keys_main, TIERS_MAIN)
    print(f"\n== M3 TPS pdeg={PDEG} λ={args.lam:g} ==  {stats_s(tot3)}")
    c43 = dict((k.split(":")[1], s) for k, _t, s, _c in eval_model(m3, per_line, keys_c4, TIERS_MAIN)[0])
    print("  中4线 RMS: " + "  ".join(f"{n} {c43[n]['rms']:.1f}" for n in ("14号线", "15号线", "23号线", "6号线")))

    print("\n== 逐线残差（总 RMS / max ｜横向 RMS，米）==")
    print(f"  {'线':<26}{'tier':<6}{'n':<5} {'M0 RMS':>8} {'M0 max':>8}  ‖  {'M3 RMS':>8} {'M3 max':>8} {'M3 横向':>8}")
    r0 = {k: (t, s, c) for k, t, s, c in rows0}
    for k, t, s, c in rows3:
        _t, s0, _c0 = r0[k]
        ch = f"{c['rms']:8.1f}" if c else "       -"
        print(f"  {k:<28}{t:<6}{s['n']:<5} {s0['rms']:8.1f} {s0['max']:8.1f}  ‖  {s['rms']:8.1f} {s['max']:8.1f}{ch}")

    # ---- 导出（含舍入 round-trip 质检） ----
    cp = [[round(float(px), 6), round(float(py), 6),
           float(f"{w[0]:.12g}"), float(f"{w[1]:.12g}")]
          for (px, py), w in zip(m3.Pkm / m3.SCALE_TO_KM, m3.w)]
    affine = [[float(f"{v:.12g}") for v in col] for col in m3.c.T]  # [ [lon c0,c1,c2], [lat c0,c1,c2] ]
    k = m3.SCALE_TO_KM
    pred_round = tps_apply_exported(cp, affine, k, xy)
    r_round = np.hypot((pred_round[:, 0] - ll[:, 0]) * L.m_per_deg(31.15),
                       (pred_round[:, 1] - ll[:, 1]) * L.M_PER_DEG_LAT)
    print(f"\n导出舍入后全集残差：{stats_s(L.stats(r_round))}（舍入前 {tot3['rms']:.1f}；差应 <0.1 m）")

    calib_js = {
        "schema": "fmt/calibration@2",
        "model": "tps",
        "kernel": {"name": "r2logr2", "coord": "km", "scaleToKm": k},
        "lambda": float(args.lam),
        "pdeg": PDEG,
        "affine": {"lon": affine[0], "lat": affine[1]},
        "controlPoints": cp,
        "meta": {
            "fitted": datetime.date.today().isoformat(),
            "method": "affine + regularized thin-plate spline, U(r2)=r2*ln(r2), km coords",
            "trainingSet": {
                "tiers": list(TIERS_MAIN), "lines": len(keys_main), "points": int(len(xy)),
                "pairsFile": "零散/calib2_pairs.json (W3 calib2_match+calib2_pairs, read-only)",
                "central4Source": "源资产/6、14、15、23号线.svg+kmz, warp from deg3 legacy",
                "reference": "标定试验-02-边缘标定方案.md"},
            "residuals": {
                "all": {"rms": round(tot3["rms"], 1), "max": round(tot3["max"], 1)},
                "central4": {n.replace("号线", ""): {"rms": round(c43[n]["rms"], 1)} for n in c43},
                "rounded": {"rms": round(float(np.sqrt((r_round ** 2).mean())), 1)}},
            "note": "svg->lon/lat；TPS 局部修正按线路真值整体拟合，边缘（临港/崇明/浦东东）较旧 deg3 大幅改善；"
                    "无真值区（沪崇-南通向/苏锡常向/吴江向）结果仅示意。旧模型备份 data/calibration-deg3-backup.json。"},
    }

    # ---- node 对拍真值 ----
    rng_pts = [(1000, 1000), (11000, 1000), (1000, 11000), (11000, 11000),
               (6000, 6000), (6358.33, 6069.03), (3000, 9000), (9000, 3000),
               (2000, 2000), (10000, 2000), (2000, 10000), (10000, 10000),
               (5900, 3600), (6520, 5330), (7500, 7500), (4500, 6000)]
    fwd_tps = [[x, y, *tps_apply_exported(cp, affine, k, [[x, y]])[0]] for x, y in rng_pts]
    inv_probe = [(121.10, 31.05), (121.90, 31.40), (121.45, 31.42), (121.55, 30.80), (121.20, 31.70), (121.80, 31.10)]

    def collect_inverse(fwd, inv_fn):
        rows, skipped = [], []
        for lon, lat in inv_probe:
            p = inv_fn([lon, lat])
            if p is None:
                skipped.append((lon, lat, "no-converge")); continue
            q = fwd([[p[0], p[1]]])
            rt = np.hypot((q[0][0] - lon) * L.m_per_deg(31.15), (q[0][1] - lat) * L.M_PER_DEG_LAT)
            if rt > 0.01:
                skipped.append((lon, lat, f"roundtrip {rt * 100:.2f}cm")); continue
            rows.append([lon, lat, float(p[0]), float(p[1])])
        return rows, skipped

    inv_tps, sk_t = collect_inverse(
        lambda pp: tps_apply_exported(cp, affine, k, pp), lambda ll: tps_inverse(m3, ll))
    fwd_d3 = [[x, y, *m0.apply([[x, y]])[0]] for x, y in rng_pts]
    inv_d3, sk_d = collect_inverse(
        lambda pp: m0.apply(pp), lambda ll: deg3_inverse_safe(m0, ll))
    for tag, sk in (("tps", sk_t), ("deg3", sk_d)):
        for lon, lat, why in sk:
            print(f"警告：{tag} 反演点 ({lon},{lat}) {why}，不进对拍真值")
    check_js = {
        "_doc": "新旧标定 forward/inverse 对拍真值（tools/calib2_fit.py 生成；node tools/test_calib.js 消费）",
        "tps": {"forward": fwd_tps, "inverse": inv_tps},
        "deg3": {"forward": fwd_d3, "inverse": inv_d3},
    }

    if args.dry:
        print("\n--dry：不写文件。")
        return

    Path(args.out).write_text(json.dumps(calib_js, ensure_ascii=False, separators=(",", ":")),
                              encoding="utf-8")
    Path(args.check).write_text(json.dumps(check_js, ensure_ascii=False, indent=1),
                                encoding="utf-8")
    sz = Path(args.out).stat().st_size
    print(f"\nwritten: {args.out}（{len(cp)} 控制点，{sz / 1024:.0f} KB）")
    print(f"written: {args.check}")


if __name__ == "__main__":
    main()
