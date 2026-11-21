#!/usr/bin/env node
// geom.js 与 tools/svg_parse.py 的一致性对拍（node 侧）。
// 用法：node tools/test_geom.js
// 参考：tools/fixtures/geom_ref.json（由 Python 侧生成，见文件尾命令）。

const fs = require('fs');
const path = require('path');
const { pathFromD } = require(path.join(__dirname, '..', 'src', 'geom.js'));

const refPath = path.join(__dirname, 'fixtures', 'geom_ref.json');
// 旧框选基准的 4 线导入记录已挪 零散/（防混基准），此处用其固定样张副本做几何对拍（与基准无关）
const impPath = path.join(__dirname, 'fixtures', 'import4.json');

const ref = JSON.parse(fs.readFileSync(refPath, 'utf8'));
const imp = JSON.parse(fs.readFileSync(impPath, 'utf8'));
const byLayer = Object.fromEntries(imp.paths.map((p) => [p.sourceLayer, p.path]));

let fails = 0;
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

console.log(fails ? `\nFAIL - ${fails} path(s) differ` : '\nPASS - geom.js matches svg_parse.py');
process.exit(fails ? 1 : 0);

// 重新生成参考值：
//   python -c "（见 会话记录 / CLAUDE.md；用 tools/svg_parse.path_from_d 输出 vertices/length/bbox/samples）"
