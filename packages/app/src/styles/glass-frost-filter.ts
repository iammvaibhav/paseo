/**
 * The blur behind floating surfaces in the glass theme.
 *
 * A plain `backdrop-filter: blur()` misrenders on a macOS window with vibrancy: the page behind it
 * is transparent, and Chromium blurs the transparent pixels with the content
 * (electron/electron#39529). This SVG filter makes the backdrop opaque, blurs that, and then
 * clips it back to the original alpha, so only the page content under the surface is frosted.
 */
export const GLASS_FROST_FILTER_ID = "paseo-glass-frost";

const FILTER_MARKUP = `
<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">
  <filter id="${GLASS_FROST_FILTER_ID}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">
    <feComponentTransfer in="SourceGraphic" result="opaque">
      <feFuncA type="linear" slope="0" intercept="1"/>
    </feComponentTransfer>
    <feGaussianBlur in="opaque" stdDeviation="14" edgeMode="duplicate" result="blurred"/>
    <feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="alpha"/>
    <feMorphology in="alpha" operator="dilate" radius="6" result="alphaWide"/>
    <feGaussianBlur in="alphaWide" stdDeviation="14" edgeMode="duplicate" result="alphaSoft"/>
    <feComposite in="blurred" in2="alphaSoft" operator="in" result="clipped"/>
    <feComponentTransfer in="clipped">
      <feFuncA type="linear" slope="1.8"/>
    </feComponentTransfer>
  </filter>
</svg>`;

/** Adds the filter to the document once. Web only; floating surfaces reference it by id. */
export function installGlassFrostFilter(): void {
  if (typeof document === "undefined" || document.getElementById(GLASS_FROST_FILTER_ID)) return;
  const host = document.createElement("div");
  host.innerHTML = FILTER_MARKUP;
  const svg = host.firstElementChild;
  if (svg) document.body.appendChild(svg);
}
