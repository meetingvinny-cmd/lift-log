// ui/trend.js - the trend line (17 C.3.12, LOOK 4.8): one series per block, an inline SVG built
// with createElementNS only (through svg() in dom.js). Points come from stats.js trendPoints, oldest
// round first. y runs from the lowest to the highest value with headroom (no zero floor); one dot
// per round; the last dot carries its value; x labels R1, R2 ...; a <title> and an aria-label say
// the trend in words. No gridlines, no fill, no legend, no animation.
import { svg } from './dom.js';
import { t } from './strings.js';

// The drawing box (viewBox units, not screen pixels: the box scales to the content width).
const W = 320, H = 120, PAD_X = 16, PAD_TOP = 22, PAD_BOTTOM = 22;
const fmt = (n) => (n === null || n === undefined) ? '' : String(Math.round(n * 100) / 100);

function lowHigh(values) {
  let lo = null, hi = null;
  for (const v of values) { if (lo === null || v < lo) lo = v; if (hi === null || v > hi) hi = v; }
  return [lo, hi];
}

// The x and y of each point in the box (exported for today.test.js-style unit checks).
export function trendLayout(points) {
  const n = points.length;
  const [lo, hi] = lowHigh(points.map(p => p.value));
  const span = hi === lo ? 1 : hi - lo;
  const room = span * 0.15;
  const top = hi + room, bottom = lo - room;
  const x = (i) => (n === 1 ? W / 2 : PAD_X + i * (W - 2 * PAD_X) / (n - 1));
  const y = (v) => PAD_TOP + (top - v) * (H - PAD_TOP - PAD_BOTTOM) / (top - bottom);
  return points.map((p, i) => ({ pass: p.pass, value: p.value, x: Math.round(x(i) * 10) / 10, y: Math.round(y(p.value) * 10) / 10 }));
}

// name: the exercise name; unit: the word after the value (lb, kg, or the reps word).
export function trendSvg(points, name, unit) {
  if (!points || !points.length) return null;
  const pts = trendLayout(points);
  const first = pts[0], last = pts[pts.length - 1];
  const label = pts.length === 1 ? t('trend.aria.one', { exercise: name, last: fmt(last.value), unit })
    : t('trend.aria', { exercise: name, first: fmt(first.value), last: fmt(last.value), unit, n: pts.length });
  const box = svg('svg', { class: 'trend', viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': label, 'data-points': String(pts.length) },
    svg('title', {}, t('trend.title')),
    svg('line', { class: 'trend-base', x1: '0', y1: String(H - PAD_BOTTOM + 4), x2: String(W), y2: String(H - PAD_BOTTOM + 4) }));
  if (pts.length > 1) box.appendChild(svg('polyline', { class: 'trend-line', fill: 'none', points: pts.map(p => p.x + ',' + p.y).join(' ') }));
  for (const p of pts) {
    box.appendChild(svg('circle', { class: 'trend-dot', cx: String(p.x), cy: String(p.y), r: '3', 'data-pass': String(p.pass) }));
    box.appendChild(svg('text', { class: 'trend-x', x: String(p.x), y: String(H - 4), 'text-anchor': 'middle' }, t('round.short', { r: p.pass })));
  }
  box.appendChild(svg('text', { class: 'trend-last', x: String(last.x), y: String(Math.max(12, last.y - 8)), 'text-anchor': pts.length === 1 ? 'middle' : 'end', 'data-last': fmt(last.value) }, fmt(last.value)));
  return box;
}
