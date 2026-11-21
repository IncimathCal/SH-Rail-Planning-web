# -*- coding: utf-8 -*-
"""ai_parse.py — 从 Illustrator 源文件提取 Line 图层线路 path（几何走 PDF 兼容层，
命名与可见性走原生私有数据，2026-11-21 二轮重构）。

坐标基准：.ai 页面（本图 12000×12000）、SVG 朝向（y 向下）。线路 path、颜色
（CMYK→RGB 近似）、虚实样式一次全量导出为 fmt/import@1 兼容记录；paths[] 增补
非破坏性可选字段 dash / cmyk / width / category / hintNames。

sourceLayer 语义（原生权威化，讨论记录-04 用户裁定）：
- 无支线的线 = 命名的路径对象 → **路径对象名**（用户自己的命名，非杜撰）；
- 有支线的线（示范区线/机场联络线/南汇线/11/10）= 子图层 → **层链**（如 市域线/示范区线）；
- 预控通道/他省/联络线内命名对象 → 对象名（通道名等）；
- 拿不到真实名（作者未命名的描边）→ 保持中性提取序号 path-NN，绝不造名；
- 层内多条 path 同名时附 #k 序号后缀（编辑器按 sourceLayer 寻址建线，须可区分）。

category 可选枚举：预控通道层 → "reserved"；他省层 → "interprovincial"。
闭合（原生 h/s）→ d 尾追加 Z（环线识别 /z/i 测试用）；字节级相同的重复描边去重。
hintNames 为站圆组证据名（原生 Station 子层圆心 ≥60% 距线 <25pt 且 ≥3 圆），
仅「建议」展示、人工点选采用，绝不自动写入正式名称（铁律）。
可见性：隐藏层（Lb 位1=0）不进 PDF 兼容层，本工具天然不提取；原生侧如实报告。

用法：
  python -X utf8 tools/ai_parse.py "源资产/远期.ai" --out "import/远期图-全量.json"
      [--native-cache "零散/ai_native_tail.bin"]               # 原生矢量尾部缓存
      [--verify "源资产/6、14、15、23号线.svg"]               # 与既有 SVG 导出对拍
      [--calib "6,14,15,23" --svg-out "源资产/远期图-标定4线.svg"]
                                                              # 生成 georf 用标定 SVG（新基准）

依赖 PyMuPDF（fitz）+ zstandard（仅缓存缺失重提取时）；.ai 只读。输出 UTF-8 无 BOM。
"""
import argparse
import collections
import datetime
import json
import os
import re
import sys

import fitz

CLEAR = set(('m l c v y h re S s f F f* B B* b b* n RG rg SC SCN sc scn k K g G d w '
             'q Q cm gs cs CS W W* ri i j J M BT ET Tj TJ Tf TD Td Tm Tc Tw Tz Ts '
             'Do sh MP DP BMC BDC EMC BI ID EI').split())
PAINTS = ('S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n')


# ---------------------------------------------------------------- 图层分段

def layer_sections(doc, page):
    """主内容流按 /OC BDC 分段 → ([(层名, start, end)], 原始流字节)。"""
    _, v = doc.xref_get_key(page.xref, 'Resources')
    pres = {}
    for nm, xr in re.findall(r'/([\w-]+)\s+(\d+) 0 R',
                             re.search(r'/Properties\s*<<(.*?)>>', v, re.S).group(1)):
        _, v2 = doc.xref_get_key(int(xr), 'Name')
        pres[nm] = v2.strip('()')
    _, cv = doc.xref_get_key(page.xref, 'Contents')
    cx = [int(m) for m in re.findall(r'(\d+) 0 R', cv)] or [int(cv.split()[0])]
    raw = b''.join(doc.xref_stream(x) for x in cx)
    cl = re.sub(rb'\((?:[^()\\]|\\.)*\)', b'()', raw)
    ev = []
    for m in re.finditer(rb'/OC\s+(?:/([\w-]+)|<<[^>]*?/Name\s*\(([^)]*)\)>>)\s+BDC'
                         rb'|(?:^|\s)(EMC)(?=$|\s)', cl, re.M):
        if m.group(3):
            ev.append((m.start(), None))
        else:
            nm = (m.group(1) or b'').decode() or m.group(2).decode()
            ev.append((m.start(), pres.get(nm, nm)))
    secs = []
    stack = []
    prev = 0
    for pos, nm in sorted(ev):
        if pos > prev and stack:
            secs.append(('/'.join(stack), prev, pos))
        if nm is None:
            if stack:
                stack.pop()
        else:
            stack.append(nm)
        prev = pos
    if prev < len(raw) and stack:
        secs.append(('/'.join(stack), prev, len(raw)))
    return secs, raw


