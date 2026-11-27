#!/usr/bin/env node
// viewer_core.js 纯逻辑单测：数据归一（normalizeLines/stopList）、组归并（buildStopView）、
// 线路摘要与分组（lineSummaries/layerGroups/visibleListGroups 类别过滤）、搜索匹配
//（matchEntries）、标签分级与可见性（filterLabels zoom 门槛 11 组站统一＋visibleLabels 优先级：
// 全局开关＞聚焦常显·其余隐藏＞车站态单显 stationKey＞调光隐藏＞zoom 门槛——2026-11-22
// 真机反馈轮：聚焦时非聚焦线站名一律隐藏、focusMembers 组成员集常显；2026-11-27 用户裁定
// 车站高亮态＝只有被点站/组标签显示且常显）、调光纯逻辑（linePhaseOf 线路期次归类/
// lineLayerRank 仅显示级/computeDimmedSet 分期＋displayOnly/nextPhase 四档循环）、尺寸缩放
//冻结改等比（zoomInterp/scaledSize：z≥11 封顶、z<11 按 2^(z−11) 与画布同比例）、单线导出（buildLineGeoJSON/buildLineKML——2026-11-22
// 改版后纯色实线统一不透明）、颜色与转义工具、药丸链序（planGroupPillChain）、出省渐隐
//（kind:'arrow' 过滤＋arrowFadePlan/arrowFadeGradient——2026-11-22 改版：查看器以线身
// 末端 1km 渐隐示意出省）、手造输入链路（arrow＋3 线 same 组）、GCJ02 显示变换（与
// src/geom.js 逐点对拍守卫——防两份副本漂移；makeDispCoord 三态）。
// 2026-11-22 增：主支线合并（buildLineGroups 双向并集归属/无 main 组不合并/layerGroups
// 合并行/lineSearchEntries＋terms 合并命中/computeDimmedSet 组级调光/lineLabelOf·
// linesOfPin 站牌组名）；地图双击线路精确命中（lineWidthAt 与线宽表达式同源求值/
// pointToScreenPolylineDist 点到折线最小屏幕距离——描边内外、段外端点距、多段最小、空防御）。
// 2026-11-22 四项改版增：联络线双端渐变取色（connectorBlendPlan：2 线方向判定/
// connects<2/目标不存在/≥3 每端各最近/两端同线/目标或自身无坐标防御/多段拼接——
// 中途设站不影响 plan，其端到端抽查在 flatten 侧）、stopList/pinOfStop 的 stroke 透传
//（联络线站圈描边＝最近端目标线色）。
// 2026-11-22 定案轮改写：computeDimmedSet 白罩定案恒定语义（聚焦不贡献 dim、focus 仅作
// displayOnly 激活位；旧 hlMode 分支用例删除）；arrows glyph 视图用例改写为 arrowFadePlan
//（head/tail/两端/非端点忽略/无 arrow 不进 plan/<1km clamp/平面近似总长手算对照）＋
// arrowFadeGradient（端组合 stops、整线渐变收并、双端重叠收缩、恰衔接并段）。
// 2026-11-22 真数据抓包（「单线站名不见了」）：删初版自设的 LABEL_CAP=800 与 cap 入参——
// 它数整份数据的标签总数，用户 58 线真数据 1040 个标签单元一超限，普通站名在一切 zoom
// 全灭；用例改写为纯 zoom 门槛＋千级规模全链路回归（scaleLabels）。
// 2026-11-23 增：嵌套换乘组（parseNetIndex 三版放行与字段判型／buildGroupTree 查组·父组·子组·
// 最外层组·叶站／buildStopView 节点出图：中辰路·上海金山·中华艺术宫三形态＋出闸递归＋junction
// 递归取叶站／logicalLineCount 药丸线数口径／groupRelations 关系描述／导出补注；回归＝旧实现
// 对干净夹具的输出快照逐字段冻结；防御＝未知子组 id、无站组、成环、自指、多父、表外组、脏条目）。
// 2026-11-23 增：预控通道虚线分类（lineDashed/DASHED_LAYERS——meta.layer 判别，渲染层
// 据此分虚实两层；viewer.js 侧 paint 参数不在纯逻辑层，不在此测）。
// 2026-11-23 增：线路信息面板（parseLineInfo——lineinfo.md 手填介绍解析：多组/字段区切分/
// 链接节/转义注入/恶意 URL 拒绝/空文件与缺组防御；safeLinkUrl 白名单）；同日放宽节绑定＝
//「线组 id 或线 id」（lineInfoEntryOf：有组线组节优先、查不到落线自身 id、无名线退线 id）。
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
eq(sv.pins.length, 8, 'pin 数＝单站2＋g2/g4/g5/g6合并各1＋g3成员2（g1 药丸成员圈隐去）');
const g1pill = sv.pills.find((p) => p.key === 'g:g1');
ok(g1pill && g1pill.lineIds.join(',') === 'la,lb,lc', 'g1（3 线同站组）产出药丸（key 即组 pin 的 key）');
eq(g1pill.chain, [[1, 1], [1, 1], [1, 1]], 'g1 药丸链序（共点退化，顺序 [0,1,2]）');
ok(!sv.pins.some((p) => p.key === 'g:g1'), 'g1 不再画合并大圈（药丸替代）');
eq(sv.pins.filter((p) => p.key === 's2' || p.key === 's3' || p.key === 's4').length, 0,
  'g1 成员站圈不再出现（药丸即换乘标识）');
ok(g1pill.pin && g1pill.pin.kind === 'group' && g1pill.pin.big === true
  && g1pill.pin.groupType === 'same-station' && g1pill.pin.groupId === 'g1' && g1pill.pin.name === '中央',
  '药丸条目自带组 pin（面板/hover 单元，不进 pins 不渲染成圈）');
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
// 2026-11-22 改版：标签携带 lineIds（站名可见性判定用——全局开关/聚焦常显/调光隐藏）
eq((sv.labels.find((l) => l.key === 's1') || {}).lineIds, ['la'], '单站标签 lineIds＝本线');
eq((sv.labels.find((l) => l.key === 'g:g1') || {}).lineIds, ['la', 'lb', 'lc'], '组标签 lineIds＝成员线去重');
eq((sv.labels.find((l) => l.key === 'g:g3') || {}).lineIds, ['la', 'lb'], '出闸组标签 lineIds＝两成员线');
eq(sv.labels.filter((l) => l.group).length, 6, '组标签恰好 6 个');
eq(sv.labels.filter((l) => !l.group).map((l) => l.key).sort(), ['s1', 's10'], '无组站标签');
eq(V.buildStopView([]), { pins: [], pills: [], labels: [] }, '空输入不崩（2026-11-22 改版后无 arrows 视图）');

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

// ---------- filterLabels（换乘组/站 z≥10，普通单线站 z≥11） ----------
console.log('filterLabels:');
ok(V.LABEL_ZOOM_STOP === 11 && V.LABEL_ZOOM_GROUP === 10, '门槛常量：换乘组/站 10，普通单线站 11');

ok(!('LABEL_CAP' in V) && V.filterLabels.length === 2 && V.visibleLabels.length === 3,
  '标签总数上限已删：无 LABEL_CAP 导出，filterLabels/visibleLabels 不再收 cap 入参（2026-11-22 真数据抓包）');
const bigLabels = [];
for (let i = 0; i < 900; i++) bigLabels.push({ key: 's' + i, name: '站' + i, group: false });
for (let i = 0; i < 100; i++) bigLabels.push({ key: 'g' + i, name: '组' + i, group: true });
eq(V.filterLabels(bigLabels, 9).length, 0, 'z9 无标签');
eq(V.filterLabels(bigLabels, 10).length, 100, 'z10 仅换乘组标签显示');
eq(V.filterLabels(bigLabels, 10.99).length, 100, 'z10.99 普通单线站仍隐藏');
eq(V.filterLabels([{ group: false, groupType: 'out-of-station' }, { group: false, groupType: null }], 10).length, 1,
  'z10 按真实 groupType 字段显示出闸换乘站标签，不看名称');
eq(V.filterLabels([{ group: true, groupType: 'junction' }, { group: false, groupType: null }], 10).length, 1,
  'z10 按真实 group 字段显示换乘组标签');

eq(V.filterLabels(bigLabels, 11).length, 1000, 'z11 全部显示——1000 个标签单元（超旧上限 800）不再砍普通站名');
eq(V.filterLabels(bigLabels, 11).filter((l) => !l.group).length, 900, 'z11 普通站标签全在');
eq(V.filterLabels(bigLabels, 11).filter((l) => l.group).length, 100, 'z11 换乘组标签全在');
eq(V.filterLabels(bigLabels, 13).length, 1000, 'z13 全部显示');
eq(V.filterLabels([], 15).length, 0, '空标签不崩');
eq(V.filterLabels(null, 15).length, 0, 'null 不崩');
// 真数据规模回归（2026-11-22 用户抓包「单线站名不见了」：58 线 1095 站＝1040 标签单元，
// 超旧上限后普通站名在一切 zoom 全灭）：走完整链路 stopList → buildStopView → visibleLabels
const scaleFeats = [];
for (let ln = 0; ln < 60; ln++) {
  for (let k = 0; k < 18; k++) scaleFeats.push(stopFeat(`l${ln}-s${k}`, `站${ln}之${k}`, `l${ln}`, `${ln}号线`, k / 18,
    121 + k * 0.01, 31 + ln * 0.01));
}
const scaleLabels = V.buildStopView(V.stopList(fc(...scaleFeats))).labels;
eq(scaleLabels.length, 1080, '规模样本：1080 个普通站标签单元（＞旧上限 800）');
eq(V.visibleLabels(scaleLabels, 10.99, {}).length, 0, '规模样本 z10.99：门槛下无标签（组站统一 11）');
eq(V.visibleLabels(scaleLabels, 11, {}).length, 1080, '规模样本 z11：1080 个普通站名全部显示（旧 LABEL_CAP 下为 0）');
eq(V.visibleLabels(scaleLabels, 11, { dimmedSet: new Set(['l3']) }).length, 1062, '规模样本 z11 调光一条线：仅该线 18 站隐去');
const statusStops = V.stopList(fc(
  { type: 'Feature', geometry: { type: 'Point', coordinates: [121, 31] }, properties: { sid: 'sf', name: '龙居路', lineId: 'l14', lineName: '14号线', t: 0.2, stopStatus: 'future' } },
  { type: 'Feature', geometry: { type: 'Point', coordinates: [121.1, 31.1] }, properties: { sid: 'sn', name: '普通站', lineId: 'lOther', lineName: '其他线', t: 0.4 } },
));
eq(statusStops[0].stopStatus, 'future', 'stopStatus 合法值从 stops.geojson 读入');
ok(!Object.prototype.hasOwnProperty.call(statusStops[1], 'stopStatus'), '无 stopStatus 时不添加键以兼容旧结构');
const statusLabels = V.buildStopView(statusStops).labels;
eq(V.visibleLabels(statusLabels, 11, { phase: 'existing' }).map((l) => l.key), ['sn'], '站点分期覆盖：future 站名在既有档隐藏，未标注站名沿用线路期次行为');
eq(V.visibleLabels(statusLabels, 11, { phase: 'future', dimmedSet: new Set(['lOther']) }).map((l) => l.key), ['sf'], '站点分期覆盖：future 站名在远期档显示，非匹配线路按旧行为隐藏');
eq(V.visibleLabels(statusLabels, 11, { phase: 'existing', focus: 'l14' }).map((l) => l.key), ['sf'], '聚焦站名常显优先于站点分期覆盖');
eq(V.visibleLabels(statusLabels, 11, { phase: 'existing', hiddenLineIds: ['l14', 'lOther'] }).length, 0, 'hiddenLineIds 纯逻辑能力位保留（旧四档 API；2026-11-25 后分期态他省站名不走此隐藏，见 displayOnlyIds 用例）');
eq(V.stopUnitMatchesPhase([{ lineId: 'lA', status: 'future' }, { lineId: 'lB' }], 'future', new Set(['lB'])), true, '混合覆盖组：任一覆盖匹配成员即可正常显示');
eq(V.stopUnitMatchesPhase([{ lineId: 'lA' }, { lineId: 'lB' }], 'future', new Set(['lA'])), true, '未覆盖组成员按 lineId 回退 dimSet，任一未调光则正常');
eq(V.stopUnitMatchesPhase([{ lineId: 'lA' }, { lineId: 'lB' }], 'future', new Set(['lA', 'lB'])), false, '未覆盖组成员全部调光则整组调光');
ok(!Object.prototype.hasOwnProperty.call(V.buildStopView(statusStops.slice(1)).labels[0] || {}, 'stopPhaseMembers'), '无覆盖的普通组/站标签不写 stopPhaseMembers');


// ---------- 调光纯逻辑：linePhaseOf / lineLayerRank / computeDimmedSet / nextPhase ----------
console.log('dim / phase:');
ok(V.DIM_OPACITY === 0.5, '调光系数 DIM_OPACITY＝0.5（旧「突出既有」approved 档数值演化，占位待目验）');
ok(V.HIDDEN_LIST_LAYERS.join(',') === '联络线', '左栏隐藏类别常量＝[联络线]（2026-11-22 用户裁定）');
ok(V.DISPLAY_ONLY_LAYERS.join(',') === '他省', '「仅显示」级类别常量＝[他省]');
// 线路期次归类：全线最先进段（推定待用户确认——既有线的远期延伸整线归「既有」）
eq(V.linePhaseOf(lm.get('la')), 'existing', 'la（existing＋future）→ existing（最先进段）');
eq(V.linePhaseOf(lm.get('lb')), 'approved', 'lb（两段 approved）→ approved');
eq(V.linePhaseOf(lm.get('lc')), 'future', 'lc（未知状态归 future）→ future');
eq(V.linePhaseOf({ segments: [] }), null, '无段线 → null（防御）');
eq(V.linePhaseOf(null), null, 'null 线不崩');
eq(V.linePhaseOf({ segments: [{ segStatus: 'existing' }, { segStatus: 'approved' }] }), 'existing', 'existing＞approved');
eq(V.linePhaseOf({ segments: [{ segStatus: 'future' }, { segStatus: 'approved' }] }), 'approved', 'approved＞future');
// 多选分期按段状态；全选总览、部分/空集进入分期态，不存在整线期次归类。
eq([...V.normalizePhaseSelection(['existing', 'future', 'bogus'])], ['existing', 'future'], '选择集合过滤非法值');
eq(V.phaseSelectionActive(['existing', 'future']), true, '多选子集启用分期');
eq(V.phaseSelectionActive([]), true, '空集启用分期');
eq(V.phaseSelectionActive(['existing', 'approved', 'future']), false, '全选为总览');
eq(V.phaseStatusSelected('approved', ['existing', 'approved']), true, '选中段 status 高亮');
eq(V.phaseStatusSelected('future', ['existing', 'approved']), false, '未选段按逐段状态处理');
const mercatorRanges = V.segmentProgressRanges([
  { segIndex: 0, coords: [[0, 0], [1, 0]] },
  { segIndex: 1, coords: [[1, 0], [2, 0]] },
]);
eq(mercatorRanges[0].start, 0, 'WebMercator 首段从 0 开始');
eq(mercatorRanges[0].end, 0.5, '等长 WebMercator 分段边界连续');
eq(mercatorRanges[1].start, mercatorRanges[0].end, '后段起点等于前段终点');
const oneDegreeMercatorLat = (2 * Math.atan(Math.exp(Math.PI / 180)) - Math.PI / 2) * 180 / Math.PI;
const equalAxisRanges = V.segmentProgressRanges([
  { segIndex: 0, coords: [[0, 0], [1, 0]] },
  { segIndex: 1, coords: [[1, 0], [1, oneDegreeMercatorLat]] },
]);
ok(Math.abs(equalAxisRanges[0].end - 0.5) < 1e-12 && Math.abs(equalAxisRanges[1].start - 0.5) < 1e-12,
  '相同 WebMercator 横纵长度的分段各占 0.5');
