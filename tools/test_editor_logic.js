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

// ---------- 分段状态区间设定 applySegRange / 区间汇总 segRangeSummary（2026-11-21 撤点段循环改左栏区间） ----------
console.log('applySegRange:');
// 非环线站数 = 段数+1；环线站数 = 段数
function mkSegLine(loop, segs) {
  const nStops = loop ? segs.length : segs.length + 1;
  const l = mkLine(loop);
  l.stops = Array.from({ length: nStops }, (_, k) =>
    ({ id: `l0001-s${String(k + 1).padStart(2, '0')}`, name: 'x', t: k / nStops, geo: null }));
  l.segments = segs.slice();
  l.status = null;
  return l;
}
// 非环线普通区间：站 2→4 覆盖 seg[1..2]
let sr = mkSegLine(false, ['existing', 'existing', 'existing', 'existing']);
ok(L.applySegRange(sr, 2, 4, 'approved') === true, '非环线普通区间成功');
eq(sr.segments, ['existing', 'approved', 'approved', 'existing'], '站 2→4 只改中间两段');
// 非环线 a>=b 拒绝（反向与 a===b），拒绝时数据不动
sr = mkSegLine(false, ['existing', 'existing', 'existing']);
ok(L.applySegRange(sr, 3, 2, 'future') === false, '非环线 a>b 拒绝');
ok(L.applySegRange(sr, 2, 2, 'future') === false, '非环线 a===b 拒绝');
eq(sr.segments, ['existing', 'existing', 'existing'], '拒绝时数据不动');
// 环线 a>b＝跨环绕段方向：n=5，站 5→2 覆盖 seg[4]（环绕段）与 seg[0]
let sl = mkSegLine(true, ['existing', 'existing', 'existing', 'existing', 'existing']);
ok(L.applySegRange(sl, 5, 2, 'future') === true, '环线 a>b 跨环绕成功');
eq(sl.segments, ['future', 'existing', 'existing', 'existing', 'future'], '5→2 恰覆盖环绕段＋首段');
ok(L.applySegRange(sl, 3, 3, 'approved') === false, '环线 a===b 拒绝');
// 环线 a<b 不跨环绕段
sl = mkSegLine(true, ['existing', 'existing', 'existing']);
ok(L.applySegRange(sl, 1, 3, 'approved') === true, '环线 a<b 成功');
eq(sl.segments, ['approved', 'approved', 'existing'], '环线 1→3 不动环绕段 seg[2]');
// 越界拒绝（0 / n+1；环线与非环线各一）
ok(L.applySegRange(mkSegLine(false, ['existing']), 0, 2, 'future') === false, '非环线 a=0 越界拒绝');
ok(L.applySegRange(mkSegLine(false, ['existing']), 1, 3, 'future') === false, '非环线 b=n+1 越界拒绝');
ok(L.applySegRange(mkSegLine(true, ['existing', 'existing']), 6, 1, 'future') === false, '环线 a=n+1 越界拒绝');
// 端点全区间
sr = mkSegLine(false, ['existing', 'approved', 'future']);
ok(L.applySegRange(sr, 1, 4, 'future') === true, '非环线端点全区间成功');
eq(sr.segments, ['future', 'future', 'future'], '站 1→末站覆盖全部段');
sl = mkSegLine(true, ['existing', 'approved', 'future']);
ok(L.applySegRange(sl, 2, 1, 'approved') === true, '环线跨环绕端点区间成功（2→1）');
eq(sl.segments, ['existing', 'approved', 'approved'], '环线 2→1 覆盖 seg[1]＋环绕段（任意 a≠b 至多 n-1 段）');
// 其余非法：枚举 / 非整数 / 0 站 / 段表长度不符
ok(L.applySegRange(mkSegLine(false, ['existing']), 1, 2, 'weird') === false, '非法枚举拒绝');
ok(L.applySegRange(mkSegLine(false, ['existing']), 1.5, 2, 'future') === false, '非整数站序拒绝');
ok(L.applySegRange(mkLine(false), 1, 2, 'future') === false, '0 站拒绝');
let sBad = mkSegLine(false, ['existing', 'existing', 'existing']);
sBad.segments = ['existing'];
ok(L.applySegRange(sBad, 1, 2, 'future') === false, '段表长度与站数不符拒绝');

console.log('segRangeSummary:');
eq(L.segRangeSummary(mkSegLine(false, ['existing', 'approved', 'approved', 'future'])),
  '1–2 既有；2–4 已批复；4–5 远期', '非环线相邻同状态段合并为区间');
eq(L.segRangeSummary(mkSegLine(true, ['approved', 'future', 'future', 'existing'])),
  '2–4 远期；4–1 既有（含环绕段）；1–2 已批复', '环线跨环绕合并并标注环绕段');
eq(L.segRangeSummary(mkSegLine(true, ['existing', 'existing'])), '全线 既有（含环绕段）', '环线全线同状态');
ok(L.segRangeSummary(mkSegLine(false, [])) === null, '站数<2 返回 null');

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
// 4) 越界 t 不计（域 [0,1] 双闭，2026-11-21：t=1 计入，仅负值/超 1 不计）
plan = L.planStopImport(mkLine(false), [{ t: -0.1 }, { t: 1.0 }, { t: 0.5 }]);
eq([plan.total, plan.inserts], [2, [0.5, 1]], 't=1 合法计入、负值不计');
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
// 11) t=1 合法（域改 [0,1] 双闭，2026-11-21）：落末位、簿记成立、不触发递增告警
let pt = mkLine(false);
pt.stops = [{ id: 'l0001-s01', name: 'a', t: 0.3 }];
pt.segments = [];
L.applyStopImport(pt, L.planStopImport(pt, [{ t: 1 }]));
eq(pt.stops.map((s) => s.t), [0.3, 1], 't=1 落末位');
eq(pt.segments.length, pt.stops.length - 1, 't=1 落站后段数不变量');
ok(!L.lineIssues(pt).some((x) => x.includes('t 未递增')), 't=1 不触发递增告警');

