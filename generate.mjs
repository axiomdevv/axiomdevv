// Contribution Runner (native look)
// Recreates your real GitHub contribution graph (same grid, same colors, same cell positions)
// and lets a little character run over it: it walks along the bottom of the grid and jumps up
// onto contributed days, whatever their height, then drops back down when the column is empty.
//
// Usage:
//   GITHUB_TOKEN=xxx node generate.mjs <username> [out.svg]   -> out.svg (light) + out-dark.svg
//   node generate.mjs --sample [out.svg]                      (fake sparse data, for testing)

import fs from "node:fs";

// In a week with several contributed days he lands on the one with the most contributions.
// STAND_ON only breaks ties: "top" = the highest of the tied cells, "bottom" = the lowest.
const STAND_ON = "top";

// ---------- 1. Data ----------
const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function fetchWeeks(user, token) {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{weeks{contributionDays{contributionCount contributionLevel weekday date}}}}}}`;
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "contrib-runner" },
    body: JSON.stringify({ query, variables: { login: user } }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data.user.contributionsCollection.contributionCalendar.weeks.map((w) => {
    const days = Array(7).fill(null); // index = weekday, 0 = Sunday (top row)
    for (const d of w.contributionDays)
      days[d.weekday] = { count: d.contributionCount, level: LEVELS[d.contributionLevel] ?? 0, date: d.date };
    return days;
  });
}

function sampleWeeks() {
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - start.getUTCDay() - 52 * 7);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: 53 }, (_, i) => {
    const days = Array.from({ length: 7 }, (_, d) => {
      const dt = new Date(start);
      dt.setUTCDate(start.getUTCDate() + i * 7 + d);
      return { count: 0, level: 0, date: dt.toISOString().slice(0, 10) };
    });
    const set = (d, lvl) => { days[d].count = lvl; days[d].level = lvl; };
    if (i === 30) [1, 3, 2, 4, 1, 4, 2].forEach((l, d) => set(d, l));
    else if (i === 12) { set(1, 2); set(4, 3); }
    else if (rnd() < 0.3) {
      const n = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) set(Math.floor(rnd() * 7), 1 + Math.floor(rnd() * 4));
    }
    return days;
  });
}

// ---------- 2. Look (GitHub's own palettes) ----------
const THEMES = {
  light: { empty: "#ebedf0", levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"], text: "#57606a" },
  dark: { empty: "#151b23", levels: ["#033a16", "#196c2e", "#2ea043", "#56d364"], text: "#9198a1" },
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const CELL = 10, GAP = 3, STEP = CELL + GAP;
const PAD_L = 32, PAD_R = 14, HEAD = 40, PAD_B = 10;

// ---------- 3. Build one SVG ----------
function build(weeks, theme) {
  const T = THEMES[theme];
  const cols = weeks.length;
  const gridTop = HEAD;
  const gridBottom = gridTop + 7 * STEP - GAP; // the "floor"
  const width = PAD_L + cols * STEP - GAP + PAD_R;
  const height = gridBottom + PAD_B;
  const cellX = (i) => PAD_L + i * STEP;
  const cellY = (r) => gridTop + r * STEP;

  // where the character stands in each column
  // He lands on the day with the MOST contributions in that week. If several days tie,
  // STAND_ON decides between them (highest or lowest cell).
  const standRow = weeks.map((w) => {
    const cands = w.map((d, r) => (d && d.count > 0 ? { r, count: d.count } : null)).filter(Boolean);
    if (!cands.length) return null;
    const best = Math.max(...cands.map((c) => c.count));
    const rows = cands.filter((c) => c.count === best).map((c) => c.r);
    return STAND_ON === "top" ? Math.min(...rows) : Math.max(...rows);
  });
  const surf = standRow.map((r) => (r === null ? gridBottom : cellY(r)));
  const blocksUp = standRow.map((r) => (r === null ? 0 : 7 - r));

  // --- character path ---
  const PX = 1.25;
  const CH_W = 8 * PX, CH_H = 9 * PX + PX * 1.2;
  const WALK = 0.14, JUMP_BASE = 0.34, JUMP_PER_BLOCK = 0.05;
  const pts = [];
  const landings = [];
  let t = 0;
  let cx = PAD_L - 20, cy = gridBottom;
  const add = (tt, x, sy) => pts.push({ t: tt, x: x - CH_W / 2, y: sy - CH_H });
  add(0, cx, cy);
  function goTo(x1, y1, dh) {
    if (y1 === cy) {
      t += WALK;
      add(t, x1, y1);
    } else {
      const rising = y1 < cy;
      const apex = rising ? y1 - (5 + dh * 1.5) : cy - 4;
      const dur = JUMP_BASE + JUMP_PER_BLOCK * Math.min(dh, 6);
      const N = 8, ctrl = 2 * apex - (cy + y1) / 2;
      for (let k = 1; k <= N; k++) {
        const u = k / N;
        const y = (1 - u) * (1 - u) * cy + 2 * (1 - u) * u * ctrl + u * u * y1;
        add(t + dur * u, cx + (x1 - cx) * u, y);
      }
      t += dur;
    }
    cx = x1; cy = y1;
  }
  let prevBlocks = 0;
  for (let i = 0; i < cols; i++) {
    goTo(cellX(i) + CELL / 2, surf[i], Math.abs(blocksUp[i] - prevBlocks));
    if (standRow[i] !== null) landings.push({ col: i, row: standRow[i], t });
    prevBlocks = blocksUp[i];
  }
  goTo(width + 6, gridBottom, prevBlocks);
  const total = t + 1.0; // pause before looping
  pts.push({ t: total, x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
  const dur = total.toFixed(2) + "s";
  const keyTimes = pts.map((p) => (p.t / total).toFixed(4)).join(";");
  const values = pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(";");

  // --- grid cells ---
  let cells = "";
  weeks.forEach((w, i) => {
    w.forEach((d, r) => {
      if (!d) return;
      const fill = d.level > 0 ? T.levels[d.level - 1] : T.empty;
      const rect = `<rect x="${cellX(i)}" y="${cellY(r)}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`;
      const land = landings.find((l) => l.col === i && l.row === r);
      if (land) {
        const p = land.t / total;
        const a = Math.max(0, p - 0.002).toFixed(4), b = (p + 0.012).toFixed(4), c = Math.min(0.9999, p + 0.03).toFixed(4);
        cells += `<g>${rect}<animateTransform attributeName="transform" type="translate" dur="${dur}" repeatCount="indefinite" keyTimes="0;${a};${b};${c};1" values="0 0;0 0;0 -2;0 0;0 0"/></g>`;
      } else cells += rect;
    });
  });

  // --- labels (month + Mon/Wed/Fri), like the real graph ---
  let labels = "";
  let lastMonth = -1, lastCol = -10;
  weeks.forEach((w, i) => {
    const d = w.find(Boolean);
    if (!d) return;
    const m = new Date(d.date + "T00:00:00Z").getUTCMonth();
    if (m !== lastMonth) {
      if (i - lastCol >= 3) { labels += `<text x="${cellX(i)}" y="${gridTop - 7}">${MONTHS[m]}</text>`; lastCol = i; }
      lastMonth = m;
    }
  });
  [["Mon", 1], ["Wed", 3], ["Fri", 5]].forEach(([name, r]) => {
    labels += `<text x="0" y="${cellY(r) + 9}">${name}</text>`;
  });

  // --- character: original pixel sprite ---
  const sprite = [
    "..hhhh..",
    ".hhhhhh.",
    ".hffffh.",
    ".hfeffh.",
    "..ffff..",
    ".bbbbbb.",
    "fbbbbbbf",
    ".bbbbbb.",
    ".bbbbbb.",
  ];
  const colors = { h: "#2d3a6b", f: "#f2c9a0", e: "#222222", b: "#e9a23b" };
  let body = "";
  sprite.forEach((row, ry) =>
    [...row].forEach((ch, rx) => {
      if (colors[ch]) body += `<rect x="${rx * PX}" y="${ry * PX}" width="${PX + 0.05}" height="${PX + 0.05}" fill="${colors[ch]}"/>`;
    })
  );
  const leg = (x) => `<rect x="${x * PX}" y="${9 * PX}" width="${2 * PX}" height="${PX * 1.2}" fill="#3b2a1e"/>`;
  const flip = (a, b) => `<animate attributeName="opacity" values="${a};${b}" dur="0.24s" calcMode="discrete" repeatCount="indefinite"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Contribution graph with a little character jumping on the contribution blocks">
<g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="10" fill="${T.text}">${labels}</g>
${cells}
<g id="runner">
<animateTransform attributeName="transform" type="translate" dur="${dur}" repeatCount="indefinite" calcMode="linear" keyTimes="${keyTimes}" values="${values}"/>
${body}
<g>${leg(1.5)}${leg(4.5)}${flip(1, 0)}</g>
<g opacity="0">${leg(0.5)}${leg(5.5)}${flip(0, 1)}</g>
</g>
</svg>`;
}

