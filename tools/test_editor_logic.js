#!/usr/bin/env node
// editor.js 纯逻辑层单测：分段实体（fmt/line@2：加删站索引簿记、切分/并段/区间/约束检测、@1→@2 迁移）、
// stopSeq 水位、status 修正、lineIssues、批量命名、站圆预置批量落站（planStopImport/applyStopImport/suggestForStop）、
// 出省箭头（kind:'arrow' 落位/编组/命名/校验）、多线换乘药丸串法（planGroupPillChain 确定性）、
// 线路显示顺序（normalizeLineOrder：缺省回退/序列化补全/新建追加/失效清理/删除移除）、
// 站类型循环切换（nextStopKind：三种位置 × 各起点）、站数<2 缺 status 载入兜底（2026-11-22）、
// 联络线有效目标判定（connValidTargets：2026-11-22 取消颜色属性改由所联络两线决定）、
// 嵌套换乘组（2026-11-23：组树工具含成环/未知子组防御、绘制单元规划、药丸线数口径、含整组的编组判定、
// groups 字段往返、拆组/删站修剪级联、判脏键）、联络线不带颜色属性（stripConnectorColor/lineForSave）、
// lineinfo.md 节编辑（2026-11-23：保真替换/尾部追加/空文件/多节逐字节不变/标题空白边界/骨架与模板头）、
// 介绍列表条目（lineInfoTargets：线组行＋未入组线各一行——绑「线组 id 或线 id」，同日放宽）。
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

// ---------- 归档线 id 表 archivedIdList（manifest.archived；2026-11-22 抓包：取消归档后仍留在表里） ----------
console.log('archivedIdList:');
const mkArchL = (id, archived) => ({ id, meta: { archived } });
// 抓包复现：l0061 曾归档（旧表有它）后取消归档 → 必须从表里摘除（旧实现留着 → validate FAIL、flatten 整条剔除）
eq(L.archivedIdList(['l0061'], [mkArchL('l0061', false), mkArchL('l0001', false)]), [], '取消归档的线从归档表摘除');
eq(L.archivedIdList(['l0061', 'l0009'], [mkArchL('l0061', false), mkArchL('l0005', true)]), ['l0005', 'l0009'],
  '当前归档的补入、已不在线路列表里的历史 id 保留（编号永不复用）、升序');
eq(L.archivedIdList(undefined, [mkArchL('l0002', true), mkArchL('l0001', false)]), ['l0002'], '无旧表：仅当前归档线');
eq(L.archivedIdList(['l0003', 7, null], []), ['l0003'], '旧表杂物跳过；无线路时旧表原样');
eq(L.archivedIdList(['l0002', 'l0003'], [mkArchL('l0002', false), mkArchL('l0003', true)]), ['l0003'], '逐线判定：一摘一留');
eq(L.archivedIdList([], undefined), [], 'lines 缺失不崩');

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

// ---------- 站点分期覆盖：缺省取出站段、末站取入站段，显式覆盖优先 ----------
console.log('stop status override:');
const stopStatusLine = mkSecLine(false, ['existing', 'future']);
eq(L.stopStatusOf(stopStatusLine, 0), 'existing', '首站缺省跟随出站段');
eq(L.stopStatusOf(stopStatusLine, 1), 'future', '中间站缺省跟随出站段');
eq(L.stopStatusOf(stopStatusLine, 2), 'future', '末站缺省跟随入站段');
stopStatusLine.stops[1].status = 'approved';
eq(L.stopStatusOf(stopStatusLine, 1), 'approved', '站点显式覆盖优先');
eq(L.stopStatusIssues(stopStatusLine), [], '合法站点状态无校验错误');
stopStatusLine.stops[1].status = 'invalid';
eq(L.stopStatusIssues(stopStatusLine).length, 1, '非法站点状态被编辑器逻辑拦截');
L.setStopStatus(stopStatusLine.stops[1], '');
ok(!Object.hasOwn(stopStatusLine.stops[1], 'status'), '选择跟随区段删除显式覆盖字段');
stopStatusLine.stops[1].status = 'future';
const ssRoundTrip = JSON.parse(JSON.stringify(stopStatusLine));
eq(ssRoundTrip.stops[1].status, 'future', '站点覆盖序列化/恢复保真');
const lone = mkLine(false); lone.stops = [{ id: 'l0001-s01' }]; lone.status = 'approved';
eq(L.stopStatusOf(lone, 0), 'approved', '无分段时回退线路级状态');
const loneFallback = { ...lone, status: null };
eq(L.stopStatusOf(loneFallback, 0), 'future', '无区段/线路状态时回退 future');



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

// ---------- 画布增量渲染判脏键（2026-11-22 性能改版：某线「画法输入」变了才重建该线） ----------
console.log('canvas incremental render dirty key:');
const mkKeyLine = () => ({
  id: 'l0001', loop: false, color: '#112233', role: 'standalone', status: 'future', path: 'M0,0L10,10L20,0',
  connects: [], segments: [0, 1], sections: [{ name: '', status: 'existing' }, { name: '乙段', status: 'future' }],
  stops: [
    { id: 'l0001-s01', name: '甲站', t: 0.1, geo: null },
    { id: 'l0001-s02', name: '', t: 0.5, geo: null, kind: 'block' },
    { id: 'l0001-s03', name: '丙站', t: 0.9, geo: null },
  ],
  meta: { archived: false, stopSeq: 3 },
});
const KGRP = new Map([['l0001-s02', 'g0001|same-station']]);   // sid -> 所属组键
const sameDraw = (mutate, grp) => {
  const a = mkKeyLine(), b = mkKeyLine();
  if (mutate) mutate(b);
  return L.sameLineDraw(L.lineDrawKey(a, KGRP), L.lineDrawKey(b, grp || KGRP));
};
ok(sameDraw(null), '数据未变（换对象亦然）＝等价，不重建');
ok(!sameDraw((l) => { l.path = 'M0,0L5,5L20,0'; }), 'path 变');
ok(!sameDraw((l) => { l.loop = true; }), '环线开关变');
ok(!sameDraw((l) => { l.color = '#445566'; }), '颜色变');
ok(!sameDraw((l) => { l.role = 'connector'; }), '角色变');
ok(!sameDraw((l) => { l.status = 'existing'; }), '线路级状态变（预控通道整线段取色）');
ok(!sameDraw((l) => { l.meta.layer = '预控通道'; }), '类别变成预控通道');
ok(!sameDraw((l) => { l.stops[0].t = 0.2; }), '站位置变');
ok(!sameDraw((l) => { l.stops[0].name = '丁站'; }), '站名变（title 文本）');
ok(!sameDraw((l) => { l.stops[0].status = 'future'; }), '站点显式分期覆盖变，触发画布重绘');
ok(!sameDraw((l) => { delete l.stops[1].kind; }), '站类型变');
ok(!sameDraw((l) => { l.stops[1].id = 'l0001-s09'; }), '站号变');
ok(!sameDraw((l) => { l.stops.push({ id: 'l0001-s04', name: '', t: 0.95, geo: null }); }), '加站');
ok(!sameDraw((l) => { l.stops.pop(); }), '删站');
ok(!sameDraw((l) => { l.stops.reverse(); }), '站序变');
ok(!sameDraw((l) => { l.sections[1].status = 'approved'; }), '分段状态变');
ok(!sameDraw((l) => { l.segments[1] = 0; }), '段所属分段变');
ok(!sameDraw((l) => { l.sections[1].status = 'bogus'; }), '分段状态变非法值：兜底 existing 与原值不同，判为变');
ok(sameDraw((l) => { l.sections[0].status = 'bogus'; }), '非法值兜底后与原状态相同＝画法不变');
ok(!sameDraw(null, new Map([['l0001-s02', 'g0001|out-of-station']])), '所属组类型变');
ok(!sameDraw(null, new Map([['l0001-s02', 'g0002|same-station']])), '所属组号变');
ok(!sameDraw(null, new Map()), '站被移出组');
ok(sameDraw((l) => { l.meta.archived = true; }), '归档标记不影响画法（画布照画）');
ok(sameDraw((l) => { l.sections[0].name = '甲段'; }), '分段名不上画布，不算变');
ok(sameDraw((l) => { l.connects = ['l0002', 'l0003']; }), 'connects 归界面层另比（联络线目标集与几何代际）');
ok(!L.sameLineDraw(null, L.lineDrawKey(mkKeyLine(), KGRP)) && !L.sameLineDraw(L.lineDrawKey(mkKeyLine(), KGRP), null),
  '一侧缺键（首次渲染）＝须重建');
