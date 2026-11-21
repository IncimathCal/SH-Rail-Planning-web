# -*- coding: utf-8 -*-
"""ai_parse.py — 从 Illustrator 源文件（PDF 兼容层）批量提取 Line 图层线路 path。

坐标基准：.ai 页面（本图 12000×12000）、SVG 朝向（y 向下）。线路 path、颜色
（CMYK→RGB 近似）、虚实样式一次全量导出为 fmt/import@1 兼容记录；paths[] 增补
非破坏性可选字段 dash / cmyk / width / hintNames（72pt 线路名标签就近绑定，仅为
建议值，不自动应用——铁律不破）。

用法：
  python tools/ai_parse.py "源资产/远期.ai" --out "import/远期图-全量.json"
      [--verify "源资产/6、14、15、23号线.svg"]               # 与既有 SVG 导出对拍
      [--calib "6,14,15,23" --svg-out "源资产/远期图-标定4线.svg"]
                                                              # 生成 georf 用标定 SVG（新基准）

依赖 PyMuPDF（fitz）；.ai 只读。输出 UTF-8 无 BOM。
"""
import argparse
import collections
import datetime
import json
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


# ---------------------------------------------------------------- 线路名建议

def label_hints(page, eps, radius=600.0):
    """图上线路名标签（与站名同为 24pt，靠文本模式区分：X号线 / 以 线·通道·铁路 结尾 /
    含「往」）就近绑定 path 端点 → {idx: [名称...]}。图例带文本离线端点远，自然不绑。"""
    pat = re.compile(r'^\d+号线$|(线|通道|铁路)$|往')
    words = []
    seen = set()
    for w in page.get_text('words'):
        t = w[4].strip()
        if not t or not pat.search(t):
            continue
        key = (t, round(w[0]), round(w[1]))
        if key in seen:
            continue
        seen.add(key)
        words.append((t, (w[0] + w[2]) / 2, (w[1] + w[3]) / 2))
    hits = collections.defaultdict(list)
    for t, lx, ly in words:
        best = None
        bd = radius
        for i, ep in eps.items():
            for px, py in ep:
                d = ((px - lx) ** 2 + (py - ly) ** 2) ** .5
                if d < bd:
                    bd = d
                    best = i
        if best is not None and t not in hits[best]:
            hits[best].append(t)
    return hits, len(words)


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

    eps = {i: p['endpoints'] for i, p in enumerate(paths)}
    hints, nlab = label_hints(page, eps)
    print('72pt 级标签 %d 个；绑定到 %d 条路径' % (nlab, len(hints)))

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

    # 导出 import 记录
    rec = dict(schema='fmt/import@1', source='远期.ai',
               imported=datetime.date.today().isoformat(),
               note='ai_parse 提取：坐标为 .ai 页面基准 %.0f×%.0f、SVG 朝向；sourceLayer 为提取'
                    '序号（path-NN，不带语义）；dash/cmyk/width/hintNames 为非破坏性扩展字段'
                    '（hintNames 仅就近匹配的建议值，需人工确认）' % (W, H),
               paths=[])
    for i, p in enumerate(paths):
        # sourceLayer 一律中性提取序号（用户明令 2026-11-21：不得擅自起名）；
        # 自动绑定的线路名只进 hintNames，由编辑器以「建议」形式展示、人工点选采用
        rec['paths'].append(dict(sourceLayer='path-%02d' % (i + 1), color=p['color'], path=p['d'],
                                 dash=p['dash'], cmyk=p['cmyk'], width=p['width'],
                                 hintNames=hints.get(i, [])))
    with open(args.out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(rec, f, ensure_ascii=False, separators=(',', ':'))
    dashed = sum(1 for p in paths if p['dash'])
    named = sum(1 for i in range(len(paths)) if hints.get(i))
    print('\n已导出 %s：%d 条 path（虚线 %d / 实线 %d），带线路名建议 %d 条'
          % (args.out, len(paths), dashed, len(paths) - dashed, named))
    print('颜色 %d 种；建议名样例：%s' % (len(set(p['color'] for p in paths)),
          [(rec['paths'][i]['sourceLayer'], hints[i][:2]) for i in list(hints)[:6]]))


if __name__ == '__main__':
    main()
