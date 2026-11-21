# -*- coding: utf-8 -*-
"""calib_manual_fit —— 手动标定拟合（用户 Google Earth 标注的控制点，传统方式重拟合）。

控制集：data/manual-control-points.csv（tools/calib_manual_pick.py 选点、用户在
  Google Earth 按编号标注、KMZ 回填 lon/lat 的 WGS84 十进制度）。
  坐标为 .ai 页面基准 svg 坐标（12000×12000，与 import/远期图-全量.json 同基准）。

候选模型（svg(x,y) → [lon,lat]），留一交叉验证（LOO）选型：
  - deg1/deg2/deg3 全局多项式（中心化 u,v，基次序与 georef/editor 一致）；
  - affine + 正则 TPS，U(r2)=r2·ln(r2)，kernel 坐标 km = svg × 0.00972，pdeg=1，
    λ 网格搜索（38 点稀疏控制集，最优 λ 预计远大于 4006 点时代的 100）。
对照基线：现行 data/calibration.json（自动 TPS）与 deg3 备份在同 38 点上的残差。

输出（--dry 则只评估不写）：
  --out        新标定 JSON（fmt/calibration@2，model:"tps"；与编辑器 tps 槽兼容）
  --check      node 对拍真值 tools/fixtures/calib_check.json（仅重写 tps 节，deg3 节原样保留）
  --backup-old 覆盖前把现行标定备份到 data/calibration-autotps-backup.json

用法（项目根）：
  python -X utf8 tools/calib_manual_fit.py --dry      # 只看选型表
  python -X utf8 tools/calib_manual_fit.py            # 拟合＋写出
"""

import argparse
import csv
import datetime
import json
import math
import shutil
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent

# —— 与 零散/calib2_lib.py（W3）同口径，保证数字可比 ——
M_PER_DEG_LAT = 111320.0
SCALE_TO_KM = 0.00972          # ~9.72 m/svg 单位（标定试验-01 实测 9.67~9.80）
PDEG = 1
LAMBDAS = [30.0, 100.0, 300.0, 1000.0, 3000.0, 1e4, 3e4, 1e5, 3e5, 1e6]

RINGS = ("outer", "subouter", "middle", "inner")   # 与 calib_manual_pick.py 的 CSV 取值一致


def m_per_deg(lat):
    return M_PER_DEG_LAT * math.cos(math.radians(lat))


def resid_m(pred, ll, lat0):
    return np.hypot((pred[:, 0] - ll[:, 0]) * m_per_deg(lat0),
                    (pred[:, 1] - ll[:, 1]) * M_PER_DEG_LAT)


def stats(r):
    return {"n": len(r), "rms": float(np.sqrt((r ** 2).mean())),
            "max": float(np.abs(r).max())}


# ------------------------------------------------------------------ 多项式 --

def poly_basis(u, v, deg):
    cols = [np.ones_like(u)]
    for d in range(1, deg + 1):
        for k in range(d + 1):
            cols.append(u ** (d - k) * v ** k)
    return np.stack(cols, axis=1)          # 次序：1,u,v,u²,uv,v²,…（与 editor.poly3Basis 一致）


class PolyModel:
    def __init__(self, cx, cy, sc, deg, coef):
        self.cx, self.cy, self.sc, self.deg = cx, cy, sc, deg
        self.coef = coef                   # (m,2)

    def apply(self, xy):
        u = (xy[:, 0] - self.cx) / self.sc
        v = (xy[:, 1] - self.cy) / self.sc
        return poly_basis(u, v, self.deg) @ self.coef


def fit_poly(xy, ll, deg):
    cx, cy = xy.mean(0)
    sc = max(np.abs(xy - [cx, cy]).max(), 1.0)
    b = poly_basis((xy[:, 0] - cx) / sc, (xy[:, 1] - cy) / sc, deg)
    coef, *_ = np.linalg.lstsq(b, ll, rcond=None)
    return PolyModel(cx, cy, sc, deg, coef)


# ---------------------------------------------------------------------- TPS --

class TpsModel:
    def __init__(self, P, lam, w, c):
        self.P = np.asarray(P, float)      # svg 坐标
        self.Pkm = self.P * SCALE_TO_KM
        self.lam, self.w, self.c = lam, w, c   # c:(3,2) pdeg=1 [c0,c1,c2]×[lon,lat]

    def apply(self, xy):
        km = np.atleast_2d(np.asarray(xy, float)) * SCALE_TO_KM
        d2 = ((km[:, None, :] - self.Pkm[None, :, :]) ** 2).sum(-1)
        U = np.zeros_like(d2)
        m = d2 > 1e-12
        U[m] = d2[m] * np.log(d2[m])
        B = np.stack([np.ones(len(km)), km[:, 0], km[:, 1]], axis=1)
        return U @ self.w + B @ self.c


