import type { ProjectIconSource } from "@getpaseo/protocol/messages";

/**
 * What the user asked the icon to become. A URL is client-side only: the caller
 * acquires its bytes and submits the same upload payload a picked file produces.
 */
export type ProjectIconIntent = ProjectIconSource | { type: "url"; url: string };

/** The RPCs one submit has to issue. A null field is a field the user left alone. */
export interface ProjectEditSubmission {
  rename: { customName: string | null } | null;
  description: { description: string | null } | null;
  icon: ProjectIconIntent | null;
}

export interface ProjectEditFormError {
  /** Which field the failure belongs under. */
  scope: "name" | "icon" | "description";
  message: string;
}

export interface ProjectEditFormState {
  name: string;
  description: string;
  /** The image the icon tile renders, null for the derived letter fallback. */
  previewDataUri: string | null;
  pickedFileName: string | null;
  /** False once the resulting icon is the automatic one — the reset has nothing to do. */
  canUseAutomatic: boolean;
  canSubmit: boolean;
  error: ProjectEditFormError | null;
  /** Bumped only when the model clears the URL box on the user's behalf. */
  urlResetKey: number;
  submission: ProjectEditSubmission;
}

export interface ProjectEditFormModel {
  getState: () => ProjectEditFormState;
  subscribe: (listener: () => void) => () => void;
  setName: (name: string) => void;
  setDescription: (description: string) => void;
  setImageUrl: (url: string) => void;
  setPickedImage: (image: { fileName: string; mimeType: string; data: string }) => void;
  useAutomaticIcon: () => void;
  setError: (error: ProjectEditFormError | null) => void;
}

export interface ProjectEditFormSnapshot {
  /** The name on screen today, custom or derived. Seeds the input's placeholder. */
  projectName: string;
  /** The override in effect, null while the project uses its derived name. */
  projectCustomName: string | null;
  /** The description on screen today, null when the project has none. */
  projectDescription: string | null;
  hasCustomIcon: boolean;
  /** The icon the project renders today, custom or derived. */
  currentIconDataUri: string | null;
}

type IconChoice = "unchanged" | "automatic" | "upload" | "url";

interface PickedImage {
  fileName: string;
  mimeType: string;
  data: string;
}

export function openProjectEditForm(snapshot: ProjectEditFormSnapshot): ProjectEditFormModel {
  let name = snapshot.projectCustomName ?? "";
  let description = snapshot.projectDescription ?? "";
  let urlText = "";
  let picked: PickedImage | null = null;
  let iconChoice: IconChoice = "unchanged";
  let error: ProjectEditFormError | null = null;
  let urlResetKey = 0;
  const listeners = new Set<() => void>();

  function deriveRename(): ProjectEditSubmission["rename"] {
    const trimmed = name.trim();
    const customName = trimmed.length === 0 ? null : trimmed;
    return customName === snapshot.projectCustomName ? null : { customName };
  }

  function deriveDescription(): ProjectEditSubmission["description"] {
    const trimmed = description.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    return next === snapshot.projectDescription ? null : { description: next };
  }

  function deriveIcon(): ProjectIconIntent | null {
    if (iconChoice === "automatic") {
      return snapshot.hasCustomIcon ? { type: "automatic" } : null;
    }
    if (iconChoice === "upload" && picked) {
      return { type: "upload", data: picked.data };
    }
    if (iconChoice === "url") {
      const url = urlText.trim();
      return url.length === 0 ? null : { type: "url", url };
    }
    return null;
  }

  function derivePreview(): string | null {
    // Dropping a custom icon leaves the daemon to re-derive one, so the tile
    // falls back to the letter rather than claiming to know the result.
    if (iconChoice === "automatic") return null;
    if (iconChoice === "upload" && picked) {
      return `data:${picked.mimeType};base64,${picked.data}`;
    }
    return snapshot.currentIconDataUri;
  }

  function deriveState(): ProjectEditFormState {
    const submission = {
      rename: deriveRename(),
      description: deriveDescription(),
      icon: deriveIcon(),
    };
    const willBeCustom = submission.icon
      ? submission.icon.type !== "automatic"
      : snapshot.hasCustomIcon;
    return {
      name,
      description,
      previewDataUri: derivePreview(),
      pickedFileName: iconChoice === "upload" ? (picked?.fileName ?? null) : null,
      canUseAutomatic: willBeCustom,
      canSubmit: Boolean(submission.rename || submission.description || submission.icon),
      error,
      urlResetKey,
      submission,
    };
  }

  let state = deriveState();

  function publish(): void {
    state = deriveState();
    for (const listener of listeners) listener();
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setName: (nextName) => {
      name = nextName;
      error = null;
      publish();
    },
    setDescription: (nextDescription) => {
      description = nextDescription;
      error = null;
      publish();
    },
    setImageUrl: (url) => {
      urlText = url;
      // Emptying the box withdraws the URL without discarding an earlier pick.
      if (url.trim().length > 0) {
        iconChoice = "url";
      } else {
        iconChoice = picked ? "upload" : "unchanged";
      }
      error = null;
      publish();
    },
    setPickedImage: (image) => {
      picked = image;
      iconChoice = "upload";
      error = null;
      publish();
    },
    useAutomaticIcon: () => {
      picked = null;
      urlText = "";
      urlResetKey += 1;
      iconChoice = snapshot.hasCustomIcon ? "automatic" : "unchanged";
      error = null;
      publish();
    },
    setError: (nextError) => {
      error = nextError;
      publish();
    },
  };
}
