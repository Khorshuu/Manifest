/**
 * Words that judge rather than state (D-128). Each is allowed only where the
 * product's established facts use it themselves: "lightweight" is fine for a
 * product whose facts say "Lightweight design", and withheld for one that only
 * has a weight. Shared by the quality gate (sentences, terms) and the SEO
 * title fitter (D-129), which drops such a word first when a title is long.
 */
export const EVALUATIVE = [
  "amazing", "exceptional", "outstanding", "incredible", "incredibly", "remarkable", "remarkably", "revolutionary",
  "unmatched", "unparalleled", "unbeatable", "unrivaled", "unrivalled", "superior", "superb", "stunning", "impressive",
  "exquisite", "flawless", "perfect", "perfectly", "ultimate", "premium", "luxurious", "luxury", "world-class",
  "best-in-class", "best", "finest", "top-notch", "cutting-edge", "state-of-the-art", "game-changing", "powerful",
  "lightweight", "portable", "comfortable", "comfort", "precise", "precision", "accurate", "accuracy", "responsive",
  "versatile", "convenient", "durable", "long-lasting", "robust", "sturdy", "reliable", "effortless",
  "effortlessly", "seamless", "seamlessly", "immersive", "crystal-clear", "crisp", "rich", "vibrant", "smooth",
  "ultra-smooth", "blazing", "lightning-fast", "fast", "faster", "fastest", "quiet", "sleek", "stylish", "elegant",
  "beautiful", "gorgeous", "innovative", "advanced", "enhanced", "optimal", "ideal", "exclusive", "unique",
  "clear sound", "high-quality", "high quality", "top quality", "professional-grade", "pro-level",
  "high-performance", "high-end", "top-tier", "next-level", "next-gen", "flagship",
];

// "smooth" also catches "smoothly": the adverb makes the same claim.
export const EVALUATIVE_PATTERN = new RegExp(
  `\\b(?:(?:${EVALUATIVE.map((word) => word.replace(/[-\s]/g, "[-\\s]?")).join("|")})(?:ly)?|ultra-\\w+|super-\\w+|most \\w+|least \\w+)\\b`,
  "gi",
);
