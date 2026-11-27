// 查看器「点击车站」冒烟探针（只读注入；dump-dom 路数：跑完写 probeOut 再放行 load）
// 站点 index.html 的 viewer.js 之后加载本脚本。覆盖：双入口点站（搜索＋fire click 直调
// handler）、相机到站＋多线高亮（罩上重画线数）＋面板车站页（站名/逐行/多名标注）、
// 返回回各来源（搜索/线路页/列表三例）、分期态点站解除分期、单线站、他省参与、
// 联络线亮而不名、行点击链（车站页→线路页→返回车站页→返回原来源）。
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); while (!(fn())) { if (Date.now() - t0 > ms) return false; await sleep(60); } return true; };

  // 截获 map 实例（viewer.js 的 boot 是 async，Map 在 fetch 之后才建——先包装再等）
  let theMap = null;
  const OrigOn = window.maplibregl.Map.prototype.on;
  window.maplibregl.Map.prototype.on = function (type, fn) {
    if (!theMap) theMap = this;
    return OrigOn.call(this, type, fn);
  };

  const OUT = { steps: {}, fail: 0 };
  function record(step, data) {
    OUT.steps[step] = data;
    if (data && data.__bad) OUT.fail++;
  }
  function check(step, name, cond, extra) {
    const key = step + '.' + name;
    const ok = !!cond;
    if (!ok) OUT.fail++;
    OUT.steps[key] = ok === true ? 'ok' : ('FAIL ' + (extra !== undefined ? JSON.stringify(extra) : ''));
    return ok;
  }

  function stLines() { return Array.from(document.querySelectorAll('#stationBody .st-line')).map((el) => el.textContent.trim()); }
  function viewVisible(id) { const el = $(id); return !!el && !el.hidden; }
  function paintOf(layer, prop) { try { return theMap.getPaintProperty(layer, prop); } catch (e) { return 'ERR'; } }
  function layerIds(prefix) { return (theMap.getStyle().layers || []).filter((l) => l.id.indexOf(prefix) === 0).map((l) => l.id); }
  function renderedIn(layers) { try { return theMap.queryRenderedFeatures({ layers }).length; } catch (e) { return 'ERR'; } }
  async function jumpAndWait(center, zoom) {
    // center 已是显示坐标（调用方过 dispOf）
    theMap.jumpTo({ center, zoom: zoom == null ? 13 : zoom });
    await sleep(350);
  }
  // 与 viewer 同口径的显示坐标（本页面底图恒初始 gaode 态→GCJ02；权威 WGS84 数据渲染前
  // 过 S.dispCoord，探针 project/jumpTo 必须同变换，否则点偏站圈）
  function dispOf(lon, lat) { return window.VIEWER_CORE.wgs84ToGcj02(lon, lat); }
  function clickMapAt(lon, lat) {
    // 原生 canvas 事件（mousedown/mouseup/click 冒泡到 container）——走 MapLibre 真实
    // 输入路径（fire('click') 合成事件不触发其 DOM 派发链）
    const pt = theMap.project(dispOf(lon, lat));
    const cv = theMap.getCanvas();
    for (const type of ['mousedown', 'mouseup', 'click']) {
      cv.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true,
        clientX: pt.x, clientY: pt.y, button: 0, buttons: 1 }));
    }
    return pt;
  }

  async function run() {
    // 等 map 建立＋样式就绪
    const gotMap = await until(() => theMap != null, 20000);
    if (!gotMap) { record('setup', { __bad: true, msg: 'map 实例未捕获' }); return finish(); }
    await until(() => theMap.isStyleLoaded(), 20000);
    await sleep(500);
    try { theMap.getCanvas().style.cursor = ''; } catch (e) {}

    // S1 进入主界面
    $('btnConfirm').click();
    check('S1', 'mainVisible', viewVisible('viewMain'));

    // ===== S2/S3 搜索点车站（入口 1）＝完整行为 =====
    const inp = $('searchInput');
    inp.value = '人民广场';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(250);
    const stopItem = Array.from(document.querySelectorAll('#searchResults .sr-item'))
      .find((el) => el.textContent.indexOf('人民广场') >= 0 && el.textContent.indexOf('车站') >= 0);
    check('S2', 'searchStopItem', !!stopItem, stopItem && stopItem.textContent);
    stopItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await sleep(400);
    check('S3', 'stationView', viewVisible('viewStation'));
    check('S3', 'stationName', ($('stationBody').querySelector('.lp-name') || {}).textContent === '人民广场',
      ($('stationBody').querySelector('.lp-name') || {}).textContent);
    const s3lines = stLines();
    check('S3', 'lineRows3', s3lines.length === 3, s3lines);
    check('S3', 'rowNames', s3lines.map((s) => s.replace(/（.*）/, '')).sort().join('|') === '1号线|2号线|8号线', s3lines);
    check('S3', 'noCallAnno', s3lines.every((s) => s.indexOf('（') < 0), s3lines);   // 单名站不标注
    const z = theMap.getZoom(), c = theMap.getCenter();
    check('S3', 'zoom13', z > 12.5 && z < 13.5, z);
    const s3d = dispOf(121.4688422, 31.2357083);
    check('S3', 'centerAtStation', Math.abs(c.lng - s3d[0]) < 0.01 && Math.abs(c.lat - s3d[1]) < 0.01, [c.lng, c.lat]);
    check('S3', 'veilOn', paintOf('focus-veil', 'fill-opacity') === 0.7, paintOf('focus-veil', 'fill-opacity'));
    const s3copy = renderedIn(['focus-copy', 'focus-copy-dash']);
    check('S3', 'focusCopyRedrawn', s3copy === 'ERR' ? false : s3copy > 0, s3copy);
    check('S3', 'rippleFx', ($('focusFx').querySelector('.fx-item') || $('focusFx').children.length) ? true : false, $('focusFx').children.length);
    await sleep(1400);   // 等 flyTo＋波纹自清

    // ===== S4 返回回搜索态（来源记忆例 1）＋高亮取消 =====
    $('btnStationBack').click();
    await sleep(300);
    check('S4', 'backToMain', viewVisible('viewMain'));
    check('S4', 'searchKept', !$('searchResults').hidden && $('searchResults').children.length > 0 && $('searchInput').value === '人民广场',
      [$('searchInput').value, $('searchResults').children.length]);
    check('S4', 'veilOff', paintOf('focus-veil', 'fill-opacity') === 0, paintOf('focus-veil', 'fill-opacity'));
    check('S4', 'focusCopyGone', layerIds('focus-copy').length === 0, layerIds('focus-copy'));
    // 清搜索回列表
    $('searchInput').value = '';
    $('searchInput').dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);

    // ===== S5 地图单击车站（入口 2）＝嘉定北（联络线亮而不名）＋行点击链 =====
    await jumpAndWait(dispOf(121.2325827, 31.3933799));
    clickMapAt(121.2325827, 31.3933799);
    await sleep(400);
    check('S5', 'stationView', viewVisible('viewStation'));
    const s5lines = stLines();
    check('S5', 'lineRows3', s5lines.length === 3, s5lines);
    check('S5', 'rowNames', s5lines.map((s) => s.replace(/（.*）/, '')).sort().join('|') === '11号线|嘉定快线|嘉闵线', s5lines);
    const s5fade = layerIds('conn-fade-');
    check('S5', 'connFade3', s5fade.length === 3, s5fade);   // 嘉闵线 l0056 的 l0086/l0088/l0089
    check('S5', 'connUnnamed', $('stationBody').textContent.indexOf('联络') < 0, $('stationBody').textContent.slice(0, 120));
    // 行点击链：点「11号线」行 → 线路页（来源 station）
    const row11 = Array.from(document.querySelectorAll('#stationBody .st-line')).find((el) => el.textContent.indexOf('11号线') >= 0);
    row11.click();
    await sleep(600);   // setFocus fitBounds 动画中
    check('S5', 'rowClickLinePage', viewVisible('viewLine'), viewVisible('viewLine'));
    const s5lp = ($('lineBody').querySelector('.lp-name') || {}).textContent;
    check('S5', 'linePageName', s5lp === '11号线', s5lp);
    check('S5', 'focusCopyLine', (function () { const n = renderedIn(['focus-copy', 'focus-copy-dash']); return n === 'ERR' ? false : n > 0; })());
    // 线路页返回 → 回车站页
    $('btnLineBack').click();
    await sleep(300);
    check('S5', 'backToStation', viewVisible('viewStation') && stLines().length === 3);
    // 车站页返回 → 回列表（来源记忆例 2）
    $('btnStationBack').click();
    await sleep(300);
    check('S5', 'backToList', viewVisible('viewMain') && $('searchResults').hidden);
    check('S5', 'veilOff', paintOf('focus-veil', 'fill-opacity') === 0, paintOf('focus-veil', 'fill-opacity'));

    // ===== S6 分期态点车站＝解除分期 =====
    $('btnCyclePhase').click();   // all → existing
    await sleep(400);
    check('S6', 'phaseExisting', $('btnCyclePhase').textContent === '既有', $('btnCyclePhase').textContent);
    await jumpAndWait(dispOf(121.4548198, 31.2434697));   // 汉中路
    clickMapAt(121.4548198, 31.2434697);
    await sleep(400);
    check('S6', 'stationView', viewVisible('viewStation'));
    check('S6', 'phaseResetAll', $('btnCyclePhase').textContent === '全部', $('btnCyclePhase').textContent);
    check('S6', 'hanZhongLu3', stLines().length === 3, stLines());
    $('btnStationBack').click();
    await sleep(300);

    // ===== S7 单线站（富锦路，1号线一条） =====
    await jumpAndWait(dispOf(121.4193724, 31.3942874));
    clickMapAt(121.4193724, 31.3942874);
    await sleep(400);
    const s7lines = stLines();
    check('S7', 'singleLine1', viewVisible('viewStation') && s7lines.length === 1, s7lines);
    check('S7', 'rowName', s7lines[0] === '1号线', s7lines);

    // ===== S8 他省参与（花桥：11号线/宝嘉线/苏州11/苏州17〔他省〕四行） =====
    await jumpAndWait(dispOf(121.1029972, 31.300695));
    clickMapAt(121.1029972, 31.300695);
    await sleep(400);
    const s8lines = stLines();
    check('S8', 'huaQiao4', viewVisible('viewStation') && s8lines.length === 4, s8lines);
    check('S8', 'provinceRow', s8lines.some((s) => s.replace(/（.*）/, '') === '苏州17'), s8lines);
    check('S8', 'allRowNames', s8lines.map((s) => s.replace(/（.*）/, '')).sort().join('|') === '11号线|宝嘉线|苏州11|苏州17', s8lines);
    // 他省线行可点 → 线路页（无 lineinfo＝「无信息」＋标志色＋KML 在 DOM）
    const row17 = Array.from(document.querySelectorAll('#stationBody .st-line')).find((el) => el.textContent.indexOf('苏州17') >= 0);
    row17.click();
    await sleep(700);
    check('S8', 'provinceRowClick', viewVisible('viewLine'));
    check('S8', 'provinceLineName', ($('lineBody').querySelector('.lp-name') || {}).textContent === '苏州17',
      ($('lineBody').querySelector('.lp-name') || {}).textContent);
    $('btnLineBack').click();
    await sleep(300);
    $('btnStationBack').click();
    await sleep(300);

    // ===== S9 线路页 → 点车站 → 返回回线路页（来源记忆例 3，恢复聚焦不跳相机） =====
    const firstRow = document.querySelector('#lineList .line-item');
    firstRow.click();
    await sleep(700);
    check('S9', 'linePage', viewVisible('viewLine'));
    const s9name = ($('lineBody').querySelector('.lp-name') || {}).textContent;
    const cBefore = theMap.getCenter();
    await jumpAndWait(dispOf(121.4193724, 31.3942874));
    clickMapAt(121.4193724, 31.3942874);
    await sleep(400);
    check('S9', 'stationFromLine', viewVisible('viewStation'));
    $('btnStationBack').click();
    await sleep(400);
    check('S9', 'backToLinePage', viewVisible('viewLine') && ($('lineBody').querySelector('.lp-name') || {}).textContent === s9name,
      ($('lineBody').querySelector('.lp-name') || {}).textContent);
    const cAfter = theMap.getCenter();
    const s9d = dispOf(121.4193724, 31.3942874);
    check('S9', 'resumeNoCamera', Math.abs(cAfter.lng - s9d[0]) < 0.01 && Math.abs(cAfter.lat - s9d[1]) < 0.01, [cAfter.lng, cAfter.lat]);
    check('S9', 'focusResumed', (function () { const n = renderedIn(['focus-copy', 'focus-copy-dash']); return n === 'ERR' ? false : n > 0; })());

    record('done', { steps: Object.keys(OUT.steps).length });
  }

  function finish() {
    const pre = document.createElement('pre');
    pre.id = 'probeOut';
    pre.textContent = JSON.stringify(OUT);
    document.body.appendChild(pre);
    fetch('/__release').catch(() => {});
  }

  run().catch((e) => {
    record('exception', { __bad: true, msg: String(e && e.stack || e) });
  }).then(finish);
})();
