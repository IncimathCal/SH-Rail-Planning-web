#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SVG path 解析 + 曲线压平 + 弧长参数化（阶段 0 工具，也供后续管线复用）。

功能：
    - 解析 Illustrator 导出的 SVG path 语法（M/L/H/V/C/S/Q/T/Z，含相对命令）
    - 贝塞尔曲线按平坦度容差自适应细分，无损压平为折线
    - 构建弧长表，提供 point_at(t)（t ∈ [0,1] 归一化弧长）查询

仅用 Python 标准库；控制台输出用英文（避免 Windows 控制台编码问题）。

用法：
    python tools/svg_parse.py <file.svg>      # 列出各 path 图层与统计
"""

import math
import re
import sys
import xml.etree.ElementTree as ET

FLAT_TOL = 0.05          # 压平容差（SVG 单位）：控制点离弦的最大距离
ARC_MIN_DEPTH = 3        # 每段曲线强制细分层数（2^3=8 段，保证弧长表平滑）
TOKEN_RE = re.compile(r"([MLHV CSTQAZmlhvcstqaz])|(-?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)")

SVG_NS = "{http://www.w3.org/2000/svg}"


# ---------- path 词法与状态机解析 ----------

class PathError(ValueError):
    pass


def _tokenize(d):
    """把 path 字符串拆成 (命令字母, [数字...]) 流。"""
    cmd = None
    nums = []
    for m in TOKEN_RE.finditer(d):
        c, num = m.group(1), m.group(2)
        if c:
            if cmd is not None:
                yield cmd, nums
            cmd, nums = c, []
        else:
            nums.append(float(num))
    if cmd is not None:
        yield cmd, nums


def _need(nums, k, i):
    if i + k > len(nums):
        raise PathError("unexpected end of numbers in path data")
    return nums[i:i + k]


def parse_path(d):
    """解析 path 字符串 → 顶点/贝塞尔段列表。

    返回 [(x0,y0,x1,y1,x2,y2,x3,y3), ...]：
    每项为一段三次贝塞尔（直线段表示为控制点在弦上的退化贝塞尔），
    段与段首尾相接。这是压平与弧长计算的统一中间格式。
    """
    cx = cy = 0.0          # 当前点
    sx = sy = 0.0          # 子路径起点（M 记录）
    px = py = None         # 上一段第二控制点（S/T 用）
    segs = []
    last_cmd = None

    def line_to(x, y):
        nonlocal cx, cy, px, py
        segs.append((cx, cy, cx, cy, x, y, x, y))
        cx, cy = x, y
        px = py = None

    for cmd, nums in _tokenize(d):
        if cmd in "Mm":
            if not nums:
                raise PathError("M without coordinates")
            x, y = _need(nums, 2, 0)
            cx, cy = (x, y) if cmd == "M" else (cx + x, cy + y)
            sx, sy = cx, cy
            px = py = None
            # SVG 规范：M 的后续坐标对按隐式 L/l 处理
            i = 2
            while i < len(nums):
                dx, dy = _need(nums, 2, i)
                nx, ny = (cx + dx, cy + dy) if cmd == "m" else (dx, dy)
                segs.append((cx, cy, cx, cy, nx, ny, nx, ny))
                cx, cy = nx, ny
                i += 2
            last_cmd = cmd
            continue
        i = 0
        # 逐参数组循环（同一命令可带多组坐标）
        n_args = {"L": 2, "l": 2, "H": 1, "h": 1, "V": 1, "v": 1,
                  "C": 6, "c": 6, "S": 4, "s": 4, "Q": 4, "q": 4,
                  "T": 2, "t": 2}.get(cmd, 0)
        if cmd in "Zz":
            if (cx, cy) != (sx, sy):
                line_to(sx, sy)
            cx, cy = sx, sy
            px = py = None
            last_cmd = cmd
            continue
        if cmd == "A" or cmd == "a":
            raise PathError("arc command A/a not supported (not produced by AI SVG export)")
        if n_args == 0:
            raise PathError(f"unsupported command: {cmd!r}")
        while i < len(nums):
            a = _need(nums, n_args, i)
            if cmd in "ML":
                line_to(a[0], a[1])
            elif cmd in "ml":
                line_to(cx + a[0], cy + a[1])
            elif cmd == "H":
                line_to(a[0], cy)
            elif cmd == "h":
                line_to(cx + a[0], cy)
            elif cmd == "V":
                line_to(cx, a[0])
            elif cmd == "v":
                line_to(cx, cy + a[0])
            elif cmd in "Cc":
                x1, y1, x2, y2, x, y = a
                if cmd == "c":
                    x1, y1, x2, y2, x, y = (cx + x1, cy + y1, cx + x2, cy + y2, cx + x, cy + y)
                segs.append((cx, cy, x1, y1, x2, y2, x, y))
                cx, cy, px, py = x, y, x2, y2
            elif cmd in "Ss":
                x2, y2, x, y = a
                if cmd == "s":
                    x2, y2, x, y = (cx + x2, cy + y2, cx + x, cy + y)
                # 上一段若非三次曲线，第一控制点取当前点
                rx, ry = (2 * cx - px, 2 * cy - py) if px is not None else (cx, cy)
                segs.append((cx, cy, rx, ry, x2, y2, x, y))
                cx, cy, px, py = x, y, x2, y2
            elif cmd in "Qq":
                x1, y1, x, y = a
                if cmd == "q":
                    x1, y1, x, y = (cx + x1, cy + y1, cx + x, cy + y)
                # 二次升三次：控制点 = 当前点 + 2/3*(q - p)
                segs.append((cx, cy,
                             cx + 2 / 3 * (x1 - cx), cy + 2 / 3 * (y1 - cy),
                             x + 2 / 3 * (x1 - x), y + 2 / 3 * (y1 - y),
                             x, y))
                cx, cy, px, py = x, y, x1, y1
            elif cmd in "Tt":
                x, y = a
                if cmd == "t":
                    x, y = cx + x, cy + y
                qx, qy = (2 * cx - px, 2 * cy - py) if px is not None else (cx, cy)
                segs.append((cx, cy,
                             cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy),
                             x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y),
                             x, y))
                cx, cy, px, py = x, y, qx, qy
            i += n_args
        last_cmd = cmd
    _ = last_cmd  # （保留字段，将来如需隐式重复命令可扩展）
    return segs


# ---------- 贝塞尔压平（de Casteljau 自适应细分） ----------

def _flat_enough(p0, p1, p2, p3, tol):
    """弦长法：三个控制点到两端点连线的距离均 < tol 即视为平坦。"""
    ax, ay = p3[0] - p0[0], p3[1] - p0[1]
    L = math.hypot(ax, ay)
    if L < 1e-12:
        # 端点重合：退化为一点不算平坦（可能是有面积的回环），细分处理
        return max(math.hypot(p1[0] - p0[0], p1[1] - p0[1]),
                   math.hypot(p2[0] - p0[0], p2[1] - p0[1])) < tol
    for p in (p1, p2):
        d = abs((p[0] - p0[0]) * ay - (p[1] - p0[1]) * ax) / L
        if d >= tol:
            return False
    return True


def flatten(segs, tol=FLAT_TOL):
    """贝塞尔段列表 → 压平折线 [(x,y), ...]（自适应细分）。"""
    if not segs:
        return []
    pts = [segs[0][0:2]]

    def sub(p0, p1, p2, p3, depth, min_depth):
        # min_depth：强制细分层数（保证弧长表平滑）；用尽后按平坦度/深度上限停止
        if min_depth <= 0 and (depth <= 0 or _flat_enough(p0, p1, p2, p3, tol)):
            pts.append(p3)
            return
        p01 = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
        p12 = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
        p23 = ((p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2)
        p012 = ((p01[0] + p12[0]) / 2, (p01[1] + p12[1]) / 2)
        p123 = ((p12[0] + p23[0]) / 2, (p12[1] + p23[1]) / 2)
        mid = ((p012[0] + p123[0]) / 2, (p012[1] + p123[1]) / 2)
        sub(p0, p01, p012, mid, depth - 1, min_depth - 1)
        sub(mid, p123, p23, p3, depth - 1, min_depth - 1)

    for seg in segs:
        p0, p1, p2, p3 = seg[0:2], seg[2:4], seg[4:6], seg[6:8]
        # 直线退化段（控制点在端点上）直接连线
        if (abs(p1[0] - p0[0]) < 1e-12 and abs(p1[1] - p0[1]) < 1e-12 and
                abs(p2[0] - p3[0]) < 1e-12 and abs(p2[1] - p3[1]) < 1e-12):
            pts.append(p3)
            continue
        sub(p0, p1, p2, p3, 24, ARC_MIN_DEPTH)  # 至少 2^3=8 段；平坦即止，最深 2^24 兜底
    return pts


# ---------- 弧长参数化 ----------

class ArcPath:
    """折线 + 归一化弧长表。t ∈ [0,1] → 沿线点（线性插值）。"""

    def __init__(self, pts):
        # 去除相邻重复点（如 h0 产生的零长段），保证弧长严格递增
        clean = []
        for p in pts:
            if not clean or math.hypot(p[0] - clean[-1][0], p[1] - clean[-1][1]) > 1e-9:
                clean.append(p)
        if len(clean) < 2:
            raise PathError("path has fewer than 2 distinct points")
        self.pts = clean
        self.cum = [0.0]
        for a, b in zip(clean, clean[1:]):
            self.cum.append(self.cum[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
        self.length = self.cum[-1]

    def point_at(self, t):
        """t ∈ [0,1]（归一化弧长）→ (x, y)。"""
        if not 0.0 <= t <= 1.0:
            raise ValueError(f"t out of [0,1]: {t}")
        s = t * self.length
        # 二分找 s 所在子区间
        lo, hi = 0, len(self.cum) - 1
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if self.cum[mid] <= s:
                lo = mid
            else:
                hi = mid
        a, b = self.pts[lo], self.pts[lo + 1]
        seg = self.cum[lo + 1] - self.cum[lo]
        f = 0.0 if seg < 1e-12 else (s - self.cum[lo]) / seg
        return (a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]))


def path_from_d(d):
    """path 字符串 → ArcPath（一步到位）。"""
    return ArcPath(flatten(parse_path(d)))


# ---------- SVG 文件读取 ----------

def load_svg_paths(svg_file):
    """读取 SVG 文件 → [(id, data_name, stroke_color, ArcPath), ...]。

    依赖 Illustrator 导出约定：每条线路一个 <path>，Object ID = 图层名，
    描边色在 <style> 类中定义（Presentation Attributes 导出格式）。
    """
    tree = ET.parse(svg_file)
    root = tree.getroot()
    styles = {}
    st = root.find(f".//{SVG_NS}style")
    if st is not None and st.text:
        for m in re.finditer(r"\.([\w-]+)\s*\{([^}]*)\}", st.text):
            c = re.search(r"stroke\s*:\s*(#[0-9A-Fa-f]{3,8})", m.group(2))
            if c:
                styles[m.group(1)] = c.group(1)
    out = []
    for p in root.iter(f"{SVG_NS}path"):
        d = p.get("d")
        if not d or not d.strip():
            continue
        name = p.get("data-name") or p.get("id") or ""
        name = name.lstrip("_")  # Illustrator 导出数字开头 id 会加下划线前缀
        cls = (p.get("class") or "").split()
        color = next((styles[c] for c in cls if c in styles), None)
        out.append((p.get("id") or "", name, color, path_from_d(d)))
    return out


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 1
    paths = load_svg_paths(sys.argv[1])
    print(f"SVG file: {sys.argv[1]}")
    print(f"{'name':<8} {'color':<9} {'vertices':>8} {'length':>12}   bbox (x0,y0)-(x1,y1)")
    for _, name, color, ap in paths:
        xs = [p[0] for p in ap.pts]
        ys = [p[1] for p in ap.pts]
        print(f"{name:<8} {str(color):<9} {len(ap.pts):>8} {ap.length:>12.1f}   "
              f"({min(xs):.0f},{min(ys):.0f})-({max(xs):.0f},{max(ys):.0f})")
    print("\nOK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
