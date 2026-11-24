export const REASONING_EFFORTS = Object.freeze(['none','low','medium','high']);

export function reasoningEffort(value) {
  if (['off','minimal','disabled'].includes(value)) return 'none';
  if (['max','xhigh','maximum'].includes(value)) return 'high';
  if (!REASONING_EFFORTS.includes(value)) throw Error('Reasoning effort must be none, low, medium or high');
  return value;
}

export function validateReasoningOptions(request) {
  if (Object.hasOwn(request,'reasoningEffort') && !REASONING_EFFORTS.includes(request.reasoningEffort)) {
    throw Error('Invalid signed reasoning effort');
  }
  if (Object.hasOwn(request,'reasoningBudgetTokens')) {
    const n=request.reasoningBudgetTokens;
    if (!Number.isSafeInteger(n) || n<0 || n>request.maxOutputTokens ||
        (n>0 && request.reasoningEffort==='none')) throw Error('Invalid thinking budget for the signed output limit');
  }
}

export function backendReasoning(request, anthropic = false) {
  validateReasoningOptions(request);
  const options = {};
  if (request.reasoningEffort !== undefined) {
    if (!anthropic) options.reasoning_effort=request.reasoningEffort;
    else if (request.reasoningEffort==='none') options.thinking={type:'disabled'};
    else options.output_config={effort:request.reasoningEffort};
  }
  if (request.reasoningBudgetTokens !== undefined) options.reasoning_budget_tokens=request.reasoningBudgetTokens;
  return options;
}
