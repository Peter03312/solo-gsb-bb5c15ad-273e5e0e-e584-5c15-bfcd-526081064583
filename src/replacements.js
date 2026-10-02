'use strict';

// 入展素材替代方案：预览（只读）与确认（事务内重验并改清单）
//
// 策展人为【待发布】包中至多 6 件入展素材分别指定 1～8 件现有替代素材；
// 未指定的素材保持不变。预览从每件原素材（原素材或其某个候选替代）中
// 恰选一件，按替换后的【去重】清单，沿用既有核验引擎重算完整来源链与
// 单站/多站逐站授权资格：
//   * 只有全部站点全部来源节点均合格的方案才可选；
//   * 先取替换件数最少者（替换件数 = 选中编号不是“原素材(0)”的原素材件数）；
//   * 再按最终去重清单（素材 id 升序）字典序；
//   * 仍并列时按原清单（id 升序）顺序的选中编号序列字典序。
// 整次请求任何一项不合法（重复编号、候选不是包内原素材、候选素材不存在、
// 条目/候选数量越界等）都整次拒绝，不做任何局部处理。
// 无解时返回【当前清单】的逐站缺口，不修改包。
// 确认时在同一事务内核对：包仍为待发布、依据版本/原清单指纹/行程指纹未变、
// 令牌与输入一致，并对最终清单重算；过期、输入不符或重算失格均整体拒绝。

const crypto = require('crypto');
const {
  isValidDate,
  scopeMatches,
  loadGraph,
  collectChains,
  basisVersion,
  loadStops,
  normalizeStop,
  stopFieldErrors,
  stopOverlapErrors,
  verifyStoredPackage,
} = require('./verify');

class ReplacementError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const str = (v) => (v === null || v === undefined ? '' : String(v));
const MAX_ENTRIES = 6;
const MIN_CANDIDATES = 1;
const MAX_CANDIDATES = 8;

// ---------- 行程载入与校验（单站 / 多站；与既有核验同一套规则） ----------
function loadItinerary(db, pkg) {
  const stopRows = loadStops(db, pkg.id);
  if (stopRows.length >= 2) {
    const stops = stopRows.map((s, i) => normalizeStop(
      { name: s.name, media: s.medium, region: s.region, useFrom: s.useFrom, useTo: s.useTo }, i));
    const fieldErrors = stops.flatMap((s) => stopFieldErrors(s));
    if (fieldErrors.length) {
      throw new ReplacementError(400, `包行程不合法，无法预览替代方案：${fieldErrors.join('；')}`,
        { code: 'INVALID_PACKAGE', errors: fieldErrors });
    }
    const overlapErrors = stopOverlapErrors(stops);
    if (overlapErrors.length) {
      throw new ReplacementError(409, overlapErrors.join('；'), { code: 'STOPS_OVERLAP', errors: overlapErrors });
    }
    return {
      multiStop: true,
      stops: stopRows.map((s, i) => ({
        position: i, name: s.name, medium: s.medium, region: s.region, useFrom: s.useFrom, useTo: s.useTo,
      })),
    };
  }

  const medium = str(pkg.medium).trim();
  const region = str(pkg.region).trim();
  const useFrom = pkg.use_from || '';
  const useTo = pkg.use_to || '';
  const errs = [];
  if (!medium) errs.push('包缺少展示媒介');
  if (!region) errs.push('包缺少展示地区');
  if (!isValidDate(useFrom)) errs.push(`包起始日期不合法：${useFrom || '（空）'}`);
  if (!isValidDate(useTo)) errs.push(`包截止日期不合法：${useTo || '（空）'}`);
  if (isValidDate(useFrom) && isValidDate(useTo) && useFrom > useTo) errs.push('包起止日期倒置');
  if (errs.length) {
    throw new ReplacementError(400, `包参数不合法，无法预览替代方案：${errs.join('；')}`,
      { code: 'INVALID_PACKAGE', errors: errs });
  }
  return {
    multiStop: false,
    stops: [{ position: 0, name: pkg.name, medium, region, useFrom, useTo }],
  };
}

