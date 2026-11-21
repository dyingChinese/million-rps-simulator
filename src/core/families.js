/**
 * families.js — 家族谱系子系统
 *
 * 模块职责：
 *  1. 提供中文姓氏表与家族展示名（如「赵家」「赵家2支」）；
 *  2. 建号时随机分配创始家族（家族数量固定为 cfg.families.count，后代继承父系家族）；
 *  3. 快照时聚合存活个体的家族统计（财富/规模/代数 TopN）。
 *
 * 性能约定：
 *  - `aggregateFamilies` 只做一次 O(aliveCount) 遍历 + 对 ≤4096 个家族的小数组排序；
 *  - 累加器（Float64Array/Int32Array）预分配并缓存在 familySys 上，每次调用仅 fill(0)，
 *    绝不在快照路径上分配大数组；
 *  - TopN 输出对象数量很小（≤ 3 × cfg.performance.topFamilies），允许分配。
 *
 * @module families
 */

/**
 * 中文姓氏表（取自《百家姓》前 128 位，全部互不重复）。
 * 家族数超过本表长度时，用「X家2支」「X家3支」… 区分不同分支。
 * @readonly
 * @type {string[]}
 */
export const FAMILY_NAMES = [
  '赵', '钱', '孙', '李', '周', '吴', '郑', '王',
  '冯', '陈', '褚', '卫', '蒋', '沈', '韩', '杨',
  '朱', '秦', '尤', '许', '何', '吕', '施', '张',
  '孔', '曹', '严', '华', '金', '魏', '陶', '姜',
  '戚', '谢', '邹', '喻', '柏', '水', '窦', '章',
  '云', '苏', '潘', '葛', '奚', '范', '彭', '郎',
  '鲁', '韦', '昌', '马', '苗', '凤', '花', '方',
  '俞', '任', '袁', '柳', '酆', '鲍', '史', '唐',
  '费', '廉', '岑', '薛', '雷', '贺', '倪', '汤',
  '滕', '殷', '罗', '毕', '郝', '邬', '安', '常',
  '乐', '于', '时', '傅', '皮', '卞', '齐', '康',
  '伍', '余', '元', '卜', '顾', '孟', '平', '黄',
  '和', '穆', '萧', '尹', '姚', '邵', '湛', '汪',
  '祁', '毛', '禹', '狄', '米', '贝', '明', '臧',
  '计', '伏', '成', '戴', '谈', '宋', '茅', '庞',
  '熊', '纪', '舒', '屈', '项', '祝', '董', '梁',
];

/** 家族数量硬上限（与 config.js 的 families.count 钳制范围一致） */
const MAX_FAMILIES = 4096;

/**
 * 家族系统实例（每个模拟器一局一个）。
 * @typedef {object} FamilySystem
 * @property {number} count 家族总数
 * @property {string[]} founderNames 家族展示名（长度 = count）
 * @property {Float64Array} accWealth 每家族存活成员总资产（内部累加器，复用）
 * @property {Int32Array} accMembers 每家族存活成员数（内部累加器，复用）
 * @property {Int32Array} accMaxGen 每家族存活成员最高代数（内部累加器，复用）
 * @property {Int32Array} _idx 家族下标工作区（内部排序用，复用）
 */

/**
 * 创建家族系统：生成 count 个家族的展示名并预分配聚合累加器。
 *
 * @param {object} cfg 归一化配置（createConfig 结果）
 * @returns {FamilySystem} 家族系统实例
 */
export function createFamilySystem(cfg) {
  const rawCount = Math.round(cfg.families.count);
  const count = Math.max(1, Math.min(MAX_FAMILIES, Number.isFinite(rawCount) ? rawCount : 1));
  const nameCount = FAMILY_NAMES.length;
  const founderNames = new Array(count);
  for (let i = 0; i < count; i++) {
    const branch = (i / nameCount) | 0;
    founderNames[i] =
      branch === 0 ? `${FAMILY_NAMES[i]}家` : `${FAMILY_NAMES[i % nameCount]}家${branch + 1}支`;
  }
  return {
    count,
    founderNames,
    accWealth: new Float64Array(count),
    accMembers: new Int32Array(count),
    accMaxGen: new Int32Array(count),
    _idx: new Int32Array(count),
  };
}

/**
 * 为创始个体随机分配一个家族 ID（0..count-1）。
 *
 * @param {FamilySystem} familySys 家族系统
 * @param {import('./rng.js').Rng} rng 随机源
 * @returns {number} 家族 ID
 */
export function familyForFounder(familySys, rng) {
  return rng.int(familySys.count);
}

