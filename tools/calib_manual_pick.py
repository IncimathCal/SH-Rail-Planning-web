#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""手动标定选点（Plan B）：从 AI 源图导出的线路 path 与站圆预置中，按圈层/方位规则自动挑出
约 30 个控制点候选，供用户去 Google Earth 人工标注真实经纬度后重拟合标定。

数据纪律：
  - 只读 import/远期图-全量.json（线路 path）与 import/站圆预置-草稿.json（站圆预置）；
    零散/ai_layer_paths.json（可选）仅取 Station/Trans 层换乘符号的位置作「换乘」旁证；
  - 不引用任何外部地铁数据；站名只用 nameSuggestion 原样并标注「建议」，线名用 sourceLayer；
  - 不写 import/、data/calibration*.json、src/、editor.html。

选点规则（参数见「参数」一节，均可由命令行覆盖）：
  1. 地图中心 = 全部站圆（已绑定落站 + 未绑定组圆）质心；按到中心距离的分位
     （默认 p50 / p75 / p90）划 4 圈：最外围 outer / 次外围 subouter / 中圈 middle / 内圈 inner；
  2. 圈层配额默认 14 / 8 / 5 / 3（随 --n 按最大余数法等比伸缩）；
  3. 八方位（N/NE/E/SE/S/SW/W/NW）都要有；西、西南各加密 +2（用户指出 9 号线最西端以西/西南最弱）；
  4. 品质分：有建议名 +3；换乘 +3.5（不同线组圆心 <25pt 重合，或源图 Trans 层换乘符号 <25pt）；
     线路尽端最外站 +1.5 ~ +2.5（path 端点即站圆最高）；建议名疑为线路名标签 -4；
  5. 第二阶段补配额时给「同线另一尽端」加分 +0.8（每条外围线尽量取两端），
     同线已有入选站 -1、同圈层同方位已有入选站 -1.2（让每圈在各方位铺开）；
  6. 入选点之间保持最小间距（按圈 300 / 250 / 200 / 120pt），避免扎堆；
  7. 备选点先补「未覆盖的线路尽端」，再按品质分补齐。
  编号：主选 01~NN 按「外圈→内圈、自北顺时针」排；备选 B1~Bk 同序。

用法（Windows；纯标准库；重复运行输出幂等）：
  python -X utf8 tools/calib_manual_pick.py                 # 30 主选 + 10 备选
  python -X utf8 tools/calib_manual_pick.py --n 40 --backup 12
  python -X utf8 tools/calib_manual_pick.py --no-trans      # 不用 Trans 层换乘符号
产物：
  零散/手动标定-候选点.html         叠加核对图（自包含单文件；零散/ 不入库）
  data/manual-control-points.csv   回填模板（lon/lat 留空；已人工回填的值重跑时保留）
  零散/手动标定-候选点清单.md      编号表、统计、未入选说明、使用步骤（零散/ 不入库）
"""

import argparse
import csv
import hashlib
import io
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ---------- 参数 ----------

DEF_LINES = ROOT / "import" / "远期图-全量.json"
DEF_STATIONS = ROOT / "import" / "站圆预置-草稿.json"
DEF_LAYERS = ROOT / "零散" / "ai_layer_paths.json"
DEF_HTML = ROOT / "零散" / "手动标定-候选点.html"
DEF_CSV = ROOT / "data" / "manual-control-points.csv"
DEF_MD = ROOT / "零散" / "手动标定-候选点清单.md"

RING_NAMES = ["outer", "subouter", "middle", "inner"]      # 结构字段英文
RING_CN = ["最外围", "次外围", "中圈", "内圈"]
RING_W = [14, 8, 5, 3]            # 圈层配额权重（n=30 时恰为 14/8/5/3）
CUTS = [0.50, 0.75, 0.90]         # 分位切点：>p90 最外围，p75~p90 次外围，p50~p75 中圈，其余内圈
BEARINGS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
BEARING_CN = {"N": "北", "NE": "东北", "E": "东", "SE": "东南", "S": "南",
              "SW": "西南", "W": "西", "NW": "西北"}
DENSE_EXTRA = {"W": 2, "SW": 2}   # 方位加密（n=30 时的额外点数，随 n 等比取整）
MIN_SEP = [300.0, 250.0, 200.0, 120.0]   # 各圈入选点最小间距（pt）
BACKUP_SEP_FACTOR = 0.6          # 备选点最小间距 = 主选间距 × 该系数

COINCIDE_D = 25.0     # 不同线组圆心重合（换乘）阈值 pt
JOIN_D = 25.0         # path 端点落在他线 path 上（线端止于线间交汇处）的判定阈值 pt
END_TOL = 60.0        # 「path 端点即站圆」容差 pt（实证：端点站 ≤52，其后直接跳到 ≥86）
NEAR_TOL = 450.0      # 「线端超出站圆」上限 pt（实证：≤426 与 ≥525 之间有空档）
TRANS_D = 25.0        # 站圆距源图 Trans 层换乘符号的阈值 pt
TRANS_MIN_SIZE = 20.0  # Trans 层符号最小边长（滤掉退化描边）

W_NAME = 3.0          # 有可用建议名
W_LABEL = -4.0        # 建议名疑为线路名标签
W_XFER = 3.5          # 换乘（高于「尽端站 + 同线另一尽端」，落实换乘优先）
END_BONUS = {2.0: 2.5, 1.5: 2.0, 1.0: 1.5, 0.6: 1.5, 0.3: 1.5, 0.0: 0.0}   # 线路尽端最外站
RING_WEIGHT = [0.0, -1.0, -2.0, -3.0]   # 方位覆盖阶段：越外圈越优先
W_PAIR = 0.8          # 同线另一尽端已入选（每条外围线尽量取两端）
PAIR_MIN_DIST = 1500.0   # 两端相距不足此值不给配对加分（短线两端信息重复）
W_SAME_LINE = -1.0    # 同站圆组已有入选站且非配对另一端
W_SAME_CELL = -1.2    # 同圈层同方位已有入选站（让每圈在各方位铺开）

END_TEXT = {
    2.0: "尽端站（path 端点即站圆）",
    1.5: "尽端站（path 端点超出站圆 {gap:.0f}pt）",
    1.0: "近尽端站（path 端点止于线间交汇处、超出站圆 {gap:.0f}pt，端点处无本线站圆）",
    0.6: "该端最外站（path 端点远超站圆 {gap:.0f}pt）",
    0.3: "该端最外站（path 端点止于线间交汇处、远超站圆 {gap:.0f}pt）",
}
END_SHORT = {2.0: "尽端站", 1.5: "尽端站", 1.0: "近尽端站", 0.6: "端部最外站", 0.3: "端部最外站", 0.0: ""}

# 未绑定站圆组的已知原因（人工备注，来源《讨论记录-04》W1 定论；脚本无法从输入自行推出；组名不在输入中即不生效）
UNBOUND_NOTES = {
    "临港1": "源图隐藏层，线体与站圆均不进图",
    "8B浦江线": "源图隐藏对象，线体与站圆均不进图",
}

_LABEL_RE = re.compile(r"^(\d+(?:\.\d+)?号线?|.{1,12}线|.{1,12}通道)$")
_TOKEN = re.compile(r"([A-Za-z])|(-?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)")
_ARGN = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "Z": 0}


# ---------- 几何 ----------

def _bezier(pts, p0, p1, p2, p3, sub):
    for k in range(1, sub + 1):
        u = k / sub
        v = 1.0 - u
        pts.append((v * v * v * p0[0] + 3 * v * v * u * p1[0] + 3 * v * u * u * p2[0] + u * u * u * p3[0],
                    v * v * v * p0[1] + 3 * v * v * u * p1[1] + 3 * v * u * u * p2[1] + u * u * u * p3[1]))


def flatten_path(d, sub=8):
    """SVG path → 折线 [(x, y)]。支持 M L H V C S Q T Z（含相对命令）；曲线每段定分 sub 段。"""
    pts = []
    cur = start = (0.0, 0.0)
    c2 = q = None                       # 上一段第二控制点 / 二次控制点（S、T 反射用）

    def run(cmd, a):
        nonlocal cur, start, c2, q
        rel = cmd.islower()
        c = cmd.upper()
        if c == "Z":
            if cur != start:
                pts.append(start)
            cur, c2, q = start, None, None
            return
        n = _ARGN[c]
        i = 0
        while i + n <= len(a):
            v = a[i:i + n]
            i += n
            if c == "M":
                cur = (cur[0] + v[0], cur[1] + v[1]) if rel else (v[0], v[1])
                pts.append(cur)
                start = cur
                c, n = "L", 2           # 其后的坐标对按隐式 L 处理
            elif c in ("L", "H", "V"):
                if c == "L":
                    cur = (cur[0] + v[0], cur[1] + v[1]) if rel else (v[0], v[1])
                elif c == "H":
                    cur = (cur[0] + v[0], cur[1]) if rel else (v[0], cur[1])
                else:
                    cur = (cur[0], cur[1] + v[0]) if rel else (cur[0], v[0])
                pts.append(cur)
                c2 = q = None
            elif c in ("C", "S"):
                if c == "C":
                    x1, y1, x2, y2, x, y = v
                else:
                    x2, y2, x, y = v
                    x1, y1 = (2 * cur[0] - c2[0], 2 * cur[1] - c2[1]) if c2 else cur
                if rel:
                    x2, y2, x, y = x2 + cur[0], y2 + cur[1], x + cur[0], y + cur[1]
                    if cmd == "C":
                        x1, y1 = x1 + cur[0], y1 + cur[1]
                _bezier(pts, cur, (x1, y1), (x2, y2), (x, y), sub)
                cur, c2, q = (x, y), (x2, y2), None
            else:                       # Q / T：二次升三次
                if c == "Q":
                    x1, y1, x, y = v
                    if rel:
                        x1, y1, x, y = x1 + cur[0], y1 + cur[1], x + cur[0], y + cur[1]
                else:
                    x, y = (cur[0] + v[0], cur[1] + v[1]) if rel else (v[0], v[1])
                    x1, y1 = (2 * cur[0] - q[0], 2 * cur[1] - q[1]) if q else cur
                _bezier(pts, cur, (cur[0] + 2 / 3 * (x1 - cur[0]), cur[1] + 2 / 3 * (x1 - cur[1])),
                        (x + 2 / 3 * (x1 - x), y + 2 / 3 * (x1 - y)), (x, y), sub)
                cur, q, c2 = (x, y), (x1, y1), None

    cmd, args = None, []
    for m in _TOKEN.finditer(d):
        if m.group(1):
            if cmd:
                run(cmd, args)
            cmd, args = m.group(1), []
        else:
            args.append(float(m.group(2)))
    if cmd:
        run(cmd, args)
    return pts


def project(px, py, P):
    """点到折线的最近投影 → (距离, 弧长)。"""
    pts, cum = P["pts"], P["cum"]
    best_d2, best_s = float("inf"), 0.0
    for i in range(len(pts) - 1):
        ax, ay = pts[i]
        bx, by = pts[i + 1]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        f = 0.0 if l2 < 1e-18 else ((px - ax) * dx + (py - ay) * dy) / l2
        f = 0.0 if f < 0.0 else (1.0 if f > 1.0 else f)
        d2 = (px - ax - f * dx) ** 2 + (py - ay - f * dy) ** 2
        if d2 < best_d2:
            best_d2, best_s = d2, cum[i] + f * math.sqrt(l2)
    return math.sqrt(best_d2), best_s


def near_path(px, py, P, tol):
    """点落在折线 tol 范围内 → 返回弧长，否则 None。"""
    x0, y0, x1, y1 = P["bbox"]
    if not (x0 - tol <= px <= x1 + tol and y0 - tol <= py <= y1 + tol):
        return None
    d, s = project(px, py, P)
    return s if d < tol else None


def bearing_of(cx, cy, x, y):
    """方位：自北顺时针的象限角 θ（度）与八方位扇区（页面 y 向下）。"""
    th = math.degrees(math.atan2(x - cx, -(y - cy))) % 360.0
    return BEARINGS[int(((th + 22.5) % 360.0) // 45.0)], th


def quantile(sorted_vals, f):
    if not sorted_vals:
        return 0.0
    pos = f * (len(sorted_vals) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


# ---------- 读入 ----------

def sha256_of(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:12]


def load_lines(path):
    """import JSON → {sourceLayer: path dict}（折线、弧长表、bbox、hintNames）。"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    lines = {}
    for p in data.get("paths", []):
        sl = p["sourceLayer"]
        if sl in lines:
            raise SystemExit("sourceLayer 重复：%s" % sl)
        pts = flatten_path(p["path"])
        if len(pts) < 2:
            raise SystemExit("path 几何退化：%s" % sl)
        cum = [0.0]
        for i in range(1, len(pts)):
            cum.append(cum[-1] + math.dist(pts[i - 1], pts[i]))
        xs = [q[0] for q in pts]
        ys = [q[1] for q in pts]
        lines[sl] = {
            "d": p["path"], "pts": pts, "cum": cum, "len": cum[-1],
            "closed": bool(re.search(r"[Zz]", p["path"])),
            "dash": p.get("dash"),            # 源图虚线线型（叠加图同款虚线）
            "bbox": (min(xs), min(ys), max(xs), max(ys)),
            "category": p.get("category"),
            "hints": [h for h in (p.get("hintNames") or []) if h],
        }
    return data, lines


