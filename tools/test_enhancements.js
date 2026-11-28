'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const V = require('../src/viewer_core.js');

const ROOT = path.resolve(__dirname, '..');
const linesFC = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/net/lines.geojson'), 'utf8'));
const stopsFC = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/net/stops.geojson'), 'utf8'));
const idxRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/net/index.json'), 'utf8'));
const timeline = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/net/timeline.json'), 'utf8'));

// 1. Geodesic & polyline slicing contracts
const d = V.haversineKm([121.4737, 31.2304], [121.4837, 31.2304]);
assert(d > 0.9 && d < 1.05, '1/100 deg lon at Shanghai lat should be ~0.95 km, got ' + d);

const poly = [[121.40, 31.20], [121.45, 31.20], [121.50, 31.20]];
const cum = V.polylineCumDistKm(poly);
const tot = cum[cum.length - 1];
assert(Math.abs(tot - V.polylineLengthKm(poly)) < 1e-9);
const half = V.slicePolylineByRatio(poly, cum, tot, 0.5);
assert(half && Math.abs(half.tip[0] - 121.45) < 1e-4, 'midpoint tip should be near 121.45');
const quarter = V.slicePolylineByRatio(poly, cum, tot, 0.25);
assert(quarter && Math.abs(quarter.tip[0] - 121.425) < 1e-4, 'quarter tip should be near 121.425');
assert.strictEqual(V.slicePolylineByRatio(poly, cum, tot, 0), null, 'ratio=0 yields null');

// 2. Real Shanghai dataset integration: line metrics, network metrics, station metrics, timeline coverage
const parsedIdx = V.parseNetIndex(idxRaw);
const linesMap = V.normalizeLines(linesFC);
const stops = V.stopList(stopsFC);
const lineGroups = V.buildLineGroups(linesMap, parsedIdx.lineGroups || []);
const groupTree = V.buildGroupTree(parsedIdx.stationGroups, stops);
const view = V.buildStopView(stops, { linesMap, lineGroups, tree: groupTree });

// Line 1 metrics
const m1 = V.computeLineMetrics('l0015', linesMap, stops, lineGroups, timeline);
assert(m1.totalKm > 37 && m1.totalKm < 38.5, 'Line 1 totalKm expected ~37.7, got ' + m1.totalKm);
assert.strictEqual(m1.stopCount, 29, 'Line 1 stopCount expected 29, got ' + m1.stopCount);
assert.strictEqual(m1.firstOpen, '1993-05-28');
assert(m1.stages.length >= 5, 'Line 1 should have >=5 chronological stages');
assert(m1.phaseKm.existing > 36 && m1.phaseKm.approved > 0.5);

// Grouped line (Line 10 = main + branch)
const m10 = V.computeLineMetrics('l0025', linesMap, stops, lineGroups, timeline);
assert(m10.mainKm > 40 && m10.branchKm > 4 && Math.abs(m10.totalKm - (m10.mainKm + m10.branchKm)) < 1e-6);

// Network metrics
const netAll = V.computeNetworkMetrics(linesMap, stops, lineGroups, view, { phaseActive: false });
const netEx = V.computeNetworkMetrics(linesMap, stops, lineGroups, view, { phaseActive: true, phases: new Set(['existing']) });
assert(netAll.total.km > 2500 && netAll.total.km < 3500, 'Total planning km unexpected: ' + netAll.total.km);
assert(netEx.active.km > 850 && netEx.active.km < 1050, 'Existing km unexpected: ' + netEx.active.km);
assert(netAll.total.stations > 700, 'Physical stations expected >700, got ' + netAll.total.stations);
assert(netEx.active.stations > 350 && netEx.active.stations < netAll.total.stations);

