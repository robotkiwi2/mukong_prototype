// 화면 상태 기계 + 부팅 배선.
// 타이틀 ⇄ 맵(추상 레이어) ⇄ 아레나(체화 레이어). 오버레이: 브리핑·결과·일시정지.

import { loadGameData } from "./data.js";
import { TypingInput } from "./input.js";
import { ArenaGame } from "./arena.js";
import { ensureAudio } from "./sound.js";

window.__mainLoaded = true; // 부팅 가드용: 모듈이 실제로 평가됐음을 표시

const $ = (s) => document.querySelector(s);
const screens = { title: $("#screen-title"), map: $("#screen-map"), arena: $("#screen-arena") };
const overlays = { briefing: $("#overlay-briefing"), result: $("#overlay-result"), pause: $("#overlay-pause") };

let GAME = null;     // 로드된 데이터
let arena = null;    // ArenaGame 인스턴스
let input = null;

function showScreen(name) {
  for (const k in screens) screens[k].classList.toggle("active", k === name);
}
function showOverlay(name) {
  for (const k in overlays) overlays[k].classList.toggle("show", k === name);
}

// HUD 갱신 콜백 모음 (arena가 호출)
const hud = {
  initCheat(tokens) {
    let html = "";
    for (const cat of ["이동", "공격", "방어"]) {
      const items = tokens.filter(t => t.category === cat);
      if (!items.length) continue;
      html += `<h4>${cat}</h4>`;
      for (const t of items)
        html += `<div class="cmd"><b>${t.input}</b><span class="cn">${t.name}</span><div class="cd">${t.desc || ""}</div></div>`;
    }
    $("#cmd-panel").innerHTML = html;
  },
  update(a) {
    $("#ht-timer").textContent = a.elapsed.toFixed(1);
    $("#ht-blocked").textContent = "적 " + a.enemies.length;
    $("#bar-hp").style.width = (a.player.hp / a.player.maxHp * 100) + "%";
    $("#bar-qi").style.width = (a.player.qi / a.player.maxQi * 100) + "%";
    $("#val-hp").textContent = Math.ceil(a.player.hp);
    $("#val-qi").textContent = Math.ceil(a.player.qi);
  },
};

// 맵에 시나리오 노드들을 깔고, 선택하면 GAME.scenario/place를 채운다
function buildMap() {
  const g = $("#map-graph");
  g.innerHTML = "";
  GAME.scenarios.forEach((s, i) => {
    const el = document.createElement("span");
    el.className = "node";
    el.dataset.scenario = s.id;
    el.textContent = GAME.places[s.arena.place].place.name;
    el.style.left = (20 + i * 24) + "%";
    el.style.top = (38 + (i % 2) * 22) + "%";
    g.appendChild(el);
  });
}

function selectScenario(id) {
  GAME.scenario = GAME.scenarioById[id];
  GAME.place = GAME.places[GAME.scenario.arena.place];
  document.querySelectorAll("#map-graph .node")
    .forEach(n => n.classList.toggle("current", n.dataset.scenario === id));
  $("#map-name").textContent = `${GAME.place.place.name} — "${GAME.scenario.title}"`;
  $("#map-syn").textContent = GAME.scenario.synopsis;
  const s = GAME.scenario.setting;
  $("#map-setting").textContent = s ? `${s.season} · ${s.timeOfDay} (${s.weather})` : "";
}

// 아레나 진입 → 브리핑부터
function enterArena() {
  showScreen("arena");
  const sc = GAME.scenario;
  // 상단/브리핑 텍스트
  $("#ht-place").textContent = GAME.place.place.name;
  $("#ht-mode").textContent = sc.initialState.mode;
  $("#ht-objective").textContent = "목표: 적 제압";
  const s = sc.setting;
  $("#ht-setting").textContent = `${s.season} · ${s.timeOfDay} · ${s.weather}`;
  $("#brief-title").textContent = sc.title;
  $("#brief-synopsis").textContent = sc.synopsis;
  $("#brief-objective").textContent = sc.objective;
  $("#brief-controls").textContent = sc.controlsHint || "";

  arena = new ArenaGame($("#arena"), GAME, input, hud, onArenaEnd);
  arena.start();
  showOverlay("briefing");
}

function beginPlay() {
  ensureAudio();          // 사용자 제스처 시점에 오디오 깨우기
  showOverlay(null);
  arena.begin();
}

function onArenaEnd(result) {
  const t = $("#result-title");
  t.textContent = result.title;
  t.className = result.id === "lose" ? "lose" : result.id === "win" ? "win" : "";
  $("#result-text").textContent = result.text;
  $("#result-stat").textContent = `막은 횟수 ${result.blocked} / 발사 ${result.shots}`;
  showOverlay("result");
}

function retry() { showOverlay(null); arena.stop(); arena.start(); showOverlay("briefing"); }
function quitToTitle() { if (arena) arena.stop(); arena = null; showOverlay(null); showScreen("title"); }
function pause() { if (arena && arena.state === "playing") { arena.state = "paused"; input.disable(); showOverlay("pause"); } }
function resume() { if (arena && arena.state === "paused") { arena.state = "playing"; arena.last = performance.now(); input.enable(); showOverlay(null); } }

// ── 이벤트 배선 ──
document.addEventListener("click", (e) => {
  const node = e.target.closest("[data-scenario]");
  if (node) { selectScenario(node.dataset.scenario); return; }
  const a = e.target.closest("[data-action]")?.dataset.action;
  if (!a) return;
  ({
    "to-map": () => showScreen("map"),
    "to-title": quitToTitle,
    "enter-arena": enterArena,
    "begin": beginPlay,
    "retry": retry,
    "quit": quitToTitle,
    "pause": pause,
    "resume": resume,
    "open-settings": () => alert("설정: 판정 시점(commit/스트리밍)·시간 둔화 등 — 추후"),
  })[a]?.();
});

// 브리핑에서 Enter로 시작 / ESC로 일시정지·재개
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && overlays.briefing.classList.contains("show")) { e.preventDefault(); beginPlay(); }
  if (e.key === "Escape" && screens.arena.classList.contains("active")) {
    if (arena?.state === "playing") pause();
    else if (arena?.state === "paused") resume();
  }
});

// 캔버스 클릭 시 입력 재포커스 (IME 캡처 유지)
$("#arena").addEventListener("click", () => input.refocus());

// 부팅
(async function boot() {
  input = new TypingInput($("#hidden-input"), () => {});
  try {
    GAME = await loadGameData();
    buildMap();
    selectScenario(GAME.scenarios[0].id);
  } catch (err) {
    document.body.innerHTML = `<div style="color:#e8dcc2;padding:40px;font-family:sans-serif">
      <h2>데이터 로드 실패</h2><p>${err.message}</p>
      <p style="color:#9b8e74">브라우저는 file://에서 로컬 JSON을 막습니다.<br>
      폴더에서 <code>python -m http.server</code> 실행 후 <code>localhost:8000</code> 으로 여세요.</p></div>`;
    console.error(err);
  }
})();
