type Listener = () => void;

let selectedProject = "";
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getItsaplanSelectedProject(): string {
  return selectedProject;
}

export function setItsaplanSelectedProject(projectKey: string): string {
  const next = projectKey.trim();
  if (next === selectedProject) {
    return selectedProject;
  }
  selectedProject = next;
  emit();
  return selectedProject;
}

export function subscribeItsaplanSelectedProject(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