const displacedRanges = V.segmentProgressRanges([
  { segIndex: 0, coords: [[0, 0], [1, 0]] },
  { segIndex: 1, coords: [[1, 0], [2, 0]] },
], [[[0, 0], [3, 0]], [[3, 0], [4, 0]]]);
eq(displacedRanges[0].end, 0.75, '进度范围采用传入的已变换坐标');
const phaseLine = { loop: false, segments: [{ segIndex: 0, segStatus: 'existing' }, { segIndex: 1, segStatus: 'future' }] };
const phaseStops = [{ sid: 'a', lineId: 'l', t: 0 }, { sid: 'b', lineId: 'l', t: 0.5 }, { sid: 'c', lineId: 'l', t: 1 }];
eq(V.stopPhaseOf(phaseLine, phaseStops[1], phaseStops), 'existing', '中间站取入站与出站段中较早期次');
eq(V.stopPhaseOf(phaseLine, Object.assign({}, phaseStops[1], { stopIndex: 0 }), phaseStops), 'existing', '显式 stopIndex 优先于站序回退推导');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'future' }, { segIndex: 1, segStatus: 'existing' }] }, Object.assign({}, phaseStops[1], { stopIndex: 1 }), phaseStops), 'existing', '相反站序仍取较早期次');
eq(V.stopPhaseOf(phaseLine, phaseStops[0], phaseStops), 'existing', '首站取唯一出站段');
eq(V.stopPhaseOf(phaseLine, phaseStops[2], phaseStops), 'future', '末站取唯一入站段');
const loopPhaseLine = { loop: true, segments: [{ segIndex: 0, segStatus: 'future' }, { segIndex: 1, segStatus: 'approved' }, { segIndex: 2, segStatus: 'existing' }] };
eq(V.stopPhaseOf(loopPhaseLine, { sid: 'loop-first', lineId: 'l', stopIndex: 0 }, phaseStops), 'existing', '环线首站比较首段与末段');
eq(V.stopPhaseOf({ loop: true, segments: [{ segIndex: 0, segStatus: 'future' }, { segIndex: 1, segStatus: 'approved' }, { segIndex: 2, segStatus: 'future' }] }, { sid: 'loop-last', lineId: 'l', stopIndex: 2 }, phaseStops), 'approved', '环线末站比较入站与绕回段');
eq(V.stopPhaseOf(phaseLine, Object.assign({}, phaseStops[1], { stopIndex: 1, stopStatus: 'future' }), phaseStops), 'future', '显式 future 覆盖较早既有段');
const blockGapLine = { loop: false, segments: [{ segIndex: 1, segStatus: 'approved' }, { segIndex: 2, segStatus: 'future' }] };
eq(V.stopPhaseOf(blockGapLine, { sid: 'after-block', lineId: 'l', stopIndex: 2 }, phaseStops), 'approved', 'block 索引空位不压缩原始区段索引');
eq(V.stopPhaseOf({ loop: false, segments: phaseLine.segments }, { sid: 'missing-status', lineId: 'l', stopIndex: 1 }, phaseStops), 'existing', '无 stopStatus 时仍按有效相邻段兼容推导');
eq(V.stopPhaseOf(phaseLine, { sid: 'hidden-block-gap', lineId: 'l' }, [{ sid: 'a', lineId: 'l', t: 0 }, { sid: 'c', lineId: 'l', t: 1 }]), null, '旧 net 缺 stopIndex 且段数不符时防止错误映射');
eq(V.stopPhaseOf(phaseLine, { sid: 'explicit', lineId: 'l', stopStatus: 'approved' }, []), 'approved', '合法显式状态不依赖区段数据');
eq(V.stopPhaseOf(phaseLine, { sid: 'invalid', lineId: 'l', stopStatus: 'invalid', stopIndex: 99 }, phaseStops), null, '越界站序且无相邻段返回 null');
// 真实回归形状：5号线奉贤新城、29号线国家会展中心的入站期次早于出站期次。
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 13, segStatus: 'existing' }, { segIndex: 14, segStatus: 'future' }] }, { sid: 'fengxian', lineId: 'l0019', stopIndex: 14 }, []), 'existing', '5号线奉贤新城：入站既有、出站远期');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 10, segStatus: 'approved' }, { segIndex: 11, segStatus: 'future' }] }, { sid: 'national-exhibition', lineId: 'l0044', stopIndex: 11 }, []), 'approved', '29号线国家会展中心：入站近期、出站远期');
eq(V.stopPhaseOf(Object.assign({}, phaseLine, { segments: [] }), { sid: 'empty', lineId: 'l', stopIndex: 0 }, []), null, '缺少区段时防御性返回 null');
eq(V.stopPhaseOf(null, { sid: 'no-line', lineId: 'l', stopIndex: 0 }, []), null, '缺少线路时防御性返回 null');
eq(V.stopPhaseOf(phaseLine, null, phaseStops), null, '缺少站点时防御性返回 null');
eq(V.stopPhaseOf(phaseLine, { sid: 'b', lineId: 'l', t: 0.5 }, phaseStops), 'existing', '旧 net 缺 stopIndex 仍按站序兼容');
eq(V.stopPhaseOf(phaseLine, Object.assign({}, phaseStops[1], { stopIndex: 1, stopStatus: 'future' }), phaseStops), 'future', '站 stopStatus 合法枚举优先');
eq(V.stopPhaseOf(phaseLine, Object.assign({}, phaseStops[1], { stopIndex: 1, stopStatus: 'unknown' }), phaseStops), 'existing', '非法显式状态回退相邻区段');
eq(V.stopPhaseOf(phaseLine, { sid: 'non-integer', lineId: 'l', stopIndex: 1.5 }, phaseStops), null, '非整数 stopIndex 走旧兼容且无法定位时防御返回 null');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'future' }] }, { sid: 'last', lineId: 'l', stopIndex: 1 }, phaseStops), 'future', '单相邻末站保留唯一入站段');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'existing' }, { segIndex: 1, segStatus: 'approved' }] }, { sid: 'middle', lineId: 'l', stopIndex: 1 }, phaseStops), 'existing', 'existing 优先于 approved');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'approved' }, { segIndex: 1, segStatus: 'future' }] }, { sid: 'middle', lineId: 'l', stopIndex: 1 }, phaseStops), 'approved', 'approved 优先于 future');
eq(V.stopPhaseOf({ loop: true, segments: [{ segIndex: 0, segStatus: 'existing' }] }, { sid: 'loop-single', lineId: 'l', stopIndex: 0 }, phaseStops), 'existing', '单段环线的首末相邻均有防御处理');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 4, segStatus: 'future' }] }, { sid: 'gap', lineId: 'l', stopIndex: 0 }, phaseStops), null, '缺失相邻 segIndex 不推断为其它区段');
eq(V.stopPhaseOf(phaseLine, { sid: 'duplicate-id', lineId: 'other', stopIndex: 1 }, phaseStops), 'existing', '带原始 stopIndex 的站不依赖当前 stop 列表');
eq(V.stopPhaseOf(phaseLine, { sid: 'legacy-missing-line', t: 0 }, []), null, '旧 net 缺 lineId 时安全返回 null');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'unexpected' }] }, { sid: 'bad-status', lineId: 'l', stopIndex: 0 }, phaseStops), 'unexpected', '异常段状态保留防御兼容而不引发异常');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'future' }, { segIndex: 1, segStatus: 'existing' }] }, { sid: 'non-array-stops', lineId: 'l', t: 0.5 }, null), null, '旧 net 无可用站序表时返回 null');
eq(V.stopPhaseOf(phaseLine, { sid: 'b', lineId: 'l', t: 0.5 }, phaseStops), 'existing', '旧 net 按原始站序取相邻较早期次');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'existing' }, { segIndex: 1, segStatus: 'future' }] }, { sid: 'bad-id', lineId: 'l', t: 0.5 }, [{ sid: 'different', lineId: 'l', t: 0.5 }]), null, '旧 net 找不到站点时返回 null');
eq(V.stopPhaseOf(phaseLine, { sid: 'b', lineId: 'l', stopIndex: -1, t: 0.5 }, phaseStops), 'existing', '负 stopIndex 依旧回退旧站序兼容');
eq(V.stopPhaseOf(phaseLine, { sid: 'b', lineId: 'l', stopIndex: null, t: 0.5 }, phaseStops), 'existing', 'null stopIndex 依旧回退旧站序兼容');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'existing' }, { segIndex: 1, segStatus: 'future' }] }, { sid: 'index-zero', lineId: 'l', stopIndex: 0 }, phaseStops), 'existing', '边界首站索引正确');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'existing' }, { segIndex: 1, segStatus: 'future' }] }, { sid: 'index-one', lineId: 'l', stopIndex: 1 }, phaseStops), 'existing', '中间站索引按两侧段判定');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'existing' }, { segIndex: 1, segStatus: 'future' }] }, { sid: 'index-two', lineId: 'l', stopIndex: 2 }, phaseStops), 'future', '末站索引正确');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'approved' }, { segIndex: 1, segStatus: 'future' }] }, { sid: 'approved-future', lineId: 'l', stopIndex: 1 }, phaseStops), 'approved', '较早分期排序包含 approved');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'future' }, { segIndex: 1, segStatus: 'approved' }] }, { sid: 'future-approved', lineId: 'l', stopIndex: 1 }, phaseStops), 'approved', '站序反转也按期次而非入出方向排序');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 0, segStatus: 'approved' }] }, { sid: 'single', lineId: 'l', stopIndex: 1 }, phaseStops), 'approved', '仅有入站段时采用唯一有效相邻段');
eq(V.stopPhaseOf({ loop: false, segments: [{ segIndex: 1, segStatus: 'future' }] }, { sid: 'single-out', lineId: 'l', stopIndex: 1 }, phaseStops), 'future', '仅有出站段时采用唯一有效相邻段');
eq(V.stopPhaseOf({ loop: true, segments: [{ segIndex: 0, segStatus: 'future' }, { segIndex: 1, segStatus: 'existing' }] }, { sid: 'loop-start', lineId: 'l', stopIndex: 0 }, phaseStops), 'existing', '环线首站入站取最后环绕段');
eq(V.stopPhaseOf({ loop: true, segments: [{ segIndex: 0, segStatus: 'existing' }, { segIndex: 1, segStatus: 'future' }] }, { sid: 'loop-end', lineId: 'l', stopIndex: 1 }, phaseStops), 'existing', '环线末站出站取最后环绕段');
// 分期四档循环
eq(V.nextPhase('none'), 'existing', '循环 无→既有');
eq(V.nextPhase('existing'), 'approved', '既有→已批复');
eq(V.nextPhase('approved'), 'future', '已批复→远期');
eq(V.nextPhase('future'), 'none', '远期→无');
eq(V.nextPhase('weird'), 'existing', '非法输入回「无」再前进一步＝existing');
// 可交互层级：他省线 displayOnly，其余 normal（集中判断）
eq(V.lineLayerRank(lm.get('lc')), 'normal', '联络线是 normal（可交互，仅左栏列表隐藏）');
eq(V.lineLayerRank({ layer: '他省' }), 'displayOnly', '他省线 displayOnly（仅显示级）');
eq(V.lineLayerRank({ layer: '市区线' }), 'normal', '市区线 normal');
eq(V.lineLayerRank({}), 'normal', '类别缺失 → normal');
// 虚线位（2026-11-23 用户需求：预控通道画虚线）——集中判断，0/1 数字位供渲染特征属性
ok(V.DASHED_LAYERS.join(',') === '预控通道', '虚线类别常量＝[预控通道]（2026-11-23 用户需求）');
eq(V.lineDashed({ layer: '预控通道' }), 1, '预控通道 → dash 1（画虚线）');
eq(V.lineDashed({ layer: '市区线' }), 0, '市区线 → dash 0（实线）');
eq(V.lineDashed({ layer: '市域线' }), 0, '市域线 → dash 0（实线）');
eq(V.lineDashed({ layer: '联络线' }), 0, '联络线 → dash 0（实线）');
eq(V.lineDashed({ layer: '他省' }), 0, '他省线 → dash 0（仅显示级与虚线位互不相干）');
eq(V.lineDashed({}), 0, '类别缺失 → dash 0');
eq(V.lineDashed(null), 0, 'null 线不崩 → 0');
const lmTP = V.normalizeLines(fc(
  lineFeat('tp', 0, 'existing', [[0, 0], [1, 0]], { layer: '他省' }),
));
// 调光线集：默认态（无分期＋无聚焦）空集
eq([...V.computeDimmedSet(lm, { phase: 'none', focus: null })], [], '默认态不调光');
eq([...V.computeDimmedSet(lm, {})], [], '缺省 state 不调光');
eq([...V.computeDimmedSet(null, { phase: 'existing' })], [], 'null linesMap 不崩');
// 分期档：期次不匹配的线调光（fixture：la=existing、lb=approved、lc=future）
eq([...V.computeDimmedSet(lm, { phase: 'existing' })].sort(), ['lb', 'lc'], '分期「既有」→ lb/lc 调光');
eq([...V.computeDimmedSet(lm, { phase: 'approved' })].sort(), ['la', 'lc'], '分期「已批复」→ la/lc 调光');
eq([...V.computeDimmedSet(lm, { phase: 'future' })].sort(), ['la', 'lb'], '分期「远期」→ la/lb 调光');
// 聚焦：2026-11-22 白罩定案——聚焦不贡献 dim（高亮由渲染层白罩＋聚焦重画层呈现）
eq([...V.computeDimmedSet(lm, { phase: 'none', focus: 'la' })], [], '聚焦 la → 不调光（「全都不动」，非聚焦线照常）');
// 分期＋聚焦：唯一 dim 源是分期（focus 仅作 displayOnly 激活位，见下）
eq([...V.computeDimmedSet(lm, { phase: 'existing', focus: 'lb' })].sort(), ['lb', 'lc'],
  '分期既有＋聚焦 lb：聚焦既不豁免也不加重——并集只剩分期侧（lb 期次 approved 照旧被调）');
eq([...V.computeDimmedSet(lm, { phase: 'existing', focus: 'la' })].sort(), ['lb', 'lc'],
  '分期既有＋聚焦 la（期次恰好匹配）→ 同纯分期档');
// 「仅显示」级：任何调光场合恒半透明（即便期次恰好匹配）——focus 激活位仍触发
const mixTP = new Map([...lm, ...lmTP]);
eq([...V.computeDimmedSet(mixTP, { phase: 'existing' })].sort(), ['lb', 'lc', 'tp'],
  '他省线期次恰好匹配 existing 仍被调光（用户裁定硬规则 2）');
eq([...V.computeDimmedSet(mixTP, { phase: 'none', focus: 'la' })].sort(), ['tp'],
  '聚焦场合他省线恒在半透明侧（focus 现仅剩此一职——调光场合激活位）');
eq([...V.computeDimmedSet(mixTP, { phase: 'none', focus: null })], [],
  '默认态（无任何调光）他省线正常显示');
eq([...V.computeDimmedSet(mixTP, { focus: 'tp' })].includes('tp'), true,
  '聚焦他省线时其自身也在调光侧（setFocus 入口另有拦截，不产生此态）');

// ---------- visibleLabels（优先级：全局开关 ＞ 聚焦常显·其余隐藏 ＞ 调光隐藏 ＞ zoom 门槛） ----------
console.log('visibleLabels:');
const vlLabels = [
  { key: 's1', name: '甲1', group: false, lineIds: ['la'] },
  { key: 's2', name: '乙1', group: false, lineIds: ['lb'] },
  { key: 'g1', name: '组1', group: true, lineIds: ['la', 'lb'] },    // 任一成员未调光 → 显示
  { key: 'g2', name: '组2', group: true, lineIds: ['lb', 'lc'] },    // 全成员被调光 → 隐藏
  { key: 'x1', name: '无所属', group: false, lineIds: [] },          // 防御：不因调光隐藏
];
const dimLB = new Set(['lb', 'lc']);
eq(V.visibleLabels(vlLabels, 13, { hideAll: true }), [], '全局站名开关隐藏 → 一切站名不显示');
eq(V.visibleLabels(vlLabels, 13, { hideAll: true, focus: 'la' }), [], '全局开关优先级最高（压过聚焦常显）');
eq(V.visibleLabels(vlLabels, 13, { dimmedSet: dimLB }).map((l) => l.key), ['s1', 'g1', 'x1'],
  '调光线站名隐藏：乙1 隐藏、组2（全成员调光）隐藏、组1（la 未调光）保留');
eq(V.visibleLabels(vlLabels, 13, {}).map((l) => l.key), ['s1', 's2', 'g1', 'g2', 'x1'],
  '无调光无聚焦 → zoom 门槛层原样（z13 全显）');
eq(V.visibleLabels(vlLabels, 9, {}).map((l) => l.key), [], 'z9 门槛层全隐');
eq(V.visibleLabels(vlLabels, 9, { focus: 'la' }).map((l) => l.key).sort(), ['g1', 's1'],
  '聚焦线站名无视 zoom 门槛常显（组1 含 la 也常显）');
eq(V.visibleLabels(vlLabels, 9, { focus: 'la', dimmedSet: dimLB }).map((l) => l.key).sort(), ['g1', 's1'],
  '聚焦常显优先于分期调光（聚焦优先级下 dim 维度让位——成员照显）');
eq(V.visibleLabels(vlLabels, 13, { focus: 'la' }).map((l) => l.key).sort(), ['g1', 's1'],
  '聚焦时非聚焦线站名隐藏：z13 拉近也不显示（2026-11-22 真机反馈「站名也没有隐去」）');
eq(V.visibleLabels(vlLabels, 13, { focus: 'la', dimmedSet: dimLB }).map((l) => l.key).sort(), ['g1', 's1'],
  '聚焦＋分期叠加：聚焦成员照显、其余隐藏（分期隐藏维度在聚焦时整体让位）；x1 无所属线跟随隐藏');
eq(V.visibleLabels(vlLabels, 9, { focus: 'lb', dimmedSet: dimLB }).map((l) => l.key).sort(), ['g1', 'g2', 's2'],
  '聚焦被调光线（lb）站名仍常显：s2/g2/g1（均含 lb）无视调光与 zoom，s1/x1 隐藏');
eq(V.visibleLabels(vlLabels, 13, { dimmedSet: ['lb', 'lc'] }).map((l) => l.key), ['s1', 'g1', 'x1'],
  'dimmedSet 传数组（非 Set）也能容错');
eq(V.visibleLabels(null, 13, { focus: 'la' }), [], 'null 标签不崩');
eq(V.visibleLabels(vlLabels, 13), V.visibleLabels(vlLabels, 13, {}), '缺省 state＝无约束');
// focusMembers（2026-11-22 真机反馈轮·主支线合并）：聚焦判定＝标签 lineIds 与聚焦组
// 成员集有交集——支线站的站名也是聚焦线站名，须常显
const vlLabelsG = [
  { key: 's1', name: '主线站', group: false, lineIds: ['m1'] },
  { key: 'b1', name: '支线站', group: false, lineIds: ['b1'] },
  { key: 'o1', name: '他线站', group: false, lineIds: ['o1'] },
  { key: 'gm', name: '主支换乘', group: true, lineIds: ['m1', 'b1', 'o1'] },
];
eq(V.visibleLabels(vlLabelsG, 9, { focus: 'm1', focusMembers: ['m1', 'b1'] }).map((l) => l.key).sort(),
  ['b1', 'gm', 's1'],
  'focusMembers：支线站 b1 常显（主支线合并——支线也是聚焦线）、他线站隐藏、组标签任一成员命中常显');
eq(V.visibleLabels(vlLabelsG, 9, { focus: 'm1' }).map((l) => l.key).sort(), ['gm', 's1'],
  'focusMembers 缺省退 [focus]：仅含主线的标签常显（向后兼容）');
eq(V.visibleLabels(vlLabelsG, 9, { focus: 'm1', focusMembers: [] }).map((l) => l.key).sort(), ['gm', 's1'],
  'focusMembers 空数组退 [focus]（脏输入防御）');
eq(V.visibleLabels(vlLabelsG, 9, { focus: 'm1', focusMembers: [null, ''] }).map((l) => l.key).sort(), ['gm', 's1'],
  'focusMembers 全脏项过滤后空 → 退 [focus]');
// stationKey（2026-11-27 用户裁定：点击车站高亮＝只有该站标签显示且常显）：无视 zoom 门槛
// 与调光；与聚焦互斥（并传时聚焦优先——胶水层不并传，防御序）；hideAll 仍压过
eq(V.visibleLabels(vlLabelsG, 8, { stationKey: 'gm' }).map((l) => l.key), ['gm'],
  'stationKey：z8 远低于组门槛 z10 仍常显、其余一切站名（含同组成员线的单站 b1/s1）全隐藏');
eq(V.visibleLabels(vlLabelsG, 13, { stationKey: 'b1', dimmedSet: new Set(['b1']) }).map((l) => l.key), ['b1'],
  'stationKey：被点站自身被调光也照显（调光维度让位）、他站不因调光口径混入');
eq(V.visibleLabels(vlLabelsG, 13, { hideAll: true, stationKey: 'gm' }), [],
  'stationKey 让位于全局站名开关（hideAll 优先级最高，与聚焦常显同待遇）');
eq(V.visibleLabels(vlLabelsG, 13, { stationKey: 'zzz' }).map((l) => l.key), [],
  'stationKey 无匹配标签（脏 key）→ 全隐（防御）');
eq(V.visibleLabels(vlLabelsG, 9, { focus: 'm1', stationKey: 'o1' }).map((l) => l.key).sort(), ['gm', 's1'],
  'stationKey 与 focus 并传时聚焦优先（胶水层互斥不并传——防御位，对齐优先级注释序）');
// displayOnlyIds（2026-11-25 用户纠正裁定：分期态他省线照常显示——站名只按 zoom 门槛，
// 不受「被调光线隐藏」约束；他省线分期态恒入 dimmed 但那是线身恒调光口径，不再连坐站名）
const vlLabelsTP = [
  { key: 'p1', name: '他省站', group: false, lineIds: ['tp'] },
  { key: 'p2', name: '他省组', group: true, lineIds: ['tp', 'tq'] },
  { key: 'mix', name: '跨省换乘', group: true, lineIds: ['la', 'tp'] },   // 混合单元：本地成员按旧规则
  { key: 's1', name: '本地站', group: false, lineIds: ['lb'] },
];
const dimTP = new Set(['tp', 'tq', 'lb']);   // 分期态：他省线恒调光 ＋ 本地未选段线
eq(V.visibleLabels(vlLabelsTP, 13, { dimmedSet: dimTP, displayOnlyIds: ['tp', 'tq'] }).map((l) => l.key),
  ['p1', 'p2', 'mix'],
  'displayOnlyIds：他省纯单元（站/组）不受调光隐藏照常显示；混合单元任一本地成员未调光则显示；本地被调光线站名照旧隐藏');
eq(V.visibleLabels(vlLabelsTP, 13, { dimmedSet: dimTP }).map((l) => l.key),
  ['mix'],
  '对照：不传 displayOnlyIds 时他省纯单元标签随全成员调光隐藏（旧行为）——新参数是唯一放行口');
eq(V.visibleLabels(vlLabelsTP, 10, { dimmedSet: dimTP, displayOnlyIds: ['tp', 'tq'] }).map((l) => l.key),
  ['p2', 'mix'],
  'displayOnlyIds 放行不越 zoom 门槛：z10 普通站（含他省单站）仍隐藏、组标签（他省组/混合组）照门槛规则显示');
eq(V.visibleLabels(vlLabelsTP, 13, { dimmedSet: dimTP, displayOnlyIds: [] }).map((l) => l.key),
  ['mix'],
  'displayOnlyIds 空集＝不放行（防御：非分期态胶水层传空数组）');
eq(V.visibleLabels(vlLabels, 13, { dimmedSet: dimLB, displayOnlyIds: ['lb', 'lc'] }).map((l) => l.key),
  ['s1', 's2', 'g1', 'g2', 'x1'],
  'displayOnlyIds 恰为全成员调光线集：s2/g2 放行（全成员皆他省口径）、x1 无所属线信息不受影响');

// ---------- connectorFadePlan（联络线渐变接入端判定，2026-11-22 用户需求 3） ----------
console.log('connectorFadePlan:');
const fadeFC = fc(
  lineFeat('fa', 0, 'existing', [[0, 0], [0, 3]], { name: 'A线', color: '#ff0000' }),            // 左侧竖线
  lineFeat('fb', 0, 'existing', [[10, 0], [10, 3]], { name: 'B线', color: '#0000ff' }),          // 右侧竖线
  lineFeat('fc', 0, 'existing', [[0, 1.5], [5, 1.5], [10, 1.5]],                                 // 横向联络线：首端近 A、末端近 B
    { name: 'C联络线', role: 'connector', connects: ['fa', 'fb'] }),
);
const lmF = V.normalizeLines(fadeFC);
eq(lmF.get('fc').connects, ['fa', 'fb'], 'normalizeLines 保留 connects');
eq(lmF.get('fa').connects, [], '非联络线 connects 空数组（flatten 无该字段缺省）');
eq(V.connectorFadePlan(lmF, 'fa'), [{ lineId: 'fc', attachEnd: 0 }], '聚焦 fa：C 首端近 fa → attachEnd 0');
eq(V.connectorFadePlan(lmF, 'fb'), [{ lineId: 'fc', attachEnd: 1 }], '聚焦 fb：C 末端近 fb → attachEnd 1');
eq(V.connectorFadePlan(lmF, 'zz'), [], 'connects 不含聚焦线（zz 无绑定联络线）→ []');
eq(V.connectorFadePlan(lmF, null), [], 'focus null → []');
eq(V.connectorFadePlan(lmF, ''), [], 'focus 空串 → []');
eq(V.connectorFadePlan(null, 'fa'), [], 'linesMap 非 Map → []');
// 聚焦线无有效坐标（NaN 点）→ []
const lmF2 = V.normalizeLines(fc(
  lineFeat('fz', 0, 'existing', [[0, 0], [1, 1]], { connects: ['fempty'] }),
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[NaN, NaN], [NaN, NaN]] },
    properties: { lineId: 'fempty', segIndex: 0, segStatus: 'existing' } },
));
eq(V.connectorFadePlan(lmF2, 'fz'), [], '聚焦线无有效坐标 → []');
// 联络线自身无有效坐标 → 兜底 attachEnd 0（防御）
const lmF3 = V.normalizeLines(fc(
  lineFeat('fm', 0, 'existing', [[4, 0], [5, 0], [6, 0]], {}),
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[NaN, NaN], [NaN, NaN]] },
    properties: { lineId: 'fbad', segIndex: 0, segStatus: 'existing', connects: ['fm'] } },
));
eq(V.connectorFadePlan(lmF3, 'fm'), [{ lineId: 'fbad', attachEnd: 0 }], '联络线无有效坐标 → 兜底 0');
// 两端到聚焦线等距（平手）→ 兜底 0
const lmF4 = V.normalizeLines(fc(
  lineFeat('fq', 0, 'existing', [[4, 0], [5, 0], [6, 0]], {}),
  lineFeat('fe', 0, 'existing', [[5, -2], [5, 2]], { connects: ['fq'] }),   // 首(5,-2)/末(5,2) 距 fq 各 2
));
eq(V.connectorFadePlan(lmF4, 'fq'), [{ lineId: 'fe', attachEnd: 0 }], '两端等距平手 → 兜底 0');
// 多条联络线绑定同一聚焦线：全部列出，各自判定
const lmF5 = V.normalizeLines(fc(
  lineFeat('fp', 0, 'existing', [[0, 0], [0, 5]], {}),
  lineFeat('fc1', 0, 'existing', [[0, 0.5], [3, 0.5]], { connects: ['fp', 'fx1'] }),
  lineFeat('fc2', 0, 'existing', [[3, 4.5], [0, 4.5]], { connects: ['fx2', 'fp'] }),   // 画反序：末端近 fp
));
eq(V.connectorFadePlan(lmF5, 'fp'), [{ lineId: 'fc1', attachEnd: 0 }, { lineId: 'fc2', attachEnd: 1 }],
  '两条绑定联络线各判其端（fc2 反向画→末端近 fp）');
// connects 脏数据（非字符串项过滤）
const lmF6 = V.normalizeLines(fc(
  lineFeat('fn', 0, 'existing', [[0, 0], [1, 1]], {}),
  lineFeat('fd', 0, 'existing', [[9, 9], [9, 8]], { connects: ['fn', 42, null, ''] }),
));
eq(lmF6.get('fd').connects, ['fn'], 'connects 非字符串项被过滤');
eq(V.connectorFadePlan(lmF6, 'fn'), [{ lineId: 'fd', attachEnd: 1 }], '脏 connects 过滤后仍命中（fd 末端(9,8)近 fn 末端(1,1)）');

// ---------- connectorBlendPlan（联络线双端渐变取色，2026-11-22 用户需求 2） ----------
// ⚝ 联络线中途设站不影响 blend/fade plan：normalizeLines 无站概念、plan 只看
// segments 拼接折线的首末点——设站（stops）在数据链上只影响 flatten 分段切分与站表，
// 从不进入本函数输入（中途设站的端到端抽查在 flatten 侧验证，见 源资产/测试数据 l0008/l0010）。
console.log('connectorBlendPlan:');
eq(V.connectorBlendPlan(lmF), [{ lineId: 'fc', headColor: '#ff0000', tailColor: '#0000ff' }],
  '2 线正常方向判定：fc 首端近 fa（红）、末端近 fb（蓝）');