eq(L.segStatusesOf(mkKeyLine()), ['existing', 'future'], '非环线 3 站 2 段，状态取所属分段');
eq(L.segStatusesOf(Object.assign(mkKeyLine(), { loop: true, segments: [0, 1, 1] })), ['existing', 'future', 'future'], '环线 3 站 3 段（末段环绕）');
eq(L.segStatusesOf(Object.assign(mkKeyLine(), { loop: true })), ['existing', 'future', 'existing'], '环线末段缺记录兜底 existing');
eq(L.segStatusesOf(Object.assign(mkKeyLine(), { stops: mkKeyLine().stops.slice(0, 1), segments: [], sections: [] })), [], '不足 2 站无站间段');
eq(L.segStatusesOf(Object.assign(mkKeyLine(), { sections: [{ name: '', status: 'bogus' }], segments: [0, 0, 5] })),
  ['existing', 'existing'], '缺记录/非法状态兜底 existing');
ok(L.isReservedLine({ meta: { layer: '预控通道' } }) && !L.isReservedLine({ meta: { layer: '市域线' } })
  && !L.isReservedLine({}) && !L.isReservedLine(null), '预控通道类别判定');

// ---------- 嵌套换乘组（2026-11-23 用户裁定「换乘组可以再把另一个组当成员」）：组树工具 ----------
console.log('nested station groups: tree');
// 中华艺术宫型：外层出闸＋内层同站；另造出闸套出闸＋接轨站，验证「每个子组自成一个单元、递归套用」
const NEST = [
  { id: 'g0101', type: 'out-of-station', stops: ['a'], groups: ['g0102', 'g0103'], info: {} },
  { id: 'g0102', type: 'same-station', stops: ['b', 'c'], info: {} },
  { id: 'g0103', type: 'out-of-station', stops: ['d'], groups: ['g0104'], info: {} },
  { id: 'g0104', type: 'junction', stops: ['e', 'f'], info: {} },
];
const TN = L.groupTree(NEST);
eq(TN.parentOf.get('g0102'), 'g0101', 'parentOf：子组 → 父组');
eq(TN.parentOf.get('g0104'), 'g0103', 'parentOf：多层的直属父组');
ok(!TN.parentOf.has('g0101'), '最外层组没有上级');
eq([...TN.childrenOf.get('g0101')], ['g0102', 'g0103'], 'childrenOf：保持 groups 书写序');
eq(TN.childrenOf.get('g0102'), [], '无子组的组 childrenOf 为空数组');
ok(L.groupIsRoot(TN, 'g0101') && !L.groupIsRoot(TN, 'g0102') && !L.groupIsRoot(TN, 'g0104'), 'groupIsRoot：无上级为顶层');
eq(L.groupLeafStops(TN, 'g0101'), ['a', 'b', 'c', 'd', 'e', 'f'], '叶站＝直属站在前＋子组深度优先');
eq(L.groupLeafStops(TN, 'g0103'), ['d', 'e', 'f'], '中层单元的叶站');
eq(L.groupLeafStops(TN, 'g0102'), ['b', 'c'], '无子组时叶站＝直属站');
eq(TN.issues, [], '正常数据无问题');
// 防御（破损数据不得死循环、其余照常）：未知子组／自引／非字符串项忽略，重复去重，多父先到者胜，逐项记 issues
const T2 = L.groupTree([
  { id: 'g0001', type: 'same-station', stops: ['a'], groups: ['gZZZZ', 'g0001', 'g0002', 'g0002', 7, ''] },
  { id: 'g0002', type: 'same-station', stops: ['b'] },
  { id: 'g0003', type: 'same-station', stops: ['c'], groups: ['g0002'] },
]);
eq([...T2.childrenOf.get('g0001')], ['g0002'], '未知/自引/非字符串/重复项忽略，仅留有效子组');
eq(T2.childrenOf.get('g0003'), [], '多父：后到的引用忽略');
eq(T2.parentOf.get('g0002'), 'g0001', '多父时父组取先到者');
eq(T2.issues.length, 5, '问题逐项记录：未知 1＋自引 1＋非字符串 2＋多父 1');
ok(T2.issues.some((s) => s.includes('gZZZZ')) && T2.issues.some((s) => s.includes('g0003')), '问题串含涉及的组号');
// 成环：环上成员都有上级、都不是顶层，不成绘制单元；环外的组照常
const CYC = [
  { id: 'g0001', type: 'same-station', stops: ['a'], groups: ['g0002'] },
  { id: 'g0002', type: 'same-station', stops: ['b'], groups: ['g0001'] },
  { id: 'g0003', type: 'same-station', stops: ['c', 'd'] },
];
const T3 = L.groupTree(CYC);
ok(!L.groupIsRoot(T3, 'g0001') && !L.groupIsRoot(T3, 'g0002') && L.groupIsRoot(T3, 'g0003'), '成环：环上成员不算顶层（不死循环）');
const P3 = L.groupDrawPlan(CYC);
eq(P3.units, ['g0003'], '成环的环上组不成绘制单元，环外的组照常');
eq([...P3.hidden], ['c', 'd'], '被吸收的只有正常单元的叶站（环上组的直属站照画）');
eq(L.groupLeafStops(T3, 'g0001'), ['a', 'b'], '成环时叶站遍历走到过的组即止，不死循环');
eq(L.groupTree(undefined).byId.size, 0, 'undefined 不崩');
eq(L.groupTree([]).issues, [], '空表');

