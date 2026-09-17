import { client, explainError, MODEL, requireApiKey } from "../client.js";

/**
 * Streaming with adaptive thinking - what you want behind any chat UI, and what
 * keeps long responses from hitting request timeouts.
 * Run with `npm run stream -- "your prompt"`.
 */
async function main(): Promise<void> {
  requireApiKey();

  const prompt =
    process.argv.slice(2).join(" ") ||
    "Explain how prompt caching reduces cost, then give one concrete example.";

  const stream = client.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    // Thinking is on by default on Opus 5; display is "omitted" unless asked
    // for, which looks like a long pause. Ask for the summary instead.
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
    messages: [{ role: "user", content: prompt }],
  });

  let inThinking = false;
  stream.on("contentBlock", () => {
    if (inThinking) {
      process.stdout.write("\n\n--- answer ---\n");
      inThinking = false;
    }
  });
  stream.on("thinking", (delta) => {
    if (!inThinking) {
      process.stdout.write("--- thinking ---\n");
      inThinking = true;
    }
    process.stdout.write(delta);
  });
  stream.on("text", (delta) => process.stdout.write(delta));

  const message = await stream.finalMessage();
  process.stdout.write("\n");
  console.log(
    `\nTokens: ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`,
  );
}

main().catch((error) => {
  console.error(explainError(error));
  process.exit(1);
});
