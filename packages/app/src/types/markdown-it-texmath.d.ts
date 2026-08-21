declare module "markdown-it-texmath" {
  import type MarkdownIt from "markdown-it";
  import type { StateBlock } from "markdown-it";

  interface TexmathOptions {
    engine?: { renderToString: (tex: string, options?: object) => string };
    delimiters?: string | string[];
    outerSpace?: boolean;
    katexOptions?: Record<string, unknown>;
  }

  interface TexmathRule {
    name: string;
    rex: RegExp;
    tmpl: string;
    tag: string;
    displayMode?: boolean;
    outerSpace?: boolean;
    pre?: (str: string, outerSpace: boolean, pos: number) => boolean;
    post?: (str: string, outerSpace: boolean, pos: number) => boolean;
  }

  function texmath(md: MarkdownIt, options?: TexmathOptions): void;

  namespace texmath {
    function block(
      rule: TexmathRule,
    ): (state: StateBlock, startLine: number, endLine: number, silent: boolean) => boolean;
    const rules: Record<string, { inline: TexmathRule[]; block: TexmathRule[] }>;
  }

  export = texmath;
}
