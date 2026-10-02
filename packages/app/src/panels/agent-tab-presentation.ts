export function stripTicketPrefix(raw: string, name?: string | null): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  if (name && name.trim().length > 0) {
    const trimmedName = name.trim();
    const escapedName = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePrefixPattern = new RegExp(
      `^(?:(?:ticket(?:\\s*id)?|issue):\\s*)?\\[?${escapedName}\\]?\\s*(?:[—–:-]|\\s)\\s*(.*)$`,
      "i",
    );
    const match = namePrefixPattern.exec(trimmed);
    if (match) {
      const rest = match[1]?.trim() ?? "";
      if (rest.length > 0) {
        return rest;
      }
    }
  }

  const ticketPattern =
    /^(?:(?:ticket(?:\s*id)?|issue):\s*)?\[?([A-Za-z0-9_]+-\d+)\]?\s*(?:[—–:-]|\s)\s*(.*)$/i;
  const match = ticketPattern.exec(trimmed);
  if (match) {
    const rest = match[2]?.trim() ?? "";
    if (rest.length > 0) {
      return rest;
    }
  }

  const issuePrefixPattern = /^(?:ticket(?:\s*id)?|issue):\s*(.+)$/i;
  const issueMatch = issuePrefixPattern.exec(trimmed);
  if (issueMatch && issueMatch[1]?.trim()) {
    return issueMatch[1].trim();
  }

  return trimmed;
}

export function resolveWorkspaceAgentTabLabel(
  title: string | null | undefined,
  name?: string | null,
): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  const cleaned = stripTicketPrefix(normalized, name);
  return cleaned.length > 0 ? cleaned : normalized;
}

export function resolveAgentTabTooltip(input: {
  label: string | null;
  name: string | null | undefined;
  fallbackTooltip: string;
  hideAgentNames: boolean;
}): string {
  const { label, name, fallbackTooltip, hideAgentNames } = input;
  if (hideAgentNames) {
    return label ?? fallbackTooltip;
  }
  const trimmedName = name?.trim();
  if (trimmedName && trimmedName.length > 0) {
    if (label && label.trim().length > 0) {
      const trimmedLabel = label.trim();
      if (trimmedName.toLowerCase() === trimmedLabel.toLowerCase()) {
        return trimmedName;
      }
      return `${trimmedName} — ${trimmedLabel}`;
    }
    return `${trimmedName} — ${fallbackTooltip}`;
  }
  return label ?? fallbackTooltip;
}
