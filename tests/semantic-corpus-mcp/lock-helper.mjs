import { CorpusService } from "../../tools/semantic-corpus-mcp/lib.mjs";

try {
  const service = await CorpusService.create({
    environment: {
      configPath: process.env.SEMANTIC_CORPUS_SANDBOX_CONFIG,
      token: process.env.SEMANTIC_CORPUS_SANDBOX_TOKEN,
    },
    enforceProcessConfinement: false,
  });
  process.stdout.write("READY\n");
  process.stdin.resume();
  process.stdin.on("end", async () => {
    try {
      await service.close();
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${error.code ?? "ERROR"}: ${error.message}\n`);
      process.exit(3);
    }
  });
} catch (error) {
  process.stderr.write(`${error.code ?? "ERROR"}: ${error.message}\n`);
  process.exit(2);
}
