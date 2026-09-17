/**
 * Layout sweep across device classes (PRODUCTION-READINESS 17.1).
 *
 *   node scripts/perf/ux-sweep.mjs --base http://localhost:3100 \
 *     --paths "/,/cart" [--login email:password] [--variant <uuid>]
 *
 * For each page at iPhone SE, iPhone 15, a large Android phone, iPad portrait,
 * an Android tablet in landscape, a laptop and a large desktop, reports:
 * - horizontal overflow (the page scrolls sideways), with the widest offender;
 * - touch targets smaller than 40 × 40 CSS px on touch devices — visible links,
 *   buttons and form controls, skipping inline links inside running text;
 * - visible text smaller than 12 px.
 * Screenshots are not taken; this names places to look at.
 */
import { chromium } from "playwright";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith("--")) pairs.push([value.slice(2), all[index + 1]]);
    return pairs;
  }, []),
);
const base = args.base ?? "http://localhost:3100";
const paths = (args.paths ?? "/").split(",");

const DEVICES = [
  { name: "iphone-se", viewport: { width: 375, height: 667 }, touch: true },
  { name: "iphone-15", viewport: { width: 393, height: 852 }, touch: true },
  { name: "android-large", viewport: { width: 430, height: 932 }, touch: true },
  { name: "ipad", viewport: { width: 768, height: 1024 }, touch: true },
  { name: "android-tablet-land", viewport: { width: 1280, height: 800 }, touch: true },
  { name: "laptop", viewport: { width: 1366, height: 768 }, touch: false },
  { name: "desktop-large", viewport: { width: 1920, height: 1080 }, touch: false },
];

const browser = await chromium.launch();
for (const device of DEVICES) {
  const context = await browser.newContext({
    viewport: device.viewport,
    isMobile: device.touch && device.viewport.width < 800,
    hasTouch: device.touch,
  });
  const page = await context.newPage();
  if (args.login) {
    const [email, ...rest] = args.login.split(":");
    await page.request.post(`${base}/api/auth/login`, { data: { email, password: rest.join(":") }, headers: { origin: base } });
  }
  if (args.variant) {
    await page.request.post(`${base}/api/cart`, { data: { variantId: args.variant, quantity: 1 }, headers: { origin: base } });
  }
  for (const path of paths) {
    await page.goto(base + path, { waitUntil: "load", timeout: 120_000 });
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 500) {
        window.scrollTo(0, y);
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(600);
    const report = await page.evaluate((touch) => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05 && !element.closest("[aria-hidden='true'], [inert], dialog:not([open])");
      };
      const describe = (element) => {
        const label = (element.getAttribute("aria-label") || element.textContent || element.getAttribute("name") || "").trim().replace(/\s+/g, " ").slice(0, 40);
        return `${element.tagName.toLowerCase()}${element.id ? "#" + element.id : ""} "${label}"`;
      };

      const overflow = document.documentElement.scrollWidth - window.innerWidth;
      let widest = null;
      if (overflow > 1) {
        for (const element of document.body.querySelectorAll("*")) {
          const rect = element.getBoundingClientRect();
          if (rect.right > window.innerWidth + 1 && visible(element) && getComputedStyle(element).position !== "fixed") {
            if (!element.closest("[class*='overflow-x-auto'], [class*='overflow-hidden'], .rail")) {
              widest = `${describe(element)} right=${Math.round(rect.right)}`;
            }
          }
        }
      }

      const small = [];
      if (touch) {
        for (const element of document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button]")) {
          if (!visible(element)) continue;
          const rect = element.getBoundingClientRect();
          if (element.tagName === "A" && element.closest("p, li p") && getComputedStyle(element).display === "inline") continue;
          if (element.matches("input[type=checkbox], input[type=radio]") && element.closest("label")) continue;
          if (rect.width < 40 || rect.height < 40) small.push(`${describe(element)} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
        }
      }

      const tiny = new Set();
      for (const element of document.body.querySelectorAll("*")) {
        if (!element.childNodes.length || ![...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim())) continue;
        if (!visible(element) || element.closest(".sr-only")) continue;
        const size = parseFloat(getComputedStyle(element).fontSize);
        if (size < 12) tiny.add(`${Math.round(size * 10) / 10}px "${element.textContent.trim().slice(0, 30)}"`);
      }

      return { overflow, widest, small: [...new Set(small)], tiny: [...tiny] };
    }, device.touch);

    const problems = [];
    if (report.overflow > 1) problems.push(`OVERFLOW ${report.overflow}px ${report.widest ?? ""}`);
    if (report.small.length) problems.push(`small targets (${report.small.length}): ${report.small.slice(0, 6).join("; ")}`);
    if (report.tiny.length) problems.push(`tiny text (${report.tiny.length}): ${report.tiny.slice(0, 4).join("; ")}`);
    console.log(`${device.name.padEnd(20)} ${path.padEnd(34)} ${problems.length ? problems.join(" | ") : "ok"}`);
  }
  await context.close();
}
await browser.close();
