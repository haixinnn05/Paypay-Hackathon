import { findLive, liveCases, type LiveCase } from "./live.ts";
import { cases as scenarioCases, findCase as findScenario, type ScenarioCase } from "./scenario.ts";

// Every case the app shows: live PayPal sandbox disputes first, then the demo scenario.

export type ScenarioDemoCase = ScenarioCase & { source: "scenario" };
export type AnyCase = LiveCase | ScenarioDemoCase;

const asDemo = (c: ScenarioCase): ScenarioDemoCase => Object.assign(c, { source: "scenario" as const });

export const allCases = (): AnyCase[] => [...liveCases(), ...scenarioCases().map(asDemo)];

export function findAny(id: string): AnyCase | null {
  const live = findLive(id);
  if (live) return live;
  const demo = findScenario(id);
  return demo ? asDemo(demo) : null;
}
