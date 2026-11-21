// 共享几何库：SVG path 解析、贝塞尔压平、弧长参数化。
// 与 tools/svg_parse.py 语义一致（node 对拍验证）；浏览器与 node 双兼容。
// 数据规范：结构字段全英文；本文件为代码，注释用中文。
(function (global) {
  'use strict';

  const FLAT_TOL = 0.05;     // 压平容差（SVG 单位）
  const ARC_MIN_DEPTH = 3;   // 每段曲线最少细分层数（2^3 = 8 段）
  const TOKEN_RE = /([MLHVCSTQZAmlhvcstqaz])|(-?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)/g;
  const NARGS = { L: 2, l: 2, H: 1, h: 1, V: 1, v: 1, C: 6, c: 6, S: 4, s: 4, Q: 4, q: 4, T: 2, t: 2 };

  class PathError extends Error {}

  // ---------- path 词法与状态机解析 ----------

  function tokenize(d) {
    const tokens = [];
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(d)) !== null) {
      tokens.push(m[1] !== undefined ? m[1] : parseFloat(m[2]));
    }
    return tokens;
  }

  /**
   * 解析 path 字符串 → 三次贝塞尔段列表 [[x0,y0,x1,y1,x2,y2,x3,y3], ...]
   * （直线段表示为退化贝塞尔；段与段首尾相接）。与 Python 版 parse_path 语义一致。
   */
  function parsePath(d) {
    const tokens = tokenize(d);
    const segs = [];
    let cx = 0, cy = 0, sx = 0, sy = 0, px = null, py = null;
    let cmd = null;

    const lineTo = (x, y) => {
      segs.push([cx, cy, cx, cy, x, y, x, y]);
      cx = x; cy = y; px = py = null;
    };

    for (let idx = 0; idx < tokens.length; ) {
      if (typeof tokens[idx] === 'string') { cmd = tokens[idx]; idx++; }
      else if (cmd === null) throw new PathError('path data must start with a command');
      // 同一命令的后续参数组 = 隐式重复该命令（M 的后续组按 L 处理，见下）

      if (cmd === 'M' || cmd === 'm') {
        if (idx + 2 > tokens.length) throw new PathError('M without coordinates');
        const x = tokens[idx], y = tokens[idx + 1];
        if (cmd === 'M') { cx = x; cy = y; } else { cx += x; cy += y; }
        sx = cx; sy = cy; px = py = null;
        idx += 2;
        // M 的后续坐标对按隐式 L/l 处理
        while (idx + 2 <= tokens.length && typeof tokens[idx] !== 'string') {
          const dx = tokens[idx], dy = tokens[idx + 1];
          const nx = cmd === 'm' ? cx + dx : dx, ny = cmd === 'm' ? cy + dy : dy;
          segs.push([cx, cy, cx, cy, nx, ny, nx, ny]);
          cx = nx; cy = ny;
          idx += 2;
        }
        continue;
      }
      if (cmd === 'Z' || cmd === 'z') {
        if (cx !== sx || cy !== sy) lineTo(sx, sy);
        cx = sx; cy = sy; px = py = null;
        continue;
      }
      if (cmd === 'A' || cmd === 'a') {
        throw new PathError('arc command A/a not supported (not produced by AI SVG export)');
      }
      const n = NARGS[cmd];
      if (!n) throw new PathError('unsupported command: ' + cmd);
      while (idx + n <= tokens.length && typeof tokens[idx] !== 'string') {
        const a = tokens.slice(idx, idx + n);
        idx += n;
        if (cmd === 'L') lineTo(a[0], a[1]);
        else if (cmd === 'l') lineTo(cx + a[0], cy + a[1]);
        else if (cmd === 'H') lineTo(a[0], cy);
        else if (cmd === 'h') lineTo(cx + a[0], cy);
        else if (cmd === 'V') lineTo(cx, a[0]);
        else if (cmd === 'v') lineTo(cx, cy + a[0]);
        else if (cmd === 'C' || cmd === 'c') {
          const [x1, y1, x2, y2, x, y] = cmd === 'c'
            ? [cx + a[0], cy + a[1], cx + a[2], cy + a[3], cx + a[4], cy + a[5]]
            : a;
          segs.push([cx, cy, x1, y1, x2, y2, x, y]);
          cx = x; cy = y; px = x2; py = y2;
        } else if (cmd === 'S' || cmd === 's') {
          let [x2, y2, x, y] = a;
          if (cmd === 's') { x2 += cx; y2 += cy; x += cx; y += cy; }
          const rx = px !== null ? 2 * cx - px : cx, ry = py !== null ? 2 * cy - py : cy;
          segs.push([cx, cy, rx, ry, x2, y2, x, y]);
          cx = x; cy = y; px = x2; py = y2;
        } else if (cmd === 'Q' || cmd === 'q') {
          let [x1, y1, x, y] = a;
          if (cmd === 'q') { x1 += cx; y1 += cy; x += cx; y += cy; }
          // 二次升三次
          segs.push([cx, cy,
            cx + 2 / 3 * (x1 - cx), cy + 2 / 3 * (y1 - cy),
            x + 2 / 3 * (x1 - x), y + 2 / 3 * (y1 - y),
            x, y]);
          cx = x; cy = y; px = x1; py = y1;
        } else if (cmd === 'T' || cmd === 't') {
          let [x, y] = a;
          if (cmd === 't') { x += cx; y += cy; }
          const qx = px !== null ? 2 * cx - px : cx, qy = py !== null ? 2 * cy - py : cy;
          segs.push([cx, cy,
            cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy),
            x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y),
            x, y]);
          cx = x; cy = y; px = qx; py = qy;
        }
      }
      if (idx < tokens.length && typeof tokens[idx] !== 'string') {
        throw new PathError('trailing numbers without command');
      }
    }
    return segs;
  }

  // ---------- 贝塞尔压平（de Casteljau 自适应细分） ----------

  function flatEnough(p0, p1, p2, p3, tol) {
    const ax = p3[0] - p0[0], ay = p3[1] - p0[1];
    const L = Math.hypot(ax, ay);
    if (L < 1e-12) {
      return Math.max(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]),
        Math.hypot(p2[0] - p0[0], p2[1] - p0[1])) < tol;
    }
    for (const p of [p1, p2]) {
      if (Math.abs((p[0] - p0[0]) * ay - (p[1] - p0[1]) * ax) / L >= tol) return false;
    }
    return true;
  }

  function flatten(segs, tol = FLAT_TOL) {
    if (!segs.length) return [];
    const pts = [segs[0].slice(0, 2)];

    function sub(p0, p1, p2, p3, depth, minDepth) {
      if (minDepth <= 0 && (depth <= 0 || flatEnough(p0, p1, p2, p3, tol))) {
        pts.push(p3);
        return;
      }
      const p01 = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      const p12 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
      const p23 = [(p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2];
      const p012 = [(p01[0] + p12[0]) / 2, (p01[1] + p12[1]) / 2];
      const p123 = [(p12[0] + p23[0]) / 2, (p12[1] + p23[1]) / 2];
      const mid = [(p012[0] + p123[0]) / 2, (p012[1] + p123[1]) / 2];
      sub(p0, p01, p012, mid, depth - 1, minDepth - 1);
      sub(mid, p123, p23, p3, depth - 1, minDepth - 1);
    }

    for (const seg of segs) {
      const p0 = seg.slice(0, 2), p1 = seg.slice(2, 4), p2 = seg.slice(4, 6), p3 = seg.slice(6, 8);
      if (Math.abs(p1[0] - p0[0]) < 1e-12 && Math.abs(p1[1] - p0[1]) < 1e-12 &&
        Math.abs(p2[0] - p3[0]) < 1e-12 && Math.abs(p2[1] - p3[1]) < 1e-12) {
        pts.push(p3);  // 直线退化段
        continue;
      }
      sub(p0, p1, p2, p3, 24, ARC_MIN_DEPTH);
    }
    return pts;
  }

  // ---------- 弧长参数化 ----------

  class ArcPath {
    constructor(pts) {
      const clean = [];
      for (const p of pts) {
        if (!clean.length || Math.hypot(p[0] - clean[clean.length - 1][0],
          p[1] - clean[clean.length - 1][1]) > 1e-9) clean.push(p);
      }
      if (clean.length < 2) throw new PathError('path has fewer than 2 distinct points');
      this.pts = clean;
      this.cum = [0];
      for (let i = 0; i + 1 < clean.length; i++) {
        this.cum.push(this.cum[i] + Math.hypot(clean[i + 1][0] - clean[i][0],
          clean[i + 1][1] - clean[i][1]));
      }
      this.length = this.cum[this.cum.length - 1];
    }

    /** t ∈ [0,1]（归一化弧长）→ [x, y] */
    pointAt(t) {
      if (t < 0 || t > 1) throw new RangeError('t out of [0,1]: ' + t);
      const s = t * this.length;
      let lo = 0, hi = this.cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (this.cum[mid] <= s) lo = mid; else hi = mid;
      }
      const a = this.pts[lo], b = this.pts[lo + 1];
      const seg = this.cum[lo + 1] - this.cum[lo];
      const f = seg < 1e-12 ? 0 : (s - this.cum[lo]) / seg;
      return [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])];
    }

    /** 包围盒 [x0, y0, x1, y1] */
    bbox() {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of this.pts) {
        if (x < x0) x0 = x; if (y < y0) y0 = y;
        if (x > x1) x1 = x; if (y > y1) y1 = y;
      }
      return [x0, y0, x1, y1];
    }

    /** 弧长区间 [t1,t2] 内的折线点列（含端点插值）；t1 > t2 时沿环绕方向（跨 1/0） */
    polylineBetween(t1, t2) {
      if (t1 > t2) {  // 环线环绕段：拆成两段
        return this.polylineBetween(t1, 1).concat(this.polylineBetween(0, t2));
      }
      const out = [];
      const s1 = t1 * this.length, s2 = t2 * this.length;
      let lo = 0, hi = this.cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.cum[mid] <= s1) lo = mid; else hi = mid; }
      out.push(this.pointAt(t1));
      for (let i = lo + 1; i < this.cum.length; i++) {
        if (this.cum[i] >= s2) break;
        out.push(this.pts[i].slice());
      }
      out.push(this.pointAt(t2));
      return out;
    }

    /** 最近点投影：[x,y] → { t, d, p }（t 归一化弧长，d 距离，p 最近点） */
    project(x, y) {
      let best = Infinity, bt = 0, bp = null;
      const n = this.pts.length;
      for (let i = 0; i + 1 < n; i++) {
        const a = this.pts[i], b = this.pts[i + 1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const L2 = dx * dx + dy * dy;
        let f;
        if (L2 < 1e-18) f = 0;
        else f = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
        const qx = a[0] + f * dx, qy = a[1] + f * dy;
        const d2 = (x - qx) * (x - qx) + (y - qy) * (y - qy);
        if (d2 < best) {
          best = d2;
          bp = [qx, qy];
          const segLen = this.cum[i + 1] - this.cum[i];
          bt = (this.cum[i] + f * segLen) / this.length;
        }
      }
      return { t: bt, d: Math.sqrt(best), p: bp };
    }
  }

  function pathFromD(d) {
    return new ArcPath(flatten(parsePath(d)));
  }

  // ---------- GCJ02 偏移（公开标准算法，纯数学；编辑器高德底图对齐用） ----------
  // 国测局加偏为公开近似式，单向：WGS84 → GCJ02（无精确逆式，本项目也用不到逆）。
  // 克拉索夫斯基椭球长半轴 a=6378245、第一偏心率平方 ee=0.00669342162296594323。
  const GCJ_A = 6378245.0;
  const GCJ_EE = 0.00669342162296594323;
  function gcjTransformLat(x, y) {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }
  function gcjTransformLon(x, y) {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
  }
  /** 中国境外判定（算法自带的粗略界守卫；true = 境外，恒等无偏移） */
  function outOfChina(lon, lat) {
    return !(lon > 72.004 && lon < 137.8347 && lat > 0.8293 && lat < 55.8271);
  }
  /** WGS84 → GCJ02：返回 [lon, lat]；境外或非有限输入恒等返回 */
  function wgs84ToGcj02(lon, lat) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return [lon, lat];
    if (outOfChina(lon, lat)) return [lon, lat];
    let dLat = gcjTransformLat(lon - 105.0, lat - 35.0);
    let dLon = gcjTransformLon(lon - 105.0, lat - 35.0);
    const radLat = (lat / 180.0) * Math.PI;
    let magic = Math.sin(radLat);
    magic = 1 - GCJ_EE * magic * magic;
    const sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
    dLon = (dLon * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [lon + dLon, lat + dLat];
  }

  const SHGeom = { parsePath, flatten, ArcPath, pathFromD, PathError, FLAT_TOL, ARC_MIN_DEPTH,
    outOfChina, wgs84ToGcj02 };
  global.SHGeom = SHGeom;
  if (typeof module !== 'undefined' && module.exports) module.exports = SHGeom;
})(typeof globalThis !== 'undefined' ? globalThis : this);
