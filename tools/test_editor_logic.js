#!/usr/bin/env node
// editor.js 纯逻辑层单测：分段实体（fmt/line@2：加删站索引簿记、切分/并段/区间/约束检测、@1→@2 迁移）、
// stopSeq 水位、status 修正、lineIssues、批量命名、站圆预置批量落站（planStopImport/applyStopImport/suggestForStop）、
// 出省箭头（kind:'arrow' 落位/编组/命名/校验）、多线换乘药丸串法（planGroupPillChain 确定性）、
// 线路显示顺序（normalizeLineOrder：缺省回退/序列化补全/新建追加/失效清理/删除移除）、
// 站类型循环切换（nextStopKind：三种位置 × 各起点）、站数<2 缺 status 载入兜底（2026-11-22）、
// 联络线有效目标判定（connValidTargets：2026-11-22 取消颜色属性改由所联络两线决定）。
// 用法：node tools/test_editor_logic.js

const L = require(path_join('src', 'editor.js'));
function path_join(...p) { return require('path').join(__dirname, '..', ...p); }

let fails = 0;
function ok(cond, msg) {
  if (!cond) { console.log('  FAIL ' + msg); fails++; }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（got ${JSON.stringify(a)} want ${JSON.stringify(b)}）`); }

function mkLine(loop) {
  return { id: 'l0001', loop, stops: [], segments: [], sections: [], status: 'future',
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
function segLen(line) { return line.stops.length >= 2 ? (line.loop ? line.stops.length : line.stops.length - 1) : 0; }
/** 按段状态数组构造分段实体（借用 @1→@2 迁移：连续同状态并段、name 全空） */
function setSecs(line, arr) {
  line.segments = arr.slice();
  line.schema = 'fmt/line@1';
  L.migrateLineToV2(line);
  return line;
}
/** 造 n 站线（t 均布）再按段状态数组设分段（非环线站数 = 段数+1；环线站数 = 段数） */
function mkSecLine(loop, arr) {
  const l = mkLine(loop);
  const nStops = loop ? arr.length : arr.length + 1;
  l.stops = Array.from({ length: nStops }, (_, k) =>
    ({ id: `l0001-s${String(k + 1).padStart(2, '0')}`, name: 'x', t: k / nStops, geo: null }));
  setSecs(l, arr);
  l.status = null;
  return l;
}
const secStatuses = (l) => (l.sections || []).map((s) => s.status);

// ---------- 非环线：加站（索引簿记＋端部继承相邻段） ----------
console.log('non-loop insert:');
let ln = mkLine(false);
ins(ln, 0, 1);
eq(ln.segments, [], '1 站 0 段（站数<2 分段为空）');
eq(ln.sections, [], '1 站 sections 空');
ins(ln, 1, 2);
eq(ln.segments, [0], '2 站 1 段（<2→≥2 跨界建默认分段，segments 全 0）');
eq(ln.sections, [{ name: '', status: 'future' }], '默认分段 name 空、状态继承线路级');
eq(ln.status, null, '站数≥2 status=null');
setSecs(ln, ['approved']);                       // 改成 1 段已批复
eq(ln.sections, [{ name: '', status: 'approved' }], 'setSecs 构造');
ins(ln, 0, 3);                                   // 首位延伸
eq(ln.segments, [0, 0], '首位延伸继承相邻段（旧版默认 existing 已废除）');
eq(secStatuses(ln), ['approved'], '延伸不开新段');
let ln2 = mkLine(false);
ins(ln2, 0, 1); ins(ln2, 1, 2); setSecs(ln2, ['approved']);
ins(ln2, 2, 3);                                  // 末端延伸
eq(ln2.segments, [0, 0], '末端延伸继承相邻段');
let ln3 = mkLine(false);
for (let k = 0; k < 3; k++) ins(ln3, k, k + 1);
setSecs(ln3, ['future', 'approved']);
ins(ln3, 2, 4);                                  // 3 站 [A,B,C] 插 i=2 → B,C 之间＝中间插入
eq(ln3.segments, [0, 1, 1], '中间插入分裂继承（两半保留原索引）');

// ---------- 非环线：删站（合并＋空段清理重编号） ----------
console.log('non-loop delete:');
let ln4 = mkLine(false);
for (let k = 0; k < 4; k++) ins(ln4, k, k + 1);
setSecs(ln4, ['existing', 'approved', 'future']);   // 段 [0,1,2]
del(ln4, 0);
eq(ln4.segments, [0, 1], '删首站 shift＋重编号');
eq(secStatuses(ln4), ['approved', 'future'], '失去引用的首段被清理');
let ln5 = mkLine(false);
for (let k = 0; k < 4; k++) ins(ln5, k, k + 1);
setSecs(ln5, ['existing', 'approved', 'future']);
del(ln5, 3);                                    // 删末站：pop 掉 future 段
eq(ln5.segments, [0, 1], '删末站 pop（末段被清理）');
eq(secStatuses(ln5), ['existing', 'approved'], '清理后段状态');
del(ln5, 1);                                    // 删中间站：existing 与 approved 合并（保留 seg[i]=approved）
eq(ln5.segments, [0], '删中间站合并＋级联空段清理');
eq(secStatuses(ln5), ['approved'], '合并保留 seg[i] 段、另一段级联清理');

// ---------- 环线 ----------
console.log('loop:');
let lo = mkLine(true);
ins(lo, 0, 1);
eq(lo.segments, [], '环线 1 站 0 段（站数<2 分段为空）');
ins(lo, 0, 2);
eq(lo.segments, [0, 0], '环线 2 站（原环绕段分裂，两半继承默认段）');
setSecs(lo, ['approved', 'future']);
ins(lo, 0, 3);                                  // 分裂环绕段（新站 t 小于首站）
eq(lo.segments, [1, 0, 1], '环绕段分裂：尾半占首位、头半留末位，中间整体后移（[W,old..,W]）');
// 回归（2026-11-21）：环线插/删首站簿记曾整体错位一格（旧 [old..,W,W] / [old 原地]）
let lo3 = mkSecLine(true, ['existing', 'approved', 'future']);   // 3 站 [0,1,2]
ins(lo3, 0, 4);                                                  // t < 首站 → 落环绕弧
eq(lo3.segments, [2, 0, 1, 2], '环线 i=0 插站：[W,old0,old1,W]（旧版错位为 [0,1,2,2]）');
eq(L.sectionIssuesOf(lo3).length, 0, '环线 i=0 插站后约束仍成立（W 跨环绕成块）');
let lo4 = mkSecLine(true, ['existing', 'approved', 'future', 'existing']);   // 4 站 [0,1,2,3]
del(lo4, 0);
eq(lo4.segments, [1, 2, 0], '环线 i=0 删站：[g1..g(n-2),g0]，合并环绕段落末位（旧版错位为 [0,1,2]）');
eq(L.sectionIssuesOf(lo4).length, 0, '环线 i=0 删站后约束仍成立');
let lo2 = mkLine(true);
for (let k = 0; k < 3; k++) ins(lo2, k, k + 1);
setSecs(lo2, ['existing', 'approved', 'future']);
del(lo2, 0);
eq(lo2.segments.length, 2, '环线 3→2 站段数');
eq(L.sectionIssuesOf(lo2).length, 0, '环线删站后分段约束仍成立');
del(lo2, 0);
eq(lo2.segments, [], '环线 2→1 站（站数<2 分段清空）');
del(lo2, 0);
eq(lo2.segments, [], '环线 1→0 站分段保持空');

// ---------- @1→@2 迁移 migrateLineToV2 ----------
console.log('migrateLineToV2:');
let mg = mkSecLine(false, ['existing', 'existing', 'approved']);
eq(mg.schema, 'fmt/line@2', '@1 迁移后写 @2');
eq(mg.sections, [{ name: '', status: 'existing' }, { name: '', status: 'approved' }], '连续同状态并段、name 全空');
eq(mg.segments, [0, 0, 1], 'segments 改为块索引');
eq(L.migrateLineToV2(mg), 0, '已是 @2 再跑不动');
eq(mg.segments, [0, 0, 1], '重跑幂等（数据不变）');
let mg2 = mkLine(false);
mg2.schema = 'fmt/line@1';
eq(L.migrateLineToV2(mg2), 0, '空 segments 迁移 0 段');
eq([mg2.schema, mg2.sections, mg2.segments], ['fmt/line@2', [], []], '空线迁移结果');
let mg3 = mkSecLine(true, ['existing', 'future', 'existing']);
eq(mg3.sections.length, 3, '环线环绕两端同状态不自动跨环绕合并（合法，可手动并段）');
let mg4 = mkLine(false);
mg4.schema = 'fmt/line@2';
mg4.segments = ['existing', 'future'];
L.migrateLineToV2(mg4);
eq([mg4.schema, mg4.segments, secStatuses(mg4)], ['fmt/line@2', [0, 1], ['existing', 'future']], '@2 但混入字符串元素仍迁移');
let mg5 = mkLine(false);
mg5.schema = 'fmt/line@1';
mg5.segments = ['weird', 'future'];
L.migrateLineToV2(mg5);
eq(secStatuses(mg5), ['existing', 'future'], '非法枚举按 existing 兜底');
eq(mg5.segments, [0, 1], '兜底后索引正常');

// ---------- 切分 planSectionSplit ----------
console.log('planSectionSplit:');
let sp = mkSecLine(false, ['existing', 'existing', 'existing']);   // 4 站
ok(L.planSectionSplit(sp, 2) === true, '非环线站 2 切分成功');
eq(sp.segments, [0, 1, 1], '右半块改挂新段（自边界至块尾）');
eq(sp.sections, [{ name: '', status: 'existing' }, { name: '', status: 'existing' }], '新段名空、状态继承原段');
eq(L.sectionIssuesOf(sp).length, 0, '切分后约束成立');
ok(L.planSectionSplit(sp, 2) === false, '站 2 两侧已不同段：无操作');
eq(sp.segments, [0, 1, 1], '无操作数据不动');
ok(L.planSectionSplit(sp, 1) === false, '非环线 k=1 越界拒绝');
ok(L.planSectionSplit(sp, 4) === false, '非环线 k=n 越界拒绝');
ok(L.planSectionSplit(mkLine(false), 1) === false, '站数<2 拒绝');
ok(L.planSectionSplit(sp, 1.5) === false, '非整数站序拒绝');
// 连续切分：新段插在原段之后（段序＝线路序），更大索引整体 +1
let sp2 = mkSecLine(false, ['existing', 'existing', 'existing']);
L.planSectionSplit(sp2, 3);   // → 段 [0,0,1]
L.planSectionSplit(sp2, 2);   // 再在站 2 切中段
eq(sp2.segments, [0, 1, 2], '连续切分索引重排（插入式而非 append）');
eq(secStatuses(sp2), ['existing', 'existing', 'existing'], '三段状态继承');
eq(L.sectionSpanOf(sp2, 0), [1, 2], '段 0 覆盖站 1–2');
eq(L.sectionSpanOf(sp2, 1), [2, 3], '段 1 覆盖站 2–3');
eq(L.sectionSpanOf(sp2, 2), [3, 4], '段 2 覆盖站 3–4');
eq(L.sectionIssuesOf(sp2).length, 0, '连续切分后约束成立');
// 环线：k=1＝环绕段与首段分家（含覆盖全环的单段——右半块不得吞掉环绕段成空段）
let sl = mkSecLine(true, ['existing', 'existing', 'existing']);
ok(L.planSectionSplit(sl, 1) === true, '环线 k=1（全环单段在环绕边界切分）成功');
eq(sl.segments, [1, 1, 0], '环绕段独留原段、其余改挂新段');
eq(L.sectionIssuesOf(sl).length, 0, '全环切分后无空段');
eq(L.sectionSpanOf(sl, 1), [1, 3], '新段覆盖站 1–3');
eq(L.sectionSpanOf(sl, 0), [3, 1], '原段覆盖站 3–1（经环绕段）');
let sl2 = mkSecLine(true, ['existing', 'existing', 'existing', 'existing']);   // 全环单段
L.planSectionSplit(sl2, 3);   // 站 3 切：右半块自 seg2 起绕环绕段到 seg1 → segs [1,0,1,1]（NEW 块跨环绕）
eq(sl2.segments, [1, 0, 1, 1], '全环切分后右半块可绕环绕段成块');
ok(L.planSectionSplit(sl2, 1) === true, '环线 k=1（跨环绕块在环绕边界再切）成功');
eq(sl2.segments, [2, 0, 1, 1], '再切只改右半块首段（新段插在原段后）');
eq(secStatuses(sl2), ['existing', 'existing', 'existing'], '三段全继承 existing');
eq(L.sectionIssuesOf(sl2).length, 0, '跨环绕两次切分后约束成立');
let sl3 = mkSecLine(true, ['approved', 'existing', 'existing', 'existing']);   // 段 [0,1,1,1]
ok(L.planSectionSplit(sl3, 4) === true, '环线 k=n（末段边界）成功');
eq(sl3.segments, [0, 1, 1, 2], '右半块＝环绕段独立成新段');
eq(L.sectionIssuesOf(sl3).length, 0, '环线末段边界切分后约束成立');
eq(L.sectionSpanOf(sl3, 2), [4, 1], '新段覆盖站 4–1（经环绕段）');

// ---------- 并段 applySectionMerge ----------
console.log('applySectionMerge:');
let mr = mkSecLine(false, ['existing', 'approved', 'future']);
ok(L.applySectionMerge(mr, 0) === true, '段 0 并段 1 成功');
eq(mr.segments, [0, 0, 1], '下一段索引改写为 0、更大索引减一');
eq(mr.sections, [{ name: '', status: 'existing' }, { name: '', status: 'future' }], '删下一段、名称与状态取段 0');
ok(L.applySectionMerge(mr, 1) === false, '非环线末段无下一段拒绝');
eq(mr.segments, [0, 0, 1], '拒绝时数据不动');
ok(L.applySectionMerge(mkSecLine(false, ['existing']), 0) === false, '仅 1 段无可并拒绝');
ok(L.applySectionMerge(mr, -1) === false, '段号越界拒绝');
ok(L.applySectionMerge(mr, 9) === false, '段号超界拒绝');
// 环线末段的下一段＝段 0（并完删段 0、全体减一）
let ml = mkSecLine(true, ['existing', 'approved', 'future']);
ml.sections[2].name = '丙段';
ok(L.applySectionMerge(ml, 2) === true, '环线末段并首段成功');
eq(ml.segments, [1, 0, 1], '原段 0 改挂末段（落到新 1）、其余减一');
eq(ml.sections, [{ name: '', status: 'approved' }, { name: '丙段', status: 'future' }], '保留末段名/状态、删段 0');
eq(L.sectionIssuesOf(ml).length, 0, '环线环绕并段后约束成立');
// 切分后并段（段序＝线路序下相邻段恒线路相邻）
let mp = mkSecLine(false, ['existing', 'existing', 'existing']);
L.planSectionSplit(mp, 3);
L.planSectionSplit(mp, 2);   // 段 [A,NEW,A2] = [0,1,2,2]
ok(L.applySectionMerge(mp, 1) === true, '中段并末段成功');
eq(mp.segments, [0, 1, 1], '并段后仍连续成块');
eq(L.sectionIssuesOf(mp).length, 0, '并段后约束成立');

// ---------- 区间汇总 sectionSpanOf ----------
console.log('sectionSpanOf:');
let ss = mkSecLine(false, ['existing', 'existing', 'approved']);   // 4 站
eq(L.sectionSpanOf(ss, 0), [1, 3], '非环线段 0：站 1–3');
eq(L.sectionSpanOf(ss, 1), [3, 4], '非环线段 1：站 3–4');
let ss2 = mkSecLine(true, ['approved', 'existing', 'existing']);   // 环线 3 站
eq(L.sectionSpanOf(ss2, 0), [1, 2], '环线段 0：站 1–2');
eq(L.sectionSpanOf(ss2, 1), [2, 1], '环线段 1：站 2–1（经环绕段）');
let ss3 = mkSecLine(true, ['existing', 'existing', 'existing']);
eq(L.sectionSpanOf(ss3, 0), [1, 1], '环线全环单段：站 1–1（经环绕段＝全线）');
ok(L.sectionSpanOf(ss, -1) === null, '段号负拒绝');
ok(L.sectionSpanOf(ss, 9) === null, '段号超界拒绝');
ok(L.sectionSpanOf(mkLine(false), 0) === null, '站数<2 拒绝');

// ---------- 约束检测 sectionIssuesOf（越界/空段/分离块/<2 非空） ----------
console.log('sectionIssuesOf:');
eq(L.sectionIssuesOf(mkSecLine(false, ['existing', 'approved'])), [], '合法多段无 issue');
eq(L.sectionIssuesOf(mkSecLine(true, ['existing', 'approved'])), [], '合法环线多段无 issue');
eq(L.sectionIssuesOf(mkSecLine(true, ['approved', 'existing', 'existing'])), [], '环线跨环绕连续块合法');
let c1 = mkSecLine(false, ['existing', 'approved']);
c1.segments = [0, 5];
ok(L.sectionIssuesOf(c1).some((x) => x.includes('越界')), '分段索引越界检出');
let c2 = mkSecLine(false, ['existing', 'approved']);
c2.sections.push({ name: '', status: 'future' });
ok(L.sectionIssuesOf(c2).some((x) => x.includes('空段')), '空段检出');
let c3 = mkSecLine(false, ['existing', 'approved', 'existing']);
c3.sections = c3.sections.slice(0, 2);
c3.segments = [0, 1, 0];
ok(L.sectionIssuesOf(c3).some((x) => x.includes('不连续')), '非环线分离块检出');
let c4 = mkSecLine(true, ['existing', 'approved', 'existing', 'approved']);
c4.sections = c4.sections.slice(0, 2);   // [existing, approved]
c4.segments = [0, 1, 0, 1];              // 环形序下两段各分离为两块
ok(L.sectionIssuesOf(c4).some((x) => x.includes('不连续')), '环线分离块检出');
let c5 = mkLine(false);
c5.sections = [{ name: '', status: 'existing' }];
ok(L.sectionIssuesOf(c5).some((x) => x.includes('sections 应为空')), '站数<2 sections 非空检出');
let c6 = mkLine(false);
c6.segments = [0];
ok(L.sectionIssuesOf(c6).some((x) => x.includes('segments 应为空')), '站数<2 segments 非空检出');
let c7 = mkSecLine(false, ['existing', 'existing']);
c7.segments = [0];                       // 长度不符
ok(L.sectionIssuesOf(c7).some((x) => x.includes('segments 长度')), '段表长度不符检出');
let c8 = mkSecLine(false, ['existing']);
c8.sections = [];
ok(L.sectionIssuesOf(c8).some((x) => x.includes('sections 不得为空')), '站数≥2 sections 空检出');

// ---------- fixStatusField 跨界回落 ----------
console.log('fixStatusField:');
let fx = mkSecLine(false, ['approved', 'future']);   // 3 站
del(fx, 2); del(fx, 1);                               // 从末尾删到 1 站（首段 approved 保留到回落）
eq(fx.status, 'approved', '≥2→<2 状态回落取原第一个分段');
eq([fx.sections, fx.segments], [[], []], '跨界清空分段');
ins(fx, 1, 9);                                        // → 2 站
eq(fx.status, null, '回 ≥2 status 置 null');
eq(fx.sections, [{ name: '', status: 'approved' }], '<2→≥2 以线路级 status 重建默认分段');
eq(fx.segments, [0], '重建段 segments 全 0');

// ---------- 随机不变量（簿记＋切分/并段混合扰动） ----------
console.log('randomized invariant:');
for (const loop of [false, true]) {
  let rand = 42; const rnd = () => (rand = (rand * 1103515245 + 12345) % 2147483648) / 2147483648;
  let ln6 = mkLine(loop); let seq = 0; let ops = 0;
  for (let step = 0; step < 500; step++) {
    const roll = rnd();
    if (ln6.stops.length === 0 || roll < 0.5) {
      const i = Math.floor(rnd() * (ln6.stops.length + 1));
      ins(ln6, i, ++seq); ops++;
    } else if (roll < 0.85) {
      del(ln6, Math.floor(rnd() * ln6.stops.length)); ops++;
    } else if (ln6.stops.length >= 2) {
      // 随机切分/并段扰动（非法参数自然返回 false，只验不变量不被破坏）
      if (roll < 0.93) L.planSectionSplit(ln6, 1 + Math.floor(rnd() * ln6.stops.length));
      else L.applySectionMerge(ln6, Math.floor(rnd() * (ln6.sections.length + 1)));
      ops++;
    }
    ok(ln6.segments.length === segLen(ln6),
      `step${step} loop=${loop} stops=${ln6.stops.length} segs=${ln6.segments.length}（got ${JSON.stringify(ln6.segments)}）`);
    if (ln6.stops.length >= 2) {
      const iss = L.sectionIssuesOf(ln6);
      ok(iss.length === 0, `step${step} 分段约束（${iss.join('；')}，sections=${JSON.stringify(ln6.sections)}）`);
      ok(ln6.status === null, `step${step} status=null`);
      ok((ln6.sections || []).every((s) => L.SEG_ORDER.includes(s.status) && typeof s.name === 'string'),
        `step${step} 段字段合法`);
    } else {
      ok(!!ln6.status, `step${step} status 非空`);
      ok((ln6.sections || []).length === 0 && (ln6.segments || []).length === 0, `step${step} <2 分段为空`);
    }
  }
  ok(ops > 400, '操作数足够');
}

// ---------- stopSeq 水位 ----------
console.log('stopSeq:');
let ln7 = mkLine(false);
delete ln7.meta.stopSeq;
ln7.stops = [{ id: 'l0001-s01' }, { id: 'l0001-s03' }];
eq(L.nextStopSeq(ln7), 4, '无水位时按最大后缀');
eq(L.nextStopSeq(ln7), 5, '递增');
ln7.meta.stopSeq = 10;
eq(L.nextStopSeq(ln7), 11, '水位优先于后缀');
// 删除最大后缀站后不复用
let ln8 = mkLine(false);
ln8.meta.stopSeq = 5;
ln8.stops = [{ id: 'l0001-s05' }];
ln8.stops.pop();
eq(L.nextStopSeq(ln8), 6, '删除后不复用已分配编号');

// ---------- lineIssues ----------
console.log('lineIssues:');
let bad = mkLine(false);
bad.stops = [
  { id: 'l0001-s01', name: 'a', t: 0.1 },
  { id: 'l0001-s02', name: '', t: 0.2 },
  { id: 'l0001-s03', name: 'c', t: 0.15 },
];
bad.segments = ['existing'];
bad.sections = [];
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
good.segments = [0];
good.sections = [{ name: '既有段', status: 'existing' }];
good.status = null;
eq(L.lineIssues(good), [], '合格线路无 issue');
let goodLoop = mkLine(true);
goodLoop.stops = [
  { id: 'l0001-s01', name: 'a', t: 0.1 },
  { id: 'l0001-s02', name: 'b', t: 0.5 },
  { id: 'l0001-s03', name: 'c', t: 0.9 },
];
goodLoop.segments = [0, 0, 1];
goodLoop.sections = [{ name: '', status: 'existing' }, { name: '东段', status: 'future' }];
goodLoop.status = null;
eq(L.lineIssues(goodLoop), [], '环线合格（环绕段与首段同段跨环绕连续）无 issue');

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
eq(pa.segments, [0, 0], '段数 = 站数-1（单一默认分段全 0）');
eq(pa.sections, [{ name: '', status: 'future' }], '跨界自动建默认分段（status 取线路级 null→future）');
eq(pa.status, null, '站数≥2 status=null');
eq(added.map((s) => s.id), ['l0001-s10', 'l0001-s11'], '编号从 max(水位,最大后缀)+1 递增');
ok(added.every((s) => s.name === '' && s.geo === null), '新站一律空名（建议不写入）');
ok(pa.stops[1].name === '已有名', '已有站名不被覆盖');
ok(!L.lineIssues(pa).some((x) => x.includes('t 未递增')), 't 合法');
// 6) 环线：段数 = 站数
let pl = mkLine(true);
L.applyStopImport(pl, L.planStopImport(pl, [{ t: 0.1 }, { t: 0.4 }, { t: 0.8 }]));
eq(pl.segments.length, pl.stops.length, '环线预置落站后段数=站数');
eq(L.sectionIssuesOf(pl).length, 0, '环线预置落站后分段约束成立');
eq(pl.status, null, '环线 status=null');
// 7) 幂等：再跑全 exists
plan = L.planStopImport(pa, [{ t: 0.2 }, { t: 0.7 }]);
eq([plan.inserts.length, plan.skippedExist], [0, 2], '重复导入全部跳过');
// 8) 删一站后簿记仍成立（与 segRemove 联动）
del(pa, pa.stops.findIndex((s) => s.t === 0.5));
eq(L.sectionIssuesOf(pa).length, 0, '预置站+删站后分段约束成立');
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
// 10b) 换乘标 transferMarkForStop（2026-11-22：Trans 层大圆/药丸并入预置 stops 的 transfer 字段）
const itemT = { stops: [
  { t: 0.2, nameSuggestion: '乙站' },
  { t: 0.5, transfer: 'trans-078', transferKind: 'circle' },
  { t: 0.5005, transfer: 'trans-079', transferKind: 'pill' },
] };
eq(L.transferMarkForStop(itemT, 0.5001).id, 'trans-078', 't 就近取换乘标（更近者优先）');
eq(L.transferMarkForStop(itemT, 0.2), null, '非换乘站无标记');
ok(L.transferMarkForStop(itemT, 0.9) === null, '超出 dtEps 无标记');
ok(L.transferMarkForStop({ stops: [{ t: 0.5, nameSuggestion: 'x' }] }, 0.5) === null, '无 transfer 字段不标记');
ok(L.transferMarkForStop(null, 0.5) === null, '无预置项不崩');
// 10c) 换乘站名回填 backfillTransferNames（2026-11-22 需求 3：已命名「换」站 → 预置空缺建议）
{
  const mkPreset = (stops) => ({ stops });
  const lineA = mkLine(false);
  lineA.stops = [
    { id: 'a-s01', name: '虹桥路', t: 0.5 },
    { id: 'a-s02', name: '', t: 0.7 },
    { id: 'a-s03', name: '某线路所', t: 0.8, kind: 'block' },
    { id: 'a-s04', name: '某箭头', t: 0.9, kind: 'arrow' },
  ];
  const presetA = mkPreset([
    { t: 0.5, transfer: 'trans-001', transferKind: 'circle' },
    { t: 0.9, transfer: 'trans-002' },
  ]);
  const presetB = mkPreset([
    { t: 0.5001, transfer: 'trans-001', transferKind: 'circle' },
    { t: 0.6, transfer: 'trans-003', nameSuggestion: '已有建议' },
  ]);
  const res = L.backfillTransferNames([{ line: lineA, preset: presetA }], [presetA, presetB]);
  eq(res.filled, 2, '命名换乘站回填到两条预置的空缺（同 trans id 多线各计一个）');
  eq(presetA.stops[0].nameSuggestion, '虹桥路', '本线预置被回填');
  ok(presetB.stops[0].manualName === true, '回填站带 manualName 标记');
  eq(L.suggestForStop(presetB, 0.5001).manual, true, 'suggestForStop 透出 manual 来源');
  ok(presetB.stops[1].nameSuggestion === '已有建议' && !presetB.stops[1].manualName, '已有建议不被覆盖');
  ok(!presetA.stops[1].nameSuggestion, '无收集到名字的换乘标保持空缺');
  eq(L.backfillTransferNames([{ line: lineA, preset: presetA }], [presetA, presetB]).filled, 0, '重复回填幂等（空缺已填满）');
  const lineB = mkLine(false);
  lineB.stops = [
    { id: 'b-s01', name: '所', t: 0.8, kind: 'block' },
    { id: 'b-s02', name: '箭', t: 0.9, kind: 'arrow' },
  ];
  eq(L.backfillTransferNames([{ line: lineB, preset: presetA }], [mkPreset([{ t: 0.8, transfer: 'trans-002' }, { t: 0.9, transfer: 'trans-002' }])]).filled, 0, '线路所/出省箭头不收集');
}
// 10d) 同站不同名（2026-11-22 用户裁定方案一）：多名即冲突、不自动填补、并列供人工点选
{
  const mkPreset = (stops) => ({ stops });
  const mkLineWith = (id, stops) => { const l = mkLine(false); l.id = id; l.stops = stops; return l; };
  const pA = mkPreset([{ t: 0.5, transfer: 'trans-010' }]);
  const pB = mkPreset([{ t: 0.52, transfer: 'trans-010' }]);
  const lineX = mkLineWith('l0001', [{ id: 'x-s01', name: '虹桥火车站', t: 0.5 }]);
  const lineY = mkLineWith('l0002', [{ id: 'y-s01', name: '虹桥站', t: 0.52 }]);
  let r = L.backfillTransferNames([{ line: lineX, preset: pA }, { line: lineY, preset: pB }], [pA, pB]);
  eq(r.filled, 0, '同站不同名：不自动填补');
  eq(r.conflicts, 1, '冲突按换乘标去重计数');
  ok(!pA.stops[0].nameSuggestion && !pB.stops[0].nameSuggestion, '冲突站两线预置都无建议');
  eq(pA.stops[0].nameConflict.length, 2, '冲突名单并列两个名字');
  eq(pA.stops[0].nameConflict.map((c) => c.name).join('/'), '虹桥火车站/虹桥站', '名单顺序＝收集顺序');
  eq(pA.stops[0].nameConflict[0].lines.join(','), 'l0001', '名字带来源线路');
  ok(L.suggestForStop(pA, 0.5) === null, '冲突站无建议名');
  eq(L.conflictsForStop(pB, 0.5201).length, 2, 'conflictsForStop 就近取冲突名单');
  ok(L.conflictsForStop(pA, 0.9) === null, '非冲突位置无冲突');
  ok(L.conflictsForStop(null, 0.5) === null, '无预置项不崩');
  // 同名多线不算冲突：正常回填；曾冲突的标记清除
  const lineZ = mkLineWith('l0003', [{ id: 'z-s01', name: '虹桥火车站', t: 0.5 }]);
  const pC = mkPreset([{ t: 0.5001, transfer: 'trans-010' }]);
  r = L.backfillTransferNames([{ line: lineX, preset: pA }, { line: lineZ, preset: pC }], [pA, pC]);
  eq(r.filled, 2, '同名多线不算冲突，正常回填');
  eq(r.conflicts, 0, '无冲突');
  ok(pA.stops[0].nameConflict === undefined, '统一后清除冲突标记');
  eq(pA.stops[0].nameSuggestion, '虹桥火车站', '统一后按单名回填');
  // 曾单名回填、后出现异名：撤回回填建议、改标冲突
  r = L.backfillTransferNames([{ line: lineX, preset: pA }, { line: lineY, preset: pB }], [pA, pB]);
  eq(r.conflicts, 1, '后出现异名即冲突');
  ok(!pA.stops[0].nameSuggestion && !pA.stops[0].manualName, '撤回基于单名的回填建议');
  // 冲突站若已有源图文字建议（非回填）：保留不动，但仍标冲突
  const pD = mkPreset([{ t: 0.5, transfer: 'trans-010', nameSuggestion: '源图文字' }]);
  r = L.backfillTransferNames([{ line: lineX, preset: pA }, { line: lineY, preset: pB }], [pA, pB, pD]);
  eq(pD.stops[0].nameSuggestion, '源图文字', '冲突站的源图文字建议保留');
  eq(pD.stops[0].nameConflict.length, 2, '源图建议站同样标冲突');
  // 站名清空后不再命中：冲突标记清除
  r = L.backfillTransferNames([{ line: mkLineWith('l0001', [{ id: 'x-s01', name: '', t: 0.5 }]), preset: pA }], [pA]);
  ok(pA.stops[0].nameConflict === undefined, '无已命名站命中则清冲突标记');
}
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

// ---------- 线路显示顺序 normalizeLineOrder（manifest.lineOrder；2026-11-22 需求 5） ----------
console.log('lineOrder:');
// 读缺省回退：order 缺失/非数组/空 → 全部按 id 升序（现状顺序）
eq(L.normalizeLineOrder(undefined, ['l0003', 'l0001', 'l0002']), ['l0001', 'l0002', 'l0003'], '缺省回退 id 升序');
eq(L.normalizeLineOrder(null, ['l0002', 'l0001']), ['l0001', 'l0002'], 'null 回退');
eq(L.normalizeLineOrder('garbage', ['l0002', 'l0001']), ['l0001', 'l0002'], '非数组回退');
eq(L.normalizeLineOrder([], ['l0002', 'l0001']), ['l0001', 'l0002'], '空数组回退');
eq(L.normalizeLineOrder(undefined, []), [], '无线线返回空');
// 保存序列化（buildManifest 写出的全量显式顺序）：自定义序在前、未列出线按 id 升序补末
eq(L.normalizeLineOrder(['l0002', 'l0003'], ['l0001', 'l0002', 'l0003']), ['l0002', 'l0003', 'l0001'], '自定义序＋缺线补末');
eq(L.normalizeLineOrder(['l0009', 'l0002'], ['l0002', 'l0009']), ['l0009', 'l0002'], '全列出时按 order 原样（含逆序）');
// 新建追加：新线 id 不在 order → 按 id 升序补到末尾
eq(L.normalizeLineOrder(['l0002', 'l0001'], ['l0001', 'l0002', 'l0007']), ['l0002', 'l0001', 'l0007'], '新建线追加到末尾');
// 清理失效 id：已删/未载入的线 id 被滤掉（编辑器载入路径的清理语义）
eq(L.normalizeLineOrder(['l0009', 'l0001'], ['l0001', 'l0002']), ['l0001', 'l0002'], '失效 id 清理＋缺线补齐');
// 删除线路移除：线删除后其 id 不再出现在生效顺序中
eq(L.normalizeLineOrder(['l0001', 'l0002', 'l0003'], ['l0001', 'l0003']), ['l0001', 'l0003'], '删除线后顺序中无该 id');
// 去重保序＋非字符串杂物跳过（对手改 manifest 的防御）
eq(L.normalizeLineOrder(['l0001', 'l0001', 7, null, 'l0002'], ['l0001', 'l0002']), ['l0001', 'l0002'], '重复去重、杂物跳过');
eq(L.normalizeLineOrder(['l0002', 'l0001', 'l0002'], ['l0001', 'l0002']), ['l0002', 'l0001'], '重复 id 只保留首次出现');

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

// ---------- 联络线有效目标判定 connValidTargets（2026-11-22：取消颜色属性，颜色由所联络两线决定） ----------
console.log('connValidTargets:');
const RES_OK = (id) => ({ lid: id, color: '#' + id, ap: { tag: id } });   // 模拟 resolve 命中 {lid,color,ap}
eq(L.connValidTargets({ role: 'connector', connects: ['l0001', 'l0002'] }, RES_OK).map((t) => t.lid),
  ['l0001', 'l0002'], '两有效目标：保持 connects 书写序');
eq(L.connValidTargets({ role: 'connector', connects: ['l0001'] }, RES_OK), [], '仅 1 目标＝信息未填写完全，判无效');
eq(L.connValidTargets({ role: 'connector', connects: ['l0001', 'l0009'] },
  (id) => (id === 'l0001' ? RES_OK(id) : null)), [], '目标线不存在（resolve null）＝无效');
eq(L.connValidTargets({ role: 'connector', connects: ['l0001', 'l0001'] }, RES_OK), [],
  '重复 id 去重后不足 2＝无效');
eq(L.connValidTargets({ role: 'connector', connects: ['l0003', 'l0001', 'l0002', 'l0001'] }, RES_OK).map((t) => t.lid),
  ['l0003', 'l0001', 'l0002'], '≥3 目标全数返回（渲染端按距两端最近各取其一）＋去重保序');
eq(L.connValidTargets({ role: 'connector', connects: ['l01', 42, 'l02'] }, RES_OK).map((t) => t.lid),
  ['l01', 'l02'], '非字符串 id 跳过');
eq(L.connValidTargets({ role: 'main', connects: ['l0001', 'l0002'] }, RES_OK), [], '非 connector 恒无效');
eq(L.connValidTargets({ role: 'connector' }, RES_OK), [], 'connects 缺失不崩');
eq(L.connValidTargets({ role: 'connector', connects: ['l0001', 'l0002'] }), [], 'resolve 缺省＝全部不可判定→无效');
eq(L.connValidTargets(null, RES_OK), [], 'null line 不崩');

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
bl3.segments = [0, 0];
bl3.sections = [{ name: '', status: 'existing' }];
bl3.status = null;
ok(!L.lineIssues(bl3).some((x) => x.includes('s02')), '线路所空名不报 issue');
ok(L.lineIssues(bl3).some((x) => x.includes('s03 站名为空')), '普通站空名照报');
let bp3 = L.planBulkFill(bl3, ['甲', '乙']);
eq(bp3.pairs.map((p) => p[0].id), ['l0001-s03'], '批量命名跳过线路所');
eq(bp3.pairs.map((p) => p[1]), ['甲'], '名字不被线路所消耗');
let bl4 = mkLine(false);
bl4.stops = [{ id: 'l0001-s01', kind: 'block', name: '', t: 0.5 }];
eq(L.planBulkFill(bl4, ['甲']).pairs.length, 0, '全线仅线路所时批量命名无可配对');

// ---------- 出省箭头 stop.kind:'arrow'（2026-11-21）：落位/编组/命名/校验 ----------
console.log('arrow stop:');
// 落位 canPlaceArrow：仅非环线头（i=0）/尾（i=末位之后）
let aw = mkLine(false);
aw.stops = [
  { id: 'l0001-s01', name: 'a', t: 0.1 },
  { id: 'l0001-s02', name: 'b', t: 0.5 },
  { id: 'l0001-s03', name: 'c', t: 0.9 },
];
ok(L.canPlaceArrow(aw, 0) === true, '非环线 i=0（头）可放');
ok(L.canPlaceArrow(aw, 3) === true, '非环线 i=末位之后（尾）可放');
ok(L.canPlaceArrow(aw, 1) === false, '非环线 i=1（中间）拒绝');
ok(L.canPlaceArrow(aw, 2) === false, '非环线 i=2（中间）拒绝');
ok(L.canPlaceArrow(mkLine(false), 0) === true, '空线 i=0 可放（头）');
ok(L.canPlaceArrow(mkLine(true), 0) === false, '环线一律拒绝（头位也不行）');
ok(L.canPlaceArrow(mkLine(true), 3) === false, '环线尾位也拒绝');
// 编组：含箭头一律拒绝（全箭头也不行——箭头不是站点）
eq(L.planStationGroup([null, 'arrow']), { ok: false, reason: 'arrow' }, '箭头＋普通站混选拒绝');
eq(L.planStationGroup(['arrow', 'arrow']), { ok: false, reason: 'arrow' }, '全箭头同样拒绝');
eq(L.planStationGroup(['block', 'arrow']), { ok: false, reason: 'arrow' }, '箭头检查先于线路所混选');
eq(L.planStationGroup(['block', null]), { ok: false, reason: 'mixed' }, '无箭头时线路所混选逻辑不变');
eq(L.planStationGroup([null, undefined, '']), { ok: true, type: 'same-station', allBlock: false }, '无箭头时普通站判定不变');
// 批量命名跳过箭头（同线路所处理）
let awb = mkLine(false);
awb.stops = [
  { id: 'l0001-s01', kind: 'arrow', name: '', t: 0.05 },
  { id: 'l0001-s02', name: '', t: 0.3 },
  { id: 'l0001-s03', kind: 'arrow', name: '', t: 0.95 },
];
let abp = L.planBulkFill(awb, ['甲', '乙', '丙']);
eq(abp.pairs.map((p) => p[0].id), ['l0001-s02'], '批量命名跳过出省箭头');
eq(abp.pairs.map((p) => p[1]), ['甲'], '名字不被箭头消耗');
// lineIssues：箭头站名可空＋「必须在非环线头/尾」校验（保存链把门）
let awl = mkLine(false);
awl.stops = [
  { id: 'l0001-s01', kind: 'arrow', name: '', t: 0.05 },
  { id: 'l0001-s02', name: 'a', t: 0.3 },
  { id: 'l0001-s03', name: 'b', t: 0.6 },
  { id: 'l0001-s04', kind: 'arrow', name: '', t: 0.95 },
];
awl.segments = [0, 0, 0];
awl.sections = [{ name: '', status: 'existing' }];
awl.status = null;
eq(L.lineIssues(awl), [], '头尾箭头＋空名合法（不报 issue）');
let awm = mkLine(false);
awm.stops = [
  { id: 'l0001-s01', kind: 'arrow', name: '', t: 0.05 },
  { id: 'l0001-s02', kind: 'arrow', name: '', t: 0.3 },   // 中间箭头
  { id: 'l0001-s03', name: 'a', t: 0.6 },
];
awm.segments = [0, 0];
awm.sections = [{ name: '', status: 'existing' }];
awm.status = null;
ok(L.lineIssues(awm).some((x) => x.includes('出省箭头须在非环线头/尾')), '中间箭头检出');
ok(!L.lineIssues(awm).some((x) => x.includes('站名为空')), '箭头空名不报');
let awl2 = mkLine(true);
awl2.stops = [
  { id: 'l0001-s01', kind: 'arrow', name: '', t: 0.05 },
  { id: 'l0001-s02', name: 'a', t: 0.5 },
  { id: 'l0001-s03', name: 'b', t: 0.9 },
];
awl2.segments = [0, 0, 0];
awl2.sections = [{ name: '', status: 'existing' }];
awl2.status = null;
ok(L.lineIssues(awl2).some((x) => x.includes('出省箭头须在非环线头/尾')), '环线箭头检出');

// ---------- 站类型循环切换 nextStopKind（kind-tgl 按钮；2026-11-22） ----------
console.log('nextStopKind:');
// 非环线首/尾（isEnd）：站→所→箭→站 三种都合法
eq(L.nextStopKind(null, { isLoop: false, isEnd: true }), 'block', '非环首尾：站→所');
eq(L.nextStopKind('block', { isLoop: false, isEnd: true }), 'arrow', '非环首尾：所→箭');
eq(L.nextStopKind('arrow', { isLoop: false, isEnd: true }), null, '非环首尾：箭→站（免删了重放）');
// 非环线中途（isEnd:false）：站↔所，arrow 只许首尾
eq(L.nextStopKind(null, { isLoop: false, isEnd: false }), 'block', '非环中途：站→所');
eq(L.nextStopKind('block', { isLoop: false, isEnd: false }), null, '非环中途：所→站');
eq(L.nextStopKind('arrow', { isLoop: false, isEnd: false }), null, '非环中途的异常箭头：出路＝回站');
// 环线任意位置：站↔所（环线无 arrow）
eq(L.nextStopKind(null, { isLoop: true, isEnd: true }), 'block', '环线：站→所');
eq(L.nextStopKind('block', { isLoop: true, isEnd: false }), null, '环线：所→站');
eq(L.nextStopKind('arrow', { isLoop: true, isEnd: true }), null, '环线的异常箭头：出路＝回站');
// 防御：opts 缺省不崩（视作非首尾）；未知/undefined kind 按普通站处理
eq(L.nextStopKind(null), 'block', 'opts 缺省不崩');
eq(L.nextStopKind('weird', { isLoop: false, isEnd: true }), 'block', '未知 kind 按普通站');
eq(L.nextStopKind(undefined, { isLoop: false, isEnd: true }), 'block', 'undefined kind 按普通站');
// 循环闭合：非环首尾从任意起点连点三次回到原点；环线/中途在合法集合 {null,block} 内两连击回到原点
// （arrow 在环线/中途本就非法——异常起点首击即纠正回站，见上方「出路＝回站」用例，不参与闭合环）
for (const k of [null, 'block', 'arrow']) {
  let cur = k;
  for (let s = 0; s < 3; s++) cur = L.nextStopKind(cur, { isLoop: false, isEnd: true });
  ok(cur === k, `非环首尾三连击回到 ${JSON.stringify(k)}`);
}
for (const pos of [{ isLoop: false, isEnd: false }, { isLoop: true, isEnd: true }, { isLoop: true, isEnd: false }]) {
  for (const k of [null, 'block']) {
    let cur = k;
    for (let s = 0; s < 2; s++) cur = L.nextStopKind(cur, pos);
    ok(cur === k, `环线/中途两连击回到 ${JSON.stringify(k)}（${JSON.stringify(pos)}）`);
  }
}

// ---------- migrateLineToV2 的站数<2 缺 status 兜底（属性面板删状态字段后；2026-11-22） ----------
console.log('status fallback:');
let sf1 = mkLine(false);
delete sf1.status;   // 手编/旧数据缺线路级 status
sf1.stops = [{ id: 'l0001-s01', name: 'a', t: 0.5 }];
L.migrateLineToV2(sf1);
eq(sf1.status, 'future', '站数<2 缺 status 载入兜底补 future');
let sf2 = mkLine(false);
sf2.status = 'approved';
sf2.stops = [{ id: 'l0001-s01', name: 'a', t: 0.5 }];
L.migrateLineToV2(sf2);
eq(sf2.status, 'approved', '已有合法 status 不被覆盖');
let sf3 = mkLine(false);
delete sf3.status;
L.migrateLineToV2(sf3);
eq(sf3.status, 'future', '空线（0 站）同样兜底');
let sf4 = mkSecLine(false, ['existing', 'future']);   // ≥2 站、status=null
L.migrateLineToV2(sf4);
eq(sf4.status, null, '站数≥2 status=null 不动（状态挂分段）');

// ---------- 多线换乘药丸串法 planGroupPillChain（同站组 ≥3 线；确定性） ----------
console.log('planGroupPillChain:');
eq(L.planGroupPillChain([]), [], '空集返回空');
eq(L.planGroupPillChain([[0, 0]]), [0], '单点返回 [0]');
eq(L.planGroupPillChain([[0, 0], [5, 5]]), [0, 1], '两点返回原序');
// 正方形四点：四个起点总长全等（3）→ 取 order 字典序最小 [0,1,3,2]
const sq = [[0, 0], [1, 0], [0, 1], [1, 1]];
eq(L.planGroupPillChain(sq), [0, 1, 3, 2], '正方形平手取字典序最小链');
eq(L.planGroupPillChain(sq), L.planGroupPillChain(sq.slice()), '同输入重跑结果一致（确定性）');
// 共线四点（0,10,20,5）：最优 [0,3,1,2]（0→5→10→20 总长 20；与 s=2 的 [2,1,3,0] 平手，字典序小者胜）
eq(L.planGroupPillChain([[0, 0], [10, 0], [20, 0], [5, 0]]), [0, 3, 1, 2], '共线点贪心最近邻链');
// 最优起点非 0：孤远点在 index 3——s=2 的 [2,1,0,3] 与 s=3 的 [3,0,1,2] 总长 12 平手，字典序小者胜
eq(L.planGroupPillChain([[0, 0], [1, 0], [2, 0], [-10, 0]]), [2, 1, 0, 3], '最优起点可为非 0（平手取字典序）');
// 返回值为下标的完整排列
const rp = [[3, 1], [-2, -2], [7, 5], [0, 9], [4, 4]];
eq([...L.planGroupPillChain(rp)].sort((a, b) => a - b), [0, 1, 2, 3, 4], '五点返回完整排列');

// ---------- 换乘节点组列表：搜索与分页（2026-11-22 用户需求：每页 8 个＋搜索框） ----------
console.log('station group list:');
eq(L.searchTermsOf(''), [], '空查询无词');
eq(L.searchTermsOf('  龙阳路   L0021 '), ['龙阳路', 'l0021'], '按空白拆词、统一小写');
eq(L.searchTermsOf(null), [], 'null 不崩');
ok(L.matchesTerms('g0001 同站\nl0002 龙阳路', ['龙阳路']), '包含即命中');
ok(L.matchesTerms('g0001 同站\nl0002 龙阳路', ['龙阳路', '同站']), '多词须全部命中（AND）');
ok(!L.matchesTerms('g0001 同站\nl0002 龙阳路', ['龙阳路', '出闸']), '缺一词不命中');
ok(L.matchesTerms('abc', []), '无词＝全部命中');
ok(L.matchesTerms(undefined, ['x']) === false, '空文本不崩、不命中');
// 检索文本：组号／类型中文标签／成员站的站号、站名、线路 id 与线名
const GI = (sid) => ({
  'l0002-s08': { lineId: 'l0002', lineName: '2号线', stopName: '龙阳路' },
  'l0007-s05': { lineId: 'l0007', lineName: '7号线', stopName: '龙阳路' },
})[sid];
const gA = { id: 'g0001', type: 'same-station', stops: ['l0002-s08', 'l0007-s05'] };
const txtA = L.groupSearchText(gA, GI);
ok(txtA.includes('g0001') && txtA.includes('同站') && txtA.includes('l0002 2号线 龙阳路')
  && txtA.includes('l0007-s05'), '检索文本含组号/类型/站号/线路/站名');
eq(L.groupSearchText({ id: 'g0002', type: null, stops: [] }, GI), 'g0002\ntype 未定', '类型未定与空成员');
eq(L.groupSearchText({ id: 'g0003', type: 'out-of-station', stops: ['l0099-s01'] }, GI),
  'g0003\n出闸\nl0099-s01\n', '成员查不到所属线也不崩（仅站号可检索）');
ok(L.matchesTerms(txtA, L.searchTermsOf('7号线')), '按线名命中');
ok(L.matchesTerms(txtA, L.searchTermsOf('G0001')), '组号不区分大小写');
ok(!L.matchesTerms(txtA, L.searchTermsOf('出闸')), '类型不符不命中');
// 分页切片：每页 8 个、页码回正
const R20 = Array.from({ length: 20 }, (_, i) => i);
eq(L.pageSlice(R20, 1, 8), { rows: [0, 1, 2, 3, 4, 5, 6, 7], page: 1, pages: 3 }, '第 1 页 8 条');
eq(L.pageSlice(R20, 3, 8).rows, [16, 17, 18, 19], '末页取余');
eq(L.pageSlice(R20, 9, 8).page, 3, '页码超界回正到末页');
eq(L.pageSlice(R20, 0, 8).page, 1, '页码 0 回正到 1');
eq(L.pageSlice([], 5, 8), { rows: [], page: 1, pages: 1 }, '空列表：1 页 0 行');
eq(L.LAYER_RESERVED, '预控通道', '预控通道类别名（不设站、默认远期、整线显示）');

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
