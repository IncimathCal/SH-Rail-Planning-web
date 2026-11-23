// 编辑器主逻辑（阶段 2 MVP，仅本地使用，永不部署）。
// 数据纪律（见《架构方案-01》§0）：
//   - 换乘编组绝不按站名自动合并，就近提示仅视觉参考；
//   - 编号分配后永不复用（设站用 meta.stopSeq 水位，线/组用持久计数器）；
//   - 数据文件结构字段全英文，中文仅在 name/aliases/info/note/sourceLayer 值中。
(function (global) {
  'use strict';

  // ---------- 纯逻辑层（无 DOM 依赖，node 单测覆盖：tools/test_editor_logic.js） ----------
  const SEG_ORDER = ['existing', 'approved', 'future'];
  const SEG_LABEL = { existing: '既有', approved: '已批复', future: '远期' };
  const ROLE_LABEL = { standalone: '独立', main: '主线', branch: '支线', connector: '联络线' };
  const EPS = 1e-4;          // t 最小间隔

  /** 加站后的分段表调整（stops 已含新站，i 为其下标）——分段实体（fmt/line@2，2026-11-21）。
   *  segments 元素是分段索引：中间插入分裂原段（两半继承原索引）；端部延伸**继承相邻段**
   *  （首位 unshift(segs[0])、末端 push(末值)；环线 0→1 站 push(segs[0]||0)）——
   *  旧版端部默认 'existing' 的语义废除（铺满模型下端部必须归段；空表兜底 0，
   *  对应的分段 sections 由 fixStatusField 在跨界时创建）。
   *  段数不变量：非环线 = 站数-1，环线 = 站数（站数<2 时一律为空，见 fixStatusField）。 */
  function segInsert(line, i) {
    const segs = line.segments;
    const n = line.stops.length;   // 已含新站
    if (line.loop) {
      if (n === 1) segs.push(segs[0] || 0);
      else if (i === 0) {
        // 新站落在环绕弧上（t 小于首站 t）：环绕段一分为二，尾半（t→s0）占首位、
        // 头半（s(n-1)→t）留末位，中间各段整体后移一格——即 [W, old0..old(n-2), W]
        const w = segs.length ? segs[segs.length - 1] : 0;
        segs.unshift(w);
        if (segs.length === 1) segs.push(w);   // 1 站环线空表兜底：两半同段 [0,0]
      }
      else segs.splice(i - 1, 1, segs[i - 1] || 0, segs[i - 1] || 0);   // 1→2 站时段表尚空，兜底 0
    } else {
      if (n === 1) { /* 非环线 1 站 = 0 段（站数<2 时 segments/sections 均为空） */ }
      else if (i === 0) segs.unshift(segs[0] || 0);          // 首位延伸，新段继承原首段
      else if (i === n - 1) segs.push(segs[segs.length - 1] || 0);   // 末端延伸，继承原末段
      else segs.splice(i - 1, 1, segs[i - 1] || 0, segs[i - 1] || 0);
    }
  }

  /** 删站前的分段表调整（stops 尚未移除，i 为待删下标）。
   *  相邻两段合并，保留 seg[i] 的分段索引；删后站数仍 ≥2 时清理失去全部引用的分段（防空段/断号），
   *  跌破 2 站则不清理——留给 fixStatusField 先从 sections[0] 收回落选状态再整体清空。 */
  function segRemove(line, i) {
    const segs = line.segments;
    const n = line.stops.length;
    if (line.loop) {
      if (n === 1) segs.length = 0;
      else if (i === 0) {
        // 删首站：新站序自原 s1 起，中间各段整体前移一格；环绕段（旧 wrap∪旧 g0
        // 合并弧）落到末位，值按「保留被删站下游段」规则取 g0 —— 即 [g1..g(n-2), g0]
        segs.splice(segs.length - 1, 1);
        segs.push(segs.shift());
      }
      else {
        // seg[j] 连接 stop j → (j+1)%n；删 stop i 合并 seg[(i-1+n)%n] 与 seg[i]
        const other = (i - 1 + n) % n;
        const merged = segs[i];
        segs.splice(Math.max(i, other), 1);
        segs.splice(Math.min(i, other), 1, merged);
      }
    } else {
      if (i === 0) segs.shift();
      else if (i === n - 1) segs.pop();
      else { const merged = segs[i]; segs.splice(i - 1, 2, merged); }
    }
    if (n >= 3) pruneSections(line);
  }

  /** 分段清理：删除失去全部 segment 引用的分段（空段），更大索引整体减一（防断号）。
   *  段序与线路序一致（切分插入式维护），空段只会在并段/删站/切换环线后出现。 */
  function pruneSections(line) {
    if (!line.sections) return;
    const usedOf = () => { const u = new Set(); for (const v of line.segments || []) u.add(v); return u; };
    let used = usedOf();
    let k = 0;
    while (k < line.sections.length) {
      if (used.has(k)) { k++; continue; }
      line.sections.splice(k, 1);
      line.segments = (line.segments || []).map((v) => (v > k ? v - 1 : v));
      used = usedOf();   // 索引整体变化，引用集重算；不递增 k＝接着检查挪到当前位置的原下一段
    }
  }

  /** 站数跨过 2 的边界时的状态与分段表修正（每次加/删站后调用，幂等）。
   *  ≥2：status 置 null；sections 尚空（<2→≥2 跨界）则以线路级 status 建单一分段
   *      （name ""、status 继承，即「建新线默认分段」；segments 已由 segInsert 铺好，
   *       跨界时其空表兜底 0 与新 sections[0] 恰好对齐）。
   *  <2：sections/segments 清空，status 从原第一个分段继承（≥2→<2 跨界回落），空则补 future。 */
  function fixStatusField(line) {
    const n = line.stops.length;
    if (n >= 2) {
      const prev = line.status;
      line.status = null;
      if (!line.sections || !line.sections.length) {
        line.sections = [{ name: '', status: SEG_ORDER.includes(prev) ? prev : 'future' }];
      }
    } else {
      if (line.sections && line.sections.length) {
        const st0 = line.sections[0] && line.sections[0].status;
        if (SEG_ORDER.includes(st0)) line.status = st0;
      }
      if (!line.status) line.status = 'future';
      line.sections = [];
      line.segments = [];
    }
  }

  /** fmt/line@1 → @2 迁移：segments 由状态字符串数组改为分段索引数组，
   *  按连续同状态块生成 sections（name 一律 ""——先建后补，绝不自动起名；status 取块状态），
   *  schema 写 @2。就地修改并返回生成分段数；非 @1 形态（schema 已 @2 且无字符串元素）返回 0 不动。
   *  注：环线环绕两端同状态的块按线性扫描仍生成两个分段（合法，可一键并段），不自动跨环绕合并。
   *  另兼任「站数<2 缺线路级 status」的兜底（2026-11-22 属性面板删状态字段后 UI 不再有录入口，
   *  而 validate 对 <2 站仍必填）：任何形态的 line 在此统一补 'future'——载入五路径
   *  （拖入/工作区/自动拉取/暂存恢复/撤销还原）都过本函数，缺则补（结构枚举缺省，非起名）。 */
  function migrateLineToV2(line) {
    if (line && line.stops && line.stops.length < 2 && !SEG_ORDER.includes(line.status)) line.status = 'future';
    if (!line || !Array.isArray(line.segments)) {
      if (line && line.schema === 'fmt/line@1') { line.schema = 'fmt/line@2'; if (!line.sections) line.sections = []; }
      return 0;
    }
    const isV1 = line.schema === 'fmt/line@1' || line.segments.some((v) => typeof v === 'string');
    if (!isV1) return 0;
    const norm = (v) => (SEG_ORDER.includes(v) ? v : 'existing');
    const sections = [];
    let prev = null;
    for (const v of line.segments) {
      const st = norm(v);
      if (st !== prev) { sections.push({ name: '', status: st }); prev = st; }
    }
    let idx = -1;
    prev = null;
    line.segments = line.segments.map((v) => {
      const st = norm(v);
      if (st !== prev) { idx++; prev = st; }
      return idx;
    });
    line.sections = sections;
    line.schema = 'fmt/line@2';
    return sections.length;
  }

  /** 在站 k（1-based 站序）设分段边界：使 seg[k-2]（站 k-1→k）与 seg[k-1]（站 k→k+1）分属两段。
   *  两者已不同段返回 false（无操作）；否则右半块（自 seg[k-1] 起沿站序的连续同段块，环线可跨环绕）
   *  改挂新分段（name ""、status 继承原段）并返回 true。
   *  新分段在 sections 中插到原分段之后（而非 append 到末尾）：维持「段序＝线路序」不变量，
   *  之后更大的索引整体 +1——这使并段（applySectionMerge）的「下一段」恒为线路相邻段，面板行序恒与线路序一致。
   *  非环线合法 k∈[2,n-1]；环线 k∈[1,n]（k=1＝环绕段 seg[n-1] 与 seg[0] 分家）。 */
  function planSectionSplit(line, k) {
    const n = line.stops.length;
    if (n < 2 || !Number.isInteger(k)) return false;
    if (line.loop ? (k < 1 || k > n) : (k < 2 || k > n - 1)) return false;
    const segs = line.segments;
    const want = line.loop ? n : n - 1;
    if (segs.length !== want || !(line.sections || []).length) return false;
    const right = (k - 1) % n;            // 右半块起点（环线 k=n 时 =n-1）
    const left = (k - 2 + n) % n;         // 左侧相邻段（环线 k=1 时 =n-1 环绕段）
    if (segs[left] !== segs[right]) return false;   // 已不同段：无操作
    const oldIdx = segs[right];
    if (!line.sections[oldIdx]) return false;       // 索引越界（数据异常）防御
    const newIdx = oldIdx + 1;
    line.sections.splice(newIdx, 0, { name: '', status: line.sections[oldIdx].status });
    for (let j = 0; j < segs.length; j++) if (segs[j] > oldIdx) segs[j] += 1;
    // 右半块＝自 right 起沿站序的连续同段块；p 到 left（左半块末位）必停——
    // 覆盖全环的单段在环绕边界切分时，右半块恰为「除环绕段外全部」（否则会吞掉左半块成空段）
    let p = right, guard = 0;
    while (guard++ < segs.length && segs[p] === oldIdx && p !== left) {
      segs[p] = newIdx;
      if (line.loop) p = (p + 1) % segs.length; else p++;
    }
    return true;
  }

  /** 段 k（0-based 段序）与下一段并段：下一段的 segments 改写为 k，sections 删下一段、
   *  更大索引减一；名称与状态取段 k（下一段的名字弃用——绝不自动拼接起名）。
   *  非环线末段无下一段返回 false；环线末段的下一段＝段 0（并完删段 0、更大索引减一）。
   *  依赖「段序＝线路序」不变量（planSectionSplit 插入式维护），两段恒线路相邻、并完仍连续成块。 */
  function applySectionMerge(line, k) {
    const secs = line.sections || [];
    if (line.stops.length < 2 || !Array.isArray(line.segments)) return false;
    if (!Number.isInteger(k) || k < 0 || k >= secs.length) return false;
    if (secs.length < 2) return false;
    if (!line.loop && k === secs.length - 1) return false;
    if (line.loop && k === secs.length - 1) {
      // 环线末段并首段：保留 k 的名/状态；删段 0，原值 0 →k、其余整体减一（k 落到新 k-1）
      line.sections.splice(0, 1);
      line.segments = line.segments.map((v) => (v === 0 ? k - 1 : v - 1));
    } else {
      const del = k + 1;
      line.sections.splice(del, 1);
      line.segments = line.segments.map((v) => (v === del ? k : (v > del ? v - 1 : v)));
    }
    return true;
  }

  /** 段 k 覆盖的站序区间（面板汇总用）：返回 [起站, 讫站]（1-based，含端；seg f..l 对应站 f+1..l+2）。
   *  环线块跨环绕段时讫站绕回（如 [4,1]，全线单段为 [1,1]），环绕与否由调用方判定；
   *  站数<2、段号越界、空段、段表长度不符返回 null。 */
  function sectionSpanOf(line, k) {
    const n = line.stops.length;
    const segs = line.segments || [];
    if (n < 2 || !Number.isInteger(k) || k < 0 || !(line.sections || [])[k]) return null;
    const want = line.loop ? n : n - 1;
    if (segs.length !== want) return null;
    let f = -1;
    for (let i = 0; i < segs.length; i++) { if (segs[i] === k) { f = i; break; } }
    if (f < 0) return null;
    let l = f, p = f, guard = 0;
    while (guard++ < segs.length && segs[p] === k) {
      l = p;
      if (line.loop) p = (p + 1) % segs.length; else p++;
    }
    return [f + 1, line.loop ? (((l + 1) % n) + 1) : l + 2];
  }

  /** 分段约束检测（纯逻辑，lineIssues 调用＋单测覆盖）：返回中文问题描述数组（空＝合格）。
   *  站数<2：sections/segments 均须为空（线路级 status 接管）；
   *  站数≥2：segments 长度＝环线站数/非环线站数-1、值均为 [0,sections.length) 的整数、
   *  每个分段至少被 1 个 segment 引用（无空段）、同一分段的 segments 连续成块
   *  （沿站序不分离；环线按环形序判定——跨环绕的同段仍算连续）。 */
  function sectionIssuesOf(l) {
    const issues = [];
    const n = l.stops.length;
    const segs = l.segments || [];
    const secs = l.sections || [];
    if (n < 2) {
      if (secs.length) issues.push('站数<2 时 sections 应为空');
      if (segs.length) issues.push('站数<2 时 segments 应为空');
      return issues;
    }
    const want = l.loop ? n : n - 1;
    if (segs.length !== want) { issues.push(`segments 长度 ${segs.length} ≠ 应为 ${want}`); return issues; }
    if (!secs.length) { issues.push('站数≥2 时 sections 不得为空'); return issues; }
    const used = new Set();
    segs.forEach((v, i) => {
      if (!Number.isInteger(v) || v < 0 || v >= secs.length) issues.push(`segments[${i}]=${v} 分段索引越界`);
      else used.add(v);
    });
    for (let k = 0; k < secs.length; k++) {
      if (!used.has(k)) issues.push(`分段 ${k} 未被任何 segment 引用（空段）`);
    }
    // 连续成块：扫描起点挪到（环形）首个值变化处，之后每段只允许出现一次连续块
    if (!issues.length) {
      const arr = segs;
      let start = 0;
      if (l.loop && arr.length > 1) {
        for (let i = 1; i < arr.length; i++) { if (arr[i] !== arr[0]) { start = i; break; } }
      }
      const seen = new Set();
      let cur = null;
      for (let t = 0; t < arr.length; t++) {
        const v = arr[(start + t) % arr.length];
        if (v !== cur) {
          if (seen.has(v)) { issues.push(`分段 ${v} 的区间不连续（沿站序分离）`); break; }
          seen.add(cur = v);
        }
      }
    }
    return issues;
  }

  /** 分配下一个设站序号（水位 = max(meta.stopSeq, 现有最大后缀) + 1，编号永不复用） */
  function nextStopSeq(line) {
    let m = line.meta.stopSeq || 0;
    for (const st of line.stops) {
      const n = parseInt(st.id.split('-s')[1], 10);
      if (!isNaN(n) && n > m) m = n;
    }
    line.meta.stopSeq = m + 1;
    return line.meta.stopSeq;
  }

  /** 出省箭头（stop.kind:'arrow'）落位判定（纯逻辑，addStop 守卫＋单测共用）：
   *  仅非环线的头（i===0）/尾（i===stops.length，即末位之后）可放；环线一律不允许（无出省端点）。 */
  function canPlaceArrow(line, i) {
    if (!line || line.loop) return false;
    return i === 0 || i === (line.stops || []).length;
  }

  /** 站类型循环切换（设站列表 kind-tgl 按钮；2026-11-22）：按位置约束返回下一个类型。
   *  kind＝当前类型（null/缺省＝普通车站，'block'＝线路所，'arrow'＝出省箭头）；
   *  opts.isLoop＝环线；opts.isEnd＝该站位于头/尾（下标 0 或最末，与 validate.py 的 arrow 端点规则一致）。
   *    非环线首/尾：null→'block'→'arrow'→null（三种都合法——arrow 可循环改回站，免删了重放）；
   *    非环线中途：null→'block'→null（arrow 只许首尾）；
   *    环线任意位置：null→'block'→null（环线无 arrow）。
   *  返回 null 表示普通车站（数据不写 kind 字段）；对异常输入（中途/环线的 arrow 起点）同样给出
   *  定义良好的出路（一律回 null），按钮永远可点、一键修复非法状态。 */
  function nextStopKind(kind, opts) {
    const cur = (kind === 'block' || kind === 'arrow') ? kind : null;
    const o = opts || {};
    if (o.isLoop || !o.isEnd) return cur === null ? 'block' : null;
    if (cur === null) return 'block';
    if (cur === 'block') return 'arrow';
    return null;
  }

  /** 联络线不带颜色属性（2026-11-22 用户裁定「联络线取消颜色属性，颜色由所联络的两条线决定」；
   *  validate 既有规则：connector 带 color 即错）。就地清除 role==='connector' 线上遗留的 color——
   *  **按键删除**，与现有联络线文件的写法一致（无 color 键）；返回是否清了。非联络线一律不动。
   *  调用点：角色改为联络线的那一刻（属性面板）、线路载入五路径（经 migrateLineNote）。 */
  function stripConnectorColor(line) {
    if (!line || line.role !== 'connector' || !Object.prototype.hasOwnProperty.call(line, 'color')) return false;
    delete line.color;
    return true;
  }
  /** 落盘用的线路对象（node 单测覆盖）：联络线不带 color 落盘——兜底，正常路径下内存里早已清除
   *  （stripConnectorColor），此处保证任何来路的联络线都不把它写进文件。需要剔除时返回剔除后的
   *  浅拷贝（不改写内存），否则原样返回同一对象。 */
  function lineForSave(line) {
    if (!line || line.role !== 'connector' || !Object.prototype.hasOwnProperty.call(line, 'color')) return line;
    const out = Object.assign({}, line);
    delete out.color;
    return out;
  }

  /** 保存前客户端自检（与 validate.py 规则对应的子集） */
  function lineIssues(l) {
    const issues = [];
    l.stops.forEach((st, i) => {
      const isBlk = st.kind === 'block', isArr = st.kind === 'arrow';
      // 线路所（block）/出省箭头（arrow）站名可空；普通站空名仍报
      if (!isBlk && !isArr && (!st.name || !st.name.trim())) issues.push(`${st.id} 站名为空`);
      if (i > 0 && st.t <= l.stops[i - 1].t) issues.push(`${st.id} t 未递增`);
      // 出省箭头必须在非环线头/尾（保存校验链把门；编辑器落站/切环线另有前置守卫）
      if (isArr && (l.loop || (i !== 0 && i !== l.stops.length - 1))) {
        issues.push(`${st.id} 出省箭头须在非环线头/尾`);
      }
    });
    for (const si of sectionIssuesOf(l)) issues.push(si);
    if (l.stops.length < 2 && !l.status) issues.push('站数<2 但未设线路级 status');
    if (l.stops.length >= 2 && l.status) issues.push('站数≥2 时 status 应为 null');
    if ((l.role === 'main' || l.role === 'branch') && !l.groupId) issues.push('main/branch 必须有线组');
    if (l.role === 'connector' && (!l.connects || l.connects.length < 2)) issues.push('connector 需 connects ≥ 2');
    if (l.role !== 'connector' && l.connects && l.connects.length) issues.push('非 connector 的 connects 应为空');
    return issues;
  }

  /** 批量命名规划：names 每行一个，按序配给 line.stops 中站名为空（含纯空白）的普通站；
   *  已命名的站、线路所（kind:'block'，可无名）与出省箭头（kind:'arrow'，非站点）都跳过不动——
   *  「先点完设站再一次贴名」与逐站命名两种方式并存。
   *  返回 {pairs:[[stop,name]...], total}；写入由调用方执行（便于先快照后改）。 */
  function planBulkFill(line, names) {
    const clean = (names || []).map((s) => String(s).trim()).filter(Boolean);
    const pairs = [];
    let k = 0;
    for (const st of line.stops) {
      if (st.kind === 'block' || st.kind === 'arrow') continue;
      if (st.name && st.name.trim()) continue;
      if (k >= clean.length) break;
      pairs.push([st, clean[k++]]);
    }
    return { pairs, total: clean.length };
  }

  /** 站圆预置批量落站规划（fmt/stations-import@2；node 单测覆盖）。
   *  t 域 [0,1] 双闭（2026-11-21 用户裁定：开线终点站可精确落 1；环线 t=1≡t=0 同一物理点，
   *  不设特殊拦截，物理同点重复设站由用户自律 + t 严格递增兜底）。
   *  preset stops（tools/station_extract.py 产物，t 6 位小数）逐个判定：
   *  与「原有站」|Δt| < dtEps → 跳过（exists，用户已设过的不动）；
   *  与「原有站或已接纳预置站」间隔 < eps → 跳过（conflict，如环线自交/共线重叠圆）；
   *  其余接纳。返回 {inserts:[t...], skippedExist, skippedConflict, total}。
   *  写入由 applyStopImport 执行（调用方先做整批快照，撤销一次回退整批）。 */
  function planStopImport(line, stops, dtEps = 0.002, eps = EPS) {
    const cand = (stops || []).map((s) => Math.round(s.t * 1e6) / 1e6)
      .filter((t) => t >= 0 && t <= 1).sort((a, b) => a - b);
    const out = { inserts: [], skippedExist: 0, skippedConflict: 0, total: cand.length };
    const orig = line.stops.map((s) => s.t);          // 原有站（exists 只对照这些）
    const ts = orig.slice().sort((a, b) => a - b);    // 原有 + 已接纳（conflict 对照）
    for (const t of cand) {
      if (orig.some((u) => Math.abs(u - t) < dtEps)) { out.skippedExist++; continue; }
      let i = 0;
      while (i < ts.length && ts[i] < t) i++;
      const prevT = i > 0 ? ts[i - 1] : null;
      const nextT = i < ts.length ? ts[i] : null;
      if ((prevT !== null && t - prevT < eps) || (nextT !== null && nextT - t < eps)) {
        out.skippedConflict++;
        continue;
      }
      ts.splice(i, 0, t);
      out.inserts.push(t);
    }
    return out;
  }

  /** 执行批量落站（plan 来自 planStopImport）。name 一律留空——预置站名建议绝不自动写入。 */
  function applyStopImport(line, plan) {
    const added = [];
    for (const t of plan.inserts) {
      let i = 0;
      while (i < line.stops.length && line.stops[i].t < t) i++;
      const seq = nextStopSeq(line);
      const st = { id: `${line.id}-s${String(seq).padStart(2, '0')}`, name: '', t, geo: null };
      line.stops.splice(i, 0, st);
      segInsert(line, i);
      added.push(st);
    }
    fixStatusField(line);
    return added;
  }

  /** 站点 t 就近取预置站名建议（|Δt| ≤ dtEps）；返回 {name, dist, manual} 或 null。仅展示用，点选才写入。
   *  manual＝建议来自换乘站名回填（backfillTransferNames，人工命名的其他线），title 文案区别于源图就近文字。 */
  function suggestForStop(item, t, dtEps = 0.002) {
    if (!item) return null;
    let best = null;
    for (const s of item.stops || []) {
      if (!s.nameSuggestion) continue;
      const d = Math.abs(s.t - t);
      if (d <= dtEps && (!best || d < best.d)) best = { name: s.nameSuggestion, dist: s.suggestDist, manual: !!s.manualName, d };
    }
    return best;
  }

  /** 站点 t 就近查预置换乘标（|Δt| ≤ dtEps）；返回 {id, kind} 或 null。仅展示用——
   *  「换」chip 提示该站位置来自 Trans 层换乘标（circle=双线大圆 / pill=多线药丸），
   *  供编组时重点核对；换乘编组本身绝不自动（预置 transfers 全表也只是参考）。 */
  function transferMarkForStop(item, t, dtEps = 0.002) {
    if (!item) return null;
    let best = null;
    for (const s of item.stops || []) {
      if (!s.transfer) continue;
      const d = Math.abs(s.t - t);
      if (d <= dtEps && (!best || d < best.d)) best = { id: s.transfer, kind: s.transferKind, d };
    }
    return best;
  }

  /** 站点 t 就近查预置站的同站不同名冲突（|Δt| ≤ dtEps）；返回 [{name, lines}] 或 null。仅展示用——
   *  多名并列供人工点选采用其一，绝不自动写入（2026-11-22 用户裁定「方案一」，见 backfillTransferNames）。 */
  function conflictsForStop(item, t, dtEps = 0.002) {
    if (!item) return null;
    let best = null;
    for (const s of item.stops || []) {
      if (!s.nameConflict || !s.nameConflict.length) continue;
      const d = Math.abs(s.t - t);
      if (d <= dtEps && (!best || d < best.d)) best = s.nameConflict;
    }
    return best;
  }

  /** 换乘站名回填（2026-11-22 需求 3，node 单测覆盖）：从各线**已命名**的换乘标站收集
   *  {transId → {站名 → [所用线路 id]}}，写回预置里同 trans id 且**还缺建议名**的站
   *  （只填空缺、绝不覆盖已有 nameSuggestion；manualName=true 标记人工回填来源）。
   *  同站不同名（2026-11-22 用户裁定「方案一」）：同一换乘标被录成 ≥2 个名字时**不自动填补**——
   *  换乘标是物理站、站名属于「线路×站」，多名多为有意（市域/国铁与地铁命名体系不同），不该被
   *  自动统一；该预置站改标 nameConflict=[{name, lines}]，站列表并列显示供人工点选其一。此前若已按
   *  单名回填过（manualName），冲突出现时撤回该回填建议（它基于不完整信息）；源图文字建议不动。
   *  pairs = [{line, preset}]（preset 由 UI 层 matchPresetForLine 预解析）；
   *  presets = S.stationPresets（原地修改，内存级即改即生效，不落盘）。
   *  返回 {filled, conflicts, byMark}：填补的预置站数、处于多名冲突的换乘标数（按 transId 去重）、收集表。 */
  function backfillTransferNames(pairs, presets, dtEps = 0.002) {
    const byMark = new Map();
    for (const { line, preset } of pairs || []) {
      if (!line || !preset) continue;
      for (const st of line.stops || []) {
        if (st.kind === 'block' || st.kind === 'arrow') continue;   // 线路所/箭头不参与
        if (!st.name || !st.name.trim()) continue;                  // 只收已命名站
        const m = transferMarkForStop(preset, st.t, dtEps);
        if (!m) continue;
        let byName = byMark.get(m.id);
        if (!byName) byMark.set(m.id, byName = new Map());
        const nm = st.name.trim();
        if (!byName.has(nm)) byName.set(nm, []);
        const lids = byName.get(nm);
        if (!lids.includes(line.id)) lids.push(line.id);
      }
    }
    let filled = 0;
    const conflictIds = new Set();
    for (const it of presets || []) {
      for (const s of it.stops || []) {
        if (!s.transfer) continue;
        const byName = byMark.get(s.transfer);
        if (!byName) { delete s.nameConflict; continue; }   // 已无已命名站命中（站名被清空等）：清冲突标记
        const names = [...byName.keys()];
        if (names.length >= 2) {
          if (s.manualName) { delete s.nameSuggestion; delete s.manualName; }   // 撤回基于单名的回填
          s.nameConflict = names.map((name) => ({ name, lines: byName.get(name).slice() }));
          conflictIds.add(s.transfer);
          continue;
        }
        delete s.nameConflict;   // 曾冲突、现已统一：清标记，按单名处理
        if (!s.nameSuggestion) {
          s.nameSuggestion = names[0];
          s.manualName = true;
          filled++;
        }
      }
    }
    return { filled, conflicts: conflictIds.size, byMark };
  }

  /** 线路按 meta.layer 分组（分类＝源图 Line 直属子图层名，用户自有图层词汇，与 sourceLayer 同性质）。
   *  返回 [{layer, lines}]：有分类的组按名称拼音序（localeCompare 'zh'）排列，
   *  未分类（layer 缺失/空/非字符串）组固定最后；组内按 id 升序。
   *  只有一类且无未分类时也照常返回单组（组头保持一致显示）。 */
  function layerGroupsOf(lines) {
    const byLayer = new Map();   // layer（可为 null）-> [line...]
    for (const l of lines || []) {
      const key = (l.meta && typeof l.meta.layer === 'string' && l.meta.layer) || null;
      if (!byLayer.has(key)) byLayer.set(key, []);
      byLayer.get(key).push(l);
    }
    const names = [...byLayer.keys()].filter((k) => k !== null)
      .sort((a, b) => a.localeCompare(b, 'zh'));
    if (byLayer.has(null)) names.push(null);
    return names.map((k) => ({ layer: k, lines: byLayer.get(k).sort((a, b) => (a.id < b.id ? -1 : 1)) }));
  }

  /** 线路显示顺序（查看器左栏序，2026-11-22 需求 5）规范化（纯逻辑，node 单测覆盖）。
   *  order＝manifest.lineOrder 存的原始数组（可缺失/含已删线 id/杂物），lineIds＝当前全部线 id；
   *  返回完整覆盖 lineIds 的新数组：先按 order 中出现的合法 id（去重、保序）排列，
   *  未列出的线按 id 升序补到末尾（新建线即此路径自然落末尾）。
   *  order 非数组/为空＝全部按 id 升序（缺省回退，与现状顺序一致）。
   *  编辑器侧 S.lineOrder 只存原始值、用时经本函数取生效顺序——按文件零散载入
   *  （manifest 先于线路文件到达）不会误清尚未载入的线 id。 */
  function normalizeLineOrder(order, lineIds) {
    const ids = [...(lineIds || [])];
    const known = new Set(ids);
    const out = [];
    if (Array.isArray(order)) {
      for (const x of order) {
        if (typeof x === 'string' && known.has(x) && !out.includes(x)) out.push(x);
      }
    }
    for (const id of ids.slice().sort()) {   // id 定长 lNNNN，字典序＝升序
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  /** manifest.archived（归档线 id 表，防编号复用）的规范化（纯逻辑，node 单测覆盖）。
   *  prev＝上一份 manifest 的 archived（可缺失），lines＝当前全部线：当前归档的补入、
   *  **已取消归档的必须摘除**——留着即 validate 报「archived id is also an active line」，
   *  flatten 又按归档表把这条线整条剔除（2026-11-22 抓包：l0061 取消归档后查看器里
   *  仍不见）。已不在 lines 里的历史 id 原样保留（编号永不复用）。返回升序数组。 */
  function archivedIdList(prev, lines) {
    const ids = new Set(Array.isArray(prev) ? prev.filter((x) => typeof x === 'string') : []);
    for (const l of lines || []) {
      if (l && l.meta && l.meta.archived) ids.add(l.id);
      else if (l && l.id) ids.delete(l.id);
    }
    return [...ids].sort();
  }

  /** 「预控通道」类别（meta.layer＝源图 Line 直属子图层名原样转写）：该类线不设站——建线默认
   *  远期、无需加站即整线显示（2026-11-22 用户说明；查看器侧另有 联络线/他省 的类别裁定） */
  const LAYER_RESERVED = '预控通道';

  /** 换乘节点组列表的搜索与分页（纯逻辑，node 单测覆盖；2026-11-22 用户需求：每页 8 个＋搜索框）。
   *  query 按空白拆词、不区分大小写、逐词「包含」且全部命中才算匹配（AND）；空 query＝全部命中。 */
  function searchTermsOf(q) {
    return String(q == null ? '' : q).toLowerCase().split(/\s+/).filter(Boolean);
  }
  function matchesTerms(text, terms) {
    const low = String(text == null ? '' : text).toLowerCase();
    return (terms || []).every((t) => low.includes(t));
  }
  /** 组 → 可检索文本：组号、类型（与列表下拉同款中文标签）、成员站的站号／站名／所属线路 id 与线名。
   *  stopInfoOf(sid) 由调用方注入 → {lineId, lineName, stopName}（查不到返回 undefined 也不崩）。 */
  const GROUP_TYPE_TEXT = { 'same-station': '同站', 'out-of-station': '出闸', junction: '接轨站', '': 'type 未定' };
  function groupSearchText(group, stopInfoOf) {
    const g = group || {};
    const parts = [g.id, GROUP_TYPE_TEXT[g.type || '']];
    for (const sid of g.stops || []) {
      const o = stopInfoOf ? stopInfoOf(sid) : null;
      parts.push(sid, o ? `${o.lineId || ''} ${o.lineName || ''} ${o.stopName || ''}` : '');
    }
    return parts.join('\n');
  }
  /** 列表分页切片：返回 {rows, page, pages}，page 越界/非整数回正到 [1, pages]（空列表 pages=1）。 */
  function pageSlice(rows, page, size) {
    const all = rows || [];
    const n = Math.max(1, Math.floor(size) || 1);
    const pages = Math.max(1, Math.ceil(all.length / n));
    const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
    return { rows: all.slice((p - 1) * n, p * n), page: p, pages };
  }

  // ---------- 画布增量渲染的判脏键（纯比对逻辑，node 单测覆盖；界面层 lineStale 据此决定某线是否重建） ----------
  /** 是否「预控通道」类线：不设站，站数<2 时整线单段显示（2026-11-22 用户说明，仅限该类别） */
  function isReservedLine(line) {
    return !!(line && line.meta && line.meta.layer === LAYER_RESERVED);
  }
  /** 各站间段的绘制状态（＝sections[segments[i]].status，缺记录/非法值兜底 existing）；站数<2 为空表。
   *  段数与 flatten 同口径：非环线 n 站 n-1 段、环线 n 段（末段环绕）。画布绘制与判脏共用 */
  function segStatusesOf(line) {
    const stops = line.stops || [], segs = line.segments || [], secs = line.sections || [];
    const n = stops.length, cnt = n < 2 ? 0 : (line.loop ? n : n - 1), out = [];
    for (let i = 0; i < cnt; i++) {
      const sec = secs[segs[i]];
      out.push(sec && SEG_ORDER.includes(sec.status) ? sec.status : 'existing');
    }
    return out;
  }
  /** 线路「画法输入」比对键：线级字段 path/loop/color/role/status/是否预控通道＋逐站 [id,t,name,kind,
   *  所属组键]＋各站间段绘制状态。grpKeyOf：sid -> 所属换乘组的 `${id}|${type}|${h|v}`（无组可缺；
   *   id/type＝**直属**组，决定出闸黑边与提示文本；h/v＝站圈是否被绘制单元吸收隐去——嵌套组下
   *   上级组类型、子组关系的变化只经这一位影响本线画法，2026-11-23）。
   *  **给线路绘制新增数据依赖时必须同步补进这里**，否则改了数据画布不更新（联络线的目标集与
   *  几何代际依赖别的线，另由界面层比对）。 */
  function lineDrawKey(line, grpKeyOf) {
    const stops = line.stops || [], stopKeys = new Array(stops.length);
    for (let i = 0; i < stops.length; i++) {
      const a = stops[i];
      stopKeys[i] = [a.id, a.t, a.name, a.kind, (grpKeyOf ? grpKeyOf.get(a.id) : '') || ''];
    }
    return { path: line.path, loop: !!line.loop, color: line.color, role: line.role, status: line.status,
      reserved: isReservedLine(line), stopKeys, segStatus: segStatusesOf(line) };
  }
  /** 两个比对键是否等价（等价＝画法不变，已画的 DOM 可原样复用）。逐字段值比较，与对象身份无关 */
  function sameLineDraw(a, b) {
    if (a === b) return true;
    if (!a || !b || a.path !== b.path || a.loop !== b.loop || a.color !== b.color || a.role !== b.role
      || a.status !== b.status || a.reserved !== b.reserved) return false;
    const x = a.stopKeys, y = b.stopKeys;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      const p = x[i], q = y[i];
      if (p[0] !== q[0] || p[1] !== q[1] || p[2] !== q[2] || p[3] !== q[3] || p[4] !== q[4]) return false;
    }
    const sx = a.segStatus, sy = b.segStatus;
    if (sx.length !== sy.length) return false;
    for (let i = 0; i < sx.length; i++) if (sx[i] !== sy[i]) return false;
    return true;
  }

  /** 接轨站（stationGroups type:'junction'）合并圈描边色：按成员线角色优先级取色，
   *  main > standalone > branch > connector（main 胜 branch、非联络线胜联络线为用户明定；
   *  standalone 与 branch 的先后为本实现假设，待用户确认）。
   *  members 传 [{role, color}]；同优先级取先出现者，无可用成员线颜色时退回 '#000'。 */
  const ROLE_RANK = { main: 0, standalone: 1, branch: 2, connector: 3 };
  function junctionStroke(members) {
    let bestRank = Infinity, bestColor = null;
    for (const m of members || []) {
      const rank = ROLE_RANK[m && m.role];
      if (rank === undefined) continue;
      if (rank < bestRank && m.color) { bestRank = rank; bestColor = m.color; }
    }
    return bestColor || '#000';
  }

  /** 联络线有效目标判定（2026-11-22 用户裁定：联络线取消颜色属性，颜色由所联络的两条线决定）。
   *  line.role==='connector' 且 connects 数组去重后 ≥2 个 id 经 resolve(id) 能取到可判定目标
   *  （编辑器侧约定 resolve 返回 {lid,color,ap}：线存在于 S.lines、有 color、arcOf 几何可解析；
   *  查看器侧可按同规则类比注入）——不足 2 条即「信息未填写完全」，判无效（渲染端兜底深灰
   *  CONNECTOR_FALLBACK）。返回有效目标数组（保持 connects 书写序、去重）；connects ≥3 时
   *  全数返回、由渲染端按「距本线首/末端最近」各取其一着色，其余忽略（用户裁定）。
   *  非 connector 或 connects 非数组一律 []。 */
  function connValidTargets(line, resolve) {
    if (!line || line.role !== 'connector' || !Array.isArray(line.connects)) return [];
    const seen = new Set();
    const out = [];
    for (const id of line.connects) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      const t = resolve ? resolve(id) : null;
      if (t) out.push(t);
    }
    return out.length >= 2 ? out : [];
  }

  /** 建组类型判定（拉框/点选攒组共用；node 单测覆盖）。
   *  kinds＝候选成员的 stop.kind 列表（'block'＝线路所，'arrow'＝出省箭头，其余/null＝普通车站）：
   *  含出省箭头 → 一律拒绝（ok:false, reason:'arrow'——箭头不是站点，不可编组，全箭头也不行）；
   *  含线路所 → 组类型强制 junction（接轨站）且成员必须全为线路所；
   *  线路所与普通车站混选 → 拒绝（ok:false, reason:'mixed'）；
   *  全普通车站 → 默认 same-station（既有行为不变）。
   *  nGroups（嵌套组 2026-11-23；可缺省）＝待编组里「既有顶层组」的个数：**子组不参与类型判定**
   *  （外层组的类型＝直属站与各子组整体之间的关系，出省箭头/线路所规则只看直属站 kinds），仅用于
   *  「成员单位总数（直属站＋子组）≥2」把门——传入时不足 2 拒绝（ok:false, reason:'few'）；
   *  不传则沿用「≥2 由调用方把门」的既有约定。 */
  function planStationGroup(kinds, nGroups) {
    const arr = kinds || [];
    if (arr.some((k) => k === 'arrow')) return { ok: false, reason: 'arrow' };
    if (nGroups !== undefined && arr.length + Math.max(0, nGroups | 0) < 2) return { ok: false, reason: 'few' };
    const nBlock = arr.filter((k) => k === 'block').length;
    if (nBlock > 0 && nBlock < arr.length) return { ok: false, reason: 'mixed' };
    if (nBlock > 0) return { ok: true, type: 'junction', allBlock: true };
    return { ok: true, type: 'same-station', allBlock: false };
  }

  // ---------- 嵌套换乘组（2026-11-23 用户裁定「换乘组可以再把另一个组当成员」；纯逻辑，node 单测覆盖） ----------
  // 数据：stationGroups 每项可选 groups:[子组 id]（缺省视同 []；为空不写出）；stops 恒为该组的**直属**设站。
  // 约束：一个组至多一个父组、不成环、不自引、子组 id 须存在；成员单位总数（直属站＋子组）≥2。
  // 以下各函数对破损数据一律防御（不死循环、其余部分照常渲染），不擅自改写数据。
  /** 组树索引：返回 { byId, parentOf, childrenOf, issues }——parentOf＝子组 id → 父组 id；
   *  childrenOf＝组 id → 有效子组 id（保持 groups 书写序）。未知子组 id／自引／非字符串项忽略，
   *  重复引用去重；一个组至多一个父组——已被认领的子组再被引用时**后到的引用忽略**（先到者胜）。
   *  以上各项记入 issues（中文串，供界面提示；不影响返回的索引）。 */
  function groupTree(stationGroups) {
    const list = Array.isArray(stationGroups) ? stationGroups : (stationGroups ? [stationGroups] : []);
    const byId = new Map();
    for (const g of list) if (g && typeof g.id === 'string') byId.set(g.id, g);
    const parentOf = new Map(), childrenOf = new Map(), issues = [];
    for (const g of list) {
      if (!g || typeof g.id !== 'string') continue;
      const kids = [];
      const raw = Array.isArray(g.groups) ? g.groups : [];
      for (const cid of raw) {
        if (typeof cid !== 'string' || !cid) { issues.push(`${g.id}：子组 id 非法（已忽略）`); continue; }
        if (cid === g.id) { issues.push(`${g.id}：引用自身为子组（已忽略）`); continue; }
        if (!byId.has(cid)) { issues.push(`${g.id}：子组 ${cid} 不存在（已忽略）`); continue; }
        if (kids.includes(cid)) continue;                      // 重复引用：去重，不算问题
        if (parentOf.has(cid)) {                               // 多父：先到者胜
          issues.push(`${cid}：同时被 ${parentOf.get(cid)} 与 ${g.id} 引用为子组（按 ${parentOf.get(cid)} 计）`);
          continue;
        }
        parentOf.set(cid, g.id);
        kids.push(cid);
      }
      childrenOf.set(g.id, kids);
    }
    return { byId, parentOf, childrenOf, issues };
  }
  /** 是否最外层组（没有上级的组）。parentOf 是「每组至多一个父组」的函数关系：无上级即最外层；
   *  成环（A→B→A）时环上每个组都有上级，自然都不算最外层，无需另做环检测。gid 不存在视同最外层 */
  function groupIsRoot(tree, gid) {
    return !tree.parentOf.has(gid);
  }
  /** 组的全部叶站（直属站＋所有子孙组的直属站）：深度优先，直属站在前、子组按 groups 书写序。
   *  走过的组不再进入（成环防御）；设站 id 原样带出，存在性由调用方按线路解析 */
  function groupLeafStops(tree, gid) {
    const out = [], seen = new Set();
    const walk = (id) => {
      if (seen.has(id)) return;
      seen.add(id);
      const g = tree.byId.get(id);
      if (!g) return;
      const stops = Array.isArray(g.stops) ? g.stops : [];
      for (const sid of stops) out.push(sid);
      for (const cid of tree.childrenOf.get(id) || []) walk(cid);
    };
    walk(gid);
    return out;
  }
  /** 绘制单元规划（用户 2026-11-23 确认的渲染规则；编辑器画布与查看器同此，逐条对应）。
   *  节点＝最外层组，画法由最外层组的 type 决定；「绘制单元」＝按自身规则画出一个（或一组）图形的组：
   *  · same-station 单元：全部叶站合成一个换乘符号，**吸收**子组（内层组不单独出图形）；叶站站圈隐去；
   *  · junction 单元：既有画法（合并普通尺寸圈），成员递归取全部叶站，同样吸收子组；叶站站圈隐去；
   *  · out-of-station 单元：直属站各自一个黑边圈（不并点，由线路渲染按直属组类型描边），**不吸收**——
   *    每个子组自成绘制单元，按自身 type 递归套用本规则；
   *  · type 未定（null／非法值）沿用现行处理（不出合并图形），结构上同 out-of-station：子组各自成单元。
   *  被吸收的组、以及成环等破损数据下没有最外层祖先的组都不是绘制单元。
   *  返回 { tree, units:[绘制单元组 id，保持 stationGroups 书写序], unitSet:Set(同上),
   *        hidden:Set(被吸收的叶站 sid), leafOf:Map(单元组 id → 叶站 sid 数组) } */
  function groupDrawPlan(stationGroups) {
    const list = Array.isArray(stationGroups) ? stationGroups : [];
    const tree = groupTree(stationGroups);
    const absorbs = (g) => g.type === 'same-station' || g.type === 'junction';
    const isUnit = new Set(), queue = [];
    for (const g of list) {
      if (g && typeof g.id === 'string' && groupIsRoot(tree, g.id)) { isUnit.add(g.id); queue.push(g.id); }
    }
    while (queue.length) {                        // 自顶向下：吸收型单元的子组不成单元，其余单元的子组成单元
      const g = tree.byId.get(queue.shift());
      if (absorbs(g)) continue;
      for (const cid of tree.childrenOf.get(g.id) || []) {
        if (!isUnit.has(cid)) { isUnit.add(cid); queue.push(cid); }
      }
    }
    const units = [], unitSet = new Set(), hidden = new Set(), leafOf = new Map();
    for (const g of list) {
      if (!g || !isUnit.has(g.id)) continue;
      const leafs = groupLeafStops(tree, g.id);
      units.push(g.id);
      unitSet.add(g.id);
      leafOf.set(g.id, leafs);
      if (absorbs(g)) for (const sid of leafs) hidden.add(sid);
    }
    return { tree, units, unitSet, hidden, leafOf };
  }
  /** 药丸线数口径（用户 2026-11-23 裁定「支线算一条，联络线不算线」；适用于**一切** same-station 单元，
   *  含不嵌套的普通同站组，取代旧「按 distinct lineId 计」）。
   *  lines＝单元叶站所属的线对象列表；lineGroups＝groups.json 的 lineGroups（可缺省）。
   *  role==='connector' 的线不计；同一线组内的线算一条——线组归属取双向并集（线文件 groupId 指向 ＋
   *  线组 members 声明，与 flatten/查看器的归并同口径；两处皆无的线各自成一条）。返回去重后的逻辑线数。
   *  allLines＝全部线对象（界面层必传）：线组须有 role==='main' 的成员才把成员并成一条——没有主线的线组
   *  （如只为捆绑展示而建的线族）成员各算一条，与查看器 buildLineGroups「无 main 不归并」同口径；
   *  缺省时不作此判（仅单测直接调用）。 */
  function logicalLineCount(lines, lineGroups, allLines) {
    const declared = new Map();                   // lid → 线组 id（members 声明；先声明者胜）
    const known = new Set();                      // 线组表里实际存在的线组 id
    for (const lg of Array.isArray(lineGroups) ? lineGroups : []) {
      if (!lg || typeof lg.id !== 'string') continue;
      known.add(lg.id);
      for (const m of Array.isArray(lg.members) ? lg.members : []) {
        if (typeof m === 'string' && !declared.has(m)) declared.set(m, lg.id);
      }
    }
    const withMain = new Set();                   // 有主线成员的线组（传入全表时才判；无 main 的线组不归并）
    if (Array.isArray(allLines)) {
      for (const l of allLines) {
        if (!l || l.role !== 'main') continue;
        if (typeof l.groupId === 'string' && known.has(l.groupId)) withMain.add(l.groupId);
        const d = declared.get(l.id);
        if (d) withMain.add(d);
      }
    }
    const keys = new Set();
    for (const l of Array.isArray(lines) ? lines : []) {
      if (!l || l.role === 'connector') continue;
      const own = typeof l.groupId === 'string' && l.groupId ? l.groupId : null;
      let gid = (own && known.has(own)) ? own : (declared.get(l.id) || null);   // 孤儿 groupId 不归并（同 flatten/查看器）
      if (Array.isArray(allLines) && gid && !withMain.has(gid)) gid = null;
      keys.add(gid ? 'g:' + gid : 'l:' + l.id);
    }
    return keys.size;
  }
  /** 绘制单元画不画药丸（2026-11-23 用户裁定「上级组无论有几个站圆，都按多线站生成药丸」）：带子组的
   *  同站／接轨单元一律药丸、不论线数；平铺的同站单元按逻辑线数 ≥3（见 logicalLineCount）；接轨单元不画。
   *  shape:"pill"（2026-11-23）：同站组显式强制药丸——平行线双线站大圆悬浮对策，不论线数
   *  （仅 same-station 生效；validate 禁其他类型写 shape）。
   *  g＝单元组对象；kids＝其子组 id 列表；lines／lineGroups／allLines 同 logicalLineCount。 */
  function unitIsPill(g, kids, lines, lineGroups, allLines) {
    if (!g || (g.type !== 'same-station' && g.type !== 'junction')) return false;
    if (g.shape === 'pill' && g.type === 'same-station') return true;
    if (Array.isArray(kids) && kids.length) return true;
    return g.type === 'same-station' && logicalLineCount(lines, lineGroups, allLines) >= 3;
  }
  // ---------- 「两站分离」筛选（2026-11-23 用户裁定·shape:"pill" 配套） ----------
  // 双线同站组两站心不重合（手放站未必压在交叉点上）：换乘大圆圆心＝均值、半径屏幕恒定，
  // 放大后圆悬在两线之间。组列表筛选列出这类候选（两站心相距 >50m），供逐个改「画法：药丸」。
  /** 两点（[lon,lat] 经纬度）地表距离米（haversine；纯逻辑，node 单测覆盖） */
  function haversineM(a, b) {
    const R = 6371008.8, rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLon / 2);
    const h = s1 * s1 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  /** 组内直属站两两（画板坐标经标定换经纬度后）地表距离的最大值（米）；无标定或任一站定不了位
   *  返回 null（候选判定按「未知」不入选，不误报）。posOf/标定注入，纯逻辑，node 单测覆盖；
   *  forward 缺省用模块内 calibForward（单测注入线性假变换，不依赖真 TPS 标定数据） */
  function groupSplitMeters(g, posOf, calib, forward) {
    if (!g || !Array.isArray(g.stops) || g.stops.length < 2 || !calib) return null;
    const fwd = forward || calibForward;
    let best = null;
    for (let i = 0; i < g.stops.length; i++) {
      const p1 = posOf(g.stops[i]);
      if (!p1) return null;
      const c1 = fwd(calib, p1[0], p1[1]);
      for (let j = i + 1; j < g.stops.length; j++) {
        const p2 = posOf(g.stops[j]);
        if (!p2) return null;
        const d = haversineM(c1, fwd(calib, p2[0], p2[1]));
        if (best == null || d > best) best = d;
      }
    }
    return best;
  }
  /** 「两站分离」候选：same-station、恰 2 条逻辑线（药丸线数口径）、两站心相距 >50m。
   *  ≥3 逻辑线已是药丸不必列；出闸／接轨组不在此列（裁定场景＝双线换乘站）。 */
  const SPLIT_M = 50;
  function isSplitGroup(g, lines, posOf, calib, lineGroups, allLines, forward) {
    if (!g || g.type !== 'same-station' || !calib) return false;
    if (logicalLineCount(lines, lineGroups, allLines) !== 2) return false;
    const m = groupSplitMeters(g, posOf, calib, forward);
    return m != null && m > SPLIT_M;
  }
  /** 设站的「所属组」判脏键（lineDrawKey 的逐站组键；纯逻辑，node 单测覆盖）：
   *  `${直属组 id}|${直属组 type}|${h|v}`——直属组决定出闸黑边与提示文本；h＝站圈被绘制单元吸收隐去。
   *  嵌套组下上级组类型、子组关系、子组成员的变化，对本线画法的影响全部落在 h/v 这一位上。 */
  function stopGroupKey(group, hidden) {
    return group.id + '|' + (group.type || '') + '|' + (hidden ? 'h' : 'v');
  }
  /** 绘制单元的判脏键（纯逻辑，node 单测覆盖；界面层 syncGroupShapes 据此决定是否重建该单元的符号）。
   *  members＝单元全部叶站的成员记录 [{line, st}]，kids＝子组 id 列表。输入任一变化键即变：
   *  自身类型、药丸/大圈档位（线数口径的结论）、几何代际、联络线目标摘要、线组表摘要、子组名单、
   *  逐叶站的 [线 id, t, 站名, kind, 角色, 色, 线组归属]。
   *  **给单元绘制新增数据依赖时必须同步补进这里**，否则改了数据画布不更新。 */
  function groupUnitSig(type, isPill, geomGen, connDigest, lgDigest, kids, members) {
    return type + '|' + isPill + '|' + geomGen + '|' + connDigest + '|' + lgDigest + '|' + (kids || []).join('.')
      + (members || []).map((m) => `|${m.line.id}:${m.st.t}:${m.st.name}:${m.st.kind || ''}:${m.line.role}:${m.line.color}:${m.line.groupId || ''}`).join('');
  }
  /** 组的成员单位总数（直属站＋子组；约束 ≥2，拆组/删站后的自动拆除依据） */
  function groupUnitCount(g) {
    return (Array.isArray(g && g.stops) ? g.stops.length : 0) + (Array.isArray(g && g.groups) ? g.groups.length : 0);
  }
  /** 沿上级链级联拆除：seeds＝刚被删的组 id。逐个找到仍把它列为子组的上级，摘除引用（groups 删空即删字段）；
   *  摘除后成员单位总数不足 2 的上级一并拆除（其直属站恢复未编组、其余子组升为顶层），并以它为新 seed
   *  继续向上。就地改写 list；返回连带拆除的组 id（不含 seeds，按拆除先后）。 */
  function cascadeStationGroups(list, seeds) {
    const out = [], queue = [...(seeds || [])];
    while (queue.length) {
      const gone = queue.shift();
      for (const p of list) {
        if (!p || !Array.isArray(p.groups) || !p.groups.includes(gone)) continue;
        p.groups = p.groups.filter((x) => x !== gone);
        if (!p.groups.length) delete p.groups;   // 为空不写出
        if (groupUnitCount(p) < 2) {
          list.splice(list.indexOf(p), 1);
          out.push(p.id);
          queue.push(p.id);
        }
      }
    }
    return out;
  }
  /** 组表修剪（删站后调用；取代旧「stops 不足 2 即删」的过滤）：成员单位总数不足 2 的组全部拆除，
   *  再自被拆的组沿上级链级联（cascadeStationGroups）。就地改写 list，返回被拆除的组 id（先直拆、后级联）。 */
  function pruneStationGroups(list) {
    const removed = [];
    for (let i = 0; i < (list || []).length; i++) {
      if (groupUnitCount(list[i]) < 2) { removed.push(list[i].id); list.splice(i, 1); i--; }
    }
    return removed.concat(cascadeStationGroups(list, removed));
  }
  /** 载入规范化（`groups` 字段全程保留不丢的入口；node 单测覆盖）：groups 须为字符串数组——非数组视同 []，
   *  非字符串/空串项丢弃、重复去重；**为空不保留该字段**（旧数据无此字段往返不变，保存时不写出）。
   *  只动 groups 字段（引用是否存在、是否成环等交由校验与组树工具防御，不在此改写）；返回是否有改动。 */
  function normalizeStationGroups(stationGroups) {
    let changed = false;
    for (const g of Array.isArray(stationGroups) ? stationGroups : []) {
      if (!g || typeof g !== 'object') continue;
      const raw = g.groups;
      if (raw === undefined) continue;
      const out = [];
      for (const cid of Array.isArray(raw) ? raw : []) {
        if (typeof cid === 'string' && cid && !out.includes(cid)) out.push(cid);
      }
      if (out.length) {
        if (!Array.isArray(raw) || out.length !== raw.length) { g.groups = out; changed = true; }
      } else { delete g.groups; changed = true; }
    }
    return changed;
  }
  /** 待编组里的既有组能否编入上层（纯逻辑，node 单测覆盖）：须是存在的**顶层组**。
   *  返回问题列表 [{ id, reason:'missing'|'parent', parent }]（parent＝其上级组 id），空＝全部可用。 */
  function pendingGroupIssues(tree, groupIds) {
    const out = [];
    for (const gid of groupIds || []) {
      if (!tree.byId.has(gid)) out.push({ id: gid, reason: 'missing', parent: null });
      else if (tree.parentOf.has(gid)) out.push({ id: gid, reason: 'parent', parent: tree.parentOf.get(gid) });
    }
    return out;
  }

  /** 多线换乘药丸串法（同站组 ≥3 线画药丸用；确定性，与查看器侧逐字节同规格——两边必须一致）。
   *  对每个起点 s∈[0,n) 各跑一次贪心最近邻：每步取距链尾最近的未入链点（按欧氏距离，
   *  平手取下标小者），得链 order 与总长 total（相邻点欧氏距离之和，n 点连线 n-1 次，非两两相连）；
   *  取 total 最小者，平手取 order 序列字典序最小者。返回下标顺序数组；n≤2 返回原序 [0..n-1]。 */
  function planGroupPillChain(pts) {
    const arr = pts || [];
    const n = arr.length;
    if (n <= 2) return Array.from({ length: n }, (_, k) => k);
    const d2 = (a, b) => {
      const dx = arr[a][0] - arr[b][0], dy = arr[a][1] - arr[b][1];
      return dx * dx + dy * dy;   // 贪心步内比较与真距离同序（单调），免开方
    };
    const lexLess = (u, v) => {
      for (let k = 0; k < u.length; k++) { if (u[k] !== v[k]) return u[k] < v[k]; }
      return false;
    };
    let best = null;
    for (let s = 0; s < n; s++) {
      const order = [s];
      const used = new Set([s]);
      let total = 0;
      while (order.length < n) {
        const tail = order[order.length - 1];
        let bi = -1, bd = Infinity;
        for (let j = 0; j < n; j++) {          // j 升序＋严格 < ＝平手取下标小者
          if (used.has(j)) continue;
          const d = d2(tail, j);
          if (d < bd) { bd = d; bi = j; }
        }
        order.push(bi);
        used.add(bi);
        total += Math.sqrt(bd);                // 总长按真欧氏距离累计（与查看器同式）
      }
      if (!best || total < best.total
        || (total === best.total && lexLess(order, best.order))) {
        best = { order, total };
      }
    }
    return best.order;
  }

  // ---------- 标定变换与瓦片数学（fmt/calibration@1 deg3 / fmt/calibration@2 tps；node 单测覆盖往返与 Python 对拍） ----------
  // 多项式基次序与 tools/georef.py 的 features(deg=3) 一致：1,u,v,u²,uv,v²,u³,u²v,uv²,v³
  function poly3Basis(u, v) {
    return [1, u, v, u * u, u * v, v * v, u * u * u, u * u * v, u * v * v, v * v * v];
  }
  function calibEval(c, u, v) {
    const w = poly3Basis(u, v);
    let s = 0;
    for (let i = 0; i < c.length; i++) s += c[i] * w[i];
    return s;
  }
  /** deg3 正向：SVG 世界坐标 → [lon, lat] */
  function poly3Forward(calib, x, y) {
    const u = (x - calib.uv.cx) / calib.uv.scale;
    const v = (y - calib.uv.cy) / calib.uv.scale;
    return [calibEval(calib.coef.lon, u, v), calibEval(calib.coef.lat, u, v)];
  }
  /** deg3 反向：[lon, lat] → SVG。仿射初值 + 牛顿迭代（数值雅可比）；不收敛返回 null */
  function poly3Inverse(calib, lon, lat) {
    const a0 = calib.coef.affineLon[0], a1 = calib.coef.affineLon[1], a2 = calib.coef.affineLon[2];
    const b0 = calib.coef.affineLat[0], b1 = calib.coef.affineLat[1], b2 = calib.coef.affineLat[2];
    const det = a1 * b2 - a2 * b1;
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
    const gl = lon - a0, gt = lat - b0;
    let u = (gl * b2 - gt * a2) / det;
    let v = (gt * a1 - gl * b1) / det;
    for (let it = 0; it < 30; it++) {
      const fl = calibEval(calib.coef.lon, u, v) - lon;
      const ft = calibEval(calib.coef.lat, u, v) - lat;
      if (Math.hypot(fl, ft) < 1e-11) break;
      const h = 1e-6, cL = calib.coef.lon, cT = calib.coef.lat;
      const fl_u = (calibEval(cL, u + h, v) - calibEval(cL, u - h, v)) / (2 * h);
      const fl_v = (calibEval(cL, u, v + h) - calibEval(cL, u, v - h)) / (2 * h);
      const ft_u = (calibEval(cT, u + h, v) - calibEval(cT, u - h, v)) / (2 * h);
      const ft_v = (calibEval(cT, u, v + h) - calibEval(cT, u, v - h)) / (2 * h);
      const J = fl_u * ft_v - fl_v * ft_u;
      if (!isFinite(J) || Math.abs(J) < 1e-18) return null;
      u -= (fl * ft_v - ft * fl_v) / J;
      v -= (ft * fl_u - fl * ft_u) / J;
      if (!isFinite(u) || !isFinite(v)) return null;
    }
    return [u * calib.uv.scale + calib.uv.cx, v * calib.uv.scale + calib.uv.cy];
  }
  // ---- TPS（fmt/calibration@2，tools/calib2_fit.py 产物；与 零散/calib2_lib.py 同式）----
  // f(x,y) = affine(uk,vk) + Σ w_i·U(d2)，U(r2)=r2·ln r2（d2 为 km² 坐标距离，km = svg×scaleToKm）
  const TPS_CACHE = new WeakMap();   // calib 对象 → 展平缓存（不随 JSON 序列化）
  function tpsCache(calib) {
    let c = TPS_CACHE.get(calib);
    if (!c) {
      const cps = calib.controlPoints || [];
      const n = cps.length;
      const kx = new Float64Array(n), ky = new Float64Array(n);
      const wl = new Float64Array(n), wt = new Float64Array(n);
      const k = (calib.kernel && calib.kernel.scaleToKm) || 0.00972;
      for (let i = 0; i < n; i++) {
        kx[i] = cps[i][0] * k; ky[i] = cps[i][1] * k;
        wl[i] = cps[i][2]; wt[i] = cps[i][3];
      }
      c = { n, kx, ky, wl, wt, k, aL: calib.affine.lon, aT: calib.affine.lat };
      TPS_CACHE.set(calib, c);
    }
    return c;
  }
  /** TPS 正向：SVG 世界坐标 → [lon, lat] */
  function tpsForward(calib, x, y) {
    const c = tpsCache(calib);
    const uk = x * c.k, vk = y * c.k;
    let lon = c.aL[0] + c.aL[1] * uk + c.aL[2] * vk;
    let lat = c.aT[0] + c.aT[1] * uk + c.aT[2] * vk;
    for (let i = 0; i < c.n; i++) {
      const dx = uk - c.kx[i], dy = vk - c.ky[i];
      const d2 = dx * dx + dy * dy;
      if (d2 > 1e-12) { const U = d2 * Math.log(d2); lon += c.wl[i] * U; lat += c.wt[i] * U; }
    }
    return [lon, lat];
  }
  /** TPS 反向：[lon, lat] → SVG。affine 初值 + 牛顿迭代（解析雅可比，dU/dd2 = ln d2 + 1）；不收敛返回 null */
  function tpsInverse(calib, lon, lat) {
    const c = tpsCache(calib);
    const det = c.aL[1] * c.aT[2] - c.aL[2] * c.aT[1];
    if (!isFinite(det) || Math.abs(det) < 1e-15) return null;
    const gl = lon - c.aL[0], gt = lat - c.aT[0];
    let uk = (gl * c.aT[2] - gt * c.aL[2]) / det;
    let vk = (gt * c.aL[1] - gl * c.aT[1]) / det;
    for (let it = 0; it < 50; it++) {
      let fl = c.aL[0] + c.aL[1] * uk + c.aL[2] * vk - lon;
      let ft = c.aT[0] + c.aT[1] * uk + c.aT[2] * vk - lat;
      let fl_u = c.aL[1], fl_v = c.aL[2], ft_u = c.aT[1], ft_v = c.aT[2];
      for (let i = 0; i < c.n; i++) {
        const dx = uk - c.kx[i], dy = vk - c.ky[i];
        const d2 = dx * dx + dy * dy;
        if (d2 > 1e-12) {
          const lg = Math.log(d2), U = d2 * lg, g = 2 * (lg + 1);
          fl += c.wl[i] * U; ft += c.wt[i] * U;
          fl_u += c.wl[i] * g * dx; fl_v += c.wl[i] * g * dy;
          ft_u += c.wt[i] * g * dx; ft_v += c.wt[i] * g * dy;
        }
      }
      if (Math.hypot(fl, ft) < 1e-12) break;
      const J = fl_u * ft_v - fl_v * ft_u;
      if (!isFinite(J) || Math.abs(J) < 1e-18) return null;
      uk -= (fl * ft_v - ft * fl_v) / J;
      vk -= (ft * fl_u - fl * ft_u) / J;
      if (!isFinite(uk) || !isFinite(vk)) return null;
    }
    return [uk / c.k, vk / c.k];
  }
  /** 标定正向（按 model 分派）：SVG 世界坐标 → [lon, lat] */
  function calibForward(calib, x, y) {
    return calib.model === 'tps' ? tpsForward(calib, x, y) : poly3Forward(calib, x, y);
  }
  /** 标定反向（按 model 分派）：[lon, lat] → SVG 世界坐标；不收敛返回 null */
  function calibInverse(calib, lon, lat) {
    return calib.model === 'tps' ? tpsInverse(calib, lon, lat) : poly3Inverse(calib, lon, lat);
  }
  // ---- Web Mercator 瓦片数学 ----
  function lonToTileX(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function latToTileY(lat, z) {
    const r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }
  function tileXToLon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function tileYToLat(y, z) {
    const n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  // ---------- lineinfo.md 节编辑（2026-11-23 增，纯逻辑可单测） ----------
  // lineinfo.md＝每线组一节的用户手填介绍（格式约定与解析见 viewer_core.parseLineInfo／
  // data/lineinfo.md 模板）。编辑器「线路介绍」面板按节读写该文件：**保真硬要求＝只动被
  // 编辑的那一节，文件其余部分（用户注释、节排序、空行习惯）逐字节原样保留**——因此这里
  // 不做任何行尾归一化，按「逻辑行＋原行尾符」切分处理（CRLF/LF/CR 都原样保真）。
  // 标题绑定口径与解析器一致：`## <id> <名>` 的 id＝标题内容 trim 后首个空白前 token
  //（`##   lg07  名` 同样绑 lg07）；三级标题（### 等）不算节边界、按节内容处理。
  const LI_HEAD_RE = /^##(?!#)[ \t]*(.*)$/;
  /** 逻辑行切分：split 捕获行尾符 → [行文, 行尾符, 行文, 行尾符, …, 行文]，重建原样拼回 */
  function liSplitLines(md) { return String(md == null ? '' : md).split(/(\r\n|\n|\r)/); }
  /** 标题行文本 → 线组 id（与 parseLineInfo 同口径；非标题行返回 null） */
  function liHeadingId(text) {
    const m = String(text == null ? '' : text).match(LI_HEAD_RE);
    return m ? (m[1].trim().split(/\s+/)[0] || null) : null;
  }
  /** 逻辑行数组 → 节列表 [{id, text, start, end}]：text＝标题行起到下一标题前（含中间行尾符，
   *  逐字节原样）；start/end 为逻辑行下标 [start, end)。无任何节 → [] */
  function liSections(md) {
    const parts = liSplitLines(md);
    const lines = [];
    for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i], term: i + 1 < parts.length ? parts[i + 1] : null });
    const secs = [];
    let cur = -1;
    for (let i = 0; i < lines.length; i++) {
      const id = liHeadingId(lines[i].text);
      if (id != null) {
        if (cur >= 0) secs[secs.length - 1].end = i;
        cur = i;
        secs.push({ id, text: '', start: i, end: lines.length });
      }
    }
    for (const s of secs) {
      let t = '';
      for (let i = s.start; i < s.end; i++) t += lines[i].text + (lines[i].term || '');
      s.text = t;
    }
    return secs;
  }
  /** 取某线组节原文（同 id 多节取首个；无 → null）。面板列表标记与 textarea 取值都用它 */
  function extractLineInfoSection(mdText, groupId) {
    const id = String(groupId == null ? '' : groupId).trim();
    if (!id) return null;
    const hit = liSections(mdText).find((s) => s.id === id);
    return hit ? hit.text : null;
  }
  /** 节原位替换／尾部追加（返回新串，不改入参）：
   *  - 节存在（同 id 多节全算命中）：新节替换**首个**命中节，其余命中节一并移除（解析器
   *    「同 id 多节后者覆盖」，留着旧节会让查看器继续显示旧内容）；首个命中节之前的全部字节
   *    原样保留，命中节之间的未命中节与最后一个命中节之后的全部字节同样逐字节原样保留。
   *  - 节不存在：追加到文件尾（原文件不以行尾符结尾时先补一个——沿用文件末行自己的行尾符，
   *    无行尾符记录时用 '\n'）。
   *  - mdText 为 null/空串 → 结果就是新节本身（文件不存在的新建场景，注释头由面板另行拼）。
   *  插入节不以行尾符结尾且后面还有内容时，沿用被替换节原有的末行行尾符补上（防空行吞并）。 */
  function replaceLineInfoSection(mdText, groupId, sectionText) {
    const id = String(groupId == null ? '' : groupId).trim();
    const sec = String(sectionText == null ? '' : sectionText);
    if (!id) return mdText == null ? sec : String(mdText);
    const secs = liSections(mdText);
    const hits = secs.filter((s) => s.id === id);
    if (!hits.length) {
      const src = mdText == null ? '' : String(mdText);
      if (!src) return sec;
      let out = src;
      const parts = liSplitLines(src);
      const lastTerm = parts.length >= 3 ? parts[parts.length - 2] : null;   // 末文本行自带的行尾符
      if (!/(\r\n|\n|\r)$/.test(out)) out += lastTerm || '\n';
      return out + (sec.endsWith('\n') || sec.endsWith('\r') ? sec : sec + '\n');
    }
    const parts = liSplitLines(mdText);
    const lines = [];
    for (let i = 0; i < parts.length; i += 2) lines.push({ text: parts[i], term: i + 1 < parts.length ? parts[i + 1] : null });
    const first = hits[0], lastHit = hits[hits.length - 1];
    // 新节末尾行尾符：被替换区末行原行尾符优先（保持后续内容与原文件同样的分隔习惯）
    const afterTerm = (() => { for (let i = lastHit.end - 1; i >= first.start; i--) { if (lines[i].term) return lines[i].term; } return null; })();
    let ins = sec;
    if (first.end < lines.length && !/(\r\n|\n|\r)$/.test(ins)) ins += afterTerm || '\n';
    let out = '';
    for (let i = 0; i < first.start; i++) out += lines[i].text + (lines[i].term || '');
    out += ins;
    // 首个命中节之后逐行重抄：命中节（含其余同 id 节）跳过，未命中内容逐字节照抄
    for (let i = first.start; i < lines.length; i++) {
      if (hits.some((s) => i >= s.start && i < s.end)) continue;
      out += lines[i].text + (lines[i].term || '');
    }
    return out;
  }
  /** 新节骨架（全占位符零真实内容；线组 id/名＝用户已有数据，正文与字段全是 … 占位） */
  function lineInfoSectionSkeleton(groupId, name) {
    const id = String(groupId == null ? '' : groupId).trim();
    const nm = String(name == null ? '' : name).trim();
    return '## ' + id + (nm ? ' ' + nm : '') + '\n'
      + '起讫点: …\n编组: …\n\n（正文……）\n\n### 相关链接\n[链接文字](https://…)\n';
  }
  /** 模板头（新建 lineinfo.md 用）：仓库 data/lineinfo.md 去掉自带示例节、尾部规整为恰好一个
   *  空行；模板缺失/为空/以标题开头 → 退化为中性标题行（不造任何内容） */
  function lineInfoTemplateHeader(tplText) {
    const t = tplText == null ? '' : String(tplText);
    const m = t.search(/^##[ \t]/m);
    let head = (m >= 0 ? t.slice(0, m) : t).replace(/\s+$/, '');
    if (!head.trim()) head = '# 线路信息（lineinfo.md）';
    return head + '\n\n';
  }

  const SHLogic = { SEG_ORDER, SEG_LABEL, ROLE_LABEL, EPS, segInsert, segRemove,
    pruneSections, migrateLineToV2, planSectionSplit, applySectionMerge, sectionSpanOf, sectionIssuesOf,
    canPlaceArrow, planGroupPillChain, nextStopKind, unitIsPill,
    nextStopSeq, fixStatusField, lineIssues, planBulkFill, stripConnectorColor, lineForSave,
    planStopImport, applyStopImport, suggestForStop, transferMarkForStop, conflictsForStop, backfillTransferNames,
    layerGroupsOf, junctionStroke, planStationGroup, connValidTargets,
    groupTree, groupIsRoot, groupLeafStops, groupDrawPlan, logicalLineCount, groupUnitCount,
    haversineM, groupSplitMeters, isSplitGroup,
    stopGroupKey, groupUnitSig,
    cascadeStationGroups, pruneStationGroups, normalizeStationGroups, pendingGroupIssues,
    normalizeLineOrder, archivedIdList, LAYER_RESERVED, searchTermsOf, matchesTerms, groupSearchText, pageSlice,
    isReservedLine, segStatusesOf, lineDrawKey, sameLineDraw,
    extractLineInfoSection, replaceLineInfoSection, lineInfoSectionSkeleton, lineInfoTemplateHeader,
    calibForward, calibInverse, tpsForward, tpsInverse, poly3Forward, poly3Inverse,
    lonToTileX, latToTileY, tileXToLon, tileYToLat };
  global.SHEditorLogic = SHLogic;
  if (typeof module !== 'undefined' && module.exports) module.exports = SHLogic;

  // ---------- 以下需要浏览器 DOM（node 测试模式到此为止） ----------
  if (typeof document === 'undefined') return;

  const G = global.SHGeom;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const svg = $('view');
  const world = $('world');
  const statusEl = $('status');

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, attrs, parent) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  };
  const today = () => new Date().toISOString().slice(0, 10);
  const LS_KEY = 'shrail.editor.v1';
  // 导入记录单键（2026-11-22 性能拆分）：imports 含全量 path 字符串 ≈0.5MB 且极少变化，
  // 与线路编辑共键会让每次暂存都同步重写整块 localStorage（打字停顿即卡）——拆出后仅
  // imports 实际变化（拖入/导入新源）时才写一次；boot 从 import/ 磁盘扫到的记录不置脏
  const LS_IMPS_KEY = LS_KEY + '.imports';

  // ---------- 状态 ----------
  const S = {
    lines: new Map(),        // lid -> line 对象（fmt/line@1，可直接序列化）
    groups: null,            // fmt/groups@1 或 null（首份保存时初始化）
    manifest: null,          // fmt/manifest@1 或 null
    lineOrder: null,         // 线路显示顺序（查看器左栏序）：线 id 原始数组或 null（缺省）。
                             // 只存原始值，生效顺序经 normalizeLineOrder 现算（清失效 id、补缺线到末尾）；
                             // 随 manifest.lineOrder 存取，不参与编号水位（stopSeq 等不受影响）
    imports: [],             // {source, imported, paths:[{sourceLayer,color,path}]}
    stationPresets: [],      // fmt/stations-import@2 的 items（站圆预置，只读参考数据，不进撤销/暂存）
    calib: null,             // fmt/calibration@2（model:"tps"，手动标定 TPS v2；svg→经纬度）。渲染恒用现行 calibration.json
    basemap: 'off',          // 底图三态：'off'｜'osm'｜'amap'（高德，GCJ02 逐瓦片偏移；偏好存 localStorage）
    arcs: new Map(),         // lid -> SHGeom.ArcPath
    view: null,              // {x,y,w,h}，null = 待适配内容
    mode: 'select',
    addKind: null,           // 加站拍放类型：null＝车站（缺省），'block'＝线路所（中途接轨点），'arrow'＝出省箭头
    activeLine: null,        // lid
    selStop: null,           // sid
    selImport: null,         // {source, sourceLayer}
    pending: [],             // 编组模式待选 stop id 列表
    pendingGroups: [],       // 编组模式待编入上层的**既有顶层组** id 列表（嵌套组 2026-11-23；与 pending 并存、
                             // 瞬态——同 pending 不进快照/撤销/自动暂存，切模式/Esc/清空一并清）
    lineinfoMd: null,        // lineinfo.md 当前文本（null＝工作区没有此文件且尚未生成；「线路介绍」面板编辑）
    lineinfoSavedMd: null,   // lineinfo.md 落盘基线（载入/保存成功时与 lineinfoMd 同步——两者不同＝有未保存改动）
    liTplText: null,         // 仓库 data/lineinfo.md 模板文本（新建文件拼注释头用；boot 拉取，瞬态不进暂存）
    undo: [],                // 快照栈 {lines, groups, imports}
  };
  // 编号水位（含 localStorage 持久，防删除后复用）
  const counters = { nextL: 1, nextG: 1, nextLG: 1 };
  function loadCounters() {
    try {
      const c = JSON.parse(localStorage.getItem('shrail.counters') || '{}');
      Object.assign(counters, c);
    } catch (e) { /* 忽略 */ }
  }
  function saveCounters() {
    try { localStorage.setItem('shrail.counters', JSON.stringify(counters)); }
    catch (e) { setStatus('编号水位暂存失败（存储不可用）：重开前请先保存 manifest 留水位。', true); }
  }
  function bumpCounter(key, fmt, n) {
    const id = fmt + String(counters[key]).padStart(n, '0');
    counters[key]++;
    saveCounters();
    return id;
  }
  function syncCountersWithLoaded() {
    // 已载入的既有编号同步进水位（取 max，防旧会话分配的号被再用）
    for (const lid of S.lines.keys()) {
      const n = parseInt(lid.slice(1), 10);
      if (n >= counters.nextL) counters.nextL = n + 1;
    }
    if (S.manifest) {
      for (const a of S.manifest.archived || []) {
        const n = parseInt(String(a).slice(1), 10);
        if (!isNaN(n) && n >= counters.nextL) counters.nextL = n + 1;
      }
    }
    if (S.groups) {
      for (const g of S.groups.stationGroups || []) {
        const n = parseInt(g.id.slice(1), 10);
        if (n >= counters.nextG) counters.nextG = n + 1;
      }
      for (const lg of S.groups.lineGroups || []) {
        const n = parseInt(lg.id.slice(2), 10);
        if (n >= counters.nextLG) counters.nextLG = n + 1;
      }
    }
    saveCounters();
  }

  // ---------- 撤销（快照式） ----------
  // 快照不含 imports（2026-11-22 性能修正）：imports 只经 addImportRecord 变更且不参与撤销，
  // 全量导入 path 字符串 ≈0.5MB，逐次 stringify 进 100 层撤销栈曾致录入规模上升后明显卡顿；
  // undo 因此恒保留当前 S.imports（与旧快照行为等价——快照里的 imports 从未被真正改过）
  function snapshot() {
    const s = JSON.stringify({
      lines: [...S.lines.values()],
      groups: S.groups, lineOrder: S.lineOrder,
    });
    if (S.undo.length && S.undo[S.undo.length - 1] === s) return;   // 与栈顶相同不压栈（防空转膨胀）
    S.undo.push(s);
    if (S.undo.length > 100) S.undo.shift();
  }
  function undo() {
    const snap = S.undo.pop();
    if (!snap) { setStatus('没有可撤销的操作。'); return; }
    const d = JSON.parse(snap);
    // 快照可能是升级前的 @1 数据：还原后重跑迁移（幂等），防旧格式流入渲染/保存
    for (const l of d.lines) migrateLineToV2(l);
    S.lines = new Map(d.lines.map((l) => [l.id, l]));
    S.groups = takeGroups(d.groups);
    // imports 不随快照回滚（见 snapshot 注释）；旧版快照含 imports 键亦忽略
    S.lineOrder = Array.isArray(d.lineOrder) ? d.lineOrder : null;   // 旧快照无此键＝null（回退 id 升序）
    S.arcs = reuseArcs(S.arcs, S.lines);   // path 没变的线沿用旧弧；变了的丢掉重建
    if (S.selImport && !S.imports.some((im) => im.source === S.selImport.source)) S.selImport = null;
    if (!S.lines.has(S.activeLine)) S.activeLine = null;
    S.selStop = null; S.pending = []; S.pendingGroups = [];
    renderAll(); setStatus('已撤销。');
  }

  // ---------- localStorage 暂存 ----------
  let lsTimer = null;
  let lsFailed = false;   // 最近一次暂存是否失败（beforeunload 拦截与告警依据）
  let importsDirty = false;   // imports 变化标（addImportRecord 置位；boot 磁盘扫描后清位免整块重写）
  function autosave() {
    clearTimeout(lsTimer);
    lsTimer = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          savedAt: Date.now(),
          lines: [...S.lines.values()],
          groups: S.groups, activeLine: S.activeLine,
          lineOrder: S.lineOrder,
          lineinfoMd: S.lineinfoMd, lineinfoSavedMd: S.lineinfoSavedMd,   // 线路介绍（面板编辑后随暂存，防刷新丢未保存改动）
        }));
        if (importsDirty) {   // 导入记录仅在变化时写自己的键（见 LS_IMPS_KEY 注释）
          localStorage.setItem(LS_IMPS_KEY, JSON.stringify(S.imports));
          importsDirty = false;
        }
        lsFailed = false;
      } catch (e) {
        lsFailed = true;
        setStatus('自动暂存失败（' + ((e && e.name) || '存储异常') + '）：存储不可用或已满——请立即「保存工作区」备份！', true);
      }
    }, 400);
  }
  function offerRestore() {
    let snap = null;
    try { snap = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { /* 忽略 */ }
    if (!snap || !snap.lines || !snap.lines.length) return;
    // 导入记录暂存拆键后单读（见 LS_IMPS_KEY）；旧版单键暂存里仍带 imports，缺新键时兜底
    let snapImports = null;
    try { snapImports = JSON.parse(localStorage.getItem(LS_IMPS_KEY) || 'null'); } catch (e) { /* 忽略 */ }
    if (!Array.isArray(snapImports)) snapImports = snap.imports || [];
    $('bannerTime').textContent = new Date(snap.savedAt).toLocaleString();
    $('banner').classList.add('show');
    $('btnRestore').onclick = () => {
      const notes = [];
      snap.lines = snap.lines.map((l) => {
        const note = migrateLineNote(l);   // 暂存可能是升级前存的 @1 数据
        if (note) notes.push(note);
        return l;
      });
      S.lines = new Map(snap.lines.map((l) => [l.id, l]));
      S.groups = takeGroups(snap.groups);
      // 暂存里的显示顺序较新则采用；旧暂存（功能上线前）无此键则保留 boot 时读到的 manifest 顺序
      if (Array.isArray(snap.lineOrder)) S.lineOrder = snap.lineOrder;
      // 导入记录：同名来源以刚从 import/ 磁盘载入的为准（可能比暂存新），其余保留暂存里的
      const diskSources = new Set(S.imports.map((i) => i.source));
      S.imports = snapImports.filter((i) => !diskSources.has(i.source)).concat(S.imports);
      S.activeLine = snap.activeLine && S.lines.has(snap.activeLine) ? snap.activeLine : null;
      // 线路介绍：暂存带此键（含显式 null＝当时工作区无此文件）才采用——旧暂存（功能上线前）
      // 无此键则保留 boot 时读到的 data/lineinfo.md
      if (Object.prototype.hasOwnProperty.call(snap, 'lineinfoMd')) {
        S.lineinfoMd = snap.lineinfoMd != null ? snap.lineinfoMd : null;
        S.lineinfoSavedMd = snap.lineinfoSavedMd != null ? snap.lineinfoSavedMd : null;
      }
      // 暂存不带选中/待编组态：清掉，免左栏高亮与就近提示残留；弧缓存随线路集整体替换
      // （path 没变的沿用旧弧，变了的丢弃重建——否则同 id 异 path 的线会按旧几何落站）
      S.selStop = null; S.pending = []; S.pendingGroups = [];
      S.arcs = reuseArcs(S.arcs, S.lines);
      $('banner').classList.remove('show');
      syncCountersWithLoaded(); renderAll();
      backfillTransfersOnLoad();   // 数据就绪：自动回填（免得刷新后还要再保存一次，见其注释）
      setStatus('已恢复本地暂存。' + (notes.length ? ' ' + notes.join('；') + '。' : ''));
    };
    $('btnDiscard').onclick = () => {
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(LS_IMPS_KEY);   // 导入记录暂存一并丢弃（与旧单键行为一致）
      $('banner').classList.remove('show');
    };
  }

  // ---------- 文件载入 ----------
  function readJsonFile(file) {
    return file.text().then((t) => JSON.parse(t));
  }

  function addImportRecord(rec) {
    // 同源重复载入：替换
    S.imports = S.imports.filter((i) => i.source !== rec.source);
    S.imports.push(rec);
    importsDirty = true;   // 导入记录低频大对象：标记后由 autosave 择机单键写回（见 LS_IMPS_KEY）
  }

  /** 线路对象载入统一入口的迁移环节：@1（segments 为状态字符串数组）→@2 分段实体，
   *  就地转换；返回 null（已是 @2）或中文提示（「l0001：旧版分段已转换为分段实体（N 段），保存后生效」）。
   *  兼任联络线载入规范化（stripConnectorColor：清除联络线遗留的 color，另有提示）。
   *  覆盖路径：拖入/选择 .json（loadDataObject）、工作区直读/目录读（applyWorkspace）、
   *  http 自动拉取 data/（bootFetchData）、本地暂存恢复（offerRestore）、撤销还原（undo）。 */
  function migrateLineNote(obj) {
    const n = migrateLineToV2(obj);
    // 联络线载入规范化（2026-11-23）：清除遗留的 color——validate 既有规则「connector 不得带 color」，
    // 而界面对联络线不提供颜色栏，旧数据无从改起；载入即清、下次保存自动转正
    const stripped = stripConnectorColor(obj);
    if (n) return `${obj.id}：旧版分段已转换为分段实体（${n} 段），保存后生效`;
    return stripped ? `${obj.id}：联络线不带颜色属性（颜色由所联络的两条线决定），已清除遗留的 color，保存后生效` : null;
  }
  const isLineObj = (o) => o && /^l\d{4}$/.test(o.id || '')
    && (o.schema === 'fmt/line@1' || o.schema === 'fmt/line@2');
  /** groups 对象载入统一入口的规范化环节（嵌套组 groups 字段，见 normalizeStationGroups）：
   *  覆盖路径：拖入 groups.json（loadDataObject）、工作区直读/目录读（applyWorkspace）、http 自动拉取
   *  （bootFetchData）、本地暂存恢复（offerRestore）、撤销还原（undo）。返回同一对象（缺省原样返回）。 */
  function takeGroups(obj) {
    if (obj) normalizeStationGroups(obj.stationGroups);
    return obj;
  }
  /** 当前换乘节点组表（S.groups 未初始化时为空表） */
  const stationGroupsOf = () => (S.groups && S.groups.stationGroups) || [];

  /** 站圆预置（fmt/stations-import@2，@1 同构兼容）载入：items 并入 S.stationPresets，同源替换。只读参考数据。
   *  去重键用 obj.source（内容级标识）——boot 自动拉取与手动载入同一文件不会重复堆积。 */
  function addStationPreset(obj, fileName) {
    const src = obj.source || fileName || '（未知来源）';
    S.stationPresets = S.stationPresets.filter((it) => it.presetSource !== src);
    for (const it of obj.items || []) {
      S.stationPresets.push(Object.assign({}, it, { presetSource: src }));
    }
    return (obj.items || []).length;
  }

  function parseSvgText(text, fileName) {
    // 浏览器内直接解析 SVG（与 tools/svg_parse.py --import 等效）
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('SVG 解析失败');
    const styles = {};
    for (const st of doc.querySelectorAll('style')) {
      for (const m of st.textContent.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
        const c = m[2].match(/stroke\s*:\s*(#[0-9A-Fa-f]{3,8})/);
        if (c) styles[m[1]] = c[1].toUpperCase();
      }
    }
    const paths = [];
    for (const p of doc.querySelectorAll('path')) {
      const d = p.getAttribute('d');
      if (!d || !d.trim()) continue;
      const name = (p.getAttribute('data-name') || p.getAttribute('id') || '').replace(/^_+/, '');
      const cls = (p.getAttribute('class') || '').split(/\s+/);
      const color = cls.map((c) => styles[c]).find(Boolean) || '#888888';
      paths.push({ sourceLayer: name, color: color.toUpperCase(), path: d.replace(/\s+/g, ' ').trim() });
    }
    if (!paths.length) throw new Error('SVG 中没有 path');
    return { schema: 'fmt/import@1', source: fileName, imported: today(), paths };
  }

  /** 标定文件归槽：仅认 fmt/calibration@2（model:"tps"，手动标定 TPS v2）→ S.calib。
   *  渲染恒用现行 data/calibration.json；旧 deg3（@1）切换通道已移除——
   *  data/calibration-deg3-backup.json 与 calibration-autotps-backup.json 文件保留，回滚走 git 或文件替换。 */
  function takeCalibration(obj) {
    if (!(obj && obj.model === 'tps' && obj.schema === 'fmt/calibration@2')) return false;
    S.calib = obj;
    basemapEpoch++;
    return true;
  }

  function loadDataObject(obj, fileName) {
    if (obj && obj.schema === 'fmt/import@1') { addImportRecord(obj); return; }
    if (obj && obj.schema === 'fmt/stations-import@2') {   // @2＝增换乘标站（transfer 字段）与 transfers 全表
      const n = addStationPreset(obj, fileName);
      renderLineForm(); renderStopList();
      setStatus(`已载入站圆预置 ${n} 条（${fileName || obj.source}）——在线路属性面板「从预置导入车站」。`);
      return;
    }
    if (isLineObj(obj)) {
      const prev = S.lines.get(obj.id);
      if (prev && !confirm(`线路 ${obj.id} 已在编辑（${prev.name || '未命名'}，${prev.stops.length} 站）。`
        + `载入「${fileName || obj.id + '.json'}」将覆盖当前版本，继续？`)) {
        setStatus(`已跳过 ${fileName || obj.id + '.json'}（保留当前 ${obj.id}，未做改动）。`, true);
        return;
      }
      snapshot();   // 载入前快照：覆盖可撤销（防误选旧文件静默冲掉当前编辑）
      const note = migrateLineNote(obj);   // @1 → @2 分段实体（保存后生效）
      S.lines.set(obj.id, obj);
      S.arcs.delete(obj.id);
      if (!S.activeLine) S.activeLine = obj.id;
      setStatus(`已载入线路 ${obj.id}${prev ? '（覆盖旧版，Ctrl+Z 可撤销）' : ''}。` + (note ? ' ' + note + '。' : ''));
      return;
    }
    if (obj && obj.schema === 'fmt/groups@1') { snapshot(); S.groups = takeGroups(obj); return; }
    if (obj && obj.schema === 'fmt/manifest@1') {
      S.manifest = obj;
      // 单独载入 manifest：带有显示顺序则采用（缺失不清洗当前顺序——线路文件可能尚未到齐）
      if (Array.isArray(obj.lineOrder)) S.lineOrder = obj.lineOrder;
      return;
    }
    if (obj && obj.schema === 'fmt/calibration@1') {
      setStatus('旧 deg3 标定已停用：渲染恒用手动标定 TPS v2（data/calibration.json）。'
        + '备份文件仍保留在 data/，回滚请走 git 或直接替换 calibration.json。', true);
      return;
    }
    if (obj && obj.schema === 'fmt/calibration@2') {
      takeCalibration(obj);
      $('btnBasemap').classList.toggle('primary', S.basemap !== 'off');
      renderWorld();
      setStatus('已载入标定参数（手动标定 TPS v2），底图可用。');
      return;
    }
    throw new Error(fileName + '：无法识别的数据文件（schema 不匹配）');
  }

  async function bootFetchData() {
    // 经 http 服务打开时自动尝试拉取 data/（file:// 打开时静默跳过）
    // cache:'no-cache'＝每次向本地服务重新验证——标定/数据刚重生成时避免浏览器吃旧缓存
    const get = async (u) => {
      try { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) return null; return await r.json(); } catch (e) { return null; }
    };
    const groups = await get('data/groups.json');
    if (groups) S.groups = takeGroups(groups);
    const manifest = await get('data/manifest.json');
    if (manifest) S.manifest = manifest;
    // 显示顺序原始值直接存（生效顺序用时经 normalizeLineOrder 现算，见 S.lineOrder 注释）
    if (manifest && Array.isArray(manifest.lineOrder)) S.lineOrder = manifest.lineOrder;
    // 标定：恒用现行 data/calibration.json（手动标定 TPS v2；旧 deg3 备份文件保留但不再载入，回滚走 git）
    const calib = await get('data/calibration.json');
    if (calib) takeCalibration(calib);
    // lineinfo.md（线路介绍，文本非 JSON）：boot 经 http 时把仓库 data/lineinfo.md 当作当前
    // 工作集载入（保存工作区写回的就是它）；模板文本同源留存（面板新建文件拼注释头用）
    try {
      const r = await fetch('data/lineinfo.md', { cache: 'no-cache' });
      if (r.ok) {
        const t = await r.text();
        S.lineinfoMd = t; S.lineinfoSavedMd = t; S.liTplText = t;
      }
    } catch (e) { /* file:// 等，忽略 */ }
    try {
      const r = await fetch('data/lines/', { cache: 'no-cache' });
      if (r.ok) {
        const html = await r.text();
        const names = [...html.matchAll(/href="(l\d{4}\.json)"/g)].map((m) => m[1]);
        const notes = [];
        for (const n of new Set(names)) {
          const obj = await get('data/lines/' + n);
          if (isLineObj(obj)) {
            const note = migrateLineNote(obj);   // @1 → @2 分段实体（保存后生效）
            if (note) notes.push(note);
            S.lines.set(obj.id, obj);
            if (!S.activeLine) S.activeLine = obj.id;
          }
        }
        if (notes.length) setTimeout(() => setStatus(notes.join('；') + '。', true), 0);
      }
    } catch (e) { /* file:// 等，忽略 */ }
    // import/ 目录：svg_parse --import 的产物自动载入（导入源开箱即见）
    try {
      const r = await fetch('import/', { cache: 'no-cache' });
      if (r.ok) {
        const html = await r.text();
        // 目录列表 href 为 URL 编码后的文件名（含中文），取单段 *.json、排除 ../ 等路径
        const hrefs = [...html.matchAll(/href="([^"/]+\.json)"/g)].map((m) => m[1]);
        for (const h of new Set(hrefs)) {
          const obj = await get('import/' + h);
          if (obj && obj.schema === 'fmt/import@1') addImportRecord(obj);
          else if (obj && obj.schema === 'fmt/stations-import@2') addStationPreset(obj);
        }
      }
      importsDirty = false;   // 磁盘扫描到的记录无需暂存备份（恢复时同名以磁盘为准），免整块重写
    } catch (e) { /* file:// 等，忽略 */ }
  }

  // ---------- 几何缓存 ----------
  function arcOf(lid) {
    if (!S.arcs.has(lid)) {
      const line = S.lines.get(lid);
      if (!line) return null;
      try {
        const ap = G.pathFromD(line.path);
        ap.pathD = line.path;   // 记下来源 path：线路集整体替换时 path 没变的线沿用旧弧（见 reuseArcs）
        S.arcs.set(lid, ap);
      }
      catch (e) {
        setStatus(`线路 ${lid} path 解析失败：${e.message}`);
        S.arcs.set(lid, null);
      }
    }
    return S.arcs.get(lid);
  }
  /** 线路集整体替换（撤销／载入／恢复暂存）后的弧缓存：path 没变的线沿用旧弧对象——免重新解析压平
   *  （58 线约 9 ms），其段字符串 memo 一并保留，画布增量渲染也不会误判几何变化（几何代际不递增）；
   *  path 变了或已不存在的线丢弃，待 arcOf 惰性重建（同 id 异 path 时绝不能留旧弧：站会按旧几何落位） */
  function reuseArcs(oldArcs, lines) {
    const next = new Map();
    for (const [lid, line] of lines) {
      const prev = oldArcs.get(lid);
      if (prev && prev.pathD === line.path) next.set(lid, prev);
    }
    return next;
  }

  // ---------- 视图（平移/缩放） ----------
  function worldPerPixel() {
    return S.view ? S.view.w / Math.max(svg.clientWidth, 1) : 1;
  }
  function fitView() {
    let bb = null;
    const merge = (b) => {
      bb = bb ? [Math.min(bb[0], b[0]), Math.min(bb[1], b[1]), Math.max(bb[2], b[2]), Math.max(bb[3], b[3])]
        : b.slice();
    };
    for (const ap of S.arcs.values()) if (ap) merge(ap.bbox());
    // 未建线的导入 path 也纳入初始视野
    const boundPaths = new Set([...S.lines.values()].map((l) => l.path));
    for (const imp of S.imports) {
      for (const p of imp.paths) {
        if (boundPaths.has(p.path)) continue;
        try { merge(G.pathFromD(p.path).bbox()); } catch (e) { /* 忽略坏 path */ }
      }
    }
    if (!bb) return;
    const pad = 0.05 * Math.max(bb[2] - bb[0], bb[3] - bb[1], 1);
    const w = (bb[2] - bb[0]) + 2 * pad;
    const h = (bb[3] - bb[1]) + 2 * pad;
    const ratio = svg.clientHeight / Math.max(svg.clientWidth, 1);
    S.view = { x: bb[0] - pad, y: bb[1] - pad, w: w, h: Math.max(h, w * ratio) };
  }
  function applyView() {
    if (!S.view) return;
    const ratio = svg.clientHeight / Math.max(svg.clientWidth, 1);
    S.view.h = S.view.w * ratio;
    svg.setAttribute('viewBox', `${S.view.x} ${S.view.y} ${S.view.w} ${S.view.h}`);
  }
  /** 双击左栏条目跳转：视图对准 bbox（世界坐标 [x0,y0,x1,y1]）留边放大；minW 防过近 */
  function zoomToBox(bb, minW) {
    if (!bb) return;
    const ratio = svg.clientHeight / Math.max(svg.clientWidth, 1);
    const cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2;
    const pad = 0.12 * Math.max(bb[2] - bb[0], bb[3] - bb[1], 1);
    const w = Math.max((bb[2] - bb[0]) + 2 * pad, ((bb[3] - bb[1]) + 2 * pad) / ratio, minW || 300);
    S.view = { x: cx - w / 2, y: cy - (w * ratio) / 2, w: w, h: w * ratio };
    applyView(); renderWorld(); scheduleBasemap();
  }
  /** 双击设站行：仅把该站居中，不改变缩放 */
  function centerOn(x, y) {
    if (!S.view) return;
    const ratio = svg.clientHeight / Math.max(svg.clientWidth, 1);
    S.view.x = x - S.view.w / 2;
    S.view.y = y - (S.view.w * ratio) / 2;
    applyView(); scheduleBasemap();
  }
  function toWorld(evt) {
    const pt = new DOMPoint(evt.clientX, evt.clientY);
    const m = svg.getScreenCTM();
    if (!m) return [0, 0];
    const w = pt.matrixTransform(m.inverse());
    return [w.x, w.y];
  }

  // ---------- 未建线导入 path 持久组（renderWorld 分层，2026-11-22 性能） ----------
  // 灰色虚线＋命中线 ≈百来个复杂 path 元素，曾随每次 renderWorld 全量重建（31 线规模起肉眼卡顿）；
  // 照 basemapG 思路跨渲染保留，仅当导入集（S.imports 引用）、已绑定 path 集或选中态真正变化时重建。
  // 选中高亮不重建：renderWorld 里遍历切 class（~百元素，微秒级）
  let rawG = null;            // <g> 持久节点
  let rawGImpRef = null;      // 上次重建时的 S.imports 引用（addImportRecord 每次换新数组）
  let rawGBound = null;       // 上次重建时的已绑定 path Set
  function samePathSet(a, b) {
    if (a === b) return true;
    if (!a || !b || a.size !== b.size) return false;
    for (const p of a) if (!b.has(p)) return false;
    return true;
  }

  // ---------- 底图瓦片垫层（三态：关 / OSM / 高德；仅本地对位参考；需标定 fmt/calibration@2） ----------
  // OSM 瓦片为 WGS84，直接按标定逆变换放置；高德瓦片为 GCJ02——逐瓦片常量偏移对齐：
  // 对每片取其中心经纬度（WGS84）算 wgs84ToGcj02 偏移，加到该片四角经纬度后再逆变换放置
  // （偏移场平滑，单瓦片 256px 内误差米级，远小于标定本身 RMS 108 m）。
  let basemapG = null;
  const basemapTiles = new Map();   // "z/x/y" -> <image>
  let basemapEpoch = 0;             // 标定方案/参数变化计数：瓦片 transform 只在跨 epoch 重算
  let tileWarned = false;           // 瓦片重试后仍失败的一次性提示开关
  let basemapTimer = null;
  function scheduleBasemap() {
    clearTimeout(basemapTimer);
    basemapTimer = setTimeout(updateBasemap, 120);
  }
  /** 底图源切换后清空全部瓦片（URL 与放置偏移随源不同，旧片不可复用） */
  function clearBasemapTiles() {
    basemapTiles.clear();
    if (basemapG) basemapG.textContent = '';
    basemapEpoch++;
  }
  function updateBasemap() {
    if (!basemapG) return;
    if (S.basemap === 'off' || !S.calib || !S.view) {
      basemapTiles.clear();
      basemapG.textContent = '';
      $('osmAttr').style.display = 'none';
      return;
    }
    const amap = S.basemap === 'amap';
    $('osmAttr').style.display = 'block';
    $('osmAttr').textContent = amap ? '底图 © 高德地图' : '底图 © OpenStreetMap contributors';
    // 视野四角 → 经纬度范围（标定前向）
    const cs = [[S.view.x, S.view.y], [S.view.x + S.view.w, S.view.y],
      [S.view.x, S.view.y + S.view.h], [S.view.x + S.view.w, S.view.y + S.view.h]];
    const geoC = cs.map((p) => calibForward(S.calib, p[0], p[1]));
    const lonMin = Math.min(...geoC.map((g) => g[0])), lonMax = Math.max(...geoC.map((g) => g[0]));
    const latMin = Math.min(...geoC.map((g) => g[1])), latMax = Math.max(...geoC.map((g) => g[1]));
    // zoom：自高向低取首个"中心处单瓦片屏幕宽 ≥140px"的层级（平衡清晰度与瓦片数）
    const cLon = (lonMin + lonMax) / 2, cLat = (latMin + latMax) / 2;
    const wpp = worldPerPixel();
    let z = 3;
    for (let zz = 19; zz >= 3; zz--) {
      z = zz;
      const dlon = 360 / Math.pow(2, zz);
      const p1 = calibInverse(S.calib, cLon - dlon / 2, cLat);
      const p2 = calibInverse(S.calib, cLon + dlon / 2, cLat);
      const px = p1 && p2 ? Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / wpp : Infinity;
      if (px >= 140) break;
    }
    // 可见瓦片数超过 80 就降层重算
    let x0, y0, x1, y1;
    for (let k = 0; k < 5; k++) {
      x0 = Math.floor(lonToTileX(lonMin, z)); x1 = Math.floor(lonToTileX(lonMax, z));
      y0 = Math.floor(latToTileY(latMax, z)); y1 = Math.floor(latToTileY(latMin, z));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 80) break;
      z--;
    }
    const need = new Set();
    const nT = Math.pow(2, z);
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = Math.max(0, y0); ty <= Math.min(y1, nT - 1); ty++) {
        const key = `${z}/${tx}/${ty}`;
        need.add(key);
        let img = basemapTiles.get(key);
        if (!img) {
          img = el('image', { width: 256, height: 256, class: 'basemap-tile' }, basemapG);
          if (amap) {
            // 高德矢量底图 style=8：四子域轮询（webrd01~04）
            const sub = 1 + ((tx + ty) % 4);
            img.setAttribute('href',
              `https://webrd0${sub}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tx}&y=${ty}&z=${z}`);
          } else {
            img.setAttribute('href', `https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`);
          }
          img.addEventListener('error', () => {   // 加载失败重试一次（删元素重发）；仍失败仅提示一次
            if (img.dataset.retry) {
              if (!tileWarned) { tileWarned = true; setStatus('部分底图瓦片加载失败（网络受限？），重试无效。', true); }
              return;
            }
            img.dataset.retry = '1';
            img.remove(); basemapTiles.delete(key);
            setTimeout(scheduleBasemap, 800);
          });
          basemapTiles.set(key, img);
        }
        // 瓦片像素 → SVG 世界：三点仿射（(0,0)(256,0)(0,256)），标定在小范围内近似线性；
        // transform 只在标定方案变化（跨 epoch）时重算（TPS 反演较贵，避免平移高频重算）。
        // 高德（GCJ02）：以本片中心（WGS84）的 wgs84ToGcj02 偏移平移四角——常量偏移近似
        if (img.dataset.epoch !== String(basemapEpoch)) {
          const lonW = tileXToLon(tx, z), lonE = tileXToLon(tx + 1, z);
          const latN = tileYToLat(ty, z), latS = tileYToLat(ty + 1, z);
          let dLon = 0, dLat = 0;
          if (amap) {
            const cLon = tileXToLon(tx + 0.5, z), cLat = tileYToLat(ty + 0.5, z);
            const g = G.wgs84ToGcj02(cLon, cLat);
            dLon = g[0] - cLon; dLat = g[1] - cLat;
          }
          const p00 = calibInverse(S.calib, lonW + dLon, latN + dLat);
          const p10 = calibInverse(S.calib, lonE + dLon, latN + dLat);
          const p01 = calibInverse(S.calib, lonW + dLon, latS + dLat);
          if (!p00 || !p10 || !p01) continue;
          const a = (p10[0] - p00[0]) / 256, b = (p01[0] - p00[0]) / 256;
          const d = (p10[1] - p00[1]) / 256, e2 = (p01[1] - p00[1]) / 256;
          img.setAttribute('transform', `matrix(${a} ${d} ${b} ${e2} ${p00[0]} ${p00[1]})`);
          img.dataset.epoch = String(basemapEpoch);
        }
      }
    }
    for (const [key, img] of basemapTiles) {
      if (!need.has(key)) { img.remove(); basemapTiles.delete(key); }
    }
  }

  // ---------- 渲染 ----------
  function segPathString(ap, t1, t2) {
    // 段 path 字符串 memo（2026-11-22 性能）：挂弧对象上，随 arcOf 缓存失效（S.arcs
    // 清理/重建）整体丢弃，无悬挂顾虑；容量护栏防拖站/改站产生海量旧 t 组合（全清重填
    // 成本≈一次重绘的段计算，可接受）
    let c = ap._segStr;
    if (!c) c = ap._segStr = new Map();
    const key = t1 + '|' + t2;
    let s = c.get(key);
    if (s === undefined) {
      const pts = ap.polylineBetween(t1, t2);
      s = pts.length ? 'M' + pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L') : '';
      if (c.size > 512) c.clear();
      c.set(key, s);
    }
    return s;
  }

  // ---------- 联络线取色（2026-11-22 用户裁定：取消颜色属性，颜色由所联络的两条线决定） ----------
  /** 信息未填写完全（有效目标不足 2 条等）时的联络线兜底深灰（用户 2026-11-22 裁定） */
  const CONNECTOR_FALLBACK = '#555555';
  /** 目标线几何采样点数（端色/站圈取「最近目标线」判定的均匀 t 采样，见 connNearestTarget） */
  const CONN_SAMPLE_N = 200;

  /** 点到各有效目标线几何的最近者（联络线渐变两端取色与设站取色共用）。
   *  目标几何判定从简：沿 t 均匀采样 CONN_SAMPLE_N 点比距离平方（单调，免开方）——
   *  采样近似对编辑器工具界面足够（不做精确投影），84 线全量规模下成本亦可控。
   *  targets 元素约定 {lid,color,ap}（见 connValidTargets）；targets 空→null。 */
  function connNearestTarget(targets, pt) {
    let best = null, bd = Infinity;
    for (const tgt of targets || []) {
      let d = Infinity;
      for (let k = 0; k <= CONN_SAMPLE_N; k++) {
        const q = tgt.ap.pointAt(k / CONN_SAMPLE_N);
        const dx = q[0] - pt[0], dy = q[1] - pt[1];
        const dd = dx * dx + dy * dy;
        if (dd < d) d = dd;
      }
      if (d < bd) { bd = d; best = tgt; }
    }
    return best;
  }

  /** 站圈 <title> 提示文本（渲染与改名/拖站局部更新共用，保持一致） */
  function stopTitle(line, st, idx, grp) {
    const isBlk = st.kind === 'block';
    const isArr = st.kind === 'arrow';
    const oos = grp && grp.type === 'out-of-station';
    return `${idx + 1}. ${st.name || (isBlk ? '（线路所）' : isArr ? '（出省箭头）' : '（未命名）')}  t=${st.t.toFixed(4)}`
      + (isBlk ? '  线路所：仅编辑器可见，正式网页隐藏' : '')
      + (isArr ? '  出省箭头：非站点、指向线路外侧，编辑器与正式网页都显示；不可编组' : '')
      + (oos ? `  ${grp.id}（出闸换乘）` : '');
  }

  // ---------- 画布渲染（增量，2026-11-22 性能改版） ----------
  // 此前每次 renderWorld 都清空 #world 后全量重建（58 线 ≈4200 个 SVG 元素；本机 Chrome 无头
  // 实测：每次点击、每格滚轮 33~50 ms、掉 2~3 帧）。现在：
  //  · 每线 <g> 跨渲染持久（lineDom）：该线的「画法输入」（path／设站／分段状态／所属组…）没变
  //    就原样复用，变了只重建这一条线（≈1 ms）；
  //  · 当前线／选中站／待编组是瞬态，不进重建——只原地改样式、挪选中环、切 class；
  //  · 缩放只原地改屏幕恒定尺寸（站圈半径、描边宽、箭头三角…），不重建；
  //  · 换乘药丸／合并圈按组判脏（嵌套组 2026-11-23：按**绘制单元**——最外层组及出闸/未定单元的子组，
  //    叶站＝直属站＋所有子孙组的直属站，见 groupDrawPlan／syncGroupShapes），就近提示按输入判脏；
  //    未建线导入组沿用既有持久组逻辑。
  // 层叠序与全量重建时一致：底图 → 未建线导入 path → 各线（S.lines 迭代序）→ 药丸 → 合并圈 → 就近提示。
  // 约定：凡改了某线「画法输入」的数据，下一次 renderWorld 必须能由 lineStale 判出（逐字段比对，
  // 不靠调用方标脏；比对键＝纯逻辑层 lineDrawKey／sameLineDraw，node 单测覆盖）；日后给线路绘制
  // 新增依赖时，须同步把该依赖补进比对键。
  let gradDefs = null;                                   // 联络线渐变 <defs>（常驻，渐变随联络线增删）
  let gLines = null, pillG = null, gMerge = null, gHint = null;   // 常驻层容器
  const lineDom = new Map();                             // lid -> 线渲染记录（见 buildLine）
  const grpDom = new Map();                              // gid -> 药丸／合并圈记录（见 buildGroupShape）
  const grads = new Map();                               // lid -> 联络线 linearGradient 元素
  let lastArcs = [];                                     // 上次渲染时各线弧对象（S.lines 迭代序）
  let geomGen = 0;                                       // 几何代际：任一线弧对象更换即 +1
  let hintSig = null, hintGen = 0;                       // 就近提示层判脏
  /** 画板单位→屏幕像素比例（站圈等屏幕恒定尺寸＝像素数 ÷ 它） */
  function viewScale() {
    return S.view ? Math.max(svg.clientWidth, 1) / S.view.w : 1;
  }
  /** 常驻层容器只建一次、次序固定（defs 不参与绘制；rawG 重建时插到 gLines 之前） */
  function ensureWorldLayers() {
    if (gLines) {
      if (basemapG.parentNode !== world) world.insertBefore(basemapG, world.firstChild);
      return;
    }
    if (!basemapG) basemapG = el('g', { id: 'basemap' });
    gradDefs = el('defs', { id: 'conn-grads' }, world);
    gLines = el('g', { id: 'lines' }, world);
    pillG = el('g', { id: 'pillG' }, world);
    gMerge = el('g', { id: 'merged' }, world);
    gHint = el('g', { id: 'hints' }, world);
    world.insertBefore(basemapG, world.firstChild);
  }
  function dropGrad(lid) {
    const g = grads.get(lid);
    if (g) { g.remove(); grads.delete(lid); }
  }
  function dropLineDom(lid) {
    const rec = lineDom.get(lid);
    if (rec) { rec.g.remove(); lineDom.delete(lid); }
    dropGrad(lid);
  }
  function dropGroupDom(gid) {
    const rec = grpDom.get(gid);
    if (rec) { for (const e of rec.els) e.remove(); grpDom.delete(gid); }
  }
  /** 出省箭头三角 path（线色实心、指向线路外侧；头站取切线反方向）。尺寸为屏幕恒定（÷scale） */
  function arrowPathString(ap, t, idx, scale) {
    const [x, y] = ap.pointAt(t);
    // 切向：t 处沿正向的单位切向量（邻点差分；t≈1 用向后差分）
    const dt = 2e-3;
    let a = t, b = t + dt;
    if (b > 1) { b = t; a = Math.max(0, t - dt); }
    const p1 = ap.pointAt(a), p2 = ap.pointAt(b);
    let dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    const dl = Math.hypot(dx, dy) || 1;
    dx /= dl; dy /= dl;
    if (idx === 0) { dx = -dx; dy = -dy; }
    const px = -dy, py = dx;                          // 垂直方向（基线展开用）
    const tipL = 9 / scale, halfW = 6 / scale;        // 屏幕恒定尺寸（视觉档≈站圈 5.5px）
    return `M${(x + dx * tipL).toFixed(2)},${(y + dy * tipL).toFixed(2)}`
      + `L${(x - dx * tipL + px * halfW).toFixed(2)},${(y - dy * tipL + py * halfW).toFixed(2)}`
      + `L${(x - dx * tipL - px * halfW).toFixed(2)},${(y - dy * tipL - py * halfW).toFixed(2)}Z`;
  }
  /** 本帧渲染上下文：每次 renderWorld 现算（联络线目标、比例、编组索引、几何代际） */
  function renderCtx() {
    // 联络线有效目标索引（lid -> connValidTargets 结果[{lid,color,ap}]）：每次重绘现算，
    // 目标线被删/改色即时生效、无缓存阻碍（S.lines 实时判定；arcOf 缓存已随删线清理）
    const connTgtsOf = new Map();
    for (const [cid, cline] of S.lines) {
      if (cline.role !== 'connector') continue;
      const tg = connValidTargets(cline, (id) => {
        const tl = S.lines.get(id);
        const tap = tl && tl.color ? arcOf(id) : null;
        return tap ? { lid: id, color: tl.color, ap: tap } : null;
      });
      if (tg.length) connTgtsOf.set(cid, tg);
    }
    /** 任意线路在指定画板点的设站取色：非联络线→line.color（原行为）；联络线有效→
     *  距该点最近的目标线色；无效（信息未填写完全）→深灰兜底。站圈/线路所/出省箭头、
     *  接轨站合并圈成员色统一走这里 */
    const connColorAt = (line, pt) => {
      if (line.role !== 'connector') return line.color;
      const tg = connTgtsOf.get(line.id);
      return tg ? connNearestTarget(tg, pt).color : CONNECTOR_FALLBACK;
    };
    const scale = viewScale();
    // 换乘组索引：同站/接轨**单元**成员隐藏小圈（画合并圈）；出闸组成员圈描黑边；
    // 同站单元逻辑线数 ≥3 改画药丸——叶站圈同样隐去（药丸即换乘标识，2026-11-22 用户裁定）；
    // 不足 3 线维持大圈。嵌套组（2026-11-23）：绘制单元与被吸收的叶站由 groupDrawPlan 给出
    // （节点＝最外层组；出闸/未定单元的子组各自成单元），叶站＝直属站＋所有子孙组的直属站；
    // 出闸黑边与 <title> 提示仍按**直属组**判定（grpOf）
    const stationGroups = stationGroupsOf();
    const lineGroups = (S.groups && S.groups.lineGroups) || [];
    const gplan = groupDrawPlan(stationGroups);
    const grpOf = new Map();               // sid -> 直属组对象
    const grpKeyOf = new Map();            // sid -> `${直属组 id}|${直属组 type}|${h|v}`（线路判脏用；
                                           //   h＝站圈被单元吸收隐去——上级组类型/子组关系变化只经此位影响本线画法）
    const lineOfStop = new Map();          // sid -> lid（组内线数统计、合并圈成员查找用）
    for (const [lid0, line0] of S.lines) for (const st0 of line0.stops) lineOfStop.set(st0.id, lid0);
    const pillGroups = new Set();          // 画药丸的单元 id（上级组一律、平铺同站单元逻辑线数 ≥3，见 unitIsPill）
    const mergedHidden = gplan.hidden;     // 同站/接轨单元（含药丸单元）吸收的全部叶站 sid
    for (const g of stationGroups) {
      for (const sid of g.stops) {
        grpOf.set(sid, g);
        grpKeyOf.set(sid, stopGroupKey(g, mergedHidden.has(sid)));
      }
    }
    for (const gid of gplan.units) {
      const g = gplan.tree.byId.get(gid);
      const lines = gplan.leafOf.get(gid).map((sid) => S.lines.get(lineOfStop.get(sid))).filter(Boolean);
      if (unitIsPill(g, gplan.tree.childrenOf.get(gid), lines, lineGroups, [...S.lines.values()])) pillGroups.add(gid);   // 叶站圈一并隐去，见 buildGroupShape
    }
    // 待编组集（瞬态）：待编组站＋待编入上层的整组及其全部子孙组的直属站——站圈/单元符号的待编组提示样式
    // 与就近提示的跳过判定同用（整组待编入时，它自己的站不该再被标成「就近候选」）
    const pend = new Set(S.pending);
    const pendGrpVis = new Set();          // 待编入上层的组及其全部子孙组 id
    const pendGrpSids = [];                // 这些组的全部直属站（就近提示的跳过集随组树变化的判脏依据）
    for (const gid of S.pendingGroups) {
      const stack = [gid];
      while (stack.length) {
        const cur = stack.pop();
        if (pendGrpVis.has(cur)) continue;
        pendGrpVis.add(cur);
        const g = gplan.tree.byId.get(cur);
        if (g) for (const sid of g.stops) { pend.add(sid); pendGrpSids.push(sid); }
        for (const cid of gplan.tree.childrenOf.get(cur) || []) stack.push(cid);
      }
    }
    // 几何代际：任一线的弧对象换了（「更新path」／撤销／载入重建 S.arcs）即 +1——联络线渐变
    // 端色与换乘合并圈的位置/取色依赖**其他线**的几何，靠它判脏（本线几何变化由 path 比对覆盖）
    const arcsNow = [...S.lines.keys()].map(arcOf);
    if (arcsNow.length !== lastArcs.length || arcsNow.some((a, i) => a !== lastArcs[i])) geomGen++;
    lastArcs = arcsNow;
    let connDigest = '';                   // 联络线目标集及其取色的摘要（合并圈成员色判脏用）
    for (const [cid, tg] of connTgtsOf) connDigest += cid + tg.map((t) => t.lid + t.color).join('');
    let lgDigest = '';                     // 线组表摘要（药丸线数口径依赖线组归属：members 声明变了药丸/大圈须互换）
    for (const lg of lineGroups) lgDigest += (lg && lg.id) + ':' + ((lg && lg.members) || []).join('.') + ';';
    // 各线组的主线归属也入摘要：线组有无主线决定它算不算一条逻辑线（见 logicalLineCount），改角色后药丸/大圈须互换
    for (const l of S.lines.values()) if (l && l.role === 'main') lgDigest += 'm' + (l.groupId || '') + '.' + l.id + ';';
    return { connTgtsOf, connColorAt, scale, stationGroups, grpOf, grpKeyOf, lineOfStop,
      pillGroups, mergedHidden, geomGen, connDigest, pend, pendGrpVis, pendGrpSids: pendGrpSids.join(','),
      gplan, unitSet: gplan.unitSet, leafOf: gplan.leafOf, tree: gplan.tree, lineGroups, lgDigest };
  }
  /** 线路的「画法输入」是否变了（变了才重建该线；瞬态——当前线/选中站/待编组——不在此列）。
   *  本线数据走 lineDrawKey 逐字段比对（纯逻辑层，单测覆盖）；联络线另比目标集取色与几何代际
   *  （线身渐变与站圈取色取决于**别的线**，不在本线比对键里） */
  function lineStale(rec, line, ctx) {
    if (!sameLineDraw(rec.key, lineDrawKey(line, ctx.grpKeyOf))) return true;
    if (line.role === 'connector') {
      const tg = ctx.connTgtsOf.get(line.id);
      if (rec.geomGen !== ctx.geomGen
        || rec.connKey !== (tg ? tg.map((t) => t.lid + ':' + t.color).join(',') : '-')) return true;
    }
    return false;
  }
  /** 重建一条线的 <g>（只设与比例无关的属性；屏幕恒定尺寸由 syncLineScale 统一写） */
  function buildLine(lid, line, ap, ctx) {
    dropGrad(lid);
    const g = el('g', { class: 'svg-line' }, null);
    // 联络线线身取色（2026-11-22 用户裁定：取消颜色属性，颜色由所联络的两条线决定）：
    // 有效时 stroke＝SVG linearGradient——两端各取「距本线首/末端最近的 connects 目标线色」
    // 作 stop，gradientUnits=userSpaceOnUse 沿贝塞尔起讫连线渐变（线性近似「沿曲线填充」，
    // 编辑器工具界面足够；查看器为 MapLibre 另行实现）。段 path/.line-base 自身无 stroke
    // （CSS 只设宽度/透明度/虚线，已逐一确认），全靠此处 g.style.stroke 继承上色；
    // 无效（信息未填写完全：目标不足 2 条等）→深灰兜底。有 groupId 的联络线仍走本规则
    // （防御：编辑器线身渲染不消费组色，组逻辑不改联络线颜色）。
    const connTgts = line.role === 'connector' ? ctx.connTgtsOf.get(lid) : null;
    if (line.role === 'connector' && connTgts) {
      const p0 = ap.pointAt(0), p1 = ap.pointAt(1);
      const g0 = connNearestTarget(connTgts, p0), g1 = connNearestTarget(connTgts, p1);
      if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) < 1e-6) {
        g.style.stroke = g0.color;   // 首末重合（闭合 path 极端情形）：零向量渐变未定义，退化单色
      } else {
        // connects ≥3：两端各取最近目标、其余忽略（用户裁定，见 connValidTargets 注释）
        const grad = el('linearGradient', { id: `grad-${lid}`, gradientUnits: 'userSpaceOnUse',
          x1: p0[0], y1: p0[1], x2: p1[0], y2: p1[1] }, gradDefs);
        el('stop', { offset: '0', 'stop-color': g0.color }, grad);
        el('stop', { offset: '1', 'stop-color': g1.color }, grad);
        grads.set(lid, grad);
        g.style.stroke = `url(#grad-${lid})`;
      }
    } else {
      g.style.stroke = line.role === 'connector' ? CONNECTOR_FALLBACK : line.color;
    }
    g.dataset.lid = lid;
    // 底图：完整原始贝塞尔 path（弱化）
    const base = el('path', { d: line.path, class: 'line-base',
      'vector-effect': 'non-scaling-stroke' }, g);
    base.dataset.lid = lid;
    const stops = line.stops, segs = line.segments || [], n = stops.length;
    // 预控通道线不设站（2026-11-22 用户说明）：站数<2 时整线单段显示，状态取线路级 status
    // （建线默认远期）。**仅限预控通道**（用户明确限定，不得扩及其他类别）；其余类别站数<2
    // 一律只画弱化底 path，加满 2 站后才按站间段显示。缺省 future 同 fixStatusField/
    // migrateLineToV2 的兜底（线路级 status 的录入口已撤，载入统一补 future）
    if (n < 2 && isReservedLine(line)) {
      const st = SEG_ORDER.includes(line.status) ? line.status : 'future';
      el('path', { d: line.path, class: `seg-common seg-${st}`,
        'vector-effect': 'non-scaling-stroke' }, g);
      const wholeHit = el('path', { d: line.path, class: 'seg-hit',
        'vector-effect': 'non-scaling-stroke' }, g);
      wholeHit.dataset.lid = lid;   // 无 data-seg：整线单段不是站间段（选择模式点选语义同底 path）
    }
    const segStatus = segStatusesOf(line);
    for (let i = 0; i < segStatus.length; i++) {
      const t1 = stops[i].t;
      const t2 = (line.loop && i + 1 === n) ? stops[0].t : stops[i + 1].t;  // 环线末段环绕
      const dstr = segPathString(ap, t1, t2);
      if (!dstr) continue;
      // 段样式派生：分段实体（fmt/line@2）——sections[segments[i]].status；站数<2 的线不进本循环
      el('path', { d: dstr, class: `seg-common seg-${segStatus[i]}`,
        'vector-effect': 'non-scaling-stroke' }, g);
      const hit = el('path', { d: dstr, class: 'seg-hit',
        'vector-effect': 'non-scaling-stroke' }, g);
      hit.dataset.lid = lid; hit.dataset.seg = i;
    }
    // 设站（同站/接轨组成员的独立小圈不画，统一画合并圈；出闸换乘描黑边；
    // 线路所 kind:'block'＝虚线圆（同尺寸、线色），仅编辑器可见、正式网页隐藏；
    // 出省箭头 kind:'arrow'＝线色实心三角指向线路外侧，编辑器与正式网页都显示）
    const recStops = [];
    stops.forEach((st, idx) => {
      if (ctx.mergedHidden.has(st.id)) return;
      const [x, y] = ap.pointAt(st.t);
      const grp = ctx.grpOf.get(st.id);
      const oos = grp && grp.type === 'out-of-station';
      const isBlk = st.kind === 'block';
      if (st.kind === 'arrow') {
        // 复用 .stop-c 类获得指针/命中/拖动交互；fill/stroke 走内联样式盖过类默认白底。
        // fill 走 connColorAt：联络线箭头取「该点最近目标线色」（无效深灰），白描边不动
        const tri = el('path', { d: '', class: 'stop-c stop-arrow' }, g);
        tri.style.stroke = '#fff';
        tri.dataset.lid = lid; tri.dataset.sid = st.id;
        const tt = el('title', {}, tri);
        tt.textContent = stopTitle(line, st, idx, grp);
        recStops.push({ el: tri, id: st.id, t: st.t, idx, x, y, kind: 'arrow',
          fill: ctx.connColorAt(line, [x, y]) });
      } else {
        // 描边色走 connColorAt：联络线站圈取「该站最近目标线色」（无效深灰）、出闸组黑边优先不变
        const c = el('circle', { cx: x, cy: y, class: 'stop-c',
          stroke: oos ? '#000' : ctx.connColorAt(line, [x, y]) }, g);
        c.dataset.lid = lid; c.dataset.sid = st.id;
        const t = el('title', {}, c);
        t.textContent = stopTitle(line, st, idx, grp);
        recStops.push({ el: c, id: st.id, t: st.t, idx, x, y, kind: 'circle', blk: isBlk });
      }
    });
    return { g, base, ap, stops: recStops, ring: null, ringFor: null, scale: NaN,
      key: lineDrawKey(line, ctx.grpKeyOf), geomGen: ctx.geomGen,
      connKey: connTgts ? connTgts.map((t) => t.lid + ':' + t.color).join(',') : '-' };
  }
  /** 比例变化（缩放/窗体尺寸）：只原地改屏幕恒定尺寸属性，不重建 */
  function syncLineScale(rec, scale) {
    const rStop = 5.5 / scale, sw = 1.2 / scale;
    for (const s of rec.stops) {
      if (s.kind === 'arrow') {
        s.el.setAttribute('d', arrowPathString(rec.ap, s.t, s.idx, scale));
        s.el.style.strokeWidth = sw + 'px';
      } else {
        s.el.setAttribute('r', rStop);
        s.el.setAttribute('stroke-width', sw);
        if (s.blk) s.el.setAttribute('stroke-dasharray', `${3 / scale} ${3 / scale}`);   // 屏幕恒定虚线
      }
    }
    if (rec.ring) rec.ring.setAttribute('r', 8.5 / scale);
    rec.scale = scale;
  }
  /** 瞬态落到 DOM：当前线底图加粗提亮、选中环挪到选中站前、待编组站标黄（不重建） */
  function applyLineState(rec, line, ctx) {
    const active = line.id === S.activeLine;
    rec.base.style.strokeWidth = active ? 7 : 5;
    rec.base.style.opacity = active ? 0.42 : 0.22;
    const selIdx = active && S.selStop ? rec.stops.findIndex((s) => s.id === S.selStop) : -1;
    if (selIdx >= 0) {
      const s = rec.stops[selIdx];
      if (!rec.ring) rec.ring = el('circle', { class: 'stop-ring', 'vector-effect': 'non-scaling-stroke' });
      if (rec.ringFor !== s.id) {   // 选中环紧跟在选中站图形之前（与全量重建时的层序一致）
        rec.g.insertBefore(rec.ring, s.el);
        rec.ringFor = s.id;
        rec.ring.setAttribute('cx', s.x); rec.ring.setAttribute('cy', s.y);
        rec.ring.setAttribute('r', 8.5 / rec.scale);
      }
    } else if (rec.ring) {
      rec.ring.remove(); rec.ring = null; rec.ringFor = null;
    }
    for (const s of rec.stops) {
      const pend = ctx.pend.has(s.id);
      s.el.classList.toggle('pend', pend);
      if (s.kind === 'arrow') s.el.style.fill = pend ? 'var(--warn)' : s.fill;
    }
  }
  /** 把一串元素按序放到 prev 之后（prev 为 null＝容器最前）；次序已正确时不动 DOM。
   *  药丸是两个元素一组，逐元素对齐（只对齐组首会把下一组的垫层插进本组两层之间） */
  function placeAfter(container, els, prev) {
    let anchor = prev ? prev.nextSibling : container.firstChild;
    for (const e of els) {
      if (e !== anchor) container.insertBefore(e, anchor);
      anchor = e.nextSibling;
    }
  }
  /** 各线对齐到当前数据：该重建的重建、次序对齐 S.lines、比例同步、落瞬态。返回是否有线被重建 */
  function syncLines(ctx) {
    const seen = new Set();
    let prev = null, changed = false;
    for (const [lid, line] of S.lines) {
      const ap = arcOf(lid);
      if (!ap) { dropLineDom(lid); changed = true; continue; }   // path 解析失败的线不画（arcOf 已提示）
      let rec = lineDom.get(lid);
      if (!rec || lineStale(rec, line, ctx)) {
        const fresh = buildLine(lid, line, ap, ctx);
        if (rec) rec.g.replaceWith(fresh.g); else gLines.appendChild(fresh.g);
        lineDom.set(lid, fresh); rec = fresh; changed = true;
      }
      // 层叠序＝S.lines 迭代序（后画者在上）；只在次序不符时挪动
      placeAfter(gLines, [rec.g], prev);
      prev = rec.g; seen.add(lid);
      if (rec.scale !== ctx.scale) syncLineScale(rec, ctx.scale);
      applyLineState(rec, line, ctx);
    }
    // 线被移除也算「变了」：就近提示层按站现算，得跟着重画
    for (const lid of [...lineDom.keys()]) {
      if (!seen.has(lid)) { dropLineDom(lid); changed = true; }
    }
    return changed;
  }
  /** 重建一个换乘**绘制单元**的图形（逻辑线数 ≥3 的同站单元＝药丸；其余同站/接轨单元＝合并圈）。
   *  g＝作为绘制单元的那个组（符号的 data-grp 归它；嵌套组 2026-11-23）；members＝该单元全部叶站的
   *  成员记录（直属站＋所有子孙组的直属站）——并点位置与药丸链都按叶站算 */
  function buildGroupShape(g, members, isPill, ctx, sig) {
    // 提示文本列全部叶站；嵌套时附子组（内层组不单独出图形，凭此知道它被吸收进了本单元）
    const kids = ctx.tree.childrenOf.get(g.id) || [];
    const leafText = (ctx.leafOf.get(g.id) || []).map((sid) => stopLabel(sid)).join('；');
    const kidNote = kids.length ? `（含子组 ${kids.join('、')}）` : '';
    if (isPill) {
      // 药丸：双描边法——黑垫层（厚＋2×边宽）＋白面层，圆帽圆角＝胶囊；命中/提示挂在面层。
      // 胶囊沿成员站圈位置的贪心最近邻链（planGroupPillChain，n 点连线 n-1 次）
      const pts = members.map((m) => m.ap.pointAt(m.st.t));
      const chain = planGroupPillChain(pts);
      const dstr = 'M' + chain.map((k) => `${pts[k][0].toFixed(2)},${pts[k][1].toFixed(2)}`).join('L');
      const under = el('path', { d: dstr, class: 'grp-pill-under', fill: 'none', stroke: '#000',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, pillG);
      const pill = el('path', { d: dstr, class: 'grp-pill', fill: 'none',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, pillG);
      pill.dataset.grp = g.id;
      const tp = el('title', {}, pill);
      const nLinesP = logicalLineCount(members.map((m) => m.line), ctx.lineGroups, [...S.lines.values()]);   // 线数口径：支线算一条、联络线不算
      tp.textContent = `${g.id} ${g.type === 'junction' ? '接轨站' : '同站换乘'}（${nLinesP} 线药丸）：${leafText}${kidNote}`;
      return { isPill: true, sig, scale: NaN, pend: null, els: [under, pill] };
    }
    // 合并圈：位置取距所有成员线路最近点（投影质心迭代收敛）。
    // 接轨站（junction，支线/联络线接轨用）：尺寸与普通设站圆一致（不做换乘大圈）、
    // 不画黑边（黑边是换乘语义），描边色按成员线角色优先级 main > standalone > branch > connector
    // 取（junctionStroke；取不到成员线颜色退 '#000'；联络线成员先换「该站最近目标线色」，2026-11-22）；
    // fill 仍白底。就近提示/点选/编组交互复用既有机制。
    let px = 0, py = 0;
    for (const m of members) { const p = m.ap.pointAt(m.st.t); px += p[0]; py += p[1]; }
    px /= members.length; py /= members.length;
    for (let it = 0; it < 12; it++) {
      let sx = 0, sy = 0;
      for (const m of members) {
        const pr = m.ap.project(px, py);
        sx += pr.p[0]; sy += pr.p[1];
      }
      const nx = sx / members.length, ny = sy / members.length;
      const moved = Math.hypot(nx - px, ny - py);
      px = nx; py = ny;
      if (moved < 1e-3) break;
    }
    const isJunc = g.type === 'junction';
    const anyBlk = isJunc && members.some((m) => m.st.kind === 'block');   // 组内含线路所→虚线（属性可见）
    // 描边宽 2026-11-22 用户裁定整体 ×0.6（junction 2→1.2、双线大圈黑边 2.2→1.32）；
    // junction 成员色：联络线成员经 connColorAt 换「该站最近目标线色」（无效深灰）后再入
    // 角色优先级比较——混合组本就轮不到联络线色，全联络线接轨组自然取到目标线色
    const c = el('circle', { cx: px, cy: py, class: 'stop-merge',
      stroke: isJunc
        ? junctionStroke(members.map((m) => ({ role: m.line.role,
            color: m.line.role === 'connector'
              ? ctx.connColorAt(m.line, m.ap.pointAt(m.st.t)) : m.line.color })))
        : '#000' }, gMerge);
    c.dataset.grp = g.id;
    const t = el('title', {}, c);
    t.textContent = `${g.id} ${isJunc ? '接轨站' : '同站换乘'}：${leafText}${kidNote}`
      + (anyBlk ? '（含线路所：仅编辑器可见，正式网页隐藏）' : '');
    return { isPill: false, sig, scale: NaN, pend: null, els: [c], junc: isJunc, blk: anyBlk };
  }
  function syncGroupScale(rec, scale) {
    if (rec.isPill) {
      const thick = (7.5 * 2) / scale;      // ＝双线大圈直径（2×7.5），视觉等宽
      const border = 2.2 / scale;           // 黑边宽维持 2.2（2026-11-22 站圈描边整体 ×0.6 裁定下药丸黑边不动，视觉独立）
      rec.els[0].setAttribute('stroke-width', thick + 2 * border);
      rec.els[1].setAttribute('stroke-width', thick);
    } else {
      const c = rec.els[0];
      c.setAttribute('r', rec.junc ? 5.5 / scale : 7.5 / scale);
      c.setAttribute('stroke-width', (rec.junc ? 1.2 : 1.32) / scale);
      if (rec.blk) c.setAttribute('stroke-dasharray', `${3 / scale} ${3 / scale}`);
    }
    rec.scale = scale;
  }
  /** 换乘药丸／合并圈对齐到当前数据：按**绘制单元**判脏重建，待编组标黄原地切 */
  function syncGroupShapes(ctx) {
    const seen = new Set();
    let prevPill = null, prevMerge = null;
    for (const g of ctx.stationGroups) {
      // 非绘制单元（被上级同站/接轨单元吸收，或破损数据下不成单元；嵌套组 2026-11-23）不单独出图形
      if (!ctx.unitSet.has(g.id)) { dropGroupDom(g.id); continue; }
      if (g.type !== 'same-station' && g.type !== 'junction') { dropGroupDom(g.id); continue; }
      const members = [];                  // 全部叶站（直属站＋所有子孙组的直属站）按序解析
      for (const sid of ctx.leafOf.get(g.id) || []) {
        const lid2 = ctx.lineOfStop.get(sid);
        const line2 = lid2 !== undefined ? S.lines.get(lid2) : null;
        const st = line2 && line2.stops.find((x) => x.id === sid);
        if (!st) continue;
        const ap2 = arcOf(lid2);
        if (ap2) members.push({ ap: ap2, st, line: line2 });
      }
      if (!members.length) { dropGroupDom(g.id); continue; }
      const isPill = ctx.pillGroups.has(g.id);
      // 判脏键：类型＋药丸/大圈档位＋几何代际＋联络线目标摘要＋线组表摘要（线数口径）＋子组名单（提示文本）
      // ＋逐叶站 [线,t,站名,kind,角色,色,线组归属]——上级组类型/子组关系/子组成员的变化都会体现为
      // 叶站集合或档位的变化；成员自身的 color/groupId 入键（取色与线数口径依赖）
      const sig = groupUnitSig(g.type, isPill, ctx.geomGen, ctx.connDigest, ctx.lgDigest,
        ctx.tree.childrenOf.get(g.id), members);
      let rec = grpDom.get(g.id);
      if (!rec || rec.sig !== sig) {
        dropGroupDom(g.id);
        rec = buildGroupShape(g, members, isPill, ctx, sig);
        grpDom.set(g.id, rec);
      }
      const container = isPill ? pillG : gMerge;
      placeAfter(container, rec.els, isPill ? prevPill : prevMerge);
      if (isPill) prevPill = rec.els[1]; else prevMerge = rec.els[0];
      seen.add(g.id);
      if (rec.scale !== ctx.scale) syncGroupScale(rec, ctx.scale);
      // 待编组提示样式（瞬态）：直属站在待编组里，或本组（整组）待编入上层（含作为待编入组的子孙单元）
      const anyPend = g.stops.some((sid) => ctx.pend.has(sid)) || ctx.pendGrpVis.has(g.id);
      if (rec.isPill) {
        if (rec.pend !== anyPend) { rec.els[1].style.stroke = anyPend ? 'var(--warn)' : '#fff'; rec.pend = anyPend; }
      } else {
        rec.els[0].classList.toggle('pend', anyPend);
      }
    }
    for (const gid of [...grpDom.keys()]) if (!seen.has(gid)) dropGroupDom(gid);
  }
  /** 编组就近提示（纯视觉，绝不自动成组）：输入（待编组集／比例／线路重建）变了才重画。
   *  判脏键含待编入上层的整组及其全部直属站（S.pendingGroups／ctx.pendGrpSids，嵌套组 2026-11-23）：
   *  提示圈跳过 ctx.pend（待编组站＋整组待编入的组的全部直属站），整组增减、其子树变化都须经判脏键触发重画 */
  function syncHints(ctx, linesChanged) {
    if (!(S.mode === 'group' && S.pending.length)) {
      if (hintSig !== null) { gHint.textContent = ''; hintSig = null; }
      return;
    }
    if (linesChanged) hintGen++;
    const sig = ctx.scale + '|' + hintGen + '|' + S.pending.join(',') + '|' + S.pendingGroups.join(',') + '|' + ctx.pendGrpSids;
    if (sig === hintSig) return;
    hintSig = sig;
    gHint.textContent = '';
    const wpp = worldPerPixel();
    const hintWorld = 30 * wpp;
    const pendPts = [];
    for (const [lid, line] of S.lines) {
      const ap = arcOf(lid);
      if (!ap) continue;
      for (const sid of S.pending) {
        const st = line.stops.find((x) => x.id === sid);
        if (st) pendPts.push(ap.pointAt(st.t));
      }
    }
    if (!pendPts.length) return;
    const hintR = 12 / ctx.scale;
    for (const [lid, line] of S.lines) {
      const ap = arcOf(lid);
      if (!ap) continue;
      for (const st of line.stops) {
        if (ctx.pend.has(st.id)) continue;
        const p = ap.pointAt(st.t);
        if (pendPts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= hintWorld)) {
          el('circle', { cx: p[0], cy: p[1], r: hintR, class: 'hint-ring',
            'vector-effect': 'non-scaling-stroke' }, gHint);
        }
      }
    }
  }
  /** 未建线的导入 path 持久组对齐：导入集／已绑定 path 集变了才重建；选中态只切 class */
  function syncRawImports() {
    const boundPaths = new Set([...S.lines.values()].map((l) => l.path));
    if (!rawG || rawGImpRef !== S.imports || !samePathSet(rawGBound, boundPaths)) {
      if (rawG) rawG.remove();
      rawG = el('g', { id: 'imports-raw' });
      for (const imp of S.imports) {
        for (const p of imp.paths) {
          if (boundPaths.has(p.path)) continue;
          const path = el('path', { d: p.path, class: 'svg-line line-raw',
            stroke: '#999', 'vector-effect': 'non-scaling-stroke' }, rawG);
          path.dataset.impSource = imp.source;
          path.dataset.impLayer = p.sourceLayer;
          const hit = el('path', { d: p.path, class: 'svg-line line-raw-hit',
            'vector-effect': 'non-scaling-stroke' }, rawG);
          hit.dataset.impSource = imp.source;
          hit.dataset.impLayer = p.sourceLayer;
        }
      }
      rawGImpRef = S.imports;
      rawGBound = boundPaths;
      world.insertBefore(rawG, gLines);   // 渲染顺序：底图之上、线路之下
    }
    const selSrc = S.selImport && S.selImport.source, selLyr = S.selImport && S.selImport.sourceLayer;
    for (const node of rawG.children) {
      if (node.classList.contains('line-raw-hit')) continue;   // 命中线不带选中态
      node.classList.toggle('sel', !!selSrc && node.dataset.impSource === selSrc && node.dataset.impLayer === selLyr);
    }
  }
  function renderWorld() {
    ensureWorldLayers();
    scheduleBasemap();
    const ctx = renderCtx();
    syncRawImports();
    const linesChanged = syncLines(ctx);
    syncGroupShapes(ctx);
    syncHints(ctx, linesChanged);
  }
  /** 滚轮缩放的画布同步合帧（每帧至多一次 renderWorld） */
  let worldRaf = 0;
  function scheduleWorld() {
    if (worldRaf) return;
    worldRaf = requestAnimationFrame(() => { worldRaf = 0; renderWorld(); });
  }

  // ---------- 侧栏渲染 ----------
  // 面板内容没变就不动 DOM（2026-11-22 性能）：点选/编组/加站等操作每次都会把全部面板渲染函数走一遍，
  // 逐个比对其产出的 HTML 串——相同则跳过 innerHTML 赋值（免解析重建、不失焦不跳滚动），不同才重写。
  // 面板内事件全部委托在容器上、不绑子元素，故复用旧 DOM 无副作用；**面板容器只能经 setHtml 写入**。
  // 绕过 setHtml 直接改过面板内 DOM 的（如站行选中高亮是点选时直接切 class）须 markPanelDirty，
  // 否则下次渲染见 HTML 串没变会跳过重写、旧状态残留
  const panelHtml = new WeakMap();   // 容器元素 -> 上次写入的 HTML
  function setHtml(box, html) {
    if (panelHtml.get(box) === html) return;
    panelHtml.set(box, html);
    box.innerHTML = html;   // 真正写入（勿再被「box.innerHTML = html → setHtml」式批量替换吞掉）
  }
  function markPanelDirty(box) { panelHtml.delete(box); }
  // 导入源/线路列表的筛选与翻页是**临时 UI 状态**（2026-11-22）：不进快照、不进撤销、不进自动暂存，
  // 重载后回默认（全部/第 1 页）——翻页/筛选不触碰数据，与编辑操作（先 snapshot 再改）彻底分离。
  const IMP_PAGE_SIZE = 10;                       // 导入源模块每页条数
  const impListUi = new Map();                    // 导入源 source -> {filter:'all'|'unbound'|'bound', page}
  function impUiOf(source) {
    let st = impListUi.get(source);
    if (!st) { st = { filter: 'all', page: 1 }; impListUi.set(source, st); }
    return st;
  }
  /** 导入源条目的显示序（sourceLayer 拼音序；已建/未建混排同一序列）——分页与定位共用同一口径 */
  function impRowsOf(imp) {
    return [...imp.paths].sort((a, b) => a.sourceLayer.localeCompare(b.sourceLayer, 'zh'));
  }
  /** 画布点选/双击未建线后的左栏定位辅助：全部/未建线筛选下把该模块翻到目标行所在页
   *  （筛选为「已建线」时画布上的未建线行本就不可见，尊重筛选不强行翻页） */
  function pageImportIntoView(source, sourceLayer) {
    const imp = S.imports.find((i) => i.source === source);
    if (!imp) return;
    const ui = impUiOf(source);
    if (ui.filter === 'bound') return;
    const bound = new Set([...S.lines.values()].map((l) => l.path));
    const rows = ui.filter === 'unbound'
      ? impRowsOf(imp).filter((p) => !bound.has(p.path)) : impRowsOf(imp);
    const idx = rows.findIndex((p) => p.sourceLayer === sourceLayer);
    if (idx >= 0) ui.page = Math.floor(idx / IMP_PAGE_SIZE) + 1;
  }

  function renderImportList() {
    const box = $('impList');
    if (!S.imports.length) {
      setHtml(box, '<div class="imp-src">用工具导入或工具栏载入。选中一条 path 后可建线。</div>');
      return;
    }
    const bound = new Set([...S.lines.values()].map((l) => l.path));
    let html = '';
    for (const imp of S.imports) {
      // 渲染用副本按 sourceLayer 拼音序排列（已建线与未建线混排同一序列）；
      // S.imports 本身顺序不动——其载入顺序被 path 精确匹配（matchPresetForLine）等逻辑遍历依赖。
      const rows = impRowsOf(imp);
      const ui = impUiOf(imp.source);
      const filtered = ui.filter === 'all'
        ? rows
        : rows.filter((p) => (ui.filter === 'bound') === bound.has(p.path));
      const pages = Math.max(1, Math.ceil(filtered.length / IMP_PAGE_SIZE));
      if (ui.page > pages) ui.page = pages;   // 建线/切筛选后结果变短：页码回正（临时状态，无快照）
      const fltBtn = (v, lab) =>
        `<button class="mini${ui.filter === v ? ' primary' : ''}" data-impfilter="${v}">${lab}</button>`;
      html += `<div class="imp-group" data-igsrc="${esc(imp.source)}">
        <div class="imp-src">${esc(imp.source)}（${imp.imported}）</div>
        <div class="imp-filter">${fltBtn('all', '全部')}${fltBtn('unbound', '未建线')}${fltBtn('bound', '已建线')}
          <span class="imp-count">${ui.filter === 'all' ? `${rows.length} 条` : `${filtered.length}/${rows.length} 条`}</span></div>`;
      const slice = filtered.slice((ui.page - 1) * IMP_PAGE_SIZE, ui.page * IMP_PAGE_SIZE);
      for (const p of slice) {
        const isBound = bound.has(p.path);
        const sel = S.selImport && S.selImport.source === imp.source
          && S.selImport.sourceLayer === p.sourceLayer;
        html += `<div class="imp-row ${isBound ? 'bound' : ''} ${sel ? 'sel' : ''}"
          data-src="${esc(imp.source)}" data-layer="${esc(p.sourceLayer)}">
          <span class="chip" style="background:${esc(p.color)}"></span>
          <span class="nm" title="点击选中；再点「建线」创建线路">${esc(p.sourceLayer)}</span>
          ${(p.hintNames && p.hintNames.length)
            ? `<span class="imp-hint" title="自动就近匹配的源图文字，仅供参考，不保证正确">≈${esc(p.hintNames.join(' / '))}</span>` : ''}
          ${isBound ? '<span class="badge">已建线</span>'
            : `<button class="mini" data-mk="1">建线</button>`}
        </div>`;
      }
      if (pages > 1) html += `<div class="imp-foot">
        <button class="mini" data-imppg="prev" ${ui.page <= 1 ? 'disabled' : ''}>上一页</button>
        <span>${ui.page} / ${pages} 页</span>
        <button class="mini" data-imppg="next" ${ui.page >= pages ? 'disabled' : ''}>下一页</button>
      </div>`;
      html += '</div>';
    }
    setHtml(box, html);
  }

  // 线路列表分页（临时 UI 状态，同导入源）：分类组各自独立翻页，组头照旧显示组内总数
  const LINE_PAGE_SIZE = 8;
  const lineListUi = new Map();   // 分类组 key（JSON.stringify(layer)，null 组为 "null"）-> 页码
  const layerKey = (layer) => JSON.stringify(layer == null ? null : layer);
  function llPageOf(key) {
    const p = lineListUi.get(key);
    if (Number.isInteger(p) && p >= 1) return p;
    lineListUi.set(key, 1);
    return 1;
  }
  /** 左栏定位辅助（画布双击线路/车站用）：目标线不在其分类组当前页时，把该组页码切到目标页
   *  （临时 UI 状态，不动数据不进撤销）——否则分页会让 scrollIntoView 找不到行。
   *  返回是否切了页（调用方据此补一次 renderLineList） */
  function pageLineIntoView(lid) {
    const line = S.lines.get(lid);
    if (!line) return false;
    const key = layerKey((line.meta && typeof line.meta.layer === 'string' && line.meta.layer) || null);
    for (const grp of layerGroupsOf([...S.lines.values()])) {
      if (layerKey(grp.layer) !== key) continue;
      const idx = grp.lines.findIndex((l) => l.id === lid);
      if (idx >= 0) {
        const want = Math.floor(idx / LINE_PAGE_SIZE) + 1;
        const changed = llPageOf(key) !== want;
        lineListUi.set(key, want);
        return changed;
      }
      return false;
    }
    return false;
  }

  function renderLineList() {
    const box = $('lineList');
    if (!S.lines.size) { setHtml(box, '<div style="color:var(--dim)">暂无线路。</div>'); return; }
    // 按 meta.layer 分组渲染：组头（分类名＋条数）＋组内按 id 升序；未分类组固定最后；
    // 只有一类且无未分类时也照常显示组头（layerGroupsOf 保证，保持一致）。
    // 每组每页 8 条、组脚独立翻页（2026-11-22）；组头显示的仍是组内总数
    let html = '';
    for (const grp of layerGroupsOf([...S.lines.values()])) {
      const key = layerKey(grp.layer);
      const pages = Math.max(1, Math.ceil(grp.lines.length / LINE_PAGE_SIZE));
      const page = Math.min(llPageOf(key), pages);   // 删线后组变短：页码回正（临时状态，无快照）
      lineListUi.set(key, page);
      html += `<div class="ll-group" data-llkey="${esc(key)}">`;
      html += `<div class="layer-head"><span>${esc(grp.layer || '未分类')}</span><span>${grp.lines.length}</span></div>`;
      html += grp.lines.slice((page - 1) * LINE_PAGE_SIZE, page * LINE_PAGE_SIZE).map((l) => {
        // 联络线色块（2026-11-22 用户裁定：颜色属性已取消、派生自 connects 两端）——
        // 有效＝两端目标线色横向小渐变（端色判定与线身同一套 connNearestTarget）；
        // 无效（信息未填写完全）＝深灰兜底，与线身/站圈视觉一致
        let chipBg = esc(l.color);
        if (l.role === 'connector') {
          const tg = connValidTargets(l, (id) => {
            const tl = S.lines.get(id);
            const tap = tl && tl.color ? arcOf(id) : null;
            return tap ? { lid: id, color: tl.color, ap: tap } : null;
          });
          const ap = tg.length ? arcOf(l.id) : null;
          if (tg.length && ap) {
            const c0 = connNearestTarget(tg, ap.pointAt(0)).color;
            const c1 = connNearestTarget(tg, ap.pointAt(1)).color;
            chipBg = `linear-gradient(90deg, ${c0}, ${c1})`;
          } else {
            chipBg = CONNECTOR_FALLBACK;
          }
        }
        return `
        <div class="line-row ${l.id === S.activeLine ? 'active' : ''}" data-lid="${l.id}">
          <span class="chip" style="background:${chipBg}"></span>
          <span class="nm">${esc(l.name)} ${l.meta && l.meta.archived ? '<span class="badge arch">归档</span>' : ''}</span>
          <span class="id">${l.id} · ${l.stops.length}站</span>
        </div>`;
      }).join('');
      if (pages > 1) html += `<div class="ll-foot">
        <button class="mini" data-llpg="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
        <span>${page} / ${pages} 页</span>
        <button class="mini" data-llpg="next" ${page >= pages ? 'disabled' : ''}>下一页</button>
      </div>`;
      html += '</div>';
    }
    setHtml(box, html);
  }

  /** 线路 → 匹配的站圆预置项（fmt/stations-import@2）。
   *  绑定优先级：① path 字符串精确命中导入记录 → 按 sourceLayer 对名（W1 真名期）；
   *  ② 几何签名（首点/bbox/弧长，容差 0.5pt/2pt/0.5%——补 Z 等不改变几何的重导不受影响）。
   *  预置项 signature 由 tools/station_extract.py 从 import path 计算，与 path-NN 命名无关。 */
  function matchPresetForLine(l) {
    if (!l || !l.path || !S.stationPresets.length) return null;
    for (const imp of S.imports) {
      const p = imp.paths.find((x) => x.path === l.path);
      if (p) {
        const byName = S.stationPresets.find((it) => it.sourceLayer === p.sourceLayer);
        if (byName) return byName;
        break;   // path 已精确命中但预置无同名项（旧预置×新导入混用）→ 落到几何签名
      }
    }
    const ap = arcOf(l.id);
    if (!ap || !ap.pts.length) return null;
    const bb = ap.bbox();
    for (const it of S.stationPresets) {
      const sg = it.signature;
      if (!sg || !sg.first || !sg.bbox) continue;
      if (Math.hypot(sg.first[0] - ap.pts[0][0], sg.first[1] - ap.pts[0][1]) > 0.5) continue;
      if (Math.abs(sg.bbox[0] - bb[0]) > 2 || Math.abs(sg.bbox[1] - bb[1]) > 2 ||
        Math.abs(sg.bbox[2] - bb[2]) > 2 || Math.abs(sg.bbox[3] - bb[3]) > 2) continue;
      if (Math.abs(sg.length - ap.length) > Math.max(2, 0.005 * ap.length)) continue;
      return it;
    }
    return null;
  }

  function renderLineForm() {
    const box = $('lineform');
    const l = S.lines.get(S.activeLine);
    if (!l) { setHtml(box, '<div style="color:var(--dim)">选择或新建一条线路后编辑属性。</div>'); return; }
    const lgs = (S.groups && S.groups.lineGroups) || [];
    const lgOpts = ['<option value="">（无）</option>'].concat(
      lgs.map((g) => `<option value="${g.id}" ${l.groupId === g.id ? 'selected' : ''}>${g.id} ${esc(g.name)}</option>`),
      ['<option value="__new__">＋ 新建线组…</option>']).join('');
    // 「建议名」与「状态」字段已删（2026-11-22 用户裁定）：前者只留导入列表 ≈灰字与设站栏建议 chip；
    // 后者——<2 站的线路级 status 由建线默认与载入兜底统一给 'future'（见 migrateLineToV2 注释），
    // ≥2 站状态挂在分段上（左栏「设站」面板分段区管理），属性面板不再出现状态行。
    // 分类下拉：选项＝已载入导入记录里所有非空 layer 去重（拼音序）＋「（未分类）」空值；
    // 当前线 meta.layer 为手输历史值不在选项里时补一项保底显示（不得丢弃用户已存的值）
    const curLayer = (l.meta && typeof l.meta.layer === 'string' && l.meta.layer) || '';
    const layerSet = new Set();
    for (const imp of S.imports) {
      for (const p of imp.paths) {
        if (p && typeof p.layer === 'string' && p.layer) layerSet.add(p.layer);
      }
    }
    if (curLayer) layerSet.add(curLayer);
    const layerOpts = ['<option value="">（未分类）</option>'].concat(
      [...layerSet].sort((a, b) => a.localeCompare(b, 'zh'))
        .map((v) => `<option value="${esc(v)}" ${curLayer === v ? 'selected' : ''}>${esc(v)}</option>`));
    setHtml(box, `
      <div class="fld"><label>id</label><input type="text" value="${l.id}" disabled></div>
      <div class="fld"><label>名称</label><input type="text" id="lfName" value="${esc(l.name)}"></div>
      <!-- 联络线隐藏颜色输入（2026-11-22 用户裁定：颜色属性取消、派生自 connects 两端，
           手填会被 validate 拒）；角色切换处（lfRole change）同步显隐 -->
      <div class="fld" id="lfColorRow" style="display:${l.role === 'connector' ? 'none' : 'flex'}"><label>颜色</label><input type="color" id="lfColor" value="${esc(l.color || '#888888')}"></div>
      <div class="fld"><label>环线</label><input type="checkbox" id="lfLoop" ${l.loop ? 'checked' : ''}
        style="flex:1"><span style="color:var(--dim);font-size:11px">（path 闭合）</span></div>
      <div class="fld"><label>角色</label><select id="lfRole" style="flex:1">
        ${Object.entries(ROLE_LABEL).map(([r, lab]) =>
          `<option value="${r}" ${l.role === r ? 'selected' : ''}>${r}（${lab}）</option>`).join('')}
      </select></div>
      <div class="fld" id="lfGroupRow" style="display:${l.role === 'main' || l.role === 'branch' ? 'flex' : 'none'}">
        <label>线组</label><select id="lfGroup" style="flex:1">${lgOpts}</select></div>
      <div class="fld" id="lfConnRow" style="display:${l.role === 'connector' ? 'flex' : 'none'}">
        <label>联络</label><input type="text" id="lfConnects" placeholder="l0001,l0002"
          value="${esc((l.connects || []).join(','))}"></div>
      <div class="fld"><label>分类</label><select id="lfLayer" style="flex:1"
        title="＝源图 Line 直属子图层名（如 市区线/市域线/联络线）；建线时自动带入，可改">${layerOpts.join('')}</select></div>
      <div class="fld"><label>源图层</label><input type="text" value="${esc((l.meta && l.meta.sourceLayer) || '')}" disabled></div>
      ${(() => {
        const it = matchPresetForLine(l);
        if (!it) return `<div class="fld"><label>站圆预置</label><span style="flex:1;color:var(--dim);font-size:11px">（无匹配${S.stationPresets.length ? '' : '——未载入预置文件'}）</span></div>`;
        const ns = it.stops.filter((s) => s.nameSuggestion).length;
        const nc = it.stops.filter((s) => s.nameConflict && s.nameConflict.length).length;
        return `<div class="fld"><label>站圆预置</label><span style="flex:1" class="preset-line">
          <button class="mini primary" id="lfImportStops" title="按站圆圆心的弧长投影 t 批量落站；已有站 |Δt|<0.002 跳过；撤销一次回退整批">从预置导入车站</button>
          <button class="mini primary" id="lfAdoptNames" ${ns ? '' : 'disabled'}
            title="当前线所有空名普通站按 t 就近采纳站圆预置的建议名；已有名站与线路所跳过；同站不同名的换乘站不处理（站列表 ⚠ 标出，须逐个点选）；错了可手动改；撤销一次回退整批">采用全部建议名</button>
          <span style="color:var(--dim);font-size:11px">${esc(it.stationGroup)} · ${it.stops.length} 圆${ns ? ` · ${ns} 带站名建议` : ''}${nc ? ` · <span title="此换乘站在不同线路被录成了不同名字，未自动填补；站列表 ⚠ 标出，点选其一或手动输入">${nc} 个同站不同名</span>` : ''}</span>
        </span></div>`;
      })()}
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
        <button class="mini" id="lfUpdatePath" ${S.selImport ? '' : 'disabled'}
          title="用当前选中的导入 path 替换本线 path（设站按弧长 t 保留）">更新path</button>
        <button class="mini ${l.meta && l.meta.archived ? '' : 'danger'}" id="lfArchive">
          ${l.meta && l.meta.archived ? '取消归档' : '归档'}</button>
      </div>`);
  }

  /** 线路显示标签（同站不同名提示用）：有名称则「名称（id）」，否则 id */
  function lineLabelOf(lid) {
    const l = S.lines.get(lid);
    return l && l.name ? `${l.name}（${lid}）` : lid;
  }

  function renderStopList() {
    const box = $('stopList');
    const l = S.lines.get(S.activeLine);
    if (!l || !l.stops.length) {
      setHtml(box, '<div style="color:var(--dim)">在「加站」模式下点击线路加站；站名在此录入。加站类型（车站/线路所/出省箭头）用上方按钮切换。</div>');
      renderSections();
      return;
    }
    const preset = matchPresetForLine(l);   // 站名建议来源（无匹配则无 chips）
    // 站类型循环按钮（站→所→箭→站，按位置约束；2026-11-22）：标签显示**当前**类型一个字，
    // title 说明下一次点击变成什么；arrow 不再禁用（可循环改回站，免删了重放）
    const kindChar = (k) => (k === 'block' ? '所' : k === 'arrow' ? '箭' : '站');
    const kindName = (k) => (k === 'block' ? '线路所' : k === 'arrow' ? '出省箭头' : '普通车站');
    const kindDesc = (k) => k === 'block'
      ? '中途接轨点，虚线圆、可无名、仅编辑器可见（正式网页隐藏）；只能与线路所编为接轨站组'
      : k === 'arrow'
        ? '非站点，线色箭头指向线路外侧、可无名，编辑器与正式网页都显示；仅非环线头/尾可设'
        : '普通设站，需站名';
    setHtml(box, l.stops.map((st, i) => {
      const prev = i > 0 ? l.stops[i - 1].t : null;
      const next = i < l.stops.length - 1 ? l.stops[i + 1].t : null;
      const isBlk = st.kind === 'block';
      const isArr = st.kind === 'arrow';
      const tBad = st.t < 0 || st.t > 1 || (prev !== null && st.t <= prev) || (next !== null && st.t >= next)
        || (isArr && !(i === 0 || i === l.stops.length - 1));   // 箭头离开头尾即标红
      // 站名建议 chip：仅普通空名站展示（源图就近文字或人工回填的换乘站名，点选才写入；绝不自动命名；线路所/出省箭头不参与）
      const sug = preset && !isBlk && !isArr && !(st.name && st.name.trim()) ? suggestForStop(preset, st.t) : null;
      const sugTitle = sug
        ? (sug.manual
            ? '人工回填的换乘站名（来自你已命名的其他线路，保存工作区时回填）——比源图文字可靠；点击采用'
            : `源图就近文字（距站圆 ${sug.dist}pt），仅供参考、不保证正确；点击采用`)
        : '';
      // 「换」chip：该站位置来自 Trans 层换乘标（大圆=双线/药丸=多线），编组时重点核对；仅提示，编组绝不自动
      const tfm = preset && !isBlk && !isArr ? transferMarkForStop(preset, st.t) : null;
      // 同站不同名（2026-11-22 用户裁定方案一）：此换乘标在其他线路被录成 ≥2 个名字，回填未自动填补——
      // 空名站并列显示每个名字一个可点 chip（点哪个用哪个，复用建议 chip 的点击采用与手动输入保护）；
      // 已命名站只给非交互提示（便于发现笔误或有意异名后手动统一）
      const hasName = !!(st.name && st.name.trim());
      const cfl = preset && !isBlk && !isArr ? conflictsForStop(preset, st.t) : null;
      const cflTitle = cfl
        ? `同站不同名：此换乘站在其他线路被录成了不同的名字——`
          + cfl.map((c) => `「${c.name}」（${c.lines.map(lineLabelOf).join('、')}）`).join('／')
          + `。未自动填补，${hasName ? '想统一请手动改站名' : '点哪个用哪个，也可不用、手动输入'}`
        : '';
      const nk = nextStopKind(st.kind, { isLoop: l.loop, isEnd: i === 0 || i === l.stops.length - 1 });
      const cur = isBlk ? 'block' : isArr ? 'arrow' : null;
      return `
      <div class="stop-row ${S.selStop === st.id ? 'sel' : ''} ${S.pending.includes(st.id) ? 'pend' : ''}" data-sid="${st.id}">
        <span class="idx">${i + 1}</span>
        <input type="text" value="${esc(st.name)}" data-ren="${st.id}"
          class="${(st.name || isBlk || isArr) ? '' : 'warn'}"
          placeholder="${isBlk ? '（线路所，可无名）' : isArr ? '（出省箭头，可无名）' : '（站名）'}">
        ${sug ? `<span class="namehint stop-suggest" data-sugsid="${st.id}" data-sugname="${esc(sug.name)}"
          title="${esc(sugTitle)}">${esc(sug.name)}</span>` : ''}
        ${tfm ? `<span class="stop-trans" title="该站位置来自 Trans 层换乘标 ${esc(tfm.id)}（${tfm.kind === 'circle' ? '双线大圆' : '多线药丸'}）——此处为换乘，编组时重点核对；编组需人工完成，预置不自动建组">换</span>` : ''}
        ${cfl && !hasName ? cfl.map((c) => `<span class="namehint stop-conflict" data-sugsid="${st.id}" data-sugname="${esc(c.name)}"
          title="${esc(cflTitle)}">⚠ ${esc(c.name)}</span>`).join('') : ''}
        ${cfl && hasName ? `<span class="stop-trans" title="${esc(cflTitle)}">⚠ 异名</span>` : ''}
        <input type="text" value="${st.t.toFixed(6)}" data-tedit="${st.id}"
          class="tin${tBad ? ' warn' : ''}" title="弧长位置 t∈[0,1]，可手改（如起点改 0、开线终点改 1）">
        <button class="mini kind-tgl ${cur ? 'primary' : ''}" data-kind="${st.id}"
          title="当前：${kindName(cur)}。点击转为${kindName(nk)}：${kindDesc(nk)}">${kindChar(cur)}</button>
        <button class="mini danger" data-del="${st.id}" title="删除设站">✕</button>
      </div>`;
    }).join(''));
    renderSections();
  }

  /** 左栏「分段（铺满全线）」面板：每段一行（名称/状态/并段）＋覆盖区间小字＋底部按站切分。
   *  随 renderStopList 一并刷新（低频路径；分段改名逐键只写数据不重渲染，无焦点冲突）。
   *  分段实体（fmt/line@2）：名称可空、状态挂整段、边界必落站、铺满全线。 */
  function renderSections() {
    const rows = $('secRows'), splitSel = $('secSplitAt'), splitBtn = $('btnSecSplit'), hint = $('secHint');
    const line = S.lines.get(S.activeLine);
    const n = line ? line.stops.length : 0;
    if (!line || n < 2) {
      setHtml(rows, '<div style="color:var(--dim);font-size:11px">'
        + '设站 ≥2 后可用（不足 2 站时线路级状态自动取「远期」兜底，无需手设）。</div>');
      setHtml(splitSel, '');
      splitSel.disabled = splitBtn.disabled = true;
      hint.textContent = '';
      return;
    }
    splitSel.disabled = splitBtn.disabled = false;   // 下方按候选重定
    // 每段一行（段序＝线路序）：名称输入（可空）＋状态三档＋并段 ✕；
    // 末段 ✕ 仅环线显示（并首段，跨环绕）；行下小字＝覆盖区间
    setHtml(rows, (line.sections || []).map((sec, k) => {
      const span = sectionSpanOf(line, k);
      const spanTxt = !span ? '' : `站 ${span[0]}–${span[1]}`
        + (line.loop && span[1] <= span[0] ? (span[0] === span[1] ? '（经环绕段，全线）' : '（经环绕段）') : '');
      const last = k === line.sections.length - 1;
      const mergeBtn = line.loop || !last
        ? `<button class="mini danger" data-secmerge="${k}" title="${last && line.loop
          ? '与首段并段（跨环绕相邻）' : '与下一段并段'}——名称与状态取本段，下一段名字弃用">✕</button>`
        : '<span style="width:26px;flex:none"></span>';   // 非环线末段无下一段：占位对齐
      return `
      <div class="sec-row" data-seck="${k}">
        <div class="sec-main">
          <input type="text" data-secname="${k}" value="${esc(sec.name || '')}"
            placeholder="（分段名，可空）" title="分段名称，可先建后补">
          <select data-secstatus="${k}" title="分段状态（挂整段）">
            ${SEG_ORDER.map((s2) => `<option value="${s2}" ${sec.status === s2 ? 'selected' : ''}>${SEG_LABEL[s2]}</option>`).join('')}
          </select>
          ${mergeBtn}
        </div>
        <div class="sec-span">${k + 1}. ${spanTxt}</div>
      </div>`;
    }).join(''));
    // 切分站下拉：只列「两侧同段」的有意义边界（已不同段的站切了也是无操作）
    const label = (st) => {
      if (st.kind === 'block') return st.name && st.name.trim() ? `（线路所）${st.name.trim()}` : '（线路所）';
      return st.name && st.name.trim() ? st.name.trim() : '（未命名）';
    };
    const segs = line.segments || [];
    const cand = [];
    const lo = line.loop ? 1 : 2, hi = line.loop ? n : n - 1;
    for (let k = lo; k <= hi; k++) {
      const left = segs[(k - 2 + n) % n], right = segs[(k - 1) % n];
      if (segs.length && left === right) cand.push(k);
    }
    const old = splitSel.value;
    setHtml(splitSel, cand.length
      ? cand.map((k) => `<option value="${k}">${k} ${esc(label(line.stops[k - 1]))}</option>`).join('')
      : '<option value="">（无——各站边界已在段界上）</option>');
    splitSel.value = [...splitSel.options].some((o) => o.value === old) ? old : splitSel.value;
    splitSel.disabled = splitBtn.disabled = !cand.length;
    hint.textContent = cand.length
      ? '在所选站设边界：该站两侧分属两段（新段名空、状态继承原段）。'
      : '每个站间边界都已是段界——要加段请先到相邻段中间站切分。';
  }

  function stopLabel(sid) {
    for (const l of S.lines.values()) {
      const st = l.stops.find((x) => x.id === sid);
      if (st) return `${l.id} ${st.name || (st.kind === 'block' ? '（线路所）' : st.kind === 'arrow' ? '（出省箭头）' : '（未命名）')}`;
    }
    return sid;
  }

  /** sid → 设站类型（'block'＝线路所；'arrow'＝出省箭头；null＝普通车站；找不到站也返回 null） */
  function stopKindOf(sid) {
    for (const l of S.lines.values()) {
      const st = l.stops.find((x) => x.id === sid);
      if (st) return st.kind === 'block' ? 'block' : st.kind === 'arrow' ? 'arrow' : null;
    }
    return null;
  }

  // 换乘节点组列表的搜索与翻页（2026-11-22 用户需求：同线路列表/导入源口径，每页 8 个＋搜索框）。
  // 临时 UI 状态——不进快照、不进撤销、不进自动暂存，刷新回默认（同 impListUi/lineListUi）。
  // 搜索框是 editor.html 里的静态元素：列表重渲染只动 #stationGroups，输入焦点与输入法不丢。
  const SG_PAGE_SIZE = 8;
  const sgUi = { page: 1, q: '', filter: '' };   // filter：'' 全部｜'split' 两站分离（2026-11-23，shape:"pill" 配套）
  /** sid → 所属线路 id／线名／站名（检索文本与成员悬停提示用；每次渲染现建，规模小） */
  function stopInfoIndex() {
    const m = new Map();
    for (const l of S.lines.values()) for (const st of l.stops) m.set(st.id, { lineId: l.id, lineName: l.name, stopName: st.name });
    return m;
  }
  /** 搜索命中片段高亮：text 中命中任一关键词处包 <b class="hl">（逐段转义防注入；无关键词原样转义） */
  function hlMatch(text, terms) {
    if (text == null || text === '') return '';
    if (!terms.length) return esc(text);
    const re = new RegExp('(' + terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    return String(text).split(re).map((piece, i) => (i % 2 ? `<b class="hl">${esc(piece)}</b>` : esc(piece))).join('');
  }
  /** 当前搜索命中的组（保持 stationGroups 原序）与页切片；页码越界在此回正。
   *  另带组树索引（嵌套组：行里列子组/注明上级组用，见 renderGroupsPanel） */
  /** sid → 画板坐标 [x,y]（「两站分离」筛选用；每次渲染现建）——站沿线参数 t 经线几何缓存求点；
   *  线几何缺失／出省箭头返回 null */
  function stopPosIndex() {
    const m = new Map();
    for (const l of S.lines.values()) {
      const ap = S.arcs.get(l.id);
      if (!ap) continue;
      for (const st of l.stops) {
        if (st.kind === 'arrow') continue;
        m.set(st.id, ap.pointAt(st.t));
      }
    }
    return (sid) => m.get(sid) || null;
  }
  function sgVisible() {
    const sgs = (S.groups && S.groups.stationGroups) || [];
    const info = stopInfoIndex();
    const terms = searchTermsOf(sgUi.q);
    let hit = terms.length ? sgs.filter((g) => matchesTerms(groupSearchText(g, (sid) => info.get(sid)), terms)) : sgs;
    // 「两站分离」筛选（2026-11-23，shape:"pill" 配套）：双线同站、两站心相距 >50m——
    // 平行线放大后换乘大圆悬浮的候选清单，供逐个改「画法：药丸」；无标定时不筛（全表原样）
    let posOf = null;
    if (sgUi.filter === 'split' && S.calib) {
      posOf = stopPosIndex();
      const lineById = new Map([...S.lines.values()].map((l) => [l.id, l]));
      hit = hit.filter((g) => isSplitGroup(g,
        (g.stops || []).map((sid) => { const o = info.get(sid); return o ? lineById.get(o.lineId) : null; }).filter(Boolean),
        posOf, S.calib, (S.groups && S.groups.lineGroups) || [], [...S.lines.values()]));
    }
    const pg = pageSlice(hit, sgUi.page, SG_PAGE_SIZE);
    sgUi.page = pg.page;   // 拆组/换工作区后结果变短：页码回正（临时状态，无快照）
    return { rows: pg.rows, page: pg.page, pages: pg.pages, total: sgs.length, hit: hit.length, info, terms,
      tree: groupTree(sgs), posOf };
  }
  /** 新建组后的左栏定位（临时 UI 状态）：翻到该组所在页；被当前搜索词滤掉则清空搜索
   *  （输入框同步）——分页后新组追加在末尾，否则要翻到末页才看得到刚建的组 */
  function pageGroupIntoView(gid) {
    const sgs = (S.groups && S.groups.stationGroups) || [];
    const info = stopInfoIndex();
    const terms = searchTermsOf(sgUi.q);
    const hit = terms.length ? sgs.filter((g) => matchesTerms(groupSearchText(g, (sid) => info.get(sid)), terms)) : sgs;
    const list = hit.some((g) => g.id === gid) ? hit : sgs;
    if (list === sgs && terms.length) { sgUi.q = ''; $('sgSearch').value = ''; }
    const idx = list.findIndex((g) => g.id === gid);
    if (idx >= 0) sgUi.page = Math.floor(idx / SG_PAGE_SIZE) + 1;
  }

  function renderGroupsPanel() {
    if (!S.groups) {
      S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    }
    // 待编组（嵌套组 2026-11-23：另有「整组待编入上层」的既有顶层组，与站并存；单位总数 ≥2 才可建）
    const nUnits = S.pending.length + S.pendingGroups.length;
    const pgList = S.pendingGroups.length
      ? S.pendingGroups.map((pg) => `${esc(pg)}（${GROUP_TYPE_TEXT[(stationGroupsOf().find((x) => x.id === pg) || {}).type || '']}）`).join('、')
      : '';
    setHtml($('pendingBox'), S.mode === 'group' ? `
      <div style="font-size:12px;margin-bottom:4px">待编组：<b>${S.pending.length}</b> 站${S.pendingGroups.length ? `＋<b>${S.pendingGroups.length}</b> 组` : ''}
        <button class="mini primary" id="btnMkGroup" ${nUnits >= 2 ? '' : 'disabled'}>编组</button>
        <button class="mini" id="btnClearPend" ${nUnits ? '' : 'disabled'}>清空</button></div>${pgList ? `
      <div style="font-size:11px;color:var(--dim);margin-bottom:4px">整组待编入上层：${pgList}（新组建成后它们成为其子组）</div>` : ''}
      <div style="font-size:11px;color:var(--dim)">黄色虚线圈=就近提示，仅供参考，绝不自动合并。</div>` : '');
    // 换乘节点组（含线路所的组：线路所不得进 same-station/out-of-station，类型下拉锁死 junction）
    // ＋搜索框过滤＋每页 8 个翻页（组头计数：搜索时显示「命中 / 总数」）
    const sg = sgVisible();
    $('sgCount').textContent = (sg.terms.length || sgUi.filter) ? `${sg.hit} / ${sg.total} 组` : `${sg.total} 组`;
    // 行列表＋页脚一起作为 setHtml 实参（整段表达式包在括号里）：此前页脚串拼在 setHtml(...) 闭合
    // 之后、加到了其返回值 undefined 上被丢弃，页脚从未渲染，翻页无从点击（2026-11-23 修复）
    setHtml($('stationGroups'), (sg.rows.length ? sg.rows.map((g) => {
      const hasBlk = g.stops.some((sid) => stopKindOf(sid) === 'block');
      const lock = hasBlk ? ' title="组内含线路所：只能为接轨站（junction）"' : '';
      // 嵌套组（2026-11-23）：父组行的成员行尾列出子组（id＋类型，点击跳过去）；子组行注明上级组（同可跳）；
      // **顶层组**行在编组模式下给「编入上层组」——整组作为一个单位加入待编组（再点一次取消），
      // 已选中的行给待编组底色（同站列表待编组行）。非嵌套、非编组模式下行的 HTML 与原先逐字相同
      const parent = sg.tree.parentOf.get(g.id) || null;
      const kids = sg.tree.childrenOf.get(g.id) || [];
      const isPendGrp = S.pendingGroups.includes(g.id);
      const typeText = (gid) => GROUP_TYPE_TEXT[((sg.tree.byId.get(gid) || {}).type || '')];
      const kidHtml = kids.length
        ? `<span>子组：${kids.map((k) => `<span class="namehint" data-gjump="${k}" title="子组（点击跳到该组行）">${hlMatch(k, sg.terms)}（${typeText(k)}）</span>`).join('、')}</span>`
        : '';
      const nestBtn = (!parent && S.mode === 'group')
        ? `
        <button class="mini${isPendGrp ? ' primary' : ''}" data-gnest="${g.id}" title="${isPendGrp ? '已整组加入待编组：再点一次取消' : '把这个组整个作为一个单位加入待编组（嵌套组）：再配一站或另一组，点「编组」即建成它的上层组；画布上 Shift＋点换乘符号同效'}">编入上层组</button>` : '';
      const parentHtml = parent
        ? `
        <div class="m">上级组：<span class="namehint" data-gjump="${parent}" title="上级组（点击跳到该组行）">${hlMatch(parent, sg.terms)}（${typeText(parent)}）</span></div>` : '';
      // 画法强制（2026-11-23 shape:"pill"）：仅 same-station 组给「自动／药丸」下拉——
      // 药丸＝强制画胶囊（平行线双线站大圆悬浮对策）；「两站分离」筛选下附两站心距离
      const shapeSel = g.type === 'same-station' ? `
        <select data-gshape="${g.id}" title="画法：自动＝按线数（≥3 条逻辑线画药丸）；药丸＝强制画胶囊——平行线双线站放大后换乘大圆悬浮在两线之间的对策（2026-11-23）">
          <option value="" ${g.shape !== 'pill' ? 'selected' : ''}>自动</option>
          <option value="pill" ${g.shape === 'pill' ? 'selected' : ''}>药丸</option>
        </select>` : '';
      const splitNote = (sg.posOf && g.type === 'same-station')
        ? (() => { const mm = groupSplitMeters(g, sg.posOf, S.calib);
            return mm != null ? `<span class="namehint" title="组内直属站两两间地表距离的最大值">Δ≈${Math.round(mm)}m</span>` : ''; })()
        : '';
      return `
      <div class="grp-row" data-gid="${g.id}"${isPendGrp ? ' style="background:#4a3a10;border-radius:3px"' : ''}>
        <b>${hlMatch(g.id, sg.terms)}</b>
        <select data-gtype="${g.id}"${lock}>
          <option value="same-station" ${g.type === 'same-station' ? 'selected' : ''} ${hasBlk ? 'disabled' : ''}>同站</option>
          <option value="out-of-station" ${g.type === 'out-of-station' ? 'selected' : ''} ${hasBlk ? 'disabled' : ''}>出闸</option>
          <option value="junction" ${g.type === 'junction' ? 'selected' : ''}>接轨站</option>
          <option value="" ${!g.type ? 'selected' : ''} ${hasBlk ? 'disabled' : ''}>type 未定</option>
        </select>${shapeSel}${nestBtn}
        <button class="mini danger" data-gdel="${g.id}">拆组</button>
        <div class="m">${g.stops.map((s2) => {
          const o = sg.info.get(s2);
          return `<span title="${esc(o ? o.lineName || '' : '')}">${hlMatch(stopLabel(s2), sg.terms)}</span>`;
        }).join('；')}${kidHtml ? `${g.stops.length ? '；' : ''}${kidHtml}` : ''}${splitNote ? `；${splitNote}` : ''}</div>${parentHtml}
      </div>`;
    }).join('')
      : `<div style="color:var(--dim);font-size:12px">${sg.total ? '（无匹配）' : '（暂无）'}</div>`)
      + (sg.pages > 1 ? `<div class="sg-foot">
        <button class="mini" data-sgpg="prev" ${sg.page <= 1 ? 'disabled' : ''}>上一页</button>
        <span>${sg.page} / ${sg.pages} 页</span>
        <button class="mini" data-sgpg="next" ${sg.page >= sg.pages ? 'disabled' : ''}>下一页</button>
      </div>` : ''));
    // 线组
    const lgs = S.groups.lineGroups || [];
    setHtml($('lineGroups'), lgs.length ? lgs.map((g) => {
      const members = [...S.lines.values()].filter((l) => l.groupId === g.id);
      return `<div class="grp-row" data-lgid="${g.id}">
        <span class="chip" style="display:inline-block;width:11px;height:11px;background:${esc(g.color || '#888')};border-radius:3px"></span>
        <b>${g.id}</b> ${esc(g.name)}
        <button class="mini danger" data-lgdel="${g.id}" ${members.length ? 'disabled title="仍有成员线"' : ''}>删除</button>
        <div class="m">${members.length ? members.map((m) => `${m.id} ${esc(m.name)}`).join('；') : '（无成员）'}</div>
      </div>`;
    }).join('') : '<div style="color:var(--dim);font-size:12px">（暂无）</div>');
  }

  // ---------- 线路介绍面板（lineinfo.md 用户手填介绍；2026-11-23 增） ----------
  // 入口＝左栏「编组」节之后的「线路介绍」节。线组列表数据源＝S.groups.lineGroups（与「线组」
  // 列表同源）；选中线组后 textarea 编辑该组在 lineinfo.md 中的那一节 md 原文（不搞结构化表单，
  // 保留手写 md 习惯），防抖 300ms 实时预览——渲染复用查看器 VIEWER_CORE.parseLineInfo
  // （editor.html 载入 src/viewer_core.js，实现零语义改动）。文件读写：载入见
  // applyWorkspace／bootFetchData，落盘见 saveLineinfoIfChanged（只替换被编辑节，其余字节
  // 逐位保留）；未保存改动＝S.lineinfoMd 与 S.lineinfoSavedMd 失配，列表行内 ● 标出，
  // 文本与基线随自动暂存持久（刷新不丢），「保存工作区」后基线同步、标记清零。
  let liSel = null;              // 当前选中线组 id（临时 UI 状态：不进快照/撤销/自动暂存）
  let liPrevTimer = null;        // 预览防抖计时
  const liVC = () => (global.VIEWER_CORE && typeof global.VIEWER_CORE.parseLineInfo === 'function')
    ? global.VIEWER_CORE : null;

  /** 预览渲染：parseLineInfo 只认「## <id> …」标题绑定（id＝标题首个 token），标题 id 改掉即提示 */
  function liRenderPreview(secText) {
    const vc = liVC();
    const parsed = (vc && secText) ? vc.parseLineInfo(secText)[liSel] : null;
    if (!parsed) {
      setHtml($('liPrev'), secText
        ? '<span style="color:var(--warn)">标题 id 与所选线组不匹配（绑定靠「## <线组id>」的首个 token）</span>'
        : '<span style="color:var(--dim)">（无内容）</span>');
      return;
    }
    const parts = [];
    if (parsed.fields.length) {
      parts.push('<div class="li-flds">' + parsed.fields.map((fv) =>
        `<div><span class="li-k">${esc(fv[0])}:</span> ${esc(fv[1])}</div>`).join('') + '</div>');
    }
    // bodyHtml 为 parseLineInfo 产物：一切文本已转义、只含白名单标签（viewer_core 安全注），可直接 innerHTML
    if (parsed.bodyHtml) parts.push('<div class="li-body">' + parsed.bodyHtml + '</div>');
    if (parsed.links.length) {
      parts.push('<ul class="li-links">' + parsed.links.map((l) =>
        `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.text)}</a></li>`).join('') + '</ul>');
    }
    setHtml($('liPrev'), parts.join('') || '<span style="color:var(--dim)">（无内容）</span>');
  }
  function liPreviewSoon() {
    clearTimeout(liPrevTimer);
    liPrevTimer = setTimeout(() => liRenderPreview(extractLineInfoSection(S.lineinfoMd, liSel)), 300);
  }

  /** 编辑区随选中线组就位（值相同不重写 textarea——保住光标位置） */
  function liLoadEditor() {
    const g = liSel && S.groups ? (S.groups.lineGroups || []).find((x) => x.id === liSel) : null;
    const sec = g ? extractLineInfoSection(S.lineinfoMd, liSel) : null;
    const ta = $('liText');
    if (ta.value !== (sec || '')) ta.value = sec || '';
    ta.disabled = !g || sec == null;
    $('btnLiSkeleton').disabled = !g || sec != null;
    setHtml($('liHint'), !g ? '左侧列表选一个线组，编辑它在 lineinfo.md 里的介绍节。'
      : sec == null ? `线组 ${esc(g.id)} 还没有介绍节——点「生成骨架」创建（全占位符），也可改后再保存工作区。`
      : '');
    liRenderPreview(sec);
    liSyncState();
  }
  /** 脏标记行（未保存改动＝内存文本与落盘基线失配） */
  function liSyncState() {
    const dirty = typeof S.lineinfoMd === 'string' && S.lineinfoMd !== S.lineinfoSavedMd;
    const st = $('liState');
    st.textContent = dirty ? '有未保存改动（随「保存工作区」写入 lineinfo.md）' : '';
    st.style.color = dirty ? 'var(--warn)' : 'var(--dim)';
  }
  /** 线组列表（数据源＝S.groups.lineGroups；行内标节有无＋未保存 ●）。只重画列表容器，
   *  不动 textarea——输入逐键调用不失焦点 */
  function renderLineInfoList() {
    const lgs = (S.groups && S.groups.lineGroups) || [];
    setHtml($('liList'), lgs.length ? lgs.map((g) => {
      const cur = extractLineInfoSection(S.lineinfoMd, g.id);
      const dirty = cur != null && cur !== extractLineInfoSection(S.lineinfoSavedMd, g.id);
      return `<div class="grp-row li-row${g.id === liSel ? ' li-sel' : ''}" data-lisel="${esc(g.id)}" title="点击编辑该线组的介绍节">`
        + `<span class="chip" style="display:inline-block;width:11px;height:11px;background:${esc(g.color || '#888')};border-radius:3px"></span>`
        + `<b>${esc(g.id)}</b> ${esc(g.name || '')}`
        + `<span class="li-mark">${dirty ? '<span style="color:var(--warn)">●</span>' : ''}`
        + (cur != null ? '有节' : '<span style="color:var(--dim)">无节</span>') + '</span>'
        + `</div>`;
    }).join('') : '<div style="color:var(--dim);font-size:12px">（暂无线组——先在「编组」节新建线组）</div>');
  }
  function renderLineInfoPanel() {
    // 组删了清选中（撤销/载入工作区后 liSel 可能悬空）
    if (liSel && !(S.groups && (S.groups.lineGroups || []).some((x) => x.id === liSel))) liSel = null;
    renderLineInfoList();
    liLoadEditor();
  }

  $('liList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-lisel]');
    if (!row || row.dataset.lisel === liSel) return;
    liSel = row.dataset.lisel;
    renderLineInfoPanel();
  });
  // 生成骨架（节不存在时可点）：文件不存在先按仓库 data/lineinfo.md 模板头新建（注释头＋该组
  // 骨架，示例节不带进来）；生成即改内存文本＋自动暂存，落盘仍等「保存工作区」
  $('btnLiSkeleton').addEventListener('click', async () => {
    const g = liSel && S.groups ? (S.groups.lineGroups || []).find((x) => x.id === liSel) : null;
    if (!g) return;
    const sec = lineInfoSectionSkeleton(g.id, g.name);
    if (typeof S.lineinfoMd !== 'string') {
      let tpl = S.liTplText;
      if (typeof tpl !== 'string') {
        try { const r = await fetch('data/lineinfo.md', { cache: 'no-cache' }); if (r.ok) tpl = await r.text(); } catch (e) { /* file:// 等，忽略 */ }
        if (typeof tpl === 'string') S.liTplText = tpl;
      }
      S.lineinfoMd = lineInfoTemplateHeader(tpl) + sec;
      setStatus(`已新建 lineinfo.md（仓库模板注释头）并为 ${g.id} 生成介绍节骨架——全是占位符，请改掉 … 再保存工作区。`);
    } else {
      S.lineinfoMd = replaceLineInfoSection(S.lineinfoMd, liSel, sec);
      setStatus(`已为 ${g.id} 生成介绍节骨架——全是占位符，请改掉 … 再保存工作区。`);
    }
    renderLineInfoPanel();
    autosave();
  });
  // 编辑＝内存文本按节替换（replaceLineInfoSection 保真：其余节逐字节不动）＋自动暂存；
  // 预览防抖刷新；落盘等「保存工作区」
  $('liText').addEventListener('input', () => {
    if (!liSel || $('liText').disabled) return;
    S.lineinfoMd = replaceLineInfoSection(S.lineinfoMd, liSel, $('liText').value);
    liPreviewSoon();
    liSyncState();
    renderLineInfoList();
    autosave();
  });

  /** 待编入上层的整组态的失配清理（嵌套组）：撤销/拆组/删站后可能残留已不存在或已非顶层的组 id——
   *  只留仍存在的顶层组（瞬态状态，不进快照） */
  function syncPendingGroups() {
    if (!S.pendingGroups.length) return;
    const tree = groupTree(stationGroupsOf());
    S.pendingGroups = S.pendingGroups.filter((gid, i, a) => tree.byId.has(gid) && !tree.parentOf.has(gid) && a.indexOf(gid) === i);
  }

  function renderAll() {
    if (!S.view) fitView();
    syncPendingGroups();
    applyView();
    renderWorld();
    renderImportList();
    renderLineList();
    renderLineForm();
    renderStopList();
    renderGroupsPanel();
    renderLineInfoPanel();
    autosave();
  }

  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.style.color = isErr ? 'var(--err)' : 'var(--dim)';
  }

  /** 右上角静默轻提示（2026-11-22 需求 3）：不打断操作、不占底部状态条——保存过程会频繁
   *  setStatus，回填这类「顺带完成」的反馈若走状态条会被立刻冲掉；4 秒自动淡出。 */
  function toast(msg) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.classList.remove('show'), 4000);
  }

  // ---------- 线路操作 ----------
  function allocLid() { return bumpCounter('nextL', 'l', 4); }

  function createLineFromImport(source, sourceLayer) {
    const imp = S.imports.find((i) => i.source === source);
    const p = imp && imp.paths.find((x) => x.sourceLayer === sourceLayer);
    if (!p) return;
    snapshot();
    const lid = allocLid();
    const line = {
      // name 留空待人工录入（不擅自命名）；导入列表里的 ≈灰字仅建议展示，点选采用才写入
      schema: 'fmt/line@2', id: lid, name: '',
      groupId: null, role: 'standalone', color: p.color,
      loop: /z/i.test(p.path), path: p.path, connects: [],
      // 建线一律默认远期（2026-11-22 用户说明：预控通道线默认均为远期、不设站）——
      // 预控通道线站数<2 时线路级 status 即整线显示状态（renderWorld 整线单段，仅该类别），
      // 第 2 站落位时由 fixStatusField 据此生成默认分段
      stops: [], segments: [], sections: [], status: 'future',
      info: {},
      meta: { created: today(), updated: today(), archived: false,
        aliases: [], sourceLayer: sourceLayer, stopSeq: 0 },
    };
    // 分类继承：path 记录带 layer 字段（.ai Line 直属子图层名，可能不存在——防御式读取）则原样带入。
    // 「更新path」不回写分类——layer 只在建线时作初始值，此后属人工设定（renderLineForm 分类下拉改）。
    if (typeof p.layer === 'string' && p.layer) line.meta.layer = p.layer;
    S.lines.set(lid, line);
    S.activeLine = lid; S.selStop = null;
    renderAll();
    // 预控通道线不设站（用户说明，见上）：提示语不再引导设站
    if (line.meta.layer === LAYER_RESERVED) {
      setStatus(`已建线 ${lid}（${LAYER_RESERVED}）：默认远期、无需设站即整线显示。请在属性面板命名。`);
      return;
    }
    setStatus(`已建线 ${lid}。请在属性面板命名，再到「加站」模式点击线路设站。`);
  }

  function updatePathFromImport() {
    const l = S.lines.get(S.activeLine);
    if (!l || !S.selImport) return;
    const imp = S.imports.find((i) => i.source === S.selImport.source);
    const p = imp && imp.paths.find((x) => x.sourceLayer === S.selImport.sourceLayer);
    if (!p) return;
    if (p.path === l.path) { setStatus('选中导入 path 与当前线路相同。'); return; }
    snapshot();
    l.path = p.path;
    l.meta.updated = today();
    S.arcs.delete(l.id);
    renderAll();
    setStatus(`已更新 ${l.id} 的 path（${l.stops.length} 站按弧长 t 保留，请目视核查站点位置）。`);
  }

  /** 站圆预置批量落站：一次快照、整批插入、撤销一次回退整批。
   *  站名一律不写入（预置 nameSuggestion 仅作 chips 建议点选采用）；不自动建换乘编组。 */
  function importStopsFromPreset() {
    const l = S.lines.get(S.activeLine);
    if (!l) return;
    const item = matchPresetForLine(l);
    if (!item) { setStatus('当前线路没有匹配的站圆预置（预置按几何签名绑定，与 path-NN 命名无关）。', true); return; }
    const plan = planStopImport(l, item.stops);
    if (!plan.total) { setStatus('该预置项没有站圆。', true); return; }
    if (!plan.inserts.length) {
      setStatus(`预置 ${plan.total} 圆位置均已有站（|Δt|<0.002），本次未导入。`);
      return;
    }
    snapshot();
    const added = applyStopImport(l, plan);
    l.meta.updated = today();
    renderAll();
    const nTrans = item.stops.filter((s) => s.transfer).length;
    setStatus(`站圆预置导入「${item.stationGroup}」：新增 ${added.length} 站`
      + (nTrans ? `（含 ${nTrans} 个换乘标站，站列表「换」chip 标记）` : '')
      + `、跳过 ${plan.skippedExist}（已有站在位）`
      + (plan.skippedConflict ? `、${plan.skippedConflict}（位置过近冲突）` : '')
      + `、预置共 ${plan.total} 圆。站名未写入——空名站旁的建议 chips 点选采用；撤销一次回退整批。`);
  }

  /** 一键采用建议名：当前线所有空名站按 t 就近写入站圆预置的 nameSuggestion。
   *  口径与「绝不自动写入建议名」一致——本操作由用户人工点击「采用全部建议名」触发，属批量人工采用而非自动命名：
   *  只填空名站、已有名站跳过；写入前一次 snapshot，撤销一次回退整批；个别错名可再手动改。 */
  function adoptSuggestedNames() {
    const l = S.lines.get(S.activeLine);
    if (!l) { setStatus('没有当前线路，无法采用建议名。', true); return; }
    const preset = matchPresetForLine(l);
    if (!preset) { setStatus('当前线路没有匹配的站圆预置（预置按几何签名绑定，与 path-NN 命名无关）。', true); return; }
    let named = 0, noSug = 0, blk = 0, arr = 0, conflictN = 0;
    const pairs = [];
    for (const st of l.stops) {
      if (st.kind === 'block') { blk++; continue; }       // 线路所可无名，不参与建议名
      if (st.kind === 'arrow') { arr++; continue; }       // 出省箭头非站点，不参与建议名
      if (st.name && st.name.trim()) { named++; continue; }
      // 同站不同名（2026-11-22 用户裁定方案一）：多名冲突站一律跳过，须人工在站列表点选——
      // 批量采用会替用户裁决名字，正是冲突标记要避免的
      if (conflictsForStop(preset, st.t)) { conflictN++; continue; }
      const sug = suggestForStop(preset, st.t);
      if (sug) pairs.push([st, sug]);
      else noSug++;
    }
    if (!pairs.length) {
      setStatus(`没有可采用的建议名：${noSug} 个空名站无就近建议（|Δt|>0.002）`
        + (conflictN ? `，${conflictN} 个换乘站同站不同名未处理（站列表 ⚠ 标出，请逐个点选或手动输入）` : '')
        + (named ? `，${named} 站已有名跳过` : '') + '。');
      return;
    }
    snapshot();   // 写入前一次快照：整批一次撤销（无可采用时上面已 return，不清快照）
    for (const [st, sug] of pairs) st.name = sug.name;
    l.meta.updated = today();
    renderAll();
    setStatus(`已采用 ${pairs.length} 个建议名（空名站按 t 就近写入，可手动修改）`
      + `、跳过 ${named} 个已有名`
      + (conflictN ? `、${conflictN} 个换乘站同站不同名（未处理，站列表 ⚠ 标出，请逐个点选或手动输入）` : '')
      + (blk ? `、${blk} 个线路所` : '')
      + (arr ? `、${arr} 个出省箭头` : '')
      + (noSug ? `、${noSug} 个空名站无就近建议（|Δt|>0.002）` : '')
      + '；撤销一次回退整批。');
  }

  // ---------- 设站操作 ----------
  /** kind：null＝车站（缺省，stop 不写 kind 字段——老数据零迁移），'block'＝线路所（中途接轨点），
   *  'arrow'＝出省箭头（非站点，仅非环线头/尾可放） */
  function addStop(lid, t, kind) {
    const line = S.lines.get(lid);
    const ap = arcOf(lid);
    if (!line || !ap) return;
    t = Math.round(t * 1e6) / 1e6;
    // 找插入位置（t 严格递增）
    let i = 0;
    while (i < line.stops.length && line.stops[i].t < t) i++;
    // 出省箭头落位约束（先于快照：拒绝不压撤销栈）——环线一律不允许、非头尾拒绝不落站
    if (kind === 'arrow' && !canPlaceArrow(line, i)) {
      setStatus(line.loop
        ? '出省箭头不能放在环线上（环线无出省端点），未添加。'
        : '出省箭头只能放在线路的头/尾（当前落点算出在中间），未添加。', true);
      return;
    }
    const prevT = i > 0 ? line.stops[i - 1].t : null;
    const nextT = i < line.stops.length ? line.stops[i].t : null;
    if (prevT !== null && t - prevT < EPS) t = prevT + EPS;
    if (nextT !== null && nextT - t < EPS) t = nextT - EPS;
    // t 域 [0,1] 双闭：开线终点站可精确落 1（t=1 时 while 循环必推到末位，nextT=null，
    // EPS 微调不会把合法的 1 挪成 1-ε；与已有 t=1 站重复/过近仍走上方微调或在此拒绝）
    if (t < 0 || t > 1 || (prevT !== null && t <= prevT) || (nextT !== null && t >= nextT)) {
      setStatus('此处与相邻设站过近，未添加。', true); return;
    }
    snapshot();
    const seq = nextStopSeq(line);
    const sid = `${lid}-s${String(seq).padStart(2, '0')}`;
    const st = { id: sid, name: '', t: t, geo: null };
    if (kind === 'block') st.kind = 'block';
    else if (kind === 'arrow') st.kind = 'arrow';
    line.stops.splice(i, 0, st);
    segInsert(line, i);
    fixStatusField(line);
    line.meta.updated = today();
    S.selStop = sid;
    renderAll();
    setStatus(kind === 'block'
      ? `已加线路所 ${sid}（t=${t}，可无名；虚线圆，仅编辑器可见）。`
      : kind === 'arrow'
        ? `已加出省箭头 ${sid}（t=${t}，非站点、可无名；箭头指向线路外侧）。`
        : `已加站 ${sid}（t=${t}）。请在左侧录入站名。`);
    const input = document.querySelector(`#stopList input[data-ren="${sid}"]`);
    if (input) input.focus();
  }

  function deleteStop(lid, sid) {
    const line = S.lines.get(lid);
    if (!line) return;
    const i = line.stops.findIndex((s) => s.id === sid);
    if (i < 0) return;
    snapshot();
    segRemove(line, i);
    line.stops.splice(i, 1);
    fixStatusField(line);
    line.meta.updated = today();
    // 从换乘节点组中移除引用，防止悬挂
    let grpNote = '';
    if (S.groups) {
      let directGid = null;
      for (const g of S.groups.stationGroups || []) {
        if (g.stops.includes(sid)) {
          g.stops = g.stops.filter((x) => x !== sid);
          grpNote = `（已从 ${g.id} 移除）`;
          directGid = g.id;
        }
      }
      // 成员单位总数（直属站＋子组，嵌套组 2026-11-23）不足 2 的组拆除；被拆的组若还有上级，上级摘除
      // 对它的引用并按同规则级联（pruneStationGroups）。直属站所在组自身的拆除沿用旧例不另报，其余一并报出
      const gone = pruneStationGroups(S.groups.stationGroups || []);
      S.groups.stationGroups = S.groups.stationGroups || [];
      const casc = gone.filter((x) => x !== directGid);
      if (casc.length) grpNote += `；${casc.join('、')} 成员不足 2 已自动拆组`;
    }
    if (S.selStop === sid) S.selStop = null;
    S.pending = S.pending.filter((x) => x !== sid);
    renderAll();
    setStatus(`已删站 ${sid}。${grpNote}`);
  }

  function moveStop(lid, sid, t) {
    const line = S.lines.get(lid);
    if (!line) return false;
    const i = line.stops.findIndex((s) => s.id === sid);
    if (i < 0) return false;
    const lo = i > 0 ? line.stops[i - 1].t + EPS : 0;
    // 末站拖动上界放开到 1（t 域双闭，2026-11-21；与手改/加站一致——否则拖动是唯一落不到 1 的路径）。
    // 环线末站拖至 1 与首站 t=0 物理同点，不拦截（用户自律 + 严格递增兜底）。
    const hi = i < line.stops.length - 1 ? line.stops[i + 1].t - EPS : 1;
    if (t < lo) t = lo;
    if (t > hi) t = hi;
    t = Math.round(t * 1e6) / 1e6;
    if (Math.abs(t - line.stops[i].t) < 1e-7) return false;
    line.stops[i].t = t;
    line.meta.updated = today();
    return true;
  }

  // ---------- 交互 ----------
  let drag = null;     // {type:'stop', lid, sid, moved, pre}
  let panning = null;  // {x,y,sx,sy,view,moved}；点按位移 ≤4px 视为点击而非拖动
  let rubber = null;   // 编组模式拉框 {x0,y0,x1,y1,sx,sy,moved}（世界坐标）
  let downHit = null;  // 按下时的 e.target：pointer capture 下 pointerup 的 e.target 恒为 svg，命中判定改用此记录
  let lastCanvasClick = null;  // {t,key}：自实现画布双击判定（renderWorld 重建 DOM 会使原生 dblclick 目标漂移）
  /** 同一目标 500ms 内第二次点击＝双击：执行 fn。返回是否命中 */
  function regCanvasDbl(key, fn) {
    const now = Date.now();
    if (lastCanvasClick && lastCanvasClick.key === key && now - lastCanvasClick.t < 500) {
      lastCanvasClick = null;
      fn();
      return true;
    }
    lastCanvasClick = { t: now, key };
    return false;
  }
  /** 画布双击线路/段后：左栏定位并滚动可见（分页感知：目标线不在当前页先切页） */
  function locateLineInList(lid) {
    S.activeLine = lid; S.selStop = null;
    pageLineIntoView(lid);
    renderLineList(); renderLineForm(); renderStopList();
    const r = [...$('lineList').querySelectorAll('.line-row')].find((x) => x.dataset.lid === lid);
    if (r) r.scrollIntoView({ block: 'nearest' });
  }
  /** 画布点站后的左栏同步：当前线没变只切站行高亮（不重建列表——同站列表点选的做法，免重建丢焦点）；
   *  当前线变了才整体刷新三块 */
  function syncAfterStopPick(prevActive) {
    if (S.activeLine !== prevActive) { renderStopList(); renderLineList(); renderLineForm(); return; }
    for (const r of $('stopList').querySelectorAll('.stop-row')) {
      r.classList.toggle('sel', r.dataset.sid === S.selStop);
    }
    markPanelDirty($('stopList'));   // 直接改了 class：下次渲染须重写，免选中态回退后旧高亮残留
  }
  /** 画布双击车站后：左栏定位滚动可见（线路行分页感知同上） */
  function locateStopInList(sid, lid) {
    const r = [...$('stopList').querySelectorAll('.stop-row')].find((x) => x.dataset.sid === sid);
    if (r) r.scrollIntoView({ block: 'nearest' });
    if (pageLineIntoView(lid)) renderLineList();   // 目标线不在当前页：先切页再找行
    const lr = [...$('lineList').querySelectorAll('.line-row')].find((x) => x.dataset.lid === lid);
    if (lr) lr.scrollIntoView({ block: 'nearest' });
    setStatus(`已在左栏定位 ${sid}。`);
  }

  function startPan(e) {
    panning = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY,
      view: { ...S.view }, moved: false };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  }

  function nearestLineAt(wx, wy) {
    const wpp = worldPerPixel();
    const maxD = 40 * wpp;
    // 加站优先落在当前选中线（2026-11-22 用户指示）：共线/密线场景点击常被略近的
    // 邻线抢走——选中线在吸附半径内即直接命中；半径外照旧回落全局最近线
    if (S.activeLine) {
      const line0 = S.lines.get(S.activeLine);
      const ap0 = line0 && !(line0.meta && line0.meta.archived) && arcOf(S.activeLine);
      if (ap0) {
        const pr0 = ap0.project(wx, wy);
        if (pr0.d <= maxD) return { lid: S.activeLine, pr: pr0 };
      }
    }
    let best = null;
    for (const [lid, line] of S.lines) {
      if (line.meta && line.meta.archived) continue;
      const ap = arcOf(lid);
      if (!ap) continue;
      const pr = ap.project(wx, wy);
      if (pr.d <= maxD && (!best || pr.d < best.pr.d)) best = { lid, pr };
    }
    return best;
  }

  svg.addEventListener('pointerdown', (e) => {
    if (e.button === 1) { startPan(e); return; }          // 中键：任何位置、任何模式平移
    if (e.button !== 0) return;
    downHit = e.target;   // pointerup 命中判定用（capture 下 e.target 失真）
    const stopEl = e.target.closest('.stop-c');
    if (stopEl && S.mode === 'add') {
      // 加站模式：按住站圈拖动＝改位（2026-11-21 用户裁定：仅加站模式可拖动）
      const sid = stopEl.dataset.sid, lid = stopEl.dataset.lid;
      const prevActive = S.activeLine;
      S.activeLine = lid;
      S.selStop = sid;
      syncAfterStopPick(prevActive);
      renderWorld();   // 落选中环（增量渲染：只挪环，不重建线路），并取站圈引用供拖动局部更新
      drag = { type: 'stop', lid, sid, moved: false,
        el: world.querySelector(`.stop-c[data-sid="${CSS.escape(sid)}"]`),
        ring: world.querySelector('.stop-ring'),
        pre: JSON.stringify({ lines: [...S.lines.values()], groups: S.groups, lineOrder: S.lineOrder }) };   // 不含 imports（同 snapshot 性能修正）
      svg.setPointerCapture(e.pointerId);
      regCanvasDbl(`stop:${sid}`, () => locateStopInList(sid, lid));   // 双击站圈：左栏定位
      return;
    }
    if (stopEl && S.mode === 'select') {
      // 选择模式点站：仅选中并切换当前线（不拖动）；随后的拖动落到下方平移
      const sid = stopEl.dataset.sid, lid = stopEl.dataset.lid;
      const prevActive = S.activeLine;
      S.activeLine = lid;
      S.selStop = sid;
      syncAfterStopPick(prevActive);
      regCanvasDbl(`stop:${sid}`, () => locateStopInList(sid, lid));   // 双击站圈：左栏定位
    }
    if (S.mode === 'group') {
      if (stopEl) { startPan(e); return; }                 // 站圈点按：pointerup 切换待编组；按住拖动＝平移（防拖远松手误切换）
      const [wx, wy] = toWorld(e);                         // 其余任意处起拉：拉框直接建组
      rubber = { x0: wx, y0: wy, x1: wx, y1: wy, sx: e.clientX, sy: e.clientY, moved: false };
      svg.setPointerCapture(e.pointerId);
      return;
    }
    startPan(e);   // 选择/加站：空白或线路上左键拖动平移；未移动的松手仍按点击处理
  });

  svg.addEventListener('pointermove', (e) => {
    if (panning && S.view) {
      if (Math.hypot(e.clientX - panning.sx, e.clientY - panning.sy) > 4) panning.moved = true;
      const kx = S.view.w / svg.clientWidth;
      S.view.x = panning.view.x - (e.clientX - panning.x) * kx;
      S.view.y = panning.view.y - (e.clientY - panning.y) * kx;
      applyView();
      scheduleBasemap();   // 平移只改 viewBox 不重绘，底图需单独补瓦片
      return;
    }
    if (rubber) {
      const [wx, wy] = toWorld(e);
      rubber.x1 = wx; rubber.y1 = wy;
      if (Math.hypot(e.clientX - rubber.sx, e.clientY - rubber.sy) > 4) rubber.moved = true;
      const r = $('rubber');
      r.style.display = '';
      r.setAttribute('x', Math.min(rubber.x0, rubber.x1).toFixed(2));
      r.setAttribute('y', Math.min(rubber.y0, rubber.y1).toFixed(2));
      r.setAttribute('width', Math.abs(rubber.x1 - rubber.x0).toFixed(2));
      r.setAttribute('height', Math.abs(rubber.y1 - rubber.y0).toFixed(2));
      return;
    }
    if (drag && drag.type === 'stop') {
      // 拖动途中若发生重绘（滚轮合帧／窗体尺寸变化），该线因 t 已变而被重建：重取引用，保持局部更新
      if (!drag.el || !drag.el.isConnected) {
        drag.el = world.querySelector(`.stop-c[data-sid="${CSS.escape(drag.sid)}"]`);
        drag.ring = world.querySelector('.stop-ring');
      }
      const [wx, wy] = toWorld(e);
      if (moveStop(drag.lid, drag.sid, nearestTOnLine(drag.lid, wx, wy))) {
        drag.moved = true;
        // 拖动中只挪该站图形＋选中环＋title（松手再对齐列表 t 值/排序）——满规模防逐帧重绘卡顿；
        // 出省箭头是 <path>，原地重算三角（见下）
        const line = S.lines.get(drag.lid);
        const st = line && line.stops.find((x) => x.id === drag.sid);
        const ap = st && arcOf(drag.lid);
        if (st && ap && drag.el && drag.el.isConnected) {
          const [x, y] = ap.pointAt(st.t);
          if (drag.el.tagName === 'path') {
            // 出省箭头是 <path>（挪 cx/cy 无效、方向还随位置变）：原地重算三角，同样不全量重绘
            drag.el.setAttribute('d', arrowPathString(ap, st.t, line.stops.indexOf(st), viewScale()));
          } else {
            drag.el.setAttribute('cx', x); drag.el.setAttribute('cy', y);
          }
          if (drag.ring && drag.ring.isConnected) { drag.ring.setAttribute('cx', x); drag.ring.setAttribute('cy', y); }
          const tt = drag.el.querySelector('title');
          if (tt) tt.textContent = stopTitle(line, st, line.stops.indexOf(st),
            ((S.groups && S.groups.stationGroups) || []).find((g) => g.stops.includes(drag.sid)));
        } else {
          renderWorld(); renderStopList();
        }
      }
    }
  });

  svg.addEventListener('pointerup', (e) => {
    if (panning) {
      const wasPan = panning.moved;
      panning = null;
      svg.classList.remove('panning');
      if (wasPan) return;          // 确实拖动过：这是平移，吞掉点击语义
    }
    if (rubber) {
      const rb = rubber;
      rubber = null;
      $('rubber').style.display = 'none';
      if (rb.moved) { boxSelectStops(rb); return; }
    }
    if (drag && drag.type === 'stop') {
      if (drag.moved) {
        S.undo.push(drag.pre);  // 用拖动前快照
        if (S.undo.length > 100) S.undo.shift();
        autosave();
        renderWorld(); renderStopList();   // 拖动中只做局部更新，松手一次性全量对齐
      }
      drag = null;
      return;
    }
    const [wx, wy] = toWorld(e);

    // 命中判定：平移/拉框的 pointer capture 使 e.target 恒为 <svg>，
    // 改用按下时记录的目标元素（未拖动的点击，按下与松手位置一致）
    const hitEl = (downHit && downHit.isConnected) ? downHit : e.target;
    downHit = null;

    if (S.mode === 'add') {
      const hit = nearestLineAt(wx, wy);
      if (hit) {
        addStop(hit.lid, hit.pr.t, S.addKind);
      } else {
        setStatus('点击位置不在任何线路附近（吸附半径 40px）。', true);
      }
      return;
    }

    if (S.mode === 'group') {
      const mgEl = hitEl.closest('.stop-merge, .grp-pill');
      if (mgEl) {
        const g = S.groups.stationGroups.find((x) => x.id === mgEl.dataset.grp);
        // Shift＋点换乘符号＝把该绘制单元的组整个作为一个单位加入/移出待编组（嵌套组 2026-11-23；
        // 不带 Shift 的既有行为——直属站加入/移出待编组——不变；画布现有修饰键无冲突）
        if (g && e.shiftKey) { togglePendingGroup(g.id); return; }
        if (g) {
          const allIn = g.stops.every((sid) => S.pending.includes(sid));
          S.pending = allIn ? S.pending.filter((sid) => !g.stops.includes(sid))
            : [...new Set([...S.pending, ...g.stops])];
          renderAll();
          setStatus(allIn ? `已将 ${g.id} 全员移出待编组。` : `已将 ${g.id} 全员加入待编组。`);
        }
        return;
      }
      const stopEl = hitEl.closest('.stop-c');
      if (stopEl) {
        const sid = stopEl.dataset.sid;
        if (stopKindOf(sid) === 'arrow') {   // 出省箭头不可编组（点选拒绝，同 block 混选拒绝风格）
          setStatus('出省箭头不是站点，不可编组。', true);
          return;
        }
        S.pending = S.pending.includes(sid) ? S.pending.filter((x) => x !== sid) : [...S.pending, sid];
        renderAll();
        return;
      }
    }

    // select 模式的点击
    const mgSel = hitEl.closest('.stop-merge, .grp-pill');
    if (mgSel) {
      const g = S.groups.stationGroups.find((x) => x.id === mgSel.dataset.grp);
      // 嵌套组（2026-11-23）：符号所属组若吸收了子组，一并注明（子组的站合并进了这一个符号）
      const kids = g ? (groupTree(stationGroupsOf()).childrenOf.get(g.id) || []) : [];
      if (g) setStatus(`${g.id} ${g.type === 'junction' ? '接轨站' : g.type === 'out-of-station' ? '出闸换乘' : g.type ? '同站换乘' : '类型未定'}组：${g.stops.map((sid) => stopLabel(sid)).join('；')}`
        + (kids.length ? `（含子组 ${kids.join('、')}：其站与直属站合并为这一个符号）` : ''));
      return;
    }
    const segEl = hitEl.closest('.seg-hit');
    if (segEl) {
      // 2026-11-21 撤点段循环：分段为实体（命名/切分/并段在左栏「设站」面板的分段区管理）；
      // 段命中与底 path 命中同语义＝选中该线（双击＝左栏定位线路行，保持可用）
      const lid = segEl.dataset.lid;
      S.activeLine = lid; S.selStop = null;
      renderLineList(); renderLineForm(); renderStopList(); renderWorld();
      regCanvasDbl(`line:${lid}`, () => {
        locateLineInList(lid);
        setStatus(`已在左栏定位 ${lid}。`);
      });
      return;
    }
    if (hitEl.closest('.stop-c')) return;  // 已在 pointerdown 处理
    const baseEl = hitEl.closest('path');
    if (baseEl && baseEl.dataset.lid) {
      S.activeLine = baseEl.dataset.lid; S.selStop = null;
      renderLineList(); renderLineForm(); renderStopList(); renderWorld();
      regCanvasDbl(`line:${baseEl.dataset.lid}`, () => {
        locateLineInList(baseEl.dataset.lid);
        setStatus(`已在左栏定位 ${baseEl.dataset.lid}。`);
      });
      return;
    }
    const impEl = hitEl.closest('path[data-imp-source]');
    if (impEl) {
      S.selImport = { source: impEl.dataset.impSource, sourceLayer: impEl.dataset.impLayer };
      pageImportIntoView(impEl.dataset.impSource, impEl.dataset.impLayer);   // 分页感知：选中行不在当前页先翻页
      renderImportList(); renderWorld();   // 画布同步高亮该未建线
      setStatus(`选中导入 path：${impEl.dataset.impLayer}（${impEl.dataset.impSource}）`);
      const iSrc = impEl.dataset.impSource, iLayer = impEl.dataset.impLayer;
      regCanvasDbl(`imp:${iSrc}|${iLayer}`, () => {   // 双击未建线：左栏导入源定位滚动可见
        pageImportIntoView(iSrc, iLayer);
        renderImportList();
        const r = [...$('impList').querySelectorAll('.imp-row')]
          .find((x) => x.dataset.src === iSrc && x.dataset.layer === iLayer);
        if (r) r.scrollIntoView({ block: 'nearest' });
        setStatus(`已在左栏定位导入 path：${iLayer}。`);
      });
      return;
    }
    // 空白：取消选择（并打断双击链）
    lastCanvasClick = null;
    S.selStop = null;
    renderStopList(); renderWorld();
  });

  function nearestTOnLine(lid, wx, wy) {
    const ap = arcOf(lid);
    return ap ? ap.project(wx, wy).t : 0;
  }

  /** 「编入上层组」（嵌套组 2026-11-23）：把一个**顶层**组整个作为一个单位加入/移出待编组
   *  （与待编组站并存，凑满 2 个单位后「编组」即建成它的上层组）。组列表行的「编入上层组」按钮与
   *  画布 Shift＋点换乘符号同走这里。已有上级的组拒绝（要调整先拆其上层组）。 */
  function togglePendingGroup(gid) {
    const idx = S.pendingGroups.indexOf(gid);
    if (idx >= 0) {
      S.pendingGroups.splice(idx, 1);
      renderAll();
      setStatus(`已将整组 ${gid} 移出待编组。`);
      return;
    }
    const iss = pendingGroupIssues(groupTree(stationGroupsOf()), [gid]);
    if (iss.length) {
      const o = iss[0];
      setStatus(o.reason === 'parent'
        ? `${gid} 已是 ${o.parent} 的子组（不是顶层组），不能再整组编入别的组：要调整请先拆其上层组 ${o.parent}。`
        : `${gid} 不存在，未加入待编组。`, true);
      return;
    }
    S.pendingGroups.push(gid);
    renderAll();
    setStatus(`已将整组 ${gid} 加入待编组（作为一个单位；编组后它成为新组的子组，自身不变）：再配一站或另一个顶层组，`
      + '点「编组」建成上层组；再点一次「编入上层组」（或 Shift＋点）取消。');
  }
  /** 组列表里跳到某组（子组／上级组 chip 点击）：翻到其所在页（被搜索滤掉则清空搜索，同新建组后的定位）并滚动可见 */
  function jumpToGroupRow(gid) {
    pageGroupIntoView(gid);
    renderGroupsPanel();
    const r = [...$('stationGroups').querySelectorAll('.grp-row')].find((x) => x.dataset.gid === gid);
    if (r) r.scrollIntoView({ block: 'nearest' });
  }

  /** 编组模式拉框收尾：框内 ≥2 站直接建组（免确认）；已在其他组的站跳过并提示 */
  function boxSelectStops(rb) {
    const x0 = Math.min(rb.x0, rb.x1), x1 = Math.max(rb.x0, rb.x1);
    const y0 = Math.min(rb.y0, rb.y1), y1 = Math.max(rb.y0, rb.y1);
    const inside = [];
    for (const [lid, line] of S.lines) {
      if (line.meta && line.meta.archived) continue;
      const ap = arcOf(lid);
      if (!ap) continue;
      for (const st of line.stops) {
        const p = ap.pointAt(st.t);
        if (p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1) inside.push(st.id);
      }
    }
    if (!inside.length) { setStatus('框内没有设站。', true); return; }
    // 一设站至多一组：已在其他组的站跳过（要改先拆组），不阻断其余建组
    const grouped = new Set();
    for (const g of (S.groups && S.groups.stationGroups) || []) {
      for (const sid of g.stops) grouped.add(sid);
    }
    const skipped = inside.filter((sid) => grouped.has(sid));
    const fresh = inside.filter((sid) => !grouped.has(sid));
    if (fresh.length < 2) {
      setStatus(`框内 ${inside.length} 站中可建组的仅 ${fresh.length} 站`
        + (skipped.length ? `（${skipped.length} 站已在其他组，先拆组再框）` : '') + '，不足 2 站，未建组。', true);
      return;
    }
    // 编组约束（planStationGroup）：出省箭头一律拒绝；线路所混选拒绝；全线路所强制 junction
    const plan = planStationGroup(fresh.map((sid) => stopKindOf(sid)));
    if (!plan.ok) {
      setStatus(plan.reason === 'arrow'
        ? `框内可建组的 ${fresh.length} 站中含出省箭头，未建组（出省箭头不是站点、不可编组）`
          + (skipped.length ? `；另有 ${skipped.length} 站已在其他组。` : '。')
        : `框内可建组的 ${fresh.length} 站中线路所与普通车站混选，未建组`
          + '（线路所只能与线路所编为接轨站组）'
          + (skipped.length ? `；另有 ${skipped.length} 站已在其他组。` : '。'), true);
      return;
    }
    if (!S.groups) S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    snapshot();
    const id = bumpCounter('nextG', 'g', 4);
    S.groups.stationGroups.push({ id, stops: fresh, type: plan.type, info: {} });
    S.pending = S.pending.filter((sid) => !fresh.includes(sid));   // 已入组的不再留在待编组
    pageGroupIntoView(id);   // 新组在末尾：翻到其所在页（被搜索滤掉则清空搜索）
    renderAll();
    setStatus(plan.allBlock
      ? `拉框已建接轨站组 ${id}（${fresh.length} 个线路所；描边取成员线角色最高优先级色）`
        + (skipped.length ? `；跳过 ${skipped.length} 站（已在其他组）。` : '。')
      : `拉框已建换乘节点组 ${id}（${fresh.length} 站，默认同站；可改出闸/接轨站/未定）`
        + (skipped.length ? `；跳过 ${skipped.length} 站（已在其他组）。` : '。'));
  }

  svg.addEventListener('pointercancel', () => {
    panning = null; rubber = null; drag = null;
    svg.classList.remove('panning');
    $('rubber').style.display = 'none';
  });

  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!S.view) return;
    const [wx, wy] = toWorld(e);
    const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
    const nw = Math.min(Math.max(S.view.w * factor, 5), 1e6);
    const k = nw / S.view.w;
    S.view.x = wx - (wx - S.view.x) * k;
    S.view.y = wy - (wy - S.view.y) * k;
    S.view.w = nw;
    // 缩放只改 viewBox；站圈等屏幕恒定尺寸由 renderWorld 原地同步——合帧（每帧至多一次），
    // 高分辨率滚轮/触控板一格内会连发多个 wheel 事件
    applyView(); scheduleBasemap(); scheduleWorld();
  }, { passive: false });

  // ---------- 侧栏事件（委托） ----------
  $('impList').addEventListener('click', (e) => {
    // 模块筛选三选（临时 UI 状态）：切筛选回第 1 页；不动数据、不进撤销/暂存
    const flt = e.target.closest('[data-impfilter]');
    if (flt) {
      const grp = e.target.closest('.imp-group');
      if (grp) {
        const ui = impUiOf(grp.dataset.igsrc);
        ui.filter = flt.dataset.impfilter;
        ui.page = 1;
        renderImportList();
      }
      return;
    }
    // 模块翻页（临时 UI 状态）：重渲染后页脚滚回可见，防多模块场景视口跳走
    const pg = e.target.closest('[data-imppg]');
    if (pg && !pg.disabled) {
      const grp = e.target.closest('.imp-group');
      if (grp) {
        const ui = impUiOf(grp.dataset.igsrc);
        ui.page += pg.dataset.imppg === 'prev' ? -1 : 1;
        renderImportList();
        const foot = $('impList').querySelector(
          `.imp-group[data-igsrc="${CSS.escape(grp.dataset.igsrc)}"] .imp-foot`);
        if (foot) foot.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    const row = e.target.closest('.imp-row');
    if (!row) return;
    S.selImport = { source: row.dataset.src, sourceLayer: row.dataset.layer };
    if (e.target.dataset.mk) { createLineFromImport(row.dataset.src, row.dataset.layer); return; }
    renderImportList(); renderLineForm(); renderWorld();   // 画布同步高亮该未建线
    setStatus(`选中导入 path：${row.dataset.layer}（${row.dataset.src}）`);
    // 双击（500ms 同条两次）→ 画布跳转放大；单击会重建列表 DOM，原生 dblclick 目标会漂移，故自判
    if (!/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) {
      const imp = S.imports.find((im) => im.source === row.dataset.src);
      const p = imp && imp.paths.find((pp) => pp.sourceLayer === row.dataset.layer);
      if (p) regCanvasDbl(`side-imp:${row.dataset.src}|${row.dataset.layer}`, () => {
        try { zoomToBox(G.pathFromD(p.path).bbox(), 400); } catch (err) { setStatus('path 解析失败，无法跳转。', true); }
      });
    }
  });

  $('lineList').addEventListener('click', (e) => {
    // 分类组翻页（临时 UI 状态，组独立翻页）：重渲染后组页脚滚回可见
    const pg = e.target.closest('[data-llpg]');
    if (pg && !pg.disabled) {
      const grp = e.target.closest('.ll-group');
      if (grp) {
        const key = grp.dataset.llkey;
        lineListUi.set(key, llPageOf(key) + (pg.dataset.llpg === 'prev' ? -1 : 1));
        renderLineList();
        const foot = $('lineList').querySelector(
          `.ll-group[data-llkey="${CSS.escape(key)}"] .ll-foot`);
        if (foot) foot.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    const row = e.target.closest('.line-row');
    if (!row) return;
    S.activeLine = row.dataset.lid; S.selStop = null;
    renderAll();
    // 双击（500ms 同线两次）→ 画布跳转放大（自判，理由同导入源）
    regCanvasDbl(`side-line:${row.dataset.lid}`, () => {
      const ap = arcOf(row.dataset.lid);
      if (ap) zoomToBox(ap.bbox(), 400);
    });
  });

  $('stopList').addEventListener('click', (e) => {
    const del = e.target.dataset.del;
    if (del) { deleteStop(S.activeLine, del); return; }
    const kindEl = e.target.closest('[data-kind]');   // 站类型循环切换（站→所→箭→站，按位置约束见 nextStopKind）
    if (kindEl) {
      const line = S.lines.get(S.activeLine);
      const st = line && line.stops.find((s) => s.id === kindEl.dataset.kind);
      if (st) {
        const i = line.stops.indexOf(st);
        const next = nextStopKind(st.kind,
          { isLoop: line.loop, isEnd: i === 0 || i === line.stops.length - 1 });
        // 双向守住组约束（先于快照：拒绝不压撤销栈）：转换后组内不得混编（全线路所⟺junction 组；
        // 普通站组不得混入线路所）；出省箭头不可编组——在组中的站一律不许切箭头
        const grp = S.groups && (S.groups.stationGroups || []).find((g) => g.stops.includes(st.id));
        if (grp) {
          const others = grp.stops.filter((sid) => sid !== st.id).map((sid) => stopKindOf(sid));
          if (next === 'arrow') {
            setStatus(`${st.id} 在组 ${grp.id} 中：出省箭头不可编组，请先拆组再切换。`, true);
            return;
          }
          if (next === 'block') {   // → 线路所：组内须已全线路所，且组为 junction
            if (others.some((k) => k !== 'block')) {
              setStatus(`${st.id} 所在组 ${grp.id} 内还有普通车站：线路所不能与之同组，请先拆组。`, true);
              return;
            }
            if (grp.type !== 'junction') {
              setStatus(`${st.id} 在 ${grp.id}（${grp.type === 'out-of-station' ? '出闸' : '同站'}换乘）组中：`
                + '线路所只能进接轨站组，请先拆组或改组类型。', true);
              return;
            }
          } else if (others.some((k) => k === 'block')) {   // → 普通车站：组内还有线路所则混编
            setStatus(`${st.id} 所在组 ${grp.id} 内还有线路所：转回普通车站会混编，请先拆组。`, true);
            return;
          }
        }
        snapshot();
        if (next === null) delete st.kind;
        else st.kind = next;
        line.meta.updated = today();
        renderAll();   // 画布同步重渲染（虚线圆/箭头三角样式切换；arrow 分支同走 renderWorld 既有路径）
        setStatus(next === 'block'
          ? `${st.id} 已转为线路所（虚线圆、可无名、仅编辑器可见）。`
          : next === 'arrow'
            ? `${st.id} 已转为出省箭头（线色箭头指向线路外侧、可无名）。`
            : `${st.id} 已转回普通车站。`);
      }
      return;
    }
    const sugEl = e.target.closest('[data-sugsid]');   // 站名建议 chip：点选采用（人工确认写入）
    if (sugEl) {
      const line = S.lines.get(S.activeLine);
      const st = line && line.stops.find((s) => s.id === sugEl.dataset.sugsid);
      if (st) {
        const sugName = sugEl.dataset.sugname;
        // 手动输入保护（2026-11-22 需求 2）：chip 只应挂在空名站上，但站名逐键写入后列表不重渲染、
        // chip 会过期残留——此时绝不让建议覆盖手输名（想采用请先清空站名）
        if (st.name && st.name.trim() && st.name !== sugName) {
          sugEl.remove();
          markPanelDirty($('stopList'));   // 直接改了 DOM：下次渲染须重写
          setStatus(`「${st.name}」为手动输入的站名，未用建议「${sugName}」覆盖——想采用建议请先清空站名。`, true);
          return;
        }
        snapshot();
        st.name = sugName;
        line.meta.updated = today();
        renderAll();
        setStatus(`已采用建议站名「${st.name}」（可继续修改）。`);
      }
      return;
    }
    const row = e.target.closest('.stop-row');
    if (!row) return;
    // 双击（500ms 同站两次）→ 仅居中该站、不放大；输入框/按钮/建议 chip 上保留原生双击
    if (!/INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName) && !e.target.closest('.namehint')) {
      regCanvasDbl(`side-stop:${row.dataset.sid}`, () => {
        const line = S.lines.get(S.activeLine);
        const st = line && line.stops.find((s) => s.id === row.dataset.sid);
        const ap = line && arcOf(line.id);
        if (st && ap) centerOn(...ap.pointAt(st.t));
      });
    }
    if (S.selStop === row.dataset.sid) return;   // 已选中：不动，避免打断输入框
    S.selStop = row.dataset.sid;
    // 只切换高亮，不重建列表（重建会销毁正在交互的输入框导致失焦）
    for (const r of $('stopList').querySelectorAll('.stop-row')) {
      r.classList.toggle('sel', r.dataset.sid === S.selStop);
    }
    markPanelDirty($('stopList'));   // 直接改了 class：下次渲染须重写，免选中态回退后旧高亮残留
    renderWorld();
  });
  // 站名输入框键盘切换（2026-11-22 需求 1）：↑/↓/Enter 跳上/下一站的名称框，光标置末尾；
  // 边界不环绕，末行 Enter 收起焦点。t 输入框不受影响（数字框方向键另有用途习惯）
  $('stopList').addEventListener('keydown', (e) => {
    if (!e.target.dataset || e.target.dataset.ren === undefined) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    const rows = [...$('stopList').querySelectorAll('.stop-row')];
    const i = rows.findIndex((r) => r.contains(e.target));
    if (i < 0) return;
    const j = e.key === 'ArrowUp' ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) { if (e.key === 'Enter') e.target.blur(); return; }
    e.preventDefault();
    const nx = rows[j].querySelector('input[data-ren]');
    if (nx) { nx.focus(); nx.setSelectionRange(nx.value.length, nx.value.length); }
  });
  $('stopList').addEventListener('input', (e) => {
    const sid = e.target.dataset.ren;
    if (!sid) return;
    const line = S.lines.get(S.activeLine);
    const st = line && line.stops.find((s) => s.id === sid);
    if (st) {
      st.name = e.target.value;
      line.meta.updated = today();
      e.target.classList.toggle('warn', !st.name && st.kind !== 'block');
      // 手动输入非空即移除该行挂着的建议/冲突 chips（2026-11-22 需求 2 前半）：
      // 站名逐键已写入数据层，但列表不重渲染、chip 会过期挂着，误点将覆盖手输名（点击处另有兜底）
      if (st.name.trim()) {
        const row = e.target.closest('.stop-row');
        if (row) for (const chip of row.querySelectorAll('.namehint')) chip.remove();
        markPanelDirty($('stopList'));   // 直接改了 DOM：下次渲染须重写
      }
      // 站名不上画布（只在 title 提示里）：逐键仅更新该站 title，不全量重绘（合并圈成员留待下次全量渲染）
      const c = world.querySelector(`.stop-c[data-sid="${CSS.escape(sid)}"]`);
      if (c) {
        const tt = c.querySelector('title');
        if (tt) tt.textContent = stopTitle(line, st, line.stops.indexOf(st),
          ((S.groups && S.groups.stationGroups) || []).find((g) => g.stops.includes(sid)));
      }
      autosave();
    }
  });

  $('stopList').addEventListener('change', (e) => {
    const sid = e.target.dataset.tedit;
    if (!sid) return;
    const line = S.lines.get(S.activeLine);
    const st = line && line.stops.find((s) => s.id === sid);
    if (!st) return;
    const v = parseFloat(e.target.value);
    if (!isFinite(v) || v < 0 || v > 1) {
      e.target.value = st.t.toFixed(6);
      e.target.classList.add('warn');
      setStatus('t 需为 [0,1] 内的数字，已还原。', true);
      return;
    }
    const nv = Math.round(v * 1e6) / 1e6;
    if (nv !== st.t) {
      snapshot();
      st.t = nv;
      line.meta.updated = today();
      renderWorld(); autosave();
    }
    // 与邻站比较给出即时告警（保存仍由 lineIssues/validate 把关）
    const i = line.stops.indexOf(st);
    const prev = i > 0 ? line.stops[i - 1].t : null;
    const next = i < line.stops.length - 1 ? line.stops[i + 1].t : null;
    const tOrderBad = (prev !== null && st.t <= prev) || (next !== null && st.t >= next);
    const arrowBad = st.kind === 'arrow' && !(i === 0 || i === line.stops.length - 1);
    e.target.classList.toggle('warn', tOrderBad || arrowBad);
    e.target.value = st.t.toFixed(6);
    if (arrowBad) setStatus('警告：出省箭头须在非环线头/尾（保存线路时会被拦截）。', true);
    else if (tOrderBad) setStatus('警告：t 未严格递增（保存线路时会被拦截）。', true);
    else setStatus(`t 已更新为 ${st.t}。`);
  });

  // 加站类型切换（车站/线路所/出省箭头）：只影响「加站」模式落站写入的 stop.kind（默认车站＝不写字段）
  function syncAddKindButtons() {
    $('akStop').classList.toggle('primary', S.addKind === null);
    $('akBlock').classList.toggle('primary', S.addKind === 'block');
    $('akArrow').classList.toggle('primary', S.addKind === 'arrow');
  }
  $('akStop').addEventListener('click', () => {
    S.addKind = null; syncAddKindButtons();
    setStatus('加站类型：车站（普通设站，需站名）。');
  });
  $('akBlock').addEventListener('click', () => {
    S.addKind = 'block'; syncAddKindButtons();
    setStatus('加站类型：线路所（中途接轨点：虚线圆、可无名、仅编辑器可见；只能与线路所编为接轨站组）。');
  });
  $('akArrow').addEventListener('click', () => {
    S.addKind = 'arrow'; syncAddKindButtons();
    setStatus('加站类型：出省箭头（非站点：线色箭头指向线路外侧、可无名、编辑器与正式网页都显示；'
      + '只能放在非环线的头/尾，中间落点拒绝；不可编组）。');
  });

  // 批量命名：先点完全线设站、再一次贴入名字（与逐站命名并存，互不破坏）
  $('btnBulkFill').addEventListener('click', () => {
    const line = S.lines.get(S.activeLine);
    if (!line) { setStatus('没有当前线路，无法批量命名。', true); return; }
    const plan = planBulkFill(line, $('bulkNames').value.split(/\r?\n/));
    if (!plan.total) { setStatus('批量命名：每行一个站名，当前没有可用的名字。', true); return; }
    if (!plan.pairs.length) {
      setStatus(`当前线没有站名为空的设站（${plan.total} 个名字未用）。`, true);
      return;
    }
    snapshot();
    for (const [st, nm] of plan.pairs) st.name = nm;
    line.meta.updated = today();
    const stillEmpty = line.stops.filter((s) => !s.name || !s.name.trim()).length;
    renderAll();
    setStatus(`已按序填入 ${plan.pairs.length} 个站名`
      + (plan.total > plan.pairs.length ? `（${plan.total - plan.pairs.length} 个多余未用）` : '')
      + (stillEmpty ? `；仍有 ${stillEmpty} 站未命名。` : '；当前线全部站已命名。'));
  });

  // ---------- 分段（铺满全线）面板交互：分段实体（fmt/line@2，2026-11-21 替区间刷状态方案） ----------
  // 分段改名逐键只写数据＋autosave（照站名输入做法，不重渲染——撤销粒度留给切分/并段/改状态）；
  // 改状态/切分/并段＝snapshot()→改→renderAll()→状态栏中文反馈；无操作的红字提示不压撤销栈。
  $('secRows').addEventListener('input', (e) => {
    const k = e.target.dataset.secname;
    if (k === undefined) return;
    const line = S.lines.get(S.activeLine);
    const sec = line && line.sections && line.sections[+k];
    if (!sec) return;
    sec.name = e.target.value;   // 可空，绝不自动生成
    line.meta.updated = today();
    autosave();
  });
  $('secRows').addEventListener('change', (e) => {
    const k = e.target.dataset.secstatus;
    if (k === undefined || !SEG_ORDER.includes(e.target.value)) return;
    const line = S.lines.get(S.activeLine);
    const sec = line && line.sections && line.sections[+k];
    if (!sec) return;
    snapshot();
    sec.status = e.target.value;
    line.meta.updated = today();
    renderAll();
    const span = sectionSpanOf(line, +k);
    setStatus(`${line.id} 分段 ${+k + 1}${span ? `（站 ${span[0]}–${span[1]}）` : ''} → ${SEG_LABEL[sec.status]}（状态挂整段）。`);
  });
  $('secRows').addEventListener('click', (e) => {
    const k = e.target.dataset.secmerge;
    if (k === undefined) return;
    const line = S.lines.get(S.activeLine);
    if (!line) return;
    const kk = +k, secs = line.sections || [];
    // 先验后快照：无下一段可并不压撤销栈
    if (secs.length < 2 || (!line.loop && kk === secs.length - 1)) {
      setStatus(!line.loop && kk === secs.length - 1
        ? '非环线末段没有下一段，无法并段。' : '当前没有可并的相邻分段。', true);
      return;
    }
    const target = line.loop && kk === secs.length - 1 ? kk - 1 : kk;   // 环线末段并首段后落到 kk-1
    snapshot();
    if (!applySectionMerge(line, kk)) { setStatus('并段失败（数据异常，未改动）。', true); return; }
    line.meta.updated = today();
    renderAll();
    const span = sectionSpanOf(line, target);
    setStatus(`${line.id} 已并段：分段 ${target + 1}${span ? `（站 ${span[0]}–${span[1]}）` : ''}`
      + '吸收其下一段（名称与状态取本段，下一段名字弃用）。');
  });
  $('btnSecSplit').addEventListener('click', () => {
    const line = S.lines.get(S.activeLine);
    if (!line) { setStatus('没有当前线路，无法切分分段。', true); return; }
    const k = parseInt($('secSplitAt').value, 10);
    const n = line.stops.length;
    const segs = line.segments || [];
    // 先验后快照：站序无效或两侧已不同段（无操作）不压撤销栈；planSectionSplit 内部再验一遍兜底
    const bad = n < 2 || !Number.isInteger(k)
      || (line.loop ? (k < 1 || k > n) : (k < 2 || k > n - 1))
      || segs.length !== (line.loop ? n : n - 1)
      || !(line.sections || []).length
      || segs[(k - 2 + n) % n] !== segs[(k - 1) % n];
    if (bad) {
      setStatus('该站两侧已在不同分段（或站序无效），无需切分。', true);
      return;
    }
    const newK = segs[(k - 1) % n] + 1;   // 新分段插在原分段之后（段序＝线路序）
    snapshot();
    if (!planSectionSplit(line, k)) { setStatus('切分失败（数据异常，未改动）。', true); return; }
    line.meta.updated = today();
    renderAll();
    const span = sectionSpanOf(line, newK);
    setStatus(`${line.id} 已在站 ${k} 设分段边界：新分段 ${newK + 1}`
      + `${span ? `（站 ${span[0]}–${span[1]}${line.loop && span[1] <= span[0] ? '，经环绕段' : ''}）` : ''}`
      + '（名空、状态继承原段）。');
  });

  // 属性面板逐键渲染合帧（每帧至多一次；名称等不影响画布的字段跳过 renderWorld）——满规模防逐键全量重绘卡顿
  let formRaf = 0, formNeedsWorld = false;
  const connColorMemo = new WeakMap();   // 线对象 → 改成联络线前的原色（联络线不带 color；改回时还回，见 lfRole）
  function scheduleFormRender(needsWorld) {
    if (needsWorld) formNeedsWorld = true;
    if (formRaf) return;
    formRaf = requestAnimationFrame(() => {
      formRaf = 0;
      const w = formNeedsWorld; formNeedsWorld = false;
      renderLineList(); renderGroupsPanel();
      if (w) renderWorld();
    });
  }

  $('lineform').addEventListener('input', (e) => {
    const l = S.lines.get(S.activeLine);
    if (!l) return;
    let touched = true;
    switch (e.target.id) {
      case 'lfName': l.name = e.target.value; break;
      case 'lfColor': l.color = e.target.value.toUpperCase(); break;
      case 'lfLoop': {
        // 出省箭头守卫：环线无出省端点，线上已有箭头则拒绝切环线（先删箭头）
        if (e.target.checked && l.stops.some((st) => st.kind === 'arrow')) {
          e.target.checked = false;
          setStatus(`${l.id} 上有出省箭头：环线没有出省端点，先删除箭头再切环线。`, true);
          return;
        }
        snapshot();
        toggleLoop(l, e.target.checked);
        break;
      }
      case 'lfRole': {
        snapshot();
        const prevRole = l.role;
        l.role = e.target.value;
        if (l.role !== 'connector') l.connects = [];
        // 联络线取消颜色属性（2026-11-22 用户裁定；validate 既有规则：connector 不得带 color）：改成联络线的
        // 那一刻即清掉已有的 color——原先只藏颜色栏，文件里仍带着 color，validate 报错而界面又改不了。
        // 快照在上，Ctrl+Z 可退回。原色暂存会话内存（WeakMap 按线对象，不落盘、随对象更换自然失效）：
        // 改回非联络线时原样还回；无从还回（如载入的本来就是联络线）则取颜色栏当前显示的缺省值——
        // 非联络线的 color 仍是必填（validate 既有规则），且与颜色栏所见一致
        if (l.role === 'connector') {
          if (l.color !== undefined) connColorMemo.set(l, l.color);
          stripConnectorColor(l);
        } else if (prevRole === 'connector' && l.color === undefined) {
          l.color = connColorMemo.get(l) || ($('lfColor') ? $('lfColor').value.toUpperCase() : '#888888');
          if ($('lfColor')) $('lfColor').value = l.color;   // 属性面板不重渲染（保焦点）：颜色栏同步成还回的原色
        }
        if ((l.role === 'main' || l.role === 'branch') && !l.groupId) {
          // 留待用户在下方线组下拉中选择
        }
        $('lfGroupRow').style.display = (l.role === 'main' || l.role === 'branch') ? 'flex' : 'none';
        $('lfConnRow').style.display = l.role === 'connector' ? 'flex' : 'none';
        $('lfColorRow').style.display = l.role === 'connector' ? 'none' : 'flex';
        break;
      }
      case 'lfGroup':
        if (e.target.value === '__new__') { newLineGroupFor(l); return; }
        l.groupId = e.target.value || null;
        break;
      case 'lfConnects':
        l.connects = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'lfLayer': {
        // 分类改动即生效（同 lfName 模式）；选「（未分类）」即删除字段，不留空串
        const v = e.target.value;
        if (v) { l.meta = l.meta || {}; l.meta.layer = v; }
        else if (l.meta) delete l.meta.layer;
        break;
      }
      default: touched = false;
    }
    if (touched) {
      l.meta.updated = today(); autosave();
      const fld = e.target.id;
      // 影响画布的字段：颜色/环线/角色/联络目标/分类——分类须重绘：预控通道线「站数<2 整线显示」
      // 取决于它，改了类别画布要立刻跟着变
      scheduleFormRender(fld === 'lfColor' || fld === 'lfLoop' || fld === 'lfRole' || fld === 'lfConnects' || fld === 'lfLayer');
    }
  });
  $('lineform').addEventListener('click', (e) => {
    if (e.target.id === 'lfUpdatePath') updatePathFromImport();
    if (e.target.id === 'lfImportStops') importStopsFromPreset();
    if (e.target.id === 'lfAdoptNames') adoptSuggestedNames();
    if (e.target.id === 'lfArchive') {
      const l = S.lines.get(S.activeLine);
      if (!l) return;
      snapshot();
      l.meta.archived = !l.meta.archived;
      l.meta.updated = today();
      renderAll();
      setStatus(l.meta.archived ? `${l.id} 已标记归档（保存后保留在文件中，发布时剔除）。`
        : `${l.id} 已取消归档。`);
    }
  });

  function toggleLoop(l, loop) {
    const n = l.stops.length;
    l.loop = loop;
    const want = loop ? n : Math.max(n - 1, 0);
    while (l.segments.length > want) l.segments.pop();
    // 新增环绕段继承相邻（末）段——铺满模型下端部必须归段；空表兜底 0
    while (l.segments.length < want) l.segments.push(l.segments.length ? l.segments[l.segments.length - 1] : 0);
    pruneSections(l);        // 去环可能使原环绕段独占的分段失去全部引用
    fixStatusField(l);       // 站数<2 时归空（分段/线路级 status 接管）
  }

  function newLineGroupFor(line) {
    const name = prompt('新线组名称（如：1号线）', line.name);
    if (!name) { renderLineForm(); return; }
    snapshot();
    const id = bumpCounter('nextLG', 'lg', 2);
    S.groups.lineGroups.push({ id, name, color: line.color,
      members: [], note: '' });
    line.groupId = id;
    if (line.role === 'standalone') line.role = 'main';
    renderAll();
    setStatus(`已建线组 ${id} 并将 ${line.id} 设为成员。`);
  }

  $('btnNewLineGroup').addEventListener('click', () => {
    const name = prompt('新线组名称');
    if (!name) return;
    snapshot();
    const id = bumpCounter('nextLG', 'lg', 2);
    S.groups.lineGroups.push({ id, name, color: '#888888', members: [], note: '' });
    renderAll();
  });

  $('lineGroups').addEventListener('click', (e) => {
    const gid = e.target.dataset.lgdel;
    if (!gid) return;
    S.groups.lineGroups = S.groups.lineGroups.filter((g) => g.id !== gid);
    for (const l of S.lines.values()) if (l.groupId === gid) l.groupId = null;
    renderAll();
  });

  $('stationGroups').addEventListener('click', (e) => {
    // 列表翻页（临时 UI 状态）：重渲染后页脚滚回可见（同线路列表/导入源）
    const pg = e.target.closest('[data-sgpg]');
    if (pg && !pg.disabled) {
      sgUi.page += pg.dataset.sgpg === 'prev' ? -1 : 1;
      renderGroupsPanel();
      const foot = $('stationGroups').querySelector('.sg-foot');
      if (foot) foot.scrollIntoView({ block: 'nearest' });
      return;
    }
    // 嵌套组（2026-11-23）：子组／上级组 chip 点击＝跳到该组行；「编入上层组」＝整组加入/移出待编组
    const jump = e.target.closest('[data-gjump]');
    if (jump) { jumpToGroupRow(jump.dataset.gjump); return; }
    const nest = e.target.dataset.gnest;
    if (nest) { togglePendingGroup(nest); return; }
    const gid = e.target.dataset.gdel;
    if (!gid) return;
    snapshot();
    // 拆组（简单组与原先一致＝删组、直属站恢复未编组、无提示）。嵌套组 2026-11-23 语义，两种情形可并存：
    // 拆的是有上级的组 → 上级从 groups 摘除它（摘空即删字段），上级因此成员单位不足 2 的一并拆除并向上级联；
    // 拆的是含子组的组 → 子组升为顶层组（删掉本组即自然达成）
    const list = S.groups.stationGroups;
    const g0 = list.find((x) => x.id === gid);
    const parent0 = g0 ? list.find((x) => x !== g0 && Array.isArray(x.groups) && x.groups.includes(gid)) : null;
    const kids0 = g0 && Array.isArray(g0.groups) ? g0.groups.slice() : [];
    S.groups.stationGroups = list.filter((x) => x.id !== gid);
    const casc = cascadeStationGroups(S.groups.stationGroups, [gid]);
    renderAll();
    if (parent0 || kids0.length || casc.length) {
      setStatus(`已拆组 ${gid}（直属站恢复未编组）`
        + (parent0 ? `；已从上级组 ${parent0.id} 摘除` : '')
        + (kids0.length ? `；子组 ${kids0.join('、')} 升为顶层组` : '')
        + (casc.length ? `；${casc.join('、')} 因成员不足 2 已一并拆组` : '') + '。');
    }
  });
  $('stationGroups').addEventListener('change', (e) => {
    // 画法强制（2026-11-23 shape:"pill"，仅 same-station 组渲染此下拉）：可撤销（同组类型切换）
    const shp = e.target.dataset.gshape;
    if (shp) {
      const g = S.groups.stationGroups.find((x) => x.id === shp);
      if (!g) return;
      snapshot();
      if (e.target.value === 'pill') g.shape = 'pill'; else delete g.shape;
      renderWorld(); autosave();
      // 同 gtype：有搜索词/筛选时重渲染保持列表如实；无则保住下拉焦点
      if (searchTermsOf(sgUi.q).length || sgUi.filter) renderGroupsPanel();
      return;
    }
    const gid = e.target.dataset.gtype;
    if (!gid) return;
    const g = S.groups.stationGroups.find((x) => x.id === gid);
    if (!g) return;
    // 防御：含线路所的组不得改为 junction 之外的类型（下拉已 disabled，此处兜底还原）
    if (e.target.value !== 'junction' && g.stops.some((sid) => stopKindOf(sid) === 'block')) {
      setStatus(`${gid} 组内含线路所：只能为接轨站（junction），已还原。`, true);
      renderGroupsPanel();
      return;
    }
    snapshot();   // 组类型切换可撤销（与建组/拆组一致）
    g.type = e.target.value || null;
    if (g.type !== 'same-station') delete g.shape;   // shape 仅同站合法（validate 门禁），换类型时摘除
    renderWorld(); autosave();
    // 有搜索词/筛选时重渲染保持列表如实（类型是检索字段之一，改后该行可能不再命中）；
    // 无则不重渲染：保住下拉焦点，便于连续改多行
    if (searchTermsOf(sgUi.q).length || sgUi.filter) renderGroupsPanel();
  });
  // 组列表筛选下拉（静态元素，见 editor.html）：切换即回第 1 页（临时 UI 状态，同 sgUi.q）
  $('sgFilter').addEventListener('change', (e) => {
    sgUi.filter = e.target.value; sgUi.page = 1;
    renderGroupsPanel();
  });
  // 换乘节点组搜索框（静态元素，见 editor.html）：逐键过滤（含中文输入法组词中的 input）、回第 1 页
  $('sgSearch').addEventListener('input', (e) => {
    sgUi.q = e.target.value; sgUi.page = 1;
    renderGroupsPanel();
  });
  // 搜索框内 Esc＝清空搜索；不冒泡到全局 Esc（取消选择），免得连待编组一起清掉。
  // 输入法组词中的 Esc 交给输入法自己（取消组词），不拦不改输入框
  $('sgSearch').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.isComposing && e.target.value) {
      e.preventDefault(); e.stopPropagation();
      e.target.value = ''; sgUi.q = ''; sgUi.page = 1;
      renderGroupsPanel();
    }
  });

  $('pendingBox').addEventListener('click', (e) => {
    if (e.target.id === 'btnClearPend') { S.pending = []; S.pendingGroups = []; renderAll(); return; }
    if (e.target.id === 'btnMkGroup') {
      // 待编组单位（站＋整组，嵌套组 2026-11-23）总数 ≥2 才可建
      if (S.pending.length + S.pendingGroups.length < 2) return;
      // 一设站至多一组：冲突即拒绝（人工先拆组）
      const conflict = [];
      for (const g of S.groups.stationGroups) {
        for (const sid of S.pending) if (g.stops.includes(sid)) conflict.push(`${sid} 已在 ${g.id}`);
      }
      if (conflict.length) {
        setStatus('冲突：' + conflict.join('；') + '。请先拆组。', true);
        return;
      }
      // 待编入上层的组必须是顶层组（已有上级的先拆其上层组）
      const nestIss = pendingGroupIssues(groupTree(S.groups.stationGroups), S.pendingGroups);
      if (nestIss.length) {
        setStatus('冲突：' + nestIss.map((o) => (o.reason === 'parent'
          ? `${o.id} 已是 ${o.parent} 的子组` : `${o.id} 不存在`)).join('；') + '。请先拆其上层组。', true);
        return;
      }
      // 编组约束（planStationGroup）：出省箭头一律拒绝；线路所混选拒绝；全线路所强制 junction——
      // 只看待编组的直属站；整组不参与类型判定，仅计入成员单位总数
      const plan = planStationGroup(S.pending.map((sid) => stopKindOf(sid)), S.pendingGroups.length);
      if (!plan.ok) {
        setStatus(plan.reason === 'arrow'
          ? '编组拒绝：待编组里含出省箭头（出省箭头不是站点、不可编组）。'
          : plan.reason === 'mixed'
            ? '编组拒绝：待编组里线路所与普通车站混选（线路所只能与线路所编为接轨站组）。'
            : '编组拒绝：成员单位（站＋整组）不足 2 个。', true);
        return;
      }
      snapshot();
      const id = bumpCounter('nextG', 'g', 4);
      const gNew = { id, stops: [...S.pending] };
      if (S.pendingGroups.length) gNew.groups = [...S.pendingGroups];   // 子组列表：为空不写该字段
      gNew.type = plan.type;
      gNew.info = {};
      S.groups.stationGroups.push(gNew);
      S.pending = []; S.pendingGroups = [];
      pageGroupIntoView(id);   // 新组在末尾：翻到其所在页（被搜索滤掉则清空搜索）
      renderAll();
      // 状态栏反馈：嵌套组另说明子组去向；简单组文案与原先逐字相同
      const kidNote = gNew.groups ? `含子组 ${gNew.groups.join('、')}，` : '';
      setStatus(plan.allBlock
        ? (gNew.groups
          ? `已建接轨站组 ${id}（${kidNote}直属站全线路所）：全部叶站合并为一个普通尺寸圈，描边取成员线角色最高优先级色。`
          : `已建接轨站组 ${id}（全线路所：合并为普通尺寸虚线圈，描边取成员线角色最高优先级色）。`)
        : `已建换乘节点组 ${id}（${kidNote}默认同站${gNew.groups
          ? '：全部叶站合并为一个符号——逻辑线数 ≥3 出药丸，否则黑边大圈；可在列表改出闸（子组各按自身类型画）/接轨站/未定。'
          : '：合并为一个黑边大圈；可在列表改出闸/接轨站/未定。'}`);
    }
  });

  // 折叠面板
  for (const h of document.querySelectorAll('section > h3')) {
    h.addEventListener('click', () => h.parentElement.classList.toggle('collapsed'));
  }

  // ---------- 模式与撤销 ----------
  // 底图三态偏好：'osm'｜'amap'｜'off'（旧布尔键 '1' 视作 osm、'0'/缺失视作 off）
  S.basemap = (() => {
    const v = localStorage.getItem('shrail.basemap');
    if (v === 'osm' || v === 'amap') return v;
    return v === '1' ? 'osm' : 'off';
  })();
  /** 底图按钮文案/高亮随三态同步（关→OSM→高德→关循环切换） */
  function syncBasemapButton() {
    const b = $('btnBasemap');
    b.textContent = S.basemap === 'amap' ? '底图：高德' : S.basemap === 'osm' ? '底图：OSM' : '底图：关';
    b.classList.toggle('primary', S.basemap !== 'off');
  }
  $('btnBasemap').addEventListener('click', () => {
    const next = S.basemap === 'off' ? 'osm' : (S.basemap === 'osm' ? 'amap' : 'off');
    if (next !== 'off' && !S.calib) {
      setStatus('无标定参数：先运行 python -X utf8 tools/calib_manual_fit.py（手动标定）或 python tools/georef.py <svg> <kml> --emit'
        + ' 生成 data/calibration.json（或用「数据文件」按钮载入），再开底图。', true);
      return;
    }
    S.basemap = next;
    localStorage.setItem('shrail.basemap', next);
    syncBasemapButton();
    clearBasemapTiles();   // 源切换：瓦片 URL 与放置偏移不同，旧片不可复用
    renderWorld();
    setStatus(next === 'osm'
      ? '底图已开启（OSM）：© OpenStreetMap contributors（手动标定 TPS v2；对位精度≈标定残差：38 控点，LOO 全图 108 m）。'
      : next === 'amap'
        ? '底图已开启（高德）：© 高德地图（GCJ02 逐瓦片常量偏移对齐，单瓦片内误差米级；仅本地对位参考）。'
        : '底图已关闭。');
  });

  const MODE_HINT = {
    select: '选择：点击设站选中（左侧改名）、点击线路选中；分段在左侧「设站」面板管理（命名/切分/并段，状态挂整段、铺满全线）；左键拖动平移、滚轮缩放；拖动改站位置请切加站模式。',
    add: '加站：点击线路附近即可加站（吸附半径 40px，自动记弧长 t）；按住已有站圈可直接拖动改位置（没按到则照常拖画布）。加站类型（车站/线路所/出省箭头）用左侧设站面板顶部按钮切换——出省箭头只能落在非环线的头/尾；可以先一路点完，再展开「批量命名」一次贴入站名（线路所/出省箭头跳过）。',
    group: '编组：任意处拉框直接建组（框内 ≥2 站即建，已在其他组的跳过）；也可点选站圈攒待编组后点「编组」；中键拖动平移。'
      + '嵌套（把一个既有组整个编进新组）：点换乘符号＝加它的直属站；Shift＋点换乘符号＝把该组整个当一个单位加入待编组'
      + '（组列表顶层组的「编入上层组」同效，再点取消），配一站或另一组后点「编组」。',
  };
  for (const btn of document.querySelectorAll('#toolbar [data-mode]')) {
    btn.addEventListener('click', () => {
      S.mode = btn.dataset.mode;
      for (const b of document.querySelectorAll('#toolbar [data-mode]')) {
        b.classList.toggle('primary', b === btn);
      }
      setStatus(MODE_HINT[S.mode]);
      $('canvasHint').textContent = MODE_HINT[S.mode];
      S.pending = []; S.pendingGroups = [];
      renderAll();
    });
  }
  $('btnUndo').addEventListener('click', undo);
  // 关页拦截：仅当暂存通道已坏（lsFailed）时才拦——正常情况有恢复横幅兜底，不打扰关页
  window.addEventListener('beforeunload', (e) => {
    if (lsFailed) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z'
        && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault(); undo();
    }
    if (e.key === 'Delete' && S.selStop && S.activeLine
        && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
      deleteStop(S.activeLine, S.selStop);
    }
    if (e.key === 'Escape') { S.selStop = null; S.pending = []; S.pendingGroups = []; renderAll(); }
  });

  // ---------- 线路显示顺序面板（查看器左栏序；2026-11-22 需求 5） ----------
  // 顶栏「排序」打开对话框：平铺全部线路（类别＋线名，排列＝当前自定义顺序），
  // 每行置顶/上移/下移/置底；「确定」一次快照写入 S.lineOrder（可撤销），
  // 随「保存工作区」进 manifest.lineOrder → flatten 产出 net/index.json 供查看器消费。
  // 编辑器左栏主列表保持现状（分类分组）不动。
  const orderMenu = $('orderMenu');
  let orderDraft = [];   // 面板工作副本（确定才写回）
  /** 当前生效的线路顺序：S.lineOrder 原始值经 normalize 现算（清失效 id、补缺线到末尾） */
  function effectiveLineOrder() {
    return normalizeLineOrder(S.lineOrder, [...S.lines.keys()]);
  }
  $('btnOrder').addEventListener('click', () => {
    if (!S.lines.size) { setStatus('暂无线路，无显示顺序可调。', true); return; }
    orderDraft = effectiveLineOrder();
    renderOrderPanel();
    orderMenu.showModal();
  });
  $('orderCancel').onclick = () => orderMenu.close();
  $('orderOk').onclick = () => {
    orderMenu.close();
    if (JSON.stringify(orderDraft) === JSON.stringify(effectiveLineOrder())) {
      setStatus('线路显示顺序未变化。');
      return;
    }
    snapshot();   // 排序可撤销（一次回退整批）
    S.lineOrder = orderDraft.slice();   // draft 由 normalize 而来，恒为全量显式顺序
    renderAll();
    setStatus('已更新线路显示顺序（「保存工作区」时随 manifest 的 lineOrder 写出，'
      + '经 flatten 产出 net/index.json 供查看器左栏排序）。');
  };
  function renderOrderPanel() {
    const box = $('orderList');
    const n = orderDraft.length;
    box.innerHTML = orderDraft.map((lid, i) => {
      const l = S.lines.get(lid);
      if (!l) return '';
      const layer = (l.meta && typeof l.meta.layer === 'string' && l.meta.layer) || '未分类';
      return `
      <div class="ord-row" data-i="${i}">
        <span class="idx">${i + 1}</span>
        <span class="chip" style="background:${esc(l.color)}"></span>
        <span class="nm" title="${esc(l.id)} ${esc(l.name)}">${esc(l.name || '（未命名）')}</span>
        <span class="lyr">${esc(layer)}</span>
        <span class="lyr">${l.id} · ${l.stops.length}站${l.meta && l.meta.archived ? ' · 归档' : ''}</span>
        <button class="mini" data-ordop="top" ${i === 0 ? 'disabled' : ''} title="移到最前">置顶</button>
        <button class="mini" data-ordop="up" ${i === 0 ? 'disabled' : ''} title="上移一格">↑</button>
        <button class="mini" data-ordop="down" ${i === n - 1 ? 'disabled' : ''} title="下移一格">↓</button>
        <button class="mini" data-ordop="bottom" ${i === n - 1 ? 'disabled' : ''} title="移到最后">置底</button>
      </div>`;
    }).join('');
  }
  $('orderList').addEventListener('click', (e) => {
    const op = e.target.dataset.ordop;
    if (!op) return;
    const row = e.target.closest('.ord-row');
    if (!row) return;
    const i = +row.dataset.i;
    const j = op === 'top' ? 0 : op === 'up' ? i - 1 : op === 'down' ? i + 1 : orderDraft.length - 1;
    if (i < 0 || i >= orderDraft.length || j < 0 || j >= orderDraft.length) return;
    const [id] = orderDraft.splice(i, 1);
    orderDraft.splice(j, 0, id);
    renderOrderPanel();   // 只重排面板行，不动主界面
  });

  // ---------- 工作区（载入/新建/保存） ----------
  // 工作区文件夹与 data/ 同构：lines/*.json＋groups.json＋manifest.json，复制进 data/ 即为提交。
  // 打开走 File System Access（Chrome/Edge，可直写；可直接打开 data/ 本体，保存即落盘）；
  // 不支持该 API 的浏览器降级：载入走 webkitdirectory 目录读（只读），保存走多文件下载。
  let wsHandle = null;   // 当前工作区目录句柄（null＝未打开/降级模式）

  const wsMenu = $('wsMenu');
  $('btnWorkspace').onclick = () => wsMenu.showModal();
  $('wsCancel').onclick = () => wsMenu.close();
  $('wsOpen').onclick = async () => { wsMenu.close(); await openWorkspace(); };
  $('wsNew').onclick = () => { wsMenu.close(); resetAll(); };

  /** 应用一份工作区数据集（整体替换语义；一次快照，撤销一次回退整批）。
   *  lineinfoText＝工作区 lineinfo.md 原文（字符串）或 null（工作区无此文件——整体替换语义
   *  连介绍文本一并清零，不沿用上一个工作区的）。lineinfo 不参与撤销（撤销只回退线路/编组）。 */
  function applyWorkspace(lineFiles, groups, manifest, calib, label, writable, lineinfoText) {
    if (!lineFiles.size && !groups && !manifest) {
      setStatus(`${label}：未发现工作区文件（lines/*.json、groups.json、manifest.json 均无）。若要清空请用「新建空工作区」。`, true);
      return;
    }
    const cur = S.lines.size;
    if (!confirm(`载入工作区：将以 ${lineFiles.size} 条线路替换当前 ${cur} 条（编组一并替换，Ctrl+Z 可撤销）。继续？`)) return;
    snapshot();
    // @1 → @2 分段实体迁移（工作区里可能有升级前保存的旧文件；保存后生效）
    const migNotes = [];
    for (const l of lineFiles.values()) {
      const note = migrateLineNote(l);
      if (note) migNotes.push(note);
    }
    S.lines = new Map(lineFiles);
    // 整体替换语义要彻底：工作区缺 groups.json/manifest.json 时清空而非沿用当前值，
    // 否则旧组的 stationGroups 会悬挂引用新工作区不存在的线路/站 id
    S.groups = takeGroups(groups) || { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    S.manifest = manifest || null;
    // 工作区整体替换：显示顺序随 manifest.lineOrder（缺失＝null 回退 id 升序）
    S.lineOrder = (manifest && Array.isArray(manifest.lineOrder)) ? manifest.lineOrder : null;
    // 线路介绍整体替换：工作区有 lineinfo.md 用其原文（落盘基线同步＝无未保存改动），无则清零
    S.lineinfoMd = S.lineinfoSavedMd = (typeof lineinfoText === 'string') ? lineinfoText : null;
    if (calib) takeCalibration(calib);
    S.arcs = reuseArcs(S.arcs, S.lines);   // path 没变的线沿用旧弧；变了的丢掉重建
    if (!S.lines.has(S.activeLine)) S.activeLine = lineFiles.size ? [...lineFiles.keys()][0] : null;
    S.selStop = null; S.pending = []; S.pendingGroups = [];
    syncCountersWithLoaded();
    renderAll();
    backfillTransfersOnLoad();   // 数据就绪：自动回填（工作区线路名 → 预置空缺建议）
    syncBasemapButton();
    $('btnBasemap').classList.toggle('primary', S.basemap !== 'off' && !!S.calib);
    setStatus(`已载入工作区（${label}）：线路 ${lineFiles.size} 条`
      + (groups ? '＋groups' : '') + (manifest ? '＋manifest' : '') + (calib ? '＋标定' : '')
      + (writable ? '。保存工作区将直写该文件夹。' : '。本浏览器不支持目录直写——保存工作区将走多文件下载。')
      + (migNotes.length ? ' ' + migNotes.join('；') + '。' : ''));
  }

  async function readHandleJson(fh) {
    const f = await fh.getFile();
    return JSON.parse(await f.text());
  }

  async function openWorkspace() {
    if (!window.showDirectoryPicker) { $('fileWsDir').click(); return; }   // 降级：目录读
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); }
    catch (e) { return; }   // 用户取消
    const lineFiles = new Map(); let groups = null, manifest = null, calib = null, lineinfoText = null;
    try {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          if (name === 'lines') {
            for await (const [ln, lfh] of handle.entries()) {
              if (lfh.kind !== 'file' || !/^l\d{4}\.json$/.test(ln)) continue;
              try {
                const obj = await readHandleJson(lfh);
                if (isLineObj(obj)) lineFiles.set(obj.id, obj);
              } catch (e) { setStatus(`工作区 lines/${ln} 解析失败，已跳过：${e.message}`, true); }
            }
          }
          continue;
        }
        try {
          if (name === 'manifest.json') { const o = await readHandleJson(handle); if (o.schema === 'fmt/manifest@1') manifest = o; }
          else if (name === 'groups.json') { const o = await readHandleJson(handle); if (o.schema === 'fmt/groups@1') groups = o; }
          else if (name === 'calibration.json') { const o = await readHandleJson(handle); if (o.schema === 'fmt/calibration@2') calib = o; }
          else if (name === 'lineinfo.md') { lineinfoText = await (await handle.getFile()).text(); }   // 手填 markdown 原样读入
        } catch (e) { setStatus(`工作区 ${name} 解析失败，已跳过：${e.message}`, true); }
      }
    } catch (e) { setStatus(`读取工作区失败：${e.message}`, true); return; }
    if (lineFiles.size || groups || manifest) wsHandle = dir;
    applyWorkspace(lineFiles, groups, manifest, calib, dir.name, true, lineinfoText);
  }

  // 降级：webkitdirectory 整目录读（只读——保存走下载）。按文件名归槽，非工作区文件一概忽略
  $('fileWsDir').addEventListener('change', async (e) => {
    const lineFiles = new Map(); let groups = null, manifest = null, calib = null, lineinfoText = null;
    for (const f of [...e.target.files]) {
      const base = (f.webkitRelativePath || f.name).replace(/\\/g, '/').split('/').pop();
      try {
        if (/^l\d{4}\.json$/.test(base)) {
          const obj = JSON.parse(await f.text());
          if (isLineObj(obj)) lineFiles.set(obj.id, obj);
        } else if (base === 'manifest.json') { const o = JSON.parse(await f.text()); if (o.schema === 'fmt/manifest@1') manifest = o; }
        else if (base === 'groups.json') { const o = JSON.parse(await f.text()); if (o.schema === 'fmt/groups@1') groups = o; }
        else if (base === 'calibration.json') { const o = JSON.parse(await f.text()); if (o.schema === 'fmt/calibration@2') calib = o; }
        else if (base === 'lineinfo.md') { lineinfoText = await f.text(); }   // 手填 markdown 原样读入
      } catch (err) { /* 非 JSON/坏文件跳过 */ }
    }
    e.target.value = '';
    applyWorkspace(lineFiles, groups, manifest, calib, '目录读入', false, lineinfoText);
  });

  /** 新建空工作区＝清空暂存与编号水位后刷新（原「重置」） */
  function resetAll() {
    if (!confirm('新建空工作区：将清空本地暂存（线路/组/导入记录）与线/组编号水位，测试数据不保留，页面随即刷新。\n确定继续？')) return;
    clearTimeout(lsTimer);                    // 防清空后 400ms 防抖又把暂存写回
    localStorage.removeItem(LS_KEY);           // 主暂存 shrail.editor.v1
    localStorage.removeItem(LS_IMPS_KEY);      // 导入记录暂存（拆键后单独清理）
    localStorage.removeItem('shrail.counters'); // 线/组编号水位
    localStorage.removeItem('shrail.calib');   // 旧标定偏好键（切换功能已移除，兼容清理无害）
    location.reload();
  }

  // ---------- 导入线路（.ai/.json/.svg 三合一） ----------
  $('btnImportLines').onclick = () => $('fileImport').click();

  /** .ai 经本地 serve.py 解析为 fmt/import@1（file:// 或旧 http.server 无此 API 时给出话术） */
  async function importAiFile(f) {
    const mb = f.size && f.size > 1024 * 1024 ? `（约 ${(f.size / 1024 ** 3).toFixed(1)} GB，本机上传 1~2 分钟＋解析，请勿关闭页面）` : '';
    setStatus(`正在上传并解析 ${f.name}${mb}…`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10 * 60 * 1000);
    try {
      // body 直接给 File：浏览器流式上传（真图 1.86 GB，arrayBuffer() 整包进内存不可取），
      // Blob 长度已知故自动带 Content-Length（serve.py 依赖它，不支持 chunked）
      const res = await fetch('/api/ai-parse', {
        method: 'POST',
        headers: { 'X-Filename': encodeURIComponent(f.name) },
        body: f,
        signal: ctrl.signal,
      });
      const obj = await res.json().catch(() => null);
      if (!res.ok) throw new Error((obj && obj.error) || `服务返回 ${res.status}`);
      if (!obj || obj.schema !== 'fmt/import@1') throw new Error('服务返回的不是 fmt/import@1');
      addImportRecord(obj);
      setStatus(`已从 ${f.name} 导入 ${obj.paths.length} 条 path（导入源已更新，同源旧记录被替换）。`);
    } catch (err) {
      throw new Error((ctrl.signal.aborted ? '解析超时（10 分钟）' : err.message)
        + '。.ai 解析需本地服务：请用 python tools/serve.py 起服务，经 http://localhost:8000/editor.html 使用'
        + '（file:// 打开或 python -m http.server 均无此 API）。');
    } finally { clearTimeout(timer); }
  }

  $('fileImport').addEventListener('change', async (e) => {
    for (const f of e.target.files) {
      try {
        if (/\.ai$/i.test(f.name)) await importAiFile(f);
        else if (/\.svg$/i.test(f.name)) addImportRecord(parseSvgText(await f.text(), f.name));
        else if (/\.json$/i.test(f.name)) {
          const obj = await readJsonFile(f);
          if (obj.schema === 'fmt/import@1') addImportRecord(obj);
          else if (obj.schema === 'fmt/stations-import@2') {
            const n = addStationPreset(obj, f.name);
            setStatus(`已载入站圆预置 ${n} 条（${f.name}）。`);
          }
          else loadDataObject(obj, f.name);   // 线路/groups/manifest/标定兜底
        }
        else setStatus(`${f.name}：不支持的文件类型（支持 .ai/.json/.svg）。`, true);
      } catch (err) { setStatus(`${f.name}：${err.message}`, true); }
    }
    e.target.value = '';
    syncCountersWithLoaded();
    renderAll();
  });

  // ---------- 保存（工作区直写＋降级下载） ----------
  function saveBlob(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function download(name, obj) {
    saveBlob(name, new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' }));
  }
  /** lineinfo.md 是手填 markdown，整文件按原文落盘（不 JSON 化——保真硬要求） */
  function downloadText(name, text) {
    saveBlob(name, new Blob([String(text)], { type: 'text/markdown;charset=utf-8' }));
  }

  /** 工作区直写：线路＋groups＋manifest＋lineinfo.md（有介绍改动时）成套写入目录（多余线路文件删除并列出）。
   *  只碰 lines/ 子目录与 groups.json/manifest.json/lineinfo.md 自家产物——calibration 等其他文件一概不动。 */
  async function writeJson(dirHandle, name, obj) {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(obj, null, 2));
    await w.close();
  }
  async function writeText(dirHandle, name, text) {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(String(text));
    await w.close();
  }
  /** lineinfo.md 落盘（保存工作区的两条通道共用的环节）：内存有文本且与落盘基线不同才写
   *  ——未载入该文件的工作区不凭空生成；整文件写回但被编辑节以外的字节由
   *  replaceLineInfoSection 保证原样；写完同步基线（脏标记随之清除）。返回是否实际写入。 */
  async function saveLineinfoIfChanged(dirHandle) {
    if (typeof S.lineinfoMd !== 'string' || S.lineinfoMd === S.lineinfoSavedMd) return false;
    await writeText(dirHandle, 'lineinfo.md', S.lineinfoMd);
    S.lineinfoSavedMd = S.lineinfoMd;
    return true;
  }

  async function saveWorkspaceToHandle(dir) {
    setStatus(`正在保存工作区（${dir.name}）…`);
    const lines = [...S.lines.values()];
    const linesDir = await dir.getDirectoryHandle('lines', { create: true });
    let ok = 0, fail = 0;
    for (const l of lines) {
      const issues = lineIssues(l);
      if (issues.length) { fail++; setStatus(`保存失败 ${l.id}：${issues.join('；')}`, true); continue; }
      try { await writeJson(linesDir, `${l.id}.json`, lineForSave(l)); ok++; }   // 联络线不带 color 落盘（兜底）
      catch (e) { fail++; setStatus(`写入失败 ${l.id}.json：${e.message}`, true); }
    }
    if (!S.groups) S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    normalizeStationGroups(S.groups.stationGroups);   // 兜底：嵌套子组字段为空不写出（载入与各操作已保证）
    await writeJson(dir, 'groups.json', S.groups);
    await writeJson(dir, 'manifest.json', buildManifest());
    let liWrote = false;
    try { liWrote = await saveLineinfoIfChanged(dir); }   // lineinfo.md（有介绍改动时）
    catch (e) { setStatus(`写入失败 lineinfo.md：${e.message}`, true); }
    // 同步语义：lines/ 里已不在当前数据的线路文件删除（只认 lNNNN.json 命名，其余文件不动）
    const ids = new Set(lines.map((l) => l.id));
    const removed = [];
    for await (const [name, handle] of linesDir.entries()) {
      const m = /^(l\d{4})\.json$/.exec(name);
      if (m && handle.kind === 'file' && !ids.has(m[1])) { await linesDir.removeEntry(name); removed.push(name); }
    }
    renderLineInfoPanel();   // 介绍落盘基线已同步：面板未保存标记随之刷新（无介绍改动时为无害重绘）
    setStatus(`工作区已保存到 ${dir.name}/：线路 ${ok} 条＋groups.json＋manifest.json`
      + (liWrote ? '＋lineinfo.md' : '')
      + (fail ? `；${fail} 条未过检查或写入失败（见上）` : '')
      + (removed.length ? `；已删除多余线路文件 ${removed.join('、')}` : '。'));
  }

  // 换乘站名回填（2026-11-22 需求 3）：勾选「填补换乘站数据」时每次保存工作区先执行——
  // 从各线已命名的「换」标识站收集站名，写回站圆预置的空缺建议（只填缺、不覆盖已有）；
  // 直接改 S.stationPresets 内存并重渲染站列表，**无需刷新即生效**（下一条线「采用全部建议名」立即可用）。
  function backfillTransfersBeforeSave() {
    if (!$('backfillTrans').checked) return;
    const pairs = [...S.lines.values()].map((l) => ({ line: l, preset: matchPresetForLine(l) }));
    const { filled, conflicts } = backfillTransferNames(pairs, S.stationPresets);
    renderLineForm(); renderStopList();   // 建议与 ⚠ 冲突标记随预置内存变化即时反映（属性面板信息行含冲突数）
    // 同站不同名的冲突不弹 toast 吵人（站列表 ⚠ 常驻可见），仅在有填补时顺带报数
    if (filled) toast(`填补了 ${filled} 个换乘站站名空缺${conflicts ? `；${conflicts} 个同站不同名未填补` : ''}`);
  }

  // 回填开关状态：默认开（只补缺、无破坏性），用户改动持久 localStorage
  const bfEl = $('backfillTrans');
  bfEl.checked = (localStorage.getItem('shrail.backfillTrans') || '1') === '1';
  bfEl.addEventListener('change', () => {
    localStorage.setItem('shrail.backfillTrans', bfEl.checked ? '1' : '0');
    setStatus(bfEl.checked
      ? '已开启：载入数据与保存工作区时填补换乘站名空缺（只补缺、不覆盖已有建议，右上角提示数量）。'
      : '已关闭换乘站名回填。');
  });

  /** 数据载入完成后自动回填一次（2026-11-22 用户反馈：回填原先只挂在「保存工作区」上，
   *  刷新后预置从磁盘恢复原状、必须再保存一次才回来）。boot／恢复本地暂存／载入工作区
   *  三个数据就绪点各调一次：尊重开关；幂等（只填空缺，先前已填的不动）；静默（不弹
   *  toast——boot 场景弹了也会被后续初始化状态盖掉），确有填补或冲突标记时刷新站列表与属性面板 */
  function backfillTransfersOnLoad() {
    if (!$('backfillTrans').checked) return;
    if (!S.stationPresets.length) return;
    const pairs = [...S.lines.values()].map((l) => ({ line: l, preset: matchPresetForLine(l) }));
    const { filled, conflicts } = backfillTransferNames(pairs, S.stationPresets);
    if (filled || conflicts) { renderLineForm(); renderStopList(); }
  }

  $('btnSaveWorkspace').onclick = async () => {
    backfillTransfersBeforeSave();   // 需求 3：勾选时先回填换乘站名（改内存预置，即改即生效），再走原保存流程
    if (!wsHandle && window.showDirectoryPicker) {
      // 未打开工作区：先选目录（另存为语义）
      try { wsHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); }
      catch (e) { return; }   // 用户取消
    }
    if (wsHandle) {
      try { await saveWorkspaceToHandle(wsHandle); return; }
      catch (e) { setStatus(`直写工作区失败（${e.message}）——已转多文件下载。`, true); }
    }
    saveWorkspaceDownload();
  };

  function buildManifest() {
    const active = [...S.lines.values()].filter((l) => !l.meta.archived);
    // archived 表：沿用旧表防编号复用＋补当前归档线；取消归档的线从中摘除（见 archivedIdList）
    S.manifest = {
      schema: 'fmt/manifest@1',
      dataset: (S.manifest && S.manifest.dataset) || 'main',
      version: (S.manifest && S.manifest.version) || '0.1.0',
      updated: today(),
      lines: active.map((l) => ({ id: l.id, file: `lines/${l.id}.json`, name: l.name, stops: l.stops.length })),
      archived: archivedIdList(S.manifest && S.manifest.archived, [...S.lines.values()]),
      // 显示顺序（可选字段，2026-11-22 需求 5）：写出全量显式顺序——normalize 已清失效 id、
      // 补齐全部线（含归档线，flatten/查看器侧自会忽略归档）；flatten 据此产出 net/index.json
      lineOrder: effectiveLineOrder(),
    };
    return S.manifest;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 降级保存＝线路＋groups＋manifest（＋lineinfo.md 有介绍改动时）一并下载（目录直写不可用时；
  // 水位恢复依赖 manifest，务必成套）；逐个隔 150ms 发出降低浏览器多下载拦截概率，结束对账计数
  async function saveWorkspaceDownload() {
    const lines = [...S.lines.values()];
    const liPending = typeof S.lineinfoMd === 'string' && S.lineinfoMd !== S.lineinfoSavedMd;
    const total = lines.length + 2 + (liPending ? 1 : 0);
    let ok = 0, fail = 0, n = 0;
    for (const l of lines) {
      const issues = lineIssues(l);
      if (issues.length) { fail++; setStatus(`保存失败 ${l.id}：${issues.join('；')}`, true); continue; }
      download(`${l.id}.json`, lineForSave(l)); ok++; n++;   // 联络线不带 color 落盘（兜底）
      setStatus(`保存工作区 ${n}/${total}：已请求 ${l.id}.json`);
      await sleep(150);
    }
    if (!S.groups) S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    normalizeStationGroups(S.groups.stationGroups);   // 兜底：嵌套子组字段为空不写出（载入与各操作已保证）
    download('groups.json', S.groups); n++;
    setStatus(`保存工作区 ${n}/${total}：已请求 groups.json`);
    await sleep(150);
    download('manifest.json', buildManifest()); n++;
    if (liPending) {
      await sleep(150);
      downloadText('lineinfo.md', S.lineinfoMd); n++;   // 手填 markdown 原样下载（不 JSON 化）
      S.lineinfoSavedMd = S.lineinfoMd;                 // 已导出即记为已保存（与直写通道口径一致）
    }
    renderLineInfoPanel();   // 介绍基线已同步：面板未保存标记随之刷新（无介绍改动时为无害重绘）
    setStatus(`保存工作区完成（降级下载模式）：已请求 ${n}/${total} 个文件（线路 ${ok} 个`
      + (fail ? `＋未过检查 ${fail} 个（见上）` : '') + '＋groups＋manifest'
      + (liPending ? '＋lineinfo.md' : '') + '）→ 放入工作区/data/ 对应位置。'
      + '若浏览器询问「允许下载多个文件」请允许；中途取消可再点本按钮补齐。'
      + '（Chrome/Edge 可经「载入工作区」打开文件夹获得直写，免手动归档。）', !!fail);
  }

  // ---------- 启动 ----------
  window.addEventListener('resize', () => { applyView(); scheduleWorld(); });   // 合帧：拖动窗体时连发

  (async function boot() {
    loadCounters();
    await bootFetchData();
    syncCountersWithLoaded();
    syncAddKindButtons();
    syncBasemapButton();
    $('btnBasemap').classList.toggle('primary', S.basemap !== 'off' && !!S.calib);
    offerRestore();
    if (!S.view) fitView();
    setStatus(MODE_HINT.select);
    $('canvasHint').textContent = MODE_HINT.select;
    renderAll();
    backfillTransfersOnLoad();   // boot 数据就绪：自动回填（点「恢复暂存」后 btnRestore 内还会再跑一次，幂等）
  })();
})(typeof globalThis !== 'undefined' ? globalThis : this);
