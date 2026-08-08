// 视觉能力路由 — 【重构】移除意图正则池（VISUAL_INTENT_PATTERNS）
// 文本中"看屏幕/识别图片"类描述不再由正则前置判定；仅保留**客观数据信号**（图片文件路径/URL 扩展名），
// 与股票代码归一化同属数据层识别（保留类别）。视觉意图的完整理解交由心智内核（LLM）自主完成，
// 工具自描述（ocr_screen / ocr_image_file 等）支撑其决策。
import { getUserPreferredVision } from '../llm/vision_preferences';

/**
 * 数据层视觉信号判定（非意图正则）：
 * 文本中携带图片/截图文件路径或 URL 时返回 true —— 这是客观数据形态，而非语言意图猜测。
 */
export function hasVisionIntent(text: string): boolean {
  const normalized = String(text || '').trim();
  if (!normalized) return false;
  // 图片文件扩展名（客观数据形态）
  if (/\.(?:png|jpe?g|webp|bmp|gif|tiff?)(?:[?#\s，,。！？!?]|$)/i.test(normalized)) return true;
  // 常见本地截图/上传目录（客观路径形态）
  if (/(?:^|\s)(?:\/tmp\/|\/Users\/[^/\s]+\/(?:Desktop|Downloads|Pictures)\/|C:\\Users\\[^\\\s]+\\Pictures\\)/i.test(normalized)) return true;
  return false;
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
