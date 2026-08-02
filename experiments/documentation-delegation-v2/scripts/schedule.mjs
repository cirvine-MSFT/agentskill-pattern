import {mainFixtures, pilotFixtures} from "../fixtures/catalog.mjs";
import {protocolId, sha256} from "./lib.mjs";

export const randomizationSeed = 82620417;

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function uuid(label) {
  const hex = sha256(`v2-sonnet:${label}`);
  const value = `${hex.slice(0, 12)}4${hex.slice(13, 16)}a${hex.slice(17, 20)}${hex.slice(20, 32)}`;
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function createBlock(phase, number, fixtureId, variantId, random) {
  const blockId = `${phase === "pilot" ? "V2P" : "V2M"}-${String(number).padStart(2, "0")}`;
  const arms = random() < 0.5 ? ["A1", "A2"] : ["A2", "A1"];
  return {
    blockId,
    phase,
    fixtureId,
    variantId,
    runs: arms.map((arm, index) => {
      const observationId = `${blockId}-${arm}-${sha256(`${randomizationSeed}:${blockId}:${arm}`).slice(0, 10)}`;
      return {
        observationId,
        arm,
        order: index + 1,
        parentSessionId: uuid(`${observationId}:parent`),
        workerSessionId: arm === "A2" ? uuid(`${observationId}:worker`) : null,
        worktreeId: uuid(`${observationId}:worktree`)
      };
    })
  };
}

export function createSchedule() {
  const random = randomSource(randomizationSeed);
  const main = [];
  for (const fixture of mainFixtures) {
    for (const item of fixture.variants) {
      main.push(createBlock("main", main.length + 1, fixture.id, item.id, random));
    }
  }
  const pilot = pilotFixtures.map((fixture, index) =>
    createBlock("pilot", index + 1, fixture.id, fixture.variants[0].id, random));
  return {
    protocolId,
    scheduleVersion: 2,
    randomizationSeed,
    main,
    pilot,
    frozenCounts: {
      mainBlocks: 24,
      mainObservations: 48,
      pilotBlocks: 6,
      pilotObservations: 12
    }
  };
}
