import type { Logger } from "pino";

import { isSystemOwnedAgentLabels } from "@getpaseo/protocol/mission-control/system-owned";

import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";

/**
 * Mission Control Identity: the daemon naming service.
 *
 * Every created agent gets a fun, stable, fleet-wide name from a curated pool
 * (theme from the central Mission Control config's `namingTheme`, default
 * "mixed"). Names are collision-avoiding per host against live + stored
 * agents. Plain pool names draw first; when a theme's pool is exhausted the
 * generator steps through "<Qualifier> <Name>" combos (a shared adjective
 * list × the theme pool, 2400+ per theme), and only if the entire combo
 * space is somehow exhausted does it fall back to Roman numerals
 * (" II", " III", ...).
 *
 * Names are write-once: assigned at creation (or by the boot backfill for
 * records that never got one) and never re-mapped. A `namingTheme` change
 * affects only future assignments.
 *
 * Agents labeled `paseo.mission-control=*` (the Commander and monitors) are
 * excluded — they are hidden from Mission Control, not part of its roster.
 */

// The label-key prefix marking system-owned agents lives in the shared
// protocol module (one definition for server filters and app surfaces).
export { MISSION_CONTROL_LABEL_PREFIX } from "@getpaseo/protocol/mission-control/system-owned";

export type AgentNamingTheme =
  | "mixed"
  | "indian"
  | "cartoon"
  | "scientists"
  | "astronauts"
  | "mythology"
  | "nature";

export const AGENT_NAMING_THEMES: readonly AgentNamingTheme[] = [
  "mixed",
  "indian",
  "cartoon",
  "scientists",
  "astronauts",
  "mythology",
  "nature",
];

// Curated pools: short, pronounceable, fun. `mixed` is the default and the
// only one that intentionally blends styles; the rest are themed.
const MIXED_POOL: readonly string[] = [
  "Ripley",
  "Bolt",
  "Pixel",
  "Waffle",
  "Miso",
  "Pickle",
  "Tango",
  "Zippy",
  "Mochi",
  "Biscuit",
  "Comet",
  "Doodle",
  "Ember",
  "Fizz",
  "Gizmo",
  "Harvey",
  "Iris",
  "Juno",
  "Kilo",
  "Lumen",
  "Moxie",
  "Noodle",
  "Onyx",
  "Pip",
  "Quill",
  "Rascal",
  "Sable",
  "Taco",
  "Uno",
  "Vesper",
  "Wicket",
  "Xylo",
  "Yonder",
  "Ziggy",
  "Apollo",
  "Basil",
  "Cedar",
  "Delta",
  "Echo",
  "Fable",
  "Ginger",
  "Halo",
  "Iggy",
  "Jasper",
  "Kite",
  "Loki",
  "Mango",
  "Nova",
  "Ollie",
  "Pepper",
  "Quest",
  "Remy",
  "Sasha",
  "Toby",
  "Ursa",
  "Vega",
  "Willow",
  "Xena",
  "Yuki",
  "Zola",
  "Ace",
  "Beans",
  "Coco",
  "Duke",
  "Eddie",
  "Frankie",
  "Gus",
  "Hank",
  "Ivy",
  "Jojo",
  "Kiki",
  "Lou",
  "Mia",
  "Nico",
  "Ozzy",
  "Pia",
  "Quincy",
  "Rex",
  "Suki",
  "Theo",
  "Uma",
  "Vince",
  "Winnie",
  "Xavi",
  "Yara",
  "Zeke",
  "Arlo",
  "Bella",
  "Chip",
  "Dot",
  "Elio",
  "Finn",
  "Gem",
  "Hazel",
  "Indy",
  "Jett",
  "Koda",
  "Luna",
  "Milo",
  "Nell",
  "Otto",
  "Pippin",
  "Rio",
  "Sage",
  "Tilly",
  "Ugo",
  "Vito",
  "Wren",
  "Xander",
  "Yves",
  "Zinnia",
  "Aria",
  "Bodhi",
  "Cleo",
  "Dex",
  "Eden",
  "Faye",
  "Grey",
  "Hugo",
  "Ines",
  "Jude",
  "Kea",
  "Lane",
  "Mara",
  "Nash",
  "Ori",
  "Pax",
  "Rue",
  "Soren",
  "True",
  "Umber",
  "Vale",
  "Wes",
  "Xio",
  "Yael",
  "Zed",
  "Ash",
  "Blue",
  "Cruz",
  "Dove",
  "Earl",
  "Fox",
  "Gale",
  "Holt",
  "Ira",
  "Jax",
  "Kip",
  "Lux",
  "Moss",
  "Nyx",
  "Odin",
  "Poe",
  "Quinn",
  "Rook",
  "Slate",
  "Tess",
  "Ulan",
  "Voss",
  "Wade",
  "Yale",
  "Aero",
  "Brio",
  "Cal",
  "Drift",
  "Elm",
  "Frost",
  "Grove",
  "Hale",
  "Ink",
  "Jolt",
  "Kestrel",
  "Lyra",
  "Maple",
  "North",
  "Orbit",
  "Pine",
  "Quake",
  "Reef",
  "Storm",
  "Tide",
  "Umbra",
  "Volt",
  "Wisp",
  "Zephyr",
  "Alto",
  "Bree",
  "Cove",
  "Dusk",
  "Elan",
  "Fawn",
  "Glen",
  "Haven",
  "Isla",
  "Juniper",
  "Kai",
  "Lark",
  "Marin",
  "Nimbus",
  "Oasis",
  "Pebble",
  "Ridge",
  "Thorne",
  "Upland",
  "Yarrow",
  "Alder",
  "Bramble",
] as const;

