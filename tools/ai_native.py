# -*- coding: utf-8 -*-
"""ai_native.py — 远期.ai 原生私有数据（AIPrivateData zstd 解压后的矢量流）解析：
图层树（含 Lb 可见性位）+ 全部绘制路径清单（对象名 / CMYK / 虚线 / 闭合 / 几何）。

职责边界：本模块只读原生侧（.ai 私有数据），不读 PDF 兼容层。几何为「AI 原生绝对
坐标、y 取反后的 SVG 系」（nat_y → svg_y = −nat_y，平移 0，40/40 bbox 票证验证），
与 import 记录的 .ai 页面基准（12000×12000、SVG 朝向）一致，可直接对拍。

关键实证（2026-11-21，W1）：
- 层头 `%AI5_BeginLayer` 后首行 `…14 个数字… Lb`：**第 1 位即可见性**（1=显示），
  第 7 位与之同步；隐藏层（通过不设站×3、相交关系×2、Station/临港1、Station/8B浦江线）
  均为 0，与 PDF catalog /OCProperties 的 5 个 OCG 全 ON（只覆盖顶层）互洽。
- 层名行 `(名) Ln`；层尾 `LB` + `%AI5_EndLayer--`（EndLayer 带 -- 尾缀，须 startswith 匹配）。
- **路径对象名**：绘制算子（S/s/N/…）之后紧跟的私有注释块
  `%_/ArtDictionary : %_/XMLUID : (对象名) ; (AI10_ArtUID) ,` ——括号内即用户命名；
  `_xHH_` 为两位十六进制转义（_x32_7 = "27"、_x38_B浦江线 = "8B浦江线"），
  尾部 `_＋≥20 位数字` 为 AI 生成的 UID 后缀（复制/粘贴痕迹），剥离后仍是用户名。
  图层自己的 UID 块在 `(名) Ln 0 AE` 之后、首个绘制之前，不会误绑到路径。
- 几何算子 m/l/c/v/y/h（绝对坐标；本文件实证存在大写 L/C/V/Y 行内变体，等价处理；
  大写 M 全部是 miter limit，不作 moveto）。**行内算子粘连存在**（如 `12 w6615.8 … m`），
  故用字符级 tokenizer；隐式重复参数组（一个 c 带 18 参数）按倍数展开。
- 描边色两种来源：`c m y k K`（DeviceCMYK）与 `c m y k (色板名) 0 0 XK`（色板引用）。
  旧 tree3 不认 XK，站圆颜色记录有污染——本模块两者皆取。

用法：
  python -X utf8 tools/ai_native.py "源资产/远期.ai" --cache "零散/ai_native_tail.bin" \
      [--json 零散/ai_native_strokes.json]

  --cache 指向矢量尾部缓存（105 MB）；文件存在则直接使用，缺失时自动从 .ai 重提取
  （依赖 PyMuPDF + zstandard，解压 7 GB 原生流约数分钟）。缓存起点锚定 `(Line) Ln`
  所在层头前 1 MB，为远期.ai 专用逻辑，换文件需复核。输出 UTF-8 无 BOM。
"""
import argparse
import json
import re
import sys

# ---------------------------------------------------------------------- 常量

GEOM_OPS = set('mlcvyhLCVY')            # 大写 M 不入：实证全部是 miter limit
PAINT_OPS = set(('S', 's', 'f', 'F', 'B', 'b', 'N', 'n'))
NUM_RE = re.compile(rb'[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?')
OP_RE = re.compile(rb'[A-Za-z][A-Za-z#*]{0,3}')

BEGIN_LAYER = b'%AI5_BeginLayer'
END_LAYER = b'%AI5_EndLayer'
XMLUID_PFX = b'%_/XMLUID :'


def decode_obj_name(raw):
    """XMLUID 原始名 → 用户可读名：_xHH_ 转义 → 剥 AI 生成 UID 尾巴。"""
    s = raw
    s = re.sub(r'_x([0-9A-Fa-f]{2})_', lambda m: chr(int(m.group(1), 16)), s)
    s = re.sub(r'_x([0-9A-Fa-f]{4})_', lambda m: chr(int(m.group(1), 16)), s)
    s = re.sub(r'_\d{20,}_?$', '', s)
    return s


# ---------------------------------------------------------------------- 尾部提取

