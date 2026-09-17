import { client, explainError, MODEL, requireApiKey } from "./client.js";

/**
 * Confirms the Console API key works: lists the models the key can reach, then
 * makes one tiny billed request. Run with `npm run check-auth`.
 */
async function main(): Promise<void> {
  requireApiKey();

  const key = process.env.ANTHROPIC_API_KEY!;
  console.log(`Using key ${key.slice(0, 14)}…${key.slice(-4)}`);

  const models = await client.models.list({ limit: 20 });
  console.log(`\nModels available to this account (${models.data.length}):`);
  for (const model of models.data) {
    console.log(`  ${model.id.padEnd(24)} ${model.display_name}`);
  }

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 64,
    messages: [{ role: "user", content: "Reply with exactly: connected" }],
  });

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  console.log(`\n${MODEL} responded: ${text.trim()}`);
  console.log(
    `Tokens: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`,
  );
}

main().catch((error) => {
  console.error(`\nFailed: ${explainError(error)}`);
  process.exit(1);
});
