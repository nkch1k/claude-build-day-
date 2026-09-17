import { client, explainError, MODEL, requireApiKey } from "../client.js";

/**
 * One request, one response - the smallest useful shape.
 * Run with `npm run hello -- "your question"`.
 */
async function main(): Promise<void> {
  requireApiKey();

  const question = process.argv.slice(2).join(" ") || "What is the capital of France?";

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: "You are a concise assistant. Answer in at most three sentences.",
    messages: [{ role: "user", content: question }],
  });

  if (response.stop_reason === "refusal") {
    console.error("Request declined:", response.stop_details?.explanation);
    process.exit(1);
  }

  // content is a discriminated union - narrow before reading .text.
  for (const block of response.content) {
    if (block.type === "text") console.log(block.text);
  }
}

main().catch((error) => {
  console.error(explainError(error));
  process.exit(1);
});
