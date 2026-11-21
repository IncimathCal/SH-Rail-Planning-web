#!/usr/bin/env node
// viewer_core.js 纯逻辑单测：数据归一（normalizeLines/stopList）、组归并（buildStopView）、
// 线路摘要与分组（lineSummaries/layerGroups）、搜索匹配（matchEntries）、标签分级（filterLabels）、
// 透明度表达式（buildLineOpacity）、单线导出（buildLineGeoJSON/buildLineKML）、颜色与转义工具、
// 药丸链序（planGroupPillChain：确定性/平手/共线点/n=2~4）、出省箭头（kind:'arrow' 方向推导、
// 搜索/摘要/导出排除）、手造输入链路（arrow＋3 线 same 组）。
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
  stopFeat('s12', '双线组', 'la', '甲线', 0.4, 7, 7, 'g6', 'same-station'),   // 恰 2 线同站组 → 维持合并大圈
  stopFeat('s13', '双线组', 'lb', '乙线', 0.6, 7, 7, 'g6', 'same-station'),
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { sid: 'bad' } },  // 非 Point 跳过
);
const st = V.stopList(stopsFC);
eq(st.length, 13, '合法站 13 个、非 Point 跳过');
eq(st.find((s) => s.sid === 's10').groupId, null, '空串 groupId 归 null');
eq(st.find((s) => s.sid === 's11').groupType, null, '未知 groupType 归 null');
eq(st.find((s) => s.sid === 's2').groupType, 'same-station', '合法 groupType 保留');

// ---------- buildStopView：组归并 ----------
console.log('buildStopView:');
const sv = V.buildStopView(st);
eq(sv.pins.length, 11, 'pin 数＝单站2＋g1药丸成员3＋g2/g4/g5/g6合并各1＋g3成员2');
const g1pill = sv.pills.find((p) => p.key === 'p:g1');
ok(g1pill && g1pill.lineIds.join(',') === 'la,lb,lc', 'g1（3 线同站组）产出药丸');
eq(g1pill.chain, [[1, 1], [1, 1], [1, 1]], 'g1 药丸链序（共点退化，顺序 [0,1,2]）');
ok(!sv.pins.some((p) => p.key === 'g:g1'), 'g1 不再画合并大圈（药丸替代）');
const g1m = sv.pins.filter((p) => p.key === 's2' || p.key === 's3' || p.key === 's4');
eq(g1m.length, 3, 'g1 成员站圈照常各自出现（叠在药丸上）');
eq(g1m.every((p) => p.kind === 'stop' && p.big === false && p.groupId === 'g1' && p.groupType === 'same-station'), true,
  '药丸成员圈普通尺寸、带组号（线色描边走渲染层默认分支）');
const g6 = sv.pins.find((p) => p.key === 'g:g6');
ok(g6 && g6.kind === 'group' && g6.big === true, 'g6 恰 2 线同站组维持合并大圈（现状完全不动）');
ok(!sv.pills.some((p) => p.groupId === 'g6'), '2 线组不出药丸');
ok(!sv.pins.some((p) => p.key === 's12' || p.key === 's13'), '2 线组成员个人小圈仍不画');
const g2 = sv.pins.find((p) => p.key === 'g:g2');
ok(g2 && g2.kind === 'group' && g2.big === false && g2.groupType === 'junction', 'g2 接轨站合并普通尺寸（不出大圈）');
ok(!sv.pills.some((p) => p.groupId === 'g2'), 'junction 组不出药丸');
const g3pins = sv.pins.filter((p) => p.groupType === 'out-of-station');
eq(g3pins.map((p) => p.key).sort(), ['s7', 's8'], '出闸组成员各自成圈');
eq(g3pins.every((p) => p.kind === 'stop' && p.big === false), true, '出闸成员普通尺寸');
eq(g3pins.map((p) => [p.lon, p.lat]).sort(), [[3, 3], [3.01, 3.01]], '出闸成员坐标各自保留');
eq(g3pins.every((p) => p.groupId === 'g3'), true, '出闸成员 pin 携带 groupId（组内车站查询用）');
ok(sv.pins.find((p) => p.key === 's1').groupId == null, '无组站 pin groupId 为 null');
const g4 = sv.pins.find((p) => p.key === 'g:g4');
ok(g4 && g4.kind === 'group' && g4.big === true, '单成员组照常成组');
const g5 = sv.pins.find((p) => p.key === 'g:g5');
ok(g5 && g5.kind === 'group' && g5.groupType === 'same-station', '组员 groupType 脏数据（stopList 归 null）兜底同站换乘');
eq(sv.pills.length, 1, '全库仅 g1 满足 ≥3 线（其余组不出药丸）');
eq(sv.labels.length, 8, '标签数＝单站2＋组6（g1/g2/g3/g4/g5/g6 各一）');
const lg1 = sv.labels.find((l) => l.key === 'g:g1');
ok(lg1 && lg1.group === true && lg1.name === '中央', '药丸组仍合并为一个标签（均值位置）');
const lg3 = sv.labels.find((l) => l.key === 'g:g3');
ok(lg3 && lg3.group === true && lg3.name === '出闸西', '出闸组仍合并为一个标签');
eq(sv.labels.filter((l) => l.group).length, 6, '组标签恰好 6 个');
eq(sv.labels.filter((l) => !l.group).map((l) => l.key).sort(), ['s1', 's10'], '无组站标签');
eq(V.buildStopView([]), { pins: [], pills: [], arrows: [], labels: [] }, '空输入不崩');

