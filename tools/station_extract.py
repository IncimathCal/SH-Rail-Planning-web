#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""站圆预置提取：远期.ai 原生 Station 层站圆 → 投影到 import 线路 path → import/站圆预置-草稿.json。

数据纪律（见《架构方案-01》§0 与《讨论记录-04》）：
  - 站点可自动匹配（用户已批准），但产物只是「预置草稿」：t 供编辑器批量落站、人工筛；
  - 站名只能以 nameSuggestion「建议」形式附带（源图 Name 层就近文字），绝不自动写入正式站名；
  - 与 import JSON 的关联一律走几何签名（首点+bbox+弧长+cmyk），不依赖 path-NN 字符串，
    W1 重导（真名 sourceLayer / 补 Z / 去重）后本脚本可直接重跑，无需改动。

绑定规则（纯几何，运行时推导，不落任何绑定文件）：
  1. 每圆求全局最近 path（d < 25pt 计入 hits）；owner(P) = 按「组内圆命中比例」最高的站圆组；
  2. primary(G) = G 命中数最多且 owner 为 G 的 path，要求 hits ≥ max(2, ⌈|G|/2⌉)，否则整组不绑定；
  3. family(G) = {primary} ∪ {P : 与 primary 同 cmyk、owner 为 G、组内有圆距 P < 25pt}
     ——支线族（示范区线/11/10/松江快线等）靠同色扩展，跨线污染靠 owner 约束排除；
  4. 家族内几何孪生（同 cmyk、bbox/弧长几乎相同，如源图重复描边）只保留命中多的一条；
  5. 组内每圆投影到家族中最近 path 得 t（d ≥ 25pt 记 outlier 供人工查看，不落站）。

用法（Windows，无第三方依赖；站名建议需 PyMuPDF，可省略）：
  python -X utf8 tools/station_extract.py \
      --layers 零散/ai_layer_paths.json \
      --import import/远期图-全量.json \
      --out import/站圆预置-草稿.json \
      [--ai 源资产/远期.ai]
