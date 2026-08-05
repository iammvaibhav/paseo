export function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export function isHomeDirectoryPath(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim().replace(/[/\\]+$/, "");
  if (trimmed === "~" || trimmed === "") return true;

  return /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:[\\/]Users[\\/][^/\\]+)$/i.test(trimmed);
}
