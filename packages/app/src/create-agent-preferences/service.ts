import { AsyncStorageCreateAgentPreferenceStorage } from "./storage";
import {
  DEFAULT_FORM_PREFERENCES,
  parseFormPreferences,
  type FormPreferences,
} from "./preferences";
import type { CreateAgentPreferenceStorage } from "./storage";

export type FormPreferenceUpdate =
  | Partial<FormPreferences>
  | ((current: FormPreferences) => FormPreferences);

export class CreateAgentPreferencesService {
  private preferences: FormPreferences = DEFAULT_FORM_PREFERENCES;
  private isLoaded = false;
  private loadPromise: Promise<FormPreferences> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: CreateAgentPreferenceStorage) {}

  async load(): Promise<FormPreferences> {
    if (this.isLoaded) {
      return this.preferences;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.storage.read().then((stored) => {
        this.preferences = parseFormPreferences(stored);
        this.isLoaded = true;
        return this.preferences;
      });
    }
    return this.loadPromise;
  }

  async update(update: FormPreferenceUpdate): Promise<FormPreferences> {
    const previousWrite = this.writeQueue;
    const operation = this.applyQueuedUpdate(previousWrite, update);

    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /**
   * Replace the in-memory preferences with a host's composerPreferences blob
   * (daemon wins over the local cache on connect / daemon change). Waits for
   * any in-flight local update so a just-persisted write cannot be clobbered
   * mid-flight, then mirrors the daemon value into local storage so the two
   * never drift. The daemon blob arrives as the protocol ComposerPreferences
   * shape, so it is parsed (leniently) at the boundary.
   */
  async hydrate(preferences: unknown): Promise<FormPreferences> {
    await this.writeQueue;
    const parsed = parseFormPreferences(preferences);
    this.preferences = parsed;
    this.isLoaded = true;
    await this.storage.write(parsed);
    return this.preferences;
  }

  private async applyQueuedUpdate(
    previousWrite: Promise<void>,
    update: FormPreferenceUpdate,
  ): Promise<FormPreferences> {
    await previousWrite;
    const current = await this.load();
    const next = typeof update === "function" ? update(current) : { ...current, ...update };
    const parsed = parseFormPreferences(next);
    await this.storage.write(parsed);
    this.preferences = parsed;
    this.isLoaded = true;
    return this.preferences;
  }
}

export const createAgentPreferencesService = new CreateAgentPreferencesService(
  new AsyncStorageCreateAgentPreferenceStorage(),
);