def load_stations(path):
    """站圆预置 → (data, 落站列表, 未绑定组圆列表)。只取 x/y/t/nameSuggestion/stationGroup。"""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    stops, unbound = [], []
    for it in data.get("items", []):
        for s in it["stops"]:
            stops.append({"line": it["sourceLayer"], "group": it["stationGroup"], "t": float(s["t"]),
                          "x": float(s["x"]), "y": float(s["y"]), "name": s.get("nameSuggestion") or None})
    for u in data.get("unbound", []):
        for c in u.get("circlesDetail", []):
            unbound.append({"group": u["stationGroup"], "x": float(c["x"]), "y": float(c["y"])})
    return data, stops, unbound


def load_trans_centers(path):
    """零散/ai_layer_paths.json → Station/Trans 层填充符号中心 [(x, y)]（原生 y-up 取负，与页面基准一致）。"""
    tree = json.loads(Path(path).read_text(encoding="utf-8"))
    for node in tree:
        if node.get("name") != "Station":
            continue
        for ch in node.get("children", []):
            if ch.get("name") != "Trans":
                continue
            out = []
            for p in ch.get("paths", []):
                w, h = p["x1"] - p["x0"], p["y1"] - p["y0"]
                if p.get("paint") == "b" and w >= TRANS_MIN_SIZE and h >= TRANS_MIN_SIZE:
                    out.append(((p["x0"] + p["x1"]) / 2.0, -(p["y0"] + p["y1"]) / 2.0))
            return out
    return None


# ---------- 候选点属性 ----------

def name_kind(name, line, group, hints):
    """建议名性质：ok 可用 / none 无 / label 疑为线路名标签（如「11号线」、含连线的起讫标签）。"""
    if not name:
        return "none"
    if (_LABEL_RE.match(name) or re.search(r"[-–—~～→]", name)
            or name in hints or name in (line, group)):
        return "label"
    return "ok"


def classify_ends(lines, by_line):
    """每条非闭合、有落站的 path 两端各记一条：最外站、线端超出量 gap、线端是否止于线间交汇处。"""
    ends = []
    for sl, P in lines.items():
        sts = by_line.get(sl)
        if not sts or P["closed"]:
            continue
        for k in (0, 1):
            stop = min(sts, key=lambda s: s["t"]) if k == 0 else max(sts, key=lambda s: s["t"])
            gap = (stop["t"] if k == 0 else 1.0 - stop["t"]) * P["len"]
            e = P["pts"][0] if k == 0 else P["pts"][-1]
            join = sorted(o for o, Q in lines.items()
                          if o != sl and near_path(e[0], e[1], Q, JOIN_D) is not None)
            ends.append({"line": sl, "k": k, "stop": stop, "gap": gap, "join": join,
                         "level": end_level(gap, join), "xy": e})
    return ends


def end_level(gap, join):
    if not join:
        if gap <= END_TOL:
            return 2.0
        return 1.5 if gap <= NEAR_TOL else 0.6
    return 1.0 if gap <= NEAR_TOL else 0.3


def build_candidates(lines, stops, unbound, trans):
    """给每个落站挂上圈层/方位/尽端/换乘/品质分，返回上下文。"""
    circles = stops + unbound
    cx = sum(c["x"] for c in circles) / len(circles)
    cy = sum(c["y"] for c in circles) / len(circles)
    radii = sorted(math.hypot(c["x"] - cx, c["y"] - cy) for c in circles)
    cuts = [quantile(radii, f) for f in CUTS]          # [p50, p75, p90]

    by_line = {}
    for s in stops:
        P = lines.get(s["line"])
        if P is None:
            raise SystemExit("预置落站引用了 import 中不存在的 sourceLayer：%s" % s["line"])
        by_line.setdefault(s["line"], []).append(s)
        s["radius"] = math.hypot(s["x"] - cx, s["y"] - cy)
        s["sector"], s["theta"] = bearing_of(cx, cy, s["x"], s["y"])
        s["ring"] = (0 if s["radius"] > cuts[2] else 1 if s["radius"] > cuts[1]
                     else 2 if s["radius"] > cuts[0] else 3)
        s["nk"] = name_kind(s["name"], s["line"], s["group"], P["hints"])
        s["ends"], s["coincide"], s["trans_d"], s["near"] = [], [], None, []

    ends = classify_ends(lines, by_line)
    for e in ends:
        e["stop"]["ends"].append(e)

    # 换乘 ①：不同线组圆心 <25pt 重合（任务书字面规则；本源图换乘站多只画一个圆，命中很少）
    for i, a in enumerate(stops):
        for b in stops[i + 1:]:
            if b["group"] != a["group"] and math.hypot(a["x"] - b["x"], a["y"] - b["y"]) < COINCIDE_D:
                a["coincide"].append(b)
                b["coincide"].append(a)

    # 换乘 ②：源图 Trans 层换乘符号 <25pt（旁证）；邻近线 = 站圆 25pt 内的其他线 path
    if trans:
        for s in stops:
            d = min((math.hypot(s["x"] - t[0], s["y"] - t[1]) for t in trans), default=float("inf"))
            if d < TRANS_D:
                s["trans_d"] = d
                s["near"] = sorted(o for o, Q in lines.items()
                                   if o != s["line"] and near_path(s["x"], s["y"], Q, COINCIDE_D) is not None)

    n_xfer = 0
    for s in stops:
        s["xfer"] = bool(s["coincide"]) or s["trans_d"] is not None
        n_xfer += int(s["xfer"])
        lv = max((e["level"] for e in s["ends"]), default=0.0)
        s["end_level"] = lv
        s["end_gap"] = min((e["gap"] for e in s["ends"] if e["level"] == lv), default=0.0)
        q = W_NAME if s["nk"] == "ok" else (W_LABEL if s["nk"] == "label" else 0.0)
        s["q"] = q + (W_XFER if s["xfer"] else 0.0) + END_BONUS[lv]

    for s in unbound:
        s["radius"] = math.hypot(s["x"] - cx, s["y"] - cy)
        s["sector"], s["theta"] = bearing_of(cx, cy, s["x"], s["y"])
        s["ring"] = (0 if s["radius"] > cuts[2] else 1 if s["radius"] > cuts[1]
                     else 2 if s["radius"] > cuts[0] else 3)
    return stops, {"cx": cx, "cy": cy, "cuts": cuts, "ends": ends, "unbound": unbound, "n_xfer": n_xfer,
            "n_coincide_pairs": sum(len(s["coincide"]) for s in stops) // 2,
            "n_trans_hits": sum(1 for s in stops if s["trans_d"] is not None)}


# ---------- 选点 ----------

def apportion(n, weights):
    """最大余数法：把 n 按权重分到各圈（余数相同者外圈优先）。"""
    raw = [n * w / float(sum(weights)) for w in weights]
    base = [int(math.floor(v)) for v in raw]
    for i in sorted(range(len(weights)), key=lambda i: (-(raw[i] - base[i]), i))[: n - sum(base)]:
        base[i] += 1
    return base