// Station metrics on People's Square (g0023 or similar multi-line station)
const peoplesSqPin = view.pins.find((p) => p.name === '人民广场') || (view.pills.find((pl) => pl.pin && pl.pin.name === '人民广场') || {}).pin;
assert(peoplesSqPin, 'People Square pin should exist');
const stFocus = V.stationFocusOf(peoplesSqPin, linesMap, lineGroups, groupTree, parsedIdx.indexOrder);
const stMetrics = V.computeStationMetrics(stFocus, peoplesSqPin, linesMap, stops, lineGroups, groupTree, timeline);
assert(stMetrics.lineDetails.length >= 3, 'People Square should have >=3 lines');
assert(stMetrics.transferLabel.includes('换乘站'));
assert(stMetrics.earliestOpen.startsWith('1995'), 'People Square opened 1995, got ' + stMetrics.earliestOpen);
assert(stMetrics.lineDetails.every((d) => Number.isFinite(d.cumKm) && d.prev && d.next));

// Timeline milestone resolution
assert.strictEqual(V.timelineMilestoneAt(timeline, 1993.41).title, '1号线南段通车');
assert(V.timelineMilestoneAt(timeline, 2025.99).title.includes('18号线二期'));
assert(V.timelineMilestoneAt(timeline, 2039.5).stage === 'corridor');

// Historical station name changes & line-scoped disambiguation (4号线 vs 6号线 浦电路)
assert.strictEqual(V.stationNameAt(timeline, '锦江乐园', ['l0015'], 1995.0), '虹梅路');
assert.strictEqual(V.stationNameAt(timeline, '锦江乐园', ['l0015'], 2002.0), '锦江乐园');
assert.strictEqual(V.stationNameAt(timeline, '世纪大道', ['l0016'], 2002.0), '东方路');
assert.strictEqual(V.stationNameAt(timeline, '世纪大道', ['l0016', 'l0018'], 2007.0), '世纪大道');
assert.strictEqual(V.stationNameAt(timeline, '浦东南路', ['l0016'], 2015.0), '东昌路');
assert.strictEqual(V.stationNameAt(timeline, '浦东南路', ['l0016', 'l0030'], 2024.8), '浦东南路');
assert.strictEqual(V.stationNameAt(timeline, '国家会展中心', ['l0016'], 2012.0), '徐泾东');
assert.strictEqual(V.stationNameAt(timeline, '国家会展中心', ['l0016', 'l0032'], 2020.0), '徐泾东 / 诸光路');
assert.strictEqual(V.stationNameAt(timeline, '国家会展中心', ['l0016', 'l0032'], 2025.0), '国家会展中心');
assert.strictEqual(V.stationNameAt(timeline, '浦电路', ['l0018'], 2010.0), '浦电路');
assert.strictEqual(V.stationNameAt(timeline, '浦电路', ['l0018'], 2025.0), '向城路');
assert.strictEqual(V.stationNameAt(timeline, '浦电路', ['l0020'], 2025.0), '浦电路');
assert.strictEqual(V.stationNameAt(timeline, '人民广场', ['l0015'], 1995.0), '人民广场');
assert.strictEqual(V.stationNameAt(timeline, '人民广场', ['l0016'], 2000.5), '人民公园');
assert.strictEqual(V.stationNameAt(timeline, '人民广场', ['l0016'], 2000.7), '人民广场');
assert.strictEqual(V.stationNameAt(timeline, '上海科技馆', ['l0033'], 2022.5), '迎春路');
assert.strictEqual(V.stationNameAt(timeline, '上海科技馆', ['l0016'], 2022.5), '上海科技馆');

// Line 5 branch -> Line 23 handover metadata, groundbreaking buildTime, and unapproved future/corridor ordering
const segL5Branch = V.segmentOpenMeta(timeline, 'l0038', 18);
assert(segL5Branch.handover && segL5Branch.handover.mainId === 'l0019' && segL5Branch.handover.beforeTime === 2028.95,
  'Line 5 branch (l0038 seg 18) should hand over from l0019 at 2028.95');