// ---------- 线路分类分组 layerGroupsOf（meta.layer；2026-11-21） ----------
console.log('layerGroupsOf:');
const mkL = (id, layer) => ({ id, name: '', color: '#888', stops: [],
  meta: layer === undefined ? {} : { layer } });
let lgr = L.layerGroupsOf([mkL('l0003', '联络线'), mkL('l0001', '市区线'), mkL('l0002'),
  mkL('l0004', '市区线'), mkL('l0005', ''), mkL('l0006', 7)]);
eq(lgr.map((x) => x.layer), ['联络线', '市区线', null], '组序＝拼音序（联<市）、未分类最后');
eq(lgr[0].lines.map((l) => l.id), ['l0003'], '组内成员正确');
eq(lgr[1].lines.map((l) => l.id), ['l0001', 'l0004'], '组内按 id 升序');
eq(lgr[2].lines.map((l) => l.id), ['l0002', 'l0005', 'l0006'], '缺失/空串/非字符串都归未分类');
eq(L.layerGroupsOf([mkL('l0001', '市区线')]).map((x) => x.layer), ['市区线'], '仅一类也照常返回组（组头一致显示）');
eq(L.layerGroupsOf([]), [], '空列表返回空');

// ---------- 接轨站描边色 junctionStroke（stationGroups type:'junction'；2026-11-21） ----------
console.log('junctionStroke:');
eq(L.junctionStroke([{ role: 'branch', color: '#A' }, { role: 'main', color: '#B' }]), '#B', 'main 胜 branch（用户明定）');
eq(L.junctionStroke([{ role: 'connector', color: '#A' }, { role: 'branch', color: '#B' }]), '#B', 'branch 胜 connector（非联络线胜联络线，用户明定）');
eq(L.junctionStroke([{ role: 'connector', color: '#A' }, { role: 'standalone', color: '#B' }]), '#B', 'standalone 胜 connector');
eq(L.junctionStroke([{ role: 'standalone', color: '#A' }, { role: 'branch', color: '#B' }]), '#A', 'standalone 胜 branch（实现假设，待用户确认）');
eq(L.junctionStroke([{ role: 'main', color: '#A' }, { role: 'main', color: '#B' }]), '#A', '同优先级取先出现者');
eq(L.junctionStroke([{ role: 'weird', color: '#A' }, { role: 'main', color: '#B' }]), '#B', '未知角色跳过');
eq(L.junctionStroke([{ role: 'main', color: '' }, { role: 'branch', color: '#B' }]), '#B', '空色成员跳过取次优');
eq(L.junctionStroke([{ role: 'main' }]), '#000', '成员无 color 退默认黑');
eq(L.junctionStroke([]), '#000', '空成员退默认黑');
eq(L.junctionStroke(null), '#000', 'null 不崩');

// ---------- 线路所 stop.kind:'block'（2026-11-21）：编组约束 planStationGroup ----------
console.log('planStationGroup:');
eq(L.planStationGroup([null, null]), { ok: true, type: 'same-station', allBlock: false }, '全普通站→默认同站');
eq(L.planStationGroup(['block', 'block']), { ok: true, type: 'junction', allBlock: true }, '全线路所→强制接轨站');
eq(L.planStationGroup(['block']), { ok: true, type: 'junction', allBlock: true }, '单个线路所也判 junction（≥2 由调用方把门）');
eq(L.planStationGroup(['block', null, 'block']), { ok: false, reason: 'mixed' }, '混选拒绝');
eq(L.planStationGroup([null, undefined, '']), { ok: true, type: 'same-station', allBlock: false }, '缺省/undefined/空串都算普通站');
eq(L.planStationGroup([]), { ok: true, type: 'same-station', allBlock: false }, '空列表不崩');

// ---------- 线路所：lineIssues 空名合法 / planBulkFill 跳过 ----------
console.log('block stop isolation:');
let bl3 = mkLine(false);
bl3.stops = [
  { id: 'l0001-s01', name: 'a', t: 0.1 },
  { id: 'l0001-s02', kind: 'block', name: '', t: 0.2 },
  { id: 'l0001-s03', name: '', t: 0.3 },
];
bl3.segments = ['existing', 'existing'];
bl3.status = null;
ok(!L.lineIssues(bl3).some((x) => x.includes('s02')), '线路所空名不报 issue');
ok(L.lineIssues(bl3).some((x) => x.includes('s03 站名为空')), '普通站空名照报');
let bp3 = L.planBulkFill(bl3, ['甲', '乙']);
eq(bp3.pairs.map((p) => p[0].id), ['l0001-s03'], '批量命名跳过线路所');
eq(bp3.pairs.map((p) => p[1]), ['甲'], '名字不被线路所消耗');
let bl4 = mkLine(false);
bl4.stops = [{ id: 'l0001-s01', kind: 'block', name: '', t: 0.5 }];
eq(L.planBulkFill(bl4, ['甲']).pairs.length, 0, '全线仅线路所时批量命名无可配对');

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
