// Visual theme: every color and size the renderer and UI chrome use, so the
// look can be tuned in one place. World sizes are in world pixels; one map cell
// is `cell` world pixels on a side. Colors are CSS hex strings, which Pixi and
// CSS both accept.

import type { CppBand, StreetClass } from '../sim/types';

export interface RoofColors {
  roof: string;
  ridge: string;
}

export interface AwningColors {
  stripe: string;
  base: string;
}

export interface Theme {
  name: string;
  fonts: {
    /** Display face for numbers, titles and map labels. */
    display: string;
    /** Body face for UI text. */
    ui: string;
  };
  /** World pixels per map cell. */
  cell: number;
  board: {
    /** Page/canvas background around the board. */
    background: string;
    grass: string;
    /** Flat offset shadow under the board edge. */
    shadow: string;
    shadowOffset: number;
    /** Grass margin around the map, in cells. */
    margin: number;
    radius: number;
  };
  lot: {
    lawn: string;
    /** Parking/plaza paving for shops and apartments. */
    plaza: string;
    parkingLine: string;
    radius: number;
    /** Gap between a lot and the curb. */
    curbGap: number;
    /** Gap between neighboring lots. */
    sideGap: number;
  };
  road: {
    fill: string;
    /** Thin curb outline that separates the road from grass. */
    edge: string;
    edgeWidth: number;
    centerLine: string;
    centerLineWidth: number;
    width: Record<StreetClass, number>;
    dash: number;
    gap: number;
    /** Dead-end bulb radius as a multiple of the road half-width. */
    culDeSac: number;
  };
  house: {
    shadow: string;
    shadowOffset: [number, number];
    radius: number;
    ridgeWidth: number;
    /** Roof edge line, in the ridge color, that gives houses a crisp toy edge. */
    outline: number;
    /** Front path from door to curb. */
    path: string;
    /** Doorstep at the front door and the walkway notch at the curb (the home's serving side). */
    doorstep: string;
    unserved: RoofColors;
    passed: RoofColors;
    subscriber: RoofColors & { sparkle: string };
  };
  mdu: {
    roof: string;
    roofEdge: string;
    pip: string;
    /** Pips of subscribing units (later milestones). */
    pipLit: string;
    passedRing: string;
    radius: number;
  };
  /** MDU building tells: the demarc box on the serving wall and the dashed fiber entry to the curb. */
  demarc: {
    box: string;
    edge: string;
    entry: string;
    /** Box edge length (world px). */
    size: number;
    /** Ring around the drop point of buildings a planned route would serve. */
    emphasis: string;
  };
  smb: {
    front: string;
    frontEdge: string;
    awningServed: AwningColors;
    awningPassed: AwningColors;
    awningUnserved: AwningColors;
    radius: number;
  };
  tree: {
    body: string;
    highlight: string;
    shadow: string;
    minRadius: number;
    maxRadius: number;
    /** Chance a free cell gets trees. */
    density: number;
  };
  co: {
    body: string;
    side: string;
    band: string;
    dish: string;
    label: string;
    width: number;
    height: number;
    radius: number;
    depth: number;
    labelSize: number;
  };
  cabinet: {
    body: string;
    border: string;
    light: string;
    glow: string;
    dimBody: string;
    dimBorder: string;
    dimLight: string;
    size: number;
    radius: number;
    /** Splitter-count badge. */
    badge: string;
    badgeText: string;
    badgeRadius: number;
    /** Ring around a cabinet that is turning signups away (no free splitter port). */
    full: string;
  };
  cable: {
    underground: { tube: string; highlight: string; width: number };
    aerial: { tube: string; highlight: string; width: number; pole: string; poleRim: string; poleRadius: number };
    permitting: { alpha: number; width: number; dash: number; gap: number; badge: string; badgeRadius: number };
    constructing: {
      tube: string;
      stripe: string;
      stripeLength: number;
      /** Stripe drift speed, world px per second. */
      stripeSpeed: number;
      crew: string;
      crewCab: string;
      crewWheel: string;
    };
    /** Fiber cut burst (outages arrive in a later milestone). */
    cut: { burst: string; core: string };
    /** Wash over live cable that reaches the CO but no cabinet's reach (it lights nothing). */
    dim: { color: string; alpha: number };
  };
  /** Rocky ground under a street: a subtle stipple, emphasized while planning underground runs. */
  rock: { stipple: string; alpha: number; strong: string; strongAlpha: number };
  /** Cabinet tool shading: placement preview and existing cabinets' coverage. */
  coverage: {
    /** In-reach streets of a planned cabinet (once cabled), strongest near it. */
    reach: string;
    reachAlphaNear: number;
    reachAlphaFar: number;
    /** Streets a planned cabinet would light on today's cable: a solid band and a glowing centre line. */
    litToday: string;
    litTodayAlpha: number;
    litGlow: string;
    /** Streets another cabinet already serves: a muted hatch. */
    elsewhere: string;
    /** Existing cabinets' lit streets, one tint per cabinet (cycled). */
    tints: string[];
    tintAlpha: number;
    /** Faint dashed outline of every existing cabinet's street reach. */
    outlineAlpha: number;
  };
  /** The $/ft cost overlay (band colors come from `cpp`). */
  costOverlay: { none: string; alpha: number; width: number };
  overlay: {
    snapRing: string;
    snapFill: string;
    remove: string;
    blocked: string;
  };
  /**
   * Cost-per-passing band colors (quote card, cabinet preview, $/ft overlay,
   * report panel). Shared by map and DOM; themeCss publishes them as
   * --cpp-green / --cpp-amber / --cpp-red.
   */
  cpp: Record<CppBand, string>;
  ui: {
    page: string;
    card: string;
    cardBorder: string;
    shadow: string;
    shadowOffset: number;
    text: string;
    textSecondary: string;
    /** Brand coral for small decorations. */
    accent: string;
    /**
     * Active button fill. A shade deeper than accent so white label text keeps
     * a 4.5:1 contrast ratio.
     */
    active: string;
    activeShadow: string;
    activeText: string;
    chip: string;
    hover: string;
    danger: string;
    dangerBg: string;
    success: string;
    successBg: string;
    focus: string;
    radius: number;
    pillRadius: number;
    /** Minimum touch target. */
    touch: number;
    fontSize: number;
    numberSize: number;
  };
}

