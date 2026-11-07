import { describe, expect, it } from "vitest";
import {
  getItsaplanSelectedProject,
  setItsaplanSelectedProject,
  subscribeItsaplanSelectedProject,
} from "./itsaplan-selected-project";

describe("itsaplan selected project store", () => {
  it("notifies subscribers when the selected project changes", () => {
    setItsaplanSelectedProject("");
    const seen: string[] = [];
    const unsubscribe = subscribeItsaplanSelectedProject(() => {
      seen.push(getItsaplanSelectedProject());
    });

    setItsaplanSelectedProject("PASEO");
    setItsaplanSelectedProject("PASEO");
    setItsaplanSelectedProject("AMBIENTAISTA");

    unsubscribe();
    expect(seen).toEqual(["PASEO", "AMBIENTAISTA"]);
    expect(getItsaplanSelectedProject()).toBe("AMBIENTAISTA");
  });
});