assert.strictEqual(segL5Branch.handover.color, '#944D9A');
assert.strictEqual(V.segmentOpenMeta(timeline, 'l0015', 20).buildTime, 1990.18, 'Line 1 groundbreaking should be 1990.18');
assert.strictEqual(V.segmentOpenMeta(timeline, 'l0015', 20).approveTime, 1986.62, 'Line 1 approval should be 1986.62');
assert.strictEqual(V.segmentOpenMeta(timeline, 'l0036', 6).buildTime, 2022.02, 'Line 21 groundbreaking should be 2022.02');
assert.strictEqual(V.segmentOpenMeta(timeline, 'l0036', 6).approveTime, 2018.95, 'Line 21 NDRC 3rd-round approval should be 2018.95');
assert.strictEqual(V.segmentOpenMeta(timeline, 'l0067', 0).approveTime, 2021.43, 'Shifanqu line approval should be 2021.43');
const seg20Mid = V.segmentOpenMeta(timeline, 'l0035', 10);
const seg26 = V.segmentOpenMeta(timeline, 'l0001', 0);
assert.strictEqual(seg20Mid.open, '预计2032-12');
assert.strictEqual(seg26.open, '远期规划', 'Line 26 should be 远期规划 without fabricated completion year');
assert.strictEqual(seg26.stage, 'future');
assert.strictEqual(seg26.approveTime, null, 'Unapproved Line 26 must not have an approveTime');
assert.strictEqual(seg26.buildTime, null, 'Unstarted Line 26 must not have a buildTime');
assert(seg26.time > seg20Mid.time, 'Line 26 must come strictly after all under-construction lines (20中段)');

// Plan approvals, near-term undated zone, deferred stations, and chronological key events contracts
assert(Array.isArray(timeline.planApprovals) && timeline.planApprovals.length >= 7, 'Should include all major construction plan approvals including 3rd-round re-adjustment');
assert(timeline.planApprovals.some((p) => p.title === '《上海轨道交通第三期建设规划》（2018年~2023年）'), 'Should include 3rd construction plan banner title');
assert(timeline.planApprovals.some((p) => p.title === '《上海轨道交通第三期建设规划再调整》（2018年~2032年）'), 'Should include 3rd construction plan re-adjustment (2018-2032)');
// Near-term undated planning zone strictly between 2032-12 (2032.95) and 远期规划 (2035.0)
for (const [lid, si, desc] of [
  ['l0016', 30, '2号线南延伸（T1/T2—T3）'],
  ['l0056', 22, '嘉闵线南延伸（银都路—旗忠网球中心）'],
  ['l0064', 2, '浦南线（上海科技馆—国际创新协同区）'],
  ['l0051', 4, '奉贤线一期'],
  ['l0062', 0, '南枫线 亭林—四团段'],
  ['l0062', 7, '南枫线 亭林—省界段'],
  ['l0065', 5, '南枫线 四团—滴水湖北段'],
]) {
  const sm = V.segmentOpenMeta(timeline, lid, si);
  assert.strictEqual(sm.stage, 'near_term', `${desc} should be in near_term stage`);
  assert.strictEqual(sm.open, '近期规划', `${desc} should display 近期规划`);
  assert(sm.time > seg20Mid.time && sm.time < seg26.time, `${desc} (${sm.time}) must be strictly between 2032-12 and 远期规划`);
}
assert(timeline.deferredStations && timeline.deferredStations['l0030-s08'] && timeline.deferredStations['l0026-s06'] && timeline.deferredStations['l0013-s32'],
  'Should include real deferred stations (14号线龙居路, 11号线陈翔公路, 15号线桂林路)');
