// 아레나 모드 — 실시간 난전. 모든 행위가 타이핑.
// 월드 = 중심 원점 직교(+x 우, +y 앞). 렌더 시 캔버스에 맞게 축소(fit) + y 반전.
// 적 AI: 교전 디렉터(한 번에 하나씩) + 접근→간보기→텔레그래프→공격→회복 리듬 (§6 긴장은 타이밍에서).

import { deriveEntity, actionStats, mergePlace, judgeCommand, playerTokens } from "./data.js";
import { sfx } from "./sound.js";

const DASH_SPEED = 320, ENEMY_MELEE_SPEED = 92, ENEMY_RANGED_SPEED = 70, PLAYER_R = 14, FLASH = 0.18;
const MELEE_RANGE = 100;                                  // 이 거리(중심간) 안이면 근접공격 가능 + 근접 표시
const GRACE = 0.8, END_DELAY = 1.3;                       // 시작 유예 / 종료 텀
const STANDOFF_EXTRA = 70, ORBIT_SPEED = 48;              // 대기 시 거리·선회
const HOLD_MIN = 0.35, HOLD_JIT = 0.35, WINDUP = 0.5, RECOVER = 1.0, RANGED_CHARGE = 0.45;
const DIR_VEC = { "앞": [0, 1], "뒤": [0, -1], "좌": [-1, 0], "우": [1, 0] };
const BLOCK_EFF = { Perfect: 1.0, Great: 0.7, Good: 0.4, "빗나감": 0 };
const ATK_MUL = { Perfect: 1.0, Great: 0.85, Good: 0.6, "빗나감": 0 };

export class ArenaGame {
  constructor(canvas, game, input, hud, onEnd) {
    this.cv = canvas; this.ctx = canvas.getContext("2d");
    this.game = game; this.input = input; this.hud = hud; this.onEnd = onEnd;
    this.cx = canvas.width / 2; this.cy = canvas.height / 2; this._raf = null;
  }

  start() {
    const sc = this.game.scenario;
    this.stage = mergePlace(this.game.place, sc.arena.variant, sc.arena.placeOverride);
    const b = this.stage.bounds;
    this.scale = Math.min((this.cv.width - 40) / (2 * b.halfWidth), (this.cv.height - 40) / (2 * b.halfHeight), 1);
    this.toScreen = (x, y) => [this.cx + x * this.scale, this.cy - y * this.scale];

    this.player = deriveEntity(this.game.player);
    this.player.pos = { ...sc.player.start }; this.player.flashT = 0;
    this.tokens = playerTokens(this.player, this.game);

    this.enemies = sc.opponents.map((opp) => {
      const ent = deriveEntity(this.game.classes[opp.template]);
      const bh = opp.behavior;
      const e = { id: opp.id, ent, pos: { ...opp.spawn }, kind: bh.kind, flashT: 0, retreatT: 0,
        r: ent.maxHp > 120 ? 16 : 13, speed: (bh.kind === "ranged" ? ENEMY_RANGED_SPEED : ENEMY_MELEE_SPEED) * (ent.move?.speed || 1) };
      if (bh.kind === "melee") {
        const st = actionStats(ent, bh.attack, this.game);
        e.atkPower = st.power; e.reach = st.range + PLAYER_R + e.r;
        e.state = "circle"; e.windup = 0; e.holdT = 0; e.recoverT = 0; e.orbitDir = Math.random() < 0.5 ? 1 : -1;
      } else {
        const st = actionStats(ent, bh.fire, this.game);
        e.projSpeed = st.projectileSpeed; e.projPower = st.power;
        e.keepDist = bh.keepDist; e.interval = bh.intervalSec; e.jitter = bh.jitterSec || 0;
        e.fireT = 1.6; e.charging = false; e.chargeT = 0;
      }
      return e;
    });
    this.maxAggro = Math.max(1, Math.floor(this.enemies.filter(e => e.kind === "melee").length / 2));

    this.projectiles = []; this.popups = []; this.moveGoal = null; this.meleeTarget = null;
    this.elapsed = 0; this.graceT = 0; this.endT = 0; this.endInfo = null;
    this.state = "briefing"; this.last = performance.now();

    this.input.onCommit = (t) => this.handleCommit(t);
    this.hud.initCheat(this.tokens);
    this.loop();
  }