"""

import argparse
import collections
import datetime
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from svg_parse import path_from_d  # noqa: E402

BIND_D = 25.0        # 圆心到 path 的绑定/outlier 距离阈值（pt）
NAME_D = 25.0        # 圆心到文本 bbox 的建议距离阈值（pt）；实证中位 13.7、93% < 25
CIRCLE_MIN = 14.0    # 站圆边长下限（pt；每线站圆 18×18，换乘大圆 24×24）
CIRCLE_MAX = 30.0
TWIN_BBOX = 1.0      # 孪生 path 判定容差（pt）
TWIN_LEN = 0.01      # 孪生弧长相对差
PREFILTER = BIND_D + 5.0   # bbox 预筛余量


# ---------- 原生 Station 层 ----------

def load_station_groups(layers_file):
    """ai_layer_paths.json → {组名: [圆 dict]}。圆 = 方形填充路径，圆心转 SVG 基准（y 翻转，无平移）。"""
    tree = json.loads(Path(layers_file).read_text(encoding="utf-8"))
    roots = {n["name"]: n for n in tree}
    if "Station" not in roots:
        raise SystemExit("ai_layer_paths.json 中找不到 Station 根层")
    groups = {}
    skipped = collections.Counter()
    for ch in roots["Station"]["children"]:
        if ch["name"] in ("Trans", "Line"):   # Trans=换乘符号（不按线分组）、Line=描边
            skipped[ch["name"]] += len(ch["paths"])
            continue
        for p in ch["paths"]:
            w, h = p["x1"] - p["x0"], p["y1"] - p["y0"]
            if p.get("paint") != "b":          # 只要填充圆（描边是线不是站）
                skipped[ch["name"] + ":stroke"] += 1
                continue
            if abs(w - h) > 1.0 or not (CIRCLE_MIN <= w <= CIRCLE_MAX):
                skipped[ch["name"] + ":shape"] += 1
                continue
            groups.setdefault(ch["name"], []).append({
                "x": round((p["x0"] + p["x1"]) / 2.0, 2),
                "y": round(-(p["y0"] + p["y1"]) / 2.0, 2),   # 原生 y-up → SVG y-down
                "r": round(w / 2.0, 2),
            })
    if skipped:
        print("跳过的非站圆路径：%s" % dict(skipped))
    return groups


def dedup_circles(groups):
    """组内同圆心（±0.25pt）同半径重复圆去重（源图重复绘制防护）。返回 {组: (圆列表, 去重数)}。"""
    out = {}
    for name, circles in groups.items():
        kept, removed = [], 0
        for c in circles:
            if any(abs(c["x"] - k["x"]) <= 0.25 and abs(c["y"] - k["y"]) <= 0.25
                   and abs(c["r"] - k["r"]) <= 0.25 for k in kept):
                removed += 1
            else:
                kept.append(c)
        out[name] = (kept, removed)
    return out


# ---------- import path ----------

def load_import_paths(import_file):
    """import JSON → [path dict]（ArcPath 折线/弧长表 + 几何签名要素）。"""
    data = json.loads(Path(import_file).read_text(encoding="utf-8"))
    paths = []
    for p in data.get("paths", []):
        ap = path_from_d(p["path"])
        xs = [q[0] for q in ap.pts]
        ys = [q[1] for q in ap.pts]
        paths.append({
            "sourceLayer": p.get("sourceLayer", ""),
            "cmyk": [round(c, 3) for c in p.get("cmyk", [])],
            "dash": bool(p.get("dash")),
            "pts": ap.pts, "cum": ap.cum, "length": ap.length,
            "bbox": [min(xs), min(ys), max(xs), max(ys)],
            "first": [round(ap.pts[0][0], 2), round(ap.pts[0][1], 2)],
            "sigLength": round(ap.length, 1),
        })
    return data.get("source", Path(import_file).name), paths


def seg_project(px, py, P):
    """点到折线的精确最近投影 → (距离 d, 弧长参数 t∈[0,1])。"""
    pts, cum, total = P["pts"], P["cum"], P["length"]
    best_d2, best_t = math.inf, 0.0
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        if l2 < 1e-18:
            f = 0.0
        else:
            f = ((px - ax) * dx + (py - ay) * dy) / l2
            f = 0.0 if f < 0.0 else (1.0 if f > 1.0 else f)
        d2 = (px - ax - f * dx) ** 2 + (py - ay - f * dy) ** 2
        if d2 < best_d2:
            best_d2 = d2
            seg = cum[i + 1] - cum[i]
            best_t = (cum[i] + f * seg) / total
    return math.sqrt(best_d2), best_t


def near_paths(px, py, paths):
    """候选 path（bbox 预筛）→ [(P, d, t)]，按距离升序。"""
    out = []
    for P in paths:
        bb = P["bbox"]
        if not (bb[0] - PREFILTER <= px <= bb[2] + PREFILTER
                and bb[1] - PREFILTER <= py <= bb[3] + PREFILTER):
            continue
        d, t = seg_project(px, py, P)
        out.append((P, d, t))
    out.sort(key=lambda q: q[1])
    return out


# ---------- 绑定 ----------

def bind_groups(groups, paths):
    """执行绑定规则（见模块 docstring）。

    返回 (bound, unbound)：
      bound   [ {stationGroup, family:[P...], stops:{sourceLayer:[stop...]}, outliers:[...]} ]
              stop = {"circle":圆dict, "d":距离, "t":弧长参数}
      unbound [ {stationGroup, circles:n, nearestDetail:[{x,y,nearest,distance}]} ]
    """
    by_layer = {P["sourceLayer"]: P for P in paths}
    nearest = {}      # 组 -> [(P, d)] 每圆全局最近
    within = {}       # 组 -> Counter{sourceLayer: 25pt 内圆数}
    hits = {}         # 组 -> Counter{sourceLayer: 最近且 <25pt 圆数}
    for gname, circles in groups.items():
        nearest[gname] = []
        within[gname], hits[gname] = collections.Counter(), collections.Counter()
        for c in circles:
            cands = near_paths(c["x"], c["y"], paths)
            nearest[gname].append(cands[0][:2] if cands else (None, math.inf))
            for P, d, _t in cands:
                if d < BIND_D:
                    within[gname][P["sourceLayer"]] += 1
            if cands and cands[0][1] < BIND_D:
                hits[gname][cands[0][0]["sourceLayer"]] += 1

    # owner(P)：按组内命中比例（within / 组圆数）最高者——比例优先防大组仗量欺小组
    claims = collections.defaultdict(list)
    for gname, circles in groups.items():
        n = len(circles)
        for sl, cnt in within[gname].items():
            claims[sl].append((cnt / n, cnt, gname))
    owner = {}
    for sl, lst in claims.items():
        lst.sort(key=lambda q: (-q[0], -q[1], q[2]))
        owner[sl] = lst[0][2]

    bound, unbound = [], []
    for gname, circles in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        n = len(circles)
        if n == 0:
            continue
        primary, primary_hits = None, 0
        for sl, cnt in sorted(hits[gname].items(), key=lambda kv: (-kv[1], kv[0])):
            if owner.get(sl) == gname:
                primary, primary_hits = by_layer[sl], cnt
                break
        if primary is None or primary_hits < max(2, math.ceil(n * 0.5)):
            unbound.append({
                "stationGroup": gname,
                "circles": n,
                "nearestDetail": [
                    {"x": c["x"], "y": c["y"],
                     "nearest": nearest[gname][i][0]["sourceLayer"] if nearest[gname][i][0] else None,
                     "distance": round(nearest[gname][i][1], 1)}
                    for i, c in enumerate(circles)
                ],
            })
            continue
        # family：同色 + owner 本组 + 组内有圆 <25pt
        family = {primary["sourceLayer"]: primary}
        for sl in within[gname]:
            if sl in family or owner.get(sl) != gname:
                continue
            P = by_layer[sl]
            if P["cmyk"] == primary["cmyk"]:
                family[sl] = P
        # 孪生折叠：同色 + bbox/弧长几乎相同 → 只留一条（primary 排最前，先占位）
        kept = []
        for sl in sorted(family, key=lambda s: (s != primary["sourceLayer"], s)):
            P = family[sl]
            is_twin = any(Q["cmyk"] == P["cmyk"]
                          and all(abs(a - b) <= TWIN_BBOX for a, b in zip(Q["bbox"], P["bbox"]))
                          and abs(Q["length"] - P["length"]) <= TWIN_LEN * max(Q["length"], P["length"])
                          for Q in kept)
            if not is_twin:
                kept.append(P)
        # 落站：每圆 → 家族内最近 path
        stops = collections.defaultdict(list)
        outliers = []
        for c in circles:
            best = None
            for P in kept:
                bb = P["bbox"]
                if not (bb[0] - PREFILTER <= c["x"] <= bb[2] + PREFILTER
                        and bb[1] - PREFILTER <= c["y"] <= bb[3] + PREFILTER):
                    continue
                d, t = seg_project(c["x"], c["y"], P)
                if best is None or d < best[1]:
                    best = (P, d, t)
            if best is not None and best[1] < BIND_D:
                stops[best[0]["sourceLayer"]].append({"circle": c, "d": best[1], "t": best[2]})
            else:
                outliers.append({"x": c["x"], "y": c["y"], "r": c["r"],
                                 "nearest": best[0]["sourceLayer"] if best else None,
                                 "distance": round(best[1], 1) if best else None})
        bound.append({"stationGroup": gname, "family": kept,
                      "stops": dict(stops), "outliers": outliers})
    return bound, unbound


def signature(P):
    """几何签名（供编辑器在 W1 重导后按签名重新绑定，不依赖 path-NN）。"""
    return {
        "first": P["first"],
        "bbox": [round(v, 1) for v in P["bbox"]],
        "length": P["sigLength"],
        "cmyk": P["cmyk"],
        "dash": P["dash"],
    }


# ---------- 站名建议（源图 PDF 侧文本，仅建议） ----------

def load_texts(ai_file):
    """PyMuPDF 取整行文本（页面 12000×12000，PyMuPDF 坐标即 SVG 基准：y 向下）。
    去重（源图每字画两遍）；返回 [(x0,y0,x1,y1,text)]。"""
    import fitz  # 延迟导入：无 fitz 时仍可跑无建议版
    doc = fitz.open(ai_file)
    page = doc[0]
    lines = {}
    for x0, y0, x1, y1, w, b, l, _n in page.get_text("words"):
        r = lines.setdefault((b, l), [x0, y0, x1, y1, []])
        r[0] = min(r[0], x0); r[1] = min(r[1], y0)
        r[2] = max(r[2], x1); r[3] = max(r[3], y1)
        r[4].append(w)
    out, seen = [], set()
    for r in lines.values():
        text = "".join(r[4]).strip()
        if not text:
            continue
        key = (round(r[0], 1), round(r[1], 1), text)
        if key in seen:
            continue
        seen.add(key)
        out.append((r[0], r[1], r[2], r[3], text))
    return out


def bbox_dist(px, py, t):
    dx = max(t[0] - px, 0.0, px - t[2])
    dy = max(t[1] - py, 0.0, py - t[3])
    return math.hypot(dx, dy)


def attach_name_suggestions(bound, texts):
    """文本按「最近圆」归属（近似组内匹配：原生 Name 层为空、PDF 侧无分组信息）；
    每个已落站圆取其归属文本中最近且 < NAME_D 的一个作 nameSuggestion（原地写入 stop dict）。"""
    if not texts:
        return
    flat = []    # 全部已落站 stop（{"circle":..., "d":..., "t":...}）
    for b in bound:
        for sl in b["stops"]:
            flat.extend(b["stops"][sl])
    text_owner = []
    for t in texts:
        best_i, best_d = None, math.inf
        for i, s in enumerate(flat):
            d = bbox_dist(s["circle"]["x"], s["circle"]["y"], t)
            if d < best_d:
                best_i, best_d = i, d
        text_owner.append(best_i)
    for i, s in enumerate(flat):
        best, best_d = None, math.inf
        for ti, t in enumerate(texts):
            if text_owner[ti] != i:      # 只用归属本圆的文本（近似组内匹配）
                continue
            d = bbox_dist(s["circle"]["x"], s["circle"]["y"], t)
            if d < best_d:
                best, best_d = t, d
        if best is not None and best_d < NAME_D:
            s["nameSuggestion"] = best[4]
            s["suggestDist"] = round(best_d, 1)


# ---------- 主流程 ----------

def main():
    ap = argparse.ArgumentParser(description="远期.ai Station 层站圆 → import/站圆预置-草稿.json")
    ap.add_argument("--layers", required=True, help="零散/ai_layer_paths.json（ai_native_tree3.py 产物）")
    ap.add_argument("--import", dest="import_file", required=True, help="import/*.json（fmt/import@1）")
    ap.add_argument("--out", required=True, help="输出 JSON（建议 import/站圆预置-草稿.json）")
    ap.add_argument("--ai", default=None, help="源资产/远期.ai；提供则附带站名建议（需 PyMuPDF）")
    args = ap.parse_args()

    raw_groups = load_station_groups(args.layers)
    groups = dedup_circles(raw_groups)
    total_raw = sum(len(v) for v in raw_groups.values())
    total_dedup = sum(r for (_k, (v, r)) in groups.items())
    import_source, paths = load_import_paths(args.import_file)
    print(f"Station 子层 {len(groups)} 组；圆 {total_raw} 个（去重移除 {total_dedup}）；"
          f"import path {len(paths)} 条（{import_source}）")

    plain = {k: v for k, (v, _r) in groups.items()}
    bound, unbound = bind_groups(plain, paths)

    texts = []
    if args.ai:
        try:
            texts = load_texts(args.ai)
            print(f"PDF 侧文本 {len(texts)} 条（去重后）")
        except ImportError:
            print("警告：未安装 PyMuPDF（fitz），跳过站名建议。")
    attach_name_suggestions(bound, texts)

    items = []
    for b in bound:
        for P in b["family"]:
            sts = b["stops"].get(P["sourceLayer"], [])
            if not sts:
                continue
            sts.sort(key=lambda s: s["t"])
            stops_out = []
            for s in sts:
                t = round(s["t"], 6)   # t ∈ [0,1] 双闭（2026-11-21 裁定；环线 t=1 与 t=0 物理同点，不另拦截）
                entry = {"t": t, "x": s["circle"]["x"], "y": s["circle"]["y"],
                         "r": s["circle"]["r"], "d": round(s["d"], 1)}
                if "nameSuggestion" in s:
                    entry["nameSuggestion"] = s["nameSuggestion"]
                    entry["suggestDist"] = s["suggestDist"]
                stops_out.append(entry)
            items.append({
                "stationGroup": b["stationGroup"],
                "sourceLayer": P["sourceLayer"],
                "signature": signature(P),
                "circleCount": len(sts),
                "stops": stops_out,
            })
    items.sort(key=lambda it: (it["stationGroup"], it["sourceLayer"]))
    stop_total = sum(len(it["stops"]) for it in items)
    suggested = sum(1 for it in items for s in it["stops"] if "nameSuggestion" in s)
    group_outliers = {b["stationGroup"]: b["outliers"] for b in bound if b["outliers"]}

    out = {
        "schema": "fmt/stations-import@1",
        "source": f"远期.ai Station 层（{Path(args.layers).name}）+ {import_source}",
        "generated": datetime.date.today().isoformat(),
        "note": "预置草稿：t 为站圆圆心到线路 path 的弧长投影（6 位小数）；"
                "nameSuggestion 为源图就近文字，仅供参考、点选采用，绝不自动写入正式站名；"
                "signature 为线路 path 几何签名（首点/bbox/弧长/cmyk），编辑器据此绑定，不依赖 path-NN；"
                "unbound 各组与 groupOutliers 各圆仅供人工核对。",
        "thresholds": {"bindDistancePt": BIND_D, "nameDistancePt": NAME_D},
        "stats": {
            "groups": len(groups),
            "groupsBound": len(bound),
            "groupsUnbound": len(unbound),
            "circles": total_raw,
            "circlesDeduped": total_dedup,
            "items": len(items),
            "stops": stop_total,
            "outliers": sum(len(v) for v in group_outliers.values()),
            "unboundCircles": sum(u["circles"] for u in unbound),
            "namesSuggested": suggested,
            "namesCoverage": round(suggested / stop_total, 4) if stop_total else 0,
        },
        "unbound": [
            {"stationGroup": u["stationGroup"], "circles": u["circles"],
             "reason": "圆心距所有 path 过远或无主导归属（多为隐藏层线路）——仅供人工核对",
             "circlesDetail": u["nearestDetail"]}
            for u in unbound
        ],
        "groupOutliers": group_outliers,
        "items": items,
    }

    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
        f.write("\n")

    # ---- 控制台报告 ----
    print(f"\n绑定 {len(bound)} 组 / 未绑定 {len(unbound)} 组；落站 {len(items)} 条 path 共 {stop_total} 站；"
          f"outlier {out['stats']['outliers']} 圆、未绑定组圆 {out['stats']['unboundCircles']} 个"
          + (f"；站名建议 {suggested}/{stop_total}（{out['stats']['namesCoverage']*100:.1f}%）" if texts else ""))
    print("\n=== 未绑定组（圆仅供人工核对） ===")
    for u in unbound:
        det = "  ".join(f"({d['x']:.0f},{d['y']:.0f})→{d['nearest']}:{d['distance']}"
                        for d in u["nearestDetail"][:3])
        print(f"  {u['stationGroup']:<10} {u['circles']} 圆  {det}")
    print("\n=== 绑定明细（组 → path：站数） ===")
    for it in items:
        print(f"  {it['stationGroup']:<10} → {it['sourceLayer']:<8} {len(it['stops'])} 站"
              f"（outlier {len(group_outliers.get(it['stationGroup'], []))}）")
    if texts:
        print("\n=== 站名建议样表（有建议的前 4 条 path，每条前 6 站） ===")
        shown = 0
        for it in items:
            if shown >= 4:
                break
            if not any("nameSuggestion" in s for s in it["stops"]):
                continue
            print(f"  [{it['stationGroup']} → {it['sourceLayer']}]")
            for s in it["stops"][:6]:
                print(f"    t={s['t']:.6f}  ({s['x']:.1f},{s['y']:.1f})  建议={s.get('nameSuggestion', '—')}"
                      f"  文距={s.get('suggestDist', '—')}")
            shown += 1
    print(f"\n已写 {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