def _dist(a, b):
    return math.hypot(a["x"] - b["x"], a["y"] - b["y"])


def _tie_key(c):
    """同分时的稳定次序：更外围 → 方位角小 → 坐标 → 线名 → t（保证可复跑）。"""
    return (-c["radius"], c["theta"], c["x"], c["y"], c["line"], c["t"])


def order_key(c):
    """编号次序：外圈→内圈、自北顺时针。"""
    return (c["ring"], c["theta"], -c["radius"], c["x"], c["y"], c["line"], c["t"])


def _pair(c, ends_by_line, picked_ids):
    """候选点所在 path 的另一端最外站已入选、且两端相距足够远 → (配对加分, 是否配对)。"""
    for e in c["ends"]:
        for f in ends_by_line[e["line"]]:
            if f["k"] != e["k"] and id(f["stop"]) in picked_ids and _dist(c, f["stop"]) >= PAIR_MIN_DIST:
                return W_PAIR, True
    return 0.0, False


def select_points(cands, ctx, n, backup_n):
    """两阶段贪心选主选，再选备选。返回 (主选, 备选, 配额, 方位下限, 理由, 备选理由)。"""
    quotas = apportion(max(n, 1), RING_W)
    dense = {b: int(round(extra * max(n, 1) / float(sum(RING_W)))) for b, extra in DENSE_EXTRA.items()}
    minima = {b: (1 + dense.get(b, 0)) if n >= len(BEARINGS) else 0 for b in BEARINGS}
    ends_by_line = {}
    for e in ctx["ends"]:
        ends_by_line.setdefault(e["line"], []).append(e)

    picked, why = [], {}

    def ids():
        return {id(p) for p in picked}

    def take(c, reason):
        picked.append(c)
        why[id(c)] = reason

    def key1(c):                       # 方位覆盖阶段：越外圈越优先
        return (-(c["q"] + RING_WEIGHT[c["ring"]]),) + _tie_key(c)

    def key2(c):                       # 补配额阶段：同线另一尽端加分；同线、同圈同方位已有入选站减分
        pair, paired = _pair(c, ends_by_line, ids())
        adj = pair
        if not paired and any(p["group"] == c["group"] for p in picked):
            adj += W_SAME_LINE
        if any(p["ring"] == c["ring"] and p["sector"] == c["sector"] for p in picked):
            adj += W_SAME_CELL
        return (-(c["q"] + adj),) + _tie_key(c)

    def ring_left():
        left = list(quotas)
        for p in picked:
            left[p["ring"]] -= 1
        return left

    def choose(pool, seps, keyf, against):
        """池内取最优；先要求与已选点保持间距，全不满足时放宽间距（绝不重复同站）。"""
        if not pool:
            return None
        ok = [c for c in pool if all(_dist(c, p) >= seps[c["ring"]] for p in against)]
        return min(ok or pool, key=keyf)

    # ① 八方位覆盖（W / SW 加密）
    for b in BEARINGS:
        for _ in range(minima[b]):
            if len(picked) >= n:
                break
            pid, left = ids(), ring_left()
            pool = [c for c in cands if c["sector"] == b and id(c) not in pid and left[c["ring"]] > 0]
            c = choose(pool, MIN_SEP, key1, picked)
            if c is None:              # 该方位各圈配额已满 → 不看配额再取一次
                c = choose([x for x in cands if x["sector"] == b and id(x) not in pid], MIN_SEP, key1, picked)
            if c is None:
                break
            take(c, "方位覆盖·%s%s" % (BEARING_CN[b], "（加密）" if dense.get(b) else ""))

    # ② 逐圈补配额；某圈补不满时余量向内一圈顺延
    left = ring_left()
    for r in range(4):
        if len(picked) >= n:
            break
        left[r] = min(left[r], n - len(picked))
        while left[r] > 0:
            pid = ids()
            c = choose([x for x in cands if x["ring"] == r and id(x) not in pid], MIN_SEP, key2, picked)
            if c is None:
                break
            _, paired = _pair(c, ends_by_line, pid)
            take(c, "补%s配额%s" % (RING_CN[r], "·同线另一尽端" if paired else ""))
            left[r] -= 1
        if left[r] > 0 and r < 3:
            left[r + 1] += left[r]

    while len(picked) < n:             # 兜底：全图、不限间距，仍补不足则如实少选
        pool = [x for x in cands if id(x) not in ids()]
        if not pool:
            break
        c = min(pool, key=lambda x: (x["ring"],) + key2(x))
        take(c, "兜底补足")
    main = list(picked)

    # ③ 备选：先补未覆盖的线路尽端，再按品质分补齐
    seps = [s * BACKUP_SEP_FACTOR for s in MIN_SEP]
    rank = {"ok": 0, "none": 1, "label": 2}
    chosen, backup, bwhy = list(main), [], {}

    def btake(c, reason):
        chosen.append(c)
        backup.append(c)
        bwhy[id(c)] = reason

    def spaced(c):
        return all(_dist(c, p) >= seps[c["ring"]] for p in chosen)

    for e in sorted(ctx["ends"], key=lambda e: (e["stop"]["ring"], rank[e["stop"]["nk"]], -e["level"])
                    + _tie_key(e["stop"])):
        if len(backup) >= backup_n:
            break
        s = e["stop"]
        if not any(s is p for p in chosen) and spaced(s):
            btake(s, "未覆盖线路尽端·" + END_TEXT[e["level"]].format(gap=e["gap"]))
    while len(backup) < backup_n:
        pool = [c for c in cands if not any(c is p for p in chosen)]
        if not pool:
            break
        c = min([x for x in pool if spaced(x)] or pool,
                key=lambda x: (x["ring"], -x["q"]) + _tie_key(x))
        btake(c, "品质分次优候选")
    return main, backup, quotas, minima, why, bwhy


def assign_ids(main, backup, why, bwhy):
    """按「外圈→内圈、自北顺时针」排序并编号；同时写入入选理由。"""
    width = max(2, len(str(len(main))))
    m = sorted(main, key=order_key)
    b = sorted(backup, key=order_key)
    for i, c in enumerate(m, 1):
        c["id"], c["why"] = "%0*d" % (width, i), why[id(c)]
    for i, c in enumerate(b, 1):
        c["id"], c["why"] = "B%d" % i, bwhy[id(c)]
    return m, b


def self_check(main, backup, cands):
    """硬性自检失败即抛错；软性检查以消息形式返回。"""
    pts = [(c["x"], c["y"]) for c in main + backup]
    if len(set(pts)) != len(pts):
        raise SystemExit("自检失败：主选/备选存在重复圆心")
    known = {(s["x"], s["y"]) for s in cands}
    if not all(p in known for p in pts):
        raise SystemExit("自检失败：存在坐标不在预置站圆上的点")
    msgs = ["主选 %d 点、备选 %d 点圆心互不重复" % (len(main), len(backup)),
            "全部坐标与 import/站圆预置-草稿.json 的站圆圆心逐一一致"]
    if len(main) >= len(BEARINGS):
        miss = sorted(set(BEARINGS) - {c["sector"] for c in main})
        msgs.append("八方位齐全" if not miss else "注意：八方位缺 %s" % "/".join(miss))
    return msgs


# ---------- 文本辅助 ----------

def xfer_lines(c):
    """共点线名：共点圆所在线 ∪ Trans 旁证的邻近线（去重排序）。"""
    return sorted({b["line"] for b in c["coincide"]} | set(c["near"]))


def xfer_text(c):
    out = []
    if c["coincide"]:
        out.append("共点圆 " + "、".join("%s（%s）%.1fpt" % (b["line"], b["name"] or "无建议名", _dist(c, b))
                                     for b in c["coincide"]))
    if c["trans_d"] is not None:
        out.append("源图 Trans 层换乘符号 %.1fpt，邻近线 %s" % (c["trans_d"], "、".join(c["near"]) or "无"))
    return "换乘：" + "；".join(out)


def end_text(c):
    return "；".join(END_TEXT[e["level"]].format(gap=e["gap"])
                     for e in c["ends"] if e["level"] == c["end_level"])


NAME_NOTE = {"ok": "站名建议，待用户核实",
             "none": "无站名建议，请按线位核实",
             "label": "建议名疑为线路名标签，待用户核实"}


def note_text(c):
    parts = [NAME_NOTE[c["nk"]], "线名 " + c["line"]]
    if re.match(r"^path-\d+$", c["line"]):
        parts.append("源图站圆层组名「%s」（源图命名，供定位参考）" % c["group"])
    if c["xfer"]:
        parts.append(xfer_text(c))
    e = end_text(c)
    if e:
        parts.append(e)
    parts.append("选中理由：" + c["why"])
    return "；".join(parts)


def table_row(c):
    """报告用紧凑行：编号｜圈层｜方位｜线名｜站名建议｜x,y｜共点线。"""
    return (c["id"], RING_CN[c["ring"]] + "/" + RING_NAMES[c["ring"]], c["sector"], c["line"],
            c["name"] or "（无）", "%.1f, %.1f" % (c["x"], c["y"]), "/".join(xfer_lines(c)) or "—")


# ---------- CSV 回填模板 ----------

CSV_HEADER = ["id", "ring", "bearing", "line", "station", "x", "y", "t", "lon", "lat", "note"]


def csv_row(c):
    return {"id": c["id"], "ring": RING_NAMES[c["ring"]], "bearing": c["sector"], "line": c["line"],
            "station": c["name"] or "", "x": "%.1f" % c["x"], "y": "%.1f" % c["y"],
            "t": "%.6f" % c["t"], "lon": "", "lat": "", "note": note_text(c)}


def render_csv(rows):
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=CSV_HEADER, lineterminator="\n")
    w.writeheader()
    w.writerows(rows)
    return buf.getvalue()