  begin() { if (this.state !== "briefing") return; this.state = "playing"; this.graceT = GRACE; this.last = performance.now(); this.input.enable(); }
  stop() { if (this._raf) cancelAnimationFrame(this._raf); this.input.disable(); }
  nearestEnemy() { const p = this.player.pos; let best = null, bd = Infinity; for (const e of this.enemies) { const d = Math.hypot(e.pos.x - p.x, e.pos.y - p.y); if (d < bd) { best = e; bd = d; } } return best; }

  resolve(pos, radius) {
    const b = this.stage.bounds;
    pos.x = Math.max(-b.halfWidth + radius, Math.min(b.halfWidth - radius, pos.x));
    pos.y = Math.max(-b.halfHeight + radius, Math.min(b.halfHeight - radius, pos.y));
    for (const o of this.stage.obstacles) {
      if (!o.blocks?.movement) continue;
      const min = o.size / 2 + radius, dx = pos.x - o.pos.x, dy = pos.y - o.pos.y, d = Math.hypot(dx, dy);
      if (d < min && d > 0.01) { pos.x = o.pos.x + dx / d * min; pos.y = o.pos.y + dy / d * min; }
    }
  }

  loop() {
    this._raf = requestAnimationFrame(() => this.loop());
    const now = performance.now(); let dt = (now - this.last) / 1000; this.last = now;
    if (dt > 0.1) dt = 0.1;
    if (this.state === "playing") this.update(dt);
    else if (this.state === "ending") {                  // 종료 텀: 잔상 보여주고 결과창은 뒤늦게
      this.endT -= dt;
      for (const u of this.popups) u.t -= dt; this.popups = this.popups.filter((u) => u.t > 0);
      if (this.endT <= 0) { this.state = "result"; this.onEnd(this.endInfo); }
    }
    this.render();
  }

  // 교전 디렉터: 동시에 덤비는 근접 적 수를 maxAggro로 제한
  director() {
    const busy = (e) => ["advance", "hold", "windup", "recover"].includes(e.state);
    let slots = this.maxAggro - this.enemies.filter(e => e.kind === "melee" && busy(e)).length;
    if (slots <= 0) return;
    const p = this.player.pos;
    const cand = this.enemies.filter(e => e.kind === "melee" && e.state === "circle" && e.retreatT <= 0)
      .sort((a, b) => Math.hypot(a.pos.x - p.x, a.pos.y - p.y) - Math.hypot(b.pos.x - p.x, b.pos.y - p.y));
    for (const e of cand) { if (slots <= 0) break; e.state = "advance"; slots--; }
  }

  update(dt) {
    this.elapsed += dt;
    const p = this.player.pos;

    if (this.moveGoal) {
      const step = Math.min(DASH_SPEED * dt, this.moveGoal.remaining);
      p.x += this.moveGoal.dx * step; p.y += this.moveGoal.dy * step;
      this.moveGoal.remaining -= step; this.resolve(p, PLAYER_R);
      if (this.moveGoal.remaining <= 0) this.moveGoal = null;
    }

    if (this.graceT > 0) this.graceT -= dt;
    else { this.director(); for (const e of this.enemies) this.enemyAI(e, dt, p); }

    if (this.player.flashT > 0) this.player.flashT -= dt;

    for (const pr of this.projectiles) {
      pr.x += pr.vx * dt; pr.y += pr.vy * dt; pr.dist = Math.hypot(pr.x - pr.tx, pr.y - pr.ty);
      if (!pr.dead && Math.hypot(pr.x - p.x, pr.y - p.y) < 16) { pr.dead = true; this.player.hp -= pr.power; sfx.hit(); this.popupAt(p.x, p.y, "피격!", "#b03030"); }
      if (pr.dist < 4) pr.dead = true;
    }
    this.projectiles = this.projectiles.filter((pr) => !pr.dead);
    for (const u of this.popups) u.t -= dt; this.popups = this.popups.filter((u) => u.t > 0);

    // 근접 사거리 안의 가장 가까운 적 = 공격 대상(표시용)
    this.meleeTarget = null;
    { let bd = MELEE_RANGE; const pp = this.player.pos; for (const e of this.enemies) { const d = Math.hypot(e.pos.x - pp.x, e.pos.y - pp.y); if (d <= bd) { bd = d; this.meleeTarget = e; } } }

    if (this.enemies.length === 0) return this.finish("win");
    if (this.player.hp <= 0) { this.player.hp = 0; return this.finish("lose"); }
    if (this.elapsed >= 90) return this.finish("timeout");
    this.hud.update(this);
  }