// ---------- 输入校验：任何一项不合法都整次拒绝（逐行收集全部问题） ----------
function normalizeReplacements(rawReplacements, originals, existingIds) {
  const originalSet = new Set(originals);
  if (rawReplacements === undefined || rawReplacements === null) {
    throw new ReplacementError(400,
      '缺少替代指定 replacements（数组；每项为包内一件入展素材指定 1～8 件现有候选替代素材；无需替代时传 []）',
      { code: 'INVALID_REPLACEMENTS' });
  }
  if (!Array.isArray(rawReplacements)) {
    throw new ReplacementError(400, 'replacements 必须为数组', { code: 'INVALID_REPLACEMENTS' });
  }
  if (rawReplacements.length > MAX_ENTRIES) {
    throw new ReplacementError(400,
      `替代指定至多 ${MAX_ENTRIES} 项（当前 ${rawReplacements.length} 项）；未指定的入展素材保持不变`,
      { code: 'INVALID_REPLACEMENTS', maxEntries: MAX_ENTRIES });
  }

  const errors = [];
  const seenOriginals = new Set();
  const entries = rawReplacements.map((raw, index) => {
    const msgs = [];
    const e = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

    let materialId = Number(e.materialId ?? e.material_id ?? e.originalMaterialId);
    if (!Number.isInteger(materialId) || materialId <= 0) {
      msgs.push('materialId 缺失或不是正整数');
      materialId = null;
    } else {
      if (seenOriginals.has(materialId)) msgs.push(`原素材 #${materialId} 重复指定（编号不得重复）`);
      seenOriginals.add(materialId);
      if (!originalSet.has(materialId)) {
        msgs.push(`原素材 #${materialId} 不是该包当前清单中的入展素材（只能为包内原素材指定替代）`);
      }
    }

    let rawCandidates = e.candidateIds;
    if (rawCandidates === undefined || rawCandidates === null) rawCandidates = e.candidateMaterialIds;
    if (!Array.isArray(rawCandidates)) {
      msgs.push('candidateIds 缺失或不是数组（须指定 1～8 件现有替代素材的 id）');
      rawCandidates = [];
    } else if (rawCandidates.length < MIN_CANDIDATES) {
      msgs.push(`每件原素材至少指定 ${MIN_CANDIDATES} 件候选替代素材（当前 0 件）`);
    } else if (rawCandidates.length > MAX_CANDIDATES) {
      msgs.push(`每件原素材至多指定 ${MAX_CANDIDATES} 件候选替代素材（当前 ${rawCandidates.length} 件）`);
    }

    const candidates = [];
    const seenCand = new Set();
    for (const rc of rawCandidates.slice(0, MAX_CANDIDATES + 1)) {
      const cid = Number(rc);
      if (!Number.isInteger(cid) || cid <= 0) {
        msgs.push(`候选编号 ${JSON.stringify(rc)} 不是正整数`);
        continue;
      }
      if (!existingIds.has(cid)) msgs.push(`候选素材 #${cid} 不存在`);
      if (materialId !== null && cid === materialId) {
        msgs.push(`候选 #${cid} 与该项原素材相同（保持不变即编号 0，无需列为候选）`);
      }
      if (seenCand.has(cid)) {
        msgs.push(`候选 #${cid} 在同一项内重复（候选编号不得重复）`);
      } else {
        seenCand.add(cid);
        candidates.push(cid);
      }
    }

    if (msgs.length) errors.push({ index, materialId, messages: msgs });
    return { materialId, candidates };
  });

  if (errors.length) {
    throw new ReplacementError(400,
      `替代预览被拒绝：${errors.length} 项替代指定不合法（已逐项列出，整次请求未执行、未写入任何数据）`,
      { code: 'INVALID_REPLACEMENTS', errors });
  }
  // 原清单按 id 升序作为“原清单顺序”；每项的选择编号：0=原素材，1..k=候选（按提交顺序）
  entries.sort((a, b) => a.materialId - b.materialId);
  return entries.map((e, position) => ({ ...e, position }));
}

