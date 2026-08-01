// plotly.js-dist-min ships a prebuilt UMD bundle with no type declarations.
// Only the entry points the chart renderer uses are declared here.
declare module "plotly.js-dist-min" {
  export function newPlot(
    host: HTMLElement,
    data: unknown[],
    layout?: Record<string, unknown>,
    config?: Record<string, unknown>,
  ): Promise<unknown>;
  export function purge(host: HTMLElement): void;
  export const Plots: { resize(host: HTMLElement): void };
}
