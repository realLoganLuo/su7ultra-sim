// Car-to-Armco contact. The body is a rigid rectangle in the road plane; the barrier is a compliant
// steel rail at |d| = armcoD. Every body corner that crosses the rail gets a normal spring-damper force
// (rail and crush zone in series) and Coulomb friction along the rail. Those forces act at the corner,
// so they produce deceleration, rebound and yaw torque (spin) from ordinary rigid-body mechanics.
//
// Stiffness: Armco ~1.2 MN/m dynamic, car crush zone ~1.0 MN/m (a 56 km/h full-width crash crushes
// ~0.7 m). The contact is elastic-plastic: loading follows the series stiffness, unloading only returns
// the elastic 10 % of the peak penetration (crushed metal and a bent rail stay deformed). That hysteresis
// plus light damping gives ~0.23 restitution, typical of car-to-barrier impacts. Steel-on-paint friction 0.35.

export const BARRIER = {
  kRail: 1.2e6, // N/m
  kBody: 1.0e6, // N/m
  zeta: 0.1, // light contact damping (numerical calm); most dissipation is plastic
  /** share of peak penetration that is permanent (crush + rail bend); sets the plastic restitution */
  plastic: 0.9,
  mu: 0.35, // rail friction
  maxPen: 1.3, // m: beyond this the posts / terrain stop the car (very stiff)
  kStop: 8e6,
  /** accumulated absorbed energy at which the car is wrecked (no drive) */
  wreckJ: 60e3,
};
export const K_EFF = (BARRIER.kRail * BARRIER.kBody) / (BARRIER.kRail + BARRIER.kBody);
/** unloading stiffness: continuous at the peak, zero force at the permanent set */
export const K_UNLOAD = K_EFF / (1 - BARRIER.plastic);
/** coefficient of restitution of the normal impact: plastic hysteresis times contact damping */
export const RESTITUTION = Math.sqrt(1 - BARRIER.plastic) * Math.exp((-BARRIER.zeta * Math.PI) / Math.sqrt(1 - BARRIER.zeta ** 2));

/** body corners (x forward from the CG, y left), matching the GLB bodywork outline */
export const BODY_CORNERS: [number, number][] = [[2.65, 1.03], [2.65, -1.03], [-2.55, 1.03], [-2.55, -1.03]];

export interface Impact {
  corner: number;
  /** contact point in the car frame (x forward, y left) [m] */
  x: number; yL: number;
  /** barrier normal in the car frame, pointing from the rail into the car */
  nx: number; nyL: number;
  /** normal approach speed at the corner [m/s] */
  normalSpeed: number;
  /** kinetic energy absorbed by deformation [J] */
  energyJ: number;
  /** peak penetration past the rail line, and how it splits into permanent car crush / rail bend [m] */
  penetration: number; bodyCrush: number; railBend: number;
  /** where on the track, and which rail (+1 left, -1 right) */
  s: number; side: 1 | -1;
  /** contact-point velocity along the rail and the car's CG velocity in the road frame [m/s] */
  slideSpeed: number; vS: number; vD: number;
  wrecked: boolean;
}
