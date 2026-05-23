import { readDB, writeDB } from "../../db_layer";
import { LLMUsage } from "../tools/types";

export function recordTokenUsage(
  userId: string,
  provider: string,
  model: string,
  usage: LLMUsage | undefined,
  interactionId: string,
  mode: string = 'chat',
): void {
  if (!usage || (usage.promptTokens === 0 && usage.completionTokens === 0)) return;
  const db = readDB();
  if (!db.tokenUsage) db.tokenUsage = [];
  db.tokenUsage.push({
    id: crypto.randomUUID(),
    userId,
    provider,
    model,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    mode,
    interactionId,
    timestamp: new Date().toISOString(),
  });
  writeDB(db);
}