  enemyAI(e, dt, p) {
    const dx = p.x - e.pos.x, dy = p.y - e.pos.y, dist = Math.hypot(dx, dy) || 1;
    if (e.flashT > 0) e.flashT -= dt;

    if (e.retreatT > 0) {                                 // 피격 후 물러남
      e.retreatT -= dt;
      e.pos.x -= dx / dist * e.speed * 1.1 * dt; e.pos.y -= dy / dist * e.speed * 1.1 * dt; this.resolve(e.pos, e.r);
      return;
    }

    if (e.kind === "ranged") {
      if (dist < e.keepDist - 30) { e.pos.x -= dx / dist * e.speed * dt; e.pos.y -= dy / dist * e.speed * dt; this.resolve(e.pos, e.r); }
      else if (dist > e.keepDist + 60) { e.pos.x += dx / dist * e.speed * 0.6 * dt; e.pos.y += dy / dist * e.speed * 0.6 * dt; this.resolve(e.pos, e.r); }
      if (e.charging) {
        e.chargeT -= dt;
        if (e.chargeT <= 0) { this.fire(e); e.flashT = FLASH; sfx.enemy(); e.charging = false; e.fireT = e.interval + (Math.random() * 2 - 1) * e.jitter; }
      } else { e.fireT -= dt; if (e.fireT <= 0) { e.charging = true; e.chargeT = RANGED_CHARGE; this.popupAt(e.pos.x, e.pos.y, "장풍!", "#e07030"); } }
      return;
    }

    // 근접 상태머신
    const standoff = e.reach + STANDOFF_EXTRA;
    switch (e.state) {
      case "circle":                                      // 대기: 거리 유지하며 선회(포위)
        if (dist > standoff + 12) { e.pos.x += dx / dist * e.speed * 0.55 * dt; e.pos.y += dy / dist * e.speed * 0.55 * dt; }
        else if (dist < standoff - 12) { e.pos.x -= dx / dist * e.speed * 0.7 * dt; e.pos.y -= dy / dist * e.speed * 0.7 * dt; }
        else { e.pos.x += (-dy / dist) * ORBIT_SPEED * e.orbitDir * dt; e.pos.y += (dx / dist) * ORBIT_SPEED * e.orbitDir * dt; }
        this.resolve(e.pos, e.r); break;
      case "advance":                                     // 교전 허가됨: 사거리까지 진입
        if (dist > e.reach - 4) { e.pos.x += dx / dist * e.speed * dt; e.pos.y += dy / dist * e.speed * dt; this.resolve(e.pos, e.r); }
        else { e.state = "hold"; e.holdT = HOLD_MIN + Math.random() * HOLD_JIT; }
        break;
      case "hold":                                        // 간보기(멈칫)
        e.holdT -= dt;
        if (dist > e.reach + 30) e.state = "advance";     // 놓치면 다시 접근
        else if (e.holdT <= 0) { e.state = "windup"; e.windup = WINDUP; this.popupAt(e.pos.x, e.pos.y, "!", "#e0a030"); }
        break;
      case "windup":                                      // 텔레그래프
        e.windup -= dt;
        if (e.windup <= 0) {
          e.flashT = FLASH; sfx.enemy();
          if (dist <= e.reach + 12) { this.player.hp -= e.atkPower; sfx.hit(); this.popupAt(p.x, p.y, `적 일격! -${e.atkPower.toFixed(0)}`, "#b03030"); }
          else this.popupAt(e.pos.x, e.pos.y, "헛침", "#9b8e74");
          e.state = "recover"; e.recoverT = RECOVER;
        }
        break;
      case "recover":                                     // 회복(무방비 빈틈 = 반격 창)
        e.recoverT -= dt;
        e.pos.x -= dx / dist * e.speed * 0.3 * dt; e.pos.y -= dy / dist * e.speed * 0.3 * dt; this.resolve(e.pos, e.r);
        if (e.recoverT <= 0) e.state = "circle";
        break;
    }
  }

