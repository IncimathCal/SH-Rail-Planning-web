#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ge_convert —— 「源图 SVG 坐标 ↔ Google Earth」双向坐标转换命令行工具（原型）。

用途：把远期图项目的画板坐标（.ai 页面基准 12000×12000、SVG 朝向、单位 pt）与
Google Earth 使用的 WGS84 十进制度经纬度互转——便于把线路导出到 GE 目视核对走向，
或把 GE 里量取的位置换算回源图坐标（供编辑器录入参考）。

两个方向（子命令）：
  to-ge    导入记录 JSON（fmt/import@1，样例 import/远期图-全量.json）→ KMZ：
           每条线路的 path 字符串压平为折线，逐点正变换 (x,y)→(lon,lat)，
           输出一个 KML LineString Placemark（name 用 sourceLayer，无则 id，
           再无则中性编号 path-NN），整体打包 doc.kml 为 KMZ。
           --layer 按 sourceLayer/id 子串过滤线路；--out 以 .kml 结尾则输出裸 KML。
  from-ge  KMZ/KML → CSV：解析每个 Placemark 的 Point coordinates(lon,lat[,alt])，
           反变换 (lon,lat)→(x,y)（affine 初值 + 牛顿迭代·解析雅可比），
           输出列：name,lon,lat,x,y。不收敛的点 x,y 留空并在控制台告警。

变换依赖 data/calibration.json（fmt/calibration@2，model:"tps"）：affine + 正则薄板
样条（U(r2)=r2·ln(r2)，kernel 坐标 km = svg × kernel.scaleToKm，pdeg=1）。
正/反变换公式提取自 tools/calib_manual_fit.py 的 tps_apply_exported /
tps_inverse_exported（与 src/editor.js 的 JS 版语义对拍过），此处改写为纯标准库
实现——标定拟合才需要 numpy，仅套用变换不需要。

坐标基准：与 import/远期图-全量.json、data/manual-control-points.csv 同基准
（.ai 页面 12000×12000 画板，y 轴向下即 SVG 朝向，单位 pt）。

用法（项目根，建议 -X utf8 避免控制台编码问题）：
  python -X utf8 tools/ge_convert.py to-ge import/远期图-全量.json --out 检视.kmz
  python -X utf8 tools/ge_convert.py to-ge import/远期图-全量.json --layer 17 --out 17号线.kmz
  python -X utf8 tools/ge_convert.py from-ge 源资产/手动标定.kmz --out 点位.csv