const INDIAN_POOL: readonly string[] = [
  "Arjun",
  "Meera",
  "Kiran",
  "Aditi",
  "Rohan",
  "Priya",
  "Vikram",
  "Ananya",
  "Dev",
  "Nisha",
  "Kabir",
  "Tara",
  "Sameer",
  "Aisha",
  "Ravi",
  "Leela",
  "Sanjay",
  "Divya",
  "Mohan",
  "Asha",
  "Nikhil",
  "Pooja",
  "Varun",
  "Sita",
  "Gopal",
  "Radha",
  "Amit",
  "Kavya",
  "Rakesh",
  "Anjali",
  "Siddharth",
  "Lakshmi",
  "Karan",
  "Sunita",
  "Arnav",
  "Bharti",
  "Chetan",
  "Deepika",
  "Esha",
  "Farhan",
  "Gauri",
  "Harsh",
  "Ishaan",
  "Jaya",
  "Kartik",
  "Lata",
  "Madhav",
  "Neha",
  "Om",
  "Parvati",
  "Rohit",
  "Shreya",
  "Tanish",
  "Usha",
  "Vihaan",
  "Yash",
  "Zoya",
  "Akash",
  "Bhavna",
  "Charu",
  "Danish",
  "Ekta",
  "Firoz",
  "Gayatri",
  "Hema",
  "Irfan",
  "Jyoti",
  "Kamal",
  "Lalit",
  "Meghna",
  "Naveen",
  "Ojas",
  "Pankaj",
  "Ritu",
  "Shaan",
  "Tanvi",
  "Uday",
  "Vaibhav",
  "Wasim",
  "Yuvraj",
] as const;

const CARTOON_POOL: readonly string[] = [
  "Mickey",
  "Minnie",
  "Donald",
  "Daisy",
  "Goofy",
  "Pluto",
  "Bugs",
  "Daffy",
  "Porky",
  "Tweety",
  "Sylvester",
  "Scooby",
  "Shaggy",
  "Velma",
  "Daphne",
  "Freddy",
  "Barney",
  "Pebbles",
  "BammBamm",
  "Tom",
  "Jerry",
  "Spike",
  "Garfield",
  "Odie",
  "Snoopy",
  "Charlie",
  "Linus",
  "Lucy",
  "Woodstock",
  "Popeye",
  "Olive",
  "Bluto",
  "Homer",
  "Bart",
  "Lisa",
  "Marge",
  "Maggie",
  "SpongeBob",
  "Patrick",
  "Squidward",
  "Sandy",
  "Plankton",
  "Dora",
  "Boots",
  "Diego",
  "Pikachu",
  "Ash",
  "Misty",
  "Brock",
  "Sonic",
  "Tails",
  "Knuckles",
  "Mario",
  "Luigi",
  "Peach",
  "Toad",
  "Yoshi",
  "Wario",
  "Shrek",
  "Donkey",
  "Fiona",
  "Puss",
  "Gumball",
  "Darwin",
  "Mordecai",
  "Rigby",
  "Finn",
  "Jake",
  "BMO",
  "Steven",
  "Connie",
  "Garnet",
  "Pearl",
  "Perry",
  "Phineas",
  "Ferb",
  "Candace",
  "Kim",
  "Ron",
  "Rufus",
] as const;