// ---------- 嵌套换乘组：绘制单元规划（用户 2026-11-23 确认的渲染规则，逐条对应） ----------
console.log('nested station groups: draw plan');
const PN = L.groupDrawPlan(NEST);
eq(PN.units, ['g0101', 'g0102', 'g0103', 'g0104'], '出闸单元不吸收子组：每个子组自成一个绘制单元（递归）');
eq([...PN.hidden].sort(), ['b', 'c', 'e', 'f'], '隐去同站/接轨单元的叶站；出闸单元的直属站照画（描黑边）');
ok(PN.unitSet.has('g0102') && PN.unitSet.has('g0104'), 'unitSet 与 units 一致');
eq(PN.leafOf.get('g0102'), ['b', 'c'], '同站单元成员＝全部叶站');
// 中辰路／上海金山型：外层同站＋内层接轨站——外层吸收全部，内层不单独出图形
const PS = L.groupDrawPlan([
  { id: 'g0201', type: 'same-station', stops: ['a'], groups: ['g0202'] },
  { id: 'g0202', type: 'junction', stops: ['b', 'c'] },
]);
eq(PS.units, ['g0201'], '同站单元吸收子组：内层组不是绘制单元');
eq([...PS.hidden].sort(), ['a', 'b', 'c'], '同站单元隐去全部叶站（含内层组的）');
eq(PS.leafOf.get('g0201'), ['a', 'b', 'c'], '成员递归取全部叶站（并点位置按它算）');
// 接轨站单元同样吸收子组（多层）
const PJ = L.groupDrawPlan([
  { id: 'g0201', type: 'junction', stops: ['a'], groups: ['g0202'] },
  { id: 'g0202', type: 'same-station', stops: ['b'], groups: ['g0203'] },
  { id: 'g0203', type: 'out-of-station', stops: ['c', 'd'] },
]);
eq(PJ.units, ['g0201'], '接轨站单元吸收子组，被吸收的组自己的子组也不成单元');
eq([...PJ.hidden].sort(), ['a', 'b', 'c', 'd'], '接轨站单元隐去全部叶站');
// type 未定沿用现行处理：不出合并图形、直属站照画；结构上同出闸（子组各自成单元）
const PU = L.groupDrawPlan([
  { id: 'g0301', type: null, stops: ['a'], groups: ['g0302'] },
  { id: 'g0302', type: 'same-station', stops: ['b', 'c'] },
]);
eq(PU.units, ['g0301', 'g0302'], 'type 未定：子组各自成单元');
eq([...PU.hidden], ['b', 'c'], 'type 未定单元的直属站不隐去');
// 不嵌套的旧数据：每个组都是单元，隐去的仍只是同站/接轨组成员（与旧行为一致）
const PF = L.groupDrawPlan([
  { id: 'g0001', type: 'same-station', stops: ['a', 'b'] },
  { id: 'g0002', type: 'out-of-station', stops: ['c', 'd'] },
  { id: 'g0003', type: 'junction', stops: ['e', 'f'] },
  { id: 'g0004', type: null, stops: ['g', 'h'] },
]);
eq(PF.units, ['g0001', 'g0002', 'g0003', 'g0004'], '不嵌套：每个组都是绘制单元');
eq([...PF.hidden].sort(), ['a', 'b', 'e', 'f'], '不嵌套：隐去同站/接轨组成员，出闸/未定的照画');
eq(L.groupDrawPlan([]).units, [], '空表');
eq(L.groupDrawPlan(undefined).units, [], 'undefined 不崩');

// ---------- 嵌套换乘组：药丸线数口径（「支线算一条，联络线不算线」，适用于一切同站单元） ----------
console.log('nested station groups: logical line count');
const LN = (id, role, groupId) => ({ id, role, groupId });
const LGS = [{ id: 'lg01', members: [] }, { id: 'lg02', members: ['l0009'] }];
eq(L.logicalLineCount([], []), 0, '无成员＝0');
eq(L.logicalLineCount([LN('l0001', 'standalone', null), LN('l0002', 'main', 'lg01'), LN('l0003', 'branch', 'lg01')], LGS), 2,
  '主线＋支线＋另一线＝2（支线算一条）');
eq(L.logicalLineCount([LN('l0001', 'standalone', null), LN('l0008', 'connector', null)], LGS), 1, '联络线不算线');
eq(L.logicalLineCount([LN('l0007', 'standalone', null), LN('l0008', 'connector', null), LN('l0057', 'standalone', null)], LGS), 2,
  '上海金山型：两条独立线＋一条联络线＝2 → 大圈');
eq(L.logicalLineCount([LN('l0058', 'standalone', null), LN('l0075', 'main', 'lg06'), LN('l0076', 'branch', 'lg06')],
  [{ id: 'lg06', members: [] }]), 2, '中辰路型：独立线＋松江快线主线＋其支线＝2 → 大圈');
eq(L.logicalLineCount([LN('l0002', 'main', 'lg01'), LN('l0003', 'branch', 'lg01')]), 2,
  'lineGroups 缺省＝无已知线组：孤儿 groupId 不归并');
eq(L.logicalLineCount([LN('l0001', 'standalone', null), LN('l0002', 'standalone', null), LN('l0003', 'standalone', null)], LGS), 3,
  '三条独立线＝3 → 药丸');
eq(L.logicalLineCount([LN('l0001', 'standalone', null), LN('l0002', 'main', 'lg01'), LN('l0003', 'branch', 'lg01'),
  LN('l0004', 'main', 'lg02')], LGS), 3, '主线＋支线算一条，三条逻辑线＝3 → 药丸');
eq(L.logicalLineCount([LN('l0009', 'standalone', null), LN('l0010', 'main', 'lg02')], LGS), 1,
  '线组归属取双向并集：line.groupId 指向 ＋ 线组 members 声明');
