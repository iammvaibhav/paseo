// echarts ships types for its package entry but not for the prebuilt ESM
// bundle. We import the bundle instead of the entry because the entry's modules
// import tslib helpers that Metro's CJS interop cannot resolve. Same public API.
declare module "echarts/dist/echarts.esm.js" {
  export * from "echarts";
}
