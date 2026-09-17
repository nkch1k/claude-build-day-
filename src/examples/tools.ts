import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { client, explainError, MODEL, requireApiKey } from "../client.js";

/**
 * Tool use via the SDK's tool runner: you write the tool functions, the SDK
 * drives the call -> execute -> continue loop. Run with `npm run tools`.
 */

const getWeather = betaZodTool({
  name: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: z.object({
    city: z.string().describe("City name, e.g. Paris"),
    unit: z.enum(["celsius", "fahrenheit"]).optional(),
  }),
  run: async (input) => {
    // Stand-in for a real API call.
    const temperature = input.unit === "fahrenheit" ? "72°F" : "22°C";
    return `${temperature} and sunny in ${input.city}`;
  },
});

const convertCurrency = betaZodTool({
  name: "convert_currency",
  description: "Convert an amount between two currency codes.",
  inputSchema: z.object({
    amount: z.number(),
    from: z.string().describe("ISO 4217 code, e.g. USD"),
    to: z.string().describe("ISO 4217 code, e.g. EUR"),
  }),
  run: async (input) => {
    const rates: Record<string, number> = { USD: 1, EUR: 0.92, GBP: 0.79, JPY: 157 };
    const from = rates[input.from.toUpperCase()];
    const to = rates[input.to.toUpperCase()];
    if (from === undefined || to === undefined) {
      return `Unknown currency code. Known codes: ${Object.keys(rates).join(", ")}`;
    }
    return `${input.amount} ${input.from} = ${((input.amount / from) * to).toFixed(2)} ${input.to}`;
  },
});

async function main(): Promise<void> {
  requireApiKey();

  const prompt =
    process.argv.slice(2).join(" ") ||
    "What's the weather in Paris, and what is 250 USD in EUR?";

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    tools: [getWeather, convertCurrency],
    messages: [{ role: "user", content: prompt }],
  });

  // Each iteration is one assistant turn; the runner executes the tool calls
  // between them. Iterating lets you log what happened.
  for await (const message of runner) {
    for (const block of message.content) {
      if (block.type === "tool_use") {
        console.log(`  → ${block.name}(${JSON.stringify(block.input)})`);
      }
    }
  }

  const final = await runner.done();
  for (const block of final.content) {
    if (block.type === "text") console.log(`\n${block.text}`);
  }
}

main().catch((error) => {
  console.error(explainError(error));
  process.exit(1);
});