// ---------- lineSummaries ----------
console.log('lineSummaries:');
const summ = V.lineSummaries(lm, st);
const sa = summ.get('la');
eq(sa.stopCount, 7, 'la 站数（s1/s2/s5/s7/s10/s11/s12）');
eq(sa.firstStop, '单站甲', 'la 首站（t 最小）');
eq(sa.lastStop, '怪类型', 'la 末站（t 最大 0.9）');
eq(sa.terminals, ['单站甲', '怪类型'], 'la 起讫');
eq(sa.segCounts, { existing: 1, approved: 0, future: 1 }, 'la 分段计数');
eq(sa.stopsOrdered.map((s) => s.t), [0.1, 0.2, 0.3, 0.4, 0.5, 0.8, 0.9], '站序 t 升序');
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

// ---------- statusOpacity / buildSegLayerOpacity（按 segStatus 拆层版） ----------
console.log('statusOpacity / buildSegLayerOpacity:');
eq(V.statusOpacity('existing', true), 1.0, '既有全不透明');
eq(V.statusOpacity('approved', true), 0.75, '已批复 0.75');
eq(V.statusOpacity('future', true), 0.45, '远期 0.45');
eq(V.statusOpacity('weird', true), 0.9, '未知状态兜 0.9（与 match 版默认一致）');
eq(V.statusOpacity('future', false), 1.0, '开关关＝全 1.0');
eq(V.buildSegLayerOpacity([], 'future', true), 0.45, '无选中 → 常量透明度');
eq(V.buildSegLayerOpacity(null, 'approved', false), 1.0, 'null 选中集不崩');
eq(V.buildSegLayerOpacity(['la', 'la'], 'future', true),
  ['case', ['in', ['get', 'lineId'], ['literal', ['la']]], 0.45, 0.08], '选中集去重＋未选淡化 0.08');
eq(V.buildSegLayerOpacity(['lb'], 'existing', false),
  ['case', ['in', ['get', 'lineId'], ['literal', ['lb']]], 1.0, 0.08], '开关关＋选中 → 选中线 1.0');

// ---------- stopDisplayName / formatTerminals（显示文案） ----------
console.log('stopDisplayName / formatTerminals:');
eq(V.stopDisplayName('中央站'), '中央站', '有名站原名');
eq(V.stopDisplayName(''), V.UNNAMED_STOP_ZH, '空名 → 未命名站占位');
eq(V.stopDisplayName(null), V.UNNAMED_STOP_ZH, 'null 名不崩');
eq(V.stopDisplayName(123), V.UNNAMED_STOP_ZH, '非字符串名不崩');
eq(V.formatTerminals({ loop: true, terminals: null }), '环线（无起讫）', '环线文案');
eq(V.formatTerminals({ loop: false, terminals: ['单站甲', '怪类型'] }), '单站甲 — 怪类型', '正常起讫');
eq(V.formatTerminals({ loop: false, terminals: ['', ''] }), '—', '零站线两端全空 → —（修复旧版输出 " — "）');
eq(V.formatTerminals({ loop: false, terminals: ['', '乙'] }), V.UNNAMED_STOP_ZH + ' — 乙', '单端无名 → 占位');
eq(V.formatTerminals({ loop: false, terminals: ['甲'] }), '甲 — ' + V.UNNAMED_STOP_ZH, '缺末端 → 占位');
eq(V.formatTerminals(null), '—', 'null 摘要不崩');
eq(V.formatTerminals({ loop: false }), '—', '无 terminals 字段不崩');

// ---------- buildLineGeoJSON ----------
console.log('buildLineGeoJSON:');
const gj = V.buildLineGeoJSON('la', lm, st);
ok(gj && gj.type === 'FeatureCollection', '导出为 FC');
eq(gj.features[0].geometry.type, 'MultiLineString', '线为 MultiLineString');
eq(gj.features[0].geometry.coordinates, [[[0, 0], [1, 0]], [[1, 0], [2, 0]]], '段序＝segIndex');
eq(gj.features[0].properties.segStatuses, ['existing', 'future'], '段状态随线导出');
eq(gj.features.length, 1 + 7, 'features＝1 线＋7 站');
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
eq(svI.pins.length, 11, '集成视图 pin 数一致');
eq(summI.get('la').stopCount, 7, '集成摘要站数一致');
ok([...summI.keys()].sort().join(',') === 'la,lb,lc', '摘要覆盖全部线');

