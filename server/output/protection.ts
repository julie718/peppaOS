/**
 * 输出保护（任务清单第 3 项）— 正式对话消息一旦下发前端即不可撤销/删除；
 * 任务失败只允许「追加新消息」报错，禁止覆盖/销毁已下发内容。
 *
 * 规则：
 *   - registerFormalDelivered(requestKey) 在 agent:response 正式下发时登记该轮 key；
 *   - emitProtectedFinal() 为正式回复统一出口：若该轮已下发过正式回复，
 *     拒绝再次发出会覆盖/重复的 agent:response，改为仅追加一条 agent:error 新消息；
 *   - hasFormalDelivered() 供失败路径判断：已下发 → 追加报错；未下发 → 正常兜底回复。
 *
 * 前端侧配套（AgentChatPage.tsx）：agent:error / status idle 不再删除已渲染的
 * 兜底/流式气泡，仅追加错误气泡 —— 与服务端语义一致（追加不改写）。
 */
const deliveredFormal = new Set<string>();

export function registerFormalDelivered(requestKey: string): void {
  deliveredFormal.add(requestKey);
}

export function hasFormalDelivered(requestKey: string): boolean {
  return deliveredFormal.has(requestKey);
}

/**
 * 正式回复统一出口。
 * 返回 true = 本次为正式下发（agent:response）；false = 已被保护拦截，仅追加了报错。
 */
export function emitProtectedFinal(
  emit: (event: string, payload: any) => void,
  requestKey: string,
  payload: Record<string, any>,
  errorText?: string,
): boolean {
  if (hasFormalDelivered(requestKey)) {
    // 保护：已下发的正式消息不可覆盖/撤销 —— 只追加一条报错新消息
    emit('agent:error', {
      message: errorText || '任务处理过程中出现异常，已保留已生成的回复。',
      requestId: payload.requestId,
      source: payload.source,
    });
    return false;
  }
  registerFormalDelivered(requestKey);
  emit('agent:response', payload);
  return true;
}
