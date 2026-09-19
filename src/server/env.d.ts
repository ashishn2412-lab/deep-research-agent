/**
 * Bindings that `wrangler types` cannot infer.
 *
 * Secrets are not declared in wrangler.jsonc (that is the point of a secret), so
 * they are declared here and merged into the generated `Env` interface. Both are
 * optional — the search layer falls back to keyless providers without them.
 *
 * Add them with:
 *   wrangler secret put BRAVE_SEARCH_API_KEY
 *   wrangler secret put TAVILY_API_KEY
 * or, for local dev, put them in a `.dev.vars` file.
 */

interface Env {
  BRAVE_SEARCH_API_KEY?: string;
  TAVILY_API_KEY?: string;
  /** Set both to reach Workers AI over REST instead of the `AI` binding. */
  CF_ACCOUNT_ID?: string;
  CF_AI_API_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env {
    BRAVE_SEARCH_API_KEY?: string;
    TAVILY_API_KEY?: string;
    CF_ACCOUNT_ID?: string;
    CF_AI_API_TOKEN?: string;
  }
}