def carry_manual_csv(existing, rows):
    """重跑保护：旧文件里人工回填的 lon/lat，编号与 (x,y) 都对得上才带回。返回 (带回行数, 对不上的编号)。"""
    if not existing:
        return 0, []
    old = {r["id"]: r for r in csv.DictReader(existing.splitlines()) if r.get("id")}
    filled = {k: o for k, o in old.items() if (o.get("lon") or "").strip() or (o.get("lat") or "").strip()}
    carried = set()
    for r in rows:
        o = filled.get(r["id"])
        try:
            same = (o is not None and abs(float(o["x"]) - float(r["x"])) < 0.051
                    and abs(float(o["y"]) - float(r["y"])) < 0.051)
        except (TypeError, ValueError):
            same = False
        if same:
            r["lon"], r["lat"] = o["lon"].strip(), o["lat"].strip()
            carried.add(r["id"])
    return len(carried), sorted(k for k in filled if k not in carried)


def write_text(path, text):
    """UTF-8 无 BOM、LF；内容未变则不重写（幂等）。返回是否写入。"""
    data = text.encode("utf-8")
    if path.exists() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return True


# ---------- 清单 Markdown ----------

CATEGORY_CN = {"reserved": "预控通道", "interprovincial": "他省线路"}


def _table(header, rows):
    return ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)] + \
           ["| " + " | ".join(str(v).replace("|", "\\|") for v in r) + " |" for r in rows]


def trans_only_peripheral(trans, lines, cands, ctx):
    """Trans 层换乘符号中，位于次外围及以外、且 25pt 内没有任何已绑定落站者（无绑定线/无建议名）。"""
    out = []
    if not trans:
        return out
    for x, y in trans:
        r = math.hypot(x - ctx["cx"], y - ctx["cy"])
        if r <= ctx["cuts"][1]:
            continue
        dmin = min(math.hypot(x - s["x"], y - s["y"]) for s in cands)
        if dmin < COINCIDE_D:
            continue
        sec, _th = bearing_of(ctx["cx"], ctx["cy"], x, y)
        out.append({"x": x, "y": y, "r": r, "ring": 0 if r > ctx["cuts"][2] else 1, "sector": sec,
                    "near": sorted(o for o, Q in lines.items() if near_path(x, y, Q, COINCIDE_D) is not None),
                    "dmin": dmin})
    out.sort(key=lambda o: (-o["r"], o["x"], o["y"]))
    return out


def build_md(main, backup, cands, ctx, lines, args, meta, checks):
    n, k = len(main), len(backup)
    cx, cy, cuts = ctx["cx"], ctx["cy"], ctx["cuts"]
    quotas = apportion(max(args.n, 1), RING_W)
    L = ["# 手动标定 · 候选点清单（%d 主选 + %d 备选）" % (n, k), ""]
    L += ["> 用途：按编号去 Google Earth 找到对应车站的真实位置并标注经纬度，回传后用手动控制点重拟合标定。",
          "> 站名一律是源图就近文字的**建议**（待用户核实），线名是源图命名 `sourceLayer`；"
          "坐标为 .ai 页面基准（12000×12000，y 向下），单位 pt。",
          "> 生成命令：`python -X utf8 tools/calib_manual_pick.py`（纯标准库，重复运行输出幂等）。",
          "> 数据源：`import/远期图-全量.json`（sha256 前 12 位 `%s`，%d 条 path）、"
          "`import/站圆预置-草稿.json`（`%s`，%d 落站 + %d 未绑定组圆）%s。"
          % (meta["lines_sha"], meta["n_paths"], meta["stations_sha"], len(cands), len(ctx["unbound"]),
             "；换乘旁证取自 `零散/ai_layer_paths.json`（`%s`）的 Station/Trans 层" % meta["layers_sha"]
             if meta["layers_sha"] else "；未使用 Trans 层换乘旁证"),
          ""]

    # 一、规则与参数
    L += ["## 一、规则与参数", "",
          "- 地图中心：全部站圆（%d 落站 + %d 未绑定组圆）质心 = (%.1f, %.1f)。" % (len(cands), len(ctx["unbound"]), cx, cy),
          "- 圈层：按到中心距离的分位划分——内圈 ≤ %.0f < 中圈 ≤ %.0f < 次外围 ≤ %.0f < 最外围（分位 p50 / p75 / p90）。"
          % (cuts[0], cuts[1], cuts[2]),
          "- 圈层配额：%s（随 `--n` 按最大余数法伸缩）。" % " / ".join("%s %d" % (RING_CN[i], quotas[i]) for i in range(4)),
          "- 方位：八方位各至少 1 点，西、西南各加密 +%d（9 号线最西端以西/西南为已知最弱区）。"
          % int(round(DENSE_EXTRA["W"] * max(n, 1) / float(sum(RING_W)))),
          "- 候选池：%d 个已绑定落站（未绑定组圆没有 t、线名与建议名，不进候选池，见第五节）。" % len(cands),
          "- 品质分：有建议名 +%.1f；换乘 +%.1f；线路尽端最外站 +%.1f ~ +%.1f（path 端点即站圆最高）；建议名疑为线路名标签 %.1f。"
          % (W_NAME, W_XFER, min(v for kk, v in END_BONUS.items() if kk), max(END_BONUS.values()), W_LABEL),
          "- 换乘判定：① 不同线组圆心重合 <%dpt（全图仅 %d 对）；② 站圆 <%dpt 内有源图 Station/Trans 层换乘符号，"
          "并列出站圆 <%dpt 内经过的其他线（命中 %d 站）。%s"
          % (COINCIDE_D, ctx["n_coincide_pairs"], TRANS_D, COINCIDE_D, ctx["n_trans_hits"],
             "" if meta["layers_sha"] else "（未启用 Trans 层旁证，仅用 ①）"),
          "- 间距：各圈入选点最小间距 %s pt；补配额时同线另一端已入选 +%.1f，同线已有入选站 %.1f、"
          "同圈层同方位已有入选站 %.1f。" % ("/".join("%d" % s for s in MIN_SEP), W_PAIR, W_SAME_LINE, W_SAME_CELL),
          "- **发现**：源图换乘站只在 Trans 层画一个大圆，各线分组里没有对应圆——所以字面规则 ① 几乎命中不到，"
          "换乘站若有站名也只在 PDF 文字层；需要把它们纳入候选的话，得先由站圆预置管线补出 Trans 层站名建议。",
          ""]

    # 二、主选
    L += ["## 二、主选 %d 点（编号 %s~%s，外圈→内圈、自北顺时针）" % (n, main[0]["id"] if main else "-", main[-1]["id"] if main else "-"), ""]
    L += _table(["编号", "圈层", "方位", "线名", "站名建议", "x, y", "t", "共点线", "尽端", "选中理由"],
                [(c["id"], RING_CN[c["ring"]], c["sector"], c["line"], c["name"] or "（无）",
                  "%.1f, %.1f" % (c["x"], c["y"]), "%.6f" % c["t"], "/".join(xfer_lines(c)) or "—",
                  END_SHORT[c["end_level"]] or "—", c["why"]) for c in main])
    L.append("")

    # 三、备选
    L += ["## 三、备选 %d 点（编号 B1~B%d，格式同上；主选有找不到/不确定的点时按编号替换）" % (k, k), ""]
    L += _table(["编号", "圈层", "方位", "线名", "站名建议", "x, y", "t", "共点线", "尽端", "入选理由"],
                [(c["id"], RING_CN[c["ring"]], c["sector"], c["line"], c["name"] or "（无）",
                  "%.1f, %.1f" % (c["x"], c["y"]), "%.6f" % c["t"], "/".join(xfer_lines(c)) or "—",
                  END_SHORT[c["end_level"]] or "—", c["why"]) for c in backup])
    L.append("")

    # 四、统计
    L += ["## 四、选点统计", "", "### 4.1 主选：圈层 × 方位", ""]
    mat = []
    for r in range(4):
        row = [sum(1 for c in main if c["ring"] == r and c["sector"] == b) for b in BEARINGS]
        mat.append([RING_CN[r]] + row + [sum(row), quotas[r]])
    tot = [sum(1 for c in main if c["sector"] == b) for b in BEARINGS]
    mat.append(["合计"] + tot + [sum(tot), sum(quotas)])
    L += _table(["圈层"] + BEARINGS + ["合计", "配额"], mat)
    L += ["", "### 4.2 其他", ""]
    bk = [sum(1 for c in backup if c["ring"] == r) for r in range(4)]
    x_ref = min((s["x"] for s in cands if s["line"] == "9"), default=None)
    L += ["- 备选圈层分布：%s。" % " / ".join("%s %d" % (RING_CN[i], bk[i]) for i in range(4)),
          "- 主选中换乘站 %d 个、线路尽端最外站 %d 个（其中 path 端点即站圆的尽端站 %d 个）、无建议名 %d 个。"
          % (sum(1 for c in main if c["xfer"]), sum(1 for c in main if c["end_level"] > 0),
             sum(1 for c in main if c["end_level"] == 2.0), sum(1 for c in main if c["nk"] != "ok")),
          "- 主选涉及 %d 条线（站圆组 %d 个）。"
          % (len({c["line"] for c in main}), len({c["group"] for c in main}))]
    if x_ref is not None:
        L.append("- 最弱区覆盖：9 号线最西端经线（x = %.1f）以西的主选 %d 个（西南方位另有 %d 个）。"
                 % (x_ref, sum(1 for c in main if c["x"] < x_ref),
                    sum(1 for c in main if c["x"] >= x_ref and c["sector"] == "SW")))
    L.append("")

    # 五、未能入选
    L += ["## 五、未能入选的外围线及原因", ""]
    has_line = {s["line"] for s in cands}
    unb_groups = {}
    for u in ctx["unbound"]:
        unb_groups.setdefault(u["group"], []).append(u)
    no_stop = [sl for sl in lines if sl not in has_line]
    L += ["### 5.1 线体在图、但没有已绑定落站（%d 条，无法给出 t 与建议名）" % len(no_stop), ""]
    for sl in sorted(no_stop):
        P = lines[sl]
        extra = CATEGORY_CN.get(P["category"], "")
        if sl in unb_groups:
            extra = (extra + "；" if extra else "") + "Station 层同名组 %d 圆未绑定" % len(unb_groups[sl])
        hint = "（站圆组建议名：%s，待核实）" % P["hints"][0].split("(")[0] if P["hints"] else ""
        L.append("- `%s`%s%s" % (sl, "：" + extra if extra else "", hint))
    L += ["", "### 5.2 未绑定站圆组（%d 组 %d 圆：没有 t、线名与建议名）" % (len(unb_groups), len(ctx["unbound"])), ""]
    for g in sorted(unb_groups, key=lambda g: -len(unb_groups[g])):
        us = unb_groups[g]
        rings = [sum(1 for u in us if u["ring"] == r) for r in range(4)]
        L.append("- **%s**：%d 圆（最外围 %d / 次外围 %d / 中圈 %d / 内圈 %d），%s"
                 % (g, len(us), rings[0], rings[1], rings[2], rings[3],
                    UNBOUND_NOTES.get(g, "圆心距所有已导入 path 过远或无主导归属")))
    bad = [e for e in ctx["ends"] if e["stop"]["nk"] != "ok" and not any(e["stop"] is c for c in main)]
    L += ["", "### 5.3 线路尽端最外站无可用建议名（%d 处，Google Earth 上不好找，未入选）" % len(bad), ""]
    for e in sorted(bad, key=lambda e: (e["stop"]["ring"], e["line"], e["k"])):
        s = e["stop"]
        L.append("- `%s` %s端最外站：%s（%.1f, %.1f）%s"
                 % (e["line"], "起" if e["k"] == 0 else "讫", s["name"] or "无建议名", s["x"], s["y"],
                    "——建议名疑为线路名标签" if s["nk"] == "label" else ""))
    far = [e for e in ctx["ends"] if e["gap"] > NEAR_TOL]
    L += ["", "### 5.4 path 端点远超最外站圆 >%.0fpt（%d 处：线端本身没有站圆可用，只能取其内侧最外站）"
          % (NEAR_TOL, len(far)), ""]
    for e in sorted(far, key=lambda e: (e["line"], e["k"])):
        L.append("- `%s` %s端端点 (%.0f, %.0f)：最外站圆「%s」在端点内侧约 %.0fpt%s"
                 % (e["line"], "起" if e["k"] == 0 else "讫", e["xy"][0], e["xy"][1], e["stop"]["name"] or "无建议名", e["gap"],
                    "；端点止于与 %s 交汇处" % "、".join(e["join"]) if e["join"] else ""))
    tp = trans_only_peripheral(ctx["trans"], lines, cands, ctx)
    if ctx["trans"]:
        L += ["", "### 5.5 Trans 层外围换乘符号（次外围及以外共 %d 处没有对应落站：无绑定线、无建议名，未入选）" % len(tp), ""]
        for o in tp:
            L.append("- (%.1f, %.1f)〔%s·%s〕交汇线：%s；最近落站 %.0fpt"
                     % (o["x"], o["y"], RING_CN[o["ring"]], o["sector"], "、".join(o["near"]) or "无", o["dmin"]))
    lab = [s for s in cands if s["nk"] == "label"]
    L += ["", "### 5.6 建议名疑为线路名标签的落站（%d 个，已降权）" % len(lab), ""]
    for s in lab:
        L.append("- `%s`（%.1f, %.1f）：建议名「%s」%s" % (s["line"], s["x"], s["y"], s["name"],
                 "——入选 " + s["id"] if "id" in s else "——未入选"))
    L.append("")

    # 六、使用步骤
    L += ["## 六、使用步骤", "",
          "**A. Google Earth 建点（推荐，无需手填 CSV）**", "",
          "1. 打开叠加图 `零散/手动标定-候选点.html`，对照 AI 源图核对 30 个编号点的位置；不合适的记下编号，"
          "用备选（B1~B%d）或本文表里的其他站替换。" % k,
          "2. 在 Google Earth 里按「线名 + 站名建议」找到该站的真实位置（尽量放到车站中心），新建地名点：",
          "   - **地名以编号开头**即可，例如 `07`、`07 金山卫`、`B3`；同一编号只建一个点；",
          "   - 全部放进同一个文件夹，右键文件夹 →「保存位置为…」导出 **KML 或 KMZ** 发回。",
          "3. 我们直接读取 KML/KMZ 里以编号命名的地名点，按编号对回 x,y 重拟合，无需手填 CSV。"
          "找不到或不确定的点可以不建（或在描述里写「存疑」），不影响其余点。", "",
          "**B. 直接回填 CSV**", "",
          "- 编辑 `data/manual-control-points.csv`，在 `lon,lat` 两列填十进制度（WGS84，东经/北纬为正），其余列不要改，"
          "保存为 UTF-8。",
          "- 重跑本脚本不会冲掉已回填的值：编号与 x,y 都对得上的行原样保留；对不上的会报错停下（确认丢弃才加 `--force`）。",
          ""]

    # 七、文件
    rel = lambda p: Path(p).resolve().relative_to(ROOT).as_posix() if Path(p).resolve().is_relative_to(ROOT) else str(p)
    L += ["## 七、生成文件", "",
          "- `tools/calib_manual_pick.py`：选点脚本（入库）。",
          "- `%s`：回填模板（%d 主选 + %d 备选，UTF-8 无 BOM，lon/lat 留空）。" % (rel(args.out_csv), n, k),
          "- `%s`：叠加核对图（自包含单文件；`零散/` 不入库）。" % rel(args.out_html),
          "- `%s`：本清单（`零散/` 不入库）。" % rel(args.out_md), ""]

    # 八、自检
    L += ["## 八、自检", ""] + ["- " + m for m in checks] + [""]
    return "\n".join(L)