eq(V.connectorBlendPlan(null), [], 'linesMap 非 Map → []');
// connects<2 → 无效（不出条目）
const lmB1 = V.normalizeLines(fc(
  lineFeat('fa', 0, 'existing', [[0, 0], [0, 3]], { color: '#ff0000' }),
  lineFeat('fb', 0, 'existing', [[10, 0], [10, 3]], { color: '#0000ff' }),
  lineFeat('fc', 0, 'existing', [[0, 1.5], [10, 1.5]], { connects: ['fa'] }),
));
eq(V.connectorBlendPlan(lmB1), [], 'connects<2 → 无效');
// connects 2 条但 1 条不存在于 linesMap → 有效目标仅 1 → 无效
const lmB2 = V.normalizeLines(fc(
  lineFeat('fa', 0, 'existing', [[0, 0], [0, 3]], { color: '#ff0000' }),
  lineFeat('fc', 0, 'existing', [[0, 1.5], [10, 1.5]], { connects: ['fa', 'zz'] }),
));
eq(V.connectorBlendPlan(lmB2), [], 'connects 2 条但 1 条不存在 → 无效（信息不全深灰兜底由渲染层处理）');
// connects≥3：每端各自取最近一条（其余忽略——授权裁定注释见函数头）
const lmB3 = V.normalizeLines(fc(
  lineFeat('fa', 0, 'existing', [[0, 0], [0, 3]], { color: '#ff0000' }),
  lineFeat('fb', 0, 'existing', [[10, 0], [10, 3]], { color: '#0000ff' }),
  lineFeat('fg', 0, 'existing', [[20, 0], [20, 3]], { color: '#00ff00' }),
  lineFeat('fc', 0, 'existing', [[0, 1.5], [20, 1.5]], { connects: ['fa', 'fb', 'fg'] }),
));
eq(V.connectorBlendPlan(lmB3), [{ lineId: 'fc', headColor: '#ff0000', tailColor: '#00ff00' }],
  'connects≥3 每端各取最近（中间的 fb 两端都不取）');
// 两端同线 → 双色相等（自然退化为单色）
const lmB4 = V.normalizeLines(fc(
  lineFeat('fa', 0, 'existing', [[0, 0], [0, 3]], { color: '#ff0000' }),
  lineFeat('fb', 0, 'existing', [[100, 0], [100, 3]], { color: '#0000ff' }),
  lineFeat('fc', 0, 'existing', [[0, 1.5], [5, 1.5], [0, 2.5]], { connects: ['fa', 'fb'] }),
));
eq(V.connectorBlendPlan(lmB4), [{ lineId: 'fc', headColor: '#ff0000', tailColor: '#ff0000' }],
  '两端同线（fa）→ 双色相等');
// 目标线无坐标防御：全部无效 → 不出；一有效一无坐标 → 有效 1 → 不出
const noCoordFeat = (lid, connects) => ({
  type: 'Feature', geometry: { type: 'LineString', coordinates: [[NaN, NaN], [NaN, NaN]] },
  properties: { lineId: lid, segIndex: 0, segStatus: 'existing', connects },
});
const lmB5 = V.normalizeLines(fc(
  lineFeat('fa', 0, 'existing', [[0, 0], [0, 3]], { color: '#ff0000' }),
  noCoordFeat('fb', null),
  lineFeat('fc', 0, 'existing', [[0, 1.5], [10, 1.5]], { connects: ['fa', 'fb'] }),
));
eq(V.connectorBlendPlan(lmB5), [], '目标线 fb 无有效坐标 → 有效目标 1 → 不出');
const lmB6 = V.normalizeLines(fc(
  noCoordFeat('fa', null), noCoordFeat('fb', null),
  lineFeat('fc', 0, 'existing', [[0, 1.5], [10, 1.5]], { connects: ['fa', 'fb'] }),
));
eq(V.connectorBlendPlan(lmB6), [], '目标线全部无坐标 → 不出');
// 线自身无坐标防御 → 不出（与 fadePlan 兜底 0 不同：head/tail 色无从挂）
const lmB7 = V.normalizeLines(fc(
  lineFeat('fa', 0, 'existing', [[0, 0], [0, 3]], { color: '#ff0000' }),
  lineFeat('fb', 0, 'existing', [[10, 0], [10, 3]], { color: '#0000ff' }),
  noCoordFeat('fc', ['fa', 'fb']),
));
eq(V.connectorBlendPlan(lmB7), [], '联络线自身无坐标 → 不出');
// 多段拼接：乱序 segIndex 输入按升序拼接后取首末（首端 fa 侧、末端 fb 侧）
const lmB8 = V.normalizeLines(fc(
  lineFeat('fa', 0, 'existing', [[0, 0], [0, 3]], { color: '#ff0000' }),
  lineFeat('fb', 0, 'existing', [[10, 0], [10, 3]], { color: '#0000ff' }),
  lineFeat('fc', 1, 'existing', [[5, 1.5], [10, 1.5]], { connects: ['fa', 'fb'] }),
  lineFeat('fc', 0, 'existing', [[0, 1.5], [5, 1.5]], { connects: ['fa', 'fb'] }),
));
eq(V.connectorBlendPlan(lmB8), [{ lineId: 'fc', headColor: '#ff0000', tailColor: '#0000ff' }],
  '多段乱序 segIndex 拼接后取首末（不因段序错乱翻色）');
// 非联络线（connects 空）不出条目；connects 脏数据过滤同 normalizeLines 口径
eq(V.connectorBlendPlan(lm).filter((it) => it.lineId !== 'lc'), [],
  '无 connects 的线一律不出条目（lm 仅 lc 为 connector 且 connects<2 → 全空）');
eq(V.connectorBlendPlan(lm), [], 'lm 的 lc（connects 缺失）→ 空（旧快照容错）');

// ---------- computeDimmedSet 白罩定案恒定语义（2026-11-22 用户确认遮罩 70%，删对比开关） ----------
console.log('computeDimmedSet focus (veil final):');
eq([...V.computeDimmedSet(mixTP, { focus: 'la' })], ['tp'],
  '聚焦：非聚焦线（lb/lc）不进 dimmed（「全都不动」），他省线照旧（既有独立裁定）');
eq([...V.computeDimmedSet(mixTP, { phase: 'none', focus: 'la' })], ['tp'],
  '聚焦（显式 phase none）：同上（无 hlMode——对比开关已删，旧 dim 语义不复存在）');
eq([...V.computeDimmedSet(mixTP, { phase: 'existing' })].sort(), ['lb', 'lc', 'tp'],
  '分期未选中照旧调光（分期是既有独立裁定，与聚焦高亮方式无关）');
eq([...V.computeDimmedSet(mixTP, { phase: 'existing', focus: 'la' })].sort(), ['lb', 'lc', 'tp'],
  '分期＋聚焦：并集只剩分期侧贡献');
eq([...V.computeDimmedSet(mixTP, {})], [], '默认态不调光');
// 下游兼容：聚焦线标签常显逻辑不变（2026-11-22 真机反馈轮后非聚焦线标签聚焦时一律隐藏
//——站名维度由 visibleLabels 承接白罩的「罩住」语义，非聚焦线不再随 dimmedSet 收窄而显示）
const veilDim = V.computeDimmedSet(mixTP, { focus: 'la' });
eq(V.visibleLabels(vlLabels, 9, { focus: 'la', dimmedSet: veilDim }).map((l) => l.key).sort(),
  ['g1', 's1'],
  '聚焦下 z9 标签＝聚焦成员常显照旧＋其余隐藏');
eq(V.visibleLabels(vlLabels, 11, { focus: 'la', dimmedSet: veilDim }).map((l) => l.key).sort(),
  ['g1', 's1'],
  '聚焦下 z11 其余标签隐藏（2026-11-22 真机反馈轮改写——原「全都不动全显」的站名侧语义收回）');

// ---------- stopList/pinOfStop 的 stroke 透传（联络线站圈描边，2026-11-22 用户需求 2） ----------
console.log('stop stroke passthrough:');
const stStroke = V.stopList(fc(
  stopFeat('c1', '联络甲', 'lc', '丙线', 0.5, 1, 1),
  { type: 'Feature', geometry: { type: 'Point', coordinates: [2, 2] },
    properties: { sid: 'c2', name: '联络乙', lineId: 'lc', lineName: '丙线', t: 0.8, groupId: null, groupType: null, stroke: '#e4002b' } },
));
eq(stStroke.find((s) => s.sid === 'c1').stroke, null, '普通站无 stroke 键 → null');
eq(stStroke.find((s) => s.sid === 'c2').stroke, '#e4002b', '联络线站 stroke 保留（flatten 产出＝最近端目标线色）');
const svStroke = V.buildStopView(stStroke);
eq((svStroke.pins.find((p) => p.key === 'c2') || {}).stroke, '#e4002b', 'pinOfStop 透传 stroke（渲染层据此取站圈描边色）');
eq((svStroke.pins.find((p) => p.key === 'c1') || {}).stroke, null, '普通站 pin stroke null（渲染层退线色）');

// ---------- visibleListGroups（左栏类别过滤；地图照画、搜索照收） ----------
console.log('visibleListGroups:');
const lgrVis = V.visibleListGroups(lm, ['联络线']);
eq(lgrVis.map((g) => g.layer), ['市区线', null], '隐藏「联络线」后仅剩市区线＋未分类');
ok(!lgrVis.some((g) => g.layer === '联络线'), '联络线不出现在左栏列表');
eq(V.visibleListGroups(lm, []).map((g) => g.layer), V.layerGroups(lm).map((g) => g.layer), '空隐藏集＝原样');
eq(V.visibleListGroups(lm, V.HIDDEN_LIST_LAYERS).length, 2, '默认常量（联络线）过滤后两组');
eq(V.visibleListGroups(new Map(), ['联络线']), [], '空 Map 不崩');
eq(V.visibleListGroups(lm, null).length, 3, 'null 隐藏集不崩（不过滤）');

// ---------- layerGroups 自定义显示序（manifest.lineOrder → net/index.json 链路终端） ----------
console.log('layerGroups lineOrder:');
eq(V.layerGroups(lm).map((g) => g.layer), ['联络线', '市区线', null], '无序＝旧惯例：组中文拼音序（联 lián＜市 shì）、未分类最后');
eq(V.layerGroups(lm, ['lc', 'lb', 'la']).map((g) => g.layer), ['联络线', null, '市区线'],
  '全线倒序：组序按组内最靠前成员（未分类居中＝保真用户序优先于「未分类恒最后」惯例）');
eq(V.layerGroups(lm, ['lb']).map((g) => g.layer), [null, '联络线', '市区线'],
  '只序未分类线：该组置首，其余组间回落中文序');
eq(V.layerGroups(lm, ['lx-unknown', 'la']).map((g) => g.layer), ['市区线', '联络线', null],
  '未知 id 忽略：仅 la 生效（市区线有序置首），其余组回落旧惯例');
eq(V.layerGroups(lm, 'not-array').map((g) => g.layer), ['联络线', '市区线', null], '非数组容错＝无序');
const lmo = new Map([['l1', { lineId: 'l1', layer: '市区线' }], ['l2', { lineId: 'l2', layer: '市区线' }],
  ['l3', { lineId: 'l3', layer: '市区线' }]]);
eq(V.layerGroups(lmo, ['l3', 'l1', 'l2'])[0].lines.map((l) => l.lineId), ['l3', 'l1', 'l2'], '组内按自定义序');
eq(V.layerGroups(lmo, ['l2'])[0].lines.map((l) => l.lineId), ['l2', 'l1', 'l3'], '组内未列入者靠后 tie-break id 升序');
eq(V.visibleListGroups(lm, ['联络线'], ['lc', 'la', 'lb']).map((g) => g.layer), ['市区线', null],
  '过滤＋自定义序叠加：隐藏组整组剔除，余组仍按组内最靠前成员排序');

// ---------- zoomInterp / scaledSize（尺寸随缩放等比：z≥11 封顶、z<11 按 2^(z−11) 等比缩小） ----------
console.log('zoomInterp / scaledSize:');
ok(V.SIZE_ZOOM_MIN === 5 && V.SIZE_ZOOM_HOLD === 11 && V.SIZE_SCALE_EXP === 2, '等比常量：锚 z5/封顶 z11/底 2');
eq(V.zoomInterp(0.11, 7), ['interpolate', ['exponential', 2], ['zoom'], 5, 0.11, 11, 7],
  '线宽 7 表达式（z5=0.11 锚、z11=7 封顶两端 clamp；exponential 2＝每级×2 与画布同比例）');
eq(V.scaledSize(7), 0.11, 'scaledSize(7)＝7/64＝0.11');
eq(V.scaledSize(5.5), 0.09, '站圈 5.5 → 0.09');
eq(V.scaledSize(7.5), 0.12, '大圈 7.5 → 0.12');
eq(V.scaledSize(2), 0.03, '描边 2 → 0.03');
eq(V.scaledSize(2.2), 0.03, '黑边 2.2 → 0.03（低端锚两位小数与描边同值——z≥11 处才分档）');
eq(V.scaledSize(15), 0.23, '药丸 15 → 0.23');
eq(V.scaledSize(19.4), 0.3, '药丸外层 19.4 → 0.30（两位小数舍入防浮点噪声）');
eq(V.scaledSize(1), 0.02, 'icon-size 1 → 0.02');
ok(V.labelScale(11) === 1 && V.labelScale(13) === 1 && V.labelScale(11.7) === 1, 'labelScale：z≥11 封顶 1（拉近不变大）');
eq(V.labelScale(10), 0.5, 'labelScale(10)＝0.5');
eq(V.labelScale(9), 0.25, 'labelScale(9)＝0.25');
ok(Math.abs(V.labelScale(8) - 0.125) < 1e-12, 'labelScale(8)≈0.125（无下限地板，与元素同规则）');
ok(V.labelScale('abc') === 1 && V.labelScale(null) === 1, 'labelScale 异常输入容错＝1');

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
ok(kml.includes('id="line"'), '单一样式 id="line"（不再按分段状态拆 Style）');
ok(!kml.includes('seg-existing') && !kml.includes('seg-approved') && !kml.includes('seg-future'),
  '三档状态样式全删（2026-11-22 改版：导出纯色实线）');
ok((kml.match(/<Placemark>/g) || []).length === 4, 'Placemark＝2 段＋2 站（段仍拆分、段名保留状态文字）');
ok(kml.includes('<name>' + V.xmlEscape('甲<&>"\'站') + '</name>'), '站名 XML 转义');
ok(kml.includes('0.200000,0.300000,0'), '站坐标 6 位小数');
ok(kml.includes('0.000000,0.000000,0 1.000000,0.000000,0'), '段坐标逐点一致（WGS84 不动）');
ok(kml.includes('<color>ff0000ff</color>'), '线色全不透明（#ff0000 → ff0000ff，alpha 恒 ff）');
const kmlLc = V.buildLineKML('lc', lm, []);
ok(kmlLc.includes('<color>ff'), '任意线（含全 future 段）同样统一不透明');
ok(!kmlLc.match(/<color>(?!ff)[0-9a-f]{2}/), '不再含任何半透明 alpha');
ok(V.buildLineKML('nope', lm, st) === null, '未知线路返回 null');
ok(V.buildLineKML('la', lm, escStops, { lineWidth: 5 }).includes('<width>5</width>'), 'lineWidth 透传');

// ---------- 链路小集成：归一 → 视图 → 摘要 ----------
console.log('integration:');
const lmI = V.normalizeLines(linesFC);
const stI = V.stopList(stopsFC);
const svI = V.buildStopView(stI);
const summI = V.lineSummaries(lmI, stI);
eq(svI.pins.length, 8, '集成视图 pin 数一致（g1 药丸成员圈隐去）');
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

// ---------- 出省箭头 kind 过滤（非站：不进视图/摘要/导出；2026-11-22 改版后无 glyph 视图） ----------
console.log('arrows (kind filter):');
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
  arFeat('ar1', 'lm', 1.5, 3, 0, 'M线'),    // lm 站序（t 序）最末 → tail 端
  arFeat('ar2', 'ln', 1.2, 0, 11, 'N线'),   // ln 站序最末 → tail 端
  arFeat('ar3', 'lo', 0.5, 1, 1, 'O线'),    // lo 线不在 linesMap（孤 arrow 站）
);
const stAr = V.stopList(arrowFC);
eq(stAr.find((s) => s.sid === 'm1').kind, 'stop', '缺 kind 字段归 stop');
eq(stAr.find((s) => s.sid === 'ar1').kind, 'arrow', 'kind:"arrow" 保留（不剔除）');
const svAr = V.buildStopView(stAr);
ok(!svAr.pins.some((p) => String(p.key).indexOf('ar') === 0) && !svAr.labels.some((l) => String(l.key).indexOf('ar') === 0),
  'arrow 不进 pins/labels（搜索索引随 labels 一并排除——不画圈、不进搜索/点选）');
const lmAr = V.normalizeLines(arrowFC);
const sumAr = V.lineSummaries(lmAr, stAr);
eq(sumAr.get('lm').stopCount, 2, 'lineSummaries 不把 arrow 计为站');
eq(sumAr.get('lm').terminals, ['甲站', '乙站'], '起讫不含 arrow');
eq(sumAr.get('lm').stopsOrdered.map((s) => s.sid), ['m1', 'm2'], '站序不含 arrow');
const gjAr = V.buildLineGeoJSON('lm', lmAr, stAr);
eq(gjAr.features.filter((f) => f.geometry.type === 'Point').map((f) => f.properties.sid), ['m1', 'm2'],
  'GeoJSON 导出剔除 arrow');
ok(!V.buildLineKML('lm', lmAr, stAr).includes('ar1'), 'KML 导出剔除 arrow');

// ---------- arrowFadePlan（出省端末段 1km 渐隐计划，2026-11-22 用户改版） ----------
console.log('arrowFadePlan:');
ok(V.ARROW_FADE_M === 1000, '渐变段长常量＝1000m（2026-11-22 用户定案值）');
const afFC = fc(
  lineFeat('ah', 0, 'future', [[0, 0], [1, 0]], { name: 'H线', color: '#ff0000' }),        // head 端 arrow
  lineFeat('at', 0, 'future', [[0, 5], [1, 5]], { name: 'T线', color: '#00ff00' }),        // tail 端 arrow
  lineFeat('ab', 0, 'future', [[0, 10], [1, 10]], { name: 'B线', color: '#0000ff' }),      // 两端 arrow
  lineFeat('am', 0, 'future', [[0, 15], [1, 15]], { name: 'M线', color: '#123456' }),      // 非端点 arrow → 忽略
  lineFeat('an', 0, 'future', [[0, 20], [1, 20]], { name: 'N线', color: '#654321' }),      // 无 arrow → 不进 plan
  lineFeat('as', 0, 'future', [[0, 25], [0, 25.001]], { name: 'S线', color: '#999999' }),  // 111.32m 短线 → clamp
  lineFeat('az', 0, 'future', [[0, 30], [1, 30]], { name: 'Z线', color: '#abcdef' }),      // arrow 无 t → 尾位归位
  lineFeat('ax', 1, 'existing', [[0.5, 50], [0.5, 50.5]], { name: 'X线', color: '#feed00' }),  // 多段折线（乱序 segIndex）
  lineFeat('ax', 0, 'existing', [[0, 50], [0.5, 50]], { name: 'X线', color: '#feed00' }),
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[NaN, NaN], [NaN, NaN]] },
    properties: { lineId: 'abad', segIndex: 0, segStatus: 'existing' } },                  // 有 arrow 但无有效坐标
  stopFeat('ha0', '甲', 'ah', 'H线', 1, 1, 0),
  arFeat('ha', 'ah', 0, 0, 0, 'H线'),
  stopFeat('ta0', '乙', 'at', 'T线', 0, 0, 5),
  arFeat('ta', 'at', 1, 1, 5, 'T线'),
  stopFeat('ba0', '丙', 'ab', 'B线', 0.5, 0.5, 10),
  arFeat('ba1', 'ab', 0, 0, 10, 'B线'),
  arFeat('ba2', 'ab', 1, 1, 10, 'B线'),
  stopFeat('ma0', '丁', 'am', 'M线', 0, 0, 15),
  stopFeat('ma1', '戊', 'am', 'M线', 1, 1, 15),
  arFeat('ma', 'am', 0.5, 0.5, 15, 'M线'),
  stopFeat('na0', '己', 'an', 'N线', 0.5, 0.5, 20),
  stopFeat('sa0', '庚', 'as', 'S线', 0, 0, 25),
  arFeat('sa', 'as', 1, 0, 25.001, 'S线'),
  stopFeat('za0', '辛', 'az', 'Z线', 0, 0, 30),
  arFeat('za', 'az', null, 1, 1, 'Z线'),
  stopFeat('xa0', '壬', 'ax', 'X线', 0.5, 0.5, 50),
  arFeat('xa', 'ax', 1, 0.5, 50.5, 'X线'),
  arFeat('bada', 'abad', 0, 0, 0, '坏线'),
);
const lmAF = V.normalizeLines(afFC);
const stAF = V.stopList(afFC);
const plan = V.arrowFadePlan(lmAF, stAF);
eq(plan.map((it) => it.lineId), ['ah', 'at', 'ab', 'as', 'az', 'ax'],
  'plan 成员＝linesMap 序（am 非端点忽略、an 无 arrow、abad 无有效坐标均不进）');
// 手算对照（平面近似：1° 纬差＝111320m；1° 经差＝111320×cos(线首末纬均值)；lat=0 时 cos 因子 1）
ok(plan[0].tailCut === null && Math.abs(plan[0].headCut - 1000 / 111320) < 1e-12,
  'ah：首站 arrow → 仅 headCut＝1000/111320（赤道 1° 线总长）');
ok(plan[1].headCut === null && Math.abs(plan[1].tailCut - 1000 / (111320 * Math.cos(5 * Math.PI / 180))) < 1e-12,
  'at：尾站 arrow → 仅 tailCut（1° 经差线在 lat0＝5° 的总长）');
ok(Math.abs(plan[2].headCut - 1000 / (111320 * Math.cos(10 * Math.PI / 180))) < 1e-12
  && Math.abs(plan[2].tailCut - plan[2].headCut) < 1e-15,
  'ab：两端 arrow → headCut＝tailCut（双 cut 同值）');
eq(plan[3], { lineId: 'as', headCut: null, tailCut: 1 },
  'as：总长 111.32m＜1km → clamp cut＝1＝整线渐变');
