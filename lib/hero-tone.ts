/**
 * How light or dark the thing behind the header is.
 *
 * The home page draws its header straight over the hero photograph, so the
 * header cannot pick a fixed colour: white lettering vanishes over a bright
 * product shot and navy lettering vanishes over a dark one. Every slide is
 * therefore measured, and the header takes the opposite treatment.
 *
 * "light" and "dark" describe the *background*, never the lettering — a light
 * background gets the navy header, a dark background gets the pale one.
 */
export type BackgroundTone = "light" | "dark";

/**
 * Manual overrides, by product slug.
 *
 * Measuring an average is right almost always and wrong occasionally: an image
 * that is mostly dark with a bright sky exactly where the navigation sits
 * measures dark and reads unreadable. Rather than build a heuristic for that,
 * the design system lets whoever chose the photograph state the answer.
 *
 * Empty on purpose — nothing in the catalogue needs one yet. Add an entry only
 * after looking at the slide and finding the measurement wrong.
 */
export const HERO_TONE_OVERRIDES: Record<string, BackgroundTone> = {};

/**
 * The switch point, on relative luminance.
 *
 * Set above the midpoint rather than at it because the header also lays a veil
 * over whatever is behind it: a middling background is pulled towards the veil
 * rather than left ambiguous, and the pale treatment is the safer of the two
 * over a middling ground.
 */
export function toneFromLuminance(luminance: number): BackgroundTone {
  return luminance >= 0.55 ? "light" : "dark";
}

/** sRGB channel to linear light, per WCAG's relative luminance definition. */
function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

const measured = new Map<string, BackgroundTone>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    /*
     * The catalogue's artwork declares a viewBox and no width or height, which
     * leaves an SVG with no intrinsic size to draw at. Asking for a size up
     * front gives the canvas something to rasterise into; for a raster photo
     * the browser ignores it and uses the real dimensions.
     */
    image.width = 64;
    image.height = 64;
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not read ${url}`));
    image.src = url;
  });
}

/**
 * The average lightness of an image, as a tone.
 *
 * Returns null rather than guessing when the browser will not give up the
 * pixels — a cross-origin image with no CORS headers taints the canvas, and
 * `getImageData` throws. The caller keeps whatever tone it already had, which
 * is always a readable one.
 */
export async function detectBackgroundTone(
  url: string,
): Promise<BackgroundTone | null> {
  const cached = measured.get(url);
  if (cached) return cached;
  if (typeof document === "undefined") return null;

  try {
    const image = await loadImage(url);
    const size = 32;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;

    context.drawImage(image, 0, 0, size, size);
    const { data } = context.getImageData(0, 0, size, size);

    let total = 0;
    let counted = 0;
    for (let offset = 0; offset < data.length; offset += 4) {
      // Transparent pixels show the stage behind them, not the image.
      if (data[offset + 3] < 128) continue;
      total +=
        0.2126 * linear(data[offset]) +
        0.7152 * linear(data[offset + 1]) +
        0.0722 * linear(data[offset + 2]);
      counted += 1;
    }

    if (counted === 0) return null;

    const tone = toneFromLuminance(total / counted);
    measured.set(url, tone);
    return tone;
  } catch {
    return null;
  }
}