  fire(e) {
    const a = e.pos, t = this.player.pos, d = Math.hypot(t.x - a.x, t.y - a.y) || 1;
    this.projectiles.push({ x: a.x, y: a.y, tx: t.x, ty: t.y, vx: (t.x - a.x) / d * e.projSpeed, vy: (t.y - a.y) / d * e.projSpeed, power: e.projPower, dist: d, dead: false });
  }

  handleCommit(text) {
    if (this.state !== "playing") return;
    const r = judgeCommand(text, this.tokens);
    if (r.grade === "빗나감" || !r.token) { this.popup(`${text} — 빗나감`, "#9b8e74"); sfx.miss(); return; }
    const def = this.game.basicActions[r.token.actionId];
    this.player.flashT = FLASH;
    if (def.category === "이동") { sfx.move(); this.startMove(def.move, r.token.name); return; }
    if (def.category === "방어") { sfx.defense(); if (def.move) this.startMove(def.move, null); this.doDefense(r); return; }
    sfx.attack(); this.doMelee(r);
  }

  startMove(move, label) {
    if (!move) return;
    const p = this.player.pos; let dx, dy, remaining = move.dist;
    if (move.dir) { const v = DIR_VEC[move.dir]; dx = v[0]; dy = v[1]; }
    else {
      const e = this.nearestEnemy();
      if (!e) { if (label) this.popup(`${label} — 대상 없음`, "#9b8e74"); return; }
      const ddx = e.pos.x - p.x, ddy = e.pos.y - p.y, d = Math.hypot(ddx, ddy) || 1;
      if (move.toward === "away") { dx = -ddx / d; dy = -ddy / d; }
      else {
        // 접근: 나와 가장 가까운 적을 잇는 선을 따라 코앞(근접 거리)까지만 이동 — 적의 정해진 위치가 아님
        dx = ddx / d; dy = ddy / d;
        remaining = Math.max(8, d - (PLAYER_R + e.r + 30));
      }
    }
    this.moveGoal = { dx, dy, remaining };
    if (label) this.popup(label, "#9bbfe0");
  }

  doDefense(r) {
    let tgt = null;
    for (const pr of this.projectiles) if (!pr.dead && (!tgt || pr.dist < tgt.dist)) tgt = pr;
    if (!tgt) { this.popup("헛손질", "#9b8e74"); return; }
    tgt.dead = true;
    const leak = tgt.power * (1 - BLOCK_EFF[r.grade]);
    if (leak > 0) this.player.hp -= leak;
    const c = r.grade === "Perfect" ? "#c9a44a" : r.grade === "Great" ? "#5a8f5a" : "#9b8e74";
    this.popup(`막음! ${r.grade}${leak > 0 ? ` (-${leak.toFixed(0)})` : ""}`, c);
  }