ok(plan[4].headCut === null && Math.abs(plan[4].tailCut - 1000 / (111320 * Math.cos(30 * Math.PI / 180))) < 1e-12,
  'az：arrow 无 t → 站序排最后＝按 tail 端处理（防御性归位）');
// ax：多段乱序 segIndex 拼接，段1＝0.5° 经差×cos(50.25°)、段2＝0.5° 纬差（lat0＝(50+50.5)/2）
const axTotal = 0.5 * 111320 * Math.cos(50.25 * Math.PI / 180) + 0.5 * 111320;
ok(plan[5].headCut === null && Math.abs(plan[5].tailCut - 1000 / axTotal) < 1e-12,
  'ax：多段折线平面近似总长（经纬混合、cos 因子按全线首末纬均值）');
eq(V.arrowFadePlan(null, stAF), [], 'linesMap 非 Map → []');
eq(V.arrowFadePlan(lmAF, null), [], 'stops null → 无站序可判 → []（防御）');
eq(V.arrowFadePlan(lmAF, 'not-array'), [], 'stops 非数组 → []（防御）');

// ---------- arrowFadeGradient（端组合渐变 stops 表达式，渲染层 arrow-fade 层同构） ----------
console.log('arrowFadeGradient:');
const cR = '#ff0000', fadeR = 'rgba(255,0,0,0)';
eq(V.arrowFadeGradient(cR, null, 0.25),
  ['interpolate', ['linear'], ['line-progress'], 0, '#ff0000', 0.75, '#ff0000', 1, fadeR],
  '仅 tail：[0,c, 1−cut,c, 1,fade]——中段恒色、尾端渐隐');
eq(V.arrowFadeGradient(cR, 0.25, null),
  ['interpolate', ['linear'], ['line-progress'], 0, fadeR, 0.25, '#ff0000', 1, '#ff0000'],
  '仅 head：[0,fade, cut,c, 1,c]——首端自渐隐起');
eq(V.arrowFadeGradient(cR, 0.2, 0.3),
  ['interpolate', ['linear'], ['line-progress'], 0, fadeR, 0.2, '#ff0000', 0.7, '#ff0000', 1, fadeR],
  '两端：[0,fade, h,c, 1−t,c, 1,fade]');
eq(V.arrowFadeGradient(cR, 1, null),
  ['interpolate', ['linear'], ['line-progress'], 0, fadeR, 1, '#ff0000'],
  '仅 head 且 cut＝1（<1km）→ 整线渐变收两 stop');
eq(V.arrowFadeGradient(cR, null, 1),
  ['interpolate', ['linear'], ['line-progress'], 0, '#ff0000', 1, fadeR],
  '仅 tail 且 cut＝1（<1km）→ 整线渐变收两 stop');
eq(V.arrowFadeGradient(cR, 0.6, 0.6),
  ['interpolate', ['linear'], ['line-progress'], 0, fadeR, 0.5, '#ff0000', 1, fadeR],
  '双端重叠（0.6+0.6＞1）→ 按比例收缩（各 0.5）＋恰衔接并段（stop 严格升序防弃层）');
eq(V.arrowFadeGradient(cR, 0.5, 0.5),
  ['interpolate', ['linear'], ['line-progress'], 0, fadeR, 0.5, '#ff0000', 1, fadeR],
  '双端恰衔接（和＝1）→ 中段退化并段（无重复 stop 键）');
ok(V.arrowFadeGradient('#ff0000', null, null) === null, '两端均 null → null（调用方跳过建层）');
eq(V.arrowFadeGradient('not-a-color', 0.25, null)[6], '#888888', '非法色退默认灰');
eq(V.arrowFadeGradient('#00FF00', null, 0.25)[8], 'rgba(0,255,0,0)', '大写色 normalizeHex 小写化后取 rgb（fade＝同色 alpha 0）');

// ---------- 手造输入链路自证：arrow＋3 线 same 组一起过纯逻辑（不起浏览器） ----------
console.log('pill+arrow integration:');
const pillFC = fc(
  lineFeat('lx', 0, 'approved', [[8, 0], [9, 0], [9, 1]], { name: 'X线', color: '#ff0000' }),
  lineFeat('ly', 0, 'approved', [[8, 0], [9, 1]], { name: 'Y线', color: '#00ff00' }),
  lineFeat('lz', 0, 'approved', [[9, 0], [9, 1]], { name: 'Z线', color: '#0000ff' }),
  stopFeat('x1', '药丸甲', 'lx', 'X线', 0.1, 8, 0, 'g9', 'same-station'),
  stopFeat('y1', '药丸乙', 'ly', 'Y线', 0.9, 9, 0, 'g9', 'same-station'),
  stopFeat('z1', '药丸丙', 'lz', 'Z线', 0.5, 9, 1, 'g9', 'same-station'),
  arFeat('arx', 'lx', 1.5, 10, 0, 'X线'),   // 组外出省箭头：站序（t 序）最末 → tail 端
);
const stP = V.stopList(pillFC);
const svP = V.buildStopView(stP);
const pill9 = svP.pills.find((p) => p.groupId === 'g9') || { chain: null };
ok(svP.pills.length === 1, 'g9（3 线同站组）恰出一枚药丸');
eq(pill9.chain, [[8, 0], [9, 0], [9, 1]], '链序＝贪心最近邻（n=3 连 2 段，非两两相连）');
eq(svP.pins.filter((p) => p.groupId === 'g9').length, 0, '三成员圈隐去（药丸即换乘标识）');
ok(pill9.pin && pill9.pin.kind === 'group' && pill9.pin.name === '药丸甲' && pill9.pin.key === 'g:g9',
  '药丸条目自带组 pin（首个非空名）');
ok(!svP.pins.some((p) => p.kind === 'group' && p.groupId === 'g9'), '药丸组不再有合并大圈 pin');
eq(svP.labels.filter((l) => l.group).map((l) => l.key), ['g:g9'], '药丸组合并为一个组标签');
const sumP = V.lineSummaries(V.normalizeLines(pillFC), stP);
eq(sumP.get('lx').stopCount, 1, 'lx 站数不含 arrow（药丸成员照常计数）');
// arrowFadePlan 小集成：arrow 与药丸并存互不干扰——lx 的 arx 站序最末 → tail 端；
// lx 总长＝段1（1° 经差×cos(0.5°)，lat0＝全线首末纬均值 (0+1)/2）＋段2（1° 纬差）
const planP = V.arrowFadePlan(V.normalizeLines(pillFC), stP);
eq(planP.map((it) => it.lineId), ['lx'], '仅 lx 进 plan（ly/lz 无 arrow）');
const lxTotal = 111320 * Math.cos(0.5 * Math.PI / 180) + 111320;
ok(planP[0].headCut === null && Math.abs(planP[0].tailCut - 1000 / lxTotal) < 1e-12,
  'arx → 仅 tailCut（多段折线平面近似总长手算对照）');

// ---------- 主支线合并（2026-11-22 用户裁定：主线与支线在查看器眼中恒为一条线） ----------
console.log('line groups merge:');
const mgFC = fc(
  lineFeat('m1', 0, 'existing', [[0, 0], [1, 0]], { name: '一号线', aliases: ['One'], color: '#e40012', role: 'main', layer: '市区线', groupId: 'lgA' }),
  lineFeat('b1', 0, 'future', [[1, 0], [2, 1]], { name: '一号线支线', aliases: ['支', '分歧段'], color: '#999999', role: 'branch', layer: '市区线', groupId: 'lgA' }),
  lineFeat('s1', 0, 'approved', [[5, 5], [6, 5]], { name: '二号线', color: '#00a651', role: 'standalone' }),   // 无组独立线
  lineFeat('x1', 0, 'future', [[9, 9], [9, 8]], { name: '空组员甲', role: 'standalone', groupId: 'lgB' }),  // 无 main 组组员
  lineFeat('x2', 0, 'future', [[9, 8], [9, 7]], { name: '空组员乙', role: 'branch', groupId: 'lgB' }),
  lineFeat('m2', 0, 'approved', [[20, 0], [21, 0]], { name: '三号线主线', color: '#0000ff', role: 'main', layer: '市域线' }),        // 仅 members 声明方向（无 groupId）
  lineFeat('b2', 0, 'approved', [[21, 0], [22, 1]], { name: '三号线支线', color: '#123456', role: 'branch', layer: '市域线' }),
  lineFeat('d1', 0, 'existing', [[30, 0], [31, 0]], { name: '他省甲', color: '#888888', role: 'main', layer: '他省', groupId: 'lgD' }),  // displayOnly 入组（防御用例）
  lineFeat('d2', 0, 'future', [[31, 0], [32, 1]], { name: '他省乙', color: '#ff00ff', role: 'branch', layer: '市区线', groupId: 'lgD' }),
);
const lmG = V.normalizeLines(mgFC);
eq(lmG.get('m1').groupId, 'lgA', 'normalizeLines 保留 groupId');
eq(lmG.get('s1').groupId, '', '无组线 groupId 空串（flatten 键齐口径）');
// buildLineGroups：双向并集归属（lgA 空成员表仅靠 groupId / lgC 声明式 members）
const lgFull = V.buildLineGroups(lmG, [
  { id: 'lgA', name: '一号线', members: [] },
  { id: 'lgB', name: '坏组', members: ['x1', 'x2'] },
  { id: 'lgC', name: '三号线', members: ['m2', 'b2', 'ghost'] },   // ghost＝不在输出的成员（防御）
  { id: 'lgD', name: '他省组', members: [] },
]);
eq(lgFull.groups.map((g) => g.id), ['lgA', 'lgC', 'lgD'], '有效组＝lgA/lgC/lgD（lgB 无 main 成员不合并）');
eq(lgFull.groups[0].members, ['m1', 'b1'], 'lgA 空成员表＋groupId 指向 → 双向并集 [m1,b1]');
eq(lgFull.groups[0].mainId, 'm1', 'lgA 主线＝m1');
eq(lgFull.groups[1].members, ['m2', 'b2'], 'lgC 声明 members 生效（ghost 不在 linesMap 被滤）');
eq(lgFull.groups[2].mainId, 'd1', 'lgD 主线＝d1（displayOnly 线入组同规则）');
eq(lgFull.mainOf.get('b1'), 'm1', 'mainOf：支线→主线');
eq(lgFull.mainOf.get('d2'), 'd1', 'mainOf：他省组支线→主线');
ok(!lgFull.ofLine.has('x1') && !lgFull.mainOf.has('x2'), '无 main 组组员不归并（照旧独立显示）');
ok(!lgFull.mainOf.has('m1'), '主线自身不进 mainOf');
eq(lgFull.groups[1].name, '三号线', '组名取记录名');
const lgNoname = V.buildLineGroups(lmG, [{ id: 'lgA', name: '', members: ['m1', 'b1'] }]);
eq(lgNoname.groups[0].name, '一号线', '组名缺失退主线名（不擅自造名）');
eq(V.buildLineGroups(lmG, null).groups, [], 'null lineGroups＝空结构（net-index@1 旧快照兼容）');
ok(V.buildLineGroups(lmG, null).mainOf instanceof Map && V.buildLineGroups(lmG, null).ofLine instanceof Map,
  '空结构仍带 ofLine/mainOf Map（胶水层免判空）');
eq(V.buildLineGroups(null, [{ id: 'lgA', members: ['m1'] }]).groups, [], 'null linesMap 不崩返回空');
// 列表合并行：名＝组名、色块＝主线色、归类与排序按主线、支线不出独立行
const lgrM = V.layerGroups(lmG, null, lgFull);
const rowsM = [].concat(...lgrM.map((g) => g.lines));
eq(rowsM.map((l) => l.lineId).sort(), ['d1', 'm1', 'm2', 's1', 'x1', 'x2'], '支线不出独立行（b1/b2/d2 无行）、主线照出');
const m1row = rowsM.find((l) => l.lineId === 'm1');
eq(m1row.name, '一号线', '合并行显示名＝线组名称');
eq(m1row.color, '#e40012', '合并行色块＝主线色（非支线色 #999999）');
eq(m1row.layer, '市区线', '合并行归类＝主线类别');
eq(rowsM.find((l) => l.lineId === 'm2').name, '三号线', '声明式组主线行名＝组名');
eq(lgrM.map((g) => g.layer), ['市区线', '市域线', '他省', null], '分组与组序按主线类别（中文序、未分类最后）');
eq(V.layerGroups(lmG, ['s1'], lgFull).map((g) => g.layer), [null, '市区线', '市域线', '他省'],
  '排序按行集：支线 b1 列入 lineOrder 也不占位（s1 序生效置顶未分类）');
eq(V.layerGroups(lmG, null).length, V.layerGroups(lmG, null, null).length, '不传 lineGroups＝旧行为（向后兼容）');
eq(V.visibleListGroups(lmG, [], null, lgFull).length, 4, 'visibleListGroups 透传 lineGroups');
// 组级调光：期次态以主线为准、组全体同调同不调；聚焦豁免＝组全体成员
eq([...V.computeDimmedSet(lmG, { phase: 'existing', lineGroups: lgFull })].sort(),
  ['b2', 'd1', 'd2', 'm2', 's1', 'x1', 'x2'],
  '分期「既有」组级：lgA 组（主线 existing）全体不调光——b1 自身 future 也豁免；无 main 组组员照旧逐线');
eq([...V.computeDimmedSet(lmG, { phase: 'future', lineGroups: lgFull })].sort(),
  ['b1', 'b2', 'd1', 'd2', 'm1', 'm2', 's1'],
  '分期「远期」组级：组全体同调（b1 自身 future 但随主线 existing 一起被调光；x1/x2 恰 future 不调）');
eq([...V.computeDimmedSet(lmG, { focus: 'm1', lineGroups: lgFull })].sort(), ['d1', 'd2'],
  '聚焦主线 m1：不贡献 dim（白罩定案），仅他省组（d1/d2）随 focus 激活位恒调光（组级 displayOnly 以主线 d1 为准）');
eq([...V.computeDimmedSet(lmG, { focus: 'b1', lineGroups: lgFull })].sort(), ['d1', 'd2'],
  '防御：focus 直传支线 id 同上（不再有聚焦豁免分支——组豁免语义由渲染层白罩承接）');
eq([...V.computeDimmedSet(lmG, { phase: 'existing', focus: 'm2', lineGroups: lgFull })].sort(),
  ['b2', 'd1', 'd2', 'm2', 's1', 'x1', 'x2'],
  '叠加：分期既有＋聚焦 m2＝纯分期档结果（聚焦既不豁免 m2、也不对 lgA 组加调——并集只剩分期侧）');
eq([...V.computeDimmedSet(lmG, { phase: 'existing' })].sort(),
  ['b1', 'b2', 'd1', 'd2', 'm2', 's1', 'x1', 'x2'],
  '不传 lineGroups＝逐线旧行为（b1 future 被调光——与组级路径对照）');
// 搜索合并命中：主线与支线的 name＋aliases＋id 全部命中同一合并条目（显示名＝组名）
const entsG = V.lineSearchEntries(lmG, lgFull);
eq(entsG.map((e) => e.id).sort(), ['d1', 'm1', 'm2', 's1', 'x1', 'x2'], '条目集＝各有效组主线＋无组线（支线不单独出条目）');
const entA = entsG.find((e) => e.id === 'm1');
ok(entA && entA.text === '一号线', '合并条目 text＝组名');
eq(entA.aliases, ['一号线', 'One', '一号线支线', '支', '分歧段'], '主线与支线的 name＋aliases 全入 aliases（去重保序）');
eq(entA.terms, ['m1', 'b1'], '成员线 id 全入 terms（可命中不进副行）');
eq(entsG.find((e) => e.id === 's1').aliases, [], '无组线条目照旧');
eq(V.matchEntries('一号线支', entsG).map((e) => e.id), ['m1'], '支线名前缀命中合并条目');
eq(V.matchEntries('分歧段', entsG).map((e) => e.id), ['m1'], '支线别名命中合并条目');
eq(V.matchEntries('b1', entsG).map((e) => e.id), ['m1'], '支线 id（terms）命中合并条目');
eq(V.matchEntries('m1', entsG).map((e) => e.id), ['m1'], '主线 id（terms）命中合并条目');
eq(V.lineSearchEntries(lmG, null).length, 9, '无组信息＝逐线条目（9 条旧行为）');
// 站牌显示组名（linesOfPin/lineLabelOf：组成员一律显组名，主/支线去重）
eq(V.linesOfPin({ kind: 'group', lineIds: ['m1', 'b1', 's1'], lineNames: ['一号线', '一号线支线', '二号线'] }, lmG, lgFull),
  ['一号线（又称 One）', '二号线'], '组 pin 所属线路：主/支线同显组名并去重，别名随主线');
eq(V.linesOfPin({ kind: 'stop', lineId: 'b2', lineNames: ['三号线支线'] }, lmG, lgFull),
  ['三号线'], '单站 pin：支线显示组名');
eq(V.lineLabelOf('m2', lmG, lgFull), '三号线', '主线名≠组名时也显示组名');
eq(V.lineLabelOf('m1', lmG, lgFull), '一号线（又称 One）', '主线名恰为组名则不变（别名照挂）');
eq(V.lineLabelOf('s1', lmG, lgFull), '二号线', '无组线照旧');
eq(V.lineLabelOf('m1', lmG, null), '一号线（又称 One）', '无线组结构照旧（旧快照兼容）');
eq(V.lineLabelOf('zz', lmG, lgFull, '孤线'), '孤线', '孤线退 fallback');
eq(V.linesOfPin({ kind: 'stop', lineId: 'zz', lineNames: ['孤线'] }, lmG, lgFull), ['孤线'], '孤站退 lineName');

// ---------- 地图双击线路精确命中（2026-11-22 用户反馈：只认直接点到线体描边） ----------
console.log('dblclick precise hit:');
ok(V.LINE_WIDTH_PX === 7, '线宽基准常量＝7（lineLayerDef/connFadeLayerDef 同源引用，数值唯一源）');
ok(V.DBLCLICK_TOL_PX === 2, '双击命中容差常量＝2px（占位可调）');
eq(V.lineWidthAt(11), 7, 'lineWidthAt(z≥11)＝基准线宽（向上封顶）');
eq(V.lineWidthAt(13), 7, 'lineWidthAt(13) 封顶 7');
eq(V.lineWidthAt(5), V.scaledSize(7), 'lineWidthAt(z≤5)＝低端锚 scaledSize(7)（同两位小数舍入）');
eq(V.lineWidthAt(3), 0.11, 'lineWidthAt(3) 低端 clamp 0.11');
ok(Math.abs(V.lineWidthAt(8) - (0.11 + (Math.sqrt(2) - 1) * (7 - 0.11))) < 1e-9,
  'lineWidthAt(8)＝exponential 插值同式（lo+(2^t−1)×(hi−lo)，与 MapLibre 求值一致）');
ok(V.lineWidthAt('abc') === 7 && V.lineWidthAt(null) === 7, '异常输入退基准值（防御）');
const hitSeg = [[0, 0], [100, 0]];
eq(V.pointToScreenPolylineDist({ x: 50, y: 0 }, hitSeg), 0, '点在线上 → 0');
eq(V.pointToScreenPolylineDist({ x: 50, y: 3 }, hitSeg), 3, '垂距＝点到线段垂直距离');
eq(V.pointToScreenPolylineDist({ x: 150, y: 0 }, hitSeg), 50, '垂足在段延长线外 → 取端点距离');
eq(V.pointToScreenPolylineDist({ x: -30, y: 40 }, hitSeg), 50, '起点外侧 → 端点距（30-40-50 勾股）');
eq(V.pointToScreenPolylineDist({ x: 50, y: 4 }, [[0, 0], [100, 0], [100, 100]]), 4, '多段折线取全段最小');
eq(V.pointToScreenPolylineDist({ x: 60, y: 2 }, [[0, 10], [200, 10], [200, 100], [60, 3]]), 1,
  '多候选段取最近（末段端点距 1 ＜ 首段垂距 8）');
eq(V.pointToScreenPolylineDist({ x: 5, y: 5 }, [[3, 4]]), Math.hypot(2, 1), '单点退化＝点距');
ok(V.pointToScreenPolylineDist({ x: 5, y: 5 }, []) === Infinity, '空坐标 → Infinity（必然不命中）');
eq(V.pointToScreenPolylineDist({ x: 5, y: 5 }, [[NaN, 1], [1, 5]]), 4, '坏点跳过（剩单有效点 → 点距）');
ok(V.pointToScreenPolylineDist(null, hitSeg) === Infinity, '非法 point → Infinity（防御）');
// 命中阈值组合（胶水层同式 tol＝lineWidthAt(z)/2＋DBLCLICK_TOL_PX）
const tolAt = (z) => V.lineWidthAt(z) / 2 + V.DBLCLICK_TOL_PX;
ok(V.pointToScreenPolylineDist({ x: 50, y: 3 }, hitSeg) <= tolAt(11), '描边内（距 3 ≤ 7/2+2＝5.5px）判定命中');
ok(V.pointToScreenPolylineDist({ x: 50, y: 6 }, hitSeg) > tolAt(11), '描边外（距 6 ＞ 5.5px）不命中');
ok(V.pointToScreenPolylineDist({ x: 50, y: 2 }, hitSeg) <= tolAt(9), '拉远（z9 线宽≈4.16）命中带收窄仍含 2px');