// ---------- 指纹（确认时在事务内逐项重验） ----------
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function hash(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

// 原清单指纹：入展素材 id 升序（去重）
function listFingerprint(materialIds) {
  return hash({ materialIds: [...new Set(materialIds)].map(Number).sort((a, b) => a - b) });
}

// 行程指纹：形态（单站/多站）+ 逐站名称/媒介/地区/起止日（顺序即展出顺序）
function itineraryFingerprint(itinerary) {
  return hash({
    multiStop: itinerary.multiStop,
    stops: itinerary.stops.map((s) => ({
      name: s.name, medium: s.medium, region: s.region, useFrom: s.useFrom, useTo: s.useTo,
    })),
  });
}

// ---------- 来源结构 + 逐站覆盖的快速判定（与 verify.js 同一套规则） ----------
// 对每个可能被选中的素材（原素材/候选）预算：
//   structurallyOk: 以它为入展根时来源链可完整核验（无环/未超深/未截断）
//   missingByStop:  在每一站【不被任何一份未撤销匹配授权独自覆盖】的闭包节点集合
function buildRootInfo(db, allRootIds, stops, matById, adj, authByMat) {
  const cache = new Map();
  for (const rootId of allRootIds) {
    if (cache.has(rootId)) continue;
    const chains = collectChains(adj, rootId);
    const nodeIds = [...chains.nodePaths.keys()].sort((a, b) => a - b);
    const structurallyOk =
      !chains.truncated && !chains.tooDeep && chains.cyclicNodes.size === 0;

    const missingByStop = stops.map((st) => {
      const missing = [];
      for (const id of nodeIds) {
        const rows = authByMat.get(id) || [];
        const covered = rows.some((a) => !a.revoked
          && scopeMatches(a.media, st.medium)
          && scopeMatches(a.region, st.region)
          && a.valid_from <= st.useFrom && a.valid_to >= st.useTo);
        if (!covered) missing.push(id);
      }
      return missing;
    });
    cache.set(rootId, { structurallyOk, missingByStop });
  }
  return cache;
}

function lexLessArrays(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return a.length < b.length;
}

// ---------- 枚举全部方案并按规则择优（先替换件数 → 最终清单 → 选中编号序列） ----------
function choosePlan(originalIds, entryFor, rootInfo, stopCount) {
  // 每件原素材的可选项：[原素材(编号0), 候选1(编号1), ...]
  const optionsAt = originalIds.map((id) => {
    const e = entryFor.get(id);
    return e ? [id, ...e.candidates] : [id];
  });

  let best = null;

  const consider = (selection) => {
    const selectedIds = selection.map((optIndex, pos) => optionsAt[pos][optIndex]);
    const allRootsOk = selectedIds.every((rid) => rootInfo.get(rid).structurallyOk);
    if (!allRootsOk) return;

    // 任一站闭包并集中存在未覆盖节点 → 方案失格
    const missingUnion = new Set();
    for (let s = 0; s < stopCount; s++) {
      for (const rid of selectedIds) {
        const m = rootInfo.get(rid).missingByStop[s];
        for (const id of m) missingUnion.add(id);
      }
      if (missingUnion.size) return;
    }

    const replacedCount = selection.reduce(
      (acc, opt, pos) => acc + (selectedIds[pos] !== originalIds[pos] ? 1 : 0), 0);
    const finalList = [...new Set(selectedIds)].sort((a, b) => a - b);

    if (!best
      || replacedCount < best.replacedCount
      || (replacedCount === best.replacedCount && lexLessArrays(finalList, best.finalList))
      || (replacedCount === best.replacedCount
        && finalList.length === best.finalList.length
        && finalList.every((v, i) => v === best.finalList[i])
        && lexLessArrays(selection, best.selection))) {
      best = { selection: selection.slice(), selectedIds, finalList, replacedCount };
    }
  };

  // DFS 枚举（上界 (1+8)^6 = 531441 个方案）
  const rec = (pos, sel) => {
    if (pos === optionsAt.length) { consider(sel); return; }
    for (let opt = 0; opt < optionsAt[pos].length; opt++) {
      sel.push(opt);
      rec(pos + 1, sel);
      sel.pop();
    }
  };
  rec(0, []);
  return best;
}

// ---------- 把核验结果归一为逐站视图（单站/多站统一） ----------
function stopViews(result, itinerary) {
  if (itinerary.multiStop) {
    return (result.stops || []).map((s) => ({
      position: s.position, name: s.name, medium: s.medium, region: s.region,
      useFrom: s.useFrom, useTo: s.useTo, eligible: !!s.eligible,
      nodeCount: s.stats ? s.stats.nodeCount : (s.nodes || []).length,
      failingNodes: s.failingNodes || [],
    }));
  }
  return [{
    position: 0,
    name: itinerary.stops[0].name,
    medium: itinerary.stops[0].medium,
    region: itinerary.stops[0].region,
    useFrom: itinerary.stops[0].useFrom,
    useTo: itinerary.stops[0].useTo,
    eligible: !!result.eligible,
    nodeCount: result.stats ? result.stats.nodeCount : (result.nodes || []).length,
    failingNodes: result.failingNodes || [],
  }];
}

function runVerify(db, pkg, finalList, itinerary) {
  const synthPkg = itinerary.multiStop
    ? pkg
    : {
      id: pkg.id,
      name: pkg.name,
      medium: itinerary.stops[0].medium,
      region: itinerary.stops[0].region,
      use_from: itinerary.stops[0].useFrom,
      use_to: itinerary.stops[0].useTo,
    };
  const stopsRows = itinerary.multiStop
    ? itinerary.stops.map((s) => ({
      position: s.position, name: s.name, medium: s.medium, region: s.region, useFrom: s.useFrom, useTo: s.useTo,
    }))
    : undefined;
  return verifyStoredPackage(db, synthPkg, finalList, stopsRows);
}

// ---------- 主入口：预览（只读） ----------
function previewReplacements(db, packageId, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};

  const out = db.transaction(() => {
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);
    if (!pkg) throw new ReplacementError(404, '展览包不存在');
    if (pkg.status !== 'draft') {
      throw new ReplacementError(409,
        `当前状态为 ${pkg.status}：替代素材预览/确认仅适用于待发布包；已发布/需复核包如需调整请使用「复制为待发布包」。`,
        { code: 'NOT_DRAFT', status: pkg.status });
    }

    const originals = db
      .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
      .all(packageId)
      .map((r) => r.material_id);
    if (originals.length === 0) {
      throw new ReplacementError(400, '空展览包：尚未选取任何入展素材，无法预览替代方案', { code: 'EMPTY_PACKAGE' });
    }

    const itinerary = loadItinerary(db, pkg);
    const entries = normalizeReplacements(body.replacements, originals,
      new Set(db.prepare('SELECT id FROM materials').all().map((m) => m.id)));
    const entryFor = new Map(entries.map((e) => [e.materialId, e]));

    const matRows = db.prepare('SELECT id, title, kind FROM materials').all();
    const matById = new Map(matRows.map((m) => [m.id, m]));
    const adj = loadGraph(db);
    const authByMat = new Map();
    for (const a of db.prepare('SELECT * FROM authorizations').all()) {
      if (!authByMat.has(a.material_id)) authByMat.set(a.material_id, []);
      authByMat.get(a.material_id).push(a);
    }

    const candidateIds = [...new Set(entries.flatMap((e) => e.candidates))];
    const allRootIds = [...new Set([...originals, ...candidateIds])];
    const rootInfo = buildRootInfo(db, allRootIds, itinerary.stops, matById, adj, authByMat);

    const best = choosePlan(originals, entryFor, rootInfo, itinerary.stops.length);

    // 当前清单（什么都不替换）的完整核验结果：无论有无解都要返回
    const currentResult = runVerify(db, pkg, originals, itinerary);

    const basis = basisVersion(db);
    const lfp = listFingerprint(originals);
    const ifp = itineraryFingerprint(itinerary);

    const base = {
      generatedAt: new Date().toISOString(),
      mutated: false,
      basisVersion: basis,
      rules: currentResult.rules,
      packageId: pkg.id,
      packageName: pkg.name,
      status: pkg.status,
      multiStop: itinerary.multiStop,
      stopCount: itinerary.stops.length,
      originalMaterialIds: originals,
      itinerary: itinerary.multiStop
        ? itinerary.stops.map((s) => ({
          position: s.position, name: s.name, medium: s.medium, region: s.region, useFrom: s.useFrom, useTo: s.useTo,
        }))
        : {
          name: itinerary.stops[0].name, medium: itinerary.stops[0].medium,
          region: itinerary.stops[0].region, useFrom: itinerary.stops[0].useFrom, useTo: itinerary.stops[0].useTo,
        },
      listFingerprint: lfp,
      itineraryFingerprint: ifp,
      requested: entries.map((e) => ({
        materialId: e.materialId,
        materialTitle: matById.get(e.materialId) ? matById.get(e.materialId).title : `#${e.materialId}`,
        candidates: e.candidates.map((cid, i) => ({
          option: i + 1,
          materialId: cid,
          materialTitle: matById.get(cid) ? matById.get(cid).title : `#${cid}`,
        })),
      })),
      stats: {
        originalCount: originals.length,
        specifiedCount: entries.length,
        candidateCount: candidateIds.length,
        enumeratedPlans: optionsCount(originals, entryFor),
      },
    };

    if (!best) {
      // 无解：返回当前清单的逐站缺口；不修改包
      return {
        ...base,
        feasible: false,
        replacedCount: null,
        finalMaterialIds: null,
        currentEligible: !!currentResult.eligible,
        replacementDetails: [],
        stops: stopViews(currentResult, itinerary),
        verify: currentResult,
        confirmToken: null,
        message: '不存在全站合格的替代方案：以下为【当前清单】的逐站缺口（预览未写入任何数据，包未被修改）。',
      };
    }

    // 中选方案：用既有核验引擎对最终清单做一次权威重算（必须合格）
    const finalResult = runVerify(db, pkg, best.finalList, itinerary);
    if (!finalResult.eligible) {
      // 防御性分支：快速判定与权威核验不一致时绝不放行
      throw new ReplacementError(422,
        '替代方案重算失格：最终清单在当前授权与来源关系下并非全站合格，已拒绝（请重新预览）。',
        { code: 'RECHECK_FAILED' });
    }

    const replacementDetails = originals.map((id, pos) => {
      const e = entryFor.get(id);
      const opt = best.selection[pos];
      const selectedId = best.selectedIds[pos];
      return {
        position: pos,
        originalMaterialId: id,
        originalTitle: matById.get(id) ? matById.get(id).title : `#${id}`,
        selectedOption: e ? opt : 0,
        selectedMaterialId: selectedId,
        selectedTitle: matById.get(selectedId) ? matById.get(selectedId).title : `#${selectedId}`,
        replaced: selectedId !== id,
        candidates: e
          ? e.candidates.map((cid, i) => ({
            option: i + 1,
            materialId: cid,
            materialTitle: matById.get(cid) ? matById.get(cid).title : `#${cid}`,
          }))
          : [],
      };
    });

    const confirmToken = {
      packageId: pkg.id,
      basisVersion: basis,
      listFingerprint: lfp,
      itineraryFingerprint: ifp,
      multiStop: itinerary.multiStop,
      originalMaterialIds: originals,
      entries: entries.map((e) => ({ materialId: e.materialId, candidates: e.candidates })),
      selection: best.selection,
      finalMaterialIds: best.finalList,
      replacedCount: best.replacedCount,
      rulesVersion: currentResult.rules.version,
    };

    return {
      ...base,
      feasible: true,
      replacedCount: best.replacedCount,
      finalMaterialIds: best.finalList,
      currentEligible: !!currentResult.eligible,
      replacementDetails,
      stops: stopViews(finalResult, itinerary),
      verify: finalResult,
      confirmToken,
      message: best.replacedCount === 0
        ? '当前清单已全站合格：最优方案为不替换任何素材（替换件数 0）。确认仍将按当前清单重算并应用（清单不变）。'
        : `最优方案替换 ${best.replacedCount} 件素材：最终去重清单 ${best.finalList.join(', ')}（已按替换件数最少、最终清单升序、选中编号序列择优）。`,
    };
  })();

  return out;
}

