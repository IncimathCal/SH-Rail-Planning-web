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
   *  注：环线环绕两端同状态的块按线性扫描仍生成两个分段（合法，可一键并段），不自动跨环绕合并。 */
  function migrateLineToV2(line) {
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

  /** 保存前客户端自检（与 validate.py 规则对应的子集） */
  function lineIssues(l) {
    const issues = [];
    l.stops.forEach((st, i) => {
      // 线路所（kind:'block'）站名可空；普通站空名仍报
      if (st.kind !== 'block' && (!st.name || !st.name.trim())) issues.push(`${st.id} 站名为空`);
      if (i > 0 && st.t <= l.stops[i - 1].t) issues.push(`${st.id} t 未递增`);
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
   *  已命名的站与线路所（kind:'block'，可无名）都跳过不动——
   *  「先点完设站再一次贴名」与逐站命名两种方式并存。
   *  返回 {pairs:[[stop,name]...], total}；写入由调用方执行（便于先快照后改）。 */
  function planBulkFill(line, names) {
    const clean = (names || []).map((s) => String(s).trim()).filter(Boolean);
    const pairs = [];
    let k = 0;
    for (const st of line.stops) {
      if (st.kind === 'block') continue;
      if (st.name && st.name.trim()) continue;
      if (k >= clean.length) break;
      pairs.push([st, clean[k++]]);
    }
    return { pairs, total: clean.length };
  }

  /** 站圆预置批量落站规划（fmt/stations-import@1；node 单测覆盖）。
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

  /** 站点 t 就近取预置站名建议（|Δt| ≤ dtEps）；返回 {name, dist} 或 null。仅展示用，点选才写入。 */
  function suggestForStop(item, t, dtEps = 0.002) {
    if (!item) return null;
    let best = null;
    for (const s of item.stops || []) {
      if (!s.nameSuggestion) continue;
      const d = Math.abs(s.t - t);
      if (d <= dtEps && (!best || d < best.d)) best = { name: s.nameSuggestion, dist: s.suggestDist, d };
    }
    return best;
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

  /** 建组类型判定（拉框/点选攒组共用；node 单测覆盖）。
   *  kinds＝候选成员的 stop.kind 列表（'block'＝线路所，其余/null＝普通车站）：
   *  含线路所 → 组类型强制 junction（接轨站）且成员必须全为线路所；
   *  线路所与普通车站混选 → 拒绝（ok:false, reason:'mixed'）；
   *  全普通车站 → 默认 same-station（既有行为不变）。 */
  function planStationGroup(kinds) {
    const arr = kinds || [];
    const nBlock = arr.filter((k) => k === 'block').length;
    if (nBlock > 0 && nBlock < arr.length) return { ok: false, reason: 'mixed' };
    if (nBlock > 0) return { ok: true, type: 'junction', allBlock: true };
    return { ok: true, type: 'same-station', allBlock: false };
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

  const SHLogic = { SEG_ORDER, SEG_LABEL, ROLE_LABEL, EPS, segInsert, segRemove,
    pruneSections, migrateLineToV2, planSectionSplit, applySectionMerge, sectionSpanOf, sectionIssuesOf,
    nextStopSeq, fixStatusField, lineIssues, planBulkFill,
    planStopImport, applyStopImport, suggestForStop,
    layerGroupsOf, junctionStroke, planStationGroup,
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

  // ---------- 状态 ----------
  const S = {
    lines: new Map(),        // lid -> line 对象（fmt/line@1，可直接序列化）
    groups: null,            // fmt/groups@1 或 null（首份保存时初始化）
    manifest: null,          // fmt/manifest@1 或 null
    imports: [],             // {source, imported, paths:[{sourceLayer,color,path}]}
    stationPresets: [],      // fmt/stations-import@1 的 items（站圆预置，只读参考数据，不进撤销/暂存）
    calib: null,             // fmt/calibration@2（model:"tps"，手动标定 TPS v2；svg→经纬度）。渲染恒用现行 calibration.json
    basemap: 'off',          // 底图三态：'off'｜'osm'｜'amap'（高德，GCJ02 逐瓦片偏移；偏好存 localStorage）
    arcs: new Map(),         // lid -> SHGeom.ArcPath
    view: null,              // {x,y,w,h}，null = 待适配内容
    mode: 'select',
    addKind: null,           // 加站拍放类型：null＝车站（缺省），'block'＝线路所（中途接轨点）
    activeLine: null,        // lid
    selStop: null,           // sid
    selImport: null,         // {source, sourceLayer}
    pending: [],             // 编组模式待选 stop id 列表
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
  function snapshot() {
    const s = JSON.stringify({
      lines: [...S.lines.values()],
      groups: S.groups, imports: S.imports,
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
    S.groups = d.groups; S.imports = d.imports;
    S.arcs = new Map();
    if (S.selImport && !S.imports.some((im) => im.source === S.selImport.source)) S.selImport = null;
    if (!S.lines.has(S.activeLine)) S.activeLine = null;
    S.selStop = null; S.pending = [];
    renderAll(); setStatus('已撤销。');
  }

  // ---------- localStorage 暂存 ----------
  let lsTimer = null;
  let lsFailed = false;   // 最近一次暂存是否失败（beforeunload 拦截与告警依据）
  function autosave() {
    clearTimeout(lsTimer);
    lsTimer = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify({
          savedAt: Date.now(),
          lines: [...S.lines.values()],
          groups: S.groups, imports: S.imports, activeLine: S.activeLine,
        }));
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
      S.groups = snap.groups;
      // 导入记录：同名来源以刚从 import/ 磁盘载入的为准（可能比暂存新），其余保留暂存里的
      const diskSources = new Set(S.imports.map((i) => i.source));
      S.imports = (snap.imports || []).filter((i) => !diskSources.has(i.source)).concat(S.imports);
      S.activeLine = snap.activeLine && S.lines.has(snap.activeLine) ? snap.activeLine : null;
      $('banner').classList.remove('show');
      syncCountersWithLoaded(); renderAll();
      setStatus('已恢复本地暂存。' + (notes.length ? ' ' + notes.join('；') + '。' : ''));
    };
    $('btnDiscard').onclick = () => {
      localStorage.removeItem(LS_KEY);
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
  }

  /** 线路对象载入统一入口的迁移环节：@1（segments 为状态字符串数组）→@2 分段实体，
   *  就地转换；返回 null（已是 @2）或中文提示（「l0001：旧版分段已转换为分段实体（N 段），保存后生效」）。
   *  覆盖路径：拖入/选择 .json（loadDataObject）、工作区直读/目录读（applyWorkspace）、
   *  http 自动拉取 data/（bootFetchData）、本地暂存恢复（offerRestore）、撤销还原（undo）。 */
  function migrateLineNote(obj) {
    const n = migrateLineToV2(obj);
    return n ? `${obj.id}：旧版分段已转换为分段实体（${n} 段），保存后生效` : null;
  }
  const isLineObj = (o) => o && /^l\d{4}$/.test(o.id || '')
    && (o.schema === 'fmt/line@1' || o.schema === 'fmt/line@2');

  /** 站圆预置（fmt/stations-import@1）载入：items 并入 S.stationPresets，同源替换。只读参考数据。
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
    if (obj && obj.schema === 'fmt/stations-import@1') {
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
    if (obj && obj.schema === 'fmt/groups@1') { snapshot(); S.groups = obj; return; }
    if (obj && obj.schema === 'fmt/manifest@1') { S.manifest = obj; return; }
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
    if (groups) S.groups = groups;
    const manifest = await get('data/manifest.json');
    if (manifest) S.manifest = manifest;
    // 标定：恒用现行 data/calibration.json（手动标定 TPS v2；旧 deg3 备份文件保留但不再载入，回滚走 git）
    const calib = await get('data/calibration.json');
    if (calib) takeCalibration(calib);
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
          else if (obj && obj.schema === 'fmt/stations-import@1') addStationPreset(obj);
        }
      }
    } catch (e) { /* file:// 等，忽略 */ }
  }

  // ---------- 几何缓存 ----------
  function arcOf(lid) {
    if (!S.arcs.has(lid)) {
      const line = S.lines.get(lid);
      if (!line) return null;
      try { S.arcs.set(lid, G.pathFromD(line.path)); }
      catch (e) {
        setStatus(`线路 ${lid} path 解析失败：${e.message}`);
        S.arcs.set(lid, null);
      }
    }
    return S.arcs.get(lid);
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
    const pts = ap.polylineBetween(t1, t2);
    if (!pts.length) return '';
    return 'M' + pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('L');
  }

  /** 站圈 <title> 提示文本（渲染与改名/拖站局部更新共用，保持一致） */
  function stopTitle(line, st, idx, grp) {
    const isBlk = st.kind === 'block';
    const oos = grp && grp.type === 'out-of-station';
    return `${idx + 1}. ${st.name || (isBlk ? '（线路所）' : '（未命名）')}  t=${st.t.toFixed(4)}`
      + (isBlk ? '  线路所：仅编辑器可见，正式网页隐藏' : '')
      + (oos ? `  ${grp.id}（出闸换乘）` : '');
  }

  function renderWorld() {
    // 底图组跨渲染持久保留（否则打字等高频重绘会反复清空瓦片造成闪烁）
    if (basemapG && basemapG.parentNode === world) world.removeChild(basemapG);
    world.textContent = '';
    if (!basemapG) basemapG = el('g', { id: 'basemap' });
    world.insertBefore(basemapG, world.firstChild);
    scheduleBasemap();
    const scale = S.view ? Math.max(svg.clientWidth, 1) / S.view.w : 1;
    const rStop = 5.5 / scale, ringR = 8.5 / scale, hintR = 12 / scale;

    // 换乘组索引：同站/接轨组成员隐藏小圈（画合并圈）；出闸组成员圈描黑边
    const stationGroups = (S.groups && S.groups.stationGroups) || [];
    const grpOf = new Map();               // sid -> 组对象
    const mergedHidden = new Set();        // 同站/接轨组成员 sid
    for (const g of stationGroups) {
      for (const sid of g.stops) grpOf.set(sid, g);
      if (g.type === 'same-station' || g.type === 'junction') for (const sid of g.stops) mergedHidden.add(sid);
    }

    // 未建线的导入 path（灰色虚线；2026-11-21 halo 方案用户否决回退，灰 #666→#999 提亮）
    // ＋透明加宽命中线；选中态（S.selImport 命中）虚线改强调色加粗
    const boundPaths = new Set([...S.lines.values()].map((l) => l.path));
    for (const imp of S.imports) {
      for (const p of imp.paths) {
        if (boundPaths.has(p.path)) continue;
        const sel = S.selImport && S.selImport.source === imp.source
          && S.selImport.sourceLayer === p.sourceLayer;
        const path = el('path', { d: p.path, class: 'svg-line line-raw' + (sel ? ' sel' : ''),
          stroke: '#999', 'vector-effect': 'non-scaling-stroke' }, world);
        path.dataset.impSource = imp.source;
        path.dataset.impLayer = p.sourceLayer;
        const hit = el('path', { d: p.path, class: 'svg-line line-raw-hit',
          'vector-effect': 'non-scaling-stroke' }, world);
        hit.dataset.impSource = imp.source;
        hit.dataset.impLayer = p.sourceLayer;
      }
    }

    // 线路
    for (const [lid, line] of S.lines) {
      const ap = arcOf(lid);
      if (!ap) continue;
      const gLine = el('g', { class: 'svg-line' }, world);
      gLine.style.stroke = line.color;
      gLine.dataset.lid = lid;
      const active = lid === S.activeLine;

      // 底图：完整原始贝塞尔 path（弱化）
      const base = el('path', { d: line.path, class: 'line-base',
        'vector-effect': 'non-scaling-stroke' }, gLine);
      base.style.strokeWidth = active ? 7 : 5;
      base.style.opacity = active ? 0.42 : 0.22;
      base.dataset.lid = lid;

      const stops = line.stops;
      const segs = line.segments || [];
      const n = stops.length;
      const segCount = line.loop ? n : Math.max(n - 1, 0);
      for (let i = 0; i < segCount; i++) {
        const t1 = stops[i].t;
        let t2;
        if (line.loop) {
          t2 = (i + 1 === n) ? stops[0].t : stops[i + 1].t;  // 末段环绕
        } else {
          if (i + 1 >= n) break;
          t2 = stops[i + 1].t;
        }
        // 环线仅 1 站：环绕段 = 整条闭合路径
        const dstr = (line.loop && n === 1) ? line.path : segPathString(ap, t1, t2);
        if (!dstr) continue;
        // 段样式派生：分段实体（fmt/line@2）——sections[segments[i]].status；
        // 站数<2（分段为空、状态由线路级 status 接管）或数据异常时逐级兜底
        const sec = line.sections && line.sections[segs[i]];
        const st = sec && SEG_ORDER.includes(sec.status) ? sec.status
          : (n < 2 && SEG_ORDER.includes(line.status) ? line.status : 'existing');
        el('path', { d: dstr, class: `seg-common seg-${st}`,
          'vector-effect': 'non-scaling-stroke' }, gLine);
        const hit = el('path', { d: dstr, class: 'seg-hit',
          'vector-effect': 'non-scaling-stroke' }, gLine);
        hit.dataset.lid = lid; hit.dataset.seg = i;
      }

      // 设站（同站/接轨组成员的独立小圈不画，统一画合并圈；出闸换乘描黑边；
      // 线路所 kind:'block'＝虚线圆（同尺寸、线色），仅编辑器可见、正式网页隐藏）
      stops.forEach((st, idx) => {
        if (mergedHidden.has(st.id)) return;
        const [x, y] = ap.pointAt(st.t);
        const isSel = S.selStop === st.id && lid === S.activeLine;
        const isPend = S.pending.includes(st.id);
        const grp = grpOf.get(st.id);
        const oos = grp && grp.type === 'out-of-station';
        const isBlk = st.kind === 'block';
        if (isSel) el('circle', { cx: x, cy: y, r: ringR, class: 'stop-ring',
          'vector-effect': 'non-scaling-stroke' }, gLine);
        const c = el('circle', { cx: x, cy: y, r: rStop, class: 'stop-c' + (isPend ? ' pend' : ''),
          stroke: oos ? '#000' : line.color, 'stroke-width': 2 / scale }, gLine);
        if (isBlk) c.setAttribute('stroke-dasharray', `${3 / scale} ${3 / scale}`);   // 屏幕恒定虚线（同 hint-ring 3 3 习惯）
        c.dataset.lid = lid; c.dataset.sid = st.id;
        const t = el('title', {}, c);
        t.textContent = stopTitle(line, st, idx, grp);
      });
    }

    // 同站换乘/接轨站合并圈：位置取距所有成员线路最近点（投影质心迭代收敛）。
    // 接轨站（junction，支线/联络线接轨用）：尺寸与普通设站圆一致（不做换乘大圈）、
    // 不画黑边（黑边是换乘语义），描边色按成员线角色优先级 main > standalone > branch > connector
    // 取（junctionStroke；取不到成员线颜色退 '#000'）；fill 仍白底。就近提示/点选/编组交互复用既有机制。
    for (const g of stationGroups) {
      if (g.type !== 'same-station' && g.type !== 'junction') continue;
      const members = [];
      for (const sid of g.stops) {
        for (const [lid2, line2] of S.lines) {
          const st = line2.stops.find((x) => x.id === sid);
          if (st) {
            const ap2 = arcOf(lid2);
            if (ap2) members.push({ ap: ap2, st, line: line2 });
          }
        }
      }
      if (!members.length) continue;
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
      const anyPend = g.stops.some((sid) => S.pending.includes(sid));
      const isJunc = g.type === 'junction';
      const anyBlk = isJunc && members.some((m) => m.st.kind === 'block');   // 组内含线路所→虚线（属性可见）
      const c = el('circle', { cx: px, cy: py, r: isJunc ? rStop : 7.5 / scale,
        class: 'stop-merge' + (anyPend ? ' pend' : ''),
        stroke: isJunc
          ? junctionStroke(members.map((m) => ({ role: m.line.role, color: m.line.color })))
          : '#000',
        'stroke-width': (isJunc ? 2 : 2.2) / scale }, world);
      if (anyBlk) c.setAttribute('stroke-dasharray', `${3 / scale} ${3 / scale}`);
      c.dataset.grp = g.id;
      const t = el('title', {}, c);
      t.textContent = `${g.id} ${isJunc ? '接轨站' : '同站换乘'}：${g.stops.map((sid) => stopLabel(sid)).join('；')}`
        + (anyBlk ? '（含线路所：仅编辑器可见，正式网页隐藏）' : '');
    }

    // 编组就近提示（纯视觉，绝不自动成组）
    if (S.mode === 'group' && S.pending.length) {
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
      if (pendPts.length) {
        for (const [lid, line] of S.lines) {
          const ap = arcOf(lid);
          if (!ap) continue;
          for (const st of line.stops) {
            if (S.pending.includes(st.id)) continue;
            const p = ap.pointAt(st.t);
            if (pendPts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= hintWorld)) {
              el('circle', { cx: p[0], cy: p[1], r: hintR, class: 'hint-ring',
                'vector-effect': 'non-scaling-stroke' }, world);
            }
          }
        }
      }
    }
  }

  // ---------- 侧栏渲染 ----------
  function renderImportList() {
    const box = $('impList');
    if (!S.imports.length) {
      box.innerHTML = '<div class="imp-src">用工具导入或工具栏载入。选中一条 path 后可建线。</div>';
      return;
    }
    const bound = new Set([...S.lines.values()].map((l) => l.path));
    let html = '';
    for (const imp of S.imports) {
      html += `<div class="imp-src">${esc(imp.source)}（${imp.imported}）</div>`;
      // 渲染用副本按 sourceLayer 拼音序排列（已建线与未建线混排同一序列）；
      // S.imports 本身顺序不动——其载入顺序被 path 精确匹配（importHintsFor/matchPresetForLine）等逻辑遍历依赖。
      const rows = [...imp.paths].sort((a, b) => a.sourceLayer.localeCompare(b.sourceLayer, 'zh'));
      for (const p of rows) {
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
    }
    box.innerHTML = html;
  }

  function renderLineList() {
    const box = $('lineList');
    if (!S.lines.size) { box.innerHTML = '<div style="color:var(--dim)">暂无线路。</div>'; return; }
    // 按 meta.layer 分组渲染：组头（分类名＋条数）＋组内按 id 升序；未分类组固定最后；
    // 只有一类且无未分类时也照常显示组头（layerGroupsOf 保证，保持一致）
    let html = '';
    for (const grp of layerGroupsOf([...S.lines.values()])) {
      html += `<div class="layer-head"><span>${esc(grp.layer || '未分类')}</span><span>${grp.lines.length}</span></div>`;
      html += grp.lines.map((l) => `
        <div class="line-row ${l.id === S.activeLine ? 'active' : ''}" data-lid="${l.id}">
          <span class="chip" style="background:${esc(l.color)}"></span>
          <span class="nm">${esc(l.name)} ${l.meta && l.meta.archived ? '<span class="badge arch">归档</span>' : ''}</span>
          <span class="id">${l.id} · ${l.stops.length}站</span>
        </div>`).join('');
    }
    box.innerHTML = html;
  }

  // 本线 path 对应的导入建议名（自动就近匹配的源图文字，仅供参考）
  function importHintsFor(l) {
    if (!l || !l.path) return [];
    for (const imp of S.imports) {
      const p = imp.paths.find((x) => x.path === l.path);
      if (p && p.hintNames && p.hintNames.length) return p.hintNames;
    }
    return [];
  }

  /** 线路 → 匹配的站圆预置项（fmt/stations-import@1）。
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
    if (!l) { box.innerHTML = '<div style="color:var(--dim)">选择或新建一条线路后编辑属性。</div>'; return; }
    const lgs = (S.groups && S.groups.lineGroups) || [];
    const lgOpts = ['<option value="">（无）</option>'].concat(
      lgs.map((g) => `<option value="${g.id}" ${l.groupId === g.id ? 'selected' : ''}>${g.id} ${esc(g.name)}</option>`),
      ['<option value="__new__">＋ 新建线组…</option>']).join('');
    const needStatus = l.stops.length < 2;
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
    box.innerHTML = `
      <div class="fld"><label>id</label><input type="text" value="${l.id}" disabled></div>
      <div class="fld"><label>名称</label><input type="text" id="lfName" value="${esc(l.name)}"></div>
      ${importHintsFor(l).length ? `
      <div class="fld"><label>建议名</label><span class="hintline" style="flex:1">
        ${importHintsFor(l).map((n) => `<span class="namehint" data-namehint="${esc(n)}"
          title="源图附近自动匹配的文字，仅供参考；点击采用">${esc(n)}</span>`).join('')}
        <span style="color:var(--dim);font-size:10px">（自动匹配，不保证正确）</span>
      </span></div>` : ''}
      <div class="fld"><label>颜色</label><input type="color" id="lfColor" value="${esc(l.color)}"></div>
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
      ${needStatus ? `
      <div class="fld" id="lfStatusRow">
        <label>状态</label><select id="lfStatus" style="flex:1">
        ${SEG_ORDER.map((s2) => `<option value="${s2}" ${l.status === s2 ? 'selected' : ''}>${SEG_LABEL[s2]}</option>`).join('')}
        </select><span style="color:var(--dim);font-size:11px">（站数&lt;2 时必填）</span></div>` : `
      <div class="fld" id="lfStatusRow"><label>状态</label><span style="flex:1;color:var(--dim);font-size:11px">≥2 站后整线状态停用——状态挂在分段上：在左侧「设站」面板「分段（铺满全线）」区命名/切分/并段、整段改状态</span></div>`}
      <div class="fld"><label>分类</label><select id="lfLayer" style="flex:1"
        title="＝源图 Line 直属子图层名（如 市区线/市域线/联络线）；建线时自动带入，可改">${layerOpts.join('')}</select></div>
      <div class="fld"><label>源图层</label><input type="text" value="${esc((l.meta && l.meta.sourceLayer) || '')}" disabled></div>
      ${(() => {
        const it = matchPresetForLine(l);
        if (!it) return `<div class="fld"><label>站圆预置</label><span style="flex:1;color:var(--dim);font-size:11px">（无匹配${S.stationPresets.length ? '' : '——未载入预置文件'}）</span></div>`;
        const ns = it.stops.filter((s) => s.nameSuggestion).length;
        return `<div class="fld"><label>站圆预置</label><span style="flex:1" class="preset-line">
          <button class="mini primary" id="lfImportStops" title="按站圆圆心的弧长投影 t 批量落站；已有站 |Δt|<0.002 跳过；撤销一次回退整批">从预置导入车站</button>
          <button class="mini primary" id="lfAdoptNames" ${ns ? '' : 'disabled'}
            title="当前线所有空名普通站按 t 就近采纳站圆预置的建议名；已有名站与线路所跳过；错了可手动改；撤销一次回退整批">采用全部建议名</button>
          <span style="color:var(--dim);font-size:11px">${esc(it.stationGroup)} · ${it.stops.length} 圆${ns ? ` · ${ns} 带站名建议` : ''}</span>
        </span></div>`;
      })()}
      <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
        <button class="mini" id="lfUpdatePath" ${S.selImport ? '' : 'disabled'}
          title="用当前选中的导入 path 替换本线 path（设站按弧长 t 保留）">更新path</button>
        <button class="mini ${l.meta && l.meta.archived ? '' : 'danger'}" id="lfArchive">
          ${l.meta && l.meta.archived ? '取消归档' : '归档'}</button>
      </div>`;
  }

  function renderStopList() {
    const box = $('stopList');
    const l = S.lines.get(S.activeLine);
    if (!l || !l.stops.length) {
      box.innerHTML = '<div style="color:var(--dim)">在「加站」模式下点击线路加站；站名在此录入。加站类型（车站/线路所）用上方按钮切换。</div>';
      renderSections();
      return;
    }
    const preset = matchPresetForLine(l);   // 站名建议来源（无匹配则无 chips）
    box.innerHTML = l.stops.map((st, i) => {
      const prev = i > 0 ? l.stops[i - 1].t : null;
      const next = i < l.stops.length - 1 ? l.stops[i + 1].t : null;
      const tBad = st.t < 0 || st.t > 1 || (prev !== null && st.t <= prev) || (next !== null && st.t >= next);
      const isBlk = st.kind === 'block';
      // 站名建议 chip：仅普通空名站展示（源图就近文字，点选才写入；绝不自动命名；线路所不参与）
      const sug = preset && !isBlk && !(st.name && st.name.trim()) ? suggestForStop(preset, st.t) : null;
      return `
      <div class="stop-row ${S.selStop === st.id ? 'sel' : ''} ${S.pending.includes(st.id) ? 'pend' : ''}" data-sid="${st.id}">
        <span class="idx">${i + 1}</span>
        <input type="text" value="${esc(st.name)}" data-ren="${st.id}"
          class="${(st.name || isBlk) ? '' : 'warn'}" placeholder="${isBlk ? '（线路所，可无名）' : '（站名）'}">
        ${sug ? `<span class="namehint stop-suggest" data-sugsid="${st.id}" data-sugname="${esc(sug.name)}"
          title="源图就近文字（距站圆 ${sug.dist}pt），仅供参考、不保证正确；点击采用">${esc(sug.name)}</span>` : ''}
        <input type="text" value="${st.t.toFixed(6)}" data-tedit="${st.id}"
          class="tin${tBad ? ' warn' : ''}" title="弧长位置 t∈[0,1]，可手改（如起点改 0、开线终点改 1）">
        <button class="mini kind-tgl ${isBlk ? 'primary' : ''}" data-kind="${st.id}"
          title="${isBlk ? '转回普通车站（有名、正式网页可见）' : '转为线路所：中途接轨点，虚线圆、可无名，仅编辑器可见（正式网页隐藏）；只能与线路所编为接轨站组'}">所</button>
        <button class="mini danger" data-del="${st.id}" title="删除设站">✕</button>
      </div>`;
    }).join('');
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
      rows.innerHTML = '<div style="color:var(--dim);font-size:11px">'
        + '设站 ≥2 后可用（当前用属性面板线路级状态）。</div>';
      splitSel.innerHTML = '';
      splitSel.disabled = splitBtn.disabled = true;
      hint.textContent = '';
      return;
    }
    splitSel.disabled = splitBtn.disabled = false;   // 下方按候选重定
    // 每段一行（段序＝线路序）：名称输入（可空）＋状态三档＋并段 ✕；
    // 末段 ✕ 仅环线显示（并首段，跨环绕）；行下小字＝覆盖区间
    rows.innerHTML = (line.sections || []).map((sec, k) => {
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
    }).join('');
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
    splitSel.innerHTML = cand.length
      ? cand.map((k) => `<option value="${k}">${k} ${esc(label(line.stops[k - 1]))}</option>`).join('')
      : '<option value="">（无——各站边界已在段界上）</option>';
    splitSel.value = [...splitSel.options].some((o) => o.value === old) ? old : splitSel.value;
    splitSel.disabled = splitBtn.disabled = !cand.length;
    hint.textContent = cand.length
      ? '在所选站设边界：该站两侧分属两段（新段名空、状态继承原段）。'
      : '每个站间边界都已是段界——要加段请先到相邻段中间站切分。';
  }

  function stopLabel(sid) {
    for (const l of S.lines.values()) {
      const st = l.stops.find((x) => x.id === sid);
      if (st) return `${l.id} ${st.name || (st.kind === 'block' ? '（线路所）' : '（未命名）')}`;
    }
    return sid;
  }

  /** sid → 设站类型（'block'＝线路所；null＝普通车站；找不到站也返回 null） */
  function stopKindOf(sid) {
    for (const l of S.lines.values()) {
      const st = l.stops.find((x) => x.id === sid);
      if (st) return st.kind === 'block' ? 'block' : null;
    }
    return null;
  }

  function renderGroupsPanel() {
    if (!S.groups) {
      S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    }
    // 待编组
    $('pendingBox').innerHTML = S.mode === 'group' ? `
      <div style="font-size:12px;margin-bottom:4px">待编组：<b>${S.pending.length}</b> 站
        <button class="mini primary" id="btnMkGroup" ${S.pending.length >= 2 ? '' : 'disabled'}>编组</button>
        <button class="mini" id="btnClearPend" ${S.pending.length ? '' : 'disabled'}>清空</button></div>
      <div style="font-size:11px;color:var(--dim)">黄色虚线圈=就近提示，仅供参考，绝不自动合并。</div>` : '';
    // 换乘节点组（含线路所的组：线路所不得进 same-station/out-of-station，类型下拉锁死 junction）
    const sgs = S.groups.stationGroups || [];
    $('stationGroups').innerHTML = '<div style="margin-bottom:2px"><b>换乘节点组</b></div>' +
      (sgs.length ? sgs.map((g) => {
        const hasBlk = g.stops.some((sid) => stopKindOf(sid) === 'block');
        const lock = hasBlk ? ' title="组内含线路所：只能为接轨站（junction）"' : '';
        return `
        <div class="grp-row" data-gid="${g.id}">
          <b>${g.id}</b>
          <select data-gtype="${g.id}"${lock}>
            <option value="same-station" ${g.type === 'same-station' ? 'selected' : ''} ${hasBlk ? 'disabled' : ''}>同站</option>
            <option value="out-of-station" ${g.type === 'out-of-station' ? 'selected' : ''} ${hasBlk ? 'disabled' : ''}>出闸</option>
            <option value="junction" ${g.type === 'junction' ? 'selected' : ''}>接轨站</option>
            <option value="" ${!g.type ? 'selected' : ''} ${hasBlk ? 'disabled' : ''}>type 未定</option>
          </select>
          <button class="mini danger" data-gdel="${g.id}">拆组</button>
          <div class="m">${g.stops.map((s2) => esc(stopLabel(s2))).join('；')}</div>
        </div>`;
      }).join('')
        : '<div style="color:var(--dim);font-size:12px">（暂无）</div>');
    // 线组
    const lgs = S.groups.lineGroups || [];
    $('lineGroups').innerHTML = (lgs.length ? lgs.map((g) => {
      const members = [...S.lines.values()].filter((l) => l.groupId === g.id);
      return `<div class="grp-row" data-lgid="${g.id}">
        <span class="chip" style="display:inline-block;width:11px;height:11px;background:${esc(g.color || '#888')};border-radius:3px"></span>
        <b>${g.id}</b> ${esc(g.name)}
        <button class="mini danger" data-lgdel="${g.id}" ${members.length ? 'disabled title="仍有成员线"' : ''}>删除</button>
        <div class="m">${members.length ? members.map((m) => `${m.id} ${esc(m.name)}`).join('；') : '（无成员）'}</div>
      </div>`;
    }).join('') : '<div style="color:var(--dim);font-size:12px">（暂无）</div>');
  }

  function renderAll() {
    if (!S.view) fitView();
    applyView();
    renderWorld();
    renderImportList();
    renderLineList();
    renderLineForm();
    renderStopList();
    renderGroupsPanel();
    autosave();
  }

  function setStatus(msg, isErr) {
    statusEl.textContent = msg;
    statusEl.style.color = isErr ? 'var(--err)' : 'var(--dim)';
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
      // name 留空待人工录入（不擅自命名）；源图匹配文字只作属性面板里的建议名
      schema: 'fmt/line@2', id: lid, name: '',
      groupId: null, role: 'standalone', color: p.color,
      loop: /z/i.test(p.path), path: p.path, connects: [],
      stops: [], segments: [], sections: [], status: 'future',
      info: {},
      meta: { created: today(), updated: today(), archived: false,
        aliases: [], sourceLayer: sourceLayer, stopSeq: 0 },
    };
    // 站数<2 时分段为空（线路级 status 接管）；默认分段 [{name:"",status:"future"}]
    // 在第 2 站落位时由 fixStatusField 依 line.status 生成（语义同「建新线默认分段」）。
    // 分类继承：path 记录带 layer 字段（.ai Line 直属子图层名，可能不存在——防御式读取）则原样带入。
    // 「更新path」不回写分类——layer 只在建线时作初始值，此后属人工设定（renderLineForm 分类下拉改）。
    if (typeof p.layer === 'string' && p.layer) line.meta.layer = p.layer;
    S.lines.set(lid, line);
    S.activeLine = lid; S.selStop = null;
    renderAll();
    setStatus(`已建线 ${lid}。请在属性面板命名（导入匹配文字仅作建议），再到「加站」模式点击线路设站。`);
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
    setStatus(`站圆预置导入「${item.stationGroup}」：新增 ${added.length} 站`
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
    let named = 0, noSug = 0, blk = 0;
    const pairs = [];
    for (const st of l.stops) {
      if (st.kind === 'block') { blk++; continue; }   // 线路所可无名，不参与建议名
      if (st.name && st.name.trim()) { named++; continue; }
      const sug = suggestForStop(preset, st.t);
      if (sug) pairs.push([st, sug]);
      else noSug++;
    }
    if (!pairs.length) {
      setStatus(`没有可采用的建议名：${noSug} 个空名站无就近建议（|Δt|>0.002）`
        + (named ? `，${named} 站已有名跳过` : '') + '。');
      return;
    }
    snapshot();   // 写入前一次快照：整批一次撤销（无可采用时上面已 return，不清快照）
    for (const [st, sug] of pairs) st.name = sug.name;
    l.meta.updated = today();
    renderAll();
    setStatus(`已采用 ${pairs.length} 个建议名（空名站按 t 就近写入，可手动修改）`
      + `、跳过 ${named} 个已有名`
      + (blk ? `、${blk} 个线路所` : '')
      + (noSug ? `、${noSug} 个空名站无就近建议（|Δt|>0.002）` : '')
      + '；撤销一次回退整批。');
  }

  // ---------- 设站操作 ----------
  /** kind：null＝车站（缺省，stop 不写 kind 字段——老数据零迁移），'block'＝线路所（中途接轨点） */
  function addStop(lid, t, kind) {
    const line = S.lines.get(lid);
    const ap = arcOf(lid);
    if (!line || !ap) return;
    t = Math.round(t * 1e6) / 1e6;
    // 找插入位置（t 严格递增）
    let i = 0;
    while (i < line.stops.length && line.stops[i].t < t) i++;
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
    line.stops.splice(i, 0, st);
    segInsert(line, i);
    fixStatusField(line);
    line.meta.updated = today();
    S.selStop = sid;
    renderAll();
    setStatus(kind === 'block'
      ? `已加线路所 ${sid}（t=${t}，可无名；虚线圆，仅编辑器可见）。`
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
      for (const g of S.groups.stationGroups || []) {
        if (g.stops.includes(sid)) {
          g.stops = g.stops.filter((x) => x !== sid);
          grpNote = `（已从 ${g.id} 移除）`;
        }
      }
      S.groups.stationGroups = (S.groups.stationGroups || []).filter((g) => g.stops.length >= 2);
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
  /** 画布双击线路/段后：左栏定位并滚动可见 */
  function locateLineInList(lid) {
    S.activeLine = lid; S.selStop = null;
    renderLineList(); renderLineForm(); renderStopList();
    const r = [...$('lineList').querySelectorAll('.line-row')].find((x) => x.dataset.lid === lid);
    if (r) r.scrollIntoView({ block: 'nearest' });
  }
  /** 画布双击车站后：左栏定位滚动可见 */
  function locateStopInList(sid, lid) {
    const r = [...$('stopList').querySelectorAll('.stop-row')].find((x) => x.dataset.sid === sid);
    if (r) r.scrollIntoView({ block: 'nearest' });
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
      S.activeLine = lid;
      S.selStop = sid;
      renderStopList(); renderLineList(); renderLineForm();
      renderWorld();   // 先全量一次：渲染选中环并取重绘后的新站圈引用（旧元素已销毁），供拖动局部更新
      drag = { type: 'stop', lid, sid, moved: false,
        el: world.querySelector(`.stop-c[data-sid="${CSS.escape(sid)}"]`),
        ring: world.querySelector('.stop-ring'),
        pre: JSON.stringify({ lines: [...S.lines.values()], groups: S.groups, imports: S.imports }) };
      svg.setPointerCapture(e.pointerId);
      regCanvasDbl(`stop:${sid}`, () => locateStopInList(sid, lid));   // 双击站圈：左栏定位
      return;
    }
    if (stopEl && S.mode === 'select') {
      // 选择模式点站：仅选中并切换当前线（不拖动）；随后的拖动落到下方平移
      const sid = stopEl.dataset.sid, lid = stopEl.dataset.lid;
      S.activeLine = lid;
      S.selStop = sid;
      renderStopList(); renderLineList(); renderLineForm();
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
      const [wx, wy] = toWorld(e);
      if (moveStop(drag.lid, drag.sid, nearestTOnLine(drag.lid, wx, wy))) {
        drag.moved = true;
        // 拖动中只挪该站圆＋选中环＋title（松手再全量对齐列表 t 值/排序）——满规模防逐帧全量重建卡顿
        const line = S.lines.get(drag.lid);
        const st = line && line.stops.find((x) => x.id === drag.sid);
        const ap = st && arcOf(drag.lid);
        if (st && ap && drag.el && drag.el.isConnected) {
          const [x, y] = ap.pointAt(st.t);
          drag.el.setAttribute('cx', x); drag.el.setAttribute('cy', y);
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
      const mgEl = hitEl.closest('.stop-merge');
      if (mgEl) {
        const g = S.groups.stationGroups.find((x) => x.id === mgEl.dataset.grp);
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
        S.pending = S.pending.includes(sid) ? S.pending.filter((x) => x !== sid) : [...S.pending, sid];
        renderAll();
        return;
      }
    }

    // select 模式的点击
    const mgSel = hitEl.closest('.stop-merge');
    if (mgSel) {
      const g = S.groups.stationGroups.find((x) => x.id === mgSel.dataset.grp);
      if (g) setStatus(`${g.id} ${g.type === 'junction' ? '接轨站' : g.type === 'out-of-station' ? '出闸换乘' : g.type ? '同站换乘' : '类型未定'}组：${g.stops.map((sid) => stopLabel(sid)).join('；')}`);
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
      renderImportList(); renderWorld();   // 画布同步高亮该未建线
      setStatus(`选中导入 path：${impEl.dataset.impLayer}（${impEl.dataset.impSource}）`);
      const iSrc = impEl.dataset.impSource, iLayer = impEl.dataset.impLayer;
      regCanvasDbl(`imp:${iSrc}|${iLayer}`, () => {   // 双击未建线：左栏导入源定位滚动可见
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
    // 线路所编组约束（planStationGroup）：混选拒绝；全线路所强制 junction；全普通站默认同站
    const plan = planStationGroup(fresh.map((sid) => stopKindOf(sid)));
    if (!plan.ok) {
      setStatus(`框内可建组的 ${fresh.length} 站中线路所与普通车站混选，未建组`
        + '（线路所只能与线路所编为接轨站组）'
        + (skipped.length ? `；另有 ${skipped.length} 站已在其他组。` : '。'), true);
      return;
    }
    if (!S.groups) S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    snapshot();
    const id = bumpCounter('nextG', 'g', 4);
    S.groups.stationGroups.push({ id, stops: fresh, type: plan.type, info: {} });
    S.pending = S.pending.filter((sid) => !fresh.includes(sid));   // 已入组的不再留在待编组
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
    applyView(); renderWorld();
  }, { passive: false });

  // ---------- 侧栏事件（委托） ----------
  $('impList').addEventListener('click', (e) => {
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
    const kindEl = e.target.closest('[data-kind]');   // 线路所↔普通车站切换（互相转换）
    if (kindEl) {
      const line = S.lines.get(S.activeLine);
      const st = line && line.stops.find((s) => s.id === kindEl.dataset.kind);
      if (st) {
        // 双向守住组约束：转换后组内不得混编（全线路所⟺junction 组；普通站组不得混入线路所）
        const grp = S.groups && (S.groups.stationGroups || []).find((g) => g.stops.includes(st.id));
        if (grp) {
          const others = grp.stops.filter((sid) => sid !== st.id).map((sid) => stopKindOf(sid));
          if (st.kind !== 'block') {   // → 线路所：组内须已全线路所，且组为 junction
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
        if (st.kind === 'block') delete st.kind;
        else st.kind = 'block';
        line.meta.updated = today();
        renderAll();
        setStatus(st.kind === 'block'
          ? `${st.id} 已转为线路所（虚线圆、可无名、仅编辑器可见）。`
          : `${st.id} 已转回普通车站。`);
      }
      return;
    }
    const sugEl = e.target.closest('[data-sugsid]');   // 站名建议 chip：点选采用（人工确认写入）
    if (sugEl) {
      const line = S.lines.get(S.activeLine);
      const st = line && line.stops.find((s) => s.id === sugEl.dataset.sugsid);
      if (st) {
        snapshot();
        st.name = sugEl.dataset.sugname;
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
    renderWorld();
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
    const bad = (prev !== null && st.t <= prev) || (next !== null && st.t >= next);
    e.target.classList.toggle('warn', bad);
    e.target.value = st.t.toFixed(6);
    if (bad) setStatus('警告：t 未严格递增（保存线路时会被拦截）。', true);
    else setStatus(`t 已更新为 ${st.t}。`);
  });

  // 加站类型切换（车站/线路所）：只影响「加站」模式落站写入的 stop.kind（默认车站＝不写字段）
  function syncAddKindButtons() {
    $('akStop').classList.toggle('primary', S.addKind !== 'block');
    $('akBlock').classList.toggle('primary', S.addKind === 'block');
  }
  $('akStop').addEventListener('click', () => {
    S.addKind = null; syncAddKindButtons();
    setStatus('加站类型：车站（普通设站，需站名）。');
  });
  $('akBlock').addEventListener('click', () => {
    S.addKind = 'block'; syncAddKindButtons();
    setStatus('加站类型：线路所（中途接轨点：虚线圆、可无名、仅编辑器可见；只能与线路所编为接轨站组）。');
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
      case 'lfLoop':
        snapshot();
        toggleLoop(l, e.target.checked);
        break;
      case 'lfRole': {
        snapshot();
        l.role = e.target.value;
        if (l.role !== 'connector') l.connects = [];
        if ((l.role === 'main' || l.role === 'branch') && !l.groupId) {
          // 留待用户在下方线组下拉中选择
        }
        $('lfGroupRow').style.display = (l.role === 'main' || l.role === 'branch') ? 'flex' : 'none';
        $('lfConnRow').style.display = l.role === 'connector' ? 'flex' : 'none';
        break;
      }
      case 'lfGroup':
        if (e.target.value === '__new__') { newLineGroupFor(l); return; }
        l.groupId = e.target.value || null;
        break;
      case 'lfConnects':
        l.connects = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        break;
      case 'lfStatus': l.status = e.target.value; break;
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
      scheduleFormRender(fld === 'lfColor' || fld === 'lfLoop' || fld === 'lfRole');
    }
  });
  $('lineform').addEventListener('click', (e) => {
    if (e.target.dataset.namehint !== undefined) {   // 建议名：点选采用（人工确认后才写入）
      const l = S.lines.get(S.activeLine);
      if (!l) return;
      snapshot();
      l.name = e.target.dataset.namehint;
      l.meta.updated = today();
      renderLineForm(); renderLineList(); renderWorld(); autosave();
      setStatus(`已采用建议名「${l.name}」为 ${l.id} 命名（可继续在名称框修改）。`);
      return;
    }
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
    const gid = e.target.dataset.gdel;
    if (!gid) return;
    snapshot();
    S.groups.stationGroups = S.groups.stationGroups.filter((g) => g.id !== gid);
    renderAll();
  });
  $('stationGroups').addEventListener('change', (e) => {
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
    g.type = e.target.value || null; renderWorld(); autosave();
  });

  $('pendingBox').addEventListener('click', (e) => {
    if (e.target.id === 'btnClearPend') { S.pending = []; renderAll(); return; }
    if (e.target.id === 'btnMkGroup') {
      if (S.pending.length < 2) return;
      // 一设站至多一组：冲突即拒绝（人工先拆组）
      const conflict = [];
      for (const g of S.groups.stationGroups) {
        for (const sid of S.pending) if (g.stops.includes(sid)) conflict.push(`${sid} 已在 ${g.id}`);
      }
      if (conflict.length) {
        setStatus('冲突：' + conflict.join('；') + '。请先拆组。', true);
        return;
      }
      // 线路所编组约束（planStationGroup）：混选拒绝；全线路所强制 junction；全普通站默认同站
      const plan = planStationGroup(S.pending.map((sid) => stopKindOf(sid)));
      if (!plan.ok) {
        setStatus('编组拒绝：待编组里线路所与普通车站混选（线路所只能与线路所编为接轨站组）。', true);
        return;
      }
      snapshot();
      const id = bumpCounter('nextG', 'g', 4);
      S.groups.stationGroups.push({ id, stops: [...S.pending], type: plan.type, info: {} });
      S.pending = [];
      renderAll();
      setStatus(plan.allBlock
        ? `已建接轨站组 ${id}（全线路所：合并为普通尺寸虚线圈，描边取成员线角色最高优先级色）。`
        : `已建换乘节点组 ${id}（默认同站：合并为一个黑边大圈；可在列表改出闸/接轨站/未定）。`);
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
  $('btnUndo').addEventListener('click', () => undo());   // 顶栏撤销按钮（此前仅 Ctrl+Z，按钮未接线）
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
    add: '加站：点击线路附近即可加站（吸附半径 40px，自动记弧长 t）；按住已有站圈可直接拖动改位置（没按到则照常拖画布）。加站类型（车站/线路所）用左侧设站面板顶部按钮切换；可以先一路点完，再展开「批量命名」一次贴入站名（线路所跳过）。',
    group: '编组：任意处拉框直接建组（框内 ≥2 站即建，已在其他组的跳过）；也可点选站圈攒待编组后点「编组」；中键拖动平移。',
  };
  for (const btn of document.querySelectorAll('#toolbar [data-mode]')) {
    btn.addEventListener('click', () => {
      S.mode = btn.dataset.mode;
      for (const b of document.querySelectorAll('#toolbar [data-mode]')) {
        b.classList.toggle('primary', b === btn);
      }
      setStatus(MODE_HINT[S.mode]);
      $('canvasHint').textContent = MODE_HINT[S.mode];
      S.pending = [];
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
    if (e.key === 'Escape') { S.selStop = null; S.pending = []; renderAll(); }
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

  /** 应用一份工作区数据集（整体替换语义；一次快照，撤销一次回退整批） */
  function applyWorkspace(lineFiles, groups, manifest, calib, label, writable) {
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
    S.groups = groups || { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    S.manifest = manifest || null;
    if (calib) takeCalibration(calib);
    S.arcs = new Map();
    if (!S.lines.has(S.activeLine)) S.activeLine = lineFiles.size ? [...lineFiles.keys()][0] : null;
    S.selStop = null; S.pending = [];
    syncCountersWithLoaded();
    renderAll();
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
    const lineFiles = new Map(); let groups = null, manifest = null, calib = null;
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
        } catch (e) { setStatus(`工作区 ${name} 解析失败，已跳过：${e.message}`, true); }
      }
    } catch (e) { setStatus(`读取工作区失败：${e.message}`, true); return; }
    if (lineFiles.size || groups || manifest) wsHandle = dir;
    applyWorkspace(lineFiles, groups, manifest, calib, dir.name, true);
  }

  // 降级：webkitdirectory 整目录读（只读——保存走下载）。按文件名归槽，非工作区文件一概忽略
  $('fileWsDir').addEventListener('change', async (e) => {
    const lineFiles = new Map(); let groups = null, manifest = null, calib = null;
    for (const f of [...e.target.files]) {
      const base = (f.webkitRelativePath || f.name).replace(/\\/g, '/').split('/').pop();
      try {
        if (/^l\d{4}\.json$/.test(base)) {
          const obj = JSON.parse(await f.text());
          if (isLineObj(obj)) lineFiles.set(obj.id, obj);
        } else if (base === 'manifest.json') { const o = JSON.parse(await f.text()); if (o.schema === 'fmt/manifest@1') manifest = o; }
        else if (base === 'groups.json') { const o = JSON.parse(await f.text()); if (o.schema === 'fmt/groups@1') groups = o; }
        else if (base === 'calibration.json') { const o = JSON.parse(await f.text()); if (o.schema === 'fmt/calibration@2') calib = o; }
      } catch (err) { /* 非 JSON/坏文件跳过 */ }
    }
    e.target.value = '';
    applyWorkspace(lineFiles, groups, manifest, calib, '目录读入', false);
  });

  /** 新建空工作区＝清空暂存与编号水位后刷新（原「重置」） */
  function resetAll() {
    if (!confirm('新建空工作区：将清空本地暂存（线路/组/导入记录）与线/组编号水位，测试数据不保留，页面随即刷新。\n确定继续？')) return;
    clearTimeout(lsTimer);                    // 防清空后 400ms 防抖又把暂存写回
    localStorage.removeItem(LS_KEY);           // 主暂存 shrail.editor.v1
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
          else if (obj.schema === 'fmt/stations-import@1') {
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
  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /** 工作区直写：线路＋groups＋manifest 成套写入目录（多余线路文件删除并列出）。
   *  只碰 lines/ 子目录与 groups.json/manifest.json 三个自家产物——calibration 等其他文件一概不动。 */
  async function writeJson(dirHandle, name, obj) {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(obj, null, 2));
    await w.close();
  }

  async function saveWorkspaceToHandle(dir) {
    setStatus(`正在保存工作区（${dir.name}）…`);
    const lines = [...S.lines.values()];
    const linesDir = await dir.getDirectoryHandle('lines', { create: true });
    let ok = 0, fail = 0;
    for (const l of lines) {
      const issues = lineIssues(l);
      if (issues.length) { fail++; setStatus(`保存失败 ${l.id}：${issues.join('；')}`, true); continue; }
      try { await writeJson(linesDir, `${l.id}.json`, l); ok++; }
      catch (e) { fail++; setStatus(`写入失败 ${l.id}.json：${e.message}`, true); }
    }
    if (!S.groups) S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    await writeJson(dir, 'groups.json', S.groups);
    await writeJson(dir, 'manifest.json', buildManifest());
    // 同步语义：lines/ 里已不在当前数据的线路文件删除（只认 lNNNN.json 命名，其余文件不动）
    const ids = new Set(lines.map((l) => l.id));
    const removed = [];
    for await (const [name, handle] of linesDir.entries()) {
      const m = /^(l\d{4})\.json$/.exec(name);
      if (m && handle.kind === 'file' && !ids.has(m[1])) { await linesDir.removeEntry(name); removed.push(name); }
    }
    setStatus(`工作区已保存到 ${dir.name}/：线路 ${ok} 条＋groups.json＋manifest.json`
      + (fail ? `；${fail} 条未过检查或写入失败（见上）` : '')
      + (removed.length ? `；已删除多余线路文件 ${removed.join('、')}` : '。'));
  }

  $('btnSaveWorkspace').onclick = async () => {
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
    const archivedIds = new Set(S.manifest ? S.manifest.archived || [] : []);
    for (const l of S.lines.values()) if (l.meta.archived) archivedIds.add(l.id);
    S.manifest = {
      schema: 'fmt/manifest@1',
      dataset: (S.manifest && S.manifest.dataset) || 'main',
      version: (S.manifest && S.manifest.version) || '0.1.0',
      updated: today(),
      lines: active.map((l) => ({ id: l.id, file: `lines/${l.id}.json`, name: l.name, stops: l.stops.length })),
      archived: [...archivedIds].sort(),
    };
    return S.manifest;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 降级保存＝线路＋groups＋manifest 一并下载（目录直写不可用时；水位恢复依赖 manifest，务必成套）；
  // 逐个隔 150ms 发出降低浏览器多下载拦截概率，结束对账计数
  async function saveWorkspaceDownload() {
    const lines = [...S.lines.values()];
    const total = lines.length + 2;
    let ok = 0, fail = 0, n = 0;
    for (const l of lines) {
      const issues = lineIssues(l);
      if (issues.length) { fail++; setStatus(`保存失败 ${l.id}：${issues.join('；')}`, true); continue; }
      download(`${l.id}.json`, l); ok++; n++;
      setStatus(`保存工作区 ${n}/${total}：已请求 ${l.id}.json`);
      await sleep(150);
    }
    if (!S.groups) S.groups = { schema: 'fmt/groups@1', lineGroups: [], stationGroups: [] };
    download('groups.json', S.groups); n++;
    setStatus(`保存工作区 ${n}/${total}：已请求 groups.json`);
    await sleep(150);
    download('manifest.json', buildManifest()); n++;
    setStatus(`保存工作区完成（降级下载模式）：已请求 ${n}/${total} 个文件（线路 ${ok} 个`
      + (fail ? `＋未过检查 ${fail} 个（见上）` : '') + '＋groups＋manifest）→ 放入工作区/data/ 对应位置。'
      + '若浏览器询问「允许下载多个文件」请允许；中途取消可再点本按钮补齐。'
      + '（Chrome/Edge 可经「载入工作区」打开文件夹获得直写，免手动归档。）', !!fail);
  }

  // ---------- 启动 ----------
  window.addEventListener('resize', () => { applyView(); renderWorld(); });

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
  })();
})(typeof globalThis !== 'undefined' ? globalThis : this);