# ---------------------------------------------------------------- 路径采集

def parse_paths(data):
    """带 q/Q/cm 变换栈的路径采集（变换在 flush 时快照，路径中途不会换 cm）。
    返回 [dict(segs, ctm, stroke, dash, width, paint)]，segs 为 PDF 用户空间绝对坐标。"""
    cl = re.sub(rb'\((?:[^()\\]|\\.)*\)', b'()', data)
    cl = re.sub(rb'<[0-9A-Fa-f\s]*>', b'<>', cl)
    toks = re.findall(rb'/[\w#.-]+|-?\d*\.?\d+|[A-Za-z]{1,2}\*?', cl)
    ctm = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    stack = []
    stroke = None
    dash = None
    width = None
    segs = None
    cur = None
    paths = []
    nums = []

    def flush(paint):
        nonlocal segs
        if segs and paint != 'n':
            paths.append(dict(segs=segs, ctm=ctm, stroke=stroke,
                              dash=dash, width=width, paint=paint))
        segs = None

    for tk in toks:
        try:
            nums.append(float(tk))
            continue
        except ValueError:
            pass
        op = tk.decode(errors='replace')
        if op.startswith('/'):
            nums = []
            continue
        if op == 'q':
            stack.append(ctm)
        elif op == 'Q':
            if stack:
                ctm = stack.pop()
        elif op == 'cm' and len(nums) >= 6:
            a, b, c, d, e, f = nums[-6:]
            A, B, C, D, E, F = ctm
            ctm = (a * A + c * B, b * A + d * B,
                   a * C + c * D, b * C + d * D,
                   a * E + c * F + e, b * E + d * F + f)
        elif op == 'm':
            if segs is None:
                segs = []
            segs.append(('M', [nums[-2], nums[-1]]))
            cur = (nums[-2], nums[-1])
        elif op == 'l' and segs is not None:
            segs.append(('L', [nums[-2], nums[-1]]))
            cur = (nums[-2], nums[-1])
        elif op == 'c' and segs is not None:
            segs.append(('C', nums[-6:]))
            cur = (nums[-2], nums[-1])
        elif op == 'v' and segs is not None and cur is not None:
            x2, y2, x3, y3 = nums[-4:]
            segs.append(('C', [cur[0], cur[1], x2, y2, x3, y3]))
            cur = (x3, y3)
        elif op == 'y' and segs is not None:
            x1, y1, x3, y3 = nums[-4:]
            segs.append(('C', [x1, y1, x3, y3, x3, y3]))
            cur = (x3, y3)
        elif op == 'h' and segs is not None:
            segs.append(('Z', []))
        elif op == 're':
            if segs is not None:
                flush('n')
            x, y, w, h = nums[-4:]
            segs = [('M', [x, y]), ('L', [x + w, y]), ('L', [x + w, y + h]),
                    ('L', [x, y + h]), ('Z', [])]
            cur = (x, y)
        elif op in PAINTS:
            flush(op)
        elif op in ('SCN', 'SC', 'RG') and nums:
            stroke = tuple(round(x, 4) for x in nums[-4:])
        elif op == 'd':
            dash = None if len(nums) <= 1 else tuple(round(x, 1) for x in nums[:-1])
        elif op == 'w' and nums:
            width = nums[-1]
        if op in CLEAR:
            nums = []
    flush('n')
    return paths


def stroke_hex(comps):
    """CMYK/灰 → RGB 十六进制（无 ICC 的朴素换算，作建议色）。"""
    if comps is None:
        return '#888888'
    if len(comps) >= 4:
        c, m, y, k = comps[:4]
    elif len(comps) == 1:
        c = m = y = 0.0
        k = comps[0]
    else:
        return '#888888'
    r = round(255 * (1 - min(1, c + k)))
    g = round(255 * (1 - min(1, m + k)))
    b = round(255 * (1 - min(1, y + k)))
    return '#%02X%02X%02X' % (r, g, b)


def fitz_color_fix(page, paths):
    """朴素 CMYK→RGB 与 ICC 实际转换差距大：按 rect 就近从 get_drawings 借
    MuPDF 色彩管理转换后的描边色（与 AI 的 SVG 导出一致）。"""
    ds = [d for d in page.get_drawings() if d.get('color')]
    for p in paths:
        b = p['bbox']
        best, bd = None, 30.0
        for d in ds:
            r = d['rect']
            dd = abs(r.x0 - b[0]) + abs(r.y0 - b[1]) + abs(r.x1 - b[2]) + abs(r.y1 - b[3])
            if dd < bd:
                bd, best = dd, d
        if best is not None:
            p['color'] = '#%02X%02X%02X' % tuple(min(255, round(x * 255)) for x in best['color'])


