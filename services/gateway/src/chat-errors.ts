import OpenAI from 'openai';

export type ChatFailure = { code: string; status: number; message: string };
export function chatFailure(error: unknown): ChatFailure {
  if (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    (error instanceof Error &&
      ['TimeoutError', 'AbortError'].includes(error.name))
  )
    return {
      code: 'model_timeout',
      status: 504,
      message: 'The model timed out.',
    };
  if (error instanceof OpenAI.APIError) {
    if (error.status === 429) {
      const quota =
        error.type === 'insufficient_quota' ||
        [
          'insufficient_quota',
          'credit_balance_exhausted',
          'organization_spend_limit_exceeded',
          'project_spend_limit_exceeded',
          'organization_usage_limit_exceeded',
        ].includes(error.code ?? '');
      return quota
        ? {
            code: 'model_quota',
            status: 503,
            message:
              'OpenAI quota or billing limit reached. Ask the operator to check billing.',
          }
        : {
            code: 'model_rate_limit',
            status: 429,
            message:
              'OpenAI is rate limiting requests. Wait before trying again.',
          };
    }
    if ([400, 401, 403, 404].includes(error.status ?? 0))
      return {
        code: 'model_configuration',
        status: 502,
        message:
          'OpenAI rejected the configured key, model, or request. Ask the operator to check the chat configuration.',
      };
  }
  return {
    code: 'model_unavailable',
    status: 503,
    message: 'Chat is temporarily unavailable.',
  };
}
export function chatErrorEvent(error: unknown, failure: ChatFailure) {
  // Deliberately exclude messages, bodies, headers, prompts and arbitrary provider codes.
  const requestId = error instanceof OpenAI.APIError ? error.requestID : null;
  return {
    event: 'chat_model_error',
    code: failure.code,
    status: error instanceof OpenAI.APIError ? (error.status ?? null) : null,
    requestId:
      requestId && /^req_[a-zA-Z0-9_-]{1,100}$/.test(requestId)
        ? requestId
        : null,
  };
}
