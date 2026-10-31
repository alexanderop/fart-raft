// A rider's look: animal, color, hat, outfit and gadget. Plain data shared by the menus, the
// renderer, the wire protocol and the server, so no DOM, no Three and no Effect here.

/** Rider colors: saturated hues, so tinting an animal keeps its shading. The first eight are the seat colors. */
export const LOOK_COLORS = [
  "#ff8a3d",
  "#3d9bff",
  "#b07cff",
  "#ffd23f",
  "#ff4fb0",
  "#5ee9ff",
  "#b8f53b",
  "#ff4a4a",
  "#2fd17a",
  "#1fbfae",
  "#5b6cff",
  "#d24dff",
] as const;

export const ANIMALS = ["capybara", "hippo", "croc", "lobster"] as const;
export const HATS = [
  "none",
  "police",
  "nurse",
  "firefighter",
  "chef",
  "pirate",
  "crown",
  "tophat",
  "cowboy",
  "party",
  "viking",
  "bunny",
  "propeller",
  "halo",
] as const;
export const OUTFITS = [
  "none",
  "police",
  "nurse",
  "doctor",
  "firefighter",
  "chef",
  "pirate",
  "superhero",
  "prisoner",
  "tuxedo",
  "hula",
  "astronaut",
] as const;
export const GADGETS = [
  "none",
  "shades",
  "mustache",
  "monocle",
  "stethoscope",
  "bowtie",
  "flower",
  "snorkel",
  "headphones",
] as const;

export type Animal = (typeof ANIMALS)[number];
export type Hat = (typeof HATS)[number];
export type Outfit = (typeof OUTFITS)[number];
export type Gadget = (typeof GADGETS)[number];

/** `color` indexes LOOK_COLORS. */
export type Look = { animal: Animal; color: number; hat: Hat; outfit: Outfit; gadget: Gadget };

export const ANIMAL_LABELS: Record<Animal, string> = {
  capybara: "🦫 Capybara",
  hippo: "🦛 Hippo",
  croc: "🐊 Croc",
  lobster: "🦞 Lobster",
};

export const HAT_LABELS: Record<Hat, string> = {
  none: "❌ None",
  police: "👮 Police cap",
  nurse: "➕ Nurse cap",
  firefighter: "🚒 Fire helmet",
  chef: "👨‍🍳 Chef hat",
  pirate: "🏴‍☠️ Pirate hat",
  crown: "👑 Crown",
  tophat: "🎩 Top hat",
  cowboy: "🤠 Cowboy hat",
  party: "🥳 Party hat",
  viking: "⚔️ Viking helmet",
  bunny: "🐰 Bunny ears",
  propeller: "🧢 Propeller cap",
  halo: "😇 Halo",
};

export const OUTFIT_LABELS: Record<Outfit, string> = {
  none: "❌ None",
  police: "👮 Police",
  nurse: "🏥 Nurse",
  doctor: "🥼 Doctor",
  firefighter: "🧯 Firefighter",
  chef: "🍳 Chef",
  pirate: "🦜 Pirate",
  superhero: "🦸 Superhero",
  prisoner: "⛓️ Prisoner",
  tuxedo: "🤵 Tuxedo",
  hula: "🌺 Hula",
  astronaut: "🚀 Astronaut",
};

export const GADGET_LABELS: Record<Gadget, string> = {
  none: "❌ None",
  shades: "😎 Shades",
  mustache: "🥸 Mustache",
  monocle: "🧐 Monocle",
  stethoscope: "🩺 Stethoscope",
  bowtie: "🎀 Bow tie",
  flower: "🌸 Flower",
  snorkel: "🤿 Snorkel",
  headphones: "🎧 Headphones",
};

