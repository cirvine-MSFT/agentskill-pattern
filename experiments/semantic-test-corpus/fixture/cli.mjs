#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { migrateV1ToV2 } from "./migration/index.mjs";

const file = process.argv[2];
const source = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
const input = JSON.parse(source);
process.stdout.write(`${JSON.stringify(migrateV1ToV2(input), null, 2)}\n`);
