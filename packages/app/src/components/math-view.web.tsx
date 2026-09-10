import { useMemo } from "react";
import { renderToString } from "katex";

interface MathViewProps {
  tex: string;
  display?: boolean;
  color?: string;
}

export function MathView({ tex, display = false, color }: MathViewProps) {
  const html = useMemo(() => {
    try {
      return renderToString(tex, {
        displayMode: display,
        throwOnError: false,
        output: "mathml",
      });
    } catch {
      return tex;
    }
  }, [tex, display]);

  const innerHtml = useMemo(() => ({ __html: html }), [html]);

  const style = useMemo(
    () => (display ? { ...blockStyle, color: color ?? "inherit" } : { color: color ?? "inherit" }),
    [display, color],
  );

  if (display) {
    return <div style={style} dangerouslySetInnerHTML={innerHtml} />;
  }
  return <span style={style} dangerouslySetInnerHTML={innerHtml} />;
}

const blockStyle: React.CSSProperties = {
  textAlign: "center",
  marginTop: 4,
  marginBottom: 4,
};