/**
 * 家族展示名；非法家族 ID 回退为「未知家族」。
 *
 * @param {FamilySystem} familySys 家族系统
 * @param {number} familyId 家族 ID
 * @returns {string} 展示名，如「赵家」
 */
export function familyName(familySys, familyId) {
  if (familyId < 0 || familyId >= familySys.count || familyId !== (familyId | 0)) return '未知家族';
  return familySys.founderNames[familyId];
}

/**
 * 聚合存活个体的家族统计（快照时调用，O(aliveCount)）。
 *
 * 输出：
 *  - topWealth：按家族总资产降序，元素 {id,name,wealth,members,avgWealth,generation}；
 *  - topSize：按家族存活人数降序，元素 {id,name,wealth,members}；
 *  - topGeneration：按家族最高代数降序，元素 {id,name,generation,members}；
 *  - 三个列表长度均 ≤ cfg.performance.topFamilies，且只包含有存活成员的家族；
 *  - familyCount = 家族总数（配置值）；totalMembers = 本次统计到的存活成员数。
 *
 * @param {import('./store.js').AgentStore} store 智能体容器
 * @param {FamilySystem} familySys 家族系统
 * @param {Int32Array|ArrayLike<number>} aliveList 存活 slot 表（store.aliveList）
 * @param {number} aliveCount 存活数量
 * @param {object} cfg 归一化配置
 * @returns {{
 *   topWealth: Array<{id:number,name:string,wealth:number,members:number,avgWealth:number,generation:number}>,
 *   topSize: Array<{id:number,name:string,wealth:number,members:number}>,
 *   topGeneration: Array<{id:number,name:string,generation:number,members:number}>,
 *   familyCount: number,
 *   totalMembers: number
 * }} 家族统计结果
 */
export function aggregateFamilies(store, familySys, aliveList, aliveCount, cfg) {
  const count = familySys.count;
  const wealth = familySys.accWealth;
  const members = familySys.accMembers;
  const maxGen = familySys.accMaxGen;
  const idx = familySys._idx;
  wealth.fill(0);
  members.fill(0);
  maxGen.fill(0);

  const assets = store.assets;
  const familyId = store.familyId;
  const generation = store.generation;
  let totalMembers = 0;
  for (let i = 0; i < aliveCount; i++) {
    const s = aliveList[i];
    const f = familyId[s];
    if (f < 0 || f >= count) continue; // 非法家族 ID 防御（不应出现）
    wealth[f] += assets[s];
    members[f]++;
    const g = generation[s];
    if (g > maxGen[f]) maxGen[f] = g;
    totalMembers++;
  }

  // 压缩出「有存活成员的家族」下标集合（家族数 ≤ 4096，开销可忽略）
  let familyN = 0;
  for (let f = 0; f < count; f++) {
    if (members[f] > 0) idx[familyN++] = f;
  }

  const emptyResult = () => ({
    topWealth: [],
    topSize: [],
    topGeneration: [],
    familyCount: count,
    totalMembers,
  });
  if (familyN === 0) return emptyResult();

  const topN = Math.max(1, Math.min(cfg.performance.topFamilies | 0, familyN));
  const names = familySys.founderNames;
  // 只对前 familyN 个下标做原地排序（TypedArray 排序，小数组，代价可忽略）
  const view = idx.subarray(0, familyN);

  /** @type {Array<{id:number,name:string,wealth:number,members:number,avgWealth:number,generation:number}>} */
  const topWealth = new Array(topN);
  view.sort((a, b) => wealth[a] - wealth[b]);
  for (let k = 0; k < topN; k++) {
    const f = idx[familyN - 1 - k];
    const m = members[f];
    topWealth[k] = {
      id: f,
      name: names[f],
      wealth: wealth[f],
      members: m,
      avgWealth: m > 0 ? wealth[f] / m : 0,
      generation: maxGen[f],
    };
  }

  /** @type {Array<{id:number,name:string,wealth:number,members:number}>} */
  const topSize = new Array(topN);
  view.sort((a, b) => members[a] - members[b]);
  for (let k = 0; k < topN; k++) {
    const f = idx[familyN - 1 - k];
    topSize[k] = { id: f, name: names[f], wealth: wealth[f], members: members[f] };
  }

  /** @type {Array<{id:number,name:string,generation:number,members:number}>} */
  const topGeneration = new Array(topN);
  view.sort((a, b) => maxGen[a] - maxGen[b]);
  for (let k = 0; k < topN; k++) {
    const f = idx[familyN - 1 - k];
    topGeneration[k] = { id: f, name: names[f], generation: maxGen[f], members: members[f] };
  }

  return { topWealth, topSize, topGeneration, familyCount: count, totalMembers };
}
