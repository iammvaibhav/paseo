import { useEffect, useState } from "react";
import { openWebhookForm, type WebhookFormSnapshot } from "./webhook-form-model";

export function useWebhookFormModel(snapshot: WebhookFormSnapshot) {
  const [model] = useState(() => openWebhookForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  useEffect(() => {
    model.applyHosts(snapshot.hosts);
    model.applyProjectTargets(snapshot.defaults.projectTargets);
    model.applyPreferences(snapshot.defaults.preferences);
  }, [model, snapshot.hosts, snapshot.defaults.preferences, snapshot.defaults.projectTargets]);

  return model;
}
