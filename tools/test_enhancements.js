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