  doMelee(r) {
    const st = actionStats(this.player, r.token.actionId, this.game), p = this.player.pos;
    let best = null, bd = Infinity;
    for (const e of this.enemies) { const d = Math.hypot(e.pos.x - p.x, e.pos.y - p.y); if (d <= MELEE_RANGE && d < bd) { best = e; bd = d; } }
    if (!best) { this.popup(`${r.token.name} — 허공 (적이 멀다)`, "#9b8e74"); return; }
    best.flashT = FLASH;
    let dmg = st.power * ATK_MUL[r.grade];
    if (best.state === "recover" || best.state === "windup") dmg *= 1.3;   // 빈틈 반격 보너스
    best.ent.hp -= dmg;
    if (best.ent.hp <= 0) { this.enemies = this.enemies.filter((e) => e !== best); sfx.down(); this.popupAt(best.pos.x, best.pos.y, "쓰러짐!", "#c9a44a"); return; }
    const low = best.ent.hp / best.ent.maxHp < 0.35;
    best.retreatT = low ? 1.1 : 0.5;
    if (best.kind === "melee") { best.state = "circle"; best.windup = 0; best.holdT = 0; best.recoverT = 0; }
    else best.charging = false;
    this.popupAt(best.pos.x, best.pos.y, `${r.grade} -${dmg.toFixed(0)}${low ? " · 도망!" : ""}`, "#e8dcc2");
  }

  popup(text, color) { const p = this.player.pos; this.popupAt(p.x, p.y, text, color); }
  popupAt(wx, wy, text, color) { const [sx, sy] = this.toScreen(wx, wy); this.popups.push({ text, color, x: sx, y: sy - 30, t: 0.9 }); }

  finish(id) {
    this.state = "ending"; this.endT = END_DELAY; this.input.disable();
    const cond = this.game.scenario.endConditions.find((c) => c.id === id);
    this.endInfo = { id, title: cond.title, text: cond.text, left: this.enemies.length };
  }

  flashRing(sx, sy, sr, t) {
    if (t <= 0) return;
    this.ctx.globalAlpha = Math.min(1, t / FLASH); this.ctx.strokeStyle = "#fff"; this.ctx.lineWidth = 3;
    this.ctx.beginPath(); this.ctx.arc(sx, sy, sr + 5, 0, 7); this.ctx.stroke();
    this.ctx.globalAlpha = 1; this.ctx.lineWidth = 1;
  }

