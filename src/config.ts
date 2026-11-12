// Vehicle parameters, key bindings and defaults. 1 unit = 1 metre.

export const G = 9.81;

export const CAR = {
  length: 5.115,
  width: 1.97,
  height: 1.465,
  wheelbase: 3.0,
  // CG sits 1.56 m behind the front axle... measured from CG: front axle +1.56, rear axle -1.44
  xFront: 1.56,
  xRear: -1.44,
  halfTrack: 0.863,
  wheelRadius: 0.36,
  mass: 2300,
  sprungMass: 2120,
  unsprungMass: 45, // per corner
  hCG: 0.5,
  rollArm: 0.4, // CG above roll axis
  pitchArm: 0.45, // CG above pitch (anti-dive) centre
  Ix: 800,
  Iy: 3800,
  wheelInertia: 1.3,
  maxPowerW: 1138e3,
  maxDriveForce: 26000,
  vMax: 350 / 3.6,
  cdA: 0.62,
  clAFront: 0.15,
  clARear: 0.343, // total 0.493 m² -> ~285 kg downforce at 350 km/h
  rolling: 0.012,
  tireMu: 1.35, // dry performance tyre calibration, not a measured tyre curve
  corneringFront: 150000, // estimated axle cornering stiffness N/rad
  corneringRear: 180000,
  yawInertia: 4200, // estimated kg m²
};

export const SUSP = {
  k: 45000, // N/m per corner
  c: 4000, // N s/m per corner
  kTire: 300000,
  cTire: 1200,
  bumpTravel: 0.09,
  droopTravel: 0.08,
  stopK: 350000,
  actMax: 6000, // N per corner
  actBandwidthHz: 14,
};

export const KEYS = {
  accel: ['KeyW', 'ArrowUp'],
  brake: ['KeyS', 'ArrowDown'],
  ebrake: ['Space'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  toggleBrake: ['Digit1'],
  toggleSusp: ['Digit2'],
  xray: ['KeyX'],
  camera: ['KeyC'],
  ghost: ['KeyG'],
  reset: ['KeyR'],
  paint: ['KeyP'],
  hidePanels: ['Tab'],
};

export const DEFAULTS = {
  emb: false,
  activeSusp: false,
  ghost: false,
  xray: false,
};

export const TRACK_CFG = {
  roadHalfWidth: 6,
  curbOuter: 7.4,
  armcoD: 9.0,
  crashD: 7.9, // car edge (half width 1.08 m) reaches the Armco at 9.0 m
  laneCenters: [-4, 0, 4] as const,
};

export const PHYSICS_HZ = 120;
export const PHYS_DT = 1 / PHYSICS_HZ;