"""

import argparse
import csv
import json
import math
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

# 复用 tools/svg_parse.py 的 path 解析与贝塞尔压平（纯标准库，与本工具同目录）
sys.path.insert(0, str(Path(__file__).resolve().parent))
from svg_parse import parse_path, flatten  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CALIB = ROOT / "data" / "calibration.json"

KML_NS = "http://www.opengis.net/xml/kml/2.2"
FLAT_TOL = 0.05            # 压平容差（svg pt），与 svg_parse.FLAT_TOL 一致
INV_ITERS = 60             # 反变换牛顿迭代上限（同 calib_manual_fit.tps_inverse_exported）
INV_TOL = 1e-12            # 反变换收敛容差（经纬度度量的残差模长，同参考实现）


# ---------------------------------------------------------------- TPS 变换 --

class TpsTransform:
    """导出标定系数的薄板样条正/反变换（纯标准库版，公式来源见模块文档）。

    affine 存成两行三元组：lon = a0 + a1*u + a2*v，lat = b0 + b1*u + b2*v，
    其中 (u,v) = (x,y) × scaleToKm（km 坐标）；控制点已预乘同系数。
    """

    def __init__(self, control_points, affine_lon, affine_lat, scale_to_km):
        self.s = float(scale_to_km)
        self.alon = [float(v) for v in affine_lon]
        self.alat = [float(v) for v in affine_lat]
        # [(pku, pkv, wlon, wlat), ...]，控制点 svg 坐标预乘 scaleToKm
        self.cps = [(float(p[0]) * self.s, float(p[1]) * self.s,
                     float(p[2]), float(p[3])) for p in control_points]

    def forward(self, x, y):
        """svg (x,y) → WGS84 (lon,lat)。"""
        u, v = x * self.s, y * self.s
        a0, a1, a2 = self.alon
        b0, b1, b2 = self.alat
        lon = a0 + a1 * u + a2 * v
        lat = b0 + b1 * u + b2 * v
        for pku, pkv, wlon, wlat in self.cps:
            du, dv = u - pku, v - pkv
            d2 = du * du + dv * dv
            if d2 > 1e-12:
                r = d2 * math.log(d2)
                lon += wlon * r
                lat += wlat * r
        return lon, lat

    def inverse(self, lon, lat, iters=INV_ITERS, tol=INV_TOL):
        """WGS84 (lon,lat) → svg (x,y)；牛顿迭代（affine 初值 + 解析雅可比）。

        不收敛 / 奇异返回 None。步进方程与参考实现一致：
        J·step = f(u,v) − (lon,lat)，J 为正变换对 (u,v) 的 2×2 雅可比。
        """
        a0, a1, a2 = self.alon
        b0, b1, b2 = self.alat
        det = a1 * b2 - a2 * b1
        if abs(det) < 1e-15:
            return None
        u = ((lon - a0) * b2 - (lat - b0) * a2) / det
        v = ((lat - b0) * a1 - (lon - a0) * b1) / det
        for _ in range(iters):
            # 同时累计正变换值 f 与雅可比 J（w·(ln d2 +1)·2·d 为 U 对 u/v 的偏导）
            flo = a0 + a1 * u + a2 * v
            fla = b0 + b1 * u + b2 * v
            j00, j01, j10, j11 = a1, a2, b1, b2
            for pku, pkv, wlon, wlat in self.cps:
                du, dv = u - pku, v - pkv
                d2 = du * du + dv * dv
                if d2 > 1e-12:
                    lg = math.log(d2)
                    r = d2 * lg
                    lp2du = (lg + 1.0) * 2.0 * du
                    lp2dv = (lg + 1.0) * 2.0 * dv
                    flo += wlon * r
                    fla += wlat * r
                    j00 += wlon * lp2du
                    j01 += wlon * lp2dv
                    j10 += wlat * lp2du
                    j11 += wlat * lp2dv
            glo = flo - lon
            gla = fla - lat
            if math.hypot(glo, gla) < tol:
                break
            jd = j00 * j11 - j01 * j10
            if not math.isfinite(jd) or abs(jd) < 1e-300:
                return None
            u -= (glo * j11 - gla * j01) / jd
            v -= (gla * j00 - glo * j10) / jd
            if not (math.isfinite(u) and math.isfinite(v)):
                return None
        return u / self.s, v / self.s


def load_calibration(path):
    """读取并校验标定 JSON → TpsTransform。"""
    js = json.loads(Path(path).read_text(encoding="utf-8"))
    if js.get("schema") != "fmt/calibration@2":
        print(f"警告：{path} schema={js.get('schema')!r}，非 fmt/calibration@2，按尽力而为继续")
    if js.get("model") != "tps":
        sys.exit(f"错误：标定 model={js.get('model')!r}，本工具只支持 tps")
    kern = js.get("kernel", {})
    if kern.get("name") != "r2logr2" or kern.get("coord") != "km":
        sys.exit(f"错误：不支持的 kernel {kern}（仅 r2logr2/km）")
    cps = js["controlPoints"]
    if not cps or any(len(p) < 4 for p in cps):
        sys.exit("错误：controlPoints 为空或字段不全（需 [x,y,wLon,wLat]）")
    return TpsTransform(cps, js["affine"]["lon"], js["affine"]["lat"],
                        kern["scaleToKm"])


def _record_name(rec, idx):
    """Placemark 名：sourceLayer → id → 中性编号 path-NN（不擅自起名）。"""
    return rec.get("sourceLayer") or rec.get("id") or f"path-{idx:02d}"


# -------------------------------------------------------------------- to-ge --

def _kml_color(hex_rgb):
    """#RRGGBB → KML LineStyle 颜色 ffBBGGRR（非法输入返回 None）。"""
    h = (hex_rgb or "").strip()
    if len(h) == 7 and h[0] == "#":
        try:
            return "ff" + h[5:7] + h[3:5] + h[1:3]
        except ValueError:
            pass
    return None


def cmd_to_ge(args):
    js = json.loads(Path(args.input).read_text(encoding="utf-8"))
    recs = js.get("paths") or []
    if args.layer:
        recs = [r for r in recs if args.layer in (r.get("sourceLayer") or r.get("id") or "")]
    if not recs:
        sys.exit(f"错误：输入中无线路{'（--layer 过滤后为空）' if args.layer else ''}")
    tps = load_calibration(args.calib)

    ET.register_namespace("", KML_NS)
    q = lambda tag: f"{{{KML_NS}}}{tag}"  # noqa: E731
    kml = ET.Element(q("kml"))
    doc = ET.SubElement(kml, q("Document"))
    ET.SubElement(doc, q("name")).text = js.get("source") or Path(args.input).stem

    total_pts = 0
    for i, rec in enumerate(recs, 1):
        name = _record_name(rec, i)
        pts = flatten(parse_path(rec["path"]), args.flat_tol)
        coords = []
        for x, y in pts:
            lon, lat = tps.forward(x, y)
            coords.append(f"{lon:.7f},{lat:.7f}")
        total_pts += len(coords)
        pm = ET.SubElement(doc, q("Placemark"))
        ET.SubElement(pm, q("name")).text = name
        col = _kml_color(rec.get("color"))
        if col:
            style = ET.SubElement(pm, q("Style"))
            ls = ET.SubElement(style, q("LineStyle"))
            ET.SubElement(ls, q("color")).text = col
            ET.SubElement(ls, q("width")).text = "3"
        line = ET.SubElement(pm, q("LineString"))
        ET.SubElement(line, q("tessellate")).text = "1"
        ET.SubElement(line, q("coordinates")).text = " ".join(coords)

    data = ET.tostring(kml, encoding="UTF-8", xml_declaration=True)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.suffix.lower() == ".kmz":
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("doc.kml", data)
    else:
        out.write_bytes(data)
    print(f"to-ge 完成：{len(recs)} 条线路、折线共 {total_pts} 点"
          f"{'（--layer 过滤）' if args.layer else ''}")
    print(f"written: {out}（{out.stat().st_size / 1024:.0f} KB）")


