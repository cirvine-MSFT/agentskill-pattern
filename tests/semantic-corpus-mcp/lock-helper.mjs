import { createInterface } from "node:readline";
import { CorpusService } from "../../tools/semantic-corpus-mcp/lib.mjs";

const operation = process.argv[2];
const args = JSON.parse(Buffer.from(process.argv[3], "base64url").toString("utf8"));
let continueWrite;

try {
  const service = await CorpusService.create({
    hooks:
      operation === "delayed-write"
        ? {
            beforeScenarioPublish: async () => {
              process.stdout.write("LOCKED\n");
              await new Promise((resolve) => {
                continueWrite = resolve;
              });
            },
          }
        : undefined,
  });
  process.stdout.write("READY\n");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", async (line) => {
    if (line === "CONTINUE") {
      continueWrite?.();
      return;
    }
    if (line !== "GO") {
      return;
    }
    try {
      const result =
        operation === "manifest"
          ? await service.writeScenarioManifest(args)
          : await service.writeScenarioInput(args);
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
      process.exitCode = 0;
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`,
      );
      process.exitCode = 2;
    } finally {
      input.close();
    }
  });
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`,
  );
  process.exitCode = 2;
}