def ensure_tail(ai_path, cache_path, log=print):
    """读矢量尾部缓存；缺失则从 .ai 解压重提取。返回字节串。"""
    import os
    if os.path.exists(cache_path):
        return open(cache_path, 'rb').read()
    import fitz
    import zstandard
    doc = fitz.open(ai_path)
    obj24 = doc.xref_object(24, compressed=True)
    order = sorted(re.findall(rb'/AIPrivateData(\d+)\s+(\d+) 0 R', obj24),
                   key=lambda t: int(t[0]))
    log('AIPrivateData 块 %d 个，开始解压…' % len(order))
    dobj = zstandard.ZstdDecompressor().decompressobj()
    native = bytearray()
    for idx, (n, xr) in enumerate(order):
        raw = doc.xref_stream(int(xr))
        if idx == 0:
            # zstd 魔数 28 B5 2F FD 的首字节 0x28 即 '('，不得连 %AI24_ZStandard_Data( 的括号一起剥
            m = re.match(rb'%AI24_ZStandard_Data', raw)
            if m:
                raw = raw[m.end():]
        native += dobj.decompress(bytes(raw))
        if idx % 5000 == 0:
            log('  …块 %d，%d 字节' % (idx, len(native)))
    buf = bytes(native)
    # 锚定矢量尾部：(Line) Ln 层头（BackGround 大图内容在其前 ~7 GB，不入缓存）
    p = buf.find(b'(Line) Ln')
    head = buf.rfind(BEGIN_LAYER, 0, p) if p >= 0 else buf.find(BEGIN_LAYER)
    start = max(0, head - (1 << 20))
    tail = buf[start:]
    open(cache_path, 'wb').write(tail)
    log('已写缓存 %s：%d 字节（自原生偏移 %d 起）' % (cache_path, len(tail), start))
    return tail


# ---------------------------------------------------------------------- 解析

class Stroke(object):
    __slots__ = ('layer', 'layer_visible', 'name', 'name_raw', 'paint', 'closed',
                 'cmyk', 'dash', 'width', 'ops', 'off', 'xw')

    def __init__(self):
        self.layer = ''
        self.layer_visible = True
        self.name = None
        self.name_raw = None
        self.paint = None
        self.closed = False
        self.cmyk = None
        self.dash = []
        self.width = None
        self.ops = []          # [(op, x0,y0,…)] 绝对坐标、SVG 系（y 已取反）
        self.off = 0
        self.xw = None         # 对象头 Xw 标志：1 = 对象级隐藏（不进 PDF 兼容层）


def _tokenize(line):
    """字符级切词：数字 / (字符串) / [数组边界] / /名字 / 算子。兼容行内粘连。"""
    toks = []
    i, n = 0, len(line)
    while i < n:
        c = line[i:i + 1]
        if c in b' \t\r':
            i += 1
            continue
        if c == b'(':
            j = i + 1
            while j < n:
                if line[j:j + 1] == b'\\':
                    j += 2
                    continue
                if line[j:j + 1] == b')':
                    break
                j += 1
            toks.append(('str', line[i + 1:j]))
            i = j + 1
            continue
        if c == b'[':
            toks.append(('arr_open', None))
            i += 1
            continue
        if c == b']':
            toks.append(('arr_close', None))
            i += 1
            continue
        if c == b'/' or c == b'%':
            j = i + 1
            while j < n and line[j:j + 1] not in b' \t\r':
                j += 1
            toks.append(('name', line[i:j]))
            i = j
            continue
        m = NUM_RE.match(line, i)
        if m:
            toks.append(('num', float(m.group(0))))
            i = m.end()
            continue
        m = OP_RE.match(line, i)
        if m:
            toks.append(('op', m.group(0).decode()))
            i = m.end()
            continue
        i += 1                                          # 其余符号（; , 等）忽略
    return toks


