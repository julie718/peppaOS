function splitLines(value?: string): string[] {
  return String(value || '').split(/\n|;/).map(s => s.trim()).filter(Boolean);
}

function round(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function nums(text: string): number[] {
  return Array.from(text.matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?/g)).map(m => Number(m[0].replace(/,/g, '')));
}

function firstMetric(line: string, labels: RegExp[]): number | undefined {
  const normalized = line.replace(/,/g, '');
  for (const label of labels) {
    const match = normalized.match(new RegExp(`(?:${label.source})\\s*[:=：]?\\s*(-?\\d+(?:\\.\\d+)?)`, 'i'));
    if (match) return Number(match[1]);
  }
  return undefined;
}

function nameFromLine(line: string, index: number): string {
  return line.split(/,|，|;|；|\t/)[0]?.trim() || `item-${index + 1}`;
}

export function analyzeMenuMargin(args: {
  menuText?: string;
  currency?: string;
}) {
  const rows = splitLines(args.menuText).map((line, idx) => {
    const values = nums(line);
    const price = firstMetric(line, [/price|售价|单价|收入/]) ?? values[0] ?? 0;
    const cost = firstMetric(line, [/cost|成本|食材|采购/]) ?? values[1] ?? 0;
    const sales = firstMetric(line, [/sales|sold|销量|份数|件数/]) ?? values[2] ?? 1;
    const grossProfit = (price - cost) * sales;
    return {
      item: nameFromLine(line, idx),
      price: round(price),
      cost: round(cost),
      sales: Math.max(0, Math.round(sales)),
      unitMargin: price > 0 ? round((price - cost) / price * 100) : 0,
      grossProfit: round(grossProfit),
      status: price <= 0 ? 'missing_price' : (price - cost) / price < 0.45 ? 'review_margin' : 'healthy',
    };
  });

  return {
    currency: args.currency || 'CNY',
    rows,
    totalGrossProfit: round(rows.reduce((sum, row) => sum + row.grossProfit, 0)),
    reviewItems: rows.filter(row => row.status !== 'healthy').map(row => row.item),
    nextActions: [
      'Check low-margin bestsellers first; small price or portion changes can matter.',
      'Separate traffic-driving items from profit-driving items before changing menu structure.',
      'Verify recipe cost, packaging, delivery commission, and discount impact.',
    ],
  };
}

export function analyzeWaste(args: {
  wasteText?: string;
  currency?: string;
}) {
  const rows = splitLines(args.wasteText).map((line, idx) => {
    const values = nums(line);
    const wastedQty = firstMetric(line, [/waste|lost|报损|损耗|浪费/]) ?? values[0] ?? 0;
    const unitCost = firstMetric(line, [/unit.?cost|cost|单价|成本/]) ?? values[1] ?? 0;
    const soldQty = firstMetric(line, [/sold|sales|销量|售出/]) ?? values[2] ?? 0;
    const wasteValue = wastedQty * unitCost;
    return {
      item: nameFromLine(line, idx),
      wastedQty: round(wastedQty),
      unitCost: round(unitCost),
      soldQty: round(soldQty),
      wasteValue: round(wasteValue),
      wasteRate: soldQty + wastedQty > 0 ? round(wastedQty / (soldQty + wastedQty) * 100) : null,
    };
  });

  return {
    currency: args.currency || 'CNY',
    rows,
    totalWasteValue: round(rows.reduce((sum, row) => sum + row.wasteValue, 0)),
    highWasteItems: rows.filter(row => (row.wasteRate || 0) >= 8).map(row => row.item),
    controls: [
      'Compare prep quantity with hourly sales rhythm.',
      'Use first-expire-first-out and log reason for every high-value waste item.',
      'Adjust purchasing or prep batch size before discounting heavily.',
    ],
  };
}

