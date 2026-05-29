// Inject contact context into chat prompts when user mentions known people
import { Contact } from "./types";
import { RELATIONSHIP_LABELS } from "./types";

export function formatContactsForContext(contacts: Contact[]): string {
  if (contacts.length === 0) return '';
  const lines = ['## Contacts mentioned'];
  for (const c of contacts) {
    const rel = RELATIONSHIP_LABELS[c.relationship]?.zh || c.relationship;
    lines.push(`- ${c.name}（${rel}）`);
    if (c.notes) lines.push(`  备注: ${c.notes}`);
    if (c.traits) lines.push(`  性格: ${c.traits}`);
    if (c.preferences) lines.push(`  偏好: ${c.preferences}`);
    if (c.lastContacted) lines.push(`  上次联系: ${c.lastContacted.slice(0, 10)}`);
  }
  return lines.join('\n');
}
