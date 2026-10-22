export function isMermaidFenceLanguage(info: string | null | undefined): boolean {
  if (!info) return false;
  const first = info.trim().split(/\s+/)[0]?.toLowerCase().replace(/^\./, "");
  return first === "mermaid";
}

export function stripTerminalFenceNewline(code: string): string {
  return code.endsWith("\n") ? code.slice(0, -1) : code;
}
