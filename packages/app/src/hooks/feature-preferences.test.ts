import { describe, expect, it } from "vitest";

import { resolveFeatureValues } from "./feature-preferences";

describe("feature-preferences", () => {
  const features = [
    {
      type: "toggle" as const,
      id: "fast_mode",
      label: "Fast",
      value: false,
    },
    {
      type: "toggle" as const,
      id: "plan_mode",
      label: "Plan",
      value: false,
    },
  ];

  it("restores persisted values for available features", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          unknown_feature: true,
        },
        localFeatureValues: {},
      }),
    ).toEqual({
      fast_mode: true,
    });
  });

  it("prefers local values over persisted values", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          plan_mode: false,
        },
        localFeatureValues: {
          fast_mode: false,
        },
      }),
    ).toEqual({
      fast_mode: false,
      plan_mode: false,
    });
  });

  it("omits provider current values when nothing is persisted or local", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {},
        localFeatureValues: {},
      }),
    ).toEqual({});
  });

  it("uses model parameter feature values before provider defaults", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {},
        localFeatureValues: {},
        modelFeatureValues: {
          fast_mode: true,
        },
      }),
    ).toEqual({
      fast_mode: true,
    });
  });

  it("prefers persisted feature values over model parameter feature values", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: false,
        },
        localFeatureValues: {},
        modelFeatureValues: {
          fast_mode: true,
        },
      }),
    ).toEqual({
      fast_mode: false,
    });
  });

  it("omits null select values from defaults", () => {
    expect(
      resolveFeatureValues({
        features: [
          {
            type: "select" as const,
            id: "profile",
            label: "Profile",
            value: null,
            options: [],
          },
        ],
        persistedFeatureValues: {},
        localFeatureValues: {},
      }),
    ).toEqual({});
  });
});