  render() {
    const ctx = this.ctx, S = this.toScreen, k = this.scale;
    ctx.clearRect(0, 0, this.cv.width, this.cv.height); ctx.textAlign = "center";
    const pPos = this.player.pos, [ppx, ppy] = S(pPos.x, pPos.y);

    const sight = this.stage.lighting?.sight ?? 1, b = this.stage.bounds;
    const [bx, by] = S(-b.halfWidth, b.halfHeight);
    ctx.fillStyle = `rgba(30,24,16,${0.4 + 0.5 * sight})`; ctx.fillRect(bx, by, b.halfWidth * 2 * k, b.halfHeight * 2 * k);
    ctx.strokeStyle = "#3a3026"; ctx.strokeRect(bx, by, b.halfWidth * 2 * k, b.halfHeight * 2 * k);

    for (const t of this.stage.terrain) if (t.shape === "circle") { const [x, y] = S(t.cx, t.cy); ctx.fillStyle = "rgba(80,90,140,.18)"; ctx.beginPath(); ctx.arc(x, y, t.r * k, 0, 7); ctx.fill(); }
    ctx.font = "12px sans-serif"; ctx.fillStyle = "#6a5a3a";
    for (const e of this.stage.exits) { const [x, y] = S(e.pos.x, e.pos.y); ctx.fillText(e.type, x, y); }
    for (const o of this.stage.obstacles) {
      const [x, y] = S(o.pos.x, o.pos.y);
      ctx.fillStyle = o.kind === "기둥" ? "#4a3f30" : o.kind === "잔해" ? "#3a3530" : "#5a4a32";
      ctx.beginPath(); ctx.arc(x, y, o.size / 2 * k, 0, 7); ctx.fill();
      ctx.fillStyle = "#80735a"; ctx.fillText(o.kind, x, y + 3);
    }

    for (const e of this.enemies) {
      const [x, y] = S(e.pos.x, e.pos.y), er = e.r * k;
      if (e.state === "windup") { ctx.strokeStyle = "#e0a030"; ctx.beginPath(); ctx.arc(x, y, er + 6 + (WINDUP - e.windup) * 34, 0, 7); ctx.stroke(); }
      if (e.charging) { ctx.strokeStyle = "#e07030"; ctx.beginPath(); ctx.arc(x, y, er + 6 + (RANGED_CHARGE - e.chargeT) * 40, 0, 7); ctx.stroke(); }
      const vuln = e.state === "recover" || e.retreatT > 0;
      ctx.fillStyle = vuln ? "#8a6a4a" : e.kind === "ranged" ? "#7a6a9a" : "#a05030";
      ctx.beginPath(); ctx.arc(x, y, er, 0, 7); ctx.fill();
      this.flashRing(x, y, er, e.flashT);
      // 근접 표시: 사거리 안이면 금색 링, 공격 대상이면 더 진하게 + 연결선
      const dPl = Math.hypot(e.pos.x - pPos.x, e.pos.y - pPos.y);
      if (dPl <= MELEE_RANGE) {
        const isT = e === this.meleeTarget;
        if (isT) { ctx.strokeStyle = "rgba(201,164,74,.3)"; ctx.beginPath(); ctx.moveTo(ppx, ppy); ctx.lineTo(x, y); ctx.stroke(); }
        ctx.strokeStyle = isT ? "#c9a44a" : "rgba(201,164,74,.4)"; ctx.lineWidth = isT ? 2 : 1;
        ctx.beginPath(); ctx.arc(x, y, er + 7, 0, 7); ctx.stroke(); ctx.lineWidth = 1;
      }
      const tag = e.retreatT > 0 ? " (도망)" : e.state === "recover" ? " (빈틈)" : "";
      ctx.fillStyle = "#e8dcc2"; ctx.font = "11px sans-serif"; ctx.fillText(e.ent.name + tag, x, y - er - 8);
      const w = 30, hpr = Math.max(0, e.ent.hp / e.ent.maxHp);
      ctx.fillStyle = "#241e16"; ctx.fillRect(x - w / 2, y - er - 6, w, 3);
      ctx.fillStyle = "#b03030"; ctx.fillRect(x - w / 2, y - er - 6, w * hpr, 3);
    }

    for (const pr of this.projectiles) {
      const [x, y] = S(pr.x, pr.y), near = Math.max(0, 1 - pr.dist / 300);
      ctx.fillStyle = `rgba(${200 + 55 * near},${120 - 80 * near},60,.9)`;
      ctx.beginPath(); ctx.arc(x, y, (7 + 5 * near) * k, 0, 7); ctx.fill();
    }

    const [px, py] = S(this.player.pos.x, this.player.pos.y), pr = PLAYER_R * k;
    ctx.fillStyle = "#c9a44a"; ctx.beginPath(); ctx.arc(px, py, pr, 0, 7); ctx.fill();
    this.flashRing(px, py, pr, this.player.flashT);
    ctx.fillStyle = "#0d0b08"; ctx.font = "12px sans-serif"; ctx.fillText("나", px, py + 4);

    if (this.state === "playing") { ctx.font = "20px 'Noto Sans KR',sans-serif"; ctx.fillStyle = "#e8dcc2"; ctx.fillText(this.input.current + "▏", px, py + 30 + pr); }
    ctx.font = "15px 'Noto Sans KR',sans-serif";
    for (const u of this.popups) { ctx.globalAlpha = Math.min(1, u.t * 1.5); ctx.fillStyle = u.color; ctx.fillText(u.text, u.x, u.y - (0.9 - u.t) * 22); ctx.globalAlpha = 1; }
  }
}