def svg_xy(ctm, x, y, H):
    a, b, c, d, e, f = ctm
    return a * x + c * y + e, H - (b * x + d * y + f)   # PDF 左下原点 → SVG 左上


def emit(p, H):
    """→ dict(d, bbox, endpoints, color, ...)；d 为绝对大写算子、逗号坐标。"""
    ctm = p['ctm']
    ds = []
    pts_all = []
    for op, vals in p['segs']:
        if op == 'Z':
            ds.append('Z')
            continue
        cs = []
        for i in range(0, len(vals), 2):
            sx, sy = svg_xy(ctm, vals[i], vals[i + 1], H)
            cs.append('%.2f,%.2f' % (sx, sy))
            pts_all.append((sx, sy))
        ds.append(op + ','.join(cs))
    xs = [q[0] for q in pts_all]
    ys = [q[1] for q in pts_all]
    return dict(d=''.join(ds), bbox=(min(xs), min(ys), max(xs), max(ys)),
                endpoints=(pts_all[0], pts_all[-1]),
                color=stroke_hex(p['stroke']), cmyk=p['stroke'],
                dash=list(p['dash']) if p['dash'] else None, width=p['width'])


# ---------------------------------------------------------------- 原生对拍与命名

def d_points(d):
    """绝对大写 d 串（emit 产物）→ 坐标点列表（含贝塞尔控制点）。"""
    pts = []
    for m in re.finditer(r'([MLC])([^MLCZ]*)', d):
        nums = [float(x) for x in re.findall(r'-?\d+\.?\d*', m.group(2))]
        for i in range(0, len(nums) - 1, 2):
            pts.append((nums[i], nums[i + 1]))
    return pts


def stroke_grid(ops):
    """原生 stroke 坐标点 → 0.1 网格索引 {(gx,gy): [(x,y)...]}，供容差点匹配。"""
    g = collections.defaultdict(list)
    for _op, w in ops:
        for i in range(0, len(w) - 1, 2):
            g[(round(w[i] * 10), round(w[i + 1] * 10))].append((w[i], w[i + 1]))
    return g


def grid_hit(grid, pt, tol=0.05):
    """点是否落在网格容差内（PDF %.2f 与原生全精度差 ≤0.005）。"""
    gx, gy = round(pt[0] * 10), round(pt[1] * 10)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for q in grid.get((gx + dx, gy + dy), ()):
                if abs(q[0] - pt[0]) <= tol and abs(q[1] - pt[1]) <= tol:
                    return True
    return False


def match_native(paths, nat, log=print):
    """PDF 侧 path（emit 后）↔ 原生描边（ai_native.Stroke，仅 Line 子树可见描边）
    点集对拍。返回 matches {pdf_idx: (stroke, mode)}，mode ∈ exact / partial。
    exact = 双向 ≥98% 点重合（同一对象）；partial = PDF 条 ⊆ 原生复合对象（拆分）。"""
    grids = {id(st): stroke_grid(st.ops) for st in nat}
    matches = {}
    used_cnt = collections.Counter()
    for i, p in enumerate(paths):
        ppts = d_points(p['d'])
        if not ppts:
            continue
        pb = p['bbox']
        best, bkey = None, None
        for st in nat:
            if not (st.cmyk and p['cmyk'] and
                    all(abs(a - b) < 0.02 for a, b in zip(st.cmyk, p['cmyk']))):
                continue
            nb = st_bbox(st)
            if nb[0] > pb[0] + 80 or nb[1] > pb[1] + 80 or nb[2] < pb[2] - 80 or nb[3] < pb[3] - 80:
                continue                                   # 原生应 ⊇ PDF（复合可偏大）
            g = grids[id(st)]
            fwd = sum(1 for q in ppts if grid_hit(g, q)) / len(ppts)
            if fwd < 0.5:
                continue
            npts = [q for pts in g.values() for q in pts]
            # 反向：原生点距任一 PDF 点 <tol（PDF 点建 0.1 网格）
            pg = collections.defaultdict(list)
            for q in ppts:
                pg[(round(q[0] * 10), round(q[1] * 10))].append(q)
            back = sum(1 for q in npts if _hit_pts(pg, q)) / len(npts)
            # 平局（如 27 号线两份字节级相同的几何）优先未被占用的原生对象
            key = (round(fwd, 3), round(back, 3), -used_cnt[id(st)])
            if bkey is None or key > bkey:
                bkey, best = key, (st, fwd, back)
        if best is not None:
            st, fwd, back = best
            used_cnt[id(st)] += 1
            matches[i] = (st, 'exact' if (fwd >= 0.98 and back >= 0.98) else 'partial')
    log('对拍：%d/%d 条 PDF path 匹配到原生描边（exact %d / partial %d）'
        % (len(matches), len(paths),
           sum(1 for _, m in matches.values() if m == 'exact'),
           sum(1 for _, m in matches.values() if m == 'partial')))
    return matches


