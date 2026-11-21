#!/usr/bin/env node
// geom.js 与 tools/svg_parse.py 的一致性对拍（node 侧）。
// 用法：node tools/test_geom.js
// 参考：tools/fixtures/geom_ref.json（由 Python 侧生成，见文件尾命令）。

const fs = require('fs');
const path = require('path');
const { pathFromD, wgs84ToGcj02, outOfChina } = require(path.join(__dirname, '..', 'src', 'geom.js'));

const refPath = path.join(__dirname, 'fixtures', 'geom_ref.json');
// 旧框选基准的 4 线导入记录已挪 零散/（防混基准），此处用其固定样张副本做几何对拍（与基准无关）
const impPath = path.join(__dirname, 'fixtures', 'import4.json');

const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
const imp = JSON.parse(fs.readFileSync(impPath, 'utf8'));
const byLayer = Object.fromEntries(imp.paths.map((p) => [p.sourceLayer, p.path]));

let fails = 0;
function ok(cond, msg) {
  if (!cond) { console.log('  FAIL ' + msg); fails++; }
  else console.log('  ok   ' + msg);
}

// ---------- GCJ02 偏移（wgs84ToGcj02/outOfChina；编辑器高德底图逐瓦片对齐用） ----------
console.log('gcj02:');
{
  const MPLAT = 111320;
  const pts = [
    ['人民广场', 121.4737, 31.2304],
    ['浦东', 121.5655, 31.2089],
    ['虹桥', 121.3200, 31.1970],
    ['临港', 121.9100, 30.8700],
    ['嘉定', 121.2650, 31.3770],
  ];
  for (const [nm, lon, lat] of pts) {
    const [glon, glat] = wgs84ToGcj02(lon, lat);
    const mE = (glon - lon) * MPLAT * Math.cos(lat * Math.PI / 180);
    const mN = (glat - lat) * MPLAT;
    const d = Math.hypot(mE, mN);
    ok(d > 300 && d < 700, `${nm} 偏移数百米量级（|Δ|=${d.toFixed(0)} m ∈ (300,700)）`);
    ok(mE > 0 && mN < 0, `${nm} 方向东偏南（东 ${mE.toFixed(0)} m、南 ${(-mN).toFixed(0)} m）`);
  }
  // 境外恒等（东京/伦敦/纽约/界外）
  for (const [lon, lat] of [[139.6917, 35.6895], [-0.1276, 51.5072], [-74.006, 40.7128], [72.0, 31.0]]) {
    const g = wgs84ToGcj02(lon, lat);
    ok(g[0] === lon && g[1] === lat, `境外恒等（${lon}, ${lat}）`);
  }
  ok(outOfChina(139.69, 35.69) === true && outOfChina(121.47, 31.23) === false, 'outOfChina 境内/境外判定');
  // 邻近点平滑：0.01°（约 1 km）间距内偏移场变化 < 10 m（逐瓦片常量偏移近似的依据）
  const a = wgs84ToGcj02(121.47, 31.23);
  const b = wgs84ToGcj02(121.48, 31.23);
  const c = wgs84ToGcj02(121.47, 31.24);
  const dE = Math.abs((b[0] - 0.01) - a[0]) * MPLAT * Math.cos(31.23 * Math.PI / 180);
  const dN = Math.abs((c[1] - 0.01) - a[1]) * MPLAT;
  ok(dE < 10 && dN < 10, `邻近点偏移场平滑（${dE.toFixed(1)} m / ${dN.toFixed(1)} m < 10 m）`);
}

for (const r of ref) {
  const d = byLayer[r.sourceLayer];
  if (!d) { console.log(`FAIL ${r.sourceLayer}: not in import file`); fails++; continue; }
  const ap = pathFromD(d);
  const xs = ap.pts.map((p) => p[0]), ys = ap.pts.map((p) => p[1]);
  const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

  const checks = [
    ['vertices', ap.pts.length, r.vertices, 0],
    ['length', ap.length, r.length, 1e-6],
    ['bbox x0', bbox[0], r.bbox[0], 1e-6],
    ['bbox y0', bbox[1], r.bbox[1], 1e-6],
    ['bbox x1', bbox[2], r.bbox[2], 1e-6],
    ['bbox y1', bbox[3], r.bbox[3], 1e-6],
  ];
  const ts = [0, 0.05, 0.1, 0.25, 0.4, 0.5, 0.62, 0.75, 0.9, 0.99, 1];
  ts.forEach((t, i) => {
    const p = ap.pointAt(t);
    checks.push([`pointAt(${t})[0]`, p[0], r.samples[i][0], 1e-5]);
    checks.push([`pointAt(${t})[1]`, p[1], r.samples[i][1], 1e-5]);
  });

  let bad = 0;
  for (const [name, got, want, tol] of checks) {
    if (Math.abs(got - want) > tol) {
      console.log(`  FAIL ${r.sourceLayer} ${name}: js=${got} py=${want}`);
      bad++;
    }
  }
  if (bad) fails++;
  else console.log(`  ok   ${r.sourceLayer}: ${ap.pts.length} pts, len ${ap.length.toFixed(2)}`);
}

console.log(fails ? `\nFAIL - ${fails} assertion(s)` : '\nPASS - geom.js matches svg_parse.py');
process.exit(fails ? 1 : 0);

// 重新生成参考值：
//   python -c "（见 会话记录 / CLAUDE.md；用 tools/svg_parse.path_from_d 输出 vertices/length/bbox/samples）"