eq(L.logicalLineCount([LN('l0009', 'standalone', null), LN('l0010', 'standalone', null)], LGS), 2, '两处归属不同组＝两条');
eq(L.logicalLineCount([LN('l0001', 'main', 'lgXX'), LN('l0002', 'branch', 'lgXX')], LGS), 2, '孤儿 groupId（组记录不存在）不归并');
eq(L.logicalLineCount(null, null), 0, 'null 不崩');
// 第三参（全部线对象）：线组须有主线成员才并成一条——与查看器 buildLineGroups「无 main 不归并」同口径（主窗口合入时对齐）
const ALL1 = [LN('l0002', 'main', 'lg01'), LN('l0003', 'branch', 'lg01'), LN('l0009', 'standalone', 'lg02'), LN('l0010', 'standalone', 'lg02')];
eq(L.logicalLineCount([LN('l0002', 'main', 'lg01'), LN('l0003', 'branch', 'lg01')], LGS, ALL1), 1, '传入全表：有主线的线组算一条');
eq(L.logicalLineCount([LN('l0009', 'standalone', 'lg02'), LN('l0010', 'standalone', 'lg02')], LGS, ALL1), 2,
  '传入全表：无主线的线组成员各算一条');
eq(L.logicalLineCount([LN('l0003', 'branch', 'lg01')], LGS, ALL1), 1, '传入全表：单元里只有支线、主线不在单元内，仍按线组算一条');

// 上级组一律药丸（2026-11-23 用户裁定「上级组无论有几个站圆，都按多线站生成药丸」）
const G2 = (id, type, kids) => ({ id, type, stops: [], groups: kids || [] });
eq(L.unitIsPill(G2('p1', 'same-station', ['k']), ['k'], [LN('l0001', 'standalone', null)]), true, 'unitIsPill：带子组的同站单元 1 条线也画药丸');
eq(L.unitIsPill(G2('p2', 'junction', ['k']), ['k'], []), true, 'unitIsPill：带子组的接轨单元也画药丸');
eq(L.unitIsPill(G2('p3', 'junction'), [], [LN('l0001', 'standalone', null), LN('l0002', 'standalone', null), LN('l0003', 'standalone', null)]), false, 'unitIsPill：平铺接轨单元不画药丸');
eq(L.unitIsPill(G2('p4', 'same-station'), [], [LN('l0001', 'standalone', null), LN('l0002', 'standalone', null)]), false, 'unitIsPill：平铺同站单元 2 条线＝大圈');
eq(L.unitIsPill(G2('p5', 'same-station'), [], [LN('l0001', 'standalone', null), LN('l0002', 'standalone', null), LN('l0003', 'standalone', null)]), true, 'unitIsPill：平铺同站单元 3 条线＝药丸');
eq(L.unitIsPill(G2('p6', 'out-of-station', ['k']), ['k'], []), false, 'unitIsPill：出闸单元不画药丸（直属站各自成圈）');
eq(L.unitIsPill(null, ['k'], []), false, 'unitIsPill：空组不崩');

// ---------- shape:"pill" ＋「两站分离」候选（2026-11-23：平行线双线站大圆悬浮对策） ----------
console.log('shape pill / split candidates');
eq(L.unitIsPill(Object.assign(G2('sp1', 'same-station'), { shape: 'pill' }), [], [LN('l0001', 'standalone', null), LN('l0002', 'standalone', null)]), true,
  'unitIsPill：同站组 shape:"pill" 强制药丸（双线也药丸）');
eq(L.unitIsPill(Object.assign(G2('sp2', 'junction'), { shape: 'pill' }), [], [LN('l0001', 'standalone', null), LN('l0002', 'standalone', null), LN('l0003', 'standalone', null)]), false,
  'unitIsPill：接轨组写 shape 不生效（平铺接轨仍不药丸）');
eq(L.unitIsPill(Object.assign(G2('sp3', 'out-of-station'), { shape: 'pill' }), ['k'], []), false,
  'unitIsPill：出闸组写 shape 不生效（直属站各自成圈）');
ok(Math.abs(L.haversineM([0, 0], [1, 0]) - 111195.1) < 50, 'haversineM：赤道 1° 经度 ≈ 111.195km');
ok(L.haversineM([121, 31], [121, 31]) < 1e-6, 'haversineM：同点为 0');
// 假变换：1 画板单位＝1 米（纬向）；posOf 手造索引——不依赖真 TPS 标定数据
const M2DEG = 1 / 111195;
const fakeFwd = (c, x, y) => [121 + x * M2DEG, 31 + y * M2DEG];
const posMapF = { sa: [0, 0], sb: [0, 60], sc: [0, 45], sd: [0, 20] };
const posOfF = (sid) => (sid in posMapF ? posMapF[sid] : null);
const G3 = (id, stops, type, extra) => Object.assign({ id, type: type || 'same-station', stops, groups: [] }, extra || {});
const ls2F = [LN('la', 'standalone', null), LN('lb', 'standalone', null)];
const ls3F = [LN('la', 'standalone', null), LN('lb', 'standalone', null), LN('lc', 'standalone', null)];
ok(Math.abs(L.groupSplitMeters(G3('m1', ['sa', 'sb']), posOfF, {}, fakeFwd) - 60) < 0.1, 'groupSplitMeters：两站 60 单位 → ≈60m');
ok(Math.abs(L.groupSplitMeters(G3('m2', ['sa', 'sb', 'sc']), posOfF, {}, fakeFwd) - 60) < 0.1, 'groupSplitMeters：三站取两两最大');
eq(L.groupSplitMeters(G3('m3', ['sa', 'zz']), posOfF, {}, fakeFwd), null, 'groupSplitMeters：站定不了位 → null（不误报）');
eq(L.groupSplitMeters(G3('m4', ['sa', 'sb']), posOfF, null), null, 'groupSplitMeters：无标定 → null');
eq(L.isSplitGroup(G3('s1', ['sa', 'sb']), ls2F, posOfF, {}, [], null, fakeFwd), true, 'isSplitGroup：双线同站 60m → 候选');
eq(L.isSplitGroup(G3('s2', ['sa', 'sd']), ls2F, posOfF, {}, [], null, fakeFwd), false, 'isSplitGroup：双线同站 20m → 不候选');
eq(L.isSplitGroup(G3('s3', ['sa', 'sb']), ls3F, posOfF, {}, [], null, fakeFwd), false, 'isSplitGroup：3 条逻辑线 → 不候选（已是药丸）');
eq(L.isSplitGroup(G3('s4', ['sa', 'sb'], 'out-of-station'), ls2F, posOfF, {}, [], null, fakeFwd), false, 'isSplitGroup：出闸组不候选');
eq(L.isSplitGroup(G3('s5', ['sa', 'sb'], 'junction'), ls2F, posOfF, {}, [], null, fakeFwd), false, 'isSplitGroup：接轨组不候选（裁定场景＝双线换乘站）');

