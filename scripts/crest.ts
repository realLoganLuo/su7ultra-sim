import { road } from '../src/track/roadSurface';
const v = 350 / 3.6;
let worst = 9, at = 0, wd = 0;
for (let s = 0; s < road.length; s += 1) for (const d of [-4, 0, 4]) {
  const h0 = road.base(s, d), hp = road.base(s + 3, d), hm = road.base(s - 3, d);
  const ap = (v * v * (hp - 2 * h0 + hm)) / 9;
  const gn = (9.81 + ap) / 9.81;
  if (gn < worst) { worst = gn; at = s; wd = d; }
}
console.log('min normal-load factor at 350 km/h (profile only):', worst.toFixed(2), 'at s', at.toFixed(0), road.sectionAt(at).name, 'd', wd);
// list the 8 worst separate spots
const arr: [number, number][] = [];
for (let s = 0; s < road.length; s += 1) { const h0 = road.base(s, 0), hp = road.base(s + 3, 0), hm = road.base(s - 3, 0); arr.push([(9.81 + (v * v * (hp - 2 * h0 + hm)) / 9) / 9.81, s]); }
arr.sort((a, b) => a[0] - b[0]);
const seen: number[] = []; const out: string[] = [];
for (const [g, s] of arr) { if (seen.every((q) => Math.abs(q - s) > 60)) { seen.push(s); out.push(`${g.toFixed(2)}@${s.toFixed(0)}(${road.sectionAt(s).name})`); } if (out.length >= 8) break; }
console.log(out.join('  '));