// ---------- planGroupPillChain（≥3 线药丸链序，与编辑器侧逐字节同规格） ----------
console.log('planGroupPillChain:');
eq(V.planGroupPillChain([]), [], '空输入空序');
eq(V.planGroupPillChain([[3, 4]]), [0], '单点返回 [0]');
eq(V.planGroupPillChain([[5, 5], [1, 1]]), [0, 1], 'n=2 两向等长 → 字典序 [0,1]');
eq(V.planGroupPillChain([[0, 0], [1, 0], [0, 1]]), [1, 0, 2], 'n=3 直角形中点作端（总长 2.0＜2.414），等长两条取字典序');
eq(V.planGroupPillChain([[0, 0], [1, 0], [1, 1], [0, 1]]), [0, 1, 2, 3], 'n=4 正方形四起点等长 → 字典序 [0,1,2,3]');
eq(V.planGroupPillChain([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 1 }, { x: 0, y: 1 }]), [0, 3, 2, 1],
  'n=4 矩形 {x,y} 对象点形 → [0,3,2,1]');
eq(V.planGroupPillChain([[0, 0], [2, 0], [1, 0], [3, 0]]), [0, 2, 1, 3], '共线乱序点贪心往返（总长 3 平手取字典序）');
eq(V.planGroupPillChain([[0, 0], [10, 0], [2, 0], [1, 0]]), [0, 3, 2, 1], '共线近簇先吃尽再走远端（整数坐标总长严格平手）');
eq(V.planGroupPillChain([[0, 0], [1, 0], [2, 0], [0, 10]]), [2, 1, 0, 3], '跨起点总长分胜负（12.0＜12.198）＋等长链取字典序');
eq(V.planGroupPillChain([[7, 7], [8, 8], [9, 9]]), V.planGroupPillChain([[7, 7], [8, 8], [9, 9]]), '同输入同输出（确定性）');
eq(V.planGroupPillChain([null, [1, 1]]), [0, 1], '坏点容错（null 点按 0,0 参与选序不崩）');

// ---------- 出省箭头（stop.kind:'arrow'，非站） ----------
console.log('arrows:');
const arFeat = (sid, lineId, t, lon, lat, lineName) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { sid, name: '', lineId, lineName, t, kind: 'arrow' },
});
const arrowFC = fc(
  lineFeat('lm', 0, 'future', [[0, 0], [3, 0]], { name: 'M线', color: '#00ff00' }),
  lineFeat('ln', 0, 'future', [[0, 10], [0, 11]], { name: 'N线', color: '#0000ff' }),
  stopFeat('m1', '甲站', 'lm', 'M线', 0, 0, 0),
  stopFeat('m2', '乙站', 'lm', 'M线', 1, 2, 0),
  stopFeat('n1', '丙站', 'ln', 'N线', 1, 0, 10),
  arFeat('ar1', 'lm', 1.5, 3, 0, 'M线'),    // 东行：邻站＝乙站（t=1，|Δt|=0.5 最小）
  arFeat('ar2', 'ln', 1.2, 0, 11, 'N线'),   // 北行：邻站＝丙站
  arFeat('ar3', 'lo', 0.5, 1, 1, 'O线'),    // lo 线无真实站 → 无邻站
  arFeat('ar4', 'lp', null, 1, 1, 'P线'),   // arrow 无 t → 几何最近邻兜底
  stopFeat('p1', '丁站', 'lp', 'P线', null, 0, 0),
  arFeat('ar5', 'lq', 0.5, 9, 9, 'Q线'),    // 与邻站重合 → 方向退化
  stopFeat('q1', '戊站', 'lq', 'Q线', 0.4, 9, 9),
);
const stAr = V.stopList(arrowFC);
eq(stAr.find((s) => s.sid === 'm1').kind, 'stop', '缺 kind 字段归 stop');
eq(stAr.find((s) => s.sid === 'ar1').kind, 'arrow', 'kind:"arrow" 保留（不剔除）');
const svAr = V.buildStopView(stAr);
eq(svAr.arrows.length, 5, '5 个 arrow 全进 arrows 视图');
ok(!svAr.pins.some((p) => String(p.key).indexOf('ar') === 0) && !svAr.labels.some((l) => String(l.key).indexOf('ar') === 0),
  'arrow 不进 pins/labels（搜索索引随 labels 一并排除）');
