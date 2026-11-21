#!/usr/bin/env node
// viewer_core.js 纯逻辑单测：数据归一（normalizeLines/stopList）、组归并（buildStopView）、
// 线路摘要与分组（lineSummaries/layerGroups）、搜索匹配（matchEntries）、标签分级（filterLabels）、
// 透明度表达式（buildLineOpacity）、单线导出（buildLineGeoJSON/buildLineKML）、颜色与转义工具。
// 用法：node tools/test_viewer_logic.js（纯 node，不引 jsdom/DOM/maplibre）

const V = require(path_join('src', 'viewer_core.js'));
function path_join(...p) { return require('path').join(__dirname, '..', ...p); }

let fails = 0;
function ok(cond, msg) {
  if (!cond) { console.log('  FAIL ' + msg); fails++; }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（got ${JSON.stringify(a)} want ${JSON.stringify(b)}）`); }

// ---------- fixture 工具 ----------
function lineFeat(lineId, segIndex, segStatus, coords, props) {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords },
    properties: Object.assign({ lineId, name: lineId + '名', segIndex, segStatus }, props || {}) };
}
function stopFeat(sid, name, lineId, lineName, t, lon, lat, groupId, groupType) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { sid, name, lineId, lineName, t, groupId: groupId || null, groupType: groupType || null } };
}
function fc(...features) { return { type: 'FeatureCollection', features }; }

// ---------- 基础小工具 ----------
console.log('xmlEscape / hexToKmlColor:');
eq(V.xmlEscape('<a & "b" \'c\'>'), '&lt;a &amp; &quot;b&quot; &apos;c&apos;&gt;', 'XML 五类字符全转义');
eq(V.xmlEscape(null), '', 'null 转空串');
eq(V.xmlEscape('中央站'), '中央站', '中文原样');
eq(V.hexToKmlColor('#ff0000'), 'ff0000ff', '红 → aabbggrr');
eq(V.hexToKmlColor('#009b77'), 'ff779b00', '绿 → 反转 rgb');
eq(V.hexToKmlColor('#ABC'), 'ffccbbaa', '三位缩写展开再反转');
eq(V.hexToKmlColor('ff0000', 0.45), '730000ff', 'alpha 0.45 → 0x73 前缀');
eq(V.hexToKmlColor('#123456', 0), '00563412', 'alpha 0 全透明');
eq(V.hexToKmlColor('not-a-color'), 'ffffffff', '非法色退白');
ok(V.normalizeHex('#E4002B') === '#e4002b', 'normalizeHex 小写化');
ok(V.normalizeHex('#xyz') === null, 'normalizeHex 非法 null');

// ---------- normalizeLines ----------
console.log('normalizeLines:');
const linesFC = fc(
  lineFeat('la', 0, 'existing', [[0, 0], [1, 0]], { name: '甲线', aliases: ['A Line', '甲'], color: '#ff0000', role: 'main', layer: '市区线' }),
  lineFeat('la', 1, 'future', [[1, 0], [2, 0]], { name: '甲线', color: '#ff0000' }),
  lineFeat('lb', 1, 'approved', [[5, 5], [6, 6]], { name: '乙线', color: 'xyz', role: 'standalone' }),   // segIndex 乱序输入
  lineFeat('lb', 0, 'approved', [[4, 4], [5, 5]], { name: '乙线' }),
  lineFeat('lc', 0, 'weird-status', [[7, 7], [8, 8]], { name: '丙线', layer: '联络线', role: 'connector' }),  // 未知 segStatus
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { segIndex: 0, segStatus: 'existing' } },  // 无 lineId
  { type: 'Feature', geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] }, properties: { lineId: 'bad1' } },              // 非 LineString
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0]] }, properties: { lineId: 'bad2' } },                              // 坐标不足
);
const lm = V.normalizeLines(linesFC);
eq([...lm.keys()], ['la', 'lb', 'lc'], '合法 3 条、坏 3 条跳过');
eq(lm.get('la').segments.map((s) => s.segStatus), ['existing', 'future'], 'la 段序＝segIndex');
eq(lm.get('lb').segments.map((s) => s.coords[0]), [[4, 4], [5, 5]], 'lb 乱序 segIndex 输入按升序排');
eq(lm.get('la').color, '#ff0000', '色值原样');
eq(lm.get('lb').color, '#888888', '非法色退默认灰');
eq(lm.get('lc').segments[0].segStatus, 'future', '未知 segStatus 退 future');
eq(lm.get('la').aliases, ['A Line', '甲'], '别名保留');
eq(lm.get('la').bbox, [0, 0, 2, 0], 'la bbox');
eq(lm.get('lb').bbox, [4, 4, 6, 6], 'lb bbox 跨段合并');
eq([...V.normalizeLines(null).keys()], [], 'null 输入不崩返回空');
eq([...V.normalizeLines(fc()).keys()], [], '空 FC 返回空');

// ---------- stopList ----------
console.log('stopList:');
const stopsFC = fc(
  stopFeat('s1', '单站甲', 'la', '甲线', 0.1, 0, 0),
  stopFeat('s2', '中央', 'la', '甲线', 0.5, 1, 1, 'g1', 'same-station'),
  stopFeat('s3', '中央', 'lb', '乙线', 0.5, 1, 1, 'g1', 'same-station'),
  stopFeat('s4', '中央', 'lc', '丙线', 0.5, 1, 1, 'g1', 'same-station'),
  stopFeat('s5', '接轨', 'la', '甲线', 0.8, 2, 2, 'g2', 'junction'),
  stopFeat('s6', '接轨', 'lc', '丙线', 0.2, 2, 2, 'g2', 'junction'),
  stopFeat('s7', '出闸西', 'la', '甲线', 0.3, 3, 3, 'g3', 'out-of-station'),
  stopFeat('s8', '出闸东', 'lb', '乙线', 0.7, 3.01, 3.01, 'g3', 'out-of-station'),
  stopFeat('s9', '孤组', 'lb', '乙线', 0.4, 4, 4, 'g4', 'same-station'),
  stopFeat('s10', '空串组', 'la', '甲线', 0.2, 5, 5, '', null),        // groupId 空串 → 无组
  stopFeat('s11', '怪类型', 'la', '甲线', 0.9, 6, 6, 'g5', 'weird'),   // groupType 未知 → null
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { sid: 'bad' } },  // 非 Point 跳过
);
const st = V.stopList(stopsFC);
eq(st.length, 11, '合法站 11 个、非 Point 跳过');
eq(st.find((s) => s.sid === 's10').groupId, null, '空串 groupId 归 null');
eq(st.find((s) => s.sid === 's11').groupType, null, '未知 groupType 归 null');
eq(st.find((s) => s.sid === 's2').groupType, 'same-station', '合法 groupType 保留');

// ---------- buildStopView：组归并 ----------
console.log('buildStopView:');
const sv = V.buildStopView(st);
eq(sv.pins.length, 8, 'pin 数＝单站2＋g1/g2/g4/g5合并各1＋g3成员2');
const g1 = sv.pins.find((p) => p.key === 'g:g1');
ok(g1 && g1.kind === 'group' && g1.big === true, 'g1 同站换乘合并大圈');
eq([g1.lon, g1.lat], [1, 1], 'g1 均值几何');
eq(g1.lineNames, ['甲线', '乙线', '丙线'], 'g1 成员线列表');
eq(g1.name, '中央', '组名取成员名');
ok(!sv.pins.some((p) => p.key === 's2' || p.key === 's3' || p.key === 's4'), '组成员个人小圈不画');
const g2 = sv.pins.find((p) => p.key === 'g:g2');
ok(g2 && g2.kind === 'group' && g2.big === false && g2.groupType === 'junction', 'g2 接轨站合并普通尺寸（不出大圈）');
const g3pins = sv.pins.filter((p) => p.groupType === 'out-of-station');
eq(g3pins.map((p) => p.key).sort(), ['s7', 's8'], '出闸组成员各自成圈');
eq(g3pins.every((p) => p.kind === 'stop' && p.big === false), true, '出闸成员普通尺寸');
eq(g3pins.map((p) => [p.lon, p.lat]).sort(), [[3, 3], [3.01, 3.01]], '出闸成员坐标各自保留');
const g4 = sv.pins.find((p) => p.key === 'g:g4');
ok(g4 && g4.kind === 'group' && g4.big === true, '单成员组照常成组');
const g5 = sv.pins.find((p) => p.key === 'g:g5');
ok(g5 && g5.kind === 'group' && g5.groupType === 'same-station', '组员 groupType 脏数据（stopList 归 null）兜底同站换乘');
eq(sv.labels.length, 7, '标签数＝单站2＋组5（g1/g2/g3/g4/g5 各一）');
const lg3 = sv.labels.find((l) => l.key === 'g:g3');
ok(lg3 && lg3.group === true && lg3.name === '出闸西', '出闸组仍合并为一个标签');
eq(sv.labels.filter((l) => l.group).length, 5, '组标签恰好 5 个');
eq(sv.labels.filter((l) => !l.group).map((l) => l.key).sort(), ['s1', 's10'], '无组站标签');
eq(V.buildStopView([]), { pins: [], labels: [] }, '空输入不崩');

// ---------- lineSummaries ----------
console.log('lineSummaries:');
const summ = V.lineSummaries(lm, st);
const sa = summ.get('la');
eq(sa.stopCount, 6, 'la 站数（s1/s2/s5/s7/s10/s11）');
eq(sa.firstStop, '单站甲', 'la 首站（t 最小）');
eq(sa.lastStop, '怪类型', 'la 末站（t 最大 0.9）');
eq(sa.terminals, ['单站甲', '怪类型'], 'la 起讫');
eq(sa.segCounts, { existing: 1, approved: 0, future: 1 }, 'la 分段计数');
eq(sa.stopsOrdered.map((s) => s.t), [0.1, 0.2, 0.3, 0.5, 0.8, 0.9], '站序 t 升序');
// t 缺失排最后
const st2 = V.stopList(fc(stopFeat('x1', '有t', 'la', '甲线', 0.5, 0, 0), stopFeat('x2', '无t', 'la', '甲线', null, 1, 1)));
const sa2 = V.lineSummaries(lm, st2).get('la');
eq(sa2.stopsOrdered.map((s) => s.name), ['有t', '无t'], 't 缺失排最后');
eq(sa2.terminals, ['有t', '无t'], '起讫按同序');
// 环线
const lmLoop = V.normalizeLines(fc(lineFeat('lr', 0, 'existing', [[0, 0], [1, 1]], { loop: true })));
const saL = V.lineSummaries(lmLoop, []).get('lr');
eq(saL.terminals, null, '环线无起讫');
eq(saL.stopCount, 0, '无线上站时站数 0');
eq(saL.firstStop, '', '无站首站空串');

// ---------- layerGroups ----------
console.log('layerGroups:');
const lgr = V.layerGroups(lm);
ok(lgr.length === 3, '三组（市区线/联络线/未分类）');
eq(lgr[lgr.length - 1].layer, null, '未分类恒最后');
const namedLayers = lgr.slice(0, -1).map((g) => g.layer).sort();
eq(namedLayers, ['市区线', '联络线'].sort(), '命名组集合正确（顺序无关）');
eq(lgr[lgr.length - 1].lines.map((l) => l.lineId), ['lb'], '乙线（layer 缺失）归未分类');
eq(V.layerGroups(new Map()), [], '空 Map 返回空');
const lm2 = V.normalizeLines(fc(
  lineFeat('la', 0, 'existing', [[0, 0], [1, 0]], { layer: '市区线' }),
  lineFeat('lz', 0, 'existing', [[0, 0], [1, 0]], { layer: '市区线' }),
  lineFeat('lb', 0, 'existing', [[0, 0], [1, 0]], { layer: '市区线' }),
));
eq(V.layerGroups(lm2)[0].lines.map((l) => l.lineId), ['la', 'lb', 'lz'], '组内按 lineId 升序');

// ---------- matchEntries ----------
console.log('matchEntries:');
const ents = [
  { type: 'line', id: 'la', text: '甲线', aliases: ['A Line', '甲'] },
  { type: 'line', id: 'lb', text: '乙线', aliases: [] },
  { type: 'stop', id: 's1', text: '甲子站', aliases: [] },
  { type: 'stop', id: 's2', text: '人民广场', aliases: [] },
  { type: 'stop', id: 's3', text: '民安路', aliases: [] },
];
eq(V.matchEntries('', ents).map((e) => e.id), [], '空查询空结果');
eq(V.matchEntries('zzz', ents).map((e) => e.id), [], '无命中空结果');
eq(V.matchEntries('甲', ents).map((e) => e.id), ['la', 's1'], '前缀命中：线路优先于站');
eq(V.matchEntries('a l', ents).map((e) => e.id), ['la'], '别名大小写不敏感包含命中');
eq(V.matchEntries('民', ents).map((e) => e.id), ['s3', 's2'], '前缀(s3)先于包含(s2)');
eq(V.matchEntries('线', ents, 1).map((e) => e.id), ['la'], 'limit 截断');
eq(V.matchEntries('线', ents).length, 2, '默认 limit 12 内全返');
eq(V.matchEntries('人民', null).length, 0, 'null 索引不崩');

// ---------- filterLabels ----------
console.log('filterLabels:');
const bigLabels = [];
for (let i = 0; i < 900; i++) bigLabels.push({ key: 's' + i, name: '站' + i, group: false });
for (let i = 0; i < 100; i++) bigLabels.push({ key: 'g' + i, name: '组' + i, group: true });
const smallLabels = bigLabels.slice(0, 700).concat(bigLabels.slice(900));   // 700 普通站＋100 组
eq(V.filterLabels(bigLabels, 9, 800).length, 0, 'z9 无标签');
eq(V.filterLabels(bigLabels, 10, 800).length, 100, 'z10 只组标签');
eq(V.filterLabels(bigLabels, 11.9, 800).length, 100, 'z11.9 仍只组标签');
eq(V.filterLabels(smallLabels, 12, 800).length, 800, 'z12 未超上限全部显示');
eq(V.filterLabels(bigLabels, 12, 800).length, 100, 'z12 超上限只显示换乘组');
eq(V.filterLabels(bigLabels, 12, 800).filter((l) => !l.group).length, 0, '超上限时普通站全滤除');
eq(V.filterLabels(bigLabels, 12, 2000).length, 1000, '上限放大则全显');
eq(V.filterLabels([], 15).length, 0, '空标签不崩');
eq(V.filterLabels(null, 15).length, 0, 'null 不崩');
eq(V.filterLabels(bigLabels, 12), V.filterLabels(bigLabels, 12, V.LABEL_CAP), '默认上限＝LABEL_CAP');

// ---------- buildLineOpacity ----------
console.log('buildLineOpacity:');
const statusExpr = ['match', ['get', 'segStatus'], 'existing', 1.0, 'approved', 0.75, 'future', 0.45, 0.9];
eq(V.buildLineOpacity([], true), statusExpr, '未选＋开关开 → 状态三档');
eq(V.buildLineOpacity([], false), 1.0, '未选＋开关关 → 全 1.0');
eq(V.buildLineOpacity(['la', 'lb'], true),
  ['case', ['in', ['get', 'lineId'], ['literal', ['la', 'lb']]], statusExpr, 0.08], '选中集 → 其余淡化 0.08');
eq(V.buildLineOpacity(['la'], false),
  ['case', ['in', ['get', 'lineId'], ['literal', ['la']]], 1.0, 0.08], '选中＋开关关 → 选中线全 1.0');
eq(V.buildLineOpacity(['la', 'la'], false), V.buildLineOpacity(['la'], false), '选中集去重');
eq(V.buildLineOpacity(null, true), statusExpr, 'null 选中集不崩');

// ---------- buildLineGeoJSON ----------
console.log('buildLineGeoJSON:');
const gj = V.buildLineGeoJSON('la', lm, st);
ok(gj && gj.type === 'FeatureCollection', '导出为 FC');
eq(gj.features[0].geometry.type, 'MultiLineString', '线为 MultiLineString');
eq(gj.features[0].geometry.coordinates, [[[0, 0], [1, 0]], [[1, 0], [2, 0]]], '段序＝segIndex');
eq(gj.features[0].properties.segStatuses, ['existing', 'future'], '段状态随线导出');
eq(gj.features.length, 1 + 6, 'features＝1 线＋6 站');
eq(gj.features[1].properties.sid, 's1', '站序 t 升序（首个 t=0.1）');
eq(gj.features.find((f) => f.properties.sid === 's2').properties.groupId, 'g1', '站 groupId 保留');
ok(gj.features.slice(1).every((f) => f.geometry.type === 'Point'), '站全为 Point');
ok(V.buildLineGeoJSON('nope', lm, st) === null, '未知线路返回 null');

// ---------- buildLineKML ----------
console.log('buildLineKML:');
const escStops = V.stopList(fc(
  stopFeat('k1', '甲<&>"\'站', 'la', '甲线', 0.2, 0.2, 0.3),
  stopFeat('k2', '乙站', 'la', '甲线', 0.8, 1.5, 0.1, 'g9', 'junction'),
));
const kml = V.buildLineKML('la', lm, escStops);
ok(kml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'XML 声明头');
ok(kml.endsWith('</kml>'), 'kml 闭合尾');
ok(kml.includes('<kml xmlns="http://www.opengis.net/kml/2.2">'), 'KML 命名空间');
for (const sid of ['seg-existing', 'seg-approved', 'seg-future']) ok(kml.includes('id="' + sid + '"'), '样式 ' + sid);
ok((kml.match(/<Placemark>/g) || []).length === 4, 'Placemark＝2 段＋2 站');
ok(kml.includes('<name>' + V.xmlEscape('甲<&>"\'站') + '</name>'), '站名 XML 转义');
ok(kml.includes('0.200000,0.300000,0'), '站坐标 6 位小数');
ok(kml.includes('0.000000,0.000000,0 1.000000,0.000000,0'), '段坐标逐点一致');
ok(kml.includes('<color>ff0000ff</color>'), 'existing 段全不透明（#ff0000 → ff0000ff）');
const kmlFut = V.buildLineKML('lc', lm, []);
ok(kmlFut.includes('<color>73'), 'lc（未知状态退 future）alpha 0x73');
const kmlFlat = V.buildLineKML('lc', lm, [], { emphasizeExisting: false });
ok(kmlFlat.includes('<color>ff'), '关闭突出既有时 KML 全不透明');
ok(!kmlFlat.includes('<color>73'), '不再含半透明色');
ok(V.buildLineKML('nope', lm, st) === null, '未知线路返回 null');
ok(V.buildLineKML('la', lm, escStops, { lineWidth: 5 }).includes('<width>5</width>'), 'lineWidth 透传');

// ---------- 链路小集成：归一 → 视图 → 摘要 ----------
console.log('integration:');
const lmI = V.normalizeLines(linesFC);
const stI = V.stopList(stopsFC);
const svI = V.buildStopView(stI);
const summI = V.lineSummaries(lmI, stI);
eq(svI.pins.length, 8, '集成视图 pin 数一致');
eq(summI.get('la').stopCount, 6, '集成摘要站数一致');
ok([...summI.keys()].sort().join(',') === 'la,lb,lc', '摘要覆盖全部线');

console.log(fails ? `\nFAIL - ${fails} assertion(s)` : '\nPASS - viewer logic OK');
process.exit(fails ? 1 : 0);