# ---------- 叠加核对图 HTML（自包含单文件，数据内联，不 fetch） ----------

HTML_CSS = r"""
:root { color-scheme: light;
  --surface:#ffffff; --plane:#f9f9f7; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --hair:#e1e0d9; --base:#c3c2b7; --main:#d03b3b; --backup:#2a78d6;
  --font: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; background: var(--plane); color: var(--ink); font: 14px/1.5 var(--font); }
header { padding: 10px 16px 8px; background: var(--surface); border-bottom: 1px solid var(--hair); }
h1 { font-size: 17px; margin: 0 0 2px; font-weight: 650; }
.sub { margin: 0 0 6px; color: var(--ink-2); font-size: 12.5px; }
.controls { display: flex; flex-wrap: wrap; gap: 4px 18px; align-items: center; font-size: 13px; }
.controls label { display: inline-flex; gap: 5px; align-items: center; cursor: pointer; }
.controls button { font: 12.5px var(--font); padding: 2px 10px; border: 1px solid var(--hair); border-radius: 5px;
  background: var(--surface); color: var(--ink); cursor: pointer; }
.controls button:hover { background: #f1f0ec; }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 2px 18px; margin: 6px 0 0; padding: 0; font-size: 12.5px; color: var(--ink-2); }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.sw { display: inline-block; width: 14px; height: 14px; border-radius: 50%; flex: none; }
.sw.main { background: var(--main); box-shadow: 0 0 0 2px var(--surface), 0 0 0 3px var(--hair); }
.sw.backup { border: 2.5px solid var(--backup); background: var(--surface); }
.sw.dot { width: 6px; height: 6px; margin: 0 4px; background: var(--muted); }
.sw.line { width: 22px; height: 0; border-top: 1.5px solid var(--base); border-radius: 0; }
.sw.guide { width: 15px; height: 15px; border: 1px dashed var(--muted); background: none; }
.how { margin: 6px 0 0; padding-left: 20px; font-size: 12.5px; color: var(--ink-2); }
.how li { margin: 1px 0; }
main { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) 440px; }
#map { min-width: 0; min-height: 0; position: relative; background: var(--surface); }
#svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none; cursor: grab; }
#svg.panning { cursor: grabbing; }
aside { min-height: 0; overflow: auto; border-left: 1px solid var(--hair); background: var(--surface); }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th, td { padding: 3px 6px; text-align: left; white-space: nowrap; border-bottom: 1px solid var(--hair); font-variant-numeric: tabular-nums; }
th { position: sticky; top: 0; background: var(--surface); color: var(--ink-2); font-weight: 600; z-index: 1; }
tbody tr { cursor: pointer; }
tbody tr:hover, tbody tr.hl { background: #f1f0ec; }
tr.bk td { color: var(--ink-2); }
td.id { font-weight: 650; color: var(--ink); }
.pill { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; vertical-align: -1px; }
.pill.main { background: var(--main); }
.pill.backup { border: 2px solid var(--backup); }
#tip { position: fixed; z-index: 10; max-width: 440px; padding: 8px 10px; background: var(--surface); border: 1px solid var(--hair);
  border-radius: 6px; box-shadow: 0 4px 16px rgba(11,11,11,.14); font-size: 12.5px; line-height: 1.5; pointer-events: none; }
#tip .t { font-weight: 650; font-size: 13.5px; margin-bottom: 2px; }
#tip div + div { color: var(--ink-2); }
footer { padding: 4px 16px; font-size: 11.5px; color: var(--muted); background: var(--surface); border-top: 1px solid var(--hair); }
/* ---- SVG 图层 ---- */
.ln { fill: none; stroke: var(--base); stroke-width: 1.4px; stroke-linejoin: round; stroke-linecap: round; pointer-events: none; }
.ln.hl { stroke: var(--ink-2); stroke-width: 3px; }
.hit { fill: none; stroke: transparent; pointer-events: stroke; cursor: help; }
.ll { fill: var(--ink-2); paint-order: stroke; stroke: var(--surface); stroke-width: 3px; stroke-linejoin: round; pointer-events: none; }
.gd { fill: none; stroke: var(--hair); pointer-events: none; }
.gs { fill: var(--muted); pointer-events: none; }
.gc { fill: var(--muted); pointer-events: none; }
.st { fill: var(--muted); opacity: .75; pointer-events: none; }
.mk { cursor: pointer; outline: none; }
.mk .dot { fill: var(--main); stroke: var(--surface); stroke-width: 2px; }
.mk .num { fill: #fff; font: 800 9px/1 var(--font); pointer-events: none; }
.mk .lbl { fill: var(--ink); font: 12px var(--font); paint-order: stroke; stroke: var(--surface); stroke-width: 3px;
  stroke-linejoin: round; pointer-events: none; }
.mk .hitpt { fill: transparent; }
.mk.backup .dot { fill: var(--surface); stroke: var(--backup); stroke-width: 2.5px; }
.mk.backup .lbl { fill: var(--ink-2); }
.mk.hl .dot, .mk:focus-visible .dot { stroke: var(--ink); stroke-width: 3px; }
svg.nb .mk.backup, svg.ns #gStops, svg.ng #gGuide, svg.nl #gLL { display: none; }
@media (max-width: 980px) {
  main { grid-template-columns: 1fr; grid-template-rows: 60vh auto; }
  aside { border-left: 0; border-top: 1px solid var(--hair); }
}
"""