/** One-click full costumes: hat, outfit and gadget that belong together. */
export const COSTUMES: readonly { label: string; hat: Hat; outfit: Outfit; gadget: Gadget }[] = [
  { label: "👮 Police", hat: "police", outfit: "police", gadget: "shades" },
  { label: "🏥 Nurse", hat: "nurse", outfit: "nurse", gadget: "stethoscope" },
  { label: "🥼 Doctor", hat: "none", outfit: "doctor", gadget: "stethoscope" },
  { label: "🚒 Firefighter", hat: "firefighter", outfit: "firefighter", gadget: "mustache" },
  { label: "👨‍🍳 Chef", hat: "chef", outfit: "chef", gadget: "mustache" },
  { label: "🏴‍☠️ Pirate", hat: "pirate", outfit: "pirate", gadget: "monocle" },
  { label: "🦸 Superhero", hat: "none", outfit: "superhero", gadget: "shades" },
  { label: "⛓️ Prisoner", hat: "none", outfit: "prisoner", gadget: "mustache" },
  { label: "🤵 Fancy", hat: "tophat", outfit: "tuxedo", gadget: "monocle" },
  { label: "🌺 Hula", hat: "none", outfit: "hula", gadget: "flower" },
  { label: "🚀 Astronaut", hat: "none", outfit: "astronaut", gadget: "headphones" },
];

/** The animal the kit sits on seat `i` (rear-left capybara, two hippos, front-right croc). */
const SEAT_ANIMALS: readonly Animal[] = ["capybara", "hippo", "hippo", "croc"];

/** What a seat looks like until its player picks: the kit's animal in the seat's color, nothing worn. */
export const defaultLook = (seat: number): Look => ({
  animal: SEAT_ANIMALS[seat % SEAT_ANIMALS.length]!,
  color: seat % LOOK_COLORS.length,
  hat: "none",
  outfit: "none",
  gadget: "none",
});

export const lookColor = (look: Look): string => LOOK_COLORS[look.color] ?? LOOK_COLORS[0];

const oneOf = <T extends string>(values: readonly T[], v: unknown, fallback: T): T =>
  values.find((x) => x === v) ?? fallback;

/** Anything (saved JSON, a hand-edited value) as a Look: unknown fields fall back to `seat`'s default. */
export function parseLook(raw: unknown, seat = 0): Look {
  const base = defaultLook(seat);
  if (typeof raw !== "object" || raw === null) return base;
  const at = (key: string): unknown => Reflect.get(raw, key);
  const color = at("color");
  return {
    animal: oneOf(ANIMALS, at("animal"), base.animal),
    color:
      typeof color === "number" &&
      Number.isInteger(color) &&
      color >= 0 &&
      color < LOOK_COLORS.length
        ? color
        : base.color,
    hat: oneOf(HATS, at("hat"), base.hat),
    outfit: oneOf(OUTFITS, at("outfit"), base.outfit),
    gadget: oneOf(GADGETS, at("gadget"), base.gadget),
  };
}

/** A random look; `random` returns [0, 1). */
export function randomLook(random: () => number = Math.random): Look {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
  return {
    animal: pick(ANIMALS),
    color: Math.floor(random() * LOOK_COLORS.length),
    hat: pick(HATS),
    outfit: pick(OUTFITS),
    gadget: pick(GADGETS),
  };
}

/** Short summary for lists: the worn items' emoji, or the animal's when nothing is worn. */
const emoji = (label: string) => label.split(" ")[0]!;

export function lookBadge(look: Look): string {
  const worn = [
    look.hat !== "none" ? emoji(HAT_LABELS[look.hat]) : "",
    look.outfit !== "none" ? emoji(OUTFIT_LABELS[look.outfit]) : "",
    look.gadget !== "none" ? emoji(GADGET_LABELS[look.gadget]) : "",
  ].join("");
  return worn || emoji(ANIMAL_LABELS[look.animal]);
}

export const sameLook = (a: Look, b: Look): boolean =>
  a.animal === b.animal &&
  a.color === b.color &&
  a.hat === b.hat &&
  a.outfit === b.outfit &&
  a.gadget === b.gadget;