def _hit_pts(pg, q, tol=0.05):
    gx, gy = round(q[0] * 10), round(q[1] * 10)
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for t in pg.get((gx + dx, gy + dy), ()):
                if abs(t[0] - q[0]) <= tol and abs(t[1] - q[1]) <= tol:
                    return True
    return False


_STROKE_BBOX = {}


def st_bbox(st):
    if id(st) not in _STROKE_BBOX:
        xs, ys = [], []
        for _op, w in st.ops:
            for i in range(0, len(w) - 1, 2):
                xs.append(w[i]); ys.append(w[i + 1])
        _STROKE_BBOX[id(st)] = (min(xs), min(ys), max(xs), max(ys)) if xs else (0, 0, 0, 0)
    return _STROKE_BBOX[id(st)]


# 有支线的线（用户裁定）＝子图层：sourceLayer 用层链
BRANCH_LAYERS = {
    'Line/市域线/示范区线', 'Line/市域线/机场联络线', 'Line/市域线/南汇线',
    'Line/市区线/11', 'Line/市区线/10',
}


def source_layer_of(st):
    """原生 stroke → (sourceLayer 或 None（中性）, hint 对象名或 None, category 或 None)。"""
    layer = st.layer
    cat = 'reserved' if layer == 'Line/预控通道' else (
          'interprovincial' if layer == 'Line/他省' else None)
    if layer in BRANCH_LAYERS:
        return layer[len('Line/'):], (st.name if st.name else None), cat
    if st.name:
        return st.name, None, cat
    return None, None, cat