HTML_JS = r"""
(function () {
  'use strict';
  var svg = document.getElementById('svg');
  var data = JSON.parse(document.getElementById('d').textContent);
  var VB = data.viewBox, vb = VB.slice();
  var NS = 'http://www.w3.org/2000/svg';
  var tip = document.getElementById('tip');
  var ZMIN = 0.8, ZMAX = 60;            // 相对全图的缩放范围
  var c = 1, sx = 1, ox = 0, oy = 0;    // sx = 像素/单位；ox/oy = 留白偏移

  function el(tag, attrs, parent, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }

  // ---- 建图（自下而上：圈层方位参考 → 线路 → 线名 → 其余站圆 → 线路悬停热区 → 候选点）----
  var gGuide = el('g', {id: 'gGuide'}, svg), gLines = el('g', {id: 'gLines'}, svg),
      gLL = el('g', {id: 'gLL'}, svg), gStops = el('g', {id: 'gStops'}, svg),
      gHits = el('g', {id: 'gHits', fill: 'none', stroke: 'transparent'}, svg),
      gMarks = el('g', {id: 'gMarks'}, svg);
  var guideDashed = [], dashed = [], dots = [], lineEls = [];
  var cx = data.center[0], cy = data.center[1], g = data.cuts[2] * 1.16;
  data.cuts.forEach(function (r) {
    guideDashed.push(el('circle', {cx: cx, cy: cy, r: r.toFixed(1), 'class': 'gd'}, gGuide));
  });
  data.bearings.forEach(function (b) {           // 八方位分界线（22.5° + 45°k，自北顺时针）
    var a = (b[0] + 22.5) * Math.PI / 180;
    el('line', {x1: cx, y1: cy, x2: (cx + g * Math.sin(a)).toFixed(1), y2: (cy - g * Math.cos(a)).toFixed(1), 'class': 'gd'}, gGuide);
    a = b[0] * Math.PI / 180;
    el('text', {x: (cx + g * 1.045 * Math.sin(a)).toFixed(1), y: (cy - g * 1.045 * Math.cos(a)).toFixed(1),
      'text-anchor': 'middle', 'dominant-baseline': 'middle', 'class': 'gs'}, gGuide, b[1]);
  });
  var guideDot = el('circle', {cx: cx, cy: cy, 'class': 'gc'}, gGuide);
  data.lines.forEach(function (L, i) {
    var p = el('path', {id: 'ln' + i, d: L.d, 'class': L.dash ? 'ln dash' : 'ln', 'vector-effect': 'non-scaling-stroke'}, gLines);
    lineEls.push(p);
    if (L.dash) dashed.push(p);
    el('use', {href: '#ln' + i, 'data-i': i, 'class': 'hit'}, gHits);
    el('text', {x: L.label[0], y: L.label[1], 'text-anchor': 'middle', 'class': 'll'}, gLL, L.n);
  });
  data.stops.forEach(function (s) { dots.push(el('circle', {cx: s[0], cy: s[1], 'class': 'st'}, gStops)); });

  var marks = [], byId = {};
  data.points.forEach(function (p) {
    var m = el('g', {'class': 'mk ' + p.kind, tabindex: '0', 'data-id': p.id,
      transform: 'translate(' + p.x + ' ' + p.y + ')'}, gMarks);
    var inner = el('g', {'class': 'inner'}, m);
    el('circle', {'class': 'dot', r: 7.5}, inner);
    if (p.kind === 'main') {
      var num = el('text', {'class': 'num', dy: 3.2, 'text-anchor': 'middle'}, inner, p.id);
      if (p.id.length > 2) num.style.fontSize = '7px';
    }
    var lbl = el('text', {'class': 'lbl', x: 11, y: 4}, inner,
      (p.kind === 'backup' ? p.id + ' ' : '') + (p.station || '（无站名建议）'));
    el('circle', {'class': 'hitpt', r: 15}, inner);      // 悬停/键盘热区 ≥ 24px
    var o = {el: m, inner: inner, lbl: lbl, x: p.x, y: p.y, px: 0, py: 0, p: p};
    marks.push(o);
    byId[p.id] = o;
  });

  // ---- 右侧清单（与图中点位联动；文字一律 textContent）----
  var tbody = document.getElementById('tb'), rows = {};
  data.points.forEach(function (p) {
    var tr = document.createElement('tr');
    tr.className = p.kind === 'backup' ? 'bk' : '';
    tr.dataset.id = p.id;
    [p.id, p.ringCn, p.bearingCn + ' ' + p.bearing, p.line, p.station || '（无）',
     p.xfer || '—'].forEach(function (v, i) {
      var td = document.createElement('td');
      if (i === 0) {
        var s = document.createElement('span');
        s.className = 'pill ' + p.kind;
        td.className = 'id';
        td.appendChild(s);
        td.appendChild(document.createTextNode(v));
      } else {
        td.textContent = v;
      }
      tr.appendChild(td);
    });
    tr.title = [p.xferText, p.endText, (p.kind === 'main' ? '选中理由：' : '备选理由：') + p.why]
      .filter(Boolean).join('；');
    tbody.appendChild(tr);
    rows[p.id] = tr;
  });

  // ---- 视口：viewBox 缩放/平移，标记保持屏幕像素大小 ----
  function metrics() {
    var W = svg.clientWidth, H = svg.clientHeight;
    if (!W || !H) return false;
    c = Math.max(1 / W, VB[2] / (VB[3] * H));     // 单位/像素 与 viewBox 宽之比（常数）
    sx = 1 / (vb[2] * c);
    ox = (W - vb[2] * sx) / 2;
    oy = (H - vb[3] * sx) / 2;
    return true;
  }
  function apply() {
    if (!metrics()) return;
    svg.setAttribute('viewBox', vb.map(function (v) { return v.toFixed(2); }).join(' '));
    var k = 1 / sx;                               // 单位/像素
    marks.forEach(function (o) {
      o.inner.setAttribute('transform', 'scale(' + k + ')');
      o.px = ox + (o.x - vb[0]) * sx;
      o.py = oy + (o.y - vb[1]) * sx;
    });
    gHits.setAttribute('stroke-width', 12 * k);
    gLL.setAttribute('font-size', 10.5 * k);
    gGuide.setAttribute('font-size', 12 * k);
    gGuide.setAttribute('stroke-width', k);
    guideDot.setAttribute('r', 3 * k);
    guideDashed.forEach(function (e) { e.setAttribute('stroke-dasharray', (5 * k) + ' ' + (5 * k)); });
    dashed.forEach(function (e) { e.setAttribute('stroke-dasharray', (8 * k) + ' ' + (5 * k)); });
    dots.forEach(function (e) { e.setAttribute('r', 2.3 * k); });
    schedulePlace();
  }
  function clampPan() {
    vb[0] = Math.max(VB[0] - vb[2], Math.min(VB[0] + VB[2], vb[0]));
    vb[1] = Math.max(VB[1] - vb[2], Math.min(VB[1] + VB[3], vb[1]));
  }
  function zoomAt(px, py, f) {                    // 以光标处为锚缩放
    var ux = vb[0] + (px - ox) / sx, uy = vb[1] + (py - oy) / sx;
    var w = Math.max(VB[2] / ZMAX, Math.min(VB[2] / ZMIN, vb[2] / f));
    var s2 = 1 / (w * c);
    vb = [ux - (px - ox) / s2, uy - (py - oy) / s2, w, w * VB[3] / VB[2]];
    clampPan();
    apply();
  }
  function zoomTo(x, y) {                         // 放大到某点（已放得更大则保持倍率）
    var W = svg.clientWidth, H = svg.clientHeight, w = Math.min(vb[2], data.zoomW);
    var s2 = 1 / (w * c), o2x = (W - w * s2) / 2, o2y = (H - w * s2 * VB[3] / VB[2]) / 2;
    vb = [x - (W / 2 - o2x) / s2, y - (H / 2 - o2y) / s2, w, w * VB[3] / VB[2]];
    apply();
  }
  function reset() { vb = VB.slice(); apply(); }

  svg.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = svg.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-Math.max(-300, Math.min(300, e.deltaY)) * 0.002));
  }, {passive: false});
  var drag = null;
  svg.addEventListener('pointerdown', function (e) {
    if ((e.button !== 0 && e.button !== 1) || (e.target.closest && e.target.closest('.mk'))) return;
    drag = {x: e.clientX, y: e.clientY};
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  });
  svg.addEventListener('pointermove', function (e) {
    if (drag) {
      vb[0] -= (e.clientX - drag.x) / sx;
      vb[1] -= (e.clientY - drag.y) / sx;
      drag.x = e.clientX;
      drag.y = e.clientY;
      clampPan();
      apply();
    } else if (!tip.hidden) {
      placeTip(e.clientX, e.clientY);
    }
  });
  function endDrag() { drag = null; svg.classList.remove('panning'); }
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('dblclick', function (e) { if (!(e.target.closest && e.target.closest('.mk'))) reset(); });

  // ---- 悬停提示：点位与线路 ----
  var CAT = {reserved: '预控通道', interprovincial: '他省线路'};
  function pointLines(p) {
    var out = [p.id + '  ' + (p.station || '（无站名建议）'),
      '线名：' + p.line + (p.group && p.group !== p.line ? '（源图站圆层组名：' + p.group + '）' : ''),
      'AI 页面坐标：x ' + p.x.toFixed(1) + '，y ' + p.y.toFixed(1) + '　t ' + p.t.toFixed(6),
      '圈层：' + p.ringCn + '（' + p.ring + '）　方位：' + p.bearingCn + ' ' + p.bearing + '（θ ' + p.theta.toFixed(1) + '°）'];
    if (p.xferText) out.push(p.xferText);
    if (p.endText) out.push(p.endText);
    out.push((p.kind === 'main' ? '选中理由：' : '备选理由：') + p.why);
    return out;
  }
  function lineLines(L) {
    return ['线名：' + L.n,
      '类别：' + (CAT[L.cat] || (L.cat || '未标注')) + '　落站：' + L.ns + ' 站' + (L.closed ? '　闭合环线' : ''),
      'path 端点：(' + L.ends[0][0] + ', ' + L.ends[0][1] + ') → (' + L.ends[1][0] + ', ' + L.ends[1][1] + ')'
        + (L.dash ? '　线型：虚线（同源图）' : '')];
  }
  function showTip(lines, x, y) {
    tip.textContent = '';
    lines.forEach(function (s, i) {
      var d = document.createElement('div');
      if (i === 0) d.className = 't';
      d.textContent = s;
      tip.appendChild(d);
    });
    tip.hidden = false;
    placeTip(x, y);
  }
  function placeTip(x, y) {
    var r = tip.getBoundingClientRect(), L = x + 16, T = y + 16;
    if (L + r.width > window.innerWidth - 8) L = Math.max(8, x - r.width - 16);
    if (T + r.height > window.innerHeight - 8) T = Math.max(8, y - r.height - 16);
    tip.style.left = L + 'px';
    tip.style.top = T + 'px';
  }
  function hideTip() { tip.hidden = true; }
  function setHl(o, on, fromRow) {                // 图中点位 ↔ 右侧清单行 联动高亮
    o.el.classList.toggle('hl', on);
    rows[o.p.id].classList.toggle('hl', on);
    if (on && !fromRow) rows[o.p.id].scrollIntoView({block: 'nearest'});
  }
  function inside(e, sel) { return !!(e.target.closest && e.target.closest(sel)); }
  svg.addEventListener('pointerover', function (e) {
    var mk = e.target.closest && e.target.closest('.mk');
    if (mk) {
      if (mk.contains(e.relatedTarget)) return;
      var o = byId[mk.dataset.id];
      showTip(pointLines(o.p), e.clientX, e.clientY);
      setHl(o, true);
      return;
    }
    var u = e.target.closest && e.target.closest('.hit');
    if (u) {
      lineEls[+u.dataset.i].classList.add('hl');
      showTip(lineLines(data.lines[+u.dataset.i]), e.clientX, e.clientY);
    }
  });
  svg.addEventListener('pointerout', function (e) {
    var mk = e.target.closest && e.target.closest('.mk');
    if (mk) {
      if (mk.contains(e.relatedTarget)) return;
      setHl(byId[mk.dataset.id], false);
      hideTip();
    }
    var u = e.target.closest && e.target.closest('.hit');
    if (u) {
      lineEls[+u.dataset.i].classList.remove('hl');
      hideTip();
    }
  });
  svg.addEventListener('focusin', function (e) {  // 键盘 Tab 到点位：与悬停同样的提示
    var mk = e.target.closest && e.target.closest('.mk');
    if (!mk) return;
    var o = byId[mk.dataset.id], r = svg.getBoundingClientRect();
    showTip(pointLines(o.p), r.left + o.px, r.top + o.py);
    setHl(o, true);
  });
  svg.addEventListener('focusout', function (e) {
    var mk = e.target.closest && e.target.closest('.mk');
    if (!mk) return;
    setHl(byId[mk.dataset.id], false);
    hideTip();
  });
  svg.addEventListener('click', function (e) {
    var mk = e.target.closest && e.target.closest('.mk');
    if (mk) zoomTo(byId[mk.dataset.id].x, byId[mk.dataset.id].y);
  });
  svg.addEventListener('keydown', function (e) {
    var mk = e.target.closest && e.target.closest('.mk');
    if (!mk || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    zoomTo(byId[mk.dataset.id].x, byId[mk.dataset.id].y);
  });
  tbody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr');
    if (tr) zoomTo(byId[tr.dataset.id].x, byId[tr.dataset.id].y);
  });
  tbody.addEventListener('pointerover', function (e) {
    var tr = e.target.closest('tr');
    if (tr) setHl(byId[tr.dataset.id], true, true);
  });
  tbody.addEventListener('pointerout', function (e) {
    var tr = e.target.closest('tr');
    if (tr) setHl(byId[tr.dataset.id], false, true);
  });

  // ---- 站名标签避让：右/左/上/下…依次试放，取与已放标签和点位重叠最少的位置 ----
  var CAND = [[11, 4, 'start'], [-11, 4, 'end'], [0, -13, 'middle'], [0, 18, 'middle'],
    [11, -8, 'start'], [11, 16, 'start'], [-11, -8, 'end'], [-11, 16, 'end']];
  function textW(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 0x2E7F ? 12 : 7;
    return w;
  }
  function inter(a, b) {
    return Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
      * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  }
  var pending = false;
  function schedulePlace() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; placeLabels(); });
  }
  function placeLabels() {
    var vis = marks.filter(function (o) { return o.p.kind === 'main' || cbB.checked; });
    var placed = vis.map(function (o) { return {x: o.px - 10, y: o.py - 10, w: 20, h: 20, o: o}; });
    vis.forEach(function (o) {
      var w = textW(o.lbl.textContent), best = null;
      CAND.forEach(function (cd) {
        var x0 = cd[2] === 'start' ? o.px + cd[0] : cd[2] === 'end' ? o.px + cd[0] - w : o.px + cd[0] - w / 2;
        var r = {x: x0 - 2, y: o.py + cd[1] - 11, w: w + 4, h: 15}, ov = 0;
        placed.forEach(function (q) {
          if (q.o === o) return;                   // 不计自身点位
          ov += (q.o ? 1.2 : 1) * inter(r, q);     // 压到其他点位罚得更重
        });
        if (!best || ov < best.ov) best = {ov: ov, cd: cd, r: r};
      });
      o.lbl.setAttribute('x', best.cd[0]);
      o.lbl.setAttribute('y', best.cd[1]);
      o.lbl.setAttribute('text-anchor', best.cd[2]);
      placed.push(best.r);
    });
  }

  // ---- 开关 ----
  var cbB = document.getElementById('cbBackup'), cbS = document.getElementById('cbStops'),
      cbG = document.getElementById('cbGuide'), cbL = document.getElementById('cbLnames');
  function syncToggles() {
    svg.classList.toggle('nb', !cbB.checked);
    svg.classList.toggle('ns', !cbS.checked);
    svg.classList.toggle('ng', !cbG.checked);
    svg.classList.toggle('nl', !cbL.checked);
    schedulePlace();
  }
  [cbB, cbS, cbG, cbL].forEach(function (cb) { cb.addEventListener('change', syncToggles); });
  document.getElementById('btnReset').addEventListener('click', reset);
  if (window.ResizeObserver) new ResizeObserver(function () { apply(); }).observe(svg);
  else window.addEventListener('resize', apply);

  syncToggles();
  apply();
  var m = location.hash.match(/^#pt=([0-9B]+)/);      // 用 #pt=07 直接定位到该点
  if (m && byId[m[1]]) {
    zoomTo(byId[m[1]].x, byId[m[1]].y);
    setHl(byId[m[1]], true);
  }
  document.documentElement.dataset.ready = data.lines.length + 'L/' + marks.length + 'M';
})();
"""