const ar1 = svAr.arrows.find((a) => a.key === 'ar1') || {};
eq(ar1.neighborSid, 'm2', '邻站＝同线 t 序最近真实站');
ok(Math.abs(ar1.angleDeg - 90) < 1e-9, '东向箭头 angleDeg=90（icon-rotate 语义：0 指北、顺时针）');
const ar2 = svAr.arrows.find((a) => a.key === 'ar2') || {};
eq(ar2.neighborSid, 'n1', '北向箭头邻站＝丙站');
ok(Math.abs(ar2.angleDeg) < 1e-9, '北向箭头 angleDeg=0');
const ar4 = svAr.arrows.find((a) => a.key === 'ar4') || {};
eq(ar4.neighborSid, 'p1', 'arrow 无 t → 几何最近邻兜底（防御）');
ok(Math.abs(ar4.angleDeg - 45) < 0.01, '东北向 ≈45°（经度×cos(纬度) 平面近似）');
eq((svAr.arrows.find((a) => a.key === 'ar3') || {}).angleDeg, null, '取不到邻站 → angleDeg null（渲染退小圆点）');
eq((svAr.arrows.find((a) => a.key === 'ar5') || {}).angleDeg, null, '与邻站重合 → angleDeg null');
const lmAr = V.normalizeLines(arrowFC);
const sumAr = V.lineSummaries(lmAr, stAr);
eq(sumAr.get('lm').stopCount, 2, 'lineSummaries 不把 arrow 计为站');
eq(sumAr.get('lm').terminals, ['甲站', '乙站'], '起讫不含 arrow');
eq(sumAr.get('lm').stopsOrdered.map((s) => s.sid), ['m1', 'm2'], '站序不含 arrow');
const gjAr = V.buildLineGeoJSON('lm', lmAr, stAr);
eq(gjAr.features.filter((f) => f.geometry.type === 'Point').map((f) => f.properties.sid), ['m1', 'm2'],
  'GeoJSON 导出剔除 arrow');
ok(!V.buildLineKML('lm', lmAr, stAr).includes('ar1'), 'KML 导出剔除 arrow');

// ---------- 手造输入链路自证：arrow＋3 线 same 组一起过纯逻辑（不起浏览器） ----------
console.log('pill+arrow integration:');
const pillFC = fc(
  lineFeat('lx', 0, 'approved', [[8, 0], [9, 0], [9, 1]], { name: 'X线', color: '#ff0000' }),
  lineFeat('ly', 0, 'approved', [[8, 0], [9, 1]], { name: 'Y线', color: '#00ff00' }),
  lineFeat('lz', 0, 'approved', [[9, 0], [9, 1]], { name: 'Z线', color: '#0000ff' }),
  stopFeat('x1', '药丸甲', 'lx', 'X线', 0.1, 8, 0, 'g9', 'same-station'),
  stopFeat('y1', '药丸乙', 'ly', 'Y线', 0.9, 9, 0, 'g9', 'same-station'),
  stopFeat('z1', '药丸丙', 'lz', 'Z线', 0.5, 9, 1, 'g9', 'same-station'),
  arFeat('arx', 'lx', 1.5, 10, 0, 'X线'),   // 组外出省箭头：邻站＝x1（t 序唯一真实站）
);
const stP = V.stopList(pillFC);
const svP = V.buildStopView(stP);
const pill9 = svP.pills.find((p) => p.groupId === 'g9') || { chain: null };
ok(svP.pills.length === 1, 'g9（3 线同站组）恰出一枚药丸');
eq(pill9.chain, [[8, 0], [9, 0], [9, 1]], '链序＝贪心最近邻（n=3 连 2 段，非两两相连）');
eq(svP.pins.filter((p) => p.groupId === 'g9').map((p) => p.key).sort(), ['x1', 'y1', 'z1'], '三成员圈照常叠于药丸上');
ok(!svP.pins.some((p) => p.kind === 'group' && p.groupId === 'g9'), '药丸组不再有合并大圈 pin');
eq(svP.arrows.map((a) => a.key), ['arx'], 'arrow 与药丸并存互不干扰');
ok(Math.abs(svP.arrows[0].angleDeg - 90) < 1e-9, 'arx 东向 90°（邻站＝x1）');
eq(svP.labels.filter((l) => l.group).map((l) => l.key), ['g:g9'], '药丸组合并为一个组标签');
const sumP = V.lineSummaries(V.normalizeLines(pillFC), stP);
eq(sumP.get('lx').stopCount, 1, 'lx 站数不含 arrow（药丸成员照常计数）');

console.log(fails ? `\nFAIL - ${fails} assertion(s)` : '\nPASS - viewer logic OK');
process.exit(fails ? 1 : 0);
