// hud.js – cg_draw.c's status bar from the game's own pictures: the ammo,
// health and armour counters in the 32×32 digits, the weapon and powerup
// icons, the frag counter, the pickup and centre messages in bigchars,
// the obituaries, the crosshair, and the scoreboard.

import { loadImage } from './image.js';
import { WEAPONS, AMMO_ICONS } from './gamedata.js';

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export class Hud {
  constructor(pak, renderer) {
    this.pak = pak;
    this.r = renderer;
    this.cache = new Map();
    this.font = this.pic('gfx/2d/bigchars');
    this.nums = DIGITS.map((n) => this.pic(`gfx/2d/numbers/${n}_32b`));
    this.minus = this.pic('gfx/2d/numbers/minus_32b');
    this.crosshair = this.pic('gfx/2d/crosshaira');
    this.lastScores = [];
  }

  pic(name) {
    let p = this.cache.get(name);
    if (p !== undefined) return p;
    p = null;
    const file = this.pak.imageName(name);
    if (file) { try { p = loadImage(this.pak.get(file), file); } catch { p = null; } }
    this.cache.set(name, p);
    return p;
  }

  /** CG_DrawField: a right-aligned number of up to `width` digits, `dh` pixels tall. */
  drawNum(x, y, num, width, dh, tint) {
    const r = this.r;
    let s = String(Math.max(-999, Math.min(999, Math.round(num))));
    if (s.length > width) s = s.slice(s.length - width);
    const dw = (dh * 2) / 3;
    x += dw * (width - s.length);
    for (const ch of s) {
      const p = ch === '-' ? this.minus : this.nums[Number(ch)];
      r.drawPic(p, x, y, dw, dh, tint);
      x += dw;
    }
  }

  /** hud: the Q3_TIC row; messages: the console lines. */
  draw(r, hud, time, messages = [], opts = {}) {
    const w = r.w, h = r.h;
    const k = w / 640;            // Q3 lays the HUD out on a 640×480 screen
    const dh = Math.round(48 * k), ih = Math.round(48 * k);
    const yb = h - Math.round(60 * k);
    if (hud.MATCH_OVER) {
      // the intermission (CG_DrawIntermission): the scoreboard, the console lines, and the way on
      this.drawScoreboard(hud, opts.scores ?? this.lastScores, k);
      this.drawConsole(messages, time, k);
      if (time > hud.OVER_TIME + 5) this.drawCenter(hud.NEXT_MAP ? `fire for ${hud.NEXT_MAP}` : 'fire to play again', Math.floor(h * 0.82), Math.round(12 * k));
      return;
    }
    if (hud.SPECTATOR && !hud.FOLLOW_NAME) {
      // free (CG_DrawSpectator): no status bar, the word and the ways out
      this.drawConsole(messages, time, k);
      this.drawCenter('SPECTATOR', h - Math.round(70 * k), Math.round(20 * k));
      this.drawCenter('fire to follow a bot · Join to play', h - Math.round(40 * k), Math.round(10 * k));
      if (hud.CPRINT) this.drawCenter(hud.CPRINT, Math.floor(h * 0.32), Math.round(16 * k));
      if (opts.scoreboard) this.drawScoreboard(hud, opts.scores ?? this.lastScores, k);
      return;
    }
    if (hud.FOLLOW_NAME) {
      // following (CG_DrawFollow): whose eyes these are; above the status bar, as the console has the top
      this.drawCenter('following', h - Math.round(118 * k), Math.round(10 * k));
      this.drawCenter(hud.FOLLOW_NAME, h - Math.round(104 * k), Math.round(20 * k));
    }
    // ammo
    const wp = WEAPONS[hud.WEAPON];
    if (wp && wp.ammo && !hud.FOLLOW_NAME) {   // (the one followed: its gun, not our ammunition)
      const cnt = hud[['', '', 'BULLETS', 'SHELLS', 'GRENADES', 'ROCKETS', 'LIGHTNING', 'SLUGS', 'CELLS', 'BFG'][wp.ammo]] ?? 0;
      this.drawNum(Math.round(4 * k), yb, cnt, 3, dh, cnt <= 0 ? [1, 0.3, 0.3] : null);
      r.drawPic(this.pic(wp.icon), Math.round(108 * k), yb, ih, ih);
    } else if (wp) r.drawPic(this.pic(wp.icon), Math.round(108 * k), yb, ih, ih);
    // health
    const hp = hud.HEALTH;
    const red = hp <= 25 && Math.floor(time * 4) % 2 === 0;
    this.drawNum(Math.round(176 * k), yb, hp, 3, dh, red ? [1, 0.2, 0.2] : hp > 100 ? [1, 1, 1] : null);
    r.drawPic(this.pic('icons/iconh_red'), Math.round(280 * k), yb, ih, ih);
    // armour
    if (hud.ARMOR > 0) {
      this.drawNum(Math.round(366 * k), yb, hud.ARMOR, 3, dh, null);
      r.drawPic(this.pic('icons/iconr_yellow'), Math.round(470 * k), yb, ih, ih);
    }
    // frags
    const fs = Math.round(16 * k);
    if (hud.GAMETYPE >= 3) {
      // a team game (CG_DrawScores): the two teams' scores, ours marked
      for (const [i, [tm, score, col]] of [[1, hud.RED_SCORE, [1, 0.3, 0.3]], [2, hud.BLUE_SCORE, [0.4, 0.5, 1]]].entries()) {
        const str = `${hud.TEAM === tm ? '>' : ''}${score ?? 0}`, y = Math.round(8 * k) + i * (fs + 2);
        if (hud.TEAM === tm) r.fillRect(w - Math.round(12 * k) - str.length * fs, y - 2, str.length * fs + Math.round(8 * k), fs + 4, 0xff000000, 0.5);
        r.drawString(this.font, str, w - Math.round(8 * k) - str.length * fs, y, fs, col);
      }
    } else {
      const frag = `${hud.FRAGS}`;
      r.drawString(this.font, frag, w - Math.round(8 * k) - frag.length * fs, Math.round(8 * k), fs, [1, 1, 1]);
      r.drawString(this.font, `${hud.LEAD ?? 0}`, w - Math.round(8 * k) - String(hud.LEAD ?? 0).length * fs, Math.round(8 * k) + fs + 2, fs, [1, 0.4, 0.4]);
    }
    // the time left (cg_drawTimer counts up; with a time limit the minutes left are what matter)
    if (hud.TIMELIMIT > 0 && !hud.MATCH_OVER) {
      const left = Math.max(0, Math.ceil(hud.TIMELIMIT * 60 - (time - Math.max(0, hud.WARMUP_END ?? 0))));
      const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      const ts = Math.round(12 * k);
      r.drawString(this.font, clock, w - Math.round(8 * k) - clock.length * ts, Math.round(8 * k) + 2 * (fs + 2), ts, left <= 60 ? [1, 0.4, 0.4] : [1, 1, 1]);
    }
    // powerups with the seconds left, up the right edge
    let py = h - Math.round(130 * k);
    for (const [key, icon] of [['QUAD', 'icons/quad'], ['HASTE', 'icons/haste'], ['INVIS', 'icons/invis'], ['REGEN', 'icons/regen'], ['ENVIRO', 'icons/envirosuit'], ['FLIGHT', 'icons/flight']]) {
      if (hud[key] > 0) {
        r.drawPic(this.pic(icon), w - Math.round(44 * k), py, Math.round(36 * k), Math.round(36 * k));
        r.drawString(this.font, String(Math.ceil(hud[key])), w - Math.round(80 * k), py + Math.round(10 * k), Math.round(12 * k));
        py -= Math.round(40 * k);
      }
    }
    if (hud.HOLDABLE) r.drawPic(this.pic(hud.HOLDABLE === 1 ? 'icons/teleporter' : 'icons/medkit'), w - Math.round(44 * k), py, Math.round(36 * k), Math.round(36 * k));
    // the reward (CG_DrawReward): the medal as many times as it has been earned (up to nine), for three seconds
    const AWARDS = [null, 'excellent', 'impressive', 'gauntlet'];
    if (hud.AWARD > 0 && time - hud.AWARD_TIME >= 0 && time - hud.AWARD_TIME < 3) {
      const kind = AWARDS[hud.AWARD], count = hud[`N_${kind.toUpperCase()}`] ?? 1, size = Math.round(44 * k), step = Math.round(48 * k);
      const pic = this.pic(`menu/medals/medal_${kind}`), ay = Math.round(56 * k);
      if (pic && count >= 10) {
        r.drawPic(pic, (w - size) >> 1, ay, size, size);
        const n = String(count), ns = Math.round(12 * k);
        r.drawString(this.font, n, (w - n.length * ns) >> 1, ay + size + 2, ns, [1, 1, 1]);
      } else if (pic) {
        let ax = (w - count * step) >> 1;
        for (let i = 0; i < count; i++, ax += step) r.drawPic(pic, ax, ay, size, size);
      }
    }
    // the countdown (CG_DrawWarmup)
    if (hud.WARMUP_END > time) this.drawCenter(`Starts in: ${Math.ceil(hud.WARMUP_END - time)}`, Math.floor(h * 0.42), Math.round(18 * k));
    // the pickup line and the centre print
    const cs = Math.max(8, Math.round(12 * k));
    if (hud.MSG) r.drawString(this.font, hud.MSG, (w - hud.MSG.length * cs) >> 1, h - Math.round(120 * k), cs, [1, 1, 1]);
    if (hud.CPRINT) this.drawCenter(hud.CPRINT, Math.floor(h * 0.32), Math.round(16 * k));
    // the console lines of the last seconds
    this.drawConsole(messages, time, k);
    // crosshair
    if (!hud.DEAD && this.crosshair) { const cz = Math.round(24 * k); r.drawPic(this.crosshair, (w - cz) >> 1, (h - cz) >> 1, cz, cz); }
    if (hud.DEAD && !hud.FOLLOW_NAME && time - hud.DEAD_TIME_ > 0) this.drawCenter('press fire to respawn', Math.floor(h * 0.6), Math.round(12 * k));
    if (opts.scoreboard) this.drawScoreboard(hud, opts.scores ?? this.lastScores, k);
  }

  /** The console lines of the last five seconds, top left, wrapped at the screen's edge (the bots talk at length). */
  drawConsole(messages, time, k) {
    const r = this.r, cs = Math.max(7, Math.round(10 * k)), x = Math.round(4 * k);
    const per = Math.max(10, Math.floor((r.w - 2 * x) / cs));
    let y = Math.round(4 * k);
    for (const m of messages) {
      if (time - m.time > 5) continue;
      let text = String(m.text), first = true;
      while (text.length) {
        let cut = text.length <= per ? text.length : text.lastIndexOf(' ', per);
        if (cut <= 0) cut = per;
        r.drawString(this.font, (first ? '' : '  ') + text.slice(0, cut).trimEnd(), x, y, cs, [1, 1, 1]);
        text = text.slice(cut).trimStart();
        y += cs + 1; first = false;
      }
    }
  }

  drawCenter(msg, y, size) {
    const lines = String(msg).split(/\\n|\n/);
    for (const line of lines) {
      this.r.drawString(this.font, line, (this.r.w - line.length * size) >> 1, y, size, [1, 1, 1]);
      y += size + 2;
    }
  }

  /** The scoreboard: rows of [name, frags, deaths, isPlayer, team]; in a team game, under each team's
   *  name and score (CG_TeamScoreboard), red first. */
  drawScoreboard(hud, scores, k) {
    const r = this.r;
    const cs = Math.max(8, Math.round(12 * k));
    let rows = scores.length ? scores : [['You', hud.FRAGS, hud.DEATHS, 1, hud.TEAM ?? 0]];
    if (hud.GAMETYPE >= 3) {
      const head = (tm, name, score) => [`${name} ${score ?? 0}`, '', '', 0, tm, true];
      rows = [head(1, 'Red', hud.RED_SCORE), ...rows.filter((x) => x[4] === 1), head(2, 'Blue', hud.BLUE_SCORE), ...rows.filter((x) => x[4] === 2)];
    } else if (hud.GAMETYPE === 1) {
      // a tournament: the two with their frags and wins-losses, then the queue, next first
      const wl = (x) => [x[0], x[1], `${x[5] ?? 0}-${x[6] ?? 0}`, x[3], x[4]];
      const queue = rows.filter((x) => x[4] === 3);
      rows = [...rows.filter((x) => x[4] !== 3).map(wl), ...(queue.length ? [['Waiting', '', '', 0, 3, true], ...queue.map((x) => [x[0], '', `${x[5] ?? 0}-${x[6] ?? 0}`, x[3], 3])] : [])];
    }
    const bw = Math.round(300 * k), bh = (rows.length + 2) * (cs + 4) + cs;
    const bx = (r.w - bw) >> 1, by = Math.round(r.h * 0.2);
    r.fillRect(bx, by, bw, bh, 0xff000000, 0.6);
    const limits = [hud.FRAGLIMIT > 0 ? `Frag limit ${hud.FRAGLIMIT}` : '', hud.TIMELIMIT > 0 ? `${hud.TIMELIMIT} min` : ''].filter(Boolean).join(' · ') || 'No limit';
    const title = hud.MATCH_OVER ? (hud.WINNER === 'You' ? 'You win' : `${hud.WINNER} wins`) : limits;
    r.drawString(this.font, title, bx + ((bw - title.length * cs) >> 1), by + 4, cs, [1, 0.9, 0.4]);
    let y = by + cs + 10;
    for (const [name, frags, deaths, isPlayer, team, isHead] of rows) {
      if (isHead) {
        r.fillRect(bx + 4, y - 2, bw - 8, cs + 4, team === 1 ? 0xff2020a0 : team === 2 ? 0xffa04020 : 0xff404040, 0.5);
        r.drawString(this.font, String(name), bx + 8, y, cs, team === 1 ? [1, 0.4, 0.4] : team === 2 ? [0.5, 0.6, 1] : [0.8, 0.8, 0.8]);
        y += cs + 4;
        continue;
      }
      r.drawString(this.font, String(name).slice(0, 14), bx + 8, y, cs, isPlayer ? [1, 1, 0.5] : [1, 1, 1]);
      const sf = String(frags), sd = String(deaths);
      r.drawString(this.font, sf, bx + bw - 8 - (sd.length + sf.length + 2) * cs, y, cs, [1, 1, 1]);
      r.drawString(this.font, sd, bx + bw - 8 - sd.length * cs, y, cs, [0.7, 0.7, 0.7]);
      y += cs + 4;
    }
    // at the end, the player's medals of the match (the single-player postgame's)
    if (hud.MATCH_OVER) {
      const medals = [['excellent', hud.N_EXCELLENT], ['impressive', hud.N_IMPRESSIVE], ['gauntlet', hud.N_GAUNTLET]].filter(([, n]) => n > 0);
      const ms = Math.round(32 * k);
      let mx = (r.w - medals.length * (ms + 3 * cs)) >> 1;
      for (const [kind, n] of medals) {
        const pic = this.pic(`menu/medals/medal_${kind}`);
        if (pic) r.drawPic(pic, mx, by + bh + 6, ms, ms);
        r.drawString(this.font, `${n}`, mx + ms + 2, by + bh + 6 + ((ms - cs) >> 1), cs, [1, 1, 1]);
        mx += ms + 3 * cs;
      }
    }
  }
}

export { AMMO_ICONS };
