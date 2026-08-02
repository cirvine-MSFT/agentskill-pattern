import {sha256} from "./lib.mjs";
import {mainFixtures, pilotFixtures} from "../fixtures/catalog.mjs";

export const RANDOMIZATION_SEED = 56017731;

function randomSource(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function deterministicUuid(namespace) {
  const hex = sha256(namespace);
  const chars = `${hex.slice(0, 12)}4${hex.slice(13, 16)}8${hex.slice(17, 20)}${hex.slice(20, 32)}`;
  return `${chars.slice(0, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}-${chars.slice(16, 20)}-${chars.slice(20)}`;
}

function blockRuns(phase, blockNumber, fixtureId, variantId, random) {
  const blockId = `${phase.toUpperCase()}-B${String(blockNumber).padStart(2, "0")}`;
  const arms = random() < 0.5 ? ["A1", "A2"] : ["A2", "A1"];
  return {
    blockId,
    phase,
    fixtureId,
    variantId,
    runs: arms.map((arm, index) => {
      const suffix = sha256(`${RANDOMIZATION_SEED}:${blockId}:${arm}`).slice(0, 8);
      const observationId = `${blockId}-${arm}-${suffix}`;
      return {
        observationId,
        arm,
        order: index + 1,
        parentSessionId: deterministicUuid(`${observationId}:parent`),
        workerSessionId: arm === "A2" ? deterministicUuid(`${observationId}:worker`) : null,
        worktreeId: deterministicUuid(`${observationId}:worktree`)
      };
    })
  };
}

export function createSchedule() {
  const random = randomSource(RANDOMIZATION_SEED);
  const main = [];
  for (const fixture of mainFixtures) {
    for (const variant of fixture.variants) {
      main.push(blockRuns("main", main.length + 1, fixture.id, variant.id, random));
    }
  }
  const pilot = pilotFixtures.map((fixture, index) =>
    blockRuns("pilot", index + 1, fixture.id, fixture.variants[0].id, random));
  return {
    protocolId: "feature-documentation-delegation-v1",
    scheduleVersion: 1,
    randomizationSeed: RANDOMIZATION_SEED,
    main,
    pilot,
    frozenCounts: {
      mainBlocks: 24,
      mainObservations: 48,
      pilotBlocks: 2,
      pilotObservations: 4
    }
  };
}