// ---------- 3b. Storm style (pixel art) ----------
// Dark grey stormy sky, drifting pixel clouds, light rain, and jagged blue lightning that
// strikes your contributed days one by one. The grid keeps GitHub's real layout.
const STORM = {
  sky: ["#0b0e14", "#10141c", "#151a24", "#1a202b", "#1f2632", "#242c39"],
  empty: "#333c4b",
  levels: ["#196c2e", "#2ea043", "#4ac26b", "#7ee787"],
  text: "#7b889c",
  backCloud: { hi: "#2a3244", mid: "#1c2230", lo: "#121720" },
  frontCloud: { hi: "#566178", mid: "#3b4455", lo: "#272e3c" },
};
const MAX_STRIKES = 60; // if you have more contributed days than this, the biggest days get struck

function mulberry(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mix = (hex, to, a) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.round(((n >> s) & 255) * (1 - a) + ((to >> s) & 255) * a);
  return "#" + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
};
const rectP = (x, y, w, h) => `M${x} ${y}h${w}v${h}h${-w}z`;

function buildStorm(weeks) {
  const rnd = mulberry(20261026);
  const cols = weeks.length;
  const gridTop = 96;
  const gridBottom = gridTop + 7 * STEP - GAP;
  const W = PAD_L + cols * STEP - GAP + PAD_R;
  const H = gridBottom + 14;
  const cellX = (i) => PAD_L + i * STEP;
  const cellY = (r) => gridTop + r * STEP;
  const tileW = Math.ceil(W / 4) * 4, gw = tileW / 4;

  // --- sky: flat bands with a 2-row dither between them ---
  const bh = Math.ceil(H / STORM.sky.length / 4) * 4;
  let sky = "";
  STORM.sky.forEach((c, i) => (sky += `<rect x="0" y="${i * bh}" width="${W}" height="${bh}" fill="${c}"/>`));
  for (let i = 1; i < STORM.sky.length; i++) {
    let d1 = "", d2 = "";
    for (let k = 0; k * 4 < W; k++) (k % 2 ? (d1 += rectP(k * 4, i * bh - 8, 4, 4)) : (d2 += rectP(k * 4, i * bh - 4, 4, 4)));
    sky += `<path d="${d1}${d2}" fill="${STORM.sky[i]}"/>`;
  }

  // --- clouds: circles rasterised on a 4px grid, wrapped so they can drift forever ---
  const key = (x, y) => `${((x % gw) + gw) % gw},${y}`;
  function cloudCells(base, count, rMin, rMax) {
    const S = new Set();
    for (let i = 0; i < count; i++) {
      const cx = ((i + 0.2 + rnd() * 0.6) * gw) / count;
      const n = 4 + Math.floor(rnd() * 3);
      const b = base + Math.floor(rnd() * 3) - 1; // each cloud gets its own flat bottom
      for (let j = 0; j < n; j++) {
        const r = rMin + rnd() * (rMax - rMin);
        const px = cx + (j - (n - 1) / 2) * (rMin * 0.9 + rnd() * 1.5);
        const py = b - r * (0.5 + rnd() * 0.35);
        for (let y = Math.max(0, Math.floor(py - r)); y <= b; y++)
          for (let x = Math.floor(px - r); x <= Math.ceil(px + r); x++)
            if ((x - px) ** 2 + (y - py) ** 2 <= r * r) S.add(key(x, y));
      }
    }
    return S;
  }
  function cloudMarkup(S, tones, dur) {
    const has = (x, y) => S.has(key(x, y));
    const out = { hi: new Map(), mid: new Map(), lo: new Map() };
    for (const k of S) {
      const [x, y] = k.split(",").map(Number);
      let tone = "mid";
      if (!has(x, y - 1)) tone = "hi";
      else if (!has(x, y + 1)) tone = "lo";
      else if (!has(x, y - 2) && (x + y) % 2 === 0) tone = "hi";
      else if (!has(x, y + 2) && (x + y) % 2 === 0) tone = "lo";
      if (!out[tone].has(y)) out[tone].set(y, []);
      out[tone].get(y).push(x);
    }
    const runs = (rows) => {
      let d = "";
      for (const [y, xs] of rows) {
        xs.sort((a, b) => a - b);
        let s = xs[0], p = xs[0];
        for (let i = 1; i <= xs.length; i++) {
          if (xs[i] === p + 1) { p = xs[i]; continue; }
          d += rectP(s * 4, y * 4, (p - s + 1) * 4, 4);
          s = xs[i]; p = xs[i];
        }
      }
      return d;
    };
    const body = `<path d="${runs(out.mid)}" fill="${tones.mid}"/><path d="${runs(out.lo)}" fill="${tones.lo}"/><path d="${runs(out.hi)}" fill="${tones.hi}"/>`;
    return `<g><animateTransform attributeName="transform" type="translate" dur="${dur}s" repeatCount="indefinite" values="0 0;${tileW} 0"/>${body}<g transform="translate(${-tileW} 0)">${body}</g></g>`;
  }
  const clouds =
    cloudMarkup(cloudCells(10, 5, 3, 5), STORM.backCloud, 150) +
    cloudMarkup(cloudCells(14, 4, 4, 6.5), STORM.frontCloud, 95);

  // --- labels ---
  let labels = "";
  let lastMonth = -1, lastCol = -10;
  weeks.forEach((w, i) => {
    const d = w.find(Boolean);
    if (!d) return;
    const m = new Date(d.date + "T00:00:00Z").getUTCMonth();
    if (m !== lastMonth) {
      if (i - lastCol >= 3) { labels += `<text x="${cellX(i)}" y="${gridTop - 7}">${MONTHS[m]}</text>`; lastCol = i; }
      lastMonth = m;
    }
  });
  [["Mon", 1], ["Wed", 3], ["Fri", 5]].forEach(([name, r]) => (labels += `<text x="0" y="${cellY(r) + 9}">${name}</text>`));

  // --- pixel blocks (notched corners, 1px bevel, shine pixel) ---
  const notch = (x, y) => rectP(x + 1, y, 8, 10) + rectP(x, y + 1, 10, 8);
  const groups = {};
  weeks.forEach((w, i) =>
    w.forEach((d, r) => {
      if (!d) return;
      const g = (groups[d.level > 0 ? d.level : 0] ??= { base: "", hi: "", lo: "", shine: "" });
      const x = cellX(i), y = cellY(r);
      g.base += notch(x, y);
      g.hi += rectP(x + 1, y, 8, 1) + rectP(x, y + 1, 1, 7);
      g.lo += rectP(x + 1, y + 9, 8, 1) + rectP(x + 9, y + 2, 1, 7);
      if (d.level > 0) g.shine += rectP(x + 2, y + 2, 3, 1);
    })
  );
  let cells = "";
  for (const [k, g] of Object.entries(groups)) {
    const base = k === "0" ? STORM.empty : STORM.levels[k - 1];
    cells += `<path d="${g.base}" fill="${base}"/><path d="${g.lo}" fill="${mix(base, 0, 0.4)}"/><path d="${g.hi}" fill="${mix(base, 0xffffff, 0.3)}"/>`;
    if (g.shine) cells += `<path d="${g.shine}" fill="${mix(base, 0xffffff, 0.55)}"/>`;
  }

  // --- rain: three stacked tiles that scroll down in a seamless loop ---
  const T = Math.ceil(H / 2);
  let drops = "";
  for (let k = 0; k < 46; k++) drops += `M${Math.floor(rnd() * W)} ${Math.floor(rnd() * (T - 7))}h1v5h-1z`;
  let rain = "";
  for (let k = -1; k <= 2; k++) rain += `<path d="${drops}" transform="translate(0 ${k * T})"/>`;
  rain = `<g fill="#a9c4e0" fill-opacity=".22"><animateTransform attributeName="transform" type="translate" dur="0.7s" repeatCount="indefinite" values="0 0;0 ${T}"/>${rain}</g>`;

  // --- lightning ---
  const targets = [];
  weeks.forEach((w, i) => w.forEach((d, r) => { if (d && d.count > 0) targets.push({ i, r, count: d.count }); }));
  targets.sort((a, b) => b.count - a.count);
  const chosen = targets.slice(0, MAX_STRIKES);
  for (let k = chosen.length - 1; k > 0; k--) {
    const j = Math.floor(rnd() * (k + 1));
    [chosen[k], chosen[j]] = [chosen[j], chosen[k]];
  }
  let tt = 0.9;
  const times = chosen.map(() => { const t0 = tt; tt += 0.75 + rnd() * 0.7; return t0; });
  const L = tt + 0.9;
  const f = (s) => (s / L).toFixed(5);
  const snap = (v) => Math.round(v / 2) * 2;

  const polyPath = (pts, w) => {
    let d = "";
    const hw = w / 2;
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      d += rectP(x0 - hw, y0, w, y1 - y0);
      if (x1 !== x0) d += rectP(Math.min(x0, x1) - hw, y1 - hw, Math.abs(x1 - x0) + w, w);
    }
    return d;
  };

  let strikes = "";
  chosen.forEach((c, k) => {
    const t0 = times[k];
    const tx = snap(cellX(c.i) + CELL / 2), ty = cellY(c.r);
    const sx = snap(tx + (rnd() - 0.5) * 36), sy = 46 + Math.floor(rnd() * 3) * 2;
    const h = 4, n = Math.max(3, Math.ceil((ty - sy) / h));
    let x = sx;
    const pts = [[x, sy]];
    // long straight runs with sharp jogs, like classic pixel-art lightning
    let segLeft = 0;
    for (let s = 1; s <= n; s++) {
      let nx = x;
      if (s === n) nx = tx;
      else if (segLeft <= 0) {
        const seg = 2 + Math.floor(rnd() * 3);
        const pull = Math.round((((tx - x) / (n - s + 1)) * seg) / 2) * 2;
        nx = snap(x + pull + [-6, -4, -2, 2, 4, 6][Math.floor(rnd() * 6)]);
        segLeft = seg;
      }
      segLeft--;
      pts.push([nx, sy + s * h]);
      x = nx;
    }
    // branches
    let outer = polyPath(pts, 6), core = polyPath(pts, 2);
    const nb = n >= 8 ? 1 + Math.floor(rnd() * 2) : 0;
    for (let b = 0; b < nb; b++) {
      const idx = 2 + Math.floor(rnd() * (n - 5));
      const dir = rnd() < 0.5 ? -1 : 1;
      const bp = [pts[idx]];
      const m = 3 + Math.floor(rnd() * 3);
      for (let s = 1; s <= m; s++) bp.push([bp[s - 1][0] + dir * (2 + 2 * Math.floor(rnd() * 2)), bp[s - 1][1] + h]);
      outer += polyPath(bp, 4); core += polyPath(bp, 2);
    }
    // impact: halo ring, flash, sparks
    const bx = cellX(c.i), by = cellY(c.r);
    const ring = rectP(bx - 2, by - 2, 14, 2) + rectP(bx - 2, by + 10, 14, 2) + rectP(bx - 2, by, 2, 10) + rectP(bx + 10, by, 2, 10);
    const sp = [[-9, -7], [9, -9], [-13, -2], [13, -4], [-5, -13], [5, -11]];
    const sparks = sp.map(([dx, dy]) => rectP(snap(tx + dx + (rnd() - 0.5) * 4), snap(by + dy + (rnd() - 0.5) * 4), 2, 2)).join("");
    // the thundercloud the bolt comes from lights up (stepped pixel puff)
    const glow = rectP(sx - 8, sy - 14, 16, 2) + rectP(sx - 16, sy - 12, 32, 2) + rectP(sx - 22, sy - 10, 44, 4) + rectP(sx - 24, sy - 6, 48, 6) + rectP(sx - 20, sy, 40, 4);
    const glow2 = rectP(sx - 10, sy - 8, 20, 2) + rectP(sx - 14, sy - 6, 28, 6) + rectP(sx - 8, sy, 16, 2);
    strikes +=
      `<g id="s${k}" opacity="0">` +
      `<animate attributeName="opacity" dur="${L.toFixed(2)}s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;${f(t0)};${f(t0 + 0.07)};${f(t0 + 0.13)};${f(t0 + 0.32)};1" values="0;1;.35;1;0;0"/>` +
      `<rect width="${W}" height="${H}" fill="#9fcbff" opacity=".09"/>` +
      `<path d="${glow}" fill="#8fb4e0" opacity=".32"/><path d="${glow2}" fill="#dff1ff" opacity=".35"/>` +
      `<path d="${outer}" fill="#3d8bff"/><path d="${core}" fill="#f4fbff"/>` +
      `<path d="${ring}" fill="#4aa8ff"/><path d="${notch(bx, by)}" fill="#eaf6ff" opacity=".9"/>` +
      `<path d="${sparks}" fill="#bfe3ff"/>` +
      `</g>` +
      `<path d="${notch(bx, by)}" fill="#4aa8ff" opacity="0"><animate attributeName="opacity" dur="${L.toFixed(2)}s" repeatCount="indefinite" keyTimes="0;${f(t0)};${f(t0 + 0.02)};${f(t0 + 1.0)};1" values="0;0;.6;0;0"/></path>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges" role="img" aria-label="Contribution graph under a stormy pixel-art sky, with lightning striking the contribution blocks">
${sky}
${clouds}
<g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" font-size="10" fill="${STORM.text}">${labels}</g>
${cells}
${rain}
${strikes}
</svg>`;
}

// ---------- 4. Run ----------
const args = process.argv.slice(2);
let weeks, out;
if (args[0] === "--sample") {
  weeks = sampleWeeks();
  out = args[1] || "runner.svg";
} else {
  const user = args[0];
  out = args[1] || "runner.svg";
  const token = process.env.GITHUB_TOKEN;
  if (!user || !token) {
    console.error("Usage: GITHUB_TOKEN=... node generate.mjs <username> [out.svg]  |  node generate.mjs --sample [out.svg]");
    process.exit(1);
  }
  weeks = await fetchWeeks(user, token);
}
const darkOut = out.replace(/\.svg$/, "") + "-dark.svg";
fs.writeFileSync(out, build(weeks, "light"));
fs.writeFileSync(darkOut, build(weeks, "dark"));
const stormOut = out.replace(/runner(?=\.svg$)/, "storm");
fs.writeFileSync(stormOut, buildStorm(weeks));
console.log(`Wrote ${out}, ${darkOut} and ${stormOut} (${weeks.length} weeks)`);
