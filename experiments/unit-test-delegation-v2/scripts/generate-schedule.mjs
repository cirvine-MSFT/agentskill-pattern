import path from "node:path";
import { generateSchedule, root, writeJson } from "./lib.mjs";

const output = path.join(root, "design", "schedule.json");
writeJson(output, generateSchedule());
process.stdout.write(`${output}\n`);
