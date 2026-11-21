#!/usr/bin/env node
// editor.js 纯逻辑层单测：分段簿记（加站/删站/环线环绕）、stopSeq 水位、status 修正、lineIssues、批量命名、
// 站圆预置批量落站（planStopImport/applyStopImport/suggestForStop）。
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

// ---------- 批量命名 planBulkFill ----------
console.log('planBulkFill:');
let bl = mkLine(false);
bl.stops = [
  { id: 'l0001-s01', name: '', t: 0.1 },
  { id: 'l0001-s02', name: '已有名', t: 0.2 },
  { id: 'l0001-s03', name: '   ', t: 0.3 },   // 纯空白视为空名
  { id: 'l0001-s04', name: '', t: 0.4 },
];
let bp = L.planBulkFill(bl, ['甲', '乙', '', '丙', '丁', '戊']);
eq(bp.total, 5, '总名数 = 去空行后的行数');
eq(bp.pairs.map((p) => p[0].id), ['l0001-s01', 'l0001-s03', 'l0001-s04'], '只配给空名站、按站序');
eq(bp.pairs.map((p) => p[1]), ['甲', '乙', '丙'], '名字按序消耗（多余丢弃）');
for (const [st, nm] of bp.pairs) st.name = nm;
eq(bl.stops.map((s) => s.name), ['甲', '已有名', '乙', '丙'], '应用后已命名的未被覆盖');
ok(!L.lineIssues(bl).some((x) => x.includes('站名为空')), '批量命名后无空名告警');
eq(L.planBulkFill(bl, ['己']).pairs.length, 0, '无空名站时无可配对');
let bl2 = mkLine(false);
bl2.stops = [{ id: 'l0001-s01', name: '', t: 0 }, { id: 'l0001-s02', name: '', t: 0.5 }];
eq(L.planBulkFill(bl2, ['一', '二']).pairs.length, 2, '全部空名时可全填');

// ---------- 站圆预置批量落站（fmt/stations-import@1） ----------
console.log('station preset import:');
// 1) 空线全插入
let pi = mkLine(false);
let plan = L.planStopImport(pi, [{ t: 0.1 }, { t: 0.5 }, { t: 0.9 }]);
eq(plan.inserts, [0.1, 0.5, 0.9], '空线：全部接纳、按 t 升序');
eq([plan.skippedExist, plan.skippedConflict, plan.total], [0, 0, 3], '空线：无跳过');
// 2) 已有站 Δt<0.002 跳过（exists 只对照原有站）
let pe = mkLine(false);
pe.stops = [{ id: 'l0001-s01', name: '已在', t: 0.5 }];
plan = L.planStopImport(pe, [{ t: 0.5005 }, { t: 0.51 }, { t: 0.3 }]);
eq(plan.inserts, [0.3, 0.51], '已有站近旁跳过、其余接纳');
eq(plan.skippedExist, 1, '|Δt|<0.002 计 exists');
// 3) 预置彼此过近（环线自交/共线圆）→ conflict
plan = L.planStopImport(mkLine(false), [{ t: 0.3 }, { t: 0.30008 }, { t: 0.30004 }]);
eq(plan.inserts, [0.3], '过近预置圆只落一个');
eq(plan.skippedConflict, 2, '其余计 conflict');
// 4) 越界 t 不计
plan = L.planStopImport(mkLine(false), [{ t: -0.1 }, { t: 1.0 }, { t: 0.5 }]);
eq([plan.total, plan.inserts.length], [1, 1], 't∈[0,1) 之外不计');
// 5) apply：簿记 + 编号 + 空名（建议绝不自动写入）
let pa = mkLine(false);
pa.stops = [{ id: 'l0001-s09', name: '已有名', t: 0.5 }];   // 水位外的既有编号
pa.segments = [];
pa.status = null;
const plan2 = L.planStopImport(pa, [{ t: 0.2, nameSuggestion: '甲' }, { t: 0.7, nameSuggestion: '乙' }]);
const added = L.applyStopImport(pa, plan2);
eq(pa.stops.map((s) => s.t), [0.2, 0.5, 0.7], '插入后 t 严格递增');
eq(pa.segments, ['existing', 'existing'], '段数 = 站数-1');
eq(pa.status, null, '站数≥2 status=null');
eq(added.map((s) => s.id), ['l0001-s10', 'l0001-s11'], '编号从 max(水位,最大后缀)+1 递增');
ok(added.every((s) => s.name === '' && s.geo === null), '新站一律空名（建议不写入）');
ok(pa.stops[1].name === '已有名', '已有站名不被覆盖');
ok(!L.lineIssues({ ...pa, segments: pa.segments }).some((x) => x.includes('t 未递增')), 't 合法');
// 6) 环线：段数 = 站数
let pl = mkLine(true);
L.applyStopImport(pl, L.planStopImport(pl, [{ t: 0.1 }, { t: 0.4 }, { t: 0.8 }]));
eq(pl.segments.length, pl.stops.length, '环线预置落站后段数=站数');
eq(pl.status, null, '环线 status=null');
// 7) 幂等：再跑全 exists
plan = L.planStopImport(pa, [{ t: 0.2 }, { t: 0.7 }]);
eq([plan.inserts.length, plan.skippedExist], [0, 2], '重复导入全部跳过');
// 8) 删一站后簿记仍成立（与 segRemove 联动）
del(pa, pa.stops.findIndex((s) => s.t === 0.5));
eq(pa.segments.length, pa.stops.length - 1, '预置站+删站后段数不变量');
// 9) 整批撤销等价（快照字符串往返）
let pu = mkLine(false);
pu.stops = [{ id: 'l0001-s01', name: '旧站', t: 0.3 }];
pu.segments = [];
const snap = JSON.stringify({ lines: [pu] });
L.applyStopImport(pu, L.planStopImport(pu, [{ t: 0.1 }, { t: 0.6 }, { t: 0.8 }]));
ok(pu.stops.length === 4, '撤销前：已批量落站');
const restored = JSON.parse(snap).lines[0];
eq(restored.stops.length, 1, '撤销（快照还原）后回到 1 站');
eq(restored.stops[0].name, '旧站', '撤销后原站原样');
// 10) 站名建议 suggestForStop
const item = { stops: [
  { t: 0.2, nameSuggestion: '乙站', suggestDist: 20.1 },
  { t: 0.5, nameSuggestion: '甲站', suggestDist: 12.3 },
] };
eq(L.suggestForStop(item, 0.5005).name, '甲站', 't 就近匹配建议');
eq(L.suggestForStop(item, 0.2).name, '乙站', '精确匹配建议');
ok(L.suggestForStop(item, 0.7) === null, '超出 dtEps 无建议');
ok(L.suggestForStop({ stops: [{ t: 0.5 }] }, 0.5) === null, '无 nameSuggestion 不建议');
ok(L.suggestForStop(null, 0.5) === null, '无预置项不崩');