// ---------- 嵌套换乘组：编组判定（待编组单位可含既有顶层组） ----------
console.log('nested station groups: plan');
eq(L.planStationGroup([null], 1), { ok: true, type: 'same-station', allBlock: false }, '一站＋一整组＝2 个单位：默认同站（中辰路/上海金山型）');
eq(L.planStationGroup([], 2), { ok: true, type: 'same-station', allBlock: false }, '仅两个整组：默认同站');
eq(L.planStationGroup(['block'], 1), { ok: true, type: 'junction', allBlock: true }, '线路所规则只看直属站：全线路所＋整组 → 强制接轨站');
eq(L.planStationGroup(['block', null], 1), { ok: false, reason: 'mixed' }, '直属站线路所与普通站混选照旧拒绝');
eq(L.planStationGroup(['arrow'], 1), { ok: false, reason: 'arrow' }, '出省箭头照旧拒绝');
eq(L.planStationGroup([null], 0), { ok: false, reason: 'few' }, '成员单位（站＋整组）不足 2 拒绝');
eq(L.planStationGroup([], 1), { ok: false, reason: 'few' }, '仅一个整组不足 2');
eq(L.planStationGroup([], 0), { ok: false, reason: 'few' }, '空集不足 2');
eq(L.planStationGroup([null]), { ok: true, type: 'same-station', allBlock: false }, '不传组数：沿用「≥2 由调用方把门」（旧调用方不变）');
eq(L.pendingGroupIssues(TN, ['g0101']), [], '顶层组可整组编入上层');
eq(L.pendingGroupIssues(TN, ['g0102']), [{ id: 'g0102', reason: 'parent', parent: 'g0101' }], '已有上级的组不可整组编入（先拆其上层组）');
eq(L.pendingGroupIssues(TN, ['gZZZZ']), [{ id: 'gZZZZ', reason: 'missing', parent: null }], '不存在的组');
eq(L.pendingGroupIssues(TN, []), [], '空列表');
eq(L.pendingGroupIssues(TN, undefined), [], 'undefined 不崩');

// ---------- 嵌套换乘组：groups 字段往返（旧数据往返不变、为空不写出） ----------
console.log('nested station groups: groups field round trip');
const oldG = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [{ id: 'g0001', stops: ['a', 'b'], type: 'same-station', info: {} }] };
const oldJson = JSON.stringify(oldG);
ok(L.normalizeStationGroups(oldG.stationGroups) === false, '旧数据（无 groups 字段）：无改动');
eq(JSON.stringify(oldG), oldJson, '旧数据 JSON 往返逐字一致');
const nG = { stationGroups: [
  { id: 'g0001', stops: ['a'], groups: ['g0002'], type: 'same-station', info: {} },
  { id: 'g0002', stops: ['b', 'c'], type: 'same-station', info: {} },
  { id: 'g0003', stops: ['d', 'e'], groups: [], type: null, info: {} },
  { id: 'g0004', stops: ['f', 'g'], groups: 'x', type: null, info: {} },
  { id: 'g0005', stops: ['h', 'i'], groups: ['g0002', 'g0002', 3, ''], type: null, info: {} },
] };
ok(L.normalizeStationGroups(nG.stationGroups) === true, '需要规范化时报有改动');
ok(L.normalizeStationGroups(nG.stationGroups) === false, '幂等');
eq(nG.stationGroups.map((g) => g.groups), [['g0002'], undefined, undefined, undefined, ['g0002']], '保留有效 id，去重、剔非字符串项');
ok(!('groups' in nG.stationGroups[2]) && !('groups' in nG.stationGroups[3]), '为空/非数组的 groups 字段删除（保存不写出）');
ok(JSON.stringify(nG.stationGroups[2]).indexOf('"groups"') === -1, '序列化不含 groups 键');
ok(JSON.stringify(nG.stationGroups[0]).includes('"groups":["g0002"]'), '非空 groups 序列化保留');
const rt = JSON.parse(JSON.stringify(nG));   // 保存 → 载入
eq(rt.stationGroups[0].groups, ['g0002'], '往返后 groups 不丢');
eq(rt.stationGroups[4].groups, ['g0002'], '往返后（去重后的）groups 不丢');
eq(L.groupTree(rt.stationGroups).parentOf.get('g0002'), 'g0001', '往返后组树关系不变（先到者胜）');
ok(L.normalizeStationGroups(undefined) === false && L.normalizeStationGroups(null) === false, 'undefined/null 不崩');
// 快照式撤销：整对象 JSON 往返同样不丢（snapshot/undo 即此路径）
const snapG = JSON.stringify({ lines: [], groups: nG });
eq(JSON.parse(snapG).groups.stationGroups[0].groups, ['g0002'], '撤销快照往返 groups 不丢');

