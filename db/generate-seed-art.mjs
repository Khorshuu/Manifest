/**
 * Draws the seed product illustrations.
 *
 * Hand-drawn SVG rather than stock photography: nothing here is licensed from
 * anyone, it stays crisp at any size, it weighs a few kilobytes, and it can
 * carry the shop's own palette. It is a stand-in until real photographs of the
 * real goods exist — those will always look better and should replace these.
 *
 * Run with: node db/generate-seed-art.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "public/seed");
mkdirSync(OUT, { recursive: true });

const INK = "#12233f";
const PAPER = "#f7f9fc";
const BRASS = "#f0a631";

/** A soft studio backdrop, so every product looks photographed on one set. */
function backdrop(tint) {
  return `
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${PAPER}"/>
      <stop offset="100%" stop-color="${tint}"/>
    </linearGradient>
    <radialGradient id="pool" cx="0.5" cy="0.92" r="0.55">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="600" height="600" fill="url(#bg)"/>
  <ellipse cx="300" cy="512" rx="190" ry="26" fill="url(#pool)"/>`;
}

function wrap(inner, tint = "#dce9ff") {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" role="img">
${backdrop(tint)}
${inner}
</svg>
`;
}

/** A stand-up coffee bag with a tin tie. */
const coffeeBag = (body, accent, label) => wrap(`
  <path d="M195 180h210l-14 320H209z" fill="${body}"/>
  <path d="M195 180h105v320H209z" fill="#ffffff" fill-opacity="0.07"/>
  <rect x="205" y="150" width="190" height="34" rx="4" fill="${INK}"/>
  <rect x="243" y="138" width="114" height="14" rx="7" fill="#8a939f"/>
  <rect x="228" y="250" width="144" height="120" fill="${PAPER}"/>
  <rect x="228" y="250" width="144" height="26" fill="${accent}"/>
  <text x="300" y="316" text-anchor="middle" font-family="Georgia, serif" font-size="34" fill="${INK}">${label}</text>
  <text x="300" y="348" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15" letter-spacing="3" fill="${INK}" fill-opacity="0.65">WHOLE BEAN</text>
  <circle cx="300" cy="430" r="20" fill="none" stroke="${PAPER}" stroke-opacity="0.7" stroke-width="3"/>
  <path d="M292 430h16M300 422v16" stroke="${PAPER}" stroke-opacity="0.7" stroke-width="3"/>`);

/** A round confectionery tin, seen slightly from above. */
const tin = (body, accent, label) => wrap(`
  <ellipse cx="300" cy="470" rx="150" ry="42" fill="${body}" fill-opacity="0.55"/>
  <rect x="150" y="300" width="300" height="170" fill="${body}"/>
  <rect x="150" y="300" width="90" height="170" fill="#ffffff" fill-opacity="0.08"/>
  <ellipse cx="300" cy="300" rx="150" ry="42" fill="${accent}"/>
  <ellipse cx="300" cy="300" rx="112" ry="30" fill="none" stroke="${INK}" stroke-opacity="0.35" stroke-width="3"/>
  <text x="300" y="310" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="${INK}">${label}</text>
  <rect x="150" y="372" width="300" height="30" fill="${PAPER}" fill-opacity="0.92"/>
  <text x="300" y="394" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="17" letter-spacing="4" fill="${INK}">IMPORTED</text>`);

/** A wrapped chocolate bar, corner folded back. */
const bar = (body, accent, label) => wrap(`
  <rect x="170" y="170" width="260" height="330" rx="6" fill="${body}"/>
  <rect x="170" y="170" width="90" height="330" fill="#ffffff" fill-opacity="0.07"/>
  <path d="M430 170l-70 70 70 0z" fill="${PAPER}" fill-opacity="0.85"/>
  <rect x="200" y="250" width="200" height="150" fill="${PAPER}"/>
  <rect x="200" y="250" width="200" height="34" fill="${accent}"/>
  <text x="300" y="330" text-anchor="middle" font-family="Georgia, serif" font-size="40" fill="${INK}">${label}</text>
  <text x="300" y="368" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15" letter-spacing="3" fill="${INK}" fill-opacity="0.65">72% CACAO</text>
  <g stroke="${INK}" stroke-opacity="0.25" stroke-width="2">
    <path d="M170 440h260M300 170v330"/>
  </g>`);

/** Three sauce bottles in a row. */
const bottles = (a, b, c) => wrap(`
  ${[[190, a], [300, b], [410, c]]
    .map(
      ([x, colour]) => `
  <g transform="translate(${x} 0)">
    <rect x="-34" y="250" width="68" height="220" rx="10" fill="${colour}"/>
    <rect x="-34" y="250" width="24" height="220" rx="10" fill="#ffffff" fill-opacity="0.14"/>
    <path d="M-16 250v-40h32v40z" fill="${colour}"/>
    <rect x="-20" y="188" width="40" height="24" rx="4" fill="${INK}"/>
    <rect x="-30" y="316" width="60" height="82" fill="${PAPER}"/>
    <path d="M-30 316h60v16h-60z" fill="${BRASS}"/>
  </g>`,
    )
    .join("")}`, "#ffe9d6");

/** A syrup jug with a handle. */
const jug = (body, label) => wrap(`
  <path d="M215 220h170v260a20 20 0 0 1-20 20H235a20 20 0 0 1-20-20z" fill="${body}"/>
  <path d="M215 220h60v280h-40a20 20 0 0 1-20-20z" fill="#ffffff" fill-opacity="0.10"/>
  <path d="M385 300h34a30 30 0 0 1 0 60h-34" fill="none" stroke="${body}" stroke-width="22"/>
  <rect x="262" y="176" width="76" height="46" fill="${body}"/>
  <rect x="254" y="160" width="92" height="20" rx="4" fill="${INK}"/>
  <rect x="240" y="300" width="120" height="120" fill="${PAPER}"/>
  <text x="300" y="352" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="${INK}">${label}</text>
  <text x="300" y="384" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" letter-spacing="2" fill="${INK}" fill-opacity="0.6">PURE GRADE A</text>`, "#f6ead9");

/** A case of cans. */
const cans = (body, accent) => wrap(`
  <rect x="150" y="300" width="300" height="180" fill="${INK}" fill-opacity="0.9"/>
  <rect x="150" y="300" width="300" height="34" fill="${accent}"/>
  ${[195, 265, 335, 405]
    .map(
      (x) => `<g transform="translate(${x} 0)">
      <rect x="-26" y="196" width="52" height="120" rx="8" fill="${body}"/>
      <rect x="-26" y="196" width="18" height="120" rx="8" fill="#ffffff" fill-opacity="0.16"/>
      <ellipse cx="0" cy="196" rx="26" ry="8" fill="#c9ced6"/>
    </g>`,
    )
    .join("")}
  <text x="300" y="420" text-anchor="middle" font-family="Georgia, serif" font-size="30" fill="${PAPER}">COLD BREW</text>
  <text x="300" y="452" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15" letter-spacing="4" fill="${PAPER}" fill-opacity="0.7">12 CANS</text>`);

/** Over-ear headphones, front on. */
const headphones = (body, pad) => wrap(`
  <path d="M170 330a130 130 0 0 1 260 0" fill="none" stroke="${body}" stroke-width="26" stroke-linecap="round"/>
  <path d="M186 330a114 114 0 0 1 228 0" fill="none" stroke="${PAPER}" stroke-opacity="0.35" stroke-width="8"/>
  ${[176, 424]
    .map(
      (x) => `<g transform="translate(${x} 0)">
      <rect x="-42" y="320" width="84" height="140" rx="26" fill="${body}"/>
      <rect x="-30" y="336" width="60" height="108" rx="20" fill="${pad}"/>
      <rect x="-14" y="300" width="28" height="34" rx="8" fill="${INK}"/>
    </g>`,
    )
    .join("")}
  <path d="M176 460v34h56" fill="none" stroke="${INK}" stroke-opacity="0.6" stroke-width="5"/>`);

/** Earbuds in an open case. */
const earbuds = (body, accent) => wrap(`
  <rect x="180" y="300" width="240" height="150" rx="28" fill="${body}"/>
  <rect x="180" y="300" width="240" height="20" rx="10" fill="#ffffff" fill-opacity="0.14"/>
  <ellipse cx="245" cy="372" rx="42" ry="30" fill="${INK}" fill-opacity="0.5"/>
  <ellipse cx="355" cy="372" rx="42" ry="30" fill="${INK}" fill-opacity="0.5"/>
  ${[245, 355]
    .map(
      (x) => `<g transform="translate(${x} 0)">
      <circle cx="0" cy="360" r="26" fill="${PAPER}"/>
      <circle cx="0" cy="360" r="12" fill="${accent}"/>
      <rect x="-9" y="372" width="18" height="46" rx="9" fill="${PAPER}"/>
    </g>`,
    )
    .join("")}
  <rect x="270" y="464" width="60" height="8" rx="4" fill="${INK}" fill-opacity="0.25"/>`);

/** A small desktop amplifier with a dial. */
const amplifier = (body, accent) => wrap(`
  <rect x="170" y="270" width="260" height="180" rx="12" fill="${body}"/>
  <rect x="170" y="270" width="260" height="34" rx="12" fill="#ffffff" fill-opacity="0.10"/>
  <circle cx="368" cy="362" r="46" fill="${INK}"/>
  <circle cx="368" cy="362" r="34" fill="${PAPER}"/>
  <path d="M368 336v18" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
  <rect x="206" y="326" width="110" height="72" fill="${INK}" fill-opacity="0.85"/>
  <rect x="218" y="342" width="86" height="8" rx="4" fill="${accent}"/>
  <rect x="218" y="360" width="62" height="8" rx="4" fill="${PAPER}" fill-opacity="0.55"/>
  <rect x="218" y="378" width="40" height="8" rx="4" fill="${PAPER}" fill-opacity="0.35"/>
  ${[200, 400].map((x) => `<rect x="${x}" y="450" width="30" height="14" rx="4" fill="${INK}" fill-opacity="0.6"/>`).join("")}`);

/** A pair of studio monitors. */
const monitors = (body, cone) => wrap(`
  ${[210, 390]
    .map(
      (x) => `<g transform="translate(${x} 0)">
      <rect x="-72" y="230" width="144" height="250" rx="8" fill="${body}"/>
      <rect x="-72" y="230" width="42" height="250" rx="8" fill="#ffffff" fill-opacity="0.07"/>
      <circle cx="0" cy="316" r="46" fill="${INK}"/>
      <circle cx="0" cy="316" r="30" fill="${cone}"/>
      <circle cx="0" cy="316" r="10" fill="${PAPER}"/>
      <circle cx="0" cy="410" r="22" fill="${INK}"/>
      <circle cx="0" cy="410" r="12" fill="${cone}"/>
    </g>`,
    )
    .join("")}`);

/** A mechanical keyboard, three-quarter view. */
const keyboard = (body, keys, accent) => wrap(`
  <rect x="120" y="300" width="360" height="150" rx="12" fill="${body}"/>
  <rect x="120" y="300" width="360" height="16" rx="8" fill="#ffffff" fill-opacity="0.12"/>
  ${Array.from({ length: 4 }, (_, row) =>
    Array.from({ length: 12 }, (_, column) => {
      const accentKey = row === 0 && column === 11;
      return `<rect x="${140 + column * 27}" y="${322 + row * 28}" width="22" height="22" rx="4" fill="${accentKey ? accent : keys}"/>`;
    }).join(""),
  ).join("")}
  <rect x="220" y="434" width="160" height="8" rx="4" fill="${INK}" fill-opacity="0.3"/>`);

/** An anodised desk lamp. */
const lamp = (body, glow) => wrap(`
  <ellipse cx="300" cy="486" rx="96" ry="18" fill="${body}"/>
  <rect x="292" y="250" width="16" height="236" fill="${body}"/>
  <path d="M300 250l-96 -70" stroke="${body}" stroke-width="16" stroke-linecap="round"/>
  <path d="M150 130h108l30 60H180z" fill="${body}"/>
  <path d="M186 190h96l-16 26h-64z" fill="${glow}"/>
  <path d="M204 220l-24 90h176l-24-90z" fill="${glow}" fill-opacity="0.18"/>
  <circle cx="300" cy="250" r="14" fill="${INK}"/>`, "#fdf3e2");

/** A handheld field recorder. */
const recorder = (body, accent) => wrap(`
  <rect x="220" y="180" width="160" height="300" rx="18" fill="${body}"/>
  <rect x="220" y="180" width="52" height="300" rx="18" fill="#ffffff" fill-opacity="0.08"/>
  ${[264, 336].map((x) => `<circle cx="${x}" cy="196" r="26" fill="${INK}"/><circle cx="${x}" cy="196" r="16" fill="#5b6675"/>`).join("")}
  <rect x="248" y="246" width="104" height="76" rx="6" fill="${INK}"/>
  <rect x="258" y="262" width="84" height="10" rx="5" fill="${accent}"/>
  <rect x="258" y="282" width="60" height="8" rx="4" fill="${PAPER}" fill-opacity="0.6"/>
  <circle cx="300" cy="384" r="30" fill="${INK}"/>
  <circle cx="300" cy="384" r="12" fill="${accent}"/>
  ${[250, 350].map((x) => `<rect x="${x - 14}" y="430" width="28" height="14" rx="4" fill="${INK}" fill-opacity="0.55"/>`).join("")}`);

/** A variety box, lid ajar. */
const box = (body, accent, label) => wrap(`
  <path d="M160 300h280v180H160z" fill="${body}"/>
  <path d="M160 300h90v180h-90z" fill="#ffffff" fill-opacity="0.08"/>
  <path d="M150 262h300l-14 44H164z" fill="${accent}"/>
  <rect x="206" y="336" width="188" height="104" fill="${PAPER}"/>
  <text x="300" y="386" text-anchor="middle" font-family="Georgia, serif" font-size="32" fill="${INK}">${label}</text>
  <text x="300" y="416" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="14" letter-spacing="3" fill="${INK}" fill-opacity="0.6">SEASONAL BOX</text>
  <path d="M300 262v-40" stroke="${INK}" stroke-opacity="0.4" stroke-width="4"/>`);

const FILES = {
  "candy-box.svg": box("#c2413a", BRASS, "Variety"),
  "headphones.svg": headphones("#1f2a38", "#39485c"),
  "maple-pecan-coffee-beans.svg": coffeeBag("#6b4423", BRASS, "Maple"),
  "sour-cherry-gummy-tin.svg": tin("#a4243d", "#f2b5c4", "Cherry"),
  "dark-chocolate-sea-salt-bars.svg": bar("#3b2416", BRASS, "Dark"),
  "small-batch-hot-sauce-trio.svg": bottles("#c0392b", "#e07b39", "#8e44ad"),
  "vermont-pancake-syrup.svg": jug("#8a5a2b", "Syrup"),
  "cold-brew-concentrate-case.svg": cans("#2f4858", BRASS),
  "wireless-earbuds-second-edition.svg": earbuds("#2b3442", "#4c8dff"),
  "portable-dac-and-amplifier.svg": amplifier("#39424f", BRASS),
  "desktop-studio-monitors-pair.svg": monitors("#20262f", "#c9a227"),
  "mechanical-keyboard-tactile.svg": keyboard("#2c3440", "#e8ecf1", BRASS),
  "anodised-aluminium-desk-lamp.svg": lamp("#8f9aa6", "#ffd98a"),
  "field-recorder-32-bit-float.svg": recorder("#33393f", "#2fa36e"),
};

for (const [name, contents] of Object.entries(FILES)) {
  writeFileSync(join(OUT, name), contents);
}

console.log(`Wrote ${Object.keys(FILES).length} illustrations to public/seed.`);