def parse_tail(buf, log=None):
    """解析矢量尾部 → (层树, Stroke 列表)。"""
    layers = []                                          # 树根
    stk = []                                             # 层栈 [{name,visible,lb,children,paths}]
    cmyk = None
    dash = []
    width = None
    cur = None                                          # 当前几何累积
    xw = None                                           # 对象头 Xw 标志
    strokes = []
    await_name = None                                   # 刚 flush、等待 XMLUID 的 Stroke
    ops_out = []

    def new_cur():
        return {'ops': [], 'closed': False}

    def flush(paint, off):
        nonlocal cur, await_name, xw
        if cur is None:
            cur = new_cur()
        if cur['ops']:
            st = Stroke()
            st.layer = '/'.join(nd['name'] for nd in stk)
            st.layer_visible = all(nd['visible'] for nd in stk)
            st.paint = paint
            st.closed = cur['closed'] or paint == 's'
            st.cmyk = cmyk
            st.dash = list(dash)
            st.width = width
            st.ops = cur['ops']
            st.off = off
            st.xw = xw
            strokes.append(st)
            ops_out.append(st)
            await_name = st
        cur = None
        xw = None                # 对象级标志随对象消费，不向后续对象泄漏

    def geom_run(op, nums):
        """几何算子：隐式重复参数组按倍数展开；y 取反入 SVG 系。"""
        nonlocal cur
        if cur is None:
            cur = new_cur()
        k = {'m': 2, 'l': 2, 'c': 6, 'v': 4, 'y': 4}.get(op)
        if k is None or not nums:                       # h
            cur['closed'] = True
            return
        for i in range(0, len(nums) - len(nums) % k, k):
            w = nums[i:i + k]
            if op == 'm':
                cur['ops'].append(('M', [w[0], -w[1]]))
            elif op == 'l':
                cur['ops'].append(('L', [w[0], -w[1]]))
            elif op == 'c':
                cur['ops'].append(('C', [w[0], -w[1], w[2], -w[3], w[4], -w[5]]))
            elif op == 'v':
                # v：起始控制=当前点（对拍容差可吸收，几何权威在 PDF 侧）
                p = cur['ops'][-1] if cur['ops'] else ('M', [0.0, 0.0])
                cx, cy = p[1][-2], p[1][-1]
                cur['ops'].append(('C', [cx, cy, w[0], -w[1], w[2], -w[3]]))
            elif op == 'y':
                cur['ops'].append(('C', [w[0], -w[1], w[2], -w[3], w[2], -w[3]]))

    def run_line(toks, off):
        """执行一行 token 流。"""
        nonlocal cmyk, dash, width, await_name, cur, xw
        stack = []                                      # 本行 operand（跨行不留：AI 逐行自洽）
        arr = None
        for kind, val in toks:
            if kind == 'num':
                if arr is not None:
                    arr.append(val)
                else:
                    stack.append(val)
                continue
            if kind == 'str':
                stack.append(('str', val))
                continue
            if kind == 'arr_open':
                arr = []
                continue
            if kind == 'arr_close':
                stack.append(('arr', arr or []))
                arr = None
                continue
            if kind == 'name':
                stack = []                              # /名字 打断操作数
                continue
            op = val
            nums = [x for x in stack if not isinstance(x, tuple)]
            if op in GEOM_OPS:
                await_name = None
                geom_run(op.lower(), nums)
            elif op in PAINT_OPS:
                flush(op, off)
            elif op == 'K' and len(nums) >= 4:
                cmyk = tuple(round(v, 4) for v in nums[-4:])
            elif op == 'XK' and len(nums) >= 4:
                cmyk = tuple(round(v, 4) for v in nums[:4])   # 色板引用：前 4 数即 CMYK
            elif op == 'd':
                for x in reversed(stack):
                    if isinstance(x, tuple) and x[0] == 'arr':
                        nz = [v for v in x[1] if v != 0]
                        dash = nz[-2:] if nz else []
                        break
            elif op == 'w' and nums:
                width = nums[-1]
            elif op == 'Xw' and nums:
                xw = str(int(nums[-1])) if nums[-1] in (0.0, 1.0) else None
            stack = []

    lines = buf.split(b'\n')
    for off_base, raw in enumerate(lines):
        s = raw.strip(b'\r \t')
        if not s:
            continue
        off = off_base                                  # 行号即可定位（报告用）
        if s[:1] == b'%':
            if s.startswith(BEGIN_LAYER):
                node = {'name': '?', 'visible': True, 'lb': None, 'children': [], 'n_paths': 0}
                (stk[-1]['children'] if stk else layers).append(node)
                stk.append(node)
            elif s.startswith(END_LAYER):
                if stk:
                    stk.pop()
            elif s.startswith(XMLUID_PFX):
                if await_name is not None:
                    body = s[len(XMLUID_PFX):]
                    p0 = body.find(b'(')
                    p1 = body.find(b')', p0 + 1) if p0 >= 0 else -1
                    if 0 <= p0 < p1:
                        raw_nm = body[p0 + 1:p1].decode('utf-8', 'replace')
                        await_name.name_raw = raw_nm
                        await_name.name = decode_obj_name(raw_nm)
                        await_name = None
            elif s.startswith(b'%_'):
                body = s[3:].strip()
                if not body:
                    continue
                t = body.split()
                if t and (t[-1].decode(errors='replace') in GEOM_OPS or
                          t[-1].decode(errors='replace') in PAINT_OPS):
                    run_line(_tokenize(body), off)
            continue
        t = s.split()
        if not t:
            continue
        last = t[-1]
        # 层名行：(名) Ln
        if len(t) == 2 and last == b'Ln' and t[0][:1] == b'(':
            nm = t[0][1:-1].decode('utf-8', 'replace')
            if stk:
                stk[-1]['name'] = nm
            continue
        # 层标志行：… Lb（14 数，第 1 位可见性）
        if last == b'Lb':
            try:
                bits = [float(x) for x in t[:-1]]
            except ValueError:
                bits = []
            if stk and bits:
                stk[-1]['lb'] = bits
                stk[-1]['visible'] = (bits[0] == 1.0) if len(bits) >= 1 else True
            continue
        if last == b'LB' and len(t) == 1:
            continue                                    # 层尾标志
        # 普通行：字符级（兼容 `12 w6615.8 … m` 粘连）
        run_line(_tokenize(s), off)

    def attach(node, path):
        p = path + [node['name']]
        cnt = sum(1 for st in strokes if st.layer == '/'.join(p))
        node['n_paths'] = cnt
        for c in node['children']:
            attach(c, p)
    for r in layers:
        attach(r, [])
    return layers, strokes