def _json_for_script(obj):
    """嵌进 <script type="application/json"> 的安全 JSON：转义「<」防提前闭合标签。"""
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return s.replace("<", "\u003c").replace(" ", "\u2028").replace(" ", "\u2029")


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def build_html(main, backup, cands, ctx, lines, meta, args):
    cx, cy, cuts = ctx["cx"], ctx["cy"], ctx["cuts"]
    n, k = len(main), len(backup)
    has_stop = {}
    for s in cands:
        has_stop[s["line"]] = has_stop.get(s["line"], 0) + 1
    ldata, xs, ys = [], [], []
    for sl in sorted(lines):
        P = lines[sl]
        far = max(P["pts"], key=lambda q: (q[0] - cx) ** 2 + (q[1] - cy) ** 2)
        ldata.append({"n": sl, "d": P["d"], "dash": bool(P["dash"]), "cat": P["category"] or "",
                      "ns": has_stop.get(sl, 0), "closed": P["closed"],
                      "label": [round(far[0], 1), round(far[1], 1)],
                      "ends": [[round(P["pts"][0][0], 1), round(P["pts"][0][1], 1)],
                               [round(P["pts"][-1][0], 1), round(P["pts"][-1][1], 1)]]})
        xs += [P["bbox"][0], P["bbox"][2]]
        ys += [P["bbox"][1], P["bbox"][3]]
    g = cuts[2] * 1.17
    xs += [cx - g, cx + g] + [c["x"] for c in main + backup]
    ys += [cy - g, cy + g] + [c["y"] for c in main + backup]
    pad = 100.0
    view = [min(xs) - pad, min(ys) - pad, max(xs) - min(xs) + 2 * pad, max(ys) - min(ys) + 2 * pad]
    pdata = []
    for c in main:
        kind = "main"
        pdata.append(_point_json(c, kind))
    for c in backup:
        pdata.append(_point_json(c, "backup"))
    data = {
        "viewBox": [round(v, 1) for v in view], "zoomW": 2800.0,
        "center": [round(cx, 2), round(cy, 2)], "cuts": [round(v, 1) for v in cuts],
        "bearings": [[i * 45.0, "%s %s" % (b, BEARING_CN[b])] for i, b in enumerate(BEARINGS)],
        "lines": ldata, "stops": [[s["x"], s["y"]] for s in cands], "points": pdata,
    }
    src = ("`import/远期图-全量.json`（%d 条 path，sha256 前 12 位 %s）、`import/站圆预置-草稿.json`（%d 落站，%s）"
           % (len(lines), meta["lines_sha"], len(cands), meta["stations_sha"]))
    if meta["layers_sha"]:
        src += "；换乘旁证取自 `零散/ai_layer_paths.json`（%s）Station/Trans 层" % meta["layers_sha"]
    head = [
        '<!DOCTYPE html>', '<html lang="zh-CN">', '<head>', '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        '<title>手动标定 · 候选点叠加核对图</title>', '<style>', HTML_CSS.strip(), '</style>', '</head>', '<body>',
        '<header>',
        '<h1>手动标定 · 候选点叠加核对图</h1>',
        '<p class="sub">远期.ai 线路 path %d 条 ＋ 已绑定站圆 %d 个（.ai 页面基准 12000×12000，y 向下，单位 pt）。'
        '红色编号点 %d 个为主选、蓝色空心点 %d 个为备选；站名均为源图就近文字的「建议」，待用户核实。</p>'
        % (len(lines), len(cands), n, k),
        '<div class="controls">',
        '<label><input type="checkbox" id="cbBackup"> 显示备选 B1~B%d</label>' % k,
        '<label><input type="checkbox" id="cbStops" checked> 显示其余站圆</label>',
        '<label><input type="checkbox" id="cbGuide" checked> 显示圈层 / 方位分界</label>',
        '<label><input type="checkbox" id="cbLnames" checked> 显示线名</label>',
        '<button id="btnReset" type="button">复位全图</button>',
        '</div>',
        '<ul class="legend">',
        '<li><span class="sw main"></span>主选 %s~%s：去 Google Earth 标注这些</li>' % (main[0]["id"], main[-1]["id"]),
        '<li><span class="sw backup"></span>备选 B1~B%d：主选不合适时按编号替换</li>' % k,
        '<li><span class="sw dot"></span>其余已绑定站圆</li>',
        '<li><span class="sw line"></span>线路 path（虚线＝源图虚线线型；悬停看线名）</li>',
        '<li><span class="sw guide"></span>圈层分界（虚线圆）与八方位分界，圆心＝全部站圆质心</li>',
        '</ul>',
        '<ol class="how">',
        '<li>滚轮缩放、按住拖动平移，双击或点「复位全图」回到全图；悬停（或 Tab 键走到）点位查看线名、站名建议、x,y、圈层、方位。</li>',
        '<li>右侧清单与图中点位联动：悬停互相高亮，点行或点红点放大到该点。</li>',
        '<li>对照 AI 源图确认点位后，到 Google Earth 找到真实位置新建地名点，地名以编号开头（如「07」或「07 金山卫」），'
        '全部放进同一文件夹导出 KML/KMZ 发回即可，无需手填 CSV。</li>',
        '</ol>', '</header>',
        '<main>', '<div id="map"><svg id="svg" xmlns="http://www.w3.org/2000/svg" role="img" '
        'aria-label="远期图线路与手动标定候选点叠加图"></svg></div>',
        '<aside><table><thead><tr><th>编号</th><th>圈层</th><th>方位</th><th>线名</th><th>站名建议</th>'
        '<th>共点线</th></tr></thead><tbody id="tb"></tbody></table></aside>', '</main>',
        '<div id="tip" role="tooltip" hidden></div>',
        '<noscript><p style="padding:12px 16px">本页需要启用 JavaScript 才能绘制叠加图。</p></noscript>',
        '<footer>数据源：%s。地图中心 (%.1f, %.1f)；圈层分位半径 p50 / p75 / p90 = %.0f / %.0f / %.0f pt。'
        '由 tools/calib_manual_pick.py 生成，重复运行输出幂等。</footer>' % (src, cx, cy, cuts[0], cuts[1], cuts[2]),
        '<script type="application/json" id="d">%s</script>' % _json_for_script(data),
        '<script>', HTML_JS.strip(), '</script>', '</body>', '</html>', '']
    return "\n".join(head)