// ---------- GCJ02 显示变换（测试阶段底图·高德对齐；与 src/geom.js 对拍守卫防副本漂移） ----------
console.log('gcj02 / makeDispCoord:');
const geom = require(path_join('src', 'geom.js'));   // 引法同 tools/test_geom.js
const GCJ_SAMPLE_PTS = [[121.47, 31.23], [116.4, 39.9], [0, 0], [135, 45]];   // 上海/北京/境外两点
for (const [lon, lat] of GCJ_SAMPLE_PTS) {
  const a = V.wgs84ToGcj02(lon, lat), b = geom.wgs84ToGcj02(lon, lat);
  ok(Math.abs(a[0] - b[0]) < 1e-12 && Math.abs(a[1] - b[1]) < 1e-12,
    `wgs84ToGcj02(${lon}, ${lat}) 与 geom.js 逐点一致（1e-12 容差）`);
  eq(V.outOfChina(lon, lat), geom.outOfChina(lon, lat), `outOfChina(${lon}, ${lat}) 与 geom.js 同步对拍`);
}
eq(V.wgs84ToGcj02(0, 0), [0, 0], '境外点（0,0）gcj 变换恒等');
// 135/45 地理上已在国界外，但落在公开近似式的粗界矩形内（lon<137.8347）——加偏照施加，
// 这是该算法的已知局限（geom.js 同行为）。对拍守卫已保证两份副本逐位一致，此处固化怪癖。
ok(V.outOfChina(135, 45) === false, '135/45 在算法粗界内（公开近似式矩形边界，非真实国界）');
eq(V.wgs84ToGcj02(135, 45), geom.wgs84ToGcj02(135, 45), '135/45 两副本输出一致（粗界内加偏，非恒等）');
ok(V.outOfChina(121.47, 31.23) === false && V.outOfChina(116.4, 39.9) === false, '上海/北京判境内');
ok(V.outOfChina(0, 0) === true, '境外样点（0,0）判境外');
const sh = V.wgs84ToGcj02(121.47, 31.23);
ok(Math.abs(sh[0] - 121.47) > 0.001 && Math.abs(sh[1] - 31.23) > 0.001, '上海点有实际偏移（非恒等）');
eq(V.makeDispCoord('none')(121.47, 31.23), [121.47, 31.23], 'makeDispCoord(none) 恒等');
eq(V.makeDispCoord('osm')(121.47, 31.23), [121.47, 31.23], 'makeDispCoord(osm) 恒等（OSM 瓦片即 WGS84）');
eq(V.makeDispCoord('carto')(121.47, 31.23), [121.47, 31.23], 'makeDispCoord(carto) 恒等（CARTO 瓦片即 WGS84，2026-11-23 接入）');
eq(V.makeDispCoord('gaode')(121.47, 31.23), V.wgs84ToGcj02(121.47, 31.23), 'makeDispCoord(gaode)＝wgs84ToGcj02');
eq(V.makeDispCoord('gaode')(0, 0), [0, 0], 'makeDispCoord(gaode) 境外恒等（outOfChina 内部守卫）');
const gcj = V.wgs84ToGcj02(121.47,31.23), back = V.gcj02ToWgs84(gcj[0],gcj[1]);
ok(Math.abs(back[0]-121.47)<1e-8 && Math.abs(back[1]-31.23)<1e-8, 'GCJ02 边缘读数逆变换还原 WGS84');
eq(V.makeDispCoord('weird')(1, 2), [1, 2], '未知 mode 兜恒等（防御）');

// ---------- 视口边缘读数尺 ----------
console.log('coordinate ruler:');
eq(V.niceTickStep(10, 1000, 100), 1, '1-2-5：1 档');
eq(V.niceTickStep(20, 1000, 100), 2, '1-2-5：2 档');
eq(V.niceTickStep(40, 1000, 100), 5, '1-2-5：5 档');
eq(V.niceTickStep(80, 1000, 100), 10, '1-2-5：进位');
eq(V.coordinateTicks(-1, 1, 0.5), [-1,-0.5,0,0.5,1], '经纬刻度序列含负数与零');
eq(V.formatCoordinate(-121.1234, 'lon', 0.01), '121.12°W', '经度负值与精度格式');
eq(V.formatCoordinate(0, 'lon', 1), '0°E', '零值避免负零');
eq(V.formatCoordinate(-0.0001, 'lat', 0.001), '0.000°N', '小数舍入不留负零与浮点尾巴');
eq(V.edgeTickPositions([{t:0,value:-1},{t:1,value:1}], [0]), [{value:0,t:0.5}], '边缘线性插值求交');
eq(V.edgeTickPositions([{t:0,value:-1},{t:0.5,value:1},{t:1,value:-1}], [0]), [{value:0,t:0.25},{value:0,t:0.75}], '非单调边缘保留两个交点');
eq(V.edgeTickPositions([{t:0,value:0},{t:1,value:0}], [0]), [], '重合边不生成不定交点');
const edgeSamples=[{t:0,value:0},{t:1,value:10}];
eq(V.edgeTickPositions(edgeSamples,[5]),[{value:5,t:0.5}],'边缘经纬坐标与屏幕参数对齐');
// 横/竖标签碰撞由 SVG 实际文字盒在页面层按真实像素裁决；此处验证交点屏幕参数。

// ---------- 嵌套换乘组（2026-11-23 用户裁定：换乘组可再把另一个组当成员） ----------
// 数据契约：index.json（fmt net-index@3）顶层 stationGroups＝[{id, type, stops, groups}]；站 feature 的
// groupId/groupType 仍＝直属组。节点＝最外层组；同站单元全部叶站合成一个符号（逻辑线 ≥3 药丸、否则
// 合并黑边大圈）；出闸单元直属站各自成圈、各子组自成绘制单元递归；junction 成员递归取全部叶站。
console.log('nested station groups:');
// parseNetIndex：三版放行＋字段判型（胶水层 fetchNetFiles 只调它）
{
  const EMPTY_IDX = { indexOrder: null, lineGroups: null, stationGroups: null, problem: '' };
  eq(V.parseNetIndex({ fmt: 'net-index@1', lineOrder: ['l0002', 'l0001'], lineGroups: [{ id: 'lg1' }], stationGroups: [{ id: 'g1' }] }),
    { indexOrder: ['l0002', 'l0001'], lineGroups: null, stationGroups: null, problem: '' }, '@1＝仅 lineOrder（lineGroups/stationGroups 即便有也不收）');
  const p2 = V.parseNetIndex({ fmt: 'net-index@2', lineOrder: ['l0001'], lineGroups: [{ id: 'lg1', members: ['l0001'] }] });
  eq([p2.indexOrder, p2.lineGroups, p2.stationGroups, p2.problem], [['l0001'], [{ id: 'lg1', members: ['l0001'] }], null, ''], '@2＝lineOrder＋lineGroups（无 stationGroups＝各组顶层旧行为）');
  const p3 = V.parseNetIndex({ fmt: 'net-index@3', lineOrder: [1], lineGroups: 'bad', stationGroups: [{ id: 'g1', type: null, stops: [], groups: [] }] });
  eq([p3.indexOrder, p3.lineGroups, p3.stationGroups, p3.problem], [['1'], null, [{ id: 'g1', type: null, stops: [], groups: [] }], ''], '@3＝＋stationGroups；lineGroups 非数组按缺省；lineOrder 逐项 String');
  const p3bad = V.parseNetIndex({ fmt: 'net-index@3', lineOrder: [], stationGroups: { id: 'g1' } });
  eq([p3bad.indexOrder, p3bad.lineGroups, p3bad.stationGroups === null, p3bad.problem !== ''], [[], null, true, true],
    '@3 而 stationGroups 非数组 → 置 null（按无嵌套）＋problem 带回提示（胶水层告警不抛）');
  eq([V.parseNetIndex({ fmt: 'net-index@3' }).stationGroups, V.parseNetIndex({ fmt: 'net-index@3' }).problem !== ''], [null, true], '@3 缺 stationGroups 键同上');
  eq(V.parseNetIndex({ fmt: 'net-index@4', lineOrder: ['l1'], stationGroups: [] }), EMPTY_IDX, 'fmt 不在名单＝整份视同不存在（全 null）——既有严格校验风格');
  eq(V.parseNetIndex(null), EMPTY_IDX, 'null 不抛');
  eq([V.parseNetIndex('net-index@3').stationGroups, V.parseNetIndex({ fmt: 'net-index@3', lineOrder: 'x', lineGroups: 7 }).lineGroups],
    [null, null], '非对象/字段非数组不抛且按缺省');
}

// ① 回归：旧形态数据（无嵌套、组内不含主支线/联络线）下 pins/pills/labels 与改前逐字段一致
//（SV_R_SNAPSHOT＝改前实现对本夹具的输出原样冻结，键序即输出序）
const lmR = V.normalizeLines(fc(
  lineFeat('ld', 0, 'existing', [[0, 0], [1, 0]], { name: '丁线', role: 'standalone' }),
  lineFeat('le', 0, 'future', [[0, 0], [0, 1]], { name: '戊线', role: 'standalone' }),
  lineFeat('lf', 0, 'future', [[0, 0], [1, 1]], { name: '己线', role: 'standalone' }),
));
const lgR = V.buildLineGroups(lmR, []);   // 无线组
const stR = V.stopList(fc(
  stopFeat('r1', '单站', 'ld', '丁线', 0.1, 0, 0),
  stopFeat('r2', '三线汇', 'ld', '丁线', 0.5, 1, 1, 'gA', 'same-station'),
  stopFeat('r3', '三线汇', 'le', '戊线', 0.5, 1.01, 1, 'gA', 'same-station'),
  stopFeat('r4', '三线汇', 'lf', '己线', 0.5, 1, 1.01, 'gA', 'same-station'),
  stopFeat('r5', '双线汇', 'ld', '丁线', 0.6, 2, 2, 'gB', 'same-station'),
  stopFeat('r6', '双线汇', 'le', '戊线', 0.4, 2, 2, 'gB', 'same-station'),
  stopFeat('r7', '接轨', 'ld', '丁线', 0.7, 3, 3, 'gC', 'junction'),
  stopFeat('r8', '接轨', 'lf', '己线', 0.3, 3, 3, 'gC', 'junction'),
  stopFeat('r9', '出闸西', 'ld', '丁线', 0.8, 4, 4, 'gD', 'out-of-station'),
  stopFeat('r10', '出闸东', 'le', '戊线', 0.9, 4.01, 4, 'gD', 'out-of-station'),
));
const tableR = [
  { id: 'gA', type: 'same-station', stops: ['r2', 'r3', 'r4'], groups: [] },
  { id: 'gB', type: 'same-station', stops: ['r5', 'r6'], groups: [] },
  { id: 'gC', type: 'junction', stops: ['r7', 'r8'], groups: [] },
  { id: 'gD', type: 'out-of-station', stops: ['r9', 'r10'], groups: [] },
];
const SV_R_SNAPSHOT = {
  pins: [
    { kind: 'stop', key: 'r1', name: '单站', lineId: 'ld', lineNames: ['丁线'], groupType: null, groupId: null, stroke: null, big: false, lon: 0, lat: 0 },
    { kind: 'group', key: 'g:gB', groupId: 'gB', name: '双线汇', lineNames: ['丁线', '戊线'], lineIds: ['ld', 'le'], groupType: 'same-station', big: true, lon: 2, lat: 2 },
    { kind: 'group', key: 'g:gC', groupId: 'gC', name: '接轨', lineNames: ['丁线', '己线'], lineIds: ['ld', 'lf'], groupType: 'junction', big: false, lon: 3, lat: 3 },
    { kind: 'stop', key: 'r9', name: '出闸西', lineId: 'ld', lineNames: ['丁线'], groupType: 'out-of-station', groupId: 'gD', stroke: null, big: false, lon: 4, lat: 4 },
    { kind: 'stop', key: 'r10', name: '出闸东', lineId: 'le', lineNames: ['戊线'], groupType: 'out-of-station', groupId: 'gD', stroke: null, big: false, lon: 4.01, lat: 4 },
  ],
  pills: [
    { key: 'g:gA', groupId: 'gA', lineIds: ['ld', 'le', 'lf'], chain: [[1.01, 1], [1, 1], [1, 1.01]],
      pin: { kind: 'group', key: 'g:gA', groupId: 'gA', name: '三线汇', lineNames: ['丁线', '戊线', '己线'], lineIds: ['ld', 'le', 'lf'], groupType: 'same-station', big: true, lon: 1.0033333333333332, lat: 1.0033333333333332 } },
  ],
  labels: [
    { key: 'r1', name: '单站', lon: 0, lat: 0, group: false, groupType: null, lineNames: ['丁线'], lineIds: ['ld'] },
    { key: 'g:gA', name: '三线汇', lon: 1.0033333333333332, lat: 1.0033333333333332, group: true, groupType: 'same-station', lineNames: ['丁线', '戊线', '己线'], lineIds: ['ld', 'le', 'lf'] },
    { key: 'g:gB', name: '双线汇', lon: 2, lat: 2, group: true, groupType: 'same-station', lineNames: ['丁线', '戊线'], lineIds: ['ld', 'le'] },
    { key: 'g:gC', name: '接轨', lon: 3, lat: 3, group: true, groupType: 'junction', lineNames: ['丁线', '己线'], lineIds: ['ld', 'lf'] },
    { key: 'g:gD', name: '出闸西', lon: 4.005, lat: 4, group: true, groupType: 'out-of-station', lineNames: ['丁线', '戊线'], lineIds: ['ld', 'le'] },
  ],
};
eq(V.buildStopView(stR), SV_R_SNAPSHOT, '① 旧调用（不传 opts＝@1/@2 旧产物路径）输出＝改前快照');
eq(V.buildStopView(stR, { linesMap: lmR, lineGroups: lgR }), SV_R_SNAPSHOT, '① 传 linesMap/lineGroups 不传结构表（@2 路径）＝改前快照');
eq(V.buildStopView(stR, { linesMap: lmR, lineGroups: lgR, tree: V.buildGroupTree(tableR, stR) }), SV_R_SNAPSHOT,
  '① 传 @3 平铺结构表（各组顶层、groups:[]）＝改前快照——单元数、字段、次序逐项一致');
eq(V.buildStopView(stR, { linesMap: lmR, lineGroups: lgR, tree: {} }), SV_R_SNAPSHOT, 'opts.tree 非法对象 → 现搭平铺树，不抛（防御）');
eq(V.buildStopView([]), { pins: [], pills: [], labels: [] }, '空输入不崩（嵌套改版后返回结构不变）');
eq(V.buildStopView(null), { pins: [], pills: [], labels: [] }, 'null 输入不崩');
eq(V.buildStopView('not-array'), { pins: [], pills: [], labels: [] }, '非数组输入不崩');
// 明确按新口径断言：上方旧夹具 g1＝甲线(main)＋乙线(standalone)＋丙线(connector) → 逻辑线 2 → 合并大圈
{
  const svNew1 = V.buildStopView(st, { linesMap: lm, lineGroups: V.buildLineGroups(lm, []) });
  ok(!svNew1.pills.some((p) => p.groupId === 'g1'), '① 新口径：g1 含联络线丙线 → 逻辑线 2 → 不出药丸');
  const g1new = svNew1.pins.find((p) => p.key === 'g:g1');
  ok(g1new && g1new.kind === 'group' && g1new.big === true && g1new.groupType === 'same-station' && g1new.lineIds.join(',') === 'la,lb,lc',
    '① 新口径：g1 改合并黑边大圈，lineIds 仍收全部三条成员线');
}

// 三形态夹具（线 id/线名/站况取自用户 2026-11-23 裁定所举站例；坐标手造）
const lmNx = V.normalizeLines(fc(
  lineFeat('l0058', 0, 'future', [[121.20, 31.10], [121.21, 31.11]], { name: '嘉松路线', role: 'standalone' }),
  lineFeat('l0075', 0, 'future', [[121.20, 31.00], [121.21, 31.00]], { name: '松江快线', role: 'main', groupId: 'lg06' }),
  lineFeat('l0076', 0, 'future', [[121.20, 31.00], [121.20, 31.01]], { name: '松江快线支线', role: 'branch', groupId: 'lg06' }),
  lineFeat('l0007', 0, 'future', [[121.30, 30.90], [121.31, 30.91]], { name: '沪乍线', role: 'standalone' }),
  lineFeat('l0008', 0, 'existing', [[121.30, 30.90], [121.32, 30.92]], { name: '金铁-金山站联络线', role: 'connector', layer: '联络线' }),
  lineFeat('l0057', 0, 'future', [[121.30, 30.95], [121.31, 30.96]], { name: '嘉青松金线', role: 'standalone' }),
  lineFeat('l0034', 0, 'future', [[121.48, 31.18], [121.49, 31.19]], { name: '19号线', role: 'standalone' }),
  lineFeat('l0051', 0, 'future', [[121.47, 31.17], [121.48, 31.18]], { name: '奉贤线', role: 'standalone' }),
  lineFeat('l0054', 0, 'future', [[121.48, 31.17], [121.49, 31.18]], { name: '机场快线', role: 'standalone' }),
  lineFeat('l0022', 0, 'existing', [[121.47, 31.18], [121.48, 31.19]], { name: '8号线', role: 'standalone' }),
));
const lgNx = V.buildLineGroups(lmNx, [{ id: 'lg06', name: '松江快线', members: ['l0075', 'l0076'] }]);
const stNx = V.stopList(fc(
  stopFeat('l0058-s11', '中辰路', 'l0058', '嘉松路线', 0.5, 121.205, 31.005, 'g9001', 'same-station'),      // 中辰路：外层同站组直属站
  stopFeat('l0075-s11', '中辰路', 'l0075', '松江快线', 0.5, 121.2, 31.0, 'g0148', 'junction'),             // 中辰路：内层 junction（既有 g0148 不动）
  stopFeat('l0076-s01', '中辰路', 'l0076', '松江快线支线', 0, 121.21, 31.01, 'g0148', 'junction'),
  stopFeat('l0057-s15', '上海金山', 'l0057', '嘉青松金线', 0.5, 121.305, 30.955, 'g9002', 'same-station'),   // 上海金山：外层同站组直属站
  stopFeat('l0007-s04', '上海金山', 'l0007', '沪乍线', 0.5, 121.3, 30.9, 'g0017', 'junction'),               // 上海金山：内层 junction（既有 g0017 不动）
  stopFeat('l0008-s01', '上海金山', 'l0008', '金铁-金山站联络线', 0.5, 121.31, 30.91, 'g0017', 'junction'),
  stopFeat('l0022-s20', '中华艺术宫', 'l0022', '8号线', 0.5, 121.475, 31.185, 'g9003', 'out-of-station'),   // 中华艺术宫：外层出闸组直属站
  stopFeat('l0034-s16', '中华艺术宫', 'l0034', '19号线', 0.5, 121.48, 31.18, 'g9004', 'same-station'),       // 中华艺术宫：内层同站组
  stopFeat('l0051-s03', '中华艺术宫', 'l0051', '奉贤线', 0.5, 121.47, 31.17, 'g9004', 'same-station'),
  stopFeat('l0054-s06', '中华艺术宫', 'l0054', '机场快线', 0.5, 121.475, 31.175, 'g9004', 'same-station'),
));
const nxTable = [
  { id: 'g9001', type: 'same-station', stops: ['l0058-s11'], groups: ['g0148'] },
  { id: 'g0148', type: 'junction', stops: ['l0075-s11', 'l0076-s01'], groups: [] },
  { id: 'g9002', type: 'same-station', stops: ['l0057-s15'], groups: ['g0017'] },
  { id: 'g0017', type: 'junction', stops: ['l0007-s04', 'l0008-s01'], groups: [] },
  { id: 'g9003', type: 'out-of-station', stops: ['l0022-s20'], groups: ['g9004'] },
  { id: 'g9004', type: 'same-station', stops: ['l0034-s16', 'l0051-s03', 'l0054-s06'], groups: [] },
  { id: 'g9009', type: 'junction', stops: ['l0007-s99'], groups: [] },   // 无输出站点的组（成员已被上游剔除的形态）
];
const treeNx = V.buildGroupTree(nxTable, stNx);
const meanOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;   // 与实现同式同序（逐位一致）

// buildGroupTree：查组/父组/子组/最外层组/叶站
eq(treeNx.group('g9001').id, 'g9001', '树：按 id 查组');
ok(treeNx.group('nope') === null, '树：未知 id → null');
eq([treeNx.parentOf('g0148'), treeNx.parentOf('g9001'), treeNx.childrenOf('g9001'), treeNx.childrenOf('g0148'), treeNx.parentOf('nope'), treeNx.childrenOf('nope')],
  ['g9001', null, ['g0148'], [], null, []], '树：父组/子组（结构表 groups 列表）');
eq([treeNx.rootOf('g0148'), treeNx.rootOf('g9001'), treeNx.rootOf('g9004'), treeNx.rootOf('nope')],
  ['g9001', 'g9001', 'g9003', null], '树：最外层组（子组上溯到节点；未知 → null）');
eq(treeNx.subtreeIds('g9003'), ['g9003', 'g9004'], '树：自身＋全部子孙组（深度优先）');
eq(treeNx.directStops('g9001').map((s) => s.sid), ['l0058-s11'], '树：直属站');
eq(treeNx.leafStops('g9001').map((s) => s.sid), ['l0058-s11', 'l0075-s11', 'l0076-s01'], '树：叶站＝自身直属站＋子孙组直属站（站表序）');
eq(treeNx.leafStops('g9009'), [], '树：无站组叶站为空');
eq(treeNx.typeOf('g9001') + ',' + treeNx.typeOf('g0148') + ',' + treeNx.typeOf('g9003'), 'same-station,junction,out-of-station', '树：有效类型取结构表');
eq(treeNx.order, ['g9001', 'g0148', 'g9002', 'g0017', 'g9003', 'g9004', 'g9009'], '树：稳定序＝子树首个叶站的站表下标，无站组排最后');