export const toyTown: Theme = {
  name: 'Toy Town',
  fonts: {
    display: 'Fredoka',
    ui: 'Nunito',
  },
  cell: 40,
  board: {
    background: '#F4F8EC',
    grass: '#CDE8B5',
    shadow: '#D3E0C3',
    shadowOffset: 14,
    margin: 1.5,
    radius: 36,
  },
  lot: {
    lawn: '#E3F1D2',
    plaza: '#EDE7D8',
    parkingLine: '#FFFFFF',
    radius: 6,
    curbGap: 3,
    sideGap: 1.5,
  },
  road: {
    fill: '#F6F0E2',
    edge: '#E2D6BA',
    edgeWidth: 1.5,
    centerLine: '#E6D9BC',
    centerLineWidth: 1.6,
    width: { arterial: 22, collector: 17, local: 13 },
    dash: 7,
    gap: 6,
    culDeSac: 1.7,
  },
  house: {
    shadow: '#C7DEB1',
    shadowOffset: [2.5, 3],
    radius: 3.5,
    ridgeWidth: 2,
    outline: 1.2,
    path: '#F6F0E2',
    doorstep: '#E2D6BA',
    unserved: { roof: '#E9E4DA', ridge: '#D6D0C3' },
    passed: { roof: '#F6B93B', ridge: '#DD9C1E' },
    subscriber: { roof: '#E8553A', ridge: '#C4402A', sparkle: '#FFFFFF' },
  },
  mdu: {
    roof: '#9FB4C7',
    roofEdge: '#8AA1B6',
    pip: '#C9D6E2',
    pipLit: '#E8553A',
    passedRing: '#F6B93B',
    radius: 7,
  },
  demarc: {
    box: '#0E7A6D',
    edge: '#FFFFFF',
    entry: '#6B8299',
    size: 6,
    emphasis: '#E8553A',
  },
  smb: {
    front: '#FBF7EE',
    frontEdge: '#E4DCCB',
    awningServed: { stripe: '#E8553A', base: '#FFFFFF' },
    awningPassed: { stripe: '#F6B93B', base: '#FFFFFF' },
    awningUnserved: { stripe: '#DCD6CA', base: '#FFFFFF' },
    radius: 3.5,
  },
  tree: {
    body: '#7CC25E',
    highlight: '#9AD67F',
    shadow: '#BFD9A6',
    minRadius: 6,
    maxRadius: 10.5,
    density: 0.55,
  },
  co: {
    body: '#0E7A6D',
    side: '#0A5C52',
    band: '#159282',
    dish: '#FFFFFF',
    label: '#FFFFFF',
    width: 60,
    height: 46,
    radius: 11,
    depth: 6,
    labelSize: 20,
  },
  cabinet: {
    body: '#0E7A6D',
    border: '#FFFFFF',
    light: '#7CF0DF',
    glow: '#7CF0DF',
    dimBody: '#93ABA7',
    dimBorder: '#F1F4F0',
    dimLight: '#D3DEDB',
    size: 19,
    radius: 5,
    badge: '#23303A',
    badgeText: '#FFFFFF',
    badgeRadius: 6.5,
    full: '#E11D48',
  },
  cable: {
    underground: { tube: '#0E7A6D', highlight: '#5FCDBF', width: 8 },
    aerial: {
      tube: '#8B6CFF',
      highlight: '#C2B3FF',
      width: 5,
      pole: '#8A5A33',
      poleRim: '#FFFFFF',
      poleRadius: 3.6,
    },
    permitting: { alpha: 0.55, width: 4, dash: 6, gap: 5, badge: '#FFFFFF', badgeRadius: 7 },
    constructing: {
      tube: '#F59E0B',
      stripe: '#FFFFFF',
      stripeLength: 5,
      stripeSpeed: 9,
      crew: '#F59E0B',
      crewCab: '#FFFFFF',
      crewWheel: '#23303A',
    },
    cut: { burst: '#E11D48', core: '#FFFFFF' },
    dim: { color: '#F6F0E2', alpha: 0.62 },
  },
  rock: { stipple: '#B9A88A', alpha: 0.55, strong: '#7D6A4E', strongAlpha: 0.9 },
  coverage: {
    // Toy Town teal (the CO and cabinet family), deep enough to read over the
    // cream roads and the pale lawns at the far band's alpha.
    reach: '#119384',
    reachAlphaNear: 0.62,
    reachAlphaFar: 0.22,
    litToday: '#0A5C52',
    litTodayAlpha: 0.78,
    litGlow: '#7CF0DF',
    elsewhere: '#8C99A8',
    tints: ['#0EA5A0', '#A855F7', '#F59E0B', '#EC4899', '#65A30D', '#F97316'],
    tintAlpha: 0.42,
    outlineAlpha: 0.38,
  },
  costOverlay: { none: '#C9C2B4', alpha: 1, width: 8 },
  overlay: {
    snapRing: '#E8553A',
    snapFill: '#FFFFFF',
    remove: '#E11D48',
    blocked: '#E11D48',
  },
  cpp: { green: '#16A34A', amber: '#D97706', red: '#DC2626' },
  ui: {
    page: '#F4F8EC',
    card: '#FFFFFF',
    cardBorder: '#E4ECD9',
    shadow: '#D3E0C3',
    shadowOffset: 3,
    text: '#23303A',
    textSecondary: '#5A6670',
    accent: '#E8553A',
    active: '#D0472C',
    activeShadow: '#A9361F',
    activeText: '#FFFFFF',
    chip: '#F1F6E8',
    hover: '#EAF2DE',
    danger: '#BE123C',
    dangerBg: '#FFE4E8',
    success: '#0E7A6D',
    successBg: '#DDF6F1',
    focus: '#0E7A6D',
    radius: 16,
    pillRadius: 999,
    touch: 44,
    fontSize: 15,
    numberSize: 17,
  },
};
