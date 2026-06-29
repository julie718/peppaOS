function splitList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

function splitLines(value?: string): string[] {
  return String(value || '').split(/\n|;/).map(s => s.trim()).filter(Boolean);
}

function scoreSignal(text: string, signal: RegExp, points: number): number {
  return signal.test(text) ? points : 0;
}

export function scoreLead(args: {
  leadText?: string;
  product?: string;
}) {
  const text = String(args.leadText || '');
  const score =
    scoreSignal(text, /budget|预算|报价|价格|采购/i, 20) +
    scoreSignal(text, /timeline|deadline|本周|本月|尽快|上线/i, 20) +
    scoreSignal(text, /decision|boss|owner|负责人|老板|决策/i, 15) +
    scoreSignal(text, /pain|problem|痛点|问题|卡住|效率/i, 20) +
    scoreSignal(text, /competitor|替代|竞品|方案/i, 10) +
    scoreSignal(text, /demo|trial|试用|演示|开通/i, 15);
  const capped = Math.min(score, 100);

  return {
    product: args.product || '',
    score: capped,
    grade: capped >= 75 ? 'hot' : capped >= 45 ? 'warm' : 'cold',
    signals: {
      budget: /budget|预算|报价|价格|采购/i.test(text),
      timing: /timeline|deadline|本周|本月|尽快|上线/i.test(text),
      decisionMaker: /decision|boss|owner|负责人|老板|决策/i.test(text),
      pain: /pain|problem|痛点|问题|卡住|效率/i.test(text),
      demoIntent: /demo|trial|试用|演示|开通/i.test(text),
    },
    nextBestAction: capped >= 75
      ? 'Schedule decision-focused call and confirm budget, authority, timeline, and success criteria.'
      : capped >= 45
        ? 'Send targeted value proof and ask one qualification question.'
        : 'Nurture with useful content and wait for stronger intent signals.',
  };
}

export function draftFollowUp(args: {
  customerName?: string;
  context?: string;
  goal?: string;
  tone?: 'warm' | 'direct' | 'consultative';
}) {
  const name = args.customerName || 'there';
  const tone = args.tone || 'consultative';
  const opener = tone === 'direct'
    ? `Hi ${name}, following up on our discussion.`
    : tone === 'warm'
      ? `Hi ${name}, hope you are doing well. I wanted to follow up with a quick note.`
      : `Hi ${name}, I reviewed the context and wanted to suggest a practical next step.`;

  return {
    tone,
    message: [
      opener,
      args.context || 'Context summary goes here.',
      `Suggested next step: ${args.goal || 'confirm priorities and decide whether a short call is useful'}.`,
      'If helpful, I can also send a concise comparison or implementation checklist.',
    ].join('\n\n'),
    checklist: [
      'Reference the customer context, not a generic pitch.',
      'Ask for one clear next step.',
      'Avoid pressure, exaggerated claims, or unapproved discounts.',
    ],
  };
}

export function handleObjection(args: {
  objection?: string;
  product?: string;
  customerContext?: string;
}) {
  const objection = String(args.objection || '');
  const type = /price|expensive|预算|贵|价格/i.test(objection)
    ? 'price'
    : /time|busy|later|没时间|以后/i.test(objection)
      ? 'timing'
      : /trust|risk|安全|稳定|风险/i.test(objection)
        ? 'trust'
        : /competitor|already|已有|竞品|替代/i.test(objection)
          ? 'competition'
          : 'general';

  const responseMap: Record<string, string> = {
    price: 'Acknowledge budget pressure, clarify value driver, then compare cost of inaction against the smallest useful plan.',
    timing: 'Acknowledge timing, ask what needs to happen before evaluation, then offer a low-effort next step.',
    trust: 'Acknowledge risk, provide proof, explain safeguards, and suggest a reversible pilot.',
    competition: 'Acknowledge existing solution, ask what is working or missing, then compare only on relevant criteria.',
    general: 'Acknowledge the concern, ask one clarifying question, and tie the answer to customer goals.',
  };

  return {
    product: args.product || '',
    objectionType: type,
    customerContext: args.customerContext || '',
    responseFrame: responseMap[type],
    suggestedReply: [
      'I understand the concern.',
      responseMap[type],
      'Would it help if we narrow this to one concrete success metric and one small next step?',
    ].join(' '),
  };
}

export function reviewCustomerHealth(args: {
  customerText?: string;
}) {
  const lines = splitLines(args.customerText);
  const rows = lines.map((line, idx) => {
    let score = 50;
    if (/renew|expansion|active|好评|续费|增购|活跃/i.test(line)) score += 25;
    if (/ticket|complaint|bug|delay|投诉|工单|故障|延期/i.test(line)) score -= 20;
    if (/inactive|churn|cancel|沉默|流失|取消/i.test(line)) score -= 30;
    if (/decision|budget|owner|预算|负责人/i.test(line)) score += 10;
    score = Math.max(0, Math.min(100, score));
    return {
      customer: line.split(/:|：|-|,/)[0]?.trim() || `customer-${idx + 1}`,
      score,
      status: score >= 75 ? 'healthy' : score >= 45 ? 'watch' : 'at_risk',
      notes: line,
    };
  });

  return {
    rows,
    atRiskCustomers: rows.filter(row => row.status === 'at_risk').map(row => row.customer),
    nextActions: [
      'Confirm business outcome, usage, open issues, and renewal timeline.',
      'For at-risk accounts, assign one owner and one recovery action.',
      'Separate product issues, service issues, and procurement/budget issues.',
    ],
  };
}

export function triageSupportTickets(args: {
  ticketText?: string;
}) {
  const tickets = splitLines(args.ticketText).map((line, idx) => {
    const severity = /down|blocked|cannot use|无法使用|宕机|阻塞|严重/i.test(line)
      ? 'high'
      : /bug|error|delay|报错|异常|延期/i.test(line)
        ? 'medium'
        : 'low';
    const category = /billing|invoice|payment|账单|发票|付款/i.test(line)
      ? 'billing'
      : /login|password|auth|登录|密码|权限/i.test(line)
        ? 'account'
        : /bug|error|crash|报错|故障|异常/i.test(line)
          ? 'technical'
          : 'request';
    return {
      id: idx + 1,
      severity,
      category,
      ticket: line,
      suggestedFirstReply: severity === 'high'
        ? 'We received this and are treating it as urgent. Please share impact scope, screenshots/logs, and exact time if available.'
        : 'Thanks for the details. We will check this and follow up with the next step or clarification shortly.',
    };
  });

  return {
    tickets,
    highPriorityCount: tickets.filter(ticket => ticket.severity === 'high').length,
    routingSummary: tickets.reduce<Record<string, number>>((acc, ticket) => {
      acc[ticket.category] = (acc[ticket.category] || 0) + 1;
      return acc;
    }, {}),
  };
}