def fit_tps(xy, ll, lam):
    n = len(xy)
    Pkm = np.asarray(xy, float) * SCALE_TO_KM
    d2 = ((Pkm[:, None, :] - Pkm[None, :, :]) ** 2).sum(-1)
    U = np.zeros_like(d2)
    m = d2 > 1e-12
    U[m] = d2[m] * np.log(d2[m])
    B = np.stack([np.ones(n), Pkm[:, 0], Pkm[:, 1]], axis=1)
    A = np.zeros((n + 3, n + 3))
    A[:n, :n] = U + lam * np.eye(n)
    A[:n, n:] = B
    A[n:, :n] = B.T
    rhs = np.zeros((n + 3, 2))
    rhs[:n] = ll
    sol = np.linalg.solve(A, rhs)
    return TpsModel(xy, lam, sol[:n], sol[n:])


def tps_apply_exported(cp, affine, xy):
    """按导出 JSON 的（已舍入）系数求值——与 src/editor.js tpsForward 同式。"""
    xy = np.atleast_2d(np.asarray(xy, float))
    km = xy * SCALE_TO_KM
    pkm = np.asarray(cp)[:, :2] * SCALE_TO_KM
    w = np.asarray(cp)[:, 2:4]
    d2 = ((km[:, None, :] - pkm[None, :, :]) ** 2).sum(-1)
    U = np.zeros_like(d2)
    m = d2 > 1e-12
    U[m] = d2[m] * np.log(d2[m])
    B = np.stack([np.ones(len(km)), km[:, 0], km[:, 1]], axis=1)
    return U @ w + B @ np.asarray(affine).T


def tps_inverse_exported(cp, affine, lonlat, iters=60, tol=1e-12):
    """TPS 反演（导出系数）：affine 种子 + 牛顿（解析雅可比）。单点 → [x,y] 或 None。"""
    a = np.asarray(affine).T               # (3,2)
    lon, lat = float(lonlat[0]), float(lonlat[1])
    det = a[1, 0] * a[2, 1] - a[2, 0] * a[1, 1]
    if abs(det) < 1e-15:
        return None
    u = ((lon - a[0, 0]) * a[2, 1] - (lat - a[0, 1]) * a[2, 0]) / det
    v = ((lat - a[0, 1]) * a[1, 0] - (lon - a[0, 0]) * a[1, 1]) / det
    w = np.asarray(cp)[:, 2:4]
    pkm = np.asarray(cp)[:, :2] * SCALE_TO_KM
    for _ in range(iters):
        d = np.array([u, v]) - pkm
        d2 = (d * d).sum(1)
        ok = d2 > 1e-12
        r2log = np.where(ok, d2 * np.log(np.where(ok, d2, 1.0)), 0.0)
        lp = np.where(ok, np.log(np.where(ok, d2, 1.0)) + 1.0, 0.0)
        f = np.array([w[:, 0] @ r2log + a[0, 0] + a[1, 0] * u + a[2, 0] * v,
                      w[:, 1] @ r2log + a[0, 1] + a[1, 1] * u + a[2, 1] * v])
        g = f - np.array([lon, lat])
        if math.hypot(*g) < tol:
            break
        J = np.empty((2, 2))
        for o in range(2):
            J[o, 0] = (w[:, o] * lp * 2 * d[:, 0]).sum() + a[1, o]
            J[o, 1] = (w[:, o] * lp * 2 * d[:, 1]).sum() + a[2, o]
        try:
            step = np.linalg.solve(J, g)
        except np.linalg.LinAlgError:
            return None
        u, v = u - step[0], v - step[1]
        if not (math.isfinite(u) and math.isfinite(v)):
            return None
    return np.array([u, v]) / SCALE_TO_KM


# ------------------------------------------------------------- 旧模型对照 --

def load_old_calib(path):
    js = json.loads(Path(path).read_text(encoding="utf-8"))
    if js.get("model") != "tps":
        return None, js
    cp = js["controlPoints"]
    affine = [js["affine"]["lon"], js["affine"]["lat"]]
    return (lambda xy: tps_apply_exported(cp, affine, xy)), js