// ---------- 嵌套换乘组：拆组/删站后的修剪与级联（成员单位总数 直属站＋子组 ≥2） ----------
console.log('nested station groups: prune & cascade');
eq(L.groupUnitCount({ stops: ['a'], groups: ['g0002'] }), 2, '一站＋一子组＝2 个单位');
eq(L.groupUnitCount({ stops: ['a', 'b'] }), 2, '无 groups 字段按 [] 计');
eq(L.groupUnitCount({}), 0, '空组 0');
eq(L.groupUnitCount(null), 0, 'null 不崩');
// 删站使内层组剩 1 站 → 拆除；外层摘除引用后剩 1 站 → 级联拆除
const L1 = [
  { id: 'g0001', stops: ['a'], groups: ['g0002'], type: 'same-station' },
  { id: 'g0002', stops: ['b'], type: 'junction' },
];
eq(L.pruneStationGroups(L1), ['g0002', 'g0001'], '内层成员不足拆除 → 外层引用摘除后也不足 → 级联拆除');
eq(L1, [], '两组都不剩');
// 外层删掉唯一直属站（剩 0 站＋1 子组）→ 外层拆除，子组升为顶层、其余不动
const L2 = [
  { id: 'g0001', stops: [], groups: ['g0002'], type: 'same-station' },
  { id: 'g0002', stops: ['b', 'c'], type: 'junction' },
  { id: 'g0003', stops: ['d', 'e'], type: 'same-station' },
];
eq(L.pruneStationGroups(L2), ['g0001'], '外层成员单位不足 2 拆除');
eq(L2.map((g) => g.id), ['g0002', 'g0003'], '子组升为顶层、无关的组不动');
// 三层级联：中层拆除 → 外层引用摘除后不足 → 一并拆除；最内层完好的组留下
const L5 = [
  { id: 'g0001', stops: ['a'], groups: ['g0002'], type: 'same-station' },
  { id: 'g0002', stops: [], groups: ['g0003'], type: 'same-station' },
  { id: 'g0003', stops: ['b', 'c'], type: 'junction' },
];
eq(L.pruneStationGroups(L5), ['g0002', 'g0001'], '级联到稳定');
eq(L5.map((g) => g.id), ['g0003'], '完好的最内层组留下并升为顶层');
// 拆组后的级联（cascadeStationGroups）：上级摘除引用（摘空即删字段），仍够 2 个单位就不拆
const L3b = [
  { id: 'g0001', stops: ['a'], groups: ['g0002', 'g0009'], type: 'out-of-station' },
  { id: 'g0009', stops: ['x', 'y'], type: 'same-station' },
];
eq(L.cascadeStationGroups(L3b, ['g0002']), [], '上级摘除后仍有 1 站＋1 子组＝2：不级联');
eq(L3b[0].groups, ['g0009'], '引用已摘除、其余子组保留');
const L4b = [{ id: 'g0001', stops: ['a'], groups: ['g0002'], type: 'out-of-station' }, { id: 'g0009', stops: ['x', 'y'] }];
eq(L.cascadeStationGroups(L4b, ['g0002']), ['g0001'], '上级摘除后只剩 1 站：一并拆除');
eq(L4b.map((g) => g.id), ['g0009'], '无关的组不动');
const L6 = [{ id: 'g0001', stops: ['a', 'b'], groups: ['g0002'], type: 'out-of-station' }];
eq(L.cascadeStationGroups(L6, ['g0002']), [], '上级摘除后仍有 2 站：保留');
ok(!('groups' in L6[0]) && L6[0].stops.length === 2, 'groups 摘空即删字段（为空不写出）');
eq(L.cascadeStationGroups([], ['g0002']), [], '空表不崩');
eq(L.cascadeStationGroups(undefined, []), [], 'undefined 不崩');
// 不嵌套的旧数据：与旧「stops 不足 2 即删」的过滤一致
const L7 = [{ id: 'g0001', stops: ['a'] }, { id: 'g0002', stops: ['b', 'c'] }];
eq(L.pruneStationGroups(L7), ['g0001'], '旧数据：仅删 stops 不足 2 的组');
eq(L7.map((g) => g.id), ['g0002'], '其余保留');

// ---------- 嵌套换乘组：画布增量渲染判脏（新增数据依赖已入键） ----------
console.log('nested station groups: dirty keys');
const GK = { id: 'g0101', type: 'out-of-station' };
eq(L.stopGroupKey(GK, false), 'g0101|out-of-station|v', '设站组键＝直属组 id|直属组 type|v（可见）');
ok(L.stopGroupKey(GK, true) !== L.stopGroupKey(GK, false), '隐去位变（上级组类型/子组关系变化落到这一位）→ 键变');
ok(L.stopGroupKey({ id: 'g0101', type: 'same-station' }, true) !== L.stopGroupKey(GK, true), '直属组类型变（出闸黑边/提示文本）→ 键变');
ok(L.stopGroupKey({ id: 'g0102', type: 'out-of-station' }, false) !== L.stopGroupKey(GK, false), '直属组号变 → 键变');
eq(L.stopGroupKey({ id: 'g0001', type: null }, false), 'g0001||v', 'type 未定以空串入键');
// 经 lineDrawKey 体现：同一线数据、仅组的隐去位不同 → 判为变（该线须重建，站圈才会出现/消失）
{
  const kl = mkKeyLine();
  const ka = L.lineDrawKey(kl, new Map([['l0001-s02', L.stopGroupKey(GK, true)]]));
  const kb = L.lineDrawKey(mkKeyLine(), new Map([['l0001-s02', L.stopGroupKey(GK, false)]]));
  ok(!L.sameLineDraw(ka, kb), 'lineDrawKey：隐去位不同＝须重建该线');
}
const mem = (lineId, t, o) => ({
  line: Object.assign({ id: lineId, role: 'standalone', color: '#123456', groupId: null }, (o && o.line) || {}),
  st: Object.assign({ id: lineId + '-s01', t, name: '甲', kind: undefined }, (o && o.st) || {}),
});
const sigOf = (over) => L.groupUnitSig(
  (over && over.type) || 'same-station', (over && over.isPill) || false, (over && over.geomGen) || 3,
  (over && over.conn) || 'c1', (over && over.lg) || 'lg01:;', (over && over.kids) || ['g0002'],
  (over && over.members) || [mem('l0001', 0.1), mem('l0002', 0.2)]);
const sig0 = sigOf();
ok(sigOf() === sig0, '输入不变＝键不变（不重建）');
ok(sigOf({ type: 'junction' }) !== sig0, '单元自身类型变 → 重建');
ok(sigOf({ isPill: true }) !== sig0, '药丸/大圈档位变（线数口径结论变）→ 重建');
ok(sigOf({ kids: ['g0002', 'g0003'] }) !== sig0 && sigOf({ kids: [] }) !== sig0, '子组名单变（子组关系/提示文本）→ 重建');
ok(sigOf({ members: [mem('l0001', 0.1), mem('l0002', 0.25)] }) !== sig0, '叶站位置变 → 重建');
ok(sigOf({ members: [mem('l0001', 0.1), mem('l0003', 0.2)] }) !== sig0, '叶站集合变（子组成员增删）→ 重建');
ok(sigOf({ members: [mem('l0001', 0.1), mem('l0002', 0.2, { st: { name: '乙' } })] }) !== sig0, '叶站站名变（提示文本）→ 重建');
ok(sigOf({ members: [mem('l0001', 0.1), mem('l0002', 0.2, { line: { role: 'branch', groupId: 'lg01' } })] }) !== sig0,
  '叶站所属线的角色/线组归属变（线数口径、接轨站描边）→ 重建');
ok(sigOf({ members: [mem('l0001', 0.1), mem('l0002', 0.2, { line: { color: '#ABCDEF' } })] }) !== sig0, '成员线颜色变 → 重建');
ok(sigOf({ lg: 'lg01:l0002;' }) !== sig0, '线组表摘要变（members 声明 → 线数口径）→ 重建');
ok(sigOf({ geomGen: 4 }) !== sig0, '几何代际变 → 重建');
ok(sigOf({ conn: 'c2' }) !== sig0, '联络线目标摘要变 → 重建');
eq(L.groupUnitSig('same-station', false, 0, '', '', undefined, undefined),
  'same-station|false|0|||', '缺省参数不崩');