// Line 19 north先行段 (2027-07) with 4 deferred intermediate stations (泰和路/兰岗路/铁山路/铁通路)
const seg19Early = V.segmentOpenMeta(timeline, 'l0034', 30);
const seg19Rest = V.segmentOpenMeta(timeline, 'l0034', 28);
assert.strictEqual(seg19Early.open, '预计2027-07', 'Line 19 江杨南路—上海宝山站 should open 2027-07');
assert.strictEqual(seg19Rest.open, '预计2028-12', 'Line 19 一二八纪念路—江杨南路 should open 2028-12');
for (const sid of ['l0034-s35', 'l0034-s36', 'l0034-s37', 'l0034-s38']) {
  const dr = timeline.deferredStations[sid];
  assert(dr && dr.builtTime === 2027.54 && dr.openTime === 2028.95, `Line 19 intermediate station ${sid} must be deferred 2027.54 -> 2028.95`);
}
// Line 13 West -> Line 29 handover on l0044 seg 8..10
const seg13West = V.segmentOpenMeta(timeline, 'l0044', 8);
assert.strictEqual(seg13West.open, '预计2027-10', 'l0044 seg 8 (前湾公园—国家会展中心) should first open 2027-10 as 13西延');
assert(seg13West.handover && seg13West.handover.mainId === 'l0029' && seg13West.handover.beforeLineId === 'l0044' && seg13West.handover.color === '#E999C0',
  'l0044 seg 8 must carry Line 13 handover metadata before Line 29 opens');
// Line 20 北新园路—高东东 (l0035 seg 22) must be unapproved 远期规划
const seg20East = V.segmentOpenMeta(timeline, 'l0035', 22);
assert.strictEqual(seg20East.open, '远期规划', 'Line 20 北新园路—高东东 must be 远期规划');
assert.strictEqual(seg20East.approveTime, null, 'Line 20 北新园路—高东东 must not have approveTime');
assert.strictEqual(seg20East.buildTime, null, 'Line 20 北新园路—高东东 must not have buildTime');
// Key events: rename & deferred station openings must include close-up coords & pauseMs >= 1200
assert(Array.isArray(timeline.keyEvents) && timeline.keyEvents.length >= 60, 'Should generate rich chronological keyEvents feed');
const renameEvents = timeline.keyEvents.filter((e) => e.type === 'rename');
const stationEvents = timeline.keyEvents.filter((e) => e.type === 'station');
assert(renameEvents.length >= 10, 'Should emit individual station rename events');
assert(stationEvents.length >= 10, 'Should emit individual deferred-station opening events');
for (const e of renameEvents.concat(stationEvents)) {
  assert(Array.isArray(e.coord) && e.coord.length === 2 && Number.isFinite(e.coord[0]) && Number.isFinite(e.coord[1]),
    `Event ${e.id} must carry valid WGS84 coord for close-up focus`);
  assert(e.pauseMs >= 2000, `Event ${e.id} must carry pauseMs >= 2000 for 5-phase fade transition`);
}
for (const e of stationEvents) {
  assert(typeof e.sid === 'string' && e.sid.length > 0, `Station event ${e.id} must carry sid`);
}
for (let i = 1; i < timeline.keyEvents.length; i++) {
  assert(timeline.keyEvents[i].time >= timeline.keyEvents[i - 1].time, 'keyEvents must be sorted chronologically');
}
// Zero non-station-name middle-dot (·) in timeline.json
const rawTl = JSON.stringify(timeline);
const allowedDotNames = ['一大会址·黄陂南路', '一大会址·新天地', '蟠祥路·国家会计学院'];
let cleanedTl = rawTl;
for (const nm of allowedDotNames) cleanedTl = cleanedTl.split(nm).join('');
assert(!cleanedTl.includes('·'), 'timeline.json must not contain any non-station-name middle-dot (·)');

console.log('ALL ENHANCEMENT TESTS PASSED!');
console.log(JSON.stringify({
  totalKm: Number(netAll.total.km.toFixed(1)),
  existingKm: Number(netAll.byPhase.existing.toFixed(1)),
  approvedKm: Number(netAll.byPhase.approved.toFixed(1)),
  futureKm: Number(netAll.byPhase.future.toFixed(1)),
  physicalStations: netAll.total.stations,
  existingStations: netEx.active.stations,
  totalLines: netAll.total.lines,
}, null, 2));