# ------------------------------------------------------------------- 主流程 --

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=str(ROOT / "data" / "manual-control-points.csv"))
    ap.add_argument("--out", default=str(ROOT / "data" / "calibration.json"))
    ap.add_argument("--check", default=str(ROOT / "tools" / "fixtures" / "calib_check.json"))
    ap.add_argument("--backup-old", default=str(ROOT / "data" / "calibration-autotps-backup.json"))
    ap.add_argument("--model", default="auto", choices=["auto", "tps", "deg1", "deg2", "deg3"],
                    help="auto=按 LOO RMS 选优（仅在编辑器支持的 tps/deg3 中落地）")
    ap.add_argument("--lambda", dest="lam", type=float, default=None,
                    help="指定 TPS λ（默认网格搜索）")
    ap.add_argument("--dry", action="store_true", help="只评估，不写任何文件")
    args = ap.parse_args()

    rows = [r for r in csv.DictReader(open(args.csv, encoding="utf-8"))
            if r.get("lon") and r.get("lat")]
    skipped = [r["id"] for r in csv.DictReader(open(args.csv, encoding="utf-8"))
               if not (r.get("lon") and r.get("lat"))]
    xy = np.array([[float(r["x"]), float(r["y"])] for r in rows])
    ll = np.array([[float(r["lon"]), float(r["lat"])] for r in rows])
    ring = np.array([r["ring"] for r in rows])
    pid = [r["id"] for r in rows]
    lat0 = float(ll[:, 1].mean())
    print(f"控制点：{len(rows)} 个（未标 {len(skipped)}：{'/'.join(skipped) or '—'}）；"
          f"圈层 {'/'.join(f'{k} {(ring == k).sum()}' for k in RINGS)}")

    # ---- 候选：多项式 + TPS(λ 网格) ----
    cands = []
    for deg in (1, 2, 3):
        cands.append((f"deg{deg}", lambda xy_, ll_, d=deg: fit_poly(xy_, ll_, d)))
    if args.lam is not None:
        lams = [args.lam]
    else:
        lams = LAMBDAS
    for lam in lams:
        cands.append((f"tps λ={lam:g}", lambda xy_, ll_, L=lam: fit_tps(xy_, ll_, L)))

    def loo(fit_fn):
        r = np.empty(len(xy))
        for i in range(len(xy)):
            m = np.arange(len(xy)) != i
            r[i] = resid_m(fit_fn(xy[m], ll[m]).apply(xy[i:i + 1]), ll[i:i + 1], lat0)[0]
        return r

    print("\n== 候选模型（全集拟合残差 / LOO 残差，米）==")
    table = []
    for name, fn in cands:
        mdl = fn(xy, ll)
        full = resid_m(mdl.apply(xy), ll, lat0)
        r = loo(fn)
        table.append((name, stats(full), stats(r), r, mdl))
        print(f"  {name:<14} 全集 {stats(full)['rms']:7.1f} / max {stats(full)['max']:8.1f}"
              f"   LOO {stats(r)['rms']:7.1f} / max {stats(r)['max']:8.1f}")

    # ---- 旧模型对照（同 38 点） ----
    old_fwd, old_js = load_old_calib(args.out)
    if old_fwd is not None:
        r_old = resid_m(old_fwd(xy), ll, lat0)
        print(f"\n== 对照：现行自动 TPS（{old_js.get('meta', {}).get('trainingSet', {}).get('points', '?')} 点拟合）"
              f"  本集 rms {stats(r_old)['rms']:.1f} / max {stats(r_old)['max']:.1f}")

    # ---- 选型 ----
    ok_models = {"tps", "deg3"} if args.model == "auto" else {args.model}
    eligible = [t for t in table if t[0].split()[0] in ok_models]
    name, full_s, loo_s, r_loo, mdl = min(eligible, key=lambda t: t[2]["rms"])
    print(f"\n选中：{name}（LOO rms {loo_s['rms']:.1f} m）")
    if not name.startswith("tps") and args.model == "auto":
        print("（deg3 胜出时同样可直接落地编辑器 deg3 槽；本脚本导出分支已备）")

    # ---- 分圈层 + 逐点 LOO 残差（标注疑似失误点） ----
    print("\n== 分圈层 LOO RMS（米） ==")
    for k in RINGS:
        m = ring == k
        if m.any():
            print(f"  {k:<7} {(ring == k).sum():2d} 点  rms {np.sqrt((r_loo[m] ** 2).mean()):7.1f}")
    thr = 2.5 * loo_s["rms"]
    big = sorted(zip(pid, r_loo), key=lambda t: -t[1])
    print("\n== LOO 残差最大 8 点（>2.5×RMS 标记 ★，供人工复核） ==")
    for p, v in big[:8]:
        print(f"  {p:<4} {v:7.1f}{'  ★' if v > thr else ''}")

    if args.dry:
        print("\n--dry：不写文件。")
        return

    # ---- 导出 ----
    out_path = Path(args.out)
    if name.startswith("tps"):
        cp = [[round(float(px), 6), round(float(py), 6),
               float(f"{w[0]:.12g}"), float(f"{w[1]:.12g}")]
              for (px, py), w in zip(mdl.P, mdl.w)]
        affine = [[float(f"{v:.12g}") for v in col] for col in mdl.c.T]
        pred_round = tps_apply_exported(cp, affine, xy)
        r_round = resid_m(pred_round, ll, lat0)
        print(f"\n导出舍入后残差 rms {stats(r_round)['rms']:.1f}（舍入前 {full_s['rms']:.1f}；差应 <0.1 m）")
        calib_js = {
            "schema": "fmt/calibration@2",
            "model": "tps",
            "kernel": {"name": "r2logr2", "coord": "km", "scaleToKm": SCALE_TO_KM},
            "lambda": float(mdl.lam),
            "pdeg": PDEG,
            "affine": {"lon": affine[0], "lat": affine[1]},
            "controlPoints": cp,
            "meta": {
                "fitted": datetime.date.today().isoformat(),
                "method": "affine + regularized thin-plate spline, U(r2)=r2*ln(r2), km coords",
                "trainingSet": {
                    "points": int(len(xy)), "lines": len(set(r["line"] for r in rows)),
                    "source": "data/manual-control-points.csv（用户 Google Earth 手动标注，WGS84）",
                    "skippedIds": skipped,
                    "kml": "源资产/手动标定.kmz"},
                "residuals": {
                    "full": {"rms": round(full_s["rms"], 1), "max": round(full_s["max"], 1)},
                    "loo": {"rms": round(loo_s["rms"], 1), "max": round(loo_s["max"], 1)},
                    "byRing": {k: {"rms": round(float(np.sqrt((r_loo[ring == k] ** 2).mean())), 1)}
                               for k in RINGS if (ring == k).any()},
                    "rounded": {"rms": round(stats(r_round)["rms"], 1)}},
                "selection": "LOO RMS 最优（候选 deg1/deg2/deg3/TPS-λ 网格）：" + name,
                "note": "手动标定（2026-11-21 用户裁定 Plan B 转正）：38 控制点四圈层八方位，"
                        "Google Earth 按编号标注；02(浦东4号5号航站楼)/B3(浏河) 涉规划道路未标。"
                        "旧自动 TPS 备份 data/calibration-autotps-backup.json；"
                        "旧 deg3 备份 data/calibration-deg3-backup.json。"},
        }
        # 对拍真值：tps 节重写，deg3 节保留
        rng_pts = [(1000, 1000), (11000, 1000), (1000, 11000), (11000, 11000),
                   (6000, 6000), (6358.33, 6069.03), (3000, 9000), (9000, 3000),
                   (2000, 2000), (10000, 2000), (2000, 10000), (10000, 10000),
                   (5900, 3600), (6520, 5330), (7500, 7500), (4500, 6000)]
        fwd = [[x, y, *tps_apply_exported(cp, affine, [[x, y]])[0]] for x, y in rng_pts]
        inv, sk = [], []
        for lon, lat in [(121.10, 31.05), (121.90, 31.40), (121.45, 31.42),
                         (121.55, 30.80), (121.20, 31.70), (121.80, 31.10)]:
            p = tps_inverse_exported(cp, affine, [lon, lat])
            if p is None:
                sk.append((lon, lat, "no-converge")); continue
            q = tps_apply_exported(cp, affine, [p])[0]
            rt = math.hypot((q[0] - lon) * m_per_deg(lat0), (q[1] - lat) * M_PER_DEG_LAT)
            if rt > 0.01:
                sk.append((lon, lat, f"roundtrip {rt * 100:.2f}cm")); continue
            inv.append([lon, lat, float(p[0]), float(p[1])])
        for lon, lat, why in sk:
            print(f"警告：tps 反演点 ({lon},{lat}) {why}，不进对拍真值")
        old_chk = json.loads(Path(args.check).read_text(encoding="utf-8")) \
            if Path(args.check).exists() else {}
        check_js = {"_doc": "新旧标定 forward/inverse 对拍真值（tps 节由 tools/calib_manual_fit.py 生成；"
                            "deg3 节由 calib2_fit.py 生成保留）；node tools/test_calib.js 消费",
                    "tps": {"forward": fwd, "inverse": inv},
                    "deg3": old_chk.get("deg3", {"forward": [], "inverse": []})}
    else:
        sys.exit(f"选中 {name}：多项式导出分支暂未实装（预期 TPS 胜出；--model tps 可强制）")

    if out_path.exists():
        shutil.copyfile(out_path, args.backup_old)
        print(f"backup: {args.out} -> {args.backup_old}")
    out_path.write_text(json.dumps(calib_js, ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
    Path(args.check).write_text(json.dumps(check_js, ensure_ascii=False, indent=1),
                                encoding="utf-8")
    sz = out_path.stat().st_size
    print(f"written: {args.out}（{len(calib_js['controlPoints'])} 控制点，{sz / 1024:.0f} KB）")
    print(f"written: {args.check}")


if __name__ == "__main__":
    main()