// ---------- 联络线不带颜色属性（2026-11-22 用户裁定；2026-11-23 补：改角色即清、载入规范化、落盘兜底） ----------
console.log('connector color:');
const mkRoleLine = (role, color) => { const l = mkLine(false); l.role = role; if (color !== undefined) l.color = color; return l; };
let cc = mkRoleLine('standalone', '#112233');
ok(L.stripConnectorColor(cc) === false && cc.color === '#112233', '非联络线不动');
cc.role = 'connector';
ok(L.stripConnectorColor(cc) === true && !('color' in cc), '改成联络线：color 按键删除（同现有联络线文件写法）');
ok(L.stripConnectorColor(cc) === false, '已无 color：无改动（幂等）');
ok(JSON.stringify(cc).indexOf('"color"') === -1, '序列化不含 color');
ok(L.stripConnectorColor(null) === false && L.stripConnectorColor({ role: 'connector' }) === false, 'null／本就无 color 不崩');
const cf = mkRoleLine('connector', '#666666');
const cfOut = L.lineForSave(cf);
ok(cfOut !== cf && !('color' in cfOut) && cf.color === '#666666', '落盘对象剔除 color，且不改写内存对象');
eq(Object.keys(cfOut), Object.keys(mkRoleLine('connector', '#666666')).filter((k) => k !== 'color'), '只去 color 键，其余字段与次序不变');
ok(JSON.stringify(cfOut).indexOf('"color"') === -1, '落盘序列化不含 color（validate：connector must not define color）');
const cf2 = mkRoleLine('standalone', '#112233');
ok(L.lineForSave(cf2) === cf2, '非联络线原样返回同一对象');
const cf3 = mkRoleLine('connector');
ok(L.lineForSave(cf3) === cf3 && L.lineForSave(null) === null, '本就无 color 的联络线原样返回；null 不崩');

// ---------- lineinfo.md 节编辑（2026-11-23：保真＝只动被编辑节，其余字节原样） ----------
console.log('lineinfo 节编辑:');
const V = require(path_join('src', 'viewer_core.js'));   // 绑定口径对拍：parseLineInfo 同为「## <id> …」首 token

// CRLF 多节文件：替换中间节，前后其余节逐字节不动（含行尾符与注释）
const crlfMd = [
  '# 线路信息',
  '',
  '<!-- 注释 -->',
  '',
  '## lg01 一号线',
  '起讫点: A—B',
  '',
  '正文一',
  '',
  '## lg02 二号线',
  '起讫点: C—D',
  '',
  '- 项一',
  '- 项二',
  '',
  '### 相关链接',
  '[链接](https://x/y)',
  '',
  '## lg03 三号线',
  '编组: 6A',
  '',
  '正文三',
  '',
].join('\r\n');
const newSec2 = '## lg02 二号线\r\n起讫点: C—E\r\n\r\n改好的正文\r\n';
const rep = L.replaceLineInfoSection(crlfMd, 'lg02', newSec2);
ok(rep.indexOf(newSec2) >= 0, '替换节进入结果');
ok(rep.slice(0, rep.indexOf(newSec2)) === crlfMd.slice(0, crlfMd.indexOf('## lg02')),
  '被替换节之前的全部字节不变（文件头注释＋lg01 整节）');
ok(rep.slice(rep.indexOf('## lg03')) === crlfMd.slice(crlfMd.indexOf('## lg03')),
  '被替换节之后的全部字节不变（lg03 整节至文件尾）');
ok(L.extractLineInfoSection(rep, 'lg01') === L.extractLineInfoSection(crlfMd, 'lg01'), 'lg01 节原文逐字节相同');
ok(L.extractLineInfoSection(rep, 'lg03') === L.extractLineInfoSection(crlfMd, 'lg03'), 'lg03 节原文逐字节相同');
const p0 = V.parseLineInfo(crlfMd), p1 = V.parseLineInfo(rep);
eq(p1.lg02.fields, [['起讫点', 'C—E']], 'parseLineInfo 对拍：lg02 字段更新');
eq(p1.lg02.bodyHtml, '<p>改好的正文</p>', 'parseLineInfo 对拍：lg02 正文更新');
eq(p1.lg01, p0.lg01, 'lg01 解析结果不变');
eq(p1.lg03, p0.lg03, 'lg03 解析结果不变');

// 尾部追加：节不存在 → 原文件全部字节作前缀，新节接在文件尾
const ap = L.replaceLineInfoSection(crlfMd, 'lg09', '## lg09 九号线\n正文九\n');
ok(ap.slice(0, crlfMd.length) === crlfMd, '尾部追加：原文件字节全保');
eq(ap.slice(crlfMd.length), '## lg09 九号线\n正文九\n', '追加节恰在文件尾');
// 原文件不以行尾符结尾：追加前补一个（沿用文件末行的行尾符）
eq(L.replaceLineInfoSection('## lg01 A\n正文一', 'lg09', '## lg09 B\nx\n'),
  '## lg01 A\n正文一\n## lg09 B\nx\n', '追加前补 LF');
eq(L.replaceLineInfoSection('## lg01 A\r\n正文一', 'lg09', '## lg09 B\nx\n'),
  '## lg01 A\r\n正文一\r\n## lg09 B\nx\n', '追加前补行尾符沿用 CRLF');

// 文件为空/无任何节
eq(L.replaceLineInfoSection(null, 'lg01', '## lg01 A\nx\n'), '## lg01 A\nx\n', 'null 文件 → 结果即新节');
eq(L.replaceLineInfoSection('', 'lg01', '## lg01 A\nx\n'), '## lg01 A\nx\n', '空文件 → 结果即新节');
eq(L.replaceLineInfoSection('# 标题\n\n散行注释\n', 'lg01', '## lg01 A\nx\n'),
  '# 标题\n\n散行注释\n## lg01 A\nx\n', '无任何节的文件 → 尾部追加（散行保留）');
ok(L.extractLineInfoSection(null, 'lg01') === null, 'null → 无节');
ok(L.extractLineInfoSection('# 只有说明\n散行\n', 'lg01') === null, '无节文件 → null');

// 同 id 多节：首个位置替换、其余同 id 一并移除（解析器「后者覆盖」，留旧节会让查看器继续显示旧内容）；
// 中间的未命中节逐字节保留。被换下的节末尾空行属于旧节字节，新节不带它（字节级对换语义）
const dup = '## d1 旧A\nk: 1\n\n## mid 中间\nm: 1\n\n## d1 旧B\nk: 2\n\n## tail 尾\nt: 1\n';
eq(L.replaceLineInfoSection(dup, 'd1', '## d1 新\nk: 9\n'),
  '## d1 新\nk: 9\n## mid 中间\nm: 1\n\n## tail 尾\nt: 1\n', '同 id 多节＝首位置替换＋余同 id 移除，中间节不动');

