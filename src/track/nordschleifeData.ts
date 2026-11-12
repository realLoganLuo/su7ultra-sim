// Nordschleife-inspired closed centreline. Coordinates in metres (x east, z south, y up).
// Not to scale / not a survey: ~60 hand placed control points giving a ~7 km lap.
// bank: degrees, positive = left side lower (banked for a left-hand turn).

export interface ControlPoint { x: number; z: number; y: number; bank: number }

const P = (x: number, z: number, y: number, bank = 0): ControlPoint => ({ x, z, y, bank });

export const CONTROL: ControlPoint[] = [
  P(0, 0, 0), //                         0  start / finish (T13)
  P(130, 0, -1), //                      1
  P(240, -30, -3, 3), //                 2  Hatzenbach
  P(330, -15, -6, -3), //                3
  P(420, -65, -9, 3), //                 4
  P(510, -55, -11, -3), //               5
  P(600, -110, -13, 3), //               6
  P(700, -115, -14), //                  7
  P(800, -135, -14), //                  8  Flugplatz
  P(910, -150, -12), //                  9  (crest)
  P(1020, -165, -16), //                10
  P(1130, -200, -22, 2), //             11  Fuchsroehre
  P(1215, -265, -33, 4), //             12
  P(1265, -345, -43, 4), //             13  (compression)
  P(1285, -430, -44), //                14
  P(1330, -500, -43), //                15  Adenauer Forst
  P(1318, -575, -41, -3), //            16
  P(1352, -648, -38, 3), //             17
  P(1338, -725, -35, -3), //            18
  P(1385, -795, -32, 3), //             19
  P(1420, -865, -30), //                20
  P(1390, -945, -28, 5), //             21  Bergwerk
  P(1310, -1005, -26, 6), //            22
  P(1200, -1020, -24, 5), //            23
  P(1080, -1010, -22), //               24  Kallenhard
  P(960, -1030, -20), //                25
  P(860, -1030, -19), //                26
  P(805, -1015, -19.5, 14), //          27  Karussell (concrete bowl)
  P(770, -985, -20, 26), //             28
  P(757, -940, -20.5, 28), //           29
  P(762, -895, -21, 20), //             30
  P(745, -850, -21, -6), //             31
  P(700, -815, -21, -8), //             32
  P(630, -810, -21), //                 33
  P(540, -830, -23), //                 34  Pflanzgarten
  P(450, -860, -26, 3), //              35
  P(370, -835, -29, -3), //             36  (jump 1)
  P(290, -865, -31, 3), //              37  (jump 2)
  P(210, -840, -32), //                 38
  P(100, -850, -33), //                 39  Wippermann
  P(-30, -870, -33), //                 40
  P(-170, -890, -30), //                41
  P(-330, -900, -26), //                42
  P(-500, -930, -22), //                43
  P(-680, -960, -18), //                44
  P(-870, -990, -14), //                45
  P(-1050, -1000, -10), //              46
  P(-1250, -1000, -8, 5), //            47  Schwalbenschwanz
  P(-1380, -960, -6, 10), //            48
  P(-1450, -880, -4, 12), //            49
  P(-1470, -780, -2, 8), //             50
  P(-1440, -680, 0, -4), //             51  Kleines Karussell
  P(-1470, -580, 0, 3), //              52
  P(-1450, -470, 0), //                 53
  P(-1400, -360, 0), //                 54  Tiergarten
  P(-1340, -250, 0), //                 55
  P(-1250, -160, 0), //                 56
  P(-1130, -90, 0, 3), //               57
  P(-1000, -40, 0), //                  58  Doettinger Hoehe
  P(-700, -10, 0), //                   59
  P(-400, 0, 0), //                     60
  P(-200, 0, 0), //                     61
];

/** Section name starts at control point index. */
export const SECTIONS: { idx: number; name: string; concrete?: boolean }[] = [
  { idx: 0, name: '起点 · T13' },
  { idx: 2, name: 'Hatzenbach' },
  { idx: 8, name: 'Flugplatz' },
  { idx: 11, name: 'Fuchsröhre' },
  { idx: 15, name: 'Adenauer Forst' },
  { idx: 21, name: 'Bergwerk' },
  { idx: 24, name: 'Kallenhard' },
  { idx: 27, name: 'Karussell', concrete: true },
  { idx: 33, name: 'Pflanzgarten' },
  { idx: 38, name: 'Wippermann' },
  { idx: 47, name: 'Schwalbenschwanz' },
  { idx: 55, name: 'Tiergarten' },
  { idx: 58, name: 'Döttinger Höhe' },
];

/** Smooth vertical features added to the road profile (crests = jumps, dips = compressions). */
export interface Feature { idx: number; frac: number; amp: number; sigma: number }
export const FEATURES: Feature[] = [
  { idx: 9, frac: 0.25, amp: 0.2, sigma: 24 }, // Flugplatz crest: the car goes light, never airborne
  { idx: 13, frac: 0.3, amp: -0.55, sigma: 30 }, // Fuchsroehre compression
  { idx: 36, frac: 0.0, amp: 0.14, sigma: 20 }, // Pflanzgarten hump 1
  { idx: 37, frac: 0.0, amp: 0.14, sigma: 20 }, // Pflanzgarten hump 2
  { idx: 20, frac: 0.0, amp: -0.3, sigma: 20 }, // Adenauer dip
  { idx: 45, frac: 0.0, amp: 0.3, sigma: 26 }, // gentle hump on the return leg
];

/** Small local bumps (wheel-level only). lat: -1 left lane side, +1 right, 0 all. */
export interface Bump { idx: number; frac: number; amp: number; sigma: number; lat: -1 | 0 | 1 }
export const BUMPS: Bump[] = [
  { idx: 3, frac: 0.5, amp: 0.05, sigma: 1.6, lat: 1 },
  { idx: 5, frac: 0.2, amp: 0.045, sigma: 1.6, lat: -1 },
  { idx: 16, frac: 0.5, amp: 0.06, sigma: 1.8, lat: 0 },
  { idx: 18, frac: 0.3, amp: 0.05, sigma: 1.5, lat: 1 },
  { idx: 22, frac: 0.5, amp: 0.06, sigma: 1.8, lat: -1 },
  { idx: 25, frac: 0.2, amp: 0.05, sigma: 1.5, lat: 0 },
  { idx: 34, frac: 0.5, amp: 0.07, sigma: 1.6, lat: 0 },
  { idx: 40, frac: 0.5, amp: 0.05, sigma: 1.6, lat: 1 },
  { idx: 41, frac: 0.5, amp: 0.045, sigma: 1.6, lat: -1 },
  { idx: 44, frac: 0.2, amp: 0.05, sigma: 1.6, lat: 0 },
  { idx: 49, frac: 0.5, amp: 0.06, sigma: 1.8, lat: -1 },
  { idx: 54, frac: 0.5, amp: 0.05, sigma: 1.6, lat: 0 },
  { idx: 59, frac: 0.2, amp: 0.04, sigma: 1.5, lat: 1 },
  { idx: 60, frac: 0.2, amp: 0.04, sigma: 1.5, lat: -1 },
];
