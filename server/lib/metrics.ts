import client from 'prom-client';

const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route'] as const,
  registers: [register],
});

export const llmCallsTotal = new client.Counter({
  name: 'llm_calls_total',
  help: 'Total LLM API calls',
  labelNames: ['provider', 'model'] as const,
  registers: [register],
});

export const llmTokensTotal = new client.Counter({
  name: 'llm_tokens_total',
  help: 'Total LLM tokens consumed',
  labelNames: ['provider', 'model', 'type'] as const,
  registers: [register],
});

export const llmCallDuration = new client.Histogram({
  name: 'llm_call_duration_seconds',
  help: 'LLM API call duration in seconds',
  labelNames: ['provider', 'model'] as const,
  registers: [register],
});

export async function getMetricsText(): Promise<string> {
  return register.metrics();
}