const svNx = V.buildStopView(stNx, { linesMap: lmNx, lineGroups: lgNx, tree: treeNx });
// ② 中辰路：外层 same-station｛直属 1 站＋junction 子组 2 站｝——子组两条线属同一线组 → 逻辑线 2；**上级组一律药丸**
//（2026-11-23 用户裁定「无论有几个站圆都按多线站生成药丸」）：一枚药丸、一个标签
{
  const pill = svNx.pills.find((p) => p.key === 'g:g9001');
  const pin = pill ? pill.pin : null;
  ok(!svNx.pins.some((p) => p.key === 'g:g9001') && pin && pin.kind === 'group' && pin.big === true && pin.groupType === 'same-station',
    '② 中辰路：上级组不论线数——一枚药丸（组 pin 挂在药丸上、不进 pins）');
  ok(svNx.pills.filter((p) => p.groupId === 'g9001' || p.groupId === 'g0148').length === 1, '② 中辰路：只出一枚药丸（内层 junction 子组不出图形）');
  const ch = pill ? pill.chain : [];
  ok(ch.length === 3 && ch[1][0] === 121.205 && ch[1][1] === 31.005
    && [ch[0], ch[2]].map((c) => c.join(',')).sort().join(';') === '121.2,31;121.21,31.01', '② 中辰路：药丸链收三叶站、嘉松路线站居中');
  ok(!svNx.pins.some((p) => ['g:g0148', 'l0058-s11', 'l0075-s11', 'l0076-s01'].includes(p.key)), '② 中辰路：内层 junction 组与各叶站都不单独出圈');
  const lb = svNx.labels.find((l) => l.key === 'g:g9001');
  const lon = meanOf([121.205, 121.2, 121.21]), lat = meanOf([31.005, 31, 31.01]);
  eq(lb, { key: 'g:g9001', name: '中辰路', lon, lat, group: true, groupType: 'same-station', lineNames: ['嘉松路线', '松江快线', '松江快线支线'], lineIds: ['l0058', 'l0075', 'l0076'] },
    '② 中辰路：一个标签——位置＝三叶站均值、名取首个非空、lineIds 收全部成员线（含支线）');
  eq(pin ? [pin.lon, pin.lat] : null, [lon, lat], '② 中辰路：并点位置＝叶站均值（与标签同位）');
  eq(svNx.labels.filter((l) => l.lineIds.some((id) => id === 'l0058' || id === 'l0075' || id === 'l0076')), [lb], '② 中辰路：整个节点只有一个标签');
  // 对照：不嵌套时是两个符号（单成员同站组＋junction 组各一）
  const flatNx = V.buildGroupTree(nxTable.map((g) => Object.assign({}, g, { groups: [] })), stNx);
  eq(V.buildStopView(stNx, { linesMap: lmNx, lineGroups: lgNx, tree: flatNx }).pins.filter((p) => p.groupId === 'g9001' || p.groupId === 'g0148').map((p) => p.key),
    ['g:g9001', 'g:g0148'], '② 对照：不嵌套＝两个符号');
}
// ③ 上海金山：直属 1 站＋junction 子组 2 站（其中一条是 connector）→ 联络线不计 → 逻辑线 2；上级组一律药丸
{
  const pill3 = svNx.pills.find((p) => p.key === 'g:g9002');
  const pin = pill3 ? pill3.pin : null;
  ok(pin && pin.kind === 'group' && pin.big === true && pin.groupType === 'same-station', '③ 上海金山：上级组不论线数（联络线不计后仅 2）→ 药丸');
  eq(pill3 ? pill3.chain.length : 0, 3, '③ 上海金山：药丸链收全部叶站（含联络线站）');
  eq((pin || {}).lineIds, ['l0057', 'l0007', 'l0008'], '③ 上海金山：pin.lineIds 仍收全部成员线（含联络线——调光/聚焦口径不变）');
  ok(!svNx.pins.some((p) => ['g:g0017', 'l0057-s15', 'l0007-s04', 'l0008-s01'].includes(p.key)), '③ 上海金山：内层 junction 组与各叶站不单独出圈');
  const lb = svNx.labels.find((l) => l.key === 'g:g9002') || {};
  eq([lb.name, lb.lon, lb.lat], ['上海金山', meanOf([121.305, 121.3, 121.31]), meanOf([30.955, 30.9, 30.91])], '③ 上海金山：一个标签（叶站均值）');
  // 反证：同形态但子组无联络线（沪乍线＋原联络线各算一条）→ 逻辑线 3 → 药丸
  const lmNx2 = new Map(lmNx);
  lmNx2.set('l0008', Object.assign({}, lmNx.get('l0008'), { role: 'standalone' }));
  const pill2 = V.buildStopView(stNx, { linesMap: lmNx2, lineGroups: lgNx, tree: treeNx }).pills.find((p) => p.groupId === 'g9002');
  eq([pill2 ? pill2.chain.length : 0, pill2 ? pill2.pin.lineIds : null], [3, ['l0057', 'l0007', 'l0008']], '③ 反证：联络线改独立线后同节点逻辑线 3 → 药丸（叶站链）');
}
// ④ 中华艺术宫：外层 out-of-station｛直属 8 号线 1 站＋same-station 子组 3 站｝
{
  const p8 = svNx.pins.find((p) => p.key === 'l0022-s20');
  ok(p8 && p8.kind === 'stop' && p8.big === false && p8.groupType === 'out-of-station' && p8.groupId === 'g9003' && p8.lineId === 'l0022',
    '④ 中华艺术宫：8 号线直属站一个普通尺寸黑边圈');
  ok(!svNx.pins.some((p) => ['g:g9003', 'g:g9004', 'l0034-s16', 'l0051-s03', 'l0054-s06'].includes(p.key)), '④ 中华艺术宫：内层同站组成员圈与合并圈都不出（药丸即换乘标识）');
  const pill = svNx.pills.find((p) => p.key === 'g:g9004');
  ok(pill && pill.pin && pill.pin.kind === 'group' && pill.pin.big === true && pill.pin.groupType === 'same-station' && pill.pin.groupId === 'g9004',
    '④ 中华艺术宫：内层同站子组自成绘制单元——一枚药丸（逻辑线 3）');
  eq(pill.chain, [[121.48, 31.18], [121.475, 31.175], [121.47, 31.17]], '④ 中华艺术宫：药丸链序＝三叶站贪心最近邻');
  eq(svNx.labels.find((l) => l.key === 'g:g9003'),
    { key: 'g:g9003', name: '中华艺术宫', lon: 121.475, lat: 31.185, group: true, groupType: 'out-of-station', lineNames: ['8号线'], lineIds: ['l0022'] },
    '④ 中华艺术宫：出闸单元自己的标签只对直属站算（均值＝该站自身）');
  eq(svNx.labels.find((l) => l.key === 'g:g9004'),
    { key: 'g:g9004', name: '中华艺术宫', lon: meanOf([121.48, 121.47, 121.475]), lat: meanOf([31.18, 31.17, 31.175]), group: true, groupType: 'same-station',
      lineNames: ['19号线', '奉贤线', '机场快线'], lineIds: ['l0034', 'l0051', 'l0054'] },
    '④ 中华艺术宫：子组自己的标签');
  eq(svNx.pins.map((p) => p.key), ['l0022-s20'], '④ 全视图 pins（上级组与药丸组不进 pins；无站组 g9009 不出图形）');
  eq(svNx.pills.map((p) => p.key), ['g:g9001', 'g:g9002', 'g:g9004'], '④ 全视图药丸（两枚上级组＋一枚 3 线组）');
  eq(svNx.labels.map((l) => l.key), ['g:g9001', 'g:g9002', 'g:g9003', 'g:g9004'], '④ 全视图标签：每个单元各一');
  // 出闸单元无直属站 → 不出自己的标签（把 8 号线站挪出直属表）
  const noDirect = nxTable.map((g) => (g.id === 'g9003' ? Object.assign({}, g, { stops: [] }) : g));
  const stNo = stNx.filter((s) => s.sid !== 'l0022-s20');
  eq(V.buildStopView(stNo, { linesMap: lmNx, lineGroups: lgNx, tree: V.buildGroupTree(noDirect, stNo) }).labels.map((l) => l.key),
    ['g:g9001', 'g:g9002', 'g:g9004'], '④ 出闸单元没有直属站则本单元不出自己的标签（子组标签照出）');
  // 嵌套组与出闸换乘标签按 group/groupType 结构字段在 z≥10 显示。
  eq([V.filterLabels(svNx.labels, 11).length, V.filterLabels(svNx.labels, 10).length, V.filterLabels(svNx.labels, 9.99).length], [4, 4, 0], '嵌套单元标签 z≥10 显示');
  eq(V.filterLabels([{ key: 'plain', group: false, groupType: null }], 10).length, 0, 'z10 普通站仍隐藏');
  eq(V.filterLabels([{ key: 'exchange', group: false, groupType: 'out-of-station' }], 10).map((l) => l.key), ['exchange'], 'z10 出闸换乘站按类型显示');
  eq(V.filterLabels([{ key: 'interchange', group: true, groupType: 'same-station' }], 10).map((l) => l.key), ['interchange'], 'z10 换乘组按结构字段显示');


  // 调光口径不变：单元标签收全部成员线，全成员被调光才隐藏
  eq([V.visibleLabels(svNx.labels, 12, { dimmedSet: ['l0008'] }).some((l) => l.key === 'g:g9002'),
    V.visibleLabels(svNx.labels, 12, { dimmedSet: ['l0057', 'l0007', 'l0008'] }).some((l) => l.key === 'g:g9002')],
  [true, false], '调光口径不变：联络线被调光不隐藏上海金山标签，三成员全调光才隐藏');
}
// junction 节点：带子组＝上级组 → 一律药丸（pin 类型仍 junction、成员线递归取全部叶站）；平铺 junction 仍是合并普通尺寸圈
{
  const stJ = V.stopList(fc(
    stopFeat('j1', '接轨枢纽', 'l0007', '沪乍线', 0.5, 10, 10, 'jN', 'junction'),
    stopFeat('j2', '接轨枢纽', 'l0034', '19号线', 0.5, 10.1, 10, 'jI', 'same-station'),
    stopFeat('j3', '接轨枢纽', 'l0051', '奉贤线', 0.5, 10, 10.1, 'jI', 'same-station'),
  ));
  const tblJ = [
    { id: 'jN', type: 'junction', stops: ['j1'], groups: ['jI'] }, { id: 'jI', type: 'same-station', stops: ['j2', 'j3'], groups: [] }];
  const svJ = V.buildStopView(stJ, { linesMap: lmNx, lineGroups: lgNx, tree: V.buildGroupTree(tblJ, stJ) });
  eq(svJ.pins, [], 'junction 上级组：不出合并圈');
  eq(svJ.pills.map((p) => [p.key, p.pin.kind, p.pin.big, p.pin.groupType, p.pin.lineIds.join(','), p.chain.length]),
    [['g:jN', 'group', true, 'junction', 'l0007,l0034,l0051', 3]], 'junction 上级组：一枚药丸，pin 类型仍 junction、成员线递归取全部叶站');
  eq(svJ.labels.map((l) => l.key), ['g:jN'], 'junction 节点：一个标签');
  const svJF = V.buildStopView(stJ, { linesMap: lmNx, lineGroups: lgNx, tree: V.buildGroupTree(tblJ.map((g) => Object.assign({}, g, { groups: [] })), stJ) });
  eq([svJF.pins.map((p) => [p.key, p.big, p.groupType]), svJF.pills.length],
    [[['g:jN', false, 'junction'], ['g:jI', true, 'same-station']], 0], 'junction 对照：平铺（无子组）＝合并普通尺寸圈、不出药丸');
}
// shape:"pill"（2026-11-23 用户裁定）：同站组显式强制药丸——平行线双线站放大后大圆悬浮在两线之间的对策
{
  const shpSt = V.stopList(fc(
    stopFeat('sa1', '平行甲', 'la', '甲线', 0.5, 121, 31, 'gs1', 'same-station'),
    stopFeat('sb1', '平行甲', 'lb', '乙线', 0.5, 121.01, 31.001, 'gs1', 'same-station'),   // 两站心不重合（平行线）
  ));
  const shpLines = new Map([['la', { lineId: 'la', name: '甲线', role: 'standalone' }],
    ['lb', { lineId: 'lb', name: '乙线', role: 'standalone' }]]);
  const shpTbl = [{ id: 'gs1', type: 'same-station', stops: ['sa1', 'sb1'], groups: [] }];
  eq(V.buildGroupTree(shpTbl, shpSt).group('gs1').shape, null, '树：结构表无 shape → null');
  eq(V.buildGroupTree([Object.assign({}, shpTbl[0], { shape: 'pill' })], shpSt).group('gs1').shape, 'pill', '树：shape:"pill" 收进树节点');
  const svD = V.buildStopView(shpSt, { linesMap: shpLines, lineGroups: null, tree: V.buildGroupTree(shpTbl, shpSt) });
  eq(svD.pins.map((p) => p.key), ['g:gs1'], 'shape：双线同站组默认＝合并大圆（进 pins）');
  eq(svD.pills, [], 'shape：默认无药丸');
  const pillTbl = [Object.assign({}, shpTbl[0], { shape: 'pill' })];
  const svP = V.buildStopView(shpSt, { linesMap: shpLines, lineGroups: null, tree: V.buildGroupTree(pillTbl, shpSt) });
  eq(svP.pills.map((p) => p.key), ['g:gs1'], 'shape：shape:"pill" 强制药丸（不论线数）');
  eq(svP.pins, [], 'shape：药丸组不进 pins（药丸即换乘标识）');
  eq(svP.pills[0].chain.map((c) => c.join(',')).sort().join(';'), '121,31;121.01,31.001', 'shape：药丸链收两站心（圆心均值改过站心胶囊）');
  eq(svP.labels.map((l) => l.key), ['g:gs1'], 'shape：标签照出');
  // 非 same-station 写 shape 不生效（validate 禁写；查看器防御性忽略）
  const svJ2 = V.buildStopView(shpSt, { linesMap: shpLines, lineGroups: null,
    tree: V.buildGroupTree([Object.assign({}, shpTbl[0], { type: 'junction', shape: 'pill' })], shpSt) });
  eq([svJ2.pills.length, svJ2.pins.map((p) => [p.key, p.big, p.groupType])], [0, [['g:gs1', false, 'junction']]],
    'shape：junction 写 shape 不生效（平铺接轨仍合并普通圈）');
  // 未知 shape 值按无强制（validate 禁写；防御）
  const svX = V.buildStopView(shpSt, { linesMap: shpLines, lineGroups: null,
    tree: V.buildGroupTree([Object.assign({}, shpTbl[0], { shape: 'circle' })], shpSt) });
  eq([svX.pills.length, svX.pins.map((p) => p.key)], [0, ['g:gs1']], 'shape：未知 shape 值按无强制处理');
}
// 出闸套出闸（三层）：子组按自身 type 递归
{
  const stO = V.stopList(fc(
    stopFeat('o1', '闸甲', 'l0007', '沪乍线', 0.1, 20, 20, 'oA', 'out-of-station'),
    stopFeat('o2', '闸乙', 'l0034', '19号线', 0.1, 20.01, 20, 'oB', 'out-of-station'),
    stopFeat('o3', '闸丙', 'l0051', '奉贤线', 0.1, 20.02, 20, 'oC', 'same-station'),
    stopFeat('o4', '闸丙', 'l0054', '机场快线', 0.1, 20.02, 20, 'oC', 'same-station'),
  ));
  const svO = V.buildStopView(stO, { linesMap: lmNx, lineGroups: lgNx, tree: V.buildGroupTree([
    { id: 'oA', type: 'out-of-station', stops: ['o1'], groups: ['oB'] },
    { id: 'oB', type: 'out-of-station', stops: ['o2'], groups: ['oC'] },
    { id: 'oC', type: 'same-station', stops: ['o3', 'o4'], groups: [] }], stO) });
  eq(svO.pins.map((p) => [p.key, p.big, p.groupType]), [['o1', false, 'out-of-station'], ['o2', false, 'out-of-station'], ['g:oC', true, 'same-station']],
    '出闸套出闸：两层直属站各自成圈，孙组按自身同站类型合成大圈（逻辑线 2）');
  eq(svO.labels.map((l) => l.key), ['g:oA', 'g:oB', 'g:oC'], '出闸套出闸：三个单元各一标签');
  const relO = V.groupRelations('oC', false, V.buildGroupTree([
    { id: 'oA', type: 'out-of-station', stops: ['o1'], groups: ['oB'] },
    { id: 'oB', type: 'out-of-station', stops: ['o2'], groups: ['oC'] },
    { id: 'oC', type: 'same-station', stops: ['o3', 'o4'], groups: [] }], stO), lmNx, lgNx);
  eq([relO.nodeChain, relO.partners], ['出闸换乘（组 oA） › 出闸换乘（组 oB）', '闸乙（19号线）'], '出闸套出闸：换乘节点链自最外层组向下；对端＝直属上级的直属站');
}
// type null／未知类型：沿用旧代码对 null 的处理（按同站换乘）；结构表类型优先于站 groupType
{
  const stN = V.stopList(fc(
    stopFeat('n1', '未定甲', 'l0007', '沪乍线', 0.1, 30, 30, 'nA', null),
    stopFeat('n2', '未定甲', 'l0034', '19号线', 0.1, 30, 30, 'nA', null),
    stopFeat('n3', '未定甲', 'l0051', '奉贤线', 0.1, 30, 30, 'nA', null),
    stopFeat('n4', '怪类', 'l0054', '机场快线', 0.1, 31, 31, 'nB', 'weird'),
    stopFeat('n5', '怪类', 'l0057', '嘉青松金线', 0.1, 31, 31, 'nB', 'weird'),
    stopFeat('n6', '表定', 'l0022', '8号线', 0.1, 32, 32, 'nC', 'same-station'),
  ));
  const trN = V.buildGroupTree([{ id: 'nA', type: null, stops: ['n1', 'n2', 'n3'], groups: [] }, { id: 'nC', type: 'junction', stops: ['n6'], groups: [] }], stN);
  const svN = V.buildStopView(stN, { linesMap: lmNx, lineGroups: lgNx, tree: trN });
  eq([svN.pills.map((p) => p.groupId), svN.pills[0].pin.groupType, svN.pins.map((p) => [p.key, p.big])],
    [['nA'], 'same-station', [['g:nB', true], ['g:nC', false]]],
    'type null／未知 → 按同站换乘（三线出药丸、两线出大圈）；结构表类型优先于站 groupType（nC 站写 same-station、表定 junction → junction 圈）');
}

// ⑤ 药丸线数口径：按逻辑线去重——联络线不计；同一有效线组算一条；其余各算一条
const lmCnt = V.normalizeLines(fc(
  lineFeat('cm', 0, 'future', [[0, 0], [1, 0]], { name: '主线甲', role: 'main', groupId: 'lgC' }),
  lineFeat('cb', 0, 'future', [[0, 0], [0, 1]], { name: '支线甲', role: 'branch', groupId: 'lgC' }),
  lineFeat('cd', 0, 'future', [[0, 0], [1, 1]], { name: '独立乙', role: 'standalone' }),
  lineFeat('ce', 0, 'future', [[0, 0], [2, 1]], { name: '独立丙', role: 'standalone' }),
  lineFeat('ch', 0, 'future', [[0, 0], [3, 1]], { name: '独立己', role: 'standalone' }),
  lineFeat('cf', 0, 'future', [[0, 0], [4, 1]], { name: '联络丁', role: 'connector' }),
  lineFeat('cg', 0, 'future', [[0, 0], [5, 1]], { name: '联络戊', role: 'connector' }),
  lineFeat('x1', 0, 'future', [[0, 0], [6, 1]], { name: '无主组员甲', role: 'standalone', groupId: 'lgX' }),   // 无 main 的线组（不归并）
  lineFeat('x2', 0, 'future', [[0, 0], [7, 1]], { name: '无主组员乙', role: 'branch', groupId: 'lgX' }),
));
const lgCnt = V.buildLineGroups(lmCnt, [{ id: 'lgC', name: '主线甲', members: ['cm', 'cb'] }, { id: 'lgX', name: '坏组', members: ['x1', 'x2'] }]);
console.log('logical line count:');
eq(V.logicalLineCount(['cm', 'cb', 'cd'], lmCnt, lgCnt), 2, '⑤ 主线＋支线＋另一线＝2（支线算一条）');
eq(V.logicalLineCount(['cd', 'ce', 'ch'], lmCnt, lgCnt), 3, '⑤ 三条互不隶属的线＝3');
eq(V.logicalLineCount(['cd', 'ce', 'cf'], lmCnt, lgCnt), 2, '⑤ 联络线不计（三线含一联络线＝2）');
eq(V.logicalLineCount(['cf', 'cg'], lmCnt, lgCnt), 0, '⑤ 全是联络线＝0');
eq(V.logicalLineCount(['cm', 'cb'], lmCnt, lgCnt), 1, '⑤ 只有一条逻辑线（同一线组）＝1');
eq(V.logicalLineCount(['cm', 'cb', 'cd'], lmCnt, null), 3, '⑤ 不传 lineGroups＝不归并（各自一条）');
eq(V.logicalLineCount(['cd', 'ce', 'cf'], null, lgCnt), 3, '⑤ 不传 linesMap＝角色未知，联络线照计（旧行为）');
eq(V.logicalLineCount(['cd', 'ce', 'zz'], lmCnt, lgCnt), 3, '⑤ 线不在 linesMap（孤站）＝按独立一条计');
eq(V.logicalLineCount(['x1', 'x2', 'cd'], lmCnt, lgCnt), 3, '⑤ 无 main 的线组不归并（各算一条）');
eq([V.logicalLineCount([], lmCnt, lgCnt), V.logicalLineCount(['cd', 'cd', null, ''], lmCnt, lgCnt), V.logicalLineCount(null, lmCnt, lgCnt)], [0, 1, 0], '⑤ 空/重复/脏输入');
const cntStops = V.stopList(fc(
  stopFeat('cm-s1', '汇甲', 'cm', '主线甲', 0.5, 1, 1, 'kA', 'same-station'),
  stopFeat('cb-s1', '汇甲', 'cb', '支线甲', 0.5, 1, 1, 'kA', 'same-station'),
  stopFeat('cd-s1', '汇甲', 'cd', '独立乙', 0.5, 1, 1, 'kA', 'same-station'),     // kA＝主线＋支线＋另一线 → 2
  stopFeat('cd-s2', '汇乙', 'cd', '独立乙', 0.6, 2, 2, 'kB', 'same-station'),
  stopFeat('ce-s1', '汇乙', 'ce', '独立丙', 0.6, 2, 2, 'kB', 'same-station'),
  stopFeat('cf-s1', '汇乙', 'cf', '联络丁', 0.6, 2, 2, 'kB', 'same-station'),     // kB＝两独立线＋联络线 → 2
  stopFeat('cd-s3', '汇丙', 'cd', '独立乙', 0.7, 3, 3, 'kC', 'same-station'),
  stopFeat('ce-s2', '汇丙', 'ce', '独立丙', 0.7, 3, 3, 'kC', 'same-station'),
  stopFeat('ch-s1', '汇丙', 'ch', '独立己', 0.7, 3, 3, 'kC', 'same-station'),     // kC＝三条互不隶属 → 3
  stopFeat('cf-s2', '汇丁', 'cf', '联络丁', 0.8, 4, 4, 'kD', 'same-station'),
  stopFeat('cg-s1', '汇丁', 'cg', '联络戊', 0.8, 4, 4, 'kD', 'same-station'),     // kD＝全是联络线 → 0
  stopFeat('cm-s2', '汇戊', 'cm', '主线甲', 0.9, 5, 5, 'kE', 'same-station'),
  stopFeat('cb-s2', '汇戊', 'cb', '支线甲', 0.9, 5, 5, 'kE', 'same-station'),     // kE＝同一线组 → 1
));
const svCnt = V.buildStopView(cntStops, { linesMap: lmCnt, lineGroups: lgCnt });
eq(svCnt.pills.map((p) => p.groupId), ['kC'], '⑤ 只有「三条互不隶属的线」出药丸');
eq(svCnt.pins.filter((p) => p.kind === 'group').map((p) => p.groupId), ['kA', 'kB', 'kD', 'kE'], '⑤ 主线＋支线＋另一线／含联络线／全是联络线／只有一条逻辑线 → 一律合并黑边大圈');
ok(svCnt.pins.filter((p) => p.kind === 'group').every((p) => p.big === true && p.groupType === 'same-station'), '⑤ 大圈 pin 的 big/groupType');
eq(svCnt.pins.find((p) => p.groupId === 'kB').lineIds, ['cd', 'ce', 'cf'], '⑤ 大圈 pin.lineIds 仍收全部成员线（含联络线）');
eq(svCnt.labels.find((l) => l.key === 'g:kA').lineIds, ['cm', 'cb', 'cd'], '⑤ 标签 lineIds 同口径（含支线）');
// 口径适用于一切同站单元（含不嵌套的普通同站组）：不传 linesMap 的旧调用对同一夹具仍按 distinct 计
eq(V.buildStopView(cntStops).pills.map((p) => p.groupId), ['kA', 'kB', 'kC'], '⑤ 对照：旧调用（无 linesMap）按 distinct lineId 计 → kA/kB 也出药丸（旧行为，仅旧产物路径）');