const SCIENTISTS_POOL: readonly string[] = [
  "Einstein",
  "Newton",
  "Curie",
  "Darwin",
  "Tesla",
  "Edison",
  "Galileo",
  "Kepler",
  "Bohr",
  "Fermi",
  "Planck",
  "Heisenberg",
  "Schrodinger",
  "Rutherford",
  "Faraday",
  "Maxwell",
  "Lavoisier",
  "Pasteur",
  "Mendel",
  "Franklin",
  "Turing",
  "Lovelace",
  "Babbage",
  "Hopper",
  "Hamilton",
  "Feynman",
  "Dirac",
  "Born",
  "Pauli",
  "Boltzmann",
  "Kelvin",
  "Joule",
  "Watt",
  "Ohm",
  "Volta",
  "Ampere",
  "Coulomb",
  "Hertz",
  "Hubble",
  "Halley",
  "Copernicus",
  "Archimedes",
  "Euclid",
  "Pythagoras",
  "Aristotle",
  "Plato",
  "Bacon",
  "Descartes",
  "Leibniz",
  "Euler",
  "Gauss",
  "Riemann",
  "Hilbert",
  "Godel",
  "Noether",
  "Ada",
  "Grace",
  "Marie",
  "Rosalind",
  "Katherine",
  "Lise",
  "Vera",
  "Barbara",
  "Jane",
  "Dian",
  "Sylvia",
  "Rachel",
  "Carl",
  "Neil",
  "Brian",
  "Stephen",
  "Richard",
  "Niels",
  "Erwin",
  "Werner",
  "Enrico",
  "James",
  "Edwin",
  "Alan",
  "Francis",
] as const;

const ASTRONAUTS_POOL: readonly string[] = [
  "Armstrong",
  "Aldrin",
  "Collins",
  "Shepard",
  "Grissom",
  "Glenn",
  "Lovell",
  "Borman",
  "Anders",
  "Cernan",
  "Young",
  "Stafford",
  "Bean",
  "Conrad",
  "Mitchell",
  "Irwin",
  "Duke",
  "Schmitt",
  "Haise",
  "Swigert",
  "Mattingly",
  "Roosa",
  "Worden",
  "Schirra",
  "White",
  "Chaffee",
  "Ride",
  "Resnik",
  "Jemison",
  "Ochoa",
  "Whitson",
  "Melroy",
  "Kelly",
  "Hurley",
  "Behnken",
  "Hague",
  "Koch",
  "Rubins",
  "Meir",
  "Mann",
  "Garan",
  "Fossum",
  "Pettit",
  "Barratt",
  "Nyberg",
  "Wakata",
  "Hoshide",
  "Mukai",
  "Tereshkova",
  "Gagarin",
  "Leonov",
  "Titov",
  "Komarov",
  "Volkov",
  "Krikalev",
  "Polyakov",
  "Savitskaya",
  "Kondakova",
  "Eisele",
  "Chawla",
] as const;