# ------------------------------------------------------------------ from-ge --

def _local(tag):
    """去掉命名空间 → 本地名（兼容 GE 各版本/无 ns 的手写 KML）。"""
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _read_kml_root(path):
    """KMZ（zip）或裸 KML → Element 根节点。"""
    p = Path(path)
    if zipfile.is_zipfile(p):
        with zipfile.ZipFile(p) as z:
            names = z.namelist()
            member = "doc.kml" if "doc.kml" in names else \
                next((n for n in names if n.lower().endswith(".kml")), None)
            if member is None:
                sys.exit(f"错误：KMZ {path} 中未找到 .kml 成员")
            return ET.fromstring(z.read(member))
    return ET.fromstring(p.read_bytes())


def _first_desc(el, local):
    return next((e for e in el.iter() if _local(e.tag) == local), None)


def cmd_from_ge(args):
    root = _read_kml_root(args.input)
    tps = load_calibration(args.calib)

    rows, n_fail, n_skip = [], 0, 0
    for pm in (e for e in root.iter() if _local(e.tag) == "Placemark"):
        name = ""
        for ch in pm:
            if _local(ch.tag) == "name":
                name = (ch.text or "").strip()
                break
        point = _first_desc(pm, "Point")
        coords_el = _first_desc(point, "coordinates") if point is not None else None
        if coords_el is None or not (coords_el.text or "").strip():
            n_skip += 1          # 非 Point placemark（如 LineString）或无坐标
            continue
        tok = coords_el.text.split()[0].split(",")
        try:
            lon_s, lat_s = tok[0], tok[1]
            lon, lat = float(lon_s), float(lat_s)
        except (ValueError, IndexError):
            print(f"警告：坐标无法解析：{coords_el.text.split()[0][:60]!r}，跳过")
            n_skip += 1
            continue
        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            print(f"警告：坐标超出范围 lon={lon}, lat={lat}，跳过")
            n_skip += 1
            continue
        xy = tps.inverse(lon, lat)
        if xy is None:
            print(f"警告：({lon},{lat})（name={name!r}）反变换未收敛，x,y 留空")
            rows.append([name, lon_s, lat_s, "", ""])
            n_fail += 1
        else:
            rows.append([name, lon_s, lat_s, f"{xy[0]:.6f}", f"{xy[1]:.6f}"])

    if not rows:
        sys.exit("错误：未找到任何带 Point coordinates 的 Placemark")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["name", "lon", "lat", "x", "y"])
        w.writerows(rows)
    print(f"from-ge 完成：{len(rows)} 个点"
          f"{'，未收敛 ' + str(n_fail) + ' 个' if n_fail else ''}"
          f"{'，跳过非 Point/坏坐标 ' + str(n_skip) + ' 个' if n_skip else ''}")
    print(f"written: {out}")


# ---------------------------------------------------------------------- CLI --

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(
        prog="ge_convert.py",
        description="「源图 SVG 坐标 ↔ Google Earth(WGS84)」双向转换工具（原型）。"
                    "坐标基准：.ai 页面 12000×12000 画板（SVG 朝向，单位 pt）；"
                    "变换依赖 data/calibration.json（fmt/calibration@2，tps）。",
        epilog="示例：\n"
                 "  python -X utf8 tools/ge_convert.py to-ge import/远期图-全量.json --out 检视.kmz\n"
                 "  python -X utf8 tools/ge_convert.py to-ge import/远期图-全量.json --layer 17 --out 17.kmz\n"
                 "  python -X utf8 tools/ge_convert.py from-ge 源资产/手动标定.kmz --out 点位.csv\n",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--calib", default=str(DEFAULT_CALIB),
                    help="标定 JSON 路径（默认 data/calibration.json，fmt/calibration@2 tps）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("to-ge", help="导入记录 JSON(fmt/import@1) → KMZ：线路折线正变换为 WGS84")
    p1.add_argument("input", help="导入记录 JSON 路径（fmt/import@1）")
    p1.add_argument("--out", required=True, help="输出 .kmz（后缀写 .kml 则输出裸 KML 文件）")
    p1.add_argument("--layer", default=None,
                    help="按 sourceLayer/id 子串过滤线路（如 --layer 17 或 --layer 苏州）")
    p1.add_argument("--flat-tol", type=float, default=FLAT_TOL,
                    help=f"贝塞尔压平容差（svg pt，默认 {FLAT_TOL}，与 svg_parse 一致）")
    p1.set_defaults(func=cmd_to_ge)

    p2 = sub.add_parser("from-ge", help="KMZ/KML → CSV：Point 经纬度反变换为 svg x,y")
    p2.add_argument("input", help="输入 KMZ 或裸 KML 路径")
    p2.add_argument("--out", required=True, help="输出 CSV 路径（列 name,lon,lat,x,y）")
    p2.set_defaults(func=cmd_from_ge)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