// ⑥ 防御：未知子组 id、无站组、成环、自指、多父、表外组、脏条目——不死循环、不抛错
const stD = V.stopList(fc(
  stopFeat('d1', '环甲', 'cd', '独立乙', 0.1, 0, 0, 'cA', 'out-of-station'),
  stopFeat('d2', '环乙', 'cd', '独立乙', 0.2, 1, 0, 'cB', 'out-of-station'),
  stopFeat('d3', '环丙', 'cd', '独立乙', 0.3, 2, 0, 'cC', 'out-of-station'),
  stopFeat('d4', '环尾', 'cd', '独立乙', 0.4, 3, 0, 'rX', 'same-station'),
  stopFeat('d5', '多父子', 'cd', '独立乙', 0.5, 4, 0, 'mC', 'same-station'),
  stopFeat('d6', '自指', 'cd', '独立乙', 0.6, 5, 0, 'sS', 'same-station'),
  stopFeat('d7', '表外组', 'cd', '独立乙', 0.7, 6, 0, 'uG', 'junction'),
  stopFeat('d8', '幽灵父', 'cd', '独立乙', 0.8, 7, 0, 'gP', 'out-of-station'),
));
const dirtyTable = [
  { id: 'cA', type: 'out-of-station', stops: ['d1'], groups: ['cB', 'rX'] },
  { id: 'cB', type: 'out-of-station', stops: ['d2'], groups: ['cC'] },
  { id: 'cC', type: 'out-of-station', stops: ['d3'], groups: ['cA'] },      // 三环 cA→cB→cC→cA；rX 挂环上（rho 形）
  { id: 'rX', type: 'same-station', stops: ['d4'], groups: [] },
  { id: 'mP1', type: 'out-of-station', stops: [], groups: ['mC'] },         // 多父：mC 同时被 mP1/mP2 声明
  { id: 'mP2', type: 'out-of-station', stops: [], groups: ['mC'] },
  { id: 'mC', type: 'same-station', stops: ['d5'], groups: [] },
  { id: 'sS', type: 'same-station', stops: ['d6'], groups: ['sS'] },        // 自指
  { id: 'gP', type: 'out-of-station', stops: ['d8'], groups: ['ghost'] },   // 未知子组 id（表里没有、也无站指向）
  { id: 'empty', type: 'junction', stops: [], groups: [] },                  // 无站组
];
const treeD = V.buildGroupTree(dirtyTable, stD);
eq([treeD.rootOf('cA'), treeD.rootOf('cB'), treeD.rootOf('cC'), treeD.rootOf('rX')], ['cA', 'cA', 'cA', 'cA'], '⑥ 三环取环上 id 最小者当根');
eq(treeD.subtreeIds('cA'), ['cA', 'cB', 'cC', 'rX'], '⑥ 环上子树遍历每组至多一次');
eq([treeD.parentOf('mC'), treeD.childrenOf('mP1'), treeD.childrenOf('mP2')], ['mP1', ['mC'], []], '⑥ 多父取表序首个声明它的父；另一父的子组表不含它');
eq([treeD.parentOf('sS'), treeD.childrenOf('sS')], [null, []], '⑥ 自指忽略');
eq([treeD.typeOf('uG'), treeD.parentOf('uG'), treeD.rootOf('uG'), treeD.group('ghost') !== null], ['junction', null, 'uG', true],
  '⑥ 站指向了、表里却没有的组＝合成顶层组（站点不丢）；未知子组 id 也可查（空记录）');
const svD = V.buildStopView(stD, { linesMap: lmCnt, lineGroups: lgCnt, tree: treeD });
//（次序＝稳定序：节点按「子树首个叶站的站表下标」排——mP1 自身无站、随其子组 mC 的叶站排在 sS 之前）
eq(svD.pins.map((p) => p.key), ['d1', 'd2', 'd3', 'g:rX', 'g:mC', 'g:sS', 'g:uG', 'd8'], '⑥ 成环/多父/自指/表外组：每站每单元只出一次，不死循环不抛错');
eq(svD.labels.map((l) => l.key), ['g:cA', 'g:cB', 'g:cC', 'g:rX', 'g:mC', 'g:sS', 'g:uG', 'g:gP'], '⑥ 标签同上（无直属站的出闸单元 mP1/mP2、无站组 empty 不出标签）');
ok(!svD.pins.some((p) => p.groupId === 'empty') && !svD.pills.length, '⑥ 无站组不出任何图形');
ok(V.groupRelations('gP', true, treeD, lmCnt, lgCnt) === null, '⑥ 幽灵子组不出现在关系描述里（视同无嵌套）');
// 同站环：环上全部叶站合成一个符号
{
  const stS = V.stopList(fc(
    stopFeat('q1', '同站环甲', 'cd', '独立乙', 0.1, 0, 0, 'sA', 'same-station'),
    stopFeat('q2', '同站环乙', 'ce', '独立丙', 0.1, 1, 0, 'sB', 'same-station'),
  ));
  const svS = V.buildStopView(stS, { linesMap: lmCnt, lineGroups: lgCnt, tree: V.buildGroupTree([
    { id: 'sA', type: 'same-station', stops: ['q1'], groups: ['sB'] }, { id: 'sB', type: 'same-station', stops: ['q2'], groups: ['sA'] }], stS) });
  eq([svS.pins.map((p) => p.key), svS.labels.map((l) => l.key), svS.pills.map((p) => [p.key, p.chain.length, p.pin.lineIds.join(',')])],
    [[], ['g:sA'], [['g:sA', 2, 'cd,ce']]], '⑥ 同站成环：环上 id 最小者为根＝上级组 → 一个药丸、一个标签（叶站不丢不重）');
}
// 脏结构表条目：逐项判型跳过、不抛；重复 id 首条为准
{
  const trDirty = V.buildGroupTree([
    null, 5, 'x', [], { id: null }, { id: '' },                                              // 非对象/无 id/空 id
    { id: 'dQ', type: 7, groups: 'zz', stops: 'not-array' },                                  // 类型非字符串、groups/stops 非数组
    { id: 'cA', type: 'out-of-station', stops: ['d1'], groups: ['cB'] },
    { id: 'cA', type: 'junction' },                                                          // 重复 id
  ].concat(dirtyTable.slice(1)), stD);
  eq([trDirty.typeOf('dQ'), trDirty.typeOf('cA'), trDirty.childrenOf('dQ'), trDirty.rootOf('dQ')], ['same-station', 'out-of-station', [], 'dQ'],
    '⑥ 脏条目逐项跳过不抛（未知类型按同站、非数组 groups 按缺省）；重复 id 首条为准');
  eq(V.buildGroupTree(null, stD).order.length, new Set(stD.filter((s) => s.groupId).map((s) => s.groupId)).size, '无结构表（null）＝按站的直属组合成平铺组');
  eq(V.buildGroupTree('bad', stD).group('cA').type, 'out-of-station', '结构表非数组＝按无表处理（类型取站 groupType）');
}

// 嵌套关系描述（信息面板用）：中华艺术宫＝「出闸换乘」关系的两端是 8 号线与「同站换乘：19号线、奉贤线、机场快线」这一组
console.log('group relations:');
eq(V.groupRelations('g9003', true, treeNx, lmNx, lgNx),
  { nodeChain: '出闸换乘（组 g9003）', nodeMembers: '', partners: '同站换乘：19号线、奉贤线、机场快线' },
  '面板·点 8 号线直属站：换乘对端＝「同站换乘：19号线、奉贤线、机场快线」（既有类型名，不新造术语）');
eq(V.groupRelations('g9004', false, treeNx, lmNx, lgNx),
  { nodeChain: '出闸换乘（组 g9003）', nodeMembers: '', partners: '中华艺术宫（8号线）' },
  '面板·点内层药丸：换乘节点＝上级出闸组；换乘对端＝8 号线直属站');
eq(V.groupRelations('g9001', false, treeNx, lmNx, lgNx),
  { nodeChain: '', nodeMembers: '中辰路（嘉松路线）；接轨站：松江快线', partners: '' },
  '面板·点中辰路合并圈：节点成员＝直属站＋子组（主支线显示组名并去重）');
eq(V.groupRelations('g9002', false, treeNx, lmNx, lgNx),
  { nodeChain: '', nodeMembers: '上海金山（嘉青松金线）；接轨站：沪乍线、金铁-金山站联络线', partners: '' },
  '面板·点上海金山合并圈：节点成员含联络线子组（描述里联络线照列，线数口径只管画法）');
eq(V.groupRelations('g0148', false, treeNx, lmNx, lgNx), { nodeChain: '同站换乘（组 g9001）', nodeMembers: '', partners: '' },
  '关系描述对内层组：上级链到节点为止（内层组无独立 pin，此路径界面不可达，仅证不抛）');
ok(V.groupRelations('g9001', false, V.buildGroupTree(nxTable.map((g) => Object.assign({}, g, { groups: [] })), stNx), lmNx, lgNx) === null,
  '平铺组返回 null（面板一行不加＝与旧版一致）');
eq(V.groupRelations('g9003', false, treeNx, lmNx, lgNx),
  { nodeChain: '', nodeMembers: '中华艺术宫（8号线）；同站换乘：19号线、奉贤线、机场快线', partners: '' },
  '关系描述对出闸节点本身的组 pin 视角＝节点成员（界面不可达：出闸单元没有组 pin，仅证不抛）');
ok(V.groupRelations(null, false, treeNx, lmNx, lgNx) === null && V.groupRelations('g9001', false, null, lmNx, lgNx) === null
  && V.groupRelations('nope', false, treeNx, lmNx, lgNx) === null && V.groupRelations('g9001', false, {}, lmNx, lgNx) === null,
  '无组/无树/非树对象/未知组 → null');
eq(V.groupRelations('g9004', false, treeNx, null, null),
  { nodeChain: '出闸换乘（组 g9003）', nodeMembers: '', partners: '中华艺术宫（8号线）' },
  '不传 linesMap/lineGroups：线路显示名退线名/线 id，文案结构不变');
// 多成员出闸（直属站两条线＋两个子组）：对端全列
{
  const stM = V.stopList(fc(
    stopFeat('m1', '闸西', 'l0022', '8号线', 0.1, 40, 40, 'mA', 'out-of-station'),
    stopFeat('m2', '闸西', 'l0007', '沪乍线', 0.1, 40, 40, 'mA', 'out-of-station'),
    stopFeat('m3', '闸东', 'l0034', '19号线', 0.1, 40.01, 40, 'mB', 'same-station'),
    stopFeat('m4', '闸东', 'l0051', '奉贤线', 0.1, 40.01, 40, 'mB', 'same-station'),
    stopFeat('m5', '闸北', 'l0054', '机场快线', 0.1, 40, 40.01, 'mC', 'junction'),
  ));
  const trM = V.buildGroupTree([
    { id: 'mA', type: 'out-of-station', stops: ['m1', 'm2'], groups: ['mB', 'mC'] },
    { id: 'mB', type: 'same-station', stops: ['m3', 'm4'], groups: [] },
    { id: 'mC', type: 'junction', stops: ['m5'], groups: [] }], stM);
  eq(V.groupRelations('mA', true, trM, lmNx, lgNx),
    { nodeChain: '出闸换乘（组 mA）', nodeMembers: '', partners: '同站换乘：19号线、奉贤线；接轨站：机场快线' },
    '多成员出闸·直属站视角：对端＝各子组（同单元其余直属站走既有「组内车站」行不重复）');
  eq(V.groupRelations('mB', false, trM, lmNx, lgNx),
    { nodeChain: '出闸换乘（组 mA）', nodeMembers: '', partners: '闸西（8号线）、闸西（沪乍线）；接轨站：机场快线' },
    '多成员出闸·子组视角：对端＝上级的直属站＋其余兄弟子组');
}

// 单线导出补注：仅嵌套节点的站补节点信息；平铺组/不传 tree＝旧版输出
{
  const gjNx = V.buildLineGeoJSON('l0034', lmNx, stNx, treeNx);
  eq(gjNx.features[1].properties, { sid: 'l0034-s16', name: '中华艺术宫', lineId: 'l0034', t: 0.5, groupId: 'g9004', groupType: 'same-station', nodeGroupId: 'g9003', nodeGroupType: 'out-of-station' },
    '导出 GeoJSON：嵌套节点的站补 nodeGroupId/nodeGroupType（直属组两键不变）');
  ok(!('nodeGroupId' in V.buildLineGeoJSON('l0034', lmNx, stNx).features[1].properties), '导出 GeoJSON：不传 tree＝旧版输出（无补键）');
  ok(!('nodeGroupId' in V.buildLineGeoJSON('l0034', lmNx, stNx, V.buildGroupTree(nxTable.map((g) => Object.assign({}, g, { groups: [] })), stNx)).features[1].properties),
    '导出 GeoJSON：平铺组传 tree 也不补键');
  ok(V.buildLineKML('l0034', lmNx, stNx, { tree: treeNx })
    .includes('<description>' + V.xmlEscape('所属：19号线；同站换乘；换乘节点：出闸换乘（组 g9003）') + '</description>'), '导出 KML：描述追加「换乘节点：类型（组 id）」');
  ok(!V.buildLineKML('l0034', lmNx, stNx).includes('换乘节点'), '导出 KML：不传 tree＝旧版输出');
  eq(V.buildLineGeoJSON('nope', lmNx, stNx, treeNx), null, '导出：未知线路照旧 null');
}

// ---------- parseLineInfo（lineinfo.md 线路手填介绍，2026-11-23） ----------
console.log('parseLineInfo:');
// 空文件/非字符串 → 空表（查看器一切线组无信息节，不报错）
eq(V.parseLineInfo(''), {}, '空文件 → 空表');
eq(V.parseLineInfo(null), {}, 'null → 空表');
eq(V.parseLineInfo(42), {}, '非字符串 → 空表');
eq(V.parseLineInfo('首个标题之前的散行不绑定任何组\n\n随便写'), {}, '标题前散行忽略');
// 多组＋字段区＋正文＋相关链接节（手造 fixture）
const liMd = [
  '## lg01 1号线',
  '起讫点: A — B',
  '编组: 6A',
  '全角冒号：也收',
  '',
  '这是 **正文第一段**，含链接 [官网](https://example.com/a?x=1&y=2)。',
  '段内第二行',
  '',
  '- 项目一',
  '- 项目二 *斜体*',
  '',
  '### 相关链接',
  '[线路图](https://example.com/map)',
  '[相对路径](docs/intro.html)',
  '',
  '## lg02 2号线',
  '仅字段: 无正文',
  '',
].join('\n');
const li = V.parseLineInfo(liMd);
eq(Object.keys(li), ['lg01', 'lg02'], '多组按标题序');
eq(li.lg01.fields, [['起讫点', 'A — B'], ['编组', '6A'], ['全角冒号', '也收']], '字段区按原序、半/全角冒号均可');
ok(li.lg01.bodyHtml.indexOf('<strong>正文第一段</strong>') >= 0, '粗体 **x** → <strong>');
ok(li.lg01.bodyHtml.indexOf('<em>斜体</em>') >= 0, '斜体 *x* → <em>');
ok(li.lg01.bodyHtml.indexOf('<a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">官网</a>') >= 0,
  '链接 href 经转义（&→&amp;）＋新窗安全属性');
ok(li.lg01.bodyHtml.indexOf('<br>') >= 0, '段内换行 → <br>');
ok(li.lg01.bodyHtml.indexOf('<ul><li>项目一</li><li>项目二 <em>斜体</em></li></ul>') >= 0, '无序列表（- 开头连续行）');
eq(li.lg01.links, [{ text: '线路图', url: 'https://example.com/map' }, { text: '相对路径', url: 'docs/intro.html' }],
  '相关链接节逐行收 md 链接');
eq(li.lg02.fields, [['仅字段', '无正文']], '缺字段行不炸');
eq(li.lg02.bodyHtml, '', '无正文 → 空 bodyHtml');
eq(li.lg02.links, [], '无链接节 → 空 links');
// 只有标题、什么都没写 → 表中省去（＝查看器无痕）
eq(V.parseLineInfo('## g0 空组\n').g0, undefined, '空组（只有标题）从表中省去');
// 没写的线组：表中无该键（lg03 未写 → undefined，查看器不显示信息节）
ok(!('lg03' in li), '没写的线组无键');
// 转义：script/标签注入只落成文字；正文内恶意 URL 链接退纯文字
const liEsc = V.parseLineInfo([
  '## gx 组',
  '键: <script>alert(1)</script>',
  '',
  '正文 <img src=x onerror=alert(2)> 与 [坏](javascript:alert(3)) 与 [也坏](data:text/html,1) 结束',
].join('\n'));
ok(!/<(script|img|a\b|em|strong)/i.test(liEsc.gx.bodyHtml), '正文无任何未转义标签（script/img 注入失败）');
ok(liEsc.gx.bodyHtml.indexOf('&lt;img src=x onerror=alert(2)&gt;') >= 0,
  '注入文本转义后保留（不丢字；字段里的 <script> 存原文进 fields）');
ok(liEsc.gx.bodyHtml.indexOf('<a ') < 0 && liEsc.gx.bodyHtml.indexOf('坏') >= 0
  && liEsc.gx.bodyHtml.indexOf('也坏') >= 0,
  '恶意 URL：不渲染 <a>，链接文字保留');
eq(liEsc.gx.fields, [['键', '<script>alert(1)</script>']], 'fields 存原文（渲染侧 textContent，不预转义）');
// safeLinkUrl 白名单：http/https/相对路径放行，其余带 scheme 一律拒
eq(V.safeLinkUrl('https://例.example/路?一=二'), 'https://例.example/路?一=二', 'https 放行（含中文与查询串）');
eq(V.safeLinkUrl('HTTP://X.EXAMPLE'), 'HTTP://X.EXAMPLE', 'http 大写放行（大小写不敏感）');
eq(V.safeLinkUrl('docs/intro.html'), 'docs/intro.html', '相对路径放行');
eq(V.safeLinkUrl('/root.html'), '/root.html', '根相对放行');
eq(V.safeLinkUrl('//cdn.example/x'), '//cdn.example/x', '协议相对放行');
eq(V.safeLinkUrl('#sec'), '#sec', '纯锚点放行');
eq(V.safeLinkUrl('javascript:alert(1)'), null, 'javascript: 拒绝');
eq(V.safeLinkUrl(' data:text/html,<b>x</b> '), null, 'data: 拒绝（含首尾空白）');
eq(V.safeLinkUrl('vbscript:x'), null, 'vbscript: 拒绝');
eq(V.safeLinkUrl('mailto:a@b.c'), null, 'mailto: 拒绝');
eq(V.safeLinkUrl(''), null, '空串拒绝');
// 相关链接节：恶意 URL 与非链接行整行剔除；未知三级节按正文处理（不吞后续链接节）
const liSec = V.parseLineInfo([
  '## gs 组',
  '',
  '正文一',
  '',
  '### 运营时间（未来扩展位）',
  '### 相关链接',
  '[坏](javascript:alert(1))',
  '非链接行',
  '[好](https://ok.example)',
].join('\n'));
ok(liSec.gs.bodyHtml.indexOf('运营时间') >= 0 && liSec.gs.bodyHtml.indexOf('<h') < 0,
  '未知三级节按正文处理（标题行当正文文字）');
eq(liSec.gs.links, [{ text: '好', url: 'https://ok.example' }], '链接节：坏 URL/非链接行剔除、好链接保留');
// 字段区不成形的行按正文收（不丢字）
const liMix = V.parseLineInfo('## gm 组\n键: 值\n不成形的一行\n\n正文\n');
eq(liMix.gm.fields, [['键', '值']], '字段区成形行照收');
ok(liMix.gm.bodyHtml.indexOf('不成形的一行') >= 0, '字段区不成形行落正文（不丢字）');
// 同 id 多节：后者覆盖（重写时以新为准）
const liDup = V.parseLineInfo('## d1 A\nk: 1\n\n## d1 B\nk: 2\n');
eq(liDup.d1.fields, [['k', '2']], '同 id 多节后者覆盖');

// ---------- lineInfoEntryOf（节绑定 id 解析：线组 id 优先、线 id 兜底；2026-11-23 放宽） ----------
console.log('lineInfoEntryOf:');
const lim = new Map([
  ['l1', { lineId: 'l1', name: '1号线', role: 'main', aliases: [] }],
  ['l2', { lineId: 'l2', name: '2号线支线', role: 'branch', aliases: [] }],
  ['l3', { lineId: 'l3', name: '', role: 'standalone', aliases: [] }],
]);
const lig = V.buildLineGroups(lim, [{ id: 'lg01', name: '1号线', mainId: 'l1', members: ['l1', 'l2'] }]);
const lix = {
  lg01: { fields: [['编组', '6A']], bodyHtml: '<p>正文</p>', links: [] },
  l3: { fields: [], bodyHtml: '<p>单线介绍</p>', links: [] },
};
// 有组线：组节存在 → 绑组 id（节题＝组名）
eq(V.lineInfoEntryOf('l1', lim, lig, lix), { id: 'lg01', name: '1号线' }, '有组线 → 组 id 优先（节题＝组名）');
eq(V.lineInfoEntryOf('l2', lim, lig, lix), { id: 'lg01', name: '1号线' }, '组内支线同样解析到组 id');
// 组节缺失、线节存在 → 兜底到线自身 id（节题＝线名）
eq(V.lineInfoEntryOf('l2', lim, lig, { l2: { fields: [['k', 'v']], bodyHtml: '', links: [] } }),
  { id: 'l2', name: '2号线支线' }, '组无节 → 兜底线自身 id（节题＝线名）');
// 组节全空（只有标题）：按无节处理（与 appendLineInfo 显示判据同口径）→ 落线节
eq(V.lineInfoEntryOf('l1', lim, lig, { lg01: { fields: [], bodyHtml: '', links: [] }, l1: { fields: [['k', 'v']], bodyHtml: '', links: [] } }),
  { id: 'l1', name: '1号线' }, '组节全空 → 按无节落线节');
