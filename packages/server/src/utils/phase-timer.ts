/**
 * Splits one operation's wall time into named, consecutive phases for a single
 * structured log line. `mark(name)` attributes the time since the previous mark
 * (or creation) to `name`; marking the same name twice accumulates.
 */
export interface PhaseTimer {
  readonly phases: Record<string, number>;
  mark(name: string): void;
}

export function createPhaseTimer(now: () => number = Date.now): PhaseTimer {
  let last = now();
  const phases: Record<string, number> = {};
  return {
    phases,
    mark(name) {
      const current = now();
      phases[name] = (phases[name] ?? 0) + (current - last);
      last = current;
    },
  };
}
