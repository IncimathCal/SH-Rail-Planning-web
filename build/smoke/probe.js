// 查看器相机让位冒烟探针（2026-11-27 真机两病灶修复验证；只挂 build/smoke 站点副本，
// 不进正式树）。用法见 smoke.py：probe.html 在 viewer.js 之后加载本文件，跑完断言写
// #probeOut 后 fetch /__release 放行 load 事件，chrome --dump-dom 取回。
// 断言口径（任务书）：聚焦后取景 bbox（focusBboxOf：组全体 ∪ 聚焦绑定联络线）的
// 四向投影落在「视口 − cameraPadding」内（浮点容差 0.5px）——即 padding 真实带上、
// bbox 含全部应可见几何、站名余量生效。
/* global VIEWER_CORE */
(function () {
  'use strict';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { checks: [], fails: 0, meta: {} };
  function check(name, cond, detail) {
    out.checks.push((cond ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : ''));
    if (!cond) out.fails++;
  }
  async function waitReady() {
    const t0 = Date.now();
    for (;;) {
      const v = globalThis.__v;
      if (v && v.S && v.S.map && v.S.dispBbox && v.S.dispBbox.size > 0 && v.S.blendPlan && v.S.map.loaded()) return v;
      if (Date.now() - t0 > 45000) throw new Error('等 viewer 就绪超时（__v=' + !!globalThis.__v
        + ' dispBbox=' + (globalThis.__v && globalThis.__v.S.dispBbox ? globalThis.__v.S.dispBbox.size : 'n/a') + '）');
      await sleep(120);
    }
  }
  // 聚焦一条线 → 等相机动画（duration 600ms）落地 → 断言取景 bbox 四向投影
  async function assertFocus(v, id, label, extra) {
    v.setFocus(id);
    await sleep(1100);   // 600ms 动画 + 呼吸余量
    const V = globalThis.VIEWER_CORE;
    const S = v.S;
    const bb = V.focusBboxOf(S.dispBbox, S.lineGroups, id, S.fadeConnPlan);
    if (!bb) { check(label + '：bbox 存在', false, 'focusBboxOf=null'); return; }
    const pad = v.cameraPadding();
    const map = S.map;
    const w = window.innerWidth, h = window.innerHeight;
    const midY = (bb[1] + bb[3]) / 2, midX = (bb[0] + bb[2]) / 2;
    const pxWest = map.project([bb[0], midY]).x;      // 西界（面板侧）
    const pxEast = map.project([bb[2], midY]).x;      // 东界（屏幕右缘）
    const pyNorth = map.project([midX, bb[3]]).y;     // 北界（top）
    const pySouth = map.project([midX, bb[1]]).y;     // 南界（bottom）
    check(label + '：西界投影 ≥ 面板右缘+呼吸+站名余量（pad.left=' + pad.left.toFixed(1) + '）',
      pxWest >= pad.left - 0.5, 'pxWest=' + pxWest.toFixed(1));
    check(label + '：东界投影 ≤ 视口右 − pad.right（' + pad.right + '）',
      pxEast <= w - pad.right + 0.5, 'pxEast=' + pxEast.toFixed(1) + ' w=' + w);
    check(label + '：北界投影 ≥ pad.top（' + pad.top + '）',
      pyNorth >= pad.top - 0.5, 'pyNorth=' + pyNorth.toFixed(1));
    check(label + '：南界投影 ≤ 视口底 − pad.bottom（' + pad.bottom + '）',
      pySouth <= h - pad.bottom + 0.5, 'pySouth=' + pySouth.toFixed(1) + ' h=' + h);
    if (extra) extra(S, map, pad, w, h);
  }
  // 站名真宽实测：造 .map-label（含 is-group 加粗态）量 offsetWidth——LABEL_MARGIN_X 的依据
  function measureLabel(text, isGroup) {
    const el = document.createElement('div');
    el.className = 'map-label' + (isGroup ? ' is-group' : '');
    el.style.position = 'absolute'; el.style.visibility = 'hidden';
    el.textContent = text;
    document.body.appendChild(el);
    const wpx = el.offsetWidth;
    el.remove();
    return wpx;
  }
  async function run() {
    const v = await waitReady();
    const S = v.S;
    out.meta.lines = S.linesMap.size;
    out.meta.view = window.innerWidth + 'x' + window.innerHeight;
    // 面板展开态 rect（相机让位左基线）
    const panel = document.getElementById('panel');
    const pr = panel.getBoundingClientRect();
    out.meta.panel = pr.left + '~' + pr.right + '（宽 ' + pr.width + '）';
    out.meta.pad = JSON.stringify(v.cameraPadding());

    // ① 初始 fitAll（全图西端不被面板压住）
    {
      const bb = v.totalBbox();
      const pad = v.cameraPadding();
      const pxWest = S.map.project([bb[0], (bb[1] + bb[3]) / 2]).x;
      check('fitAll：全网西界投影 ≥ pad.left', pxWest >= pad.left - 0.5,
        'pxWest=' + pxWest.toFixed(1) + ' pad.left=' + pad.left.toFixed(1));
    }

    // ② 病灶①回归：东西联络线 l0050（standalone）——西衔嘉青松金线的联络线 l0087 并入取景
    await assertFocus(v, 'l0050', '聚焦 l0050 东西联络线（面板展开）', (St, map, pad, w) => {
      const b87 = St.dispBbox.get('l0087');   // 西衔嘉青松金线联络线
      const b88 = St.dispBbox.get('l0088');                          // 嘉闵线侧联络线
      if (b87) {
        const x87 = map.project([b87[0], (b87[1] + b87[3]) / 2]).x;
        check('病灶①：l0087（西衔嘉青松金线联络线）西端在面板右侧取景内', x87 >= pad.left - 0.5,
          'xWest(l0087)=' + x87.toFixed(1) + ' pad.left=' + pad.left.toFixed(1));
        const xE87 = map.project([b87[2], (b87[1] + b87[3]) / 2]).x;
        check('病灶①：l0087 东端在视口内', xE87 <= w - pad.right + 0.5, 'xEast=' + xE87.toFixed(1));
      } else check('病灶①：l0087 有渲染 bbox', false, 'dispBbox 缺 l0087');
      if (b88) {
        const x88 = map.project([b88[0], (b88[1] + b88[3]) / 2]).x;
        check('病灶①：l0088（嘉闵线侧联络线）西端在取景内', x88 >= pad.left - 0.5, 'xWest(l0088)=' + x88.toFixed(1));
      }
      // fade 绑定口径自证：聚焦 l0050 时 fadeConnPlan 应含 l0087/l0088
      const ids = (St.fadeConnPlan || []).map((it) => it.lineId).sort().join(',');
      check('fade 绑定口径：connects 含 l0050 的联络线 = ' + ids,
        ids === 'l0087,l0088', 'got ' + ids);
    });

    // ③ 病灶②回归：东西走向长普通线 l0062 南枫线（72km，standalone 无组）
    await assertFocus(v, 'l0062', '聚焦 l0062 南枫线（长东西普通线，面板展开）');

    // ④ 组路径短线：lg04 南汇线（主线 l0065＋支线 l0066，组全体取景）
    await assertFocus(v, 'l0065', '聚焦 l0065 南汇线（组路径短线，面板展开）');

    // ⑤ 面板收起态抽查：left 回落 GAP+站名余量（94），西端点站名不被屏缘裁
    v.setLinePanelCollapsed(true);
    await sleep(450);   // 抽屉 transition（CSS ~0.35s）落地再取 rect
    await assertFocus(v, 'l0062', '聚焦 l0062 南枫线（面板收起）');
    v.setLinePanelCollapsed(false);
    v.setFocus(null);

    // ⑥ 站名真宽实测（LABEL_MARGIN_X=70 的依据）：真数据最长站名 + 抽查
    const samples = [
      ['上海国际旅游度假区', true], ['浦东1号2号航站楼', true], ['蟠祥路·国家会计学院', false],
      ['浦东4号5号航站楼', false], ['上海儿童医学中心', false], ['虹桥2号航站楼', false],
    ];
    out.meta.labelWidths = samples.map(([t, g]) => t + (g ? '(组)' : '') + '=' + measureLabel(t, g) + 'px');
    const widest = Math.max(...samples.map(([t, g]) => measureLabel(t, g)));
    check('站名实测：最长样本半宽 ≤ LABEL_MARGIN_X(70)',
      widest / 2 <= 70, 'widest=' + widest + 'px half=' + (widest / 2).toFixed(1));

    out.summary = out.fails ? ('FAIL - ' + out.fails + ' check(s)') : 'PASS - camera smoke OK';
  }
  run().catch((e) => {
    out.checks.push('FAIL 探针异常：' + (e && e.message ? e.message : String(e)) + (e && e.stack ? ' @' + String(e.stack).split('\n')[1] : ''));
    out.fails++;
    out.summary = 'FAIL - probe error';
  }).finally(() => {
    const pre = document.createElement('pre');
    pre.id = 'probeOut';
    pre.textContent = JSON.stringify(out);
    document.body.appendChild(pre);
    try { fetch('/__release', { mode: 'no-cors' }).catch(() => {}); } catch (e) { /* 已尽力 */ }
  });
})();
