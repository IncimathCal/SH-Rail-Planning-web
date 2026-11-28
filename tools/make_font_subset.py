#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""make_font_subset.py —— 为查看器生成思源黑体中文子集 webfont（woff2）。

用途
----
扫描数据文本（站名／线路名等）与查看器 UI 文案，收集全部用字，加上一份
兜底字符集（ASCII、全角标点、常用符号），对源字体做子集化，产出：

    assets/fonts/subset-regular.woff2    （Regular 400）
    assets/fonts/subset-semibold.woff2   （SemiBold 600）
    assets/fonts/subset-chars.txt        （字符表存档，每行一个字符）

源字体是 Google Fonts 仓库的 Noto Sans SC 可变字体（与思源黑体同源设计，
wght 轴 100–900）。脚本对每个目标字重先用 fontTools.varLib.instancer 把
可变字体实例化成静态字重，再做子集化并压成 woff2。静态 ttf/otf 源同样
可用（@wght 只用于标注字重，不改字形）。

CFF→TrueType 轮廓转换（2026-11-28 部分安卓「只见白描边不见黑字」修复②）
--------------------------------------------------------------------
子集化后若字体仍是 CFF（PostScript）轮廓（源为静态 OTF 时，如苹方），自动
原地转 TrueType（glyf）轮廓再落盘——部分安卓 WebView 对 webfont 的 CFF 轮廓
渲染有缺陷。转换只换轮廓的数学描述（三次贝塞尔→二次逼近，误差默认 0.1% em
级，视觉不可辨），字形设计／字符集（cmap）／度量（hmtx）不变；源本身是
TrueType（无 CFF 表）则跳过（思源轨零改动）。详见 cff_to_glyf 文档。

字符来源与剥注释规则
--------------------
* --data-glob 命中的 .json / .geojson：按 JSON 解析，遍历全部字符串键与值；
  解析失败则退回整文件文本扫描并报警。
* --data-glob 命中的 .js：剥掉 /* */ 与 // 注释后整文件扫描（避免把注释里
  的用字也织进子集；「//」带负向后视保护 http(s):// 一类协议写法）。
* --html：剥掉 <!-- --> 与 /* */（CSS 注释）后整文件扫描，正文与属性值
  （含 title 提示文案）都收。
* 内置兜底字符集：ASCII 可打印、全角标点、常用符号与箭头（见 FALLBACK）。

校验
----
* 产物文件头必须是 woff2 magic（wOF2）。
* 数据用字（不含兜底集）必须逐字出现在每个字重产物的 cmap 里；缺字打印
  报警并以非零码退出。兜底符号若字体不含则只报警不失败。

用法（在仓库根运行）
--------------------
    python -X utf8 tools/make_font_subset.py \
      --data-glob "build/net/*" \
      --html "index.html" \
      --data-glob "src/viewer_core.js" \
      --data-glob "src/viewer.js" \
      --fonts "build/font-src/NotoSansSC-VF.ttf@400:regular" \
      --fonts "build/font-src/NotoSansSC-VF.ttf@600:semibold" \
      --out-dir "assets/fonts"

