# -*- coding: utf-8 -*-
"""ai_native.py — 远期.ai 原生私有数据（AIPrivateData zstd 解压后的矢量流）解析：
图层树（含 Lb 可见性位）+ 全部绘制对象清单（对象名 / CMYK / 虚线 / 闭合 / 几何）
+ 对象组（u…U）代表线体（普通描边线 / 渐变网格线体，如 4 号线、南汇线主线）。

职责边界：本模块只读原生侧（.ai 私有数据），不读 PDF 兼容层。几何为「AI 原生绝对
坐标、y 取反后的 SVG 系」（nat_y → svg_y = −nat_y，平移 0，40/40 bbox 票证验证），
与 import 记录的 .ai 页面基准（12000×12000、SVG 朝向）一致，可直接对拍。

关键实证（2026-11-21，W1）：
- 层头 `%AI5_BeginLayer` 后首行 `…14 个数字… Lb`：**第 1 位即可见性**（1=显示），
  第 7 位与之同步；隐藏层（通过不设站×3、相交关系×2、Station/临港1、Station/8B浦江线）
  均为 0，与 PDF catalog /OCProperties 的 5 个 OCG 全 ON（只覆盖顶层）互洽。
- 层名行 `(名) Ln`；层尾 `LB` + `%AI5_EndLayer--`（EndLayer 带 -- 尾缀，须 startswith 匹配）。
  **层头的 XMLUID 属于层**：必须在 BeginLayer / LB 处清「待名」状态，否则会泄漏绑到
  上一层的末路径（首版曾把「机场联络线」层名错绑到南汇线支线上）。
- 对象级隐藏：对象头 `1 Xw`（常态 `0 Xw` 或无）→ 不进 PDF 兼容层。
- **路径对象名**：绘制算子（S/s/N/…）之后紧跟的私有注释块
  `%_/ArtDictionary : %_/XMLUID : (对象名) ; (AI10_ArtUID) ,` ——括号内即用户命名；
  `_xHH_` 为两位十六进制转义（_x32_7 = "27"、_x38_B浦江线 = "8B浦江线"），
  尾部 `_＋≥20 位数字` 为 AI 生成的 UID 后缀（复制/粘贴痕迹），剥离后仍是用户名。
- **`%_` 前缀只有 2 字节**：`%_10109.43 … c` 是几何行、`%_N` 是绘制算子。切片必须用
  `[2:]`（首版误用 `[3:]` 吃掉行首字符：坐标首 digit 丢失、`%_N` 整行被跳过——
  2026-11-21 用户验收发现 4 号线缺失 / 南汇线主线漏导 / 多条线丢名的根因）。
- **对象组结构**（`基路径(N) → 0 Ae → u → 内容 → U`，组尾常带私有副本）：
      基路径 N（外轮廓/原路径）→ u → [S 描边 + f 端点装饰 | /Mesh X! 网格块 + W n 小裁剪]
      → U → %_/XMLUID(对象名) → %_ 私有副本（完整原始路径，%_ 前缀几何 + %_N）→ XMLUID
  对象名写在组级 XMLUID 与私有副本上；首版因 `%_N` 丢失，名字被错绑到同组的 f 端点
  装饰，于是「嘉闵线 / 22 / 沪崇线 / 沪乍线 / 苏州10·11·17 …」等真名整体丢失。
- **渐变网格线体**（gradient mesh，AI「沿描边应用渐变」的产物，同上结构但内容是网格块）：
  PDF 兼容层把它渲染为「带状轮廓 W n + 着色 /ShNN sh」，不是描边，只取 S/s 会整条漏掉。
  私有副本路径的全部控制点到带状轮廓距离恒为线宽之半（6.0pt）——它就是中心线；
  非私有基路径可能只是完整路径的子序列（4 号线仅西段），线体以私有副本为准。
  网格数据：`/Size [横向补丁数 纵向补丁数]`，每块 `/P [i j]` 含 4 个节点行 `[色… x y …]`；
  颜色分量与 /CS 色板列表**反序**对应（实证：(0.02,0.16,1) ↔ 3 号线色）。
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
MESH_BEGIN = b'/Mesh X!'

MESH_LINE_MIN_LEN = 40.0    # 网格/基路径折线长低于此值视为渐变装饰点，不作线体


def decode_obj_name(raw):
    """XMLUID 原始名 → 用户可读名：_xHH_ 转义 → 剥 AI 生成 UID 尾巴。"""
    s = raw
    s = re.sub(r'_x([0-9A-Fa-f]{2})_', lambda m: chr(int(m.group(1), 16)), s)
    s = re.sub(r'_x([0-9A-Fa-f]{4})_', lambda m: chr(int(m.group(1), 16)), s)
    s = re.sub(r'_\d{20,}_?$', '', s)
    return s


def ops_points(ops):
    """ops 的在曲线点（M/L 端点、C 的终点）→ [(x, y)]。"""
    out = []
    for op, w in ops:
        if op == 'C':
            out.append((w[4], w[5]))
        elif op in ('M', 'L'):
            out.append((w[0], w[1]))
    return out


def ops_bbox(ops):
    xs, ys = [], []
    for op, w in ops:
        for j in range(0, len(w) - 1, 2):
            xs.append(w[j])
            ys.append(w[j + 1])
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def ops_length(ops):
    """ops 在曲线折线长度（估）。"""
    pts = ops_points(ops)
    return polyline_length(pts)


def polyline_length(pts):
    return sum(((pts[i + 1][0] - pts[i][0]) ** 2 + (pts[i + 1][1] - pts[i][1]) ** 2) ** .5
               for i in range(len(pts) - 1))


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


# ---------------------------------------------------------------------- 数据结构

class Stroke(object):
    """一个绘制对象；kind='mesh' 时为渐变网格线体对象的代表。"""
    __slots__ = ('layer', 'layer_visible', 'name', 'name_raw', 'paint', 'closed',
                 'cmyk', 'dash', 'width', 'ops', 'off', 'xw',
                 'kind', 'private', 'based', 'synthetic', 'private_copy', 'in_group',
                 'mesh_len', 'mesh_colors', 'mesh_sizes', 'obj')

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
        self.off = 0           # 结束绘制算子所在行号
        self.xw = None         # 对象头 Xw 标志：'1' = 对象级隐藏（不进 PDF 兼容层）
        self.kind = 'stroke'   # stroke=描边 / fill=填充 / unpainted=N n / mesh=渐变网格线体
        self.private = False   # 几何全部来自 %_ 前缀行（私有副本）
        self.based = False     # 已被某组认作基路径
        self.synthetic = False  # 无基路径，由网格节点中心线合成
        self.private_copy = False   # 已并入私有副本（完整原始路径）
        self.in_group = False  # 是某对象组（u…U）的代表线体
        self.mesh_len = None
        self.mesh_colors = None
        self.mesh_sizes = None
        self.obj = None        # 私有副本所属的对象组（dict）

    @property
    def length(self):
        return ops_length(self.ops)

    def bbox(self):
        return ops_bbox(self.ops)


class MeshBlock(object):
    """`/Mesh X! … /End X!` 渐变网格块（Cartesian 型）。"""
    __slots__ = ('off', 'size', 'colorants', 'ncomp', 'order', 'blocks', 'cur')

    def __init__(self, off):
        self.off = off
        self.size = None            # (横向补丁数, 纵向补丁数)
        self.colorants = []         # /CS 色板（CMYK 四元组，按出现顺序）
        self.ncomp = None
        self.order = []
        self.blocks = {}            # (i, j) -> [(kind, color, x, y) × 4]
        self.cur = None

    def feed(self, body):
        """喂入一行（已剥 %_ 前缀）。"""
        if body.endswith(b'/Size X#'):
            m = re.match(rb'\[(\d+) (\d+)\]', body)
            if m:
                self.size = (int(m.group(1)), int(m.group(2)))
            return
        if body.endswith(b'/P X#'):
            m = re.match(rb'\[(\d+) (\d+)\]', body)
            self.cur = (int(m.group(1)), int(m.group(2))) if m else None
            if self.cur is not None and self.cur not in self.blocks:
                self.order.append(self.cur)
                self.blocks[self.cur] = []
            return
        if b'/DeviceCMYK' in body and b'/Separation' in body:
            m = re.match(rb'\[\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+/DeviceCMYK', body)
            if m:
                try:
                    self.colorants.append(tuple(float(m.group(k)) for k in range(1, 5)))
                except ValueError:
                    pass
            return
        if body.endswith(b'/CS X#'):
            m = re.search(rb'(\d+)\s+/NChannel', body)
            if m:
                self.ncomp = int(m.group(1))
            return
        if body.endswith(b'/R X#') or body.endswith(b'/E X#') or not body.startswith(b'['):
            return
        vals = [float(x) for x in NUM_RE.findall(body)]
        if self.cur is None or len(vals) < 3:
            return
        is_s = body.endswith(b'/S X#')
        if is_s:
            color, x, y = None, vals[0], vals[1]
        else:
            n = self.ncomp or 3
            if len(vals) < n + 3:
                return
            color, x, y = tuple(vals[:n]), vals[n + 1], vals[n + 2]
        self.blocks[self.cur].append(('S' if is_s else 'C', color, x, -y))

    def centerline(self):
        """网格节点中心线：纵向每个补丁取横向中间节点 → ([(x, y)…], [color…])。"""
        if not self.size or not self.blocks:
            return [], []
        across, along = self.size
        mid = across // 2
        pts, cols = [], []
        for j in range(along):
            blk = self.blocks.get((mid, j))
            if blk:
                pts.append((blk[0][2], blk[0][3]))
                cols.append(blk[0][1])
        blk = self.blocks.get((mid, along - 1))
        if blk and len(blk) >= 3:
            pts.append((blk[2][2], blk[2][3]))
            cols.append(blk[2][1])
        return pts, cols

    def node_bbox(self):
        pts = [(n[2], n[3]) for b in self.blocks.values() for n in b]
        return (min(p[0] for p in pts), min(p[1] for p in pts),
                max(p[0] for p in pts), max(p[1] for p in pts)) if pts else None

    def cmyk(self, comp):
        """颜色分量 → CMYK：与 /CS 色板列表反序对应（实证 (0.02,0.16,1) ↔ 3 号线色）。"""
        if not comp:
            return None
        cs = self.colorants
        if len(cs) >= len(comp):
            out = [0.0] * 4
            for k, v in enumerate(comp):
                c = cs[len(cs) - 1 - k]
                for t in range(min(4, len(c))):
                    out[t] += v * c[t]
            return tuple(round(min(1.0, max(0.0, v)), 4) for v in out)
        vals = list(comp) + [0.0] * (4 - len(comp))
        return tuple(round(v, 4) for v in vals[:4])

    def band_width(self):
        """带子宽度：中间纵向上首末横向节点距离（无数据时 None）。"""
        if not self.size or not self.blocks:
            return None
        across, along = self.size
        j = along // 2
        a = self.blocks.get((0, j))
        b = self.blocks.get((across - 1, j))
        if a and b:
            p, q = (a[0][2], a[0][3]), (b[1][2], b[1][3])
            return round(((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2) ** .5, 1)
        return None


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


# ---------------------------------------------------------------------- 解析

class _Parser(object):
    def __init__(self):
        self.layers = []
        self.stk = []                  # 层栈 [{name, visible, lb, children, n_paths}]
        self.groups = []               # 组栈 [{'blocks': [], 'base': Stroke|None, 'obj': bool, …}]
        self.strokes = []
        self.cur = None
        self.cmyk = None
        self.dash = []
        self.width = None
        self.xw = None                 # 对象头 Xw 标志
        self.await_name = None         # 刚绘制、等待 XMLUID 的 Stroke
        self.pending_obj = None        # 刚闭合、等待对象名的对象组代表线体
        self.last_obj = None           # 最近闭合的对象组（其私有副本紧随其后）
        self.last_stroke = None
        self.geom_since_flush = False
        self.mesh = None               # 正在读取的网格块
        self.n_obj_groups = 0
        self.n_private_merged = 0
        self.n_named_from_copy = 0

    # ---- 几何/绘制
    @staticmethod
    def _new_cur():
        return {'ops': [], 'closed': False, 'priv': True}

    def _flush(self, paint, off):
        if self.cur is None:
            self.cur = self._new_cur()
        if self.cur['ops']:
            st = Stroke()
            st.layer = '/'.join(nd['name'] for nd in self.stk)
            st.layer_visible = all(nd['visible'] for nd in self.stk)
            st.paint = paint
            st.closed = self.cur['closed'] or paint == 's'
            st.cmyk = self.cmyk
            st.dash = list(self.dash)
            st.width = self.width
            st.ops = self.cur['ops']
            st.off = off
            st.xw = self.xw
            st.private = self.cur['priv']
            st.kind = ('stroke' if paint in ('S', 's')
                       else 'fill' if paint in ('f', 'F', 'B', 'b') else 'unpainted')
            if st.private and paint in ('N', 'n'):
                st.obj = self.last_obj            # 组尾私有副本（对象的完整原始路径）
            else:
                self.last_obj = None
            self.strokes.append(st)
            self.await_name = st
            self.pending_obj = None
            self.last_stroke = st
        self.cur = None
        self.xw = None                # 对象级标志随对象消费，不向后续对象泄漏
        self.geom_since_flush = False

    def _geom(self, op, nums, private):
        """几何算子：隐式重复参数组按倍数展开；y 取反入 SVG 系。"""
        if self.cur is None:
            self.cur = self._new_cur()
        self.cur['priv'] = self.cur['priv'] and private
        if op == 'h':
            self.cur['closed'] = True
            self.geom_since_flush = True
            return
        k = {'m': 2, 'l': 2, 'c': 6, 'v': 4, 'y': 4}.get(op)
        if not nums or k is None:
            return
        self.await_name = None
        self.geom_since_flush = True
        for i in range(0, len(nums) - len(nums) % k, k):
            w = nums[i:i + k]
            if op == 'm':
                self.cur['ops'].append(('M', [w[0], -w[1]]))
            elif op == 'l':
                self.cur['ops'].append(('L', [w[0], -w[1]]))
            elif op == 'c':
                self.cur['ops'].append(('C', [w[0], -w[1], w[2], -w[3], w[4], -w[5]]))
            elif op == 'v':
                # v：起始控制=当前点（对拍容差可吸收，几何权威在 PDF 侧）
                p = self.cur['ops'][-1] if self.cur['ops'] else ('M', [0.0, 0.0])
                cx, cy = p[1][-2], p[1][-1]
                self.cur['ops'].append(('C', [cx, cy, w[0], -w[1], w[2], -w[3]]))
            elif op == 'y':
                self.cur['ops'].append(('C', [w[0], -w[1], w[2], -w[3], w[2], -w[3]]))

    # ---- 组与网格
    def _begin_group(self):
        base = None
        ls = self.last_stroke
        if (ls is not None and ls.paint in ('N', 'n') and ls.kind == 'unpainted'
                and not self.geom_since_flush and not ls.based
                and (self.cur is None or not self.cur['ops'])):
            base = ls
            ls.based = True
        parent = self.groups[-1] if self.groups else None
        g = {'blocks': [], 'base': base, 'i0': len(self.strokes),
             'obj': base is not None, 'rep': None, 'xw': self.xw}
        # 对象级隐藏标志（1 Xw）挂在对象的最外层包裹组头上，内层基路径处是 0 Xw
        # （实证：嘉松线太仓段 外层 1 Xw / 内层 0 Xw → 不进 PDF 兼容层）
        if base is not None and parent is not None and not parent['obj']:
            g['pxw'] = parent['xw']
        else:
            g['pxw'] = None
        self.groups.append(g)
        self.last_obj = None

    def _end_group(self):
        """组结束。对象组（基路径 N + u）→ 代表线体：渐变网格线体优先，否则组内最长描边；
        端点装饰（f）与裁剪（W n）不作代表。"""
        if not self.groups:
            return
        g = self.groups.pop()
        rep = None
        base_len = g['base'].length if g['base'] is not None else 0.0
        if g['obj'] and g['blocks']:
            best = max(g['blocks'], key=lambda b: polyline_length(b.centerline()[0]))
            pts, cols = best.centerline()
            mesh_len = polyline_length(pts)
            if max(mesh_len, base_len) >= MESH_LINE_MIN_LEN:
                rep = g['base']
                if rep is None:
                    rep = Stroke()
                    rep.layer = '/'.join(nd['name'] for nd in self.stk)
                    rep.layer_visible = all(nd['visible'] for nd in self.stk)
                    rep.paint = 'N'
                    rep.ops = [('M', [pts[0][0], pts[0][1]])] + [('L', [x, y]) for x, y in pts[1:]]
                    rep.off = best.off
                    rep.cmyk = best.cmyk(cols[len(cols) // 2])
                    rep.width = best.band_width()
                    rep.synthetic = True
                    self.strokes.append(rep)
                rep.kind = 'mesh'
                rep.mesh_len = mesh_len
                rep.mesh_sizes = [b.size for b in g['blocks']]
                rep.mesh_colors = [best.cmyk(c) for c in cols]
                # 线体颜色取网格主色（基路径的 K 状态色只是上一个对象残留，不可信）；带子为实心
                dom = [c for c in rep.mesh_colors if c]
                if dom:
                    rep.cmyk = max(set(dom), key=dom.count)
                rep.dash = []
                bw = best.band_width()
                if bw:
                    rep.width = bw
        if rep is None and g['obj']:
            ss = [s for s in self.strokes[g['i0']:] if s.paint in ('S', 's')]
            if ss:
                rep = max(ss, key=lambda s: s.length)
        if rep is None:
            return                                     # 非对象组 / 仅装饰
        self.n_obj_groups += 1
        rep.in_group = True
        if g['pxw'] == '1' or (g['base'] is not None and g['base'].xw == '1') or rep.xw == '1':
            rep.xw = '1'                     # 任一层出现 1 Xw 即对象级隐藏
        elif rep.xw is None and g['pxw'] is not None:
            rep.xw = g['pxw']
        g['rep'] = rep
        self.pending_obj = rep
        self.await_name = None
        self.last_obj = g

    def _bind_name(self, raw_nm):
        target = self.pending_obj if self.pending_obj is not None else self.await_name
        if target is None:
            return
        target.name_raw = raw_nm
        target.name = decode_obj_name(raw_nm)
        self.await_name = None
        self.pending_obj = None

    # ---- 一行 token 流
    def _run_line(self, toks, off, private):
        stack = []                                      # 本行 operand（AI 逐行自洽）
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
                self._geom(op.lower(), nums, private)
            elif op in PAINT_OPS:
                self._flush(op, off)
            elif op == 'K' and len(nums) >= 4:
                self.cmyk = tuple(round(v, 4) for v in nums[-4:])
            elif op == 'XK' and len(nums) >= 4:
                self.cmyk = tuple(round(v, 4) for v in nums[:4])   # 色板引用：前 4 数即 CMYK
            elif op == 'd':
                for x in reversed(stack):
                    if isinstance(x, tuple) and x[0] == 'arr':
                        nz = [v for v in x[1] if v != 0]
                        self.dash = nz[-2:] if nz else []
                        break
            elif op == 'w' and nums:
                self.width = nums[-1]
            elif op == 'Xw' and nums:
                self.xw = str(int(nums[-1])) if nums[-1] in (0.0, 1.0) else None
            elif op == 'u':
                self._begin_group()
            elif op == 'U':
                self._end_group()
            stack = []

    # ---- 主循环
    def run(self, buf):
        for off, raw in enumerate(buf.split(b'\n')):
            s = raw.strip(b'\r \t')
            if not s:
                continue
            if s[:1] == b'%':
                if s.startswith(BEGIN_LAYER):
                    node = {'name': '?', 'visible': True, 'lb': None, 'children': [], 'n_paths': 0}
                    (self.stk[-1]['children'] if self.stk else self.layers).append(node)
                    self.stk.append(node)
                    self.await_name = None        # 层头的 XMLUID 属于层，绝不绑到上一个路径
                    self.pending_obj = None
                    self.last_obj = None
                elif s.startswith(END_LAYER):
                    if self.stk:
                        self.stk.pop()
                elif s.startswith(XMLUID_PFX):
                    if self.mesh is not None:
                        continue
                    body = s[len(XMLUID_PFX):]
                    p0 = body.find(b'(')
                    p1 = body.find(b')', p0 + 1) if p0 >= 0 else -1
                    if 0 <= p0 < p1:
                        self._bind_name(body[p0 + 1:p1].decode('utf-8', 'replace'))
                elif s.startswith(b'%_'):
                    body = s[2:].strip()          # %_ 仅 2 字节
                    if not body:
                        continue
                    if self.mesh is not None:
                        self.mesh.feed(body)
                        continue
                    t = body.split()
                    if t and (t[-1].decode(errors='replace') in GEOM_OPS or
                              t[-1].decode(errors='replace') in PAINT_OPS):
                        self._run_line(_tokenize(body), off, True)
                continue
            if self.mesh is not None:
                if s.startswith(b'/End'):
                    self.mesh = None
                continue                                 # 网格块内的非 %_ 行（空行等）
            if s.startswith(b'/Mesh') and MESH_BEGIN in s:
                self.mesh = MeshBlock(off)
                if self.groups:
                    self.groups[-1]['blocks'].append(self.mesh)
                continue
            t = s.split()
            if not t:
                continue
            last = t[-1]
            # 层名行：(名) Ln
            if len(t) == 2 and last == b'Ln' and t[0][:1] == b'(':
                if self.stk:
                    self.stk[-1]['name'] = t[0][1:-1].decode('utf-8', 'replace')
                continue
            # 层标志行：… Lb（14 数，第 1 位可见性）
            if last == b'Lb':
                try:
                    bits = [float(x) for x in t[:-1]]
                except ValueError:
                    bits = []
                if self.stk and bits:
                    self.stk[-1]['lb'] = bits
                    self.stk[-1]['visible'] = (bits[0] == 1.0)
                continue
            if last == b'LB' and len(t) == 1:
                self.await_name = None                   # 层尾标志：之后的 XMLUID 不属路径
                continue
            # 普通行：字符级（兼容 `12 w6615.8 … m` 粘连）
            self._run_line(_tokenize(s), off, False)

    # ---- 后处理：组尾私有副本（对象的完整原始路径＋命名）回填到代表线体
    def merge_private(self):
        out = []
        for st in self.strokes:
            g = st.obj
            rep = g['rep'] if g is not None else None
            if rep is not None and st.layer == rep.layer:
                if rep.kind == 'mesh':
                    fp = ops_points(rep.ops)[:1]
                    tol = 8.0 if rep.synthetic else 0.02
                    near = bool(fp) and any(abs(fp[0][0] - x) <= tol and abs(fp[0][1] - y) <= tol
                                            for x, y in ops_points(st.ops))
                else:
                    bb, rb = st.bbox(), rep.bbox()
                    near = bool(bb and rb and all(abs(a - b) <= 20.0 for a, b in zip(bb, rb)))
                if near:
                    if rep.kind == 'mesh':
                        rep.ops = st.ops                # 私有副本＝完整原始路径
                        rep.closed = st.closed
                        rep.private_copy = True
                        rep.synthetic = False
                    if st.name and rep.name is None:
                        rep.name = st.name
                        rep.name_raw = st.name_raw
                        self.n_named_from_copy += 1
                    self.n_private_merged += 1
                    continue                         # 私有副本不单独保留
            out.append(st)
        self.strokes = out

    def finish(self):
        self.merge_private()

        def attach(node, path):
            p = path + [node['name']]
            node['n_paths'] = sum(1 for st in self.strokes if st.layer == '/'.join(p))
            for c in node['children']:
                attach(c, p)
        for r in self.layers:
            attach(r, [])


def parse_tail(buf, log=None):
    """解析矢量尾部 → (层树, Stroke 列表)。"""
    p = _Parser()
    p.run(buf)
    p.finish()
    if log:
        log('原生解析：%d 层、%d 个绘制对象、对象组 %d、私有副本并入 %d（回填名字 %d）' % (
            len(p.layers), len(p.strokes), p.n_obj_groups,
            p.n_private_merged, p.n_named_from_copy))
    return p.layers, p.strokes


def strokes_to_json(strokes):
    out = []
    for i, st in enumerate(strokes):
        out.append(dict(
            id=i, layer=st.layer, visible=st.layer_visible,
            name=st.name, nameRaw=st.name_raw, paint=st.paint, closed=st.closed,
            cmyk=list(st.cmyk) if st.cmyk else None, dash=st.dash, width=st.width,
            xw=st.xw, kind=st.kind, private=st.private, privateCopy=st.private_copy,
            inGroup=st.in_group, synthetic=st.synthetic,
            meshLen=st.mesh_len, meshColors=st.mesh_colors, meshSizes=st.mesh_sizes,
            length=round(st.length, 1), line=st.off,
            bbox=[round(v, 4) for v in st.bbox()] if st.bbox() else None,
            ops=[[op] + [round(v, 4) for v in w] for op, w in st.ops]))
    return out


def main():
    ap = argparse.ArgumentParser(description='远期.ai 原生私有数据矢量解析（图层树+对象名+可见性+渐变网格线体）')
    ap.add_argument('ai', help='.ai 文件路径（缓存缺失时重提取用）')
    ap.add_argument('--cache', default='零散/ai_native_tail.bin', help='矢量尾部缓存路径')
    ap.add_argument('--json', help='结果 JSON 输出路径（缺省只打印统计）')
    args = ap.parse_args()

    buf = ensure_tail(args.ai, args.cache)
    layers, strokes = parse_tail(buf, log=print)

    line_st = [s for s in strokes if s.layer.split('/')[0] == 'Line'
               and (s.paint in ('S', 's') or s.kind == 'mesh')]
    hid_line = [s for s in line_st if not s.layer_visible]
    named = sum(1 for s in line_st if s.layer_visible and s.name)
    print('层树根 %d；Line 子树线体 %d 条（描边 %d + 渐变网格 %d；隐藏层 %d 条），可见带名 %d 条'
          % (len(layers), len(line_st), sum(1 for s in line_st if s.kind != 'mesh'),
             sum(1 for s in line_st if s.kind == 'mesh'), len(hid_line), named))

    def show(node, depth=0, pfx=''):
        p = (pfx + '/' + node['name']) if pfx else node['name']
        n = sum(1 for s in line_st if s.layer == p)
        print('%s%s%s  [线体 %d]' % ('  ' * depth, node['name'],
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
