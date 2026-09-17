import Anthropic from "@anthropic-ai/sdk";

/**
 * Shared client. The SDK reads ANTHROPIC_API_KEY from the environment, so the
 * key never appears in source. Load it from .env via the npm scripts
 * (`tsx --env-file-if-exists=.env`) or export it in your shell.
 */
export const client = new Anthropic();

/** Default model for this project. */
export const MODEL = "claude-opus-5";

/** Fails fast with a useful message instead of a 401 deep inside a request. */
export function requireApiKey(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      [
        "ANTHROPIC_API_KEY is not set.",
        "",
        "  1. Create a key: https://console.anthropic.com/settings/keys",
        "  2. cp .env.example .env",
        "  3. Paste the key into .env",
        "",
        "Or export it directly: export ANTHROPIC_API_KEY=sk-ant-...",
      ].join("\n"),
    );
    process.exit(1);
  }
}

/** Maps SDK errors to advice, so a bad key doesn't look like a network bug. */
export function explainError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return "Authentication failed - the key in ANTHROPIC_API_KEY is invalid or revoked. Check https://console.anthropic.com/settings/keys";
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return "Permission denied - the key is valid but lacks access to this resource or workspace.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited. Retry after a short wait, or raise limits in the Console.";
  }
  if (error instanceof Anthropic.BadRequestError) {
    return `Bad request: ${error.message}`;
  }
  if (error instanceof Anthropic.APIError) {
    return `API error ${error.status}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}