以上即默认值（不传参数等价于上述命令；build/font-src 不入库，路径可换）。
"""

import argparse
import glob
import json
import os
import re
import sys

from fontTools.ttLib import TTFont, newTable
from fontTools import subset as ft_subset
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.varLib import instancer

# ---------------------------------------------------------------------------
# 兜底字符集（全部经源字体 cmap 验证存在；新增符号前先探一次 cmap）
# ---------------------------------------------------------------------------
FALLBACK_GROUPS = [
    ("ASCII 可打印字符", "".join(chr(c) for c in range(0x20, 0x7F))),
    # 注：U+00A0（NBSP）与 U+3000（全角空格）本 VF 的 cmap 没有，空档类空白
    # 由系统字体兜底即可（不可见字符，无需字形），不收进兜底集以免恒报警。
    ("全角标点与符号 FF01–FF5E", "".join(chr(c) for c in range(0xFF01, 0xFF5F))),
    ("全角货币等 FFE0–FFE5", "".join(chr(c) for c in range(0xFFE0, 0xFFE6))),
    ("CJK 常用标点与括号", "、。〈〉《》「」『』【】〔〕"),
    ("破折号省略号引号", "‐–—‘’“”‥…※"),
    ("间隔号与度数运算符号", "°±·×÷§©«»‹›"),
    ("箭头", "←↑→↓↔⇄⇒"),
    ("数学与集合符号", "−≈≠≤≥∈∋∧∨"),
    ("带圈数字①–⑩", "".join(chr(c) for c in range(0x2460, 0x246A))),
    ("警示与其他", "⚠℃¥￥"),
]


def gb2312_level1_chars():
    """GB2312 一级常用汉字（16–55 区，3755 字），纯编码生成、无外部数据文件。

    供 --common-hanzi 兜底：真数据站名＋UI 文案之外的常用字也进子集，
    避免数据更新后个别新站名缺字回退系统字体造成字形混排。
    """
    chars = []
    for qu in range(16, 56):        # 区 16–55＝一级汉字
        for wei in range(1, 95):    # 每区 94 位
            try:
                chars.append(bytes([0xA0 + qu, 0xA0 + wei]).decode("gb2312"))
            except UnicodeDecodeError:
                pass                # 区内空位（如末区不足 94 字）
    return "".join(chars)

# ---------------------------------------------------------------------------
# 注释剥离（HTML 的 <!-- -->、CSS 与 JS 的 /* */、JS 的 // 行注释）
# ---------------------------------------------------------------------------
RE_HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
RE_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.S)
# 「//」前不能是「:」，保护 http:// 与 https:// 一类写法不被当注释截断
RE_LINE_COMMENT = re.compile(r"(?<!:)//[^\n]*")


def strip_comments(text, kind):
    """按文件类别剥注释，返回用于收字的文本。"""
    if kind == "html":
        text = RE_HTML_COMMENT.sub(" ", text)
        text = RE_BLOCK_COMMENT.sub(" ", text)
    elif kind == "js":
        text = RE_BLOCK_COMMENT.sub(" ", text)
        text = RE_LINE_COMMENT.sub(" ", text)
    return text


def walk_json_strings(obj, sink):
    """递归遍历 JSON 结构，把所有字符串键与值喂给 sink。"""
    if isinstance(obj, str):
        sink(obj)
    elif isinstance(obj, list):
        for item in obj:
            walk_json_strings(item, sink)
    elif isinstance(obj, dict):
        for key, value in obj.items():
            sink(key) if isinstance(key, str) else None
            walk_json_strings(value, sink)


def kind_of(path):
    """按扩展名判定文件的处理类别。"""
    lower = path.lower()
    if lower.endswith((".json", ".geojson")):
        return "json"
    if lower.endswith(".js"):
        return "js"
    if lower.endswith((".html", ".htm")):
        return "html"
    return "text"


def read_text(path):
    """读文本：兼容 UTF-8 BOM，其余按纯 UTF-8。"""
    with open(path, encoding="utf-8-sig") as fh:
        return fh.read()


def harvest_file(path, data_chars, ui_chars):
    """扫描单个文件，把字符分别记入数据用字与 UI 用字两个集合。"""
    kind = kind_of(path)
    if kind == "json":
        try:
            with open(path, encoding="utf-8-sig") as fh:
                root = json.load(fh)
        except (ValueError, OSError) as exc:
            print("报警：%s JSON 解析失败（%s），退回整文件文本扫描" % (path, exc))
            text = read_text(path)
            data_chars.update(text)
            return
        walk_json_strings(root, data_chars.update)
        return
    text = strip_comments(read_text(path), kind)
    if kind in ("js", "html"):
        ui_chars.update(text)
    else:
        data_chars.update(text)


def build_font(source_path, wght):
    """加载源字体；可变字体先实例化到指定 wght，返回静态 TTFont。"""
    font = TTFont(source_path)
    if "fvar" in font:
        instancer.instantiateVariableFont(
            font, {"wght": wght}, inplace=True, updateFontNames=True
        )
    # usWeightClass 双保险（instancer 对 wght 轴本就会写，静态字体则只做标注）
    font["OS/2"].usWeightClass = wght
    return font


def subset_font(font, char_set):
    """对字体做子集化并压成 woff2，返回 TTFont（flavor 已置 woff2）。"""
    options = ft_subset.Options()
    options.flavor = "woff2"
    options.hinting = False  # 网页显示不依赖 TrueType 提示，去掉省体积
    subsetter = ft_subset.Subsetter(options)
    subsetter.populate(unicodes=sorted(ord(c) for c in char_set))
    subsetter.subset(font)
    font.flavor = "woff2"
    return font


def cff_to_glyf(font, max_err_em=1.0):
    """CFF（PostScript 三次曲线）轮廓原地转 TrueType（glyf 二次曲线）轮廓。

    背景（2026-11-28 部分安卓「只见白描边不见黑字」修复②）：苹方源是静态
    OTF（CFF 轮廓），部分安卓 WebView 对网页 webfont 的 CFF 轮廓渲染有缺陷；
    转 glyf 后兼容面更广。转换只改轮廓的数学描述（三次贝塞尔→二次逼近，
    误差 max_err_em × upm/1000 单位——默认 1.0 即 0.1% em，视觉不可辨），
    字形设计、字符集（cmap）、度量（hmtx）均不变。源本身是 TrueType（无
    CFF 表）时不动、返回 False（思源轨零改动）。

    路线＝fontTools 官方 cu2qu：Cu2QuPen 收三次曲线、逼近输出二次曲线给
    TTGlyphPen（reverse_direction＝CFF 与 TrueType 的外轮廓方向相反，必须
    反转）；重建 glyf/loca、删 CFF 与 VORG（VORG 只伴随 CFF 的竖排基线
    偏移，TrueType 轨道由 vmtx 承担）、sfntVersion 改 00010000；maxp 从
    OTTO 的 0.5 版升 1.0 全字段（recalc 按 glyf 实际轮廓统计；本流程
    hinting=False 无 TrueType 指令，指令相关 max 字段无实义）。
    """
    if "CFF " not in font:
        return False
    glyph_order = font.getGlyphOrder()
    upm = font["head"].unitsPerEm
    max_err = max_err_em * upm / 1000.0
    glyph_set = font.getGlyphSet()
    glyf = newTable("glyf")
    glyf.glyphOrder = glyph_order
    glyphs = {}
    for name in glyph_order:
        pen = TTGlyphPen(glyph_set)
        cu2qu = Cu2QuPen(pen, max_err, reverse_direction=True)
        glyph_set[name].draw(cu2qu)
        glyphs[name] = pen.glyph()
    glyf.glyphs = glyphs
    font["loca"] = newTable("loca")
    font["glyf"] = glyf
    del font["CFF "]
    if "VORG" in font:
        del font["VORG"]
    font.sfntVersion = "\x00\x01\x00\x00"
    maxp = newTable("maxp")
    maxp.tableVersion = 0x00010000  # 1.0 全字段（OTTO 的 0.5 版只带 numGlyphs）
    maxp.numGlyphs = len(glyph_order)
    # 指令相关字段的保守默认（本流程 hinting=False 无 TrueType 指令，全 0；
    # maxZones=2 为规范惯例值——只有带 twilight zone 指令的字体才需要 >1）
    maxp.maxZones = 2
    maxp.maxTwilightPoints = 0
    maxp.maxStorage = 0
    maxp.maxFunctionDefs = 0
    maxp.maxInstructionDefs = 0
    maxp.maxStackElements = 0
    maxp.maxSizeOfInstructions = 0
    font["maxp"] = maxp
    # TTGlyphPen 产出的字形未算 bbox（xMin 等），maxp.recalc 要读——先逐字形补
    for name in glyph_order:
        glyphs[name].recalcBounds(glyf)
    maxp.recalc(font)
    return True


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="生成查看器用思源黑体中文子集 webfont（woff2）"
    )
    # 可多次参数的默认值用 None 占位：一旦显式传参就整体替换默认，避免叠加
    parser.add_argument(
        "--data-glob",
        action="append",
        default=None,
        help="数据/文本源 glob，可多次；.json/.geojson 按 JSON 抽字符串，"
        ".js 剥注释，其余整文件（默认 build/net/*）",
    )
    parser.add_argument(
        "--html",
        action="append",
        default=None,
        help="HTML UI 文案源，可多次，剥注释后收字（默认 index.html）",
    )
    parser.add_argument(
        "--fonts",
        action="append",
        default=None,
        help="源字体规格 路径@wght:输出名，可多次；输出名决定产物名 "
        "subset-<输出名>.woff2（默认 VF 实例化 400/600 两档）",
    )
    parser.add_argument(
        "--out-dir", default="assets/fonts", help="产物目录（默认 assets/fonts）"
    )
    parser.add_argument(
        "--out-chars",
        default=None,
        help="字符表存档路径（默认 <out-dir>/subset-chars.txt）",
    )
    parser.add_argument(
        "--common-hanzi",
        action="store_true",
        help="兜底集追加 GB2312 一级常用汉字 3755 字（软校验；"
        "2026-11-28 苹方子集用，思源默认命令不带以维持原口径）",
    )
    args = parser.parse_args(argv)
    if args.data_glob is None:
        args.data_glob = ["build/net/*"]
    if args.html is None:
        args.html = ["index.html"]
    if args.fonts is None:
        args.fonts = [
            "build/font-src/NotoSansSC-VF.ttf@400:regular",
            "build/font-src/NotoSansSC-VF.ttf@600:semibold",
        ]

    # ---- 1. 收字 ----------------------------------------------------------
    data_chars = set()   # 数据用字：硬校验对象
    ui_chars = set()     # UI 用字：软校验（缺字只报警）
    sources = []
    for pattern in args.data_glob:
        sources.extend(sorted(glob.glob(pattern)))
    sources.extend(args.html)
    if not sources:
        print("错误：没有任何输入文件（--data-glob/--html 未命中）")
        return 1
    for path in sources:
        if not os.path.isfile(path):
            print("错误：输入文件不存在：%s" % path)
            return 1
        harvest_file(path, data_chars, ui_chars)

    fallback_chars = set()
    for _label, group in FALLBACK_GROUPS:
        fallback_chars.update(group)
    if args.common_hanzi:
        fallback_chars.update(gb2312_level1_chars())

    # 空白统一不进字符表（换行/制表等不可见，字体无需字形；普通空格除外）
    def wanted(c):
        return (not c.isspace()) or c == " "

    data_chars = {c for c in data_chars if wanted(c)}
    ui_chars = {c for c in ui_chars if wanted(c)}
    fallback_chars = {c for c in fallback_chars if wanted(c)}

    char_set = data_chars | ui_chars | fallback_chars
    chars_sorted = sorted(char_set)
    hanzi = [c for c in chars_sorted if 0x3400 <= ord(c) <= 0x9FFF]
    print(
        "字符表：%d 字（数据 %d、UI 增量 %d、兜底集 %d；其中汉字 %d）"
        % (
            len(chars_sorted),
            len(data_chars),
            len(ui_chars - data_chars),
            len(fallback_chars - data_chars - ui_chars),
            len(hanzi),
        )
    )

    # ---- 2. 字符表存档（每行一个字符） ------------------------------------
    out_dir = args.out_dir
    out_chars_path = args.out_chars or os.path.join(out_dir, "subset-chars.txt")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.dirname(out_chars_path) or ".", exist_ok=True)
    with open(out_chars_path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(chars_sorted) + "\n")
    print("字符表存档：%s" % os.path.normpath(out_chars_path))

    # ---- 3. 逐字重生成子集 ------------------------------------------------
    failed = False
    for spec in args.fonts:
        try:
            source_path, rest = spec.rsplit("@", 1)
            wght_str, name = rest.split(":", 1)
            wght = int(wght_str)
        except ValueError:
            print("错误：--fonts 规格应为 路径@wght:输出名，收到：%s" % spec)
            return 1
        if not os.path.isfile(source_path):
            print("错误：源字体不存在：%s" % source_path)
            return 1

        font = build_font(source_path, wght)
        subset_font(font, char_set)
        converted = cff_to_glyf(font)  # CFF 源（静态 OTF）自动转 TrueType 轮廓
        out_path = os.path.normpath(os.path.join(out_dir, "subset-%s.woff2" % name))
        font.save(out_path)

        # ---- 4. 校验：woff2 magic + cmap 覆盖 -----------------------------
        with open(out_path, "rb") as fh:
            magic = fh.read(4)
        if magic != b"wOF2":
            print("错误：%s 文件头不是 wOF2（收到 %r）" % (out_path, magic))
            failed = True
            continue
        check = TTFont(out_path)
        if converted and ("glyf" not in check or "CFF " in check):
            print(
                "错误：%s 轮廓转换失败：应含 glyf 不含 CFF（实得 %s）"
                % (out_path, sorted(k.strip() for k in check.keys()))
            )
            failed = True
        cmap = check.getBestCmap()
        miss_data = [c for c in data_chars if ord(c) not in cmap]
        miss_ui = [c for c in ui_chars if ord(c) not in cmap]
        miss_fallback = [
            c for c in fallback_chars if ord(c) not in cmap
        ]
        size_kb = os.path.getsize(out_path) / 1024.0
        print(
            "subset-%s.woff2：wght=%d，%d 字形，%.1f KB，轮廓 %s"
            % (
                name,
                wght,
                check["maxp"].numGlyphs,
                size_kb,
                "TrueType（已从 CFF 转换）" if converted else "TrueType",
            )
        )
        for label, missing, hard in (
            ("数据用字", miss_data, True),
            ("UI 用字", miss_ui, False),
            ("兜底符号", miss_fallback, False),
        ):
            if missing:
                shown = "".join(
                    "U+%04X(%s)" % (ord(c), c) for c in sorted(missing)
                )
                print(
                    "%s：源字体缺 %d 字：%s"
                    % (label, len(missing), shown)
                )
                if hard:
                    failed = True
        if size_kb > 200:
            print("报警：%s 超过 200KB，检查是否收了多余字重/字符" % out_path)
    if failed:
        print("结果：FAIL（存在缺字或格式问题，见上方报警）")
        return 1
    print("结果：PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
