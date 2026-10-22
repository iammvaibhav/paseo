// `import x from "./a.css" with { type: "file" }` gives the file path.
declare module "*.css" {
	const path: string;
	export default path;
}
