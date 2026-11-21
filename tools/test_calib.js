#!/usr/bin/env node
// 新旧标定模型与 Python 端的对拍（tools/calib2_fit.py 生成真值）：
//   forward：deg3 / TPS 各 16 点，容差 1e-9 deg；
//   inverse：各 6 点（affine 种子 + 牛顿，与 Python 同口径），容差 1e-3 svg 单位（≈1 cm）；
//   round-trip：JS inverse → forward 残差；附 TPS 单次求值耗时参考（4006 控制点）。
// 用法：node tools/test_calib.js

const fs = require('fs');
const path = require('path');
const L = require(path.join(__dirname, '..', 'src', 'editor.js'));

const root = path.join(__dirname, '..');
const calibTps = JSON.parse(fs.readFileSync(path.join(root, 'data', 'calibration.json'), 'utf8'));
const calibD3 = JSON.parse(fs.readFileSync(path.join(root, 'data', 'calibration-deg3-backup.json'), 'utf8'));
const chk = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'calib_check.json'), 'utf8'));

let fails = 0;
function near(got, want, tol, msg) {
  const d = Math.abs(got - want);
  if (d > tol) { console.log(`  FAIL ${msg}: js=${got} py=${want} |Δ|=${d}`); fails++; }
}

// ---- forward ----
for (const [tag, calib] of [['tps', calibTps], ['deg3', calibD3]]) {
  let n = 0;
  for (const [x, y, lon, lat] of chk[tag].forward) {
    const p = L.calibForward(calib, x, y);
    near(p[0], lon, 1e-9, `${tag} forward lon @(${x},${y})`);
    near(p[1], lat, 1e-9, `${tag} forward lat @(${x},${y})`);
    n++;
  }
  console.log(`  ok?  ${tag} forward ${n} 点（1e-9 deg）${fails ? '' : 'PASS'}`);
}

// ---- inverse ----
for (const [tag, calib] of [['tps', calibTps], ['deg3', calibD3]]) {
  let n = 0;
  for (const [lon, lat, x, y] of chk[tag].inverse) {
    const p = L.calibInverse(calib, lon, lat);
    if (!p) { console.log(`  FAIL ${tag} inverse @(${lon},${lat}): null`); fails++; continue; }
    near(p[0], x, 1e-3, `${tag} inverse x @(${lon},${lat})`);
    near(p[1], y, 1e-3, `${tag} inverse y @(${lon},${lat})`);
    const q = L.calibForward(calib, p[0], p[1]);      // round-trip
    near(q[0], lon, 1e-8, `${tag} roundtrip lon`);
    near(q[1], lat, 1e-8, `${tag} roundtrip lat`);
    n++;
  }
  console.log(`  ok?  ${tag} inverse ${n} 点（1e-3 svg ≈1cm；含 round-trip）${fails ? '' : 'PASS'}`);
}

// ---- 性能参考（非判定项） ----
if (calibTps.model === 'tps') {
  const N = 2000;
  let t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) L.tpsForward(calibTps, 1000 + i * 4, 1000 + i * 3);
  let dt = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  console.log(`  perf tpsForward  ${dt.toFixed(3)} ms/次（${calibTps.controlPoints.length} 控制点）`);
  t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) L.tpsInverse(calibTps, 121.1 + i * 3e-4, 31.1 + i * 2e-4);
  dt = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
  console.log(`  perf tpsInverse  ${dt.toFixed(3)} ms/次`);
}

console.log(fails ? `\nFAIL - ${fails} 项不一致` : '\nPASS - 标定 JS/Python 对拍一致');
process.exit(fails ? 1 : 0);
