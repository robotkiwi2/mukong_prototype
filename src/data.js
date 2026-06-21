// 데이터 로딩 + 엔티티 파생 + 장소 병합 + 입력 판정.
// 검증 스크립트에서 굴려본 로직(기획문서 §5.5, §6.2, §8)을 그대로 옮긴 것.

const DATA_DIR = "data/";

async function fetchJSON(name) {
  const res = await fetch(DATA_DIR + name + ".json");
  if (!res.ok) throw new Error(`${name}.json 로드 실패 (${res.status}). 로컬 서버로 실행했는지 확인하세요.`);
  return res.json();
}

const PLACE_FILES = ["place_chwiseonru_2f", "place_golmok"];
const SCENARIO_FILES = ["scenario_chwiseonru_drill", "scenario_golmok"];

// 공유 라이브러리 + 모든 장소/시나리오를 로드. place/scenario는 선택 시 채워짐.
export async function loadGameData() {
  const [basic, tech, weap, actors, player] = await Promise.all([
    fetchJSON("basic_actions"), fetchJSON("techniques"), fetchJSON("weapons"),
    fetchJSON("actors"), fetchJSON("player_default"),
  ]);
  const placeFiles = await Promise.all(PLACE_FILES.map(fetchJSON));
  const scenFiles = await Promise.all(SCENARIO_FILES.map(fetchJSON));
  const places = {};
  for (const pf of placeFiles) places[pf.place.id] = pf;   // id로 색인
  const scenarios = scenFiles.map(s => s.scenario);
  const scenarioById = {};
  for (const s of scenarios) scenarioById[s.id] = s;
  return {
    basicActions: basic.basicActions,
    techniques: tech.techniques,
    weapons: weap.weapons,
    classes: actors.classes,
    player: player.player,
    places, scenarios, scenarioById,
    place: null, scenario: null,   // 맵에서 선택 시 채워짐
  };
}

// ── 엔티티 파생: 클래스/프로필 + override → 해석된 인물 ──
export function deriveEntity(base, override = {}) {
  const lvl = override.level ?? base.level;
  const res = base.resources;
  const hp = res.base.hp + (lvl - 1) * res.perLevel.hp;
  const qi = res.base.qi + (lvl - 1) * res.perLevel.qi;
  return {
    name: override.name ?? base.name,
    faction: override.faction ?? base.faction,
    level: lvl,
    maxHp: hp, hp,
    maxQi: qi, qi,
    masteryProfile: override.masteryProfile ?? base.masteryProfile,
    loadout: override.loadout ?? base.loadout,
    weapon: override.weapon ?? base.weapon,
    move: override.move ?? base.move,
  };
}

// 특정 기본행위의 숙련도 = base + (level-1)*perLevel + 행위별 가감
export function masteryOf(entity, actionId) {
  const m = entity.masteryProfile;
  return m.base + (entity.level - 1) * m.perLevel + ((m.actions && m.actions[actionId]) || 0);
}

// 기본행위 실제 수치 = base × (1 + scale×숙련) × 병기보정
export function actionStats(entity, actionId, game) {
  const def = game.basicActions[actionId];
  if (!def) return null;
  const mst = masteryOf(entity, actionId);
  const out = {};
  for (const [k, v] of Object.entries(def.base)) {
    const scale = (def.masteryScale && def.masteryScale[k]) || 0;
    out[k] = v * (1 + scale * mst);
  }
  const wmods = game.weapons[entity.weapon]?.mods?.[actionId];
  if (wmods) for (const [k, mul] of Object.entries(wmods)) if (out[k] != null) out[k] *= mul;
  out._mastery = mst;
  return out;
}

// ── 장소 병합: base(stage) → variant → override ──
function applyPatch(stage, patch) {
  if (!patch) return stage;
  for (const k of ["size", "lighting"]) if (patch[k]) stage[k] = { ...(stage[k] || {}), ...patch[k] };
  if (patch.obstacles) {
    const o = patch.obstacles;
    if (o.remove) stage.obstacles = stage.obstacles.filter(x => !o.remove.includes(x.id));
    if (o.modify) stage.obstacles = stage.obstacles.map(x => o.modify[x.id] ? { ...x, ...o.modify[x.id] } : x);
    if (o.add) stage.obstacles = [...stage.obstacles, ...o.add];
  }
  if (patch.terrain) {
    const t = patch.terrain;
    if (t.remove) stage.terrain = stage.terrain.filter(x => !t.remove.includes(x.id));
    if (t.add) stage.terrain = [...stage.terrain, ...t.add];
  }
  return stage;
}

export function mergePlace(placeFile, variantName, override) {
  let stage = JSON.parse(JSON.stringify(placeFile.stage));
  const v = variantName ? placeFile.variants?.[variantName] : null;
  stage = applyPatch(stage, v);
  stage = applyPatch(stage, override);
  return stage;
}

// ── 입력 판정(정확도 등급제, §4.2) ──
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

// typed를 방어 토큰 집합과 비교 → 최선의 등급. blockEff = 막기 효과(0~1).
export function judgeDefense(typed, tokens) {
  let best = { ratio: 0, token: null };
  for (const t of tokens) {
    const r = similarity(typed.trim(), t.input);
    if (r > best.ratio) best = { ratio: r, token: t };
  }
  const r = best.ratio;
  let grade, blockEff;
  if (r >= 0.95) { grade = "Perfect"; blockEff = 1.0; }
  else if (r >= 0.7) { grade = "Great"; blockEff = 0.7; }
  else if (r >= 0.45) { grade = "Good"; blockEff = 0.4; }
  else { grade = "빗나감"; blockEff = 0; }
  return { grade, blockEff, ratio: r, token: best.token };
}

// 플레이어가 즉흥 가능한 방어 기본행위 토큰 (category 방어 + 숙련>0)
export function defenseTokens(entity, game) {
  const out = [];
  for (const [id, def] of Object.entries(game.basicActions)) {
    if (def.category === "방어" && masteryOf(entity, id) > 0)
      out.push({ actionId: id, input: def.input, name: def.name });
  }
  return out;
}

// 플레이어가 즉흥 가능한 기본행위 토큰 (이동 + 방어 + 근접 공격). 원거리(장풍 등)는 프로토타입에서 제외.
export function playerTokens(entity, game) {
  const out = [];
  for (const [id, def] of Object.entries(game.basicActions)) {
    if (masteryOf(entity, id) <= 0) continue;
    const ranged = def.base.projectileSpeed != null;
    if (def.category === "공격" && ranged) continue;
    if (!["이동", "공격", "방어"].includes(def.category)) continue;
    out.push({ actionId: id, input: def.input, name: def.name, category: def.category, desc: def.desc, move: def.move });
  }
  return out;
}

// typed를 토큰 집합과 비교 → 등급(+최선 토큰). 등급별 효과는 호출부에서 결정.
export function judgeCommand(typed, tokens) {
  let best = { ratio: 0, token: null };
  for (const t of tokens) {
    const r = similarity(typed.trim(), t.input);
    if (r > best.ratio) best = { ratio: r, token: t };
  }
  const r = best.ratio;
  let grade;
  if (r >= 0.95) grade = "Perfect";
  else if (r >= 0.7) grade = "Great";
  else if (r >= 0.45) grade = "Good";
  else grade = "빗나감";
  return { grade, ratio: r, token: best.token };
}