const MYTHOLOGY_POOL: readonly string[] = [
  "Zeus",
  "Hera",
  "Athena",
  "Apollo",
  "Artemis",
  "Ares",
  "Aphrodite",
  "Hermes",
  "Hestia",
  "Demeter",
  "Hades",
  "Persephone",
  "Hephaestus",
  "Dionysus",
  "Eros",
  "Nike",
  "Iris",
  "Selene",
  "Helios",
  "Atlas",
  "Prometheus",
  "Pandora",
  "Medusa",
  "Perseus",
  "Theseus",
  "Hercules",
  "Achilles",
  "Hector",
  "Odysseus",
  "Ajax",
  "Nestor",
  "Priam",
  "Paris",
  "Helen",
  "Cassandra",
  "Andromeda",
  "Pegasus",
  "Cerberus",
  "Hydra",
  "Chimera",
  "Minotaur",
  "Sphinx",
  "Griffin",
  "Phoenix",
  "Titan",
  "Cronus",
  "Rhea",
  "Uranus",
  "Gaia",
  "Oceanus",
  "Hyperion",
  "Themis",
  "Eos",
  "Nyx",
  "Erebus",
  "Thanatos",
  "Hypnos",
  "Morpheus",
  "Nemesis",
  "Tyche",
  "Odin",
  "Thor",
  "Loki",
  "Freya",
  "Freyr",
  "Tyr",
  "Baldur",
  "Heimdall",
  "Njord",
  "Sif",
  "Idun",
  "Frigg",
  "Hel",
  "Mimir",
  "Ymir",
  "Surtr",
  "Skadi",
  "Ganesha",
  "Hanuman",
  "Krishna",
] as const;

const NATURE_POOL: readonly string[] = [
  "Willow",
  "Fern",
  "Hazel",
  "Ivy",
  "Juniper",
  "Aspen",
  "Birch",
  "Cedar",
  "Alder",
  "Rowan",
  "Maple",
  "Laurel",
  "Olive",
  "Rose",
  "Lily",
  "Daisy",
  "Violet",
  "Iris",
  "Poppy",
  "Clover",
  "Heather",
  "Briar",
  "Meadow",
  "Brooke",
  "River",
  "Skye",
  "Storm",
  "Rain",
  "Snow",
  "Frost",
  "Ember",
  "Flint",
  "Stone",
  "Pebble",
  "Canyon",
  "Ridge",
  "Summit",
  "Glacier",
  "Tundra",
  "Prairie",
  "Savanna",
  "Marsh",
  "Delta",
  "Reef",
  "Lagoon",
  "Cove",
  "Harbor",
  "Comet",
  "Nova",
  "Aurora",
  "Sol",
  "Luna",
  "Stella",
  "Wren",
  "Robin",
  "Sparrow",
  "Falcon",
  "Hawk",
  "Raven",
  "Kestrel",
] as const;

export const NAME_POOLS: Record<AgentNamingTheme, readonly string[]> = {
  mixed: MIXED_POOL,
  indian: INDIAN_POOL,
  cartoon: CARTOON_POOL,
  scientists: SCIENTISTS_POOL,
  astronauts: ASTRONAUTS_POOL,
  mythology: MYTHOLOGY_POOL,
  nature: NATURE_POOL,
};

/**
 * Qualifier adjectives for the overflow tier. Combined with a theme's pool
 * they yield "Qualifier Name" combos ("Swift Ripley"): 40 qualifiers × the
 * smallest pool (60) is 2400 combos per theme, so plain names keep their
 * current aesthetic and Roman numerals remain the fallback of last resort.
 */
export const NAME_QUALIFIERS: readonly string[] = [
  "Swift",
  "Brave",
  "Calm",
  "Daring",
  "Eager",
  "Fleet",
  "Grim",
  "Hale",
  "Iron",
  "Jolly",
  "Keen",
  "Lucky",
  "Mighty",
  "Nimble",
  "Odd",
  "Proud",
  "Quick",
  "Rusty",
  "Silent",
  "Tidy",
  "Urgent",
  "Valiant",
  "Wise",
  "Zesty",
  "Agile",
  "Bold",
  "Crafty",
  "Dapper",
  "Earnest",
  "Fearless",
  "Gleaming",
  "Honest",
  "Jovial",
  "Kind",
  "Lively",
  "Merry",
  "Noble",
  "Quirky",
  "Resolute",
  "Slick",
] as const;

export function normalizeNamingTheme(value: unknown): AgentNamingTheme {
  if (typeof value === "string" && (NAME_POOLS as Record<string, readonly string[]>)[value]) {
    return value as AgentNamingTheme;
  }
  return "mixed";
}

export interface AgentNamingServiceOptions {
  agentStorage: AgentStorage;
  getAgentManager: () => Pick<AgentManager, "listAgents" | "setAgentName">;
  readTheme: () => unknown;
  logger: Logger;
}

export interface AgentCreatedIdentityInput {
  agentId: string;
  labels: Record<string, string>;
  internal: boolean;
}