// 标题解析边界（与 parseLineInfo 同口径）：「##」后前导/多重空白不影响首 token 绑 id
const liSpMd = '##   lg07   七号\r\nk: v\r\n';
eq(L.extractLineInfoSection(liSpMd, 'lg07'), liSpMd, '前导空白标题仍按首 token 绑 id');
eq(L.replaceLineInfoSection(liSpMd, 'lg07', '## lg07 换\n'), '## lg07 换\n', '替换命中前导空白标题');
ok(L.extractLineInfoSection(liSpMd, 'lg0') === null, 'id 不是完整 token 不命中');

// 三级标题不是节边界：### 相关链接 属于所在节，替换整节不越界到他节
const h3 = '## lg01 A\nx: 1\n\n正文\n\n### 相关链接\n[l](https://a)\n\n## lg02 B\ny: 2\n';
ok(L.extractLineInfoSection(h3, 'lg01').indexOf('### 相关链接') >= 0, '### 子节属所在节');
eq(L.replaceLineInfoSection(h3, 'lg01', '## lg01 A\n新正文\n'),
  '## lg01 A\n新正文\n## lg02 B\ny: 2\n', '替换含 ### 子节的整节，lg02 不受影响');
// 替换节不以行尾符结尾且后面还有内容：沿用原节末行行尾符补上（防后续标题被吞进正文行）
eq(L.replaceLineInfoSection('## a A\n旧文\n## b B\nx\n', 'a', '## a A\n新文'),
  '## a A\n新文\n## b B\nx\n', '新节无尾行尾符时自动补（文件尾节不受影响）');
eq(L.replaceLineInfoSection('## a A\n旧文\r\n## b B\nx\n', 'a', '## a A\n新文'),
  '## a A\n新文\r\n## b B\nx\n', '补行尾符沿用原节末行的 CRLF');

// 骨架与模板头（全占位符零真实内容）
const sk = L.lineInfoSectionSkeleton('lg42', '嘉闵线');
ok(sk.startsWith('## lg42 嘉闵线\n'), '骨架标题绑定线组 id＋名');
ok(sk.indexOf('起讫点: …') >= 0 && sk.indexOf('（正文……）') >= 0
  && sk.indexOf('[链接文字](https://…)') >= 0, '骨架字段区/正文/链接全占位符');
ok(sk.endsWith('\n'), '骨架以行尾符结尾');
eq(L.lineInfoSectionSkeleton('lg42', ''), '## lg42\n起讫点: …\n编组: …\n\n（正文……）\n\n### 相关链接\n[链接文字](https://…)\n', '无名线组骨架');
const tpl = require('fs').readFileSync(path_join('data', 'lineinfo.md'), 'utf8');
const head = L.lineInfoTemplateHeader(tpl);
ok(!head.split('\n').some((l) => /^##/.test(l)), '模板头去掉自带示例节（无行首 ## 行）');
ok(head.endsWith('\n\n'), '模板头以恰好一个空行结尾');
ok(/^# 线路信息（lineinfo\.md）/.test(head), '模板头保留文件标题');
eq(L.lineInfoTemplateHeader(''), '# 线路信息（lineinfo.md）\n\n', '空模板退化为中性标题');
eq(L.lineInfoTemplateHeader('## lg01 A\nx: 1\n'), '# 线路信息（lineinfo.md）\n\n', '以标题开头的模板退化');
const liNew = head + sk;
const pv = V.parseLineInfo(liNew);
eq(pv.lg42.fields, [['起讫点', '…'], ['编组', '…']], '模板头＋骨架可被查看器解析（字段占位）');
eq(pv.lg42.links, [{ text: '链接文字', url: 'https://…' }], '骨架相关链接可被解析');

// ---------- lineInfoTargets（介绍列表条目：线组行＋未入组线行；2026-11-23 放宽「绑线组 id 或线 id」） ----------
console.log('lineInfoTargets:');
// 无任何线组：全部线各占一行（绑线自身 id）——列表不能是空的
const lt0 = L.lineInfoTargets([], [
  { id: 'l01', name: '机场快线', color: '#123456', meta: { archived: false } },
  { id: 'l02', name: '', color: '#445566', meta: { archived: true } },
]);
eq(lt0.map((t) => t.id), ['l01', 'l02'], '无线组 → 全部线各一行（绑线自身 id）');
eq(lt0.map((t) => t.kind), ['line', 'line'], '全为线行');
eq(lt0.map((t) => t.name), ['机场快线', ''], '线行名＝线名（可空）');
eq(lt0[0].color, '#123456', '行 chip 色＝线色');
ok(lt0[0].archived === false && lt0[1].archived === true, '归档标随线携带');
// 混排：组行在前（原序）、未入组/悬空组的线在后（传入序）；已被现存组收编的线不重复出行
const lt1 = L.lineInfoTargets([
  { id: 'lg01', name: '1号线', color: '#aa0000' },
  { id: 'lg02', name: '', color: '#00aa00' },
], [
  { id: 'l03', name: '1号线主线', groupId: 'lg01', meta: {} },
  { id: 'l04', name: '2号线', groupId: null, meta: {} },
  { id: 'l05', name: '悬空组线', groupId: 'lgZZ', meta: { archived: true } },
]);
eq(lt1.map((t) => t.id + ':' + t.kind), ['lg01:group', 'lg02:group', 'l04:line', 'l05:line'],
  '组行在前、未入组线与悬空组线在后；组收编的 l03 不重复出行');
eq(lt1[0].name, '1号线', '组行名＝组名（可空组退空串）');
eq(lt1[2].name, '2号线', '线行名＝线名');
ok(lt1[3].archived === true, '悬空组线归档标照带');
eq(lt1.map((t) => t.kind), ['group', 'group', 'line', 'line'], 'kind 标注组行/线行');
// 无名组/无名线照出行（id 即标识）；缺 id 条目跳过；非数组入参 → 空表
eq(L.lineInfoTargets([{ id: 'lg9' }], [{ id: 'l9' }]).map((t) => t.id), ['lg9', 'l9'], '无名组/无名线照出行');
eq(L.lineInfoTargets([{ name: '无 id 组' }], [{ name: '无 id 线', meta: {} }]), [], '缺 id 条目跳过');
eq(L.lineInfoTargets(null, undefined), [], '非数组入参 → 空表');

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
