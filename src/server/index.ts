/**
 * Worker entry point.
 *
 * `routeAgentRequest` maps `/agents/:agent/:instance` (HTTP and WebSocket) onto
 * the right Durable Object instance. Everything else falls through to the static
 * assets binding, which serves the React SPA.
 */

import { routeAgentRequest } from "agents";

import { isDemoMode } from "./demo";

export { ResearchAgent } from "./agent";
export { ResearchWorkflow } from "./workflow";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Small health endpoint, handy when checking a deployment.
    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        demoMode: isDemoMode(env),
        hasBraveKey: Boolean(env.BRAVE_SEARCH_API_KEY),
        hasTavilyKey: Boolean(env.TAVILY_API_KEY),
      });
    }

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // `env.ASSETS` is provided by the assets binding in wrangler.jsonc.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