// 无组线：直接按线 id 命中（没建组的单线也能显示介绍；无名线节题退线 id）
eq(V.lineInfoEntryOf('l3', lim, lig, lix), { id: 'l3', name: 'l3' }, '无组线 → 线 id 命中，无名退线 id');
// 两处都无节 → null（显示侧完全无痕；l1 的组节在 lix 里存在 → 组命中，见上）
eq(V.lineInfoEntryOf('l1', lim, lig, { l3: lix.l3 }), null, '组与线都无节 → null');
// 无组结构（旧快照 @1＝buildLineGroups 空表）：线 id 直查
const ligEmpty = V.buildLineGroups(lim, []);
eq(V.lineInfoEntryOf('l1', lim, ligEmpty, { l1: { fields: [['a', 'b']], bodyHtml: '', links: [] } }),
  { id: 'l1', name: '1号线' }, '无组结构 → 线 id 直查');
// 防御：空 id／lineInfo 缺失 → null
eq(V.lineInfoEntryOf(null, lim, lig, lix), null, '空 id → null');
eq(V.lineInfoEntryOf('l1', lim, lig, undefined), null, 'lineInfo 缺失 → null');

// ---------- 地图单击聚焦（2026-11-27：isLineHitLayerId 线身层判定 / lineClickAction 点击目标分类） ----------
console.log('isLineHitLayerId / lineClickAction:');
// 线身层：静态两层＋罩上重画/他省接管层＋动态渐变层族（含分期拆段 -seg- 变体）
for (const id of ['lines', 'lines-dash', 'lines-displayonly', 'focus-copy', 'focus-copy-dash',
  'arrow-fade-l1', 'arrow-fade-seg-l1-0', 'conn-blend-l9', 'conn-blend-seg-l9-2', 'conn-fade-l9']) {
  ok(V.isLineHitLayerId(id), `线身层 ${id} 判真`);
}
// 非线身层：站圈/药丸/省界/白罩/底图（点车站/空白无操作——demo 裁定）
for (const id of ['stops', 'stops-dark', 'stops-big', 'pills-outer', 'pills-inner',
  'stops-focus', 'pills-inner-focus', 'provinces', 'focus-veil', 'basemap-veil', 'bg', '']) {
  ok(!V.isLineHitLayerId(id), `非线身层 ${id || '(空)'} 判假`);
}
ok(!V.isLineHitLayerId(undefined) && !V.isLineHitLayerId(null) && !V.isLineHitLayerId(123), '非字符串输入判假（防御）');
// 点击目标分类：普通本地线 focus；联络线（类别名或 connects）与他省线 silent；null 防御
const mkLine = (o) => Object.assign({ lineId: 'x', name: 'x', layer: '', connects: [], segments: [] }, o);
eq(V.lineClickAction(mkLine({ layer: '市区线' })), 'focus', '市区线 → focus');
eq(V.lineClickAction(mkLine({ layer: '市域线' })), 'focus', '市域线 → focus');
eq(V.lineClickAction(mkLine({ layer: '预控通道' })), 'focus', '预控通道 → focus（虚线身份不影响可聚焦）');
eq(V.lineClickAction(mkLine({ layer: '联络线' })), 'silent', '联络线（类别名命中）→ silent');
eq(V.lineClickAction(mkLine({ connects: ['a', 'b'] })), 'silent', '带 connects 结构字段 → silent');
eq(V.lineClickAction(mkLine({ connects: ['a'] })), 'silent', 'connects 单元素也是联络线 → silent');
// 真机「单击无反应」根因回归：flatten 键齐输出使一切线带 connects 空数组（normalizeLines
// 保留键），旧轻提示版按 Array.isArray 判 → 空数组也命中 → 所有线静默。必须判非空。
eq(V.lineClickAction(mkLine({ layer: '市区线', connects: [] })), 'focus', 'connects 空数组（flatten 键齐常态）→ focus（2026-11-26 真机 bug 回归）');
eq(V.lineClickAction(mkLine({ layer: '市域线', connects: null })), 'focus', 'connects 缺失/null → focus');
eq(V.lineClickAction(mkLine({ layer: '他省' })), 'silent', '他省线 → silent（纯背景既定裁定）');
eq(V.lineClickAction(mkLine({ layer: '他省线' })), 'focus', '不在 DISPLAY_ONLY_LAYERS 的名字按普通线（名单精确匹配的边界）');
eq(V.lineClickAction(null), 'silent', 'null → silent（防御）');

// ---------- 聚焦取景 bbox（2026-11-27 真机病灶①：聚焦绑定联络线并入取景） ----------
console.log('focusBboxOf:');
{
  // 东西联络线病灶的抽象化：聚焦线本体 bbox ＋西延联络线，取景须含联络线几何
  const bb = new Map([
    ['l50', [121.22, 30.99, 121.78, 31.12]],           // 聚焦线本体（东西向）
    ['l87', [121.18, 30.98, 121.22, 31.00]],           // 西衔嘉青松金线的联络线（西延出本体）
    ['l88', [121.35, 31.02, 121.36, 31.04]],           // 东侧联络线（在本体范围内）
    ['l57', [121.05, 30.95, 121.19, 31.05]],           // 嘉青松金线（未绑定——不进 fadeConnPlan）
  ]);
  const lgNone = V.buildLineGroups(new Map(), []);
  // 单线无组＋fade 绑定联络线：bbox 并入 l87（西界扩到 121.18）与 l88（已在范围内，无副作用）
  eq(V.focusBboxOf(bb, lgNone, 'l50', [{ lineId: 'l87', attachEnd: 0 }, { lineId: 'l88', attachEnd: 1 }]),
    [121.18, 30.98, 121.78, 31.12], '聚焦绑定联络线几何并入取景（东西联络线病灶回归：西衔联络线不再出画）');
  // fadeConnPlan 空 → 只线本体（原行为）
  eq(V.focusBboxOf(bb, lgNone, 'l50', []), [121.22, 30.99, 121.78, 31.12], '无绑定联络线 → 只线本体 bbox');
  eq(V.focusBboxOf(bb, lgNone, 'l50', null), [121.22, 30.99, 121.78, 31.12], 'fadeConnPlan 未传 → 只线本体 bbox');
  // 未绑定的联络线（conn-blend 常驻背景）不并入
  eq(V.focusBboxOf(bb, lgNone, 'l50', [{ lineId: 'l87', attachEnd: 0 }])[0], 121.18, '绑定即并入');
  // 组路径：成员联合（支线也是这条线的一部分）＋联络线并入
  const linesMap = new Map([
    ['l11', { lineId: 'l11', name: '主线', layer: '市域线', role: 'main', segments: [] }],
    ['l12', { lineId: 'l12', name: '支线', layer: '市域线', role: 'branch', segments: [] }],
  ]);
  const lg = V.buildLineGroups(linesMap, [{ id: 'lg01', name: '组', mainId: 'l11', members: ['l11', 'l12'] }]);
  const bb2 = new Map([
    ['l11', [121.1, 31.0, 121.5, 31.2]],
    ['l12', [121.3, 30.9, 121.6, 31.1]],
    ['l99', [121.0, 31.3, 121.2, 31.4]],               // 绑定联络线（北延出组范围）
  ]);
  eq(V.focusBboxOf(bb2, lg, 'l11', [{ lineId: 'l99', attachEnd: 0 }]),
    [121.0, 30.9, 121.6, 31.4], '组路径：成员联合 ∪ 绑定联络线（attachEnd 不影响 bbox）');
  eq(V.focusBboxOf(bb2, lg, 'l12', []), [121.1, 30.9, 121.6, 31.2], '支线 id 归一到组 bbox（setFocus 已归一，防御）');
  // 防御：null id／全缺 bbox／lineGroups 非 Map／组成员缺 bbox 跳过／空 members 退单线
  eq(V.focusBboxOf(bb2, lg, null, []), null, '空 focusId → null');
  eq(V.focusBboxOf(new Map(), lg, 'l11', [{ lineId: 'l99', attachEnd: 0 }]), null, '全体缺 bbox → null（调用方静默不跳）');
  eq(V.focusBboxOf(bb2, null, 'l11', []), [121.1, 31.0, 121.5, 31.2], 'lineGroups 缺失 → 退单线 bbox');
  const bb3 = new Map([['l11', [121.1, 31.0, 121.5, 31.2]]]);
  eq(V.focusBboxOf(bb3, lg, 'l11', [{ lineId: 'missing', attachEnd: 0 }]), [121.1, 31.0, 121.5, 31.2], '联络线缺 bbox → 跳过不炸');
  const lgEmpty = V.buildLineGroups(linesMap, [{ id: 'lg02', name: '空组', mainId: 'l11', members: [] }]);
  eq(V.focusBboxOf(bb3, lgEmpty, 'l11', []), [121.1, 31.0, 121.5, 31.2], '组 members 空 → 退单线（与 focusMembers 兜底同口径）');
  eq(V.focusBboxOf(bb3, lg, 'l11', [{ attachEnd: 0 }]), [121.1, 31.0, 121.5, 31.2], 'fadeConnPlan 脏条目（无 lineId）→ 跳过');
}

// ---------- 点击车站（2026-11-27：站圈命中层 / 站·组→自然线路集合 / 车站页数据 / 多线 bbox） ----------
console.log('isStopHitLayerId:');
// 站圈/药丸层：基础五层＋罩上复制 -focus 变体（点车站命中层，站圈优先于线身）
for (const id of ['stops', 'stops-dark', 'stops-big', 'pills-outer', 'pills-inner',
  'stops-focus', 'stops-dark-focus', 'stops-big-focus', 'pills-outer-focus', 'pills-inner-focus']) {
  ok(V.isStopHitLayerId(id), `站圈层 ${id} 判真`);
}
for (const id of ['lines', 'lines-dash', 'lines-displayonly', 'focus-copy', 'focus-copy-dash',
  'conn-blend-l1', 'conn-fade-l1', 'arrow-fade-l1', 'provinces', 'focus-veil', 'basemap-veil', 'bg', '']) {
  ok(!V.isStopHitLayerId(id), `非站圈层 ${id || '(空)'} 判假`);
}
ok(!V.isStopHitLayerId(undefined) && !V.isStopHitLayerId(null) && !V.isStopHitLayerId(123), '非字符串输入判假（防御）');

console.log('stationLinesOf / stationFocusOf:');
{
  // 夹具：l1＋l1b 建线组（主支线算一条）；lc 带 connects、lc2 类别名（联络线两种形态）；
  // lp 他省线；g1 同站组（3 自然线＋1 联络线成员→联络线剔除）；g4 出闸组（直属站×2＋
  // 同站子组 g5）；g6 同站组（本地＋他省→他省参与）；s9 单线站；s10 纯联络线站
  const linesFC = fc(
    lineFeat('l1', 0, 'existing', [[121.00, 31.00], [121.10, 31.00]], { role: 'main', groupId: 'lg1' }),
    lineFeat('l1b', 0, 'existing', [[121.05, 31.00], [121.06, 31.05]], { role: 'branch', groupId: 'lg1' }),
    lineFeat('l2', 0, 'existing', [[121.20, 31.10], [121.11, 31.01]]),
    lineFeat('l3', 0, 'future', [[121.30, 31.20], [121.12, 31.02]]),
    lineFeat('l4', 0, 'future', [[121.40, 31.00], [121.15, 31.05]]),
    lineFeat('l5', 0, 'future', [[121.50, 31.30], [121.16, 31.06]]),
    lineFeat('l6', 0, 'future', [[121.60, 31.40], [121.16, 31.06]]),
    lineFeat('l7', 0, 'future', [[121.70, 31.50], [121.17, 31.07]]),
    lineFeat('lp', 0, 'future', [[121.80, 31.60], [121.18, 31.08]], { layer: '他省' }),
    lineFeat('lc', 0, 'existing', [[121.11, 31.01], [121.20, 31.10]], { connects: ['l1', 'l2'] }),
    lineFeat('lc2', 0, 'existing', [[121.00, 31.00], [121.30, 31.20]], { layer: '联络线' }),
  );
  const linesMap = V.normalizeLines(linesFC);
  // l1 的 groupId 两方向并集：组记录 members 含 l1b、l1 自身也指 lg1（现实两种形态并存）
  const lg = V.buildLineGroups(linesMap, [{ id: 'lg1', name: '1 号线组', mainId: 'l1', members: ['l1', 'l1b'] }]);
  const stopsFC = fc(
    stopFeat('s1', '同名站', 'l1', '1号线', 0.5, 121.100, 31.000, 'g1', 'same-station'),
    stopFeat('s1b', '同名站', 'l1b', '1号线支', 0.5, 121.1001, 31.0001, 'g1', 'same-station'),
    stopFeat('s2', '同名站', 'l2', '2号线', 0.4, 121.1002, 31.0002, 'g1', 'same-station'),
    stopFeat('s3', '同名站', 'l3', '3号线', 0.6, 121.1003, 31.0003, 'g1', 'same-station'),
    stopFeat('s10b', '同名站', 'lc', '联络', 0.5, 121.1004, 31.0004, 'g1', 'same-station'),   // 组内联络线成员→剔除
    stopFeat('s20', '东站', 'l2', '2号线', 0.1, 121.200, 31.100, 'g4', 'out-of-station'),
    stopFeat('s21', '西站', 'l4', '4号线', 0.9, 121.150, 31.050, 'g4', 'out-of-station'),
    stopFeat('s22', '南站', 'l5', '5号线', 0.5, 121.160, 31.060, 'g5', 'same-station'),
    stopFeat('s23', '南站', 'l6', '6号线', 0.5, 121.1601, 31.0601, 'g5', 'same-station'),
    stopFeat('s30', '跨界站', 'l3', '3号线', 0.2, 121.120, 31.020, 'g6', 'same-station'),
    stopFeat('s31', '跨界站', 'lp', '他省线', 0.2, 121.1201, 31.0201, 'g6', 'same-station'),
    stopFeat('s9', '单线站', 'l7', '7号线', 0.5, 121.170, 31.070, null, null),
    stopFeat('s10', '联络站', 'lc', '联络', 0.5, 121.150, 31.060, null, null),   // 纯联络线站
  );
  const stops = V.stopList(stopsFC);
  const stationGroups = [
    { id: 'g1', type: 'same-station' },
    { id: 'g4', type: 'out-of-station', groups: ['g5'] },
    { id: 'g5', type: 'same-station' },
    { id: 'g6', type: 'same-station' },
    { id: 'g7', type: 'same-station' },   // 无站组（防御）
  ];
  const tree = V.buildGroupTree(stationGroups, stops);
  const view = V.buildStopView(stops, { linesMap, lineGroups: lg, tree });
  const pinByKey = new Map(view.pins.map((p) => [p.key, p]));
  for (const pill of view.pills || []) if (pill.pin) pinByKey.set(pill.pin.key, pill.pin);

  // 同站组 pin（4 成员站、3 自然线）：主支线算一条、联络线成员剔除
  const p1 = pinByKey.get('g:g1');
  ok(!!p1, 'g1 出组 pin（3 逻辑线≥3 → 药丸 pin 挂 pinByKey）');
  eq(V.stationLinesOf(p1, linesMap, lg, tree).sort(), ['l1', 'l2', 'l3'], '组 pin 线集：主支线归并＋联络线剔除');
  // 出闸成员站 pin：整个出闸单元（直属站×2＋子组 g5 两线）
  const p20 = pinByKey.get('s20');
  ok(!!p20, '出闸直属站 pin 存在');
  eq(V.stationLinesOf(p20, linesMap, lg, tree).sort(), ['l2', 'l4', 'l5', 'l6'], '出闸成员站→最外层组全部叶站的线集');
  // 子组 pin（出闸单元内的同站子组 g5）：同样整个出闸单元
  eq(V.stationLinesOf(pinByKey.get('g:g5'), linesMap, lg, tree).sort(), ['l2', 'l4', 'l5', 'l6'], '出闸子组符号→整个出闸单元线集（统一口径）');
  // 他省线参与（修正裁定）：g6 本地＋他省同组
  eq(V.stationLinesOf(pinByKey.get('g:g6'), linesMap, lg, tree).sort(), ['l3', 'lp'], '他省线进线集（修正裁定：参与）');
  // 单线站
  eq(V.stationLinesOf(pinByKey.get('s9'), linesMap, lg, tree), ['l7'], '单线站 → 本线一条');
  // 纯联络线站 → 空集（不可点）
  eq(V.stationLinesOf(pinByKey.get('s10'), linesMap, lg, tree), [], '纯联络线站 → 空（不可点）');
  // 类别名联络线（layer 命中 HIDDEN_LIST_LAYERS）同样剔除
  const pLc2 = { key: 'x-lc2', kind: 'stop', name: '联络站2', lineId: 'lc2' };
  eq(V.stationLinesOf(pLc2, linesMap, lg, tree), [], '类别名联络线（layer=联络线）→ 空');
  // 孤站（lineId 不在 linesMap）：按普通线保留（防御不丢站）
  eq(V.stationLinesOf({ key: 's-ghost', kind: 'stop', name: '鬼站', lineId: 'ghost' }, linesMap, lg, tree), ['ghost'], '孤站线不在 linesMap → 按普通线保留');
  // 无站组手工 pin → 空；空/坏输入防御
  eq(V.stationLinesOf({ key: 'g:g7', kind: 'group', groupId: 'g7' }, linesMap, lg, tree), [], '无站组 → 空');
  eq(V.stationLinesOf(null, linesMap, lg, tree), [], 'null pin → 空（防御）');
  eq(V.stationLinesOf({ key: 's9', kind: 'stop', lineId: 'l7' }, null, null, null), ['l7'], 'linesMap/lineGroups/tree 缺省 → 逐线旧行为');

  // stationFocusOf：面板数据（排序 lineOrder 优先、多名标注、memberIds 组员并集）
  const lineOrder = ['l3', 'l2', 'l1', 'l4', 'l5', 'l6', 'l7', 'lp'];
  const st1 = V.stationFocusOf(p1, linesMap, lg, tree, lineOrder);
  ok(!!st1, '组 pin stationFocusOf 非空');
  eq(st1.lines.map((l) => l.mainId), ['l3', 'l2', 'l1'], 'lineOrder 自定义序（l1 组行以主线 id 参与排序）');
  eq(st1.lines.map((l) => l.name), ['l3名', 'l2名', '1 号线组'], '行名＝组名优先（l1 显示线组名）');
  eq(st1.lines.map((l) => l.color), [linesMap.get('l3').color, linesMap.get('l2').color, linesMap.get('l1').color], '行色＝主线色');
  eq(st1.lines[2].members, ['l1', 'l1b'], '行 members＝线组成员（渲染高亮用）');
  eq(st1.memberIds, ['l3', 'l2', 'l1', 'l1b'], 'memberIds＝各线组成员并集（l1b 计入）');
  eq(st1.multiName, false, '同名站（全部叫法一个名）→ 不标注');
  eq(st1.lines.map((l) => l.calls), [['同名站'], ['同名站'], ['同名站']], 'calls＝成员站名去重（单名站也收，标注开关在 multiName）');
  eq(st1.name, '同名站', '站名＝pin.name（首个非空叶站名）');
  eq([st1.lon, st1.lat], [p1.lon, p1.lat], '坐标透传 pin（组均值）');

  // 出闸单元（一站多名）：multiName=true、各行 calls 各取其成员站名
  const st20 = V.stationFocusOf(pinByKey.get('s20'), linesMap, lg, tree, null);
  ok(!!st20, '出闸成员站 stationFocusOf 非空');
  eq(st20.lines.map((l) => l.mainId).sort(), ['l2', 'l4', 'l5', 'l6'], '出闸单元四条自然线');
  eq(st20.multiName, true, '一站多名（东站/西站/南站）→ 标注开启');
  const callsOf = {};
  for (const l of st20.lines) callsOf[l.mainId] = l.calls;
  eq(callsOf['l2'], ['东站'], 'l2 叫法＝其成员站名');
  eq(callsOf['l4'], ['西站'], 'l4 叫法');
  eq(callsOf['l5'], ['南站'], 'l5（与 l6 同名子组）叫法＝子组成员站名');
  // 无 lineOrder：tie-break lineId 升序
  eq(st20.lines.map((l) => l.mainId), ['l2', 'l4', 'l5', 'l6'], '无 lineOrder → lineId 升序');
  // 纯联络线站 → null（搜索入口退旧行为的判定）
  eq(V.stationFocusOf(pinByKey.get('s10'), linesMap, lg, tree, null), null, '纯联络线站 → null');
  eq(V.stationFocusOf(null, linesMap, lg, tree, null), null, 'null pin → null（防御）');
  // 他省行也在面板数据（可点行的数据基础）
  const st6 = V.stationFocusOf(pinByKey.get('g:g6'), linesMap, lg, tree, null);
  eq(st6.lines.map((l) => l.mainId), ['l3', 'lp'], '他省线行列在车站页（修正裁定）');

  // focusBboxOfSet：各高亮线（组员并集）bbox 联合 ∪ 绑定联络线 bbox
  const bb = new Map([
    ['l1', [121.00, 31.00, 121.10, 31.00]],
    ['l1b', [121.05, 31.00, 121.06, 31.05]],
    ['l2', [121.11, 31.01, 121.20, 31.10]],
    ['l3', [121.12, 31.02, 121.30, 31.20]],
    ['lcx', [121.00, 30.90, 121.05, 31.00]],   // 绑定联络线（南延出线本体）
  ]);
  eq(V.focusBboxOfSet(bb, lg, ['l1', 'l2'], [{ lineId: 'lcx', attachEnd: 0 }]),
    [121.00, 30.90, 121.20, 31.10], '多线 bbox＝组员并集（含支线 l1b）∪ 绑定联络线');
  eq(V.focusBboxOfSet(bb, lg, ['l1', 'l1'], []), [121.00, 31.00, 121.10, 31.05], '重复 id 去重（防御）');
  eq(V.focusBboxOfSet(bb, lg, [], []), null, '空集合 → null');
  eq(V.focusBboxOfSet(bb, null, ['l1'], []), [121.00, 31.00, 121.10, 31.00], 'lineGroups 缺省 → 退逐线（无组员扩展）');
  eq(V.focusBboxOfSet(bb, lg, ['l1'], [{ lineId: 'missing', attachEnd: 0 }]),
    [121.00, 31.00, 121.10, 31.05], '联络线缺 bbox → 跳过不炸');
  // 联络线只亮不列名回归：组内联络线成员不进 stationFocusOf 的任何文字面（lines 无 lc 条目）
  ok(st1.lines.every((l) => l.mainId !== 'lc' && l.name.indexOf('联络') < 0), '车站页数据不含联络线条目（钉死规则）');
}

console.log(fails ? `\nFAIL - ${fails} assertion(s)` : '\nPASS - viewer logic OK');
process.exit(fails ? 1 : 0);