def _point_json(c, kind):
    return {"id": c["id"], "kind": kind, "x": round(c["x"], 2), "y": round(c["y"], 2), "t": c["t"],
            "line": c["line"], "station": c["name"] or "", "group": c["group"],
            "ring": RING_NAMES[c["ring"]], "ringCn": RING_CN[c["ring"]],
            "bearing": c["sector"], "bearingCn": BEARING_CN[c["sector"]], "theta": round(c["theta"], 1),
            "xfer": "/".join(xfer_lines(c)), "xferText": xfer_text(c) if c["xfer"] else "",
            "endText": end_text(c), "why": c["why"]}


# ---------- 主流程 ----------

def main():
    ap = argparse.ArgumentParser(description="手动标定选点：按圈层/方位规则从站圆预置中挑控制点候选（纯标准库，幂等）")
    ap.add_argument("--lines", type=Path, default=DEF_LINES, help="import/远期图-全量.json")
    ap.add_argument("--stations", type=Path, default=DEF_STATIONS, help="import/站圆预置-草稿.json")
    ap.add_argument("--layers", type=Path, default=DEF_LAYERS,
                    help="零散/ai_layer_paths.json：仅取 Station/Trans 层换乘符号作换乘旁证；文件不存在则自动跳过")
    ap.add_argument("--no-trans", action="store_true", help="不使用 Trans 层换乘旁证")
    ap.add_argument("--n", type=int, default=30, help="主选点数（默认 30）")
    ap.add_argument("--backup", type=int, default=10, help="备选点数（默认 10）")
    ap.add_argument("--out-html", type=Path, default=DEF_HTML, help="叠加核对图输出路径")
    ap.add_argument("--out-csv", type=Path, default=DEF_CSV, help="回填模板 CSV 输出路径")
    ap.add_argument("--out-md", type=Path, default=DEF_MD, help="候选点清单 Markdown 输出路径")
    ap.add_argument("--force", action="store_true",
                    help="CSV 中已人工回填、但与本次选点对不上的行：确认丢弃并覆盖（默认报错停下以防丢失）")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")       # Windows 控制台也能输出中文
    if args.n < 1 or args.backup < 0:
        raise SystemExit("--n 须 ≥1、--backup 须 ≥0")

    _lines_data, lines = load_lines(args.lines)
    _st_data, stops, unbound = load_stations(args.stations)
    if not stops:
        raise SystemExit("站圆预置里没有已绑定落站，无法选点")
    trans = None
    if not args.no_trans and args.layers.exists():
        trans = load_trans_centers(args.layers) or None
    cands, ctx = build_candidates(lines, stops, unbound, trans)
    picked, bk, quotas, minima, why, bwhy = select_points(cands, ctx, args.n, args.backup)
    main_pts, bk_pts = assign_ids(picked, bk, why, bwhy)
    checks = self_check(main_pts, bk_pts, cands)
    ctx["trans"] = trans
    meta = {"lines_sha": sha256_of(args.lines), "stations_sha": sha256_of(args.stations),
            "layers_sha": sha256_of(args.layers) if trans else None, "n_paths": len(lines)}

    # ---- CSV 回填模板（保护已人工回填的 lon/lat）----
    rows = [csv_row(c) for c in main_pts + bk_pts]
    existing = None
    if args.out_csv.exists():
        try:
            existing = args.out_csv.read_text(encoding="utf-8-sig")
        except (UnicodeDecodeError, ValueError):
            if not args.force:
                raise SystemExit("现有 %s 不是 UTF-8 文本（可能被 Excel 另存过）。为防冲掉人工回填未覆盖；确认请加 --force。"
                                 % args.out_csv)
    carried, orphans = carry_manual_csv(existing, rows) if existing is not None else (0, [])
    if orphans and not args.force:
        raise SystemExit("%s 中已人工回填、但与本次选点对不上的行：%s。为防丢失未覆盖；"
                         "确认丢弃请加 --force，或先用 --out-csv 另存一份。" % (args.out_csv, "、".join(orphans)))
    wrote = [("CSV", args.out_csv, write_text(args.out_csv, render_csv(rows)))]

    # ---- 叠加图与清单 ----
    wrote.append(("叠加图", args.out_html, write_text(args.out_html, build_html(main_pts, bk_pts, cands, ctx, lines, meta, args))))
    wrote.append(("清单", args.out_md, write_text(args.out_md, build_md(main_pts, bk_pts, cands, ctx, lines, args, meta, checks))))

    # ---- 控制台报告 ----
    cx, cy, cuts = ctx["cx"], ctx["cy"], ctx["cuts"]
    print("线路 path %d 条；已绑定落站 %d、未绑定组圆 %d；换乘：共点圆 %d 对%s"
          % (len(lines), len(cands), len(unbound), ctx["n_coincide_pairs"],
             ("、Trans 层换乘符号命中 %d 站" % ctx["n_trans_hits"]) if trans else "（未用 Trans 层旁证）"))
    print("地图中心 (%.1f, %.1f)；圈层分位半径 p50/p75/p90 = %.0f / %.0f / %.0f pt"
          % (cx, cy, cuts[0], cuts[1], cuts[2]))
    print("圈层配额 %s；方位下限 %s"
          % (" / ".join("%s %d" % (RING_CN[i], quotas[i]) for i in range(4)),
             " ".join("%s%d" % (b, minima[b]) for b in BEARINGS)))
    for title, pts in (("主选 %d 点" % len(main_pts), main_pts), ("备选 %d 点" % len(bk_pts), bk_pts)):
        print("\n== %s ==" % title)
        for c in pts:
            print("  %-3s %-4s %-2s %-14s %-10s (%8.1f,%9.1f) t=%.6f 共点线 %-16s %s"
                  % (c["id"], RING_CN[c["ring"]], c["sector"], c["line"], c["name"] or "（无）", c["x"], c["y"],
                     c["t"], "/".join(xfer_lines(c)) or "—", c["why"]))
    print("\n自检：" + "；".join(checks))
    for name, path, changed in wrote:
        print("%s：%s（%s）" % (name, path, "已写入" if changed else "内容未变，幂等"))
    if carried:
        print("已保留 %d 行人工回填的 lon/lat" % carried)
    if orphans:
        print("注意：按 --force 丢弃了 %d 行无法对上的人工回填：%s" % (len(orphans), "、".join(orphans)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
