import { getUserPreferredVision } from '../llm/vision_preferences';

const VISUAL_INTENT_PATTERNS: RegExp[] = [
  /\b(?:look\s+at|see|read|ocr|identify|recognize|describe|analy[sz]e|inspect|scan)\b.*\b(?:screen|screenshot|image|photo|picture|diagram|drawing|ui|interface|error|qr|barcode|table|receipt|chart)\b/i,
  /\b(?:what(?:'s| is)|who(?:'s| is)|tell me what)\b.*\b(?:on|in)\b.*\b(?:screen|screenshot|image|photo|picture|diagram|drawing)\b/i,
  /\b(?:screen|screenshot|image|photo|picture|diagram|drawing|ui|interface|qr|barcode|chart)\b.*\b(?:look|read|ocr|identify|recognize|describe|analy[sz]e|inspect)\b/i,
  /\.(?:png|jpe?g|webp|bmp|gif|tiff?)\b/i,
  /(?:屏幕上有什么|桌面上有什么|看一下屏幕|看看屏幕|看一下桌面|看看桌面|当前画面|当前窗口|前台窗口|识别屏幕|读屏幕|分析屏幕|看屏幕|看桌面)/u,
  /(?:看|看看|识别|辨认|读取|读一下|读取|分析|描述|解释|检查|扫|扫描).*(?:屏幕|截图|截屏|图片|照片|图像|图里|这张图|这个图|界面|画面|报错|二维码|条形码|表格|票据|手写|户型图|平面图|图纸|设计图|CAD)/u,
  /(?:屏幕|截图|截屏|图片|照片|图像|图里|这张图|这个图|界面|画面|报错|二维码|条形码|表格|户型图|平面图|图纸|设计图|CAD).*(?:看|看看|识别|辨认|读取|读一下|分析|描述|解释|检查|扫|扫描)/u,
  /(?:识别|辨认).*(?:这个|这个人|这是什么|是谁|哪种|什么东西|哪里不对)/u,
];

export function hasVisionIntent(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  return VISUAL_INTENT_PATTERNS.some(pattern => pattern.test(normalized));
}

export function buildVisionRoutingOverlay(userId: string, text: string): string {
  if (!hasVisionIntent(text)) return '';
  const vision = getUserPreferredVision(userId);
  return [
    '## Vision Capability Routing',
    `Configured Vision Model: ${vision.provider}/${vision.model}.`,
    'The current primary reasoning model is not the whole Peppa. For visual requests, route perception through the configured Vision Model and vision tools.',
    'If the user asks to see, identify, recognize, read, OCR, inspect, or analyze an image, photo, screenshot, visible screen, UI, diagram, drawing, floor plan, QR code, or visual error:',
    '- Do not refuse by saying the primary model lacks vision.',
    '- Use ocr_screen for the current visible screen.',
    '- Use ocr_region when the user names a specific area.',
    '- Use ocr_image_file when the user provides or references an image file path.',
    '- Use floorplan_extract_geometry for floor plans or drawings that need CAD-ready structure.',
    '- Use computer_use only when the user asks Peppa to operate the desktop after seeing it.',
    '- If there is no visible screen target, image, screenshot, or file path available, ask the user for the image or clarify what Peppa should look at.',
  ].join('\n');
}

export function buildModelSelfAwareness(
  provider: string,
  model: string,
  userId: string,
  options: { visionAware?: boolean } = {},
): string {
  const base = `Primary reasoning provider: ${provider}, model: ${model}.`;
  if (!options.visionAware) {
    return `\n\n[System note: ${base} If asked which text/reasoning model is replying, mention this exact primary model.]`;
  }

  const vision = getUserPreferredVision(userId);
  return [
    '',
    '',
    '[System note:',
    base,
    `Configured vision provider: ${vision.provider}, model: ${vision.model}.`,
    'If asked about visual capability, explain that Peppa routes visual perception through the configured Vision Model and vision tools; do not say Peppa cannot see merely because the primary reasoning model is text-only.',
    ']',
  ].join('\n');
}
