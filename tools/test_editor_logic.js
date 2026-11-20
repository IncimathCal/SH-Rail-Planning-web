#!/usr/bin/env node
// editor.js 纯逻辑层单测：分段簿记（加站/删站/环线环绕）、stopSeq 水位、status 修正、lineIssues。
// 用法：node tools/test_editor_logic.js

const L = require(path_join('src', 'editor.js'));
function path_join(...p) { return require('path').join(__dirname, '..', ...p); }

let fails = 0;
function ok(cond, msg) {
  if (!cond) { console.log('  FAIL ' + msg); fails++; }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（got ${JSON.stringify(a)} want ${JSON.stringify(b)}）`); }

function mkLine(loop) {
  return { id: 'l0001', loop, stops: [], segments: [], status: 'future',
    meta: { stopSeq: 0 }, role: 'standalone', groupId: null, connects: [] };
}
function ins(line, i, seq) {  // 模拟 addStop 的簿记部分
  line.stops.splice(i, 0, { id: `l0001-s${String(seq).padStart(2, '0')}`, name: 'x', t: 0, geo: null });
  L.segInsert(line, i);
  L.fixStatusField(line);
}
function del(line, i) {
  L.segRemove(line, i);
  line.stops.splice(i, 1);
  L.fixStatusField(line);
}
function segLen(line) { return line.loop ? line.stops.length : Math.max(line.stops.length - 1, 0); }

// ---------- 非环线：加站 ----------
console.log('non-loop insert:');
let ln = mkLine(false);
ins(ln, 0, 1);
eq(ln.segments, [], '1 站 0 段');
ins(ln, 1, 2);
eq(ln.segments, ['existing'], '2 站 1 段（末端延伸默认 existing）');
ln.segments = ['approved'];
ins(ln, 0, 3);                                    // 首位延伸
eq(ln.segments, ['existing', 'approved'], '首位延伸 unshift');
ln.segments = ['future', 'approved'];
ins(ln, 2, 4);                                    // 末端延伸（3 站时 i=2 是中间！）
// 修正：3 站 [A,B,C] 插 i=2 → 位于 B,C 之间，是中间插入
eq(ln.segments, ['future', 'approved', 'approved'], '中间插入 i=2 分裂继承');
// 真正的末端延伸：4 站插 i=3
let ln2 = mkLine(false);
ins(ln2, 0, 1); ins(ln2, 1, 2); ln2.segments = ['approved'];
ins(ln2, 2, 3);
eq(ln2.segments, ['approved', 'existing'], '末端延伸 push');

// ---------- 非环线：删站 ----------
console.log('non-loop delete:');
let ln3 = mkLine(false);
for (let k = 0; k < 4; k++) ins(ln3, k, k + 1);
ln3.segments = ['existing', 'approved', 'future'];
del(ln3, 0);
eq(ln3.segments, ['approved', 'future'], '删首站 shift');
let ln4 = mkLine(false);
for (let k = 0; k < 4; k++) ins(ln4, k, k + 1);
ln4.segments = ['existing', 'approved', 'future'];
del(ln4, 3);
eq(ln4.segments, ['existing', 'approved'], '删末站 pop');
del(ln4, 1);
eq(ln4.segments, ['approved'], '删中间站合并（保留 seg[i]）');

// ---------- 环线 ----------
console.log('loop:');
let lo = mkLine(true);
ins(lo, 0, 1);
eq(lo.segments, ['existing'], '环线 1 站 1 段');
lo.segments = ['approved'];
ins(lo, 0, 2);
eq(lo.segments, ['approved', 'approved'], '环线 2 站（分裂环绕段继承）');
let lo2 = mkLine(true);
for (let k = 0; k < 3; k++) ins(lo2, k, k + 1);
lo2.segments = ['existing', 'approved', 'future'];
del(lo2, 0);
eq(lo2.segments.length, 2, '环线 3→2 站段数');
del(lo2, 0);
eq(lo2.segments.length, 1, '环线 2→1 站段数');
del(lo2, 0);
eq(lo2.segments, [], '环线 1→0 站段数');

// ---------- 随机不变量 ----------
console.log('randomized invariant:');
for (const loop of [false, true]) {
  let rand = 42; const rnd = () => (rand = (rand * 1103515245 + 12345) % 2147483648) / 2147483648;
  let ln5 = mkLine(loop); let seq = 0; let ops = 0;
  for (let step = 0; step < 500; step++) {
    if (ln5.stops.length === 0 || rnd() < 0.55) {
      const i = Math.floor(rnd() * (ln5.stops.length + 1));
      ins(ln5, i, ++seq); ops++;
    } else {
      del(ln5, Math.floor(rnd() * ln5.stops.length)); ops++;
    }
    ok(ln5.segments.length === segLen(ln5),
      `step${step} loop=${loop} stops=${ln5.stops.length} segs=${ln5.segments.length}`);
    ok(ln5.segments.every((s) => L.SEG_ORDER.includes(s)), `step${step} 枚举合法`);
    if (ln5.stops.length >= 2) ok(ln5.status === null, `step${step} status=null`);
    else ok(!!ln5.status, `step${step} status 非空`);
  }
  ok(ops > 400, '操作数足够');
}

// ---------- stopSeq 水位 ----------
console.log('stopSeq:');
let ln6 = mkLine(false);
delete ln6.meta.stopSeq;
ln6.stops = [{ id: 'l0001-s01' }, { id: 'l0001-s03' }];
eq(L.nextStopSeq(ln6), 4, '无水位时按最大后缀');
eq(L.nextStopSeq(ln6), 5, '递增');
ln6.meta.stopSeq = 10;
eq(L.nextStopSeq(ln6), 11, '水位优先于后缀');
// 删除最大后缀站后不复用
let ln7 = mkLine(false);
ln7.meta.stopSeq = 5;
ln7.stops = [{ id: 'l0001-s05' }];
ln7.stops.pop();
eq(L.nextStopSeq(ln7), 6, '删除后不复用已分配编号');

// ---------- lineIssues ----------
console.log('lineIssues:');
let bad = mkLine(false);
bad.stops = [
  { id: 'l0001-s01', name: 'a', t: 0.1 },
  { id: 'l0001-s02', name: '', t: 0.2 },
  { id: 'l0001-s03', name: 'c', t: 0.15 },
];
bad.segments = ['existing'];
bad.status = 'future';
const iss = L.lineIssues(bad);
ok(iss.some((x) => x.includes('站名为空')), '检出空站名');
ok(iss.some((x) => x.includes('t 未递增')), '检出 t 未递增');
ok(iss.some((x) => x.includes('segments 长度')), '检出段数不符');
ok(iss.some((x) => x.includes('status 应为 null')), '检出 status 应为 null');

let good = mkLine(false);
good.stops = [
  { id: 'l0001-s01', name: 'a', t: 0.1 },
  { id: 'l0001-s02', name: 'b', t: 0.2 },
];
good.segments = ['existing'];
good.status = null;
eq(L.lineIssues(good), [], '合格线路无 issue');

let conn = mkLine(false);
conn.role = 'connector'; conn.status = 'future';
conn.connects = ['l0002'];
ok(L.lineIssues(conn).some((x) => x.includes('connects')), 'connector 数量检查');
let mainNoGroup = mkLine(false);
mainNoGroup.role = 'main';
ok(L.lineIssues(mainNoGroup).some((x) => x.includes('线组')), 'main 需线组检查');

// ---------- 标定变换与瓦片数学（fmt/calibration@1，文件存在时） ----------
console.log('calibration:');
const calibFile = require('path').join(__dirname, '..', 'data', 'calibration.json');
if (require('fs').existsSync(calibFile)) {
  const calib = JSON.parse(require('fs').readFileSync(calibFile, 'utf8'));
  const uv = calib.uv;
  const pts = [
    [uv.cx - uv.scale, uv.cy - uv.scale], [uv.cx + uv.scale, uv.cy - uv.scale],
    [uv.cx - uv.scale, uv.cy + uv.scale], [uv.cx + uv.scale, uv.cy + uv.scale],
    [uv.cx, uv.cy],
  ];
  for (const [x, y] of pts) {
    const [lon, lat] = L.calibForward(calib, x, y);
    ok(lon > 115 && lon < 125 && lat > 28 && lat < 34,
      `forward 在上海范围（${lon.toFixed(3)}, ${lat.toFixed(3)}）`);
    const back = L.calibInverse(calib, lon, lat);
    const err = back ? Math.hypot(back[0] - x, back[1] - y) : Infinity;
    ok(err < 1e-3, `geo→svg→geo 往返误差 ${err.toExponential(2)} < 1e-3`);
  }
  // 仿射初值本身在合理范围内（供牛顿迭代收敛）
  const affGuess = (() => {
    const a0 = calib.coef.affineLon, b0 = calib.coef.affineLat;
    return [a0[0] + a0[1] + a0[2], b0[0] + b0[1] + b0[2]];
  })();
  ok(Math.abs(affGuess[0] - 121.5) < 2 && Math.abs(affGuess[1] - 31.2) < 1, 'affine 系数量级合理');
  // 瓦片数学往返
  for (const [lon, lat] of [[121.46, 31.18], [121.9, 31.35], [120.85, 30.68]]) {
    for (const z of [5, 10, 14]) {
      const x = L.lonToTileX(lon, z), y = L.latToTileY(lat, z);
      ok(Math.abs(L.tileXToLon(x, z) - lon) < 1e-9, `lon 瓦片往返 z=${z}`);
      ok(Math.abs(L.tileYToLat(y, z) - lat) < 1e-9, `lat 瓦片往返 z=${z}`);
    }
  }
  ok(L.latToTileY(85.05, 8) < 1 && L.latToTileY(-85.05, 8) > 255, 'lat→tileY 方向（北小南大）');
} else {
  console.log('  (data/calibration.json 不存在，跳过标定用例)');
}

console.log(fails ? `\nFAIL - ${fails} assertion(s)` : '\nPASS - editor logic OK');
process.exit(fails ? 1 : 0);