// ---------- 标定变换与瓦片数学（fmt/calibration@1 deg3 / @2 tps，文件存在时） ----------
console.log('calibration:');
const calibFile = require('path').join(__dirname, '..', 'data', 'calibration.json');
if (require('fs').existsSync(calibFile)) {
  const calib = JSON.parse(require('fs').readFileSync(calibFile, 'utf8'));
  const isTps = calib.model === 'tps';
  const pts = isTps
    ? [[1000, 1000], [11000, 1000], [1000, 11000], [11000, 11000], [6000, 6000]]
    : (() => {
      const uv = calib.uv;
      return [
        [uv.cx - uv.scale, uv.cy - uv.scale], [uv.cx + uv.scale, uv.cy - uv.scale],
        [uv.cx - uv.scale, uv.cy + uv.scale], [uv.cx + uv.scale, uv.cy + uv.scale],
        [uv.cx, uv.cy],
      ];
    })();
  for (const [x, y] of pts) {
    const [lon, lat] = L.calibForward(calib, x, y);
    ok(lon > 115 && lon < 125 && lat > 28 && lat < 34,
      `forward 在上海范围（${lon.toFixed(3)}, ${lat.toFixed(3)}）`);
    const back = L.calibInverse(calib, lon, lat);
    const err = back ? Math.hypot(back[0] - x, back[1] - y) : Infinity;
    ok(err < 1e-3, `geo→svg→geo 往返误差 ${err.toExponential(2)} < 1e-3`);
  }
  // 仿射初值本身在合理范围内（供牛顿迭代收敛）
  const affGuess = isTps
    ? [calib.affine.lon[0], calib.affine.lat[0]]
    : (() => {
      const a0 = calib.coef.affineLon, b0 = calib.coef.affineLat;
      return [a0[0] + a0[1] + a0[2], b0[0] + b0[1] + b0[2]];
    })();
  ok(Math.abs(affGuess[0] - 121.5) < 2 && Math.abs(affGuess[1] - 31.2) < 1, 'affine 系数量级合理');
  // 外部真值（6/14/15/23 号线 SVG 弧长点 ↔ GE 描线 KML 对应点，2026-11-21 提取；
  // 2026-11-21 起坐标为 .ai 页面基准——旧框选导出基准 + (4684.9, 4040.53) 平移，
  // 见 tools/ai_parse.py 与《源资产分析-01》）。
  // 往返自洽测试抓不住"基次序转置"类 bug（正逆共享同一错误），必须对真值校验。
  const MPLAT = 111320;
  const TRUTH = [
    { line: '6', x: 7563.4, y: 4813.63, lon: 121.584427, lat: 31.288155 },
    { line: '6', x: 6900.4, y: 5826.03, lon: 121.516461, lat: 31.200513 },
    { line: '14', x: 7183.8, y: 5236.13, lon: 121.543867, lat: 31.249931 },
    { line: '14', x: 5836.8, y: 5260.53, lon: 121.407237, lat: 31.249784 },
    { line: '15', x: 5690.4, y: 5253.63, lon: 121.392325, lat: 31.248055 },
    { line: '15', x: 6108.5, y: 6754.83, lon: 121.43571, lat: 31.114899 },
    { line: '23', x: 6267.1, y: 6811.03, lon: 121.45053, lat: 31.113416 },
    { line: '23', x: 6226.5, y: 7818.53, lon: 121.446027, lat: 31.025531 },
  ];
  for (const p of TRUTH) {
    const [lon, lat] = L.calibForward(calib, p.x, p.y);
    const mPerLon = MPLAT * Math.cos(p.lat * Math.PI / 180);
    const d = Math.hypot((lon - p.lon) * mPerLon, (lat - p.lat) * MPLAT);
    ok(d < 1000, `${p.line} 号线真值点误差 ${d.toFixed(0)} m < 1000 m`);
  }
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