function optionsCount(originals, entryFor) {
  let n = 1;
  for (const id of originals) {
    const e = entryFor.get(id);
    n *= e ? (1 + e.candidates.length) : 1;
  }
  return n;
}

// ---------- 主入口：确认（事务内核版本/指纹/输入，重算并应用所选清单） ----------
function applyReplacements(db, packageId, rawBody) {
  const body = rawBody && typeof rawBody === 'object' ? rawBody : {};
  const token = body.confirmToken;
  if (!token || typeof token !== 'object') {
    throw new ReplacementError(400, '缺少确认令牌 confirmToken（原样回传预览返回的 confirmToken）',
      { code: 'TOKEN_REQUIRED' });
  }

  const out = db.transaction(() => {
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(packageId);
    if (!pkg) throw new ReplacementError(404, '展览包不存在');
    if (pkg.status !== 'draft') {
      throw new ReplacementError(409,
        `当前状态为 ${pkg.status}：只有待发布包可以确认替代方案`,
        { code: 'NOT_DRAFT', status: pkg.status });
    }

    // 1) 令牌须属于本包且结构完整
    if (!Number.isInteger(Number(token.packageId)) || Number(token.packageId) !== packageId) {
      throw new ReplacementError(409, '确认令牌与目标包不一致或已损坏，请重新预览', { code: 'TOKEN_MISMATCH' });
    }
    const clientBasis = Number(token.basisVersion);
    if (!Number.isInteger(clientBasis) || clientBasis < 0
      || typeof token.listFingerprint !== 'string' || typeof token.itineraryFingerprint !== 'string'
      || !Array.isArray(token.originalMaterialIds) || !Array.isArray(token.entries)
      || !Array.isArray(token.selection) || !Array.isArray(token.finalMaterialIds)) {
      throw new ReplacementError(409, '确认令牌内容不完整或已损坏，请重新预览', { code: 'TOKEN_MISMATCH' });
    }

    // 2) 依据版本未变（授权/来源关系无变更）
    const currentBasis = basisVersion(db);
    if (clientBasis !== currentBasis) {
      throw new ReplacementError(409,
        `预览后授权或来源关系已变更（依据版本 ${clientBasis} → ${currentBasis}），拒绝确认且不修改包，请重新预览。`,
        { code: 'STALE_BASIS', clientBasis, currentBasis });
    }

    // 3) 包仍为同一原清单（未被清空/编辑）
    const originals = db
      .prepare('SELECT material_id FROM package_items WHERE package_id=? ORDER BY position, material_id')
      .all(packageId)
      .map((r) => r.material_id);
    if (originals.length === 0) {
      throw new ReplacementError(409, '包清单已被清空，拒绝确认且不修改包，请重新编辑并预览', { code: 'PACKAGE_CHANGED' });
    }
    if (listFingerprint(originals) !== token.listFingerprint
      || listFingerprint(token.originalMaterialIds) !== token.listFingerprint) {
      throw new ReplacementError(409, '预览后包素材清单已变更，拒绝确认且不修改包，请重新预览',
        { code: 'PACKAGE_CHANGED' });
    }

    // 4) 行程未变（单站参数 / 多站站次）
    let itinerary;
    try {
      itinerary = loadItinerary(db, pkg);
    } catch (e) {
      if (e instanceof ReplacementError) {
        throw new ReplacementError(422, '预览后包行程已不再合法，拒绝确认且不修改包，请重新预览',
          { code: 'INPUT_MISMATCH', reason: e.details });
      }
      throw e;
    }
    if (itineraryFingerprint(itinerary) !== token.itineraryFingerprint
      || !!itinerary.multiStop !== !!token.multiStop) {
      throw new ReplacementError(409, '预览后包行程（单站参数或多站站次）已变更，拒绝确认且不修改包，请重新预览',
        { code: 'ITINERARY_CHANGED' });
    }

    // 5) 依据令牌中的原清单 + 候选表重建方案，输入必须与预览完全一致
    const existingIds = new Set(db.prepare('SELECT id FROM materials').all().map((m) => m.id));
    const originalSet = new Set(originals);
    const entryFor = new Map();
    for (const te of token.entries) {
      const mid = Number(te.materialId);
      const cands = Array.isArray(te.candidates) ? te.candidates.map(Number) : [];
      if (!Number.isInteger(mid) || mid <= 0 || !originalSet.has(mid)
        || cands.length < MIN_CANDIDATES || cands.length > MAX_CANDIDATES
        || cands.some((cid) => !Number.isInteger(cid) || cid <= 0 || !existingIds.has(cid) || cid === mid)
        || new Set(cands).size !== cands.length) {
        throw new ReplacementError(422, '确认输入与预览不一致：替代指定无法按当前数据重建，拒绝确认且不修改包',
          { code: 'INPUT_MISMATCH' });
      }
      if (entryFor.has(mid)) {
        throw new ReplacementError(422, '确认输入与预览不一致：原素材编号重复，拒绝确认', { code: 'INPUT_MISMATCH' });
      }
      entryFor.set(mid, cands);
    }

    const selection = token.selection.map(Number);
    if (selection.length !== originals.length
      || selection.some((o, pos) => {
        if (!Number.isInteger(o) || o < 0) return true;
        const cands = entryFor.get(originals[pos]);
        return o > (cands ? cands.length : 0);
      })) {
      throw new ReplacementError(422, '确认输入与预览不一致：选中编号序列越界或长度不符，拒绝确认且不修改包',
        { code: 'INPUT_MISMATCH' });
    }

    const selectedIds = originals.map((id, pos) => {
      const cands = entryFor.get(id);
      const opt = selection[pos];
      return opt === 0 ? id : cands[opt - 1];
    });
    const finalList = [...new Set(selectedIds)].sort((a, b) => a - b);
    const tokenFinal = token.finalMaterialIds.map(Number).sort((a, b) => a - b);
    if (finalList.length !== tokenFinal.length || finalList.some((v, i) => v !== tokenFinal[i])) {
      throw new ReplacementError(422, '确认输入与预览不一致：重建的最终清单与令牌不符，拒绝确认且不修改包',
        { code: 'INPUT_MISMATCH', finalList, tokenFinal: token.finalMaterialIds });
    }

    // 6) 对最终清单在当前数据下重算：必须仍全站合格，否则拒绝（不部分修改）
    const result = runVerify(db, pkg, finalList, itinerary);
    if (!result.eligible) {
      throw new ReplacementError(422,
        '替代方案重算失格：最终清单在当前授权与来源关系下并非全站合格，拒绝确认且不修改包，请重新预览。',
        { code: 'RECHECK_FAILED', result });
    }

    // 7) 全部通过：原子应用最终去重清单（仅替换 package_items；不动行程/状态/快照/依据版本）
    db.prepare('DELETE FROM package_items WHERE package_id=?').run(packageId);
    const ins = db.prepare('INSERT INTO package_items(package_id, material_id, position) VALUES (?,?,?)');
    finalList.forEach((mid, i) => ins.run(packageId, mid, i));
    db.prepare('UPDATE packages SET updated_at=? WHERE id=?').run(new Date().toISOString(), packageId);

    return {
      packageId,
      finalMaterialIds: finalList,
      replacedCount: selection.reduce((acc, opt, pos) => acc + (selectedIds[pos] !== originals[pos] ? 1 : 0), 0),
      selection,
      basisVersion: currentBasis,
      listFingerprint: listFingerprint(finalList),
      itineraryFingerprint: token.itineraryFingerprint,
      verify: result,
      multiStop: itinerary.multiStop,
      stopCount: itinerary.stops.length,
      stops: stopViews(result, itinerary),
    };
  })();

  return out;
}

module.exports = {
  ReplacementError,
  previewReplacements,
  applyReplacements,
  listFingerprint,
  itineraryFingerprint,
  normalizeReplacements,
  choosePlan,
};