def station_circle_hints(nat, paths):
    """原生 Station 子层站圆组证据名：组内 ≥3 圆且 ≥60% 圆心距 path <25pt。
    距离基准 = d 全部控制点 + 弧长 25pt 密集采样（稀疏采样会漏长线中段）。
    返回 {pdf_idx: ['名(k/n)', ...]}（换乘标记子层 Trans/Line 除外）。"""
    from svg_parse import path_from_d
    groups = collections.defaultdict(list)
    for st in nat:
        parts = st.layer.split('/')
        if (len(parts) == 2 and parts[0] == 'Station' and st.paint in ('b', 'f', 'B')
                and parts[1] not in ('Trans', 'Line')):
            b = st_bbox(st)
            if b[2] - b[0] <= 40 and b[3] - b[1] <= 40:      # 站圆量级（非大复合）
                groups[parts[1]].append(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2))
    hints = collections.defaultdict(list)
    for i, p in enumerate(paths):
        pts = d_points(p['d'])
        try:
            ap = path_from_d(p['d'])
            k = max(8, int(ap.length // 25))
            pts = pts + [ap.point_at(t / k) for t in range(k + 1)]
        except Exception:
            pass
        for nm, centers in sorted(groups.items()):
            if len(centers) < 3:
                continue
            ok = sum(1 for (cx, cy) in centers
                     if min((cx - x) ** 2 + (cy - y) ** 2 for x, y in pts) < 25 ** 2)
            if ok >= max(3, int(len(centers) * 0.6)):
                hints[i].append('%s(%d/%d)' % (nm, ok, len(centers)))
    return hints


# ---------------------------------------------------------------- 旧 SVG 对拍

def d_bbox(d):
    """轻量 SVG path bbox（含控制点）；支持 M/L/C/H/V/S/Q/Z 及小写相对形式。"""
    toks = re.findall(r'[MLCQHVSZAmlcqhvsza]|-?\d*\.?\d+', d)
    x = y = sx = sy = 0.0
    lo = [float('inf')] * 2
    hi = [float('-inf')] * 2
    def acc(*pts):
        for i in range(0, len(pts), 2):
            lo[0] = min(lo[0], pts[i]); hi[0] = max(hi[0], pts[i])
            lo[1] = min(lo[1], pts[i+1]); hi[1] = max(hi[1], pts[i+1])
    cmd, nums = None, []
    def run(c, ns):
        nonlocal x, y, sx, sy
        rel = c.islower()
        C = c.upper()
        i = 0
        while i < len(ns):
            if C in 'ML':
                a, b = ns[i:i+2]; i += 2
                if rel: a += x; b += y
                if C == 'M': sx, sy = a, b
                x, y = a, b; acc(x, y)
            elif C == 'C':
                w = ns[i:i+6]; i += 6
                if rel: w = [v + (x if j % 2 == 0 else y) for j, v in enumerate(w)]
                acc(*w); x, y = w[4], w[5]
            elif C in 'Q':
                w = ns[i:i+4]; i += 4
                if rel: w = [v + (x if j % 2 == 0 else y) for j, v in enumerate(w)]
                acc(*w); x, y = w[2], w[3]
            elif C == 'S':
                w = ns[i:i+4]; i += 4
                if rel: w = [v + (x if j % 2 == 0 else y) for j, v in enumerate(w)]
                acc(*w); x, y = w[2], w[3]
            elif C == 'H':
                a = ns[i]; i += 1
                x = x + a if rel else a; acc(x, y)
            elif C == 'V':
                b = ns[i]; i += 1
                y = y + b if rel else b; acc(x, y)
            elif C == 'A':
                w = ns[i:i+7]; i += 7
                a, b = w[5], w[6]
                if rel: a += x; b += y
                x, y = a, b; acc(x, y)
            elif C == 'Z':
                x, y = sx, sy; acc(x, y)
                break
    for t in toks:
        if re.fullmatch(r'-?\d*\.?\d+', t):
            nums.append(float(t)); continue
        if cmd:
            run(cmd, nums)
        cmd, nums = t, []
    if cmd:
        run(cmd, nums)
    return (lo[0], lo[1], hi[0], hi[1])


def d_shift(d, tx, ty):
    """平移 SVG path 的绝对命令坐标（相对命令不动）→ 新 d 串。
    旧导出混用 M/L 绝对与 l/c/h/v 相对，必须逐命令区分，只动大写命令的目标点。"""
    toks = re.findall(r'[MLCQHVSZATmlcqhvszat]|-?\d*\.?\d+', d)
    NARG = {'M': 2, 'L': 2, 'C': 6, 'S': 4, 'Q': 4, 'T': 2,
            'H': 1, 'V': 1, 'A': 7, 'Z': 0}
    out = []
    cmd = None
    nums = []

    def flush():
        nonlocal nums
        if cmd is None or not nums:
            return
        w = list(nums)
        if not cmd.islower() and w:
            C = cmd.upper()
            if C in 'MLCSQT':
                for i in range(0, len(w) - len(w) % 2, 2):
                    w[i] += tx
                    w[i + 1] += ty
            elif C == 'H':
                w = [x + tx for x in w]
            elif C == 'V':
                w = [y + ty for y in w]
            elif C == 'A':
                for i in range(5, len(w) - len(w) % 7, 7):
                    w[i] += tx
                    w[i + 1] += ty
        out.append(cmd + ','.join('%.2f' % x for x in w))
        nums = []          # 只清参数：SVG 允许隐式重复参数组（命令字母省略）

    for t in toks:
        if re.fullmatch(r'-?\d*\.?\d+', t):
            if cmd is None:
                continue
            nums.append(float(t))
            if len(nums) == NARG.get(cmd.upper(), -1):
                flush()      # 组满即出，隐式重复组继续以同命令累积
        else:
            flush()
            cmd = t
    flush()
    return ''.join(out)


def parse_old_svg(fn):
    """→ [(name, color, bbox)]；bbox 由 d_bbox 正确解析（含控制点）。"""
    s = open(fn, encoding='utf-8').read()
    cls = dict(re.findall(r'\.([\w-]+)\s*\{[^}]*stroke:\s*(#[0-9A-Fa-f]+)', s))
    out = []
    for m in re.finditer(r'<path[^>]*>', s):
        tag = m.group(0)
        name = (re.search(r'data-name="([^"]*)"', tag) or re.search(r'id="([^"]*)"', tag))
        name = name.group(1).lstrip('_') if name else '?'
        c = re.search(r'stroke:(#[0-9A-Fa-f]+)', tag) or re.search(r'stroke="(#[0-9A-Fa-f]+)"', tag)
        if not c:
            cn = re.search(r'class="([\w-]+)"', tag)
            c_hex = cls.get(cn.group(1)) if cn else None
        else:
            c_hex = c.group(1)
        dd = re.search(r' d="([^"]+)"', tag)
        out.append((name, c_hex, d_bbox(dd.group(1)) if dd else None))
    return out


def hex_dist(h1, h2):
    if not h1 or not h2:
        return 999
    a = [int(h1[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(h2[i:i + 2], 16) for i in (1, 3, 5)]
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** .5


# ---------------------------------------------------------------- 主流程

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('ai')
    ap.add_argument('--out', required=True)
    ap.add_argument('--verify')
    ap.add_argument('--calib')
    ap.add_argument('--svg-out')
    ap.add_argument('--native-cache', default='零散/ai_native_tail.bin',
                    help='原生矢量尾部缓存（缺失时自动从 .ai 重提取）')
    args = ap.parse_args()

    doc = fitz.open(args.ai)
    page = doc[0]
    H = page.rect.height
    W = page.rect.width
    secs, raw = layer_sections(doc, page)
    sec = next(((n, s, e) for n, s, e in secs if n.endswith('Line')), None)
    if not sec:
        sys.exit('未找到 Line 图层段')
    _, s0, e0 = sec
    parsed = [p for p in parse_paths(raw[s0:e0]) if p['paint'] in ('S', 's')]
    paths = [emit(p, H) for p in parsed]
    fitz_color_fix(page, paths)
    print('Line 图层：描边路径 %d 条（fill 装饰已剔除）' % len(paths))

    # ---- 原生权威化：命名 / 可见性 / 闭合 / 去重 / 站圆组建议 ----
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import ai_native
    buf = ai_native.ensure_tail(args.ai, args.native_cache)
    _layers, all_strokes = ai_native.parse_tail(buf)
    line_st = [s for s in all_strokes if s.layer.split('/')[0] == 'Line' and s.paint in ('S', 's')]
    nat = [s for s in line_st if s.layer_visible]
    hid = [s for s in line_st if not s.layer_visible]
    hid_names = collections.Counter(s.layer for s in hid)
    print('\n原生侧：Line 子树描边 %d 条（可见 %d / 隐藏 %d；隐藏层 %s）'
          % (len(line_st), len(nat), len(hid),
             '、'.join('%s×%d条' % (k, v) for k, v in sorted(hid_names.items()))))
    matches = match_native(paths, nat)

    # 字节级相同描边去重（保留先出现者）
    seen_d = {}
    dups = []
    keep_idx = []
    for i, p in enumerate(paths):
        if p['d'] in seen_d:
            dups.append((seen_d[p['d']], i))
        else:
            seen_d[p['d']] = i
            keep_idx.append(i)
    if dups:
        print('去重：%d 组字节级相同（%s）' % (len(dups), '；'.join(
            'path-%02d ≡ path-%02d' % (a + 1, b + 1) for a, b in dups)))

    hints = station_circle_hints(all_strokes, paths)
    print('站圆组建议：命中 %d 条 path（组证据名，仅为建议）' % len(hints))

    # 对拍：先精确锚定（宽高一致 → 位移），其余按「旧为子段」包含匹配
    trans = {}
    matched_groups = {}
    if args.verify:
        old = parse_old_svg(args.verify)
        groups = collections.defaultdict(list)
        for i, p in enumerate(paths):
            groups[p['color']].append(i)
        gbox = {}
        for col, idxs in groups.items():
            gb = [paths[i]['bbox'] for i in idxs]
            gbox[col] = (min(x[0] for x in gb), min(x[1] for x in gb),
                         max(x[2] for x in gb), max(x[3] for x in gb))
        print('\n=== 与既有 SVG 导出对拍 ===')
        exact = {}
        for name, c_hex, ob in old:
            if not ob:
                continue
            ow, oh = ob[2] - ob[0], ob[3] - ob[1]
            for col, b in gbox.items():
                if abs((b[2] - b[0]) - ow) < 5 and abs((b[3] - b[1]) - oh) < 5:
                    exact[name] = col
                    trans[name] = (b[0] - ob[0], b[1] - ob[1])
        if exact:
            tx = sorted(t[0] for t in trans.values())[len(trans) // 2]
            ty = sorted(t[1] for t in trans.values())[len(trans) // 2]
            print('  精确匹配 %d 条（%s），基准位移 (%.1f, %.1f)'
                  % (len(exact), ', '.join(exact), tx, ty))
        else:
            tx = ty = 0.0
        for name, c_hex, ob in old:
            if not ob:
                continue
            ow, oh = ob[2] - ob[0], ob[3] - ob[1]
            if name in exact:
                b = gbox[exact[name]]
                matched_groups[name] = groups[exact[name]]
                print('  %-4s [整线] %s → %s 宽高差 (0, 0) 位移 (%.1f, %.1f)'
                      % (name, c_hex, exact[name], b[0] - ob[0], b[1] - ob[1]))
                continue
            nb = (ob[0] + tx, ob[1] + ty, ob[2] + tx, ob[3] + ty)
            best, bscore = None, None
            for col, b in gbox.items():
                if b[0] <= nb[0] + 2 and b[1] <= nb[1] + 2 and b[2] >= nb[2] - 2 and b[3] >= nb[3] - 2:
                    score = (b[2] - b[0] - ow) + (b[3] - b[1] - oh)
                    if bscore is None or score < bscore:
                        bscore, best = score, col
            if best:
                matched_groups[name] = groups[best]
                b = gbox[best]
                print('  %-4s [子段] %s → %s 旧占全线的 %.0f%%×%.0f%%（远期延伸在 .ai 内）'
                      % (name, c_hex, best, ow / (b[2] - b[0]) * 100, oh / (b[3] - b[1]) * 100))
            else:
                print('  %-4s 未匹配（无包含平移后旧 bbox 的色组）' % name)
        if len(set((round(t[0]), round(t[1])) for t in trans.values())) <= 1 and trans:
            print('  → 位移一致，坐标基准对齐成立（等比 1:1，纯平移）')

    # 标定 SVG：用对拍锚定的位移平移 --verify 旧 path（几何与 KML 已配准；
    # .ai 全线含远期延伸段，直接用会破坏弧长参数对齐——georef 试验证实劣化一个量级）
    if args.calib and args.svg_out:
        if not args.verify or not trans:
            sys.exit('--svg-out 需同时给 --verify 且至少一条线精确匹配出位移')
        tx = sorted(t[0] for t in trans.values())[len(trans) // 2]
        ty = sorted(t[1] for t in trans.values())[len(trans) // 2]
        old_svg = open(args.verify, encoding='utf-8').read()
        want = set(k.strip() for k in args.calib.split(','))
        keep = []
        for m in re.finditer(r'<path[^>]*>', old_svg):
            tag = m.group(0)
            nm = (re.search(r'data-name="([^"]*)"', tag) or re.search(r'id="([^"]*)"', tag))
            nm = nm.group(1).lstrip('_') if nm else '?'
            if nm not in want:
                continue
            dd = re.search(r' d="([^"]+)"', tag)
            keep.append('<path data-name="%s号线" style="fill:none;stroke-width:12" d="%s"/>'
                        % (nm, d_shift(dd.group(1), tx, ty)))
        svg = ('<?xml version="1.0" encoding="UTF-8"?>\n'
               '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %.2f %.2f">\n%s\n</svg>\n'
               % (W, H, '\n'.join(keep)))
        open(args.svg_out, 'w', encoding='utf-8', newline='\n').write(svg)
        print('已生成标定 SVG（旧 path 平移 %.1f,%.1f 到 .ai 基准）：%s' % (tx, ty, args.svg_out))

    # 导出 import 记录（sourceLayer：对象名/层链优先，无名保持 path-NN；去重后仅保留组）
    rec = dict(schema='fmt/import@1', source='远期.ai',
               imported=datetime.date.today().isoformat(),
               note='ai_parse 原生权威化提取：坐标为 .ai 页面基准 %.0f×%.0f、SVG 朝向（几何自 PDF '
                    '兼容层，命名/可见性/闭合自原生私有数据对拍）。sourceLayer 为用户在源图的命名'
                    '（无支线线＝路径对象名，有支线线＝层链，同名多条附 #k）；作者未命名者保持中性'
                    'path-NN。category: reserved=预控通道 / interprovincial=他省。dash/cmyk/width/'
                    'hintNames 为非破坏性扩展字段（hintNames 为站圆组证据建议，需人工点选采用）' % (W, H),
               paths=[])
    entries = []
    for i in keep_idx:
        p = paths[i]
        st, mode = matches.get(i, (None, None))
        src, nhint, cat = source_layer_of(st) if st is not None else (None, None, None)
        if st is not None and st.closed and not p['d'].rstrip().endswith('Z'):
            p['d'] += 'Z'
            print('闭合补 Z：path-%02d（原生 h/s 闭合，%s）' % (i + 1, st.layer))
        entries.append(dict(i=i, src=src, nhint=nhint, cat=cat, st=st, mode=mode))
    # 同名多条 → #k 后缀（编辑器按 sourceLayer 寻址，须可区分；名字本身照抄用户命名）
    grp = collections.Counter(e['src'] for e in entries if e['src'])
    seq = collections.Counter()
    for e in entries:
        if e['src'] and grp[e['src']] > 1:
            seq[e['src']] += 1
            e['src'] = '%s#%d' % (e['src'], seq[e['src']])
        elif not e['src']:
            e['src'] = 'path-%02d' % (e['i'] + 1)
    for e in entries:
        p = paths[e['i']]
        hn = ([e['nhint']] if e['nhint'] and e['nhint'] not in e['src'] else []) \
            + hints.get(e['i'], [])
        row = dict(sourceLayer=e['src'], color=p['color'], path=p['d'],
                   dash=p['dash'], cmyk=p['cmyk'], width=p['width'])
        if e['cat']:
            row['category'] = e['cat']
        if hn:
            row['hintNames'] = hn
        rec['paths'].append(row)
    with open(args.out, 'w', encoding='utf8' if False else 'utf-8', newline='\n') as f:
        json.dump(rec, f, ensure_ascii=False, separators=(',', ':'))

    # 报告
    named_n = sum(1 for e in entries if e['src'] and not e['src'].startswith('path-'))
    branch_n = sum(1 for e in entries if e['st'] is not None and e['st'].layer in BRANCH_LAYERS)
    cat_res = sum(1 for e in entries if e['cat'] == 'reserved')
    cat_int = sum(1 for e in entries if e['cat'] == 'interprovincial')
    dashed = sum(1 for e in entries if paths[e['i']]['dash'])
    print('\n已导出 %s：%d 条 path（虚线 %d / 实线 %d）' % (args.out, len(entries), dashed, len(entries) - dashed))
    print('sourceLayer：用户命名 %d 条（其中层链 %d 条、对象名 %d 条）；中性 path-NN %d 条'
          % (named_n, branch_n, named_n - branch_n, len(entries) - named_n))
    print('category：reserved %d 条 / interprovincial %d 条；站圆组建议 %d 条；带 hintNames %d 条'
          % (cat_res, cat_int, len(hints), sum(1 for r in rec['paths'] if r.get('hintNames'))))
    print('颜色 %d 种' % len(set(p['color'] for p in paths)))

    # 交叉验证清单（用户自行裁定，不代裁）
    print('\n=== 交叉验证：命名/层归属 与 站圆组证据 不一致 ===')
    branch_tails = {l.split('/')[-1] for l in BRANCH_LAYERS}
    mism = 0
    for e in entries:
        if e['st'] is None:
            continue
        gnames = [h.split('(')[0] for h in hints.get(e['i'], [])]
        base = e['src'].split('#')[0]
        tail = e['st'].layer.split('/')[-1]
        obj_nm = e['st'].name
        prob = []
        # 站圆组与名字冲突（层链含组名 / 组名含层链尾段均算一致；中性条目无名字不算）
        segs = base.split('/')
        if (gnames and not base.startswith('path-')
                and not any(g in segs or g == base for g in gnames)):
            prob.append('站圆组 %s ≠ %s' % ('|'.join(gnames), base))
        # 分支层内对象名恰为另一分支层的名（如 南汇线层里的「机场联络线」）
        if e['st'].layer in BRANCH_LAYERS and obj_nm in branch_tails and obj_nm != tail:
            prob.append('对象名「%s」在层「%s」（另一分支层同名）' % (obj_nm, e['st'].layer))
        if prob:
            mism += 1
            print('  path-%02d → %s：%s' % (e['i'] + 1, e['src'] or '(中性)', '；'.join(prob)))
    if not mism:
        print('  （无）')
    print('共 %d 条，请用户裁定' % mism)
    # 原生侧未被 PDF 覆盖的可见描边（含被去重者）
    used = {id(e['st']) for e in entries if e['st'] is not None}
    orphan = [st for st in nat if id(st) not in used]
    if orphan:
        print('\n=== 原生可见描边未入导出：%d 条 ===' % len(orphan))
        for st in orphan:
            why = ('对象级隐藏（头标志 1 Xw，不进 PDF 兼容层）' if st.xw == '1'
                   else 'PDF 兼容层无对应（原因未明，几何未入图）' if st.name != '27'
                   else '与 path-50 字节级相同（去重保留一份）')
            print('  %s %s nseg=%d bbox=%s — %s' % (st.layer, st.name or '(无名)',
                  len(st.ops), tuple(round(v) for v in st_bbox(st)), why))


if __name__ == '__main__':
    main()
