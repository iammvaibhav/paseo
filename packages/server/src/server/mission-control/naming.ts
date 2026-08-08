import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";

/**
 * Mission Control Identity: the daemon naming service.
 *
 * Every created agent gets a fun, stable, fleet-wide name from a curated pool
 * (theme from the central Mission Control config's `namingTheme`, default
 * "mixed"). Names are collision-avoiding per host against live + stored
 * agents; when a theme's pool is exhausted the suffix walks Roman numerals
 * (" II", " III", ...).
 *
 * Agents labeled `paseo.mission-control=*` (the Commander and monitors) are
 * excluded — they are hidden from Mission Control, not part of its roster.
 */

export const MISSION_CONTROL_LABEL_PREFIX = "paseo.mission-control";

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

const NAME_POOLS: Record<AgentNamingTheme, readonly string[]> = {
  mixed: MIXED_POOL,
  indian: INDIAN_POOL,
  cartoon: CARTOON_POOL,
  scientists: SCIENTISTS_POOL,
  astronauts: ASTRONAUTS_POOL,
  mythology: MYTHOLOGY_POOL,
  nature: NATURE_POOL,
};

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
const ROMAN_SUFFIX_RE = / (II|III|IV|V|VI|VII|VIII|IX|X)$/;

/** Every curated pool name across all themes, for auto-assignment detection. */
const ALL_POOL_NAMES: ReadonlySet<string> = new Set(Object.values(NAME_POOLS).flat());

/**
 * A name is auto-assigned when it comes from one of the curated theme pools
 * (optionally with a Roman-numeral suffix from pool exhaustion). Anything
 * else — sentence-like names, personal names, project names — is treated as
 * user-set and never touched by theme re-maps.
 */
export function isAutoAssignedName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) {
    return false;
  }
  if (ALL_POOL_NAMES.has(trimmed)) {
    return true;
  }
  const base = trimmed.replace(ROMAN_SUFFIX_RE, "");
  return base !== trimmed && ALL_POOL_NAMES.has(base);
}

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

  /** Backfill: assign a name to every stored agent that lacks one. Returns the count. */
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

  /**
   * Instant theme re-map (spec: "theme switch re-maps all auto-assigned names
   * server-side immediately and broadcasts agent_update"). Renames every
   * auto-assigned name to the current theme's pool — deterministic
   * (pool order, agents sorted by id), collision-avoiding against live +
   * stored names, and leaves user-set names (anything not from a curated
   * pool) untouched. A name already in the target pool is kept as-is to
   * avoid churn. Renames go through AgentManager.setAgentName, which
   * broadcasts `agent_update` for live agents through the standard pipeline;
   * stored-only (closed, unarchived) agents are updated in storage and
   * picked up on the client's next fetch. Returns the rename count.
   */
  async remapAllNames(): Promise<number> {
    const theme = this.currentTheme();
    const candidates = await this.collectRemapCandidates();
    if (candidates.length === 0) {
      return 0;
    }
    const used = await this.collectUsedNames();
    let renamed = 0;
    for (const candidate of candidates) {
      if (NAME_POOLS[theme].includes(candidate.name)) {
        continue;
      }
      const next = this.pickNameDeterministic(theme, used);
      if (!next) {
        break;
      }
      used.add(next);
      await this.getAgentManager().setAgentName(candidate.agentId, next);
      renamed += 1;
    }
    this.logger.info({ theme, renamed }, "Re-mapped auto-assigned agent names");
    return renamed;
  }

  /** Auto-assigned, non-archived, non-machinery agents, sorted for determinism. */
  private async collectRemapCandidates(): Promise<Array<{ agentId: string; name: string }>> {
    const byId = new Map<string, { agentId: string; name: string }>();
    for (const record of await this.agentStorage.list()) {
      if (record.archivedAt || record.internal || hasMissionControlLabels(record.labels)) {
        continue;
      }
      if (!record.name) {
        continue;
      }
      byId.set(record.id, { agentId: record.id, name: record.name });
    }
    for (const agent of this.getAgentManager().listAgents()) {
      if (agent.internal || hasMissionControlLabels(agent.labels)) {
        continue;
      }
      if (!agent.name) {
        continue;
      }
      byId.set(agent.id, { agentId: agent.id, name: agent.name });
    }
    return [...byId.values()]
      .filter((entry) => isAutoAssignedName(entry.name))
      .sort((left, right) => left.agentId.localeCompare(right.agentId));
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
   * Roman-numeral suffixes off the first name ("Ripley II", "Ripley III", ...).
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
    for (const suffix of ROMAN_SUFFIXES) {
      const candidate = `${base} ${suffix}`;
      if (!used.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Deterministic variant used by theme re-maps: pool order instead of a
   * random shuffle, so a re-map is reproducible for the same agent set.
   */
  private pickNameDeterministic(theme: AgentNamingTheme, used: ReadonlySet<string>): string | null {
    const pool = NAME_POOLS[theme];
    for (const candidate of pool) {
      if (!used.has(candidate)) {
        return candidate;
      }
    }
    const base = pool[0];
    if (!base) {
      return null;
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

export function hasMissionControlLabels(labels: Record<string, string>): boolean {
  return Object.keys(labels).some((key) => key.startsWith(MISSION_CONTROL_LABEL_PREFIX));
}

function shuffle<T>(values: T[]): T[] {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