def strokes_to_json(strokes):
    out = []
    for i, st in enumerate(strokes):
        xs, ys = [], []
        for op, w in st.ops:
            for j in range(0, len(w), 2):
                xs.append(w[j]); ys.append(w[j + 1])
        out.append(dict(
            id=i, layer=st.layer, visible=st.layer_visible,
            name=st.name, nameRaw=st.name_raw, paint=st.paint, closed=st.closed,
            cmyk=list(st.cmyk) if st.cmyk else None, dash=st.dash, width=st.width,
            xw=st.xw, line=st.off,
            bbox=[min(xs), min(ys), max(xs), max(ys)] if xs else None,
            ops=[[op] + [round(v, 4) for v in w] for op, w in st.ops]))
    return out


def main():
    ap = argparse.ArgumentParser(description='远期.ai 原生私有数据矢量解析（图层树+路径对象名+可见性）')
    ap.add_argument('ai', help='.ai 文件路径（缓存缺失时重提取用）')
    ap.add_argument('--cache', default='零散/ai_native_tail.bin', help='矢量尾部缓存路径')
    ap.add_argument('--json', help='结果 JSON 输出路径（缺省只打印统计）')
    args = ap.parse_args()

    buf = ensure_tail(args.ai, args.cache)
    layers, strokes = parse_tail(buf)

    vis_line = [s for s in strokes if s.layer.split('/')[0] == 'Line' and s.paint in ('S', 's')]
    hid_line = [s for s in vis_line if not s.layer_visible]
    named = sum(1 for s in vis_line if s.name)
    print('层树根 %d；绘制对象 %d 条；Line 子树描边 %d 条（其中隐藏层 %d 条），带对象名 %d 条'
          % (len(layers), len(strokes), len(vis_line), len(hid_line), named))

    def show(node, depth=0, pfx=''):
        p = (pfx + '/' + node['name']) if pfx else node['name']
        n = sum(1 for s in strokes if s.layer == p and s.paint in ('S', 's'))
        print('%s%s%s  [描边 %d]' % ('  ' * depth, node['name'],
              '' if node['visible'] else '（隐藏）', n))
        for c in node['children']:
            show(c, depth + 1, p)
    for r in layers:
        show(r, 0)

    if args.json:
        data = dict(layers=layers, strokes=strokes_to_json(strokes))
        with open(args.json, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(data, f, ensure_ascii=False)
        print('已写 %s' % args.json)


if __name__ == '__main__':
    main()