export function buildShiftPlan(args: {
  forecastText?: string;
  staffCount?: number;
  laborBudgetHours?: number;
}) {
  const lines = splitLines(args.forecastText);
  const totalStaff = Math.max(1, Number(args.staffCount || 3));
  const budget = Math.max(0, Number(args.laborBudgetHours || totalStaff * 8));
  const rows = lines.map((line, idx) => {
    const values = nums(line);
    const forecastOrders = firstMetric(line, [/orders|客单|订单|单量|人次/]) ?? values[0] ?? 0;
    const requiredStaff = Math.max(1, Math.ceil(forecastOrders / 25));
    return {
      period: nameFromLine(line, idx),
      forecastOrders: Math.round(forecastOrders),
      requiredStaff: Math.min(requiredStaff, totalStaff),
      focus: forecastOrders >= 80 ? 'rush' : forecastOrders >= 35 ? 'steady' : 'prep_or_cleaning',
    };
  });

  return {
    staffCount: totalStaff,
    laborBudgetHours: budget,
    rows,
    riskFlags: rows.filter(row => row.requiredStaff >= totalStaff && row.focus === 'rush').map(row => `${row.period}: forecast may exceed staffing capacity.`),
    managerChecklist: [
      'Assign rush-hour cashier, production, runner, and cleaning roles clearly.',
      'Protect legal rest periods and local labor compliance.',
      'Use quiet periods for prep, inventory, training, and cleaning.',
    ],
  };
}

export function summarizeReviews(args: {
  reviewText?: string;
}) {
  const lines = splitLines(args.reviewText);
  const themes: Record<string, number> = {};
  const themeRules: Array<[string, RegExp]> = [
    ['taste', /taste|delicious|flavor|好吃|味道|口味/i],
    ['service', /service|staff|wait|服务|态度|等待|排队/i],
    ['cleanliness', /clean|卫生|干净|脏/i],
    ['price', /price|expensive|value|价格|贵|划算/i],
    ['delivery', /delivery|takeout|外卖|配送|打包/i],
  ];
  for (const line of lines) {
    for (const [theme, rule] of themeRules) {
      if (rule.test(line)) themes[theme] = (themes[theme] || 0) + 1;
    }
  }
  const negative = lines.filter(line => /bad|slow|expensive|dirty|cold|差|慢|贵|脏|冷|不好/i.test(line));

  return {
    reviewCount: lines.length,
    themes,
    negativeSamples: negative.slice(0, 5),
    actionIdeas: [
      'Turn repeated negative themes into one operational fix with an owner.',
      'Use positive themes in menu, platform listing, and staff training.',
      'Respond to complaints with factual apology, correction step, and invitation to return.',
    ],
  };
}

export function analyzePromotionRoi(args: {
  promotionText?: string;
  grossMarginRate?: number;
  currency?: string;
}) {
  const rateRaw = Number(args.grossMarginRate ?? 0.55);
  const grossMarginRate = rateRaw > 1 ? rateRaw / 100 : rateRaw;
  const rows = splitLines(args.promotionText).map((line, idx) => {
    const values = nums(line);
    const revenue = firstMetric(line, [/revenue|sales|销售额|收入|流水/]) ?? values[0] ?? 0;
    const discount = firstMetric(line, [/discount|coupon|优惠|折扣|券/]) ?? values[1] ?? 0;
    const adCost = firstMetric(line, [/ad|marketing|推广|广告/]) ?? values[2] ?? 0;
    const orders = firstMetric(line, [/orders|订单|单量/]) ?? values[3] ?? 0;
    const contribution = revenue * grossMarginRate - discount - adCost;
    return {
      promotion: nameFromLine(line, idx),
      revenue: round(revenue),
      discount: round(discount),
      adCost: round(adCost),
      orders: Math.max(0, Math.round(orders)),
      contribution: round(contribution),
      status: contribution > 0 ? 'profitable' : 'loss_making',
    };
  });

  return {
    currency: args.currency || 'CNY',
    grossMarginRate,
    rows,
    profitablePromotions: rows.filter(row => row.status === 'profitable').map(row => row.promotion),
    warnings: rows.filter(row => row.status === 'loss_making').map(row => `${row.promotion}: promotion contribution is negative.`),
  };
}
