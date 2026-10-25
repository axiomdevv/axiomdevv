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
console.log(`Wrote ${out} and ${darkOut} (${weeks.length} weeks)`);