const ROMAN_SUFFIXES = ["II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"] as const;

export class AgentNamingService {
  private readonly agentStorage: AgentStorage;
  private readonly getAgentManager: () => Pick<AgentManager, "listAgents" | "setAgentName">;
  private readonly readTheme: () => unknown;
  private readonly logger: Logger;

  constructor(options: AgentNamingServiceOptions) {
    this.agentStorage = options.agentStorage;
    this.getAgentManager = options.getAgentManager;
    this.readTheme = options.readTheme;
    this.logger = options.logger.child({ module: "mission-control", component: "naming" });
  }

  /**
   * Hook for AgentManager.onAgentCreated: returns a fresh collision-free name
   * for a brand-new agent, or null when the agent should stay unnamed
   * (mission-control labeled agents, internal agents, exhausted pools).
   */
  async assignNameForCreatedAgent(input: AgentCreatedIdentityInput): Promise<string | null> {
    if (input.internal || hasMissionControlLabels(input.labels)) {
      return null;
    }
    const used = await this.collectUsedNames();
    const name = this.pickName(this.currentTheme(), used);
    if (!name) {
      this.logger.warn({ agentId: input.agentId }, "Naming pool exhausted; agent left unnamed");
      return null;
    }
    this.logger.info({ agentId: input.agentId, name }, "Assigned agent name");
    return name;
  }

  /**
   * Boot backfill: assign a name to every stored agent that never got one
   * (names are write-once, so named records are never touched). Returns the
   * count of agents named.
   */
  async backfillMissingNames(): Promise<number> {
    const records = await this.agentStorage.list();
    const missing = records.filter(
      (record) => !record.name && !record.internal && !hasMissionControlLabels(record.labels),
    );
    if (missing.length === 0) {
      return 0;
    }
    const used = await this.collectUsedNames();
    const theme = this.currentTheme();
    let assigned = 0;
    for (const record of missing) {
      const name = this.pickName(theme, used);
      if (!name) {
        break;
      }
      used.add(name);
      await this.getAgentManager().setAgentName(record.id, name);
      assigned += 1;
    }
    if (assigned > 0) {
      this.logger.info({ assigned }, "Backfilled missing agent names");
    }
    return assigned;
  }

  private currentTheme(): AgentNamingTheme {
    return normalizeNamingTheme(this.readTheme());
  }

  private async collectUsedNames(): Promise<Set<string>> {
    const used = new Set<string>();
    const agentManager = this.getAgentManager();
    for (const agent of agentManager.listAgents()) {
      if (agent.name) {
        used.add(agent.name);
      }
    }
    for (const record of await this.agentStorage.list()) {
      if (record.name) {
        used.add(record.name);
      }
    }
    return used;
  }

  /**
   * Shuffled first unused pool name; when the whole pool is taken, walks
   * qualifier+name combos ("Swift Ripley") before falling back to
   * Roman-numeral suffixes off the first name ("Ripley II", ...) only when
   * the entire combo space is exhausted.
   */
  private pickName(theme: AgentNamingTheme, used: ReadonlySet<string>): string | null {
    const pool = NAME_POOLS[theme];
    const candidates = shuffle(pool.slice());
    for (const candidate of candidates) {
      if (!used.has(candidate)) {
        return candidate;
      }
    }
    const base = candidates[0];
    if (!base) {
      return null;
    }
    for (const qualifier of shuffle(NAME_QUALIFIERS.slice())) {
      for (const name of candidates) {
        const candidate = `${qualifier} ${name}`;
        if (!used.has(candidate)) {
          return candidate;
        }
      }
    }
    for (const suffix of ROMAN_SUFFIXES) {
      const candidate = `${base} ${suffix}`;
      if (!used.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }
}

/**
 * Server-side name for the shared system-owned predicate: true when the agent
 * carries ANY `paseo.mission-control*` label (Commander, verifiers, machinery
 * artifacts). One definition decides system-owned — the protocol module owns
 * the logic, every surface consumes it.
 */
export function hasMissionControlLabels(labels: Record<string, string> | undefined): boolean {
  return isSystemOwnedAgentLabels(labels);
}

function shuffle<T>(values: T[]): T[] {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
