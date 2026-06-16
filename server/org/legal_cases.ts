import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDataPath } from '../config/data_path';
import * as EDB from './db';

export type LegalCaseStage = 'consultation' | 'filing' | 'trial' | 'judgment' | 'enforcement' | 'closed';
export type LegalCaseMaterialType = 'consultation' | 'evidence' | 'pleading' | 'judgment' | 'contract' | 'note';

export interface OrgLegalCaseMaterial {
  id: string;
  type: LegalCaseMaterialType;
  title: string;
  content: string;
  fileName?: string;
  localPath?: string;
  source: 'manual' | 'meeting' | 'feishu' | 'tool' | 'import';
  createdBy: string;
  createdAt: string;
}

export interface OrgLegalCaseFile {
  id: string;
  orgId: string;
  title: string;
  caseNumber: string;
  party: string;
  cause: string;
  court: string;
  judge: string;
  stage: LegalCaseStage;
  hearingDate: string;
  judgmentDate: string;
  appealDeadline: string;
  enforcementDeadline: string;
  notes: string;
  materials: OrgLegalCaseMaterial[];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

const STORE_PATH = getDataPath(path.join('org', 'legal_cases.json'));

interface StoreShape {
  cases: OrgLegalCaseFile[];
}

function now() {
  return new Date().toISOString();
}

function readStore(): StoreShape {
  try {
    if (!fs.existsSync(STORE_PATH)) return { cases: [] };
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { cases: Array.isArray(parsed?.cases) ? parsed.cases : [] };
  } catch {
    return { cases: [] };
  }
}

function writeStore(store: StoreShape) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

export function extractLegalCaseHints(text: string): Partial<Pick<OrgLegalCaseFile, 'caseNumber' | 'court' | 'hearingDate' | 'judgmentDate' | 'cause'>> {
  const hints: Partial<Pick<OrgLegalCaseFile, 'caseNumber' | 'court' | 'hearingDate' | 'judgmentDate' | 'cause'>> = {};
  const caseNumber = text.match(/[（(]\d{4}[）)][^，。；;\n]{2,60}[号字]/)?.[0] || '';
  const court = text.match(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/)?.[0] || '';
  const dateMatch = text.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/);
  const cause = text.match(/案由[：:\s]+([^\n，。；;]{2,40})/)?.[1] || '';
  if (caseNumber) hints.caseNumber = caseNumber;
  if (court) hints.court = court;
  if (dateMatch) hints.hearingDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
  if (cause) hints.cause = cause.trim();
  return hints;
}

export function listCases(orgId: string, query = '', limit = 50): OrgLegalCaseFile[] {
  const q = query.trim().toLowerCase();
  let cases = readStore().cases.filter(item => item.orgId === orgId);
  if (q) {
    cases = cases.filter(item => {
      const haystack = [
        item.title,
        item.caseNumber,
        item.party,
        item.cause,
        item.court,
        item.judge,
        item.notes,
        ...(item.materials || []).map(mat => `${mat.title}\n${mat.content.slice(0, 2000)}`),
      ].join('\n').toLowerCase();
      return haystack.includes(q);
    });
  }
  return cases
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

export function getCase(orgId: string, caseId: string): OrgLegalCaseFile | null {
  return readStore().cases.find(item => item.orgId === orgId && item.id === caseId) || null;
}

export function createCase(orgId: string, userId: string, input: Partial<OrgLegalCaseFile>): OrgLegalCaseFile {
  const store = readStore();
  const ts = now();
  const caseFile: OrgLegalCaseFile = {
    id: randomUUID(),
    orgId,
    title: normalizeText(input.title) || '未命名案件',
    caseNumber: normalizeText(input.caseNumber),
    party: normalizeText(input.party),
    cause: normalizeText(input.cause),
    court: normalizeText(input.court),
    judge: normalizeText(input.judge),
    stage: (input.stage as LegalCaseStage) || 'consultation',
    hearingDate: normalizeText(input.hearingDate),
    judgmentDate: normalizeText(input.judgmentDate),
    appealDeadline: normalizeText(input.appealDeadline),
    enforcementDeadline: normalizeText(input.enforcementDeadline),
    notes: normalizeText(input.notes),
    materials: Array.isArray(input.materials) ? input.materials : [],
    createdBy: userId,
    updatedBy: userId,
    createdAt: ts,
    updatedAt: ts,
  };
  store.cases.unshift(caseFile);
  writeStore(store);
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.create',
    resourceType: 'legal_case',
    resourceId: caseFile.id,
    details: { title: caseFile.title, caseNumber: caseFile.caseNumber },
  });
  return caseFile;
}

export function updateCase(orgId: string, userId: string, caseId: string, patch: Partial<OrgLegalCaseFile>): OrgLegalCaseFile | null {
  const store = readStore();
  const idx = store.cases.findIndex(item => item.orgId === orgId && item.id === caseId);
  if (idx < 0) return null;
  const current = store.cases[idx];
  const next: OrgLegalCaseFile = {
    ...current,
    ...patch,
    id: current.id,
    orgId: current.orgId,
    materials: patch.materials || current.materials || [],
    updatedBy: userId,
    updatedAt: now(),
  };
  store.cases[idx] = next;
  writeStore(store);
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.update',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: { fields: Object.keys(patch) },
  });
  return next;
}

export function addMaterial(
  orgId: string,
  userId: string,
  caseId: string,
  material: Omit<OrgLegalCaseMaterial, 'id' | 'createdBy' | 'createdAt'>,
): OrgLegalCaseMaterial | null {
  const current = getCase(orgId, caseId);
  if (!current) return null;
  const nextMaterial: OrgLegalCaseMaterial = {
    id: randomUUID(),
    type: material.type,
    title: normalizeText(material.title) || '案件材料',
    content: normalizeText(material.content),
    fileName: material.fileName,
    localPath: material.localPath,
    source: material.source,
    createdBy: userId,
    createdAt: now(),
  };
  const nextMaterials = [nextMaterial, ...(current.materials || [])];
  updateCase(orgId, userId, caseId, {
    materials: nextMaterials,
    notes: [current.notes, material.content ? `【材料归档】${nextMaterial.title}` : ''].filter(Boolean).join('\n'),
  });
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.material.add',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: { title: nextMaterial.title, source: nextMaterial.source, fileName: nextMaterial.fileName },
  });
  return nextMaterial;
}

export function createCaseFromRemoteMaterial(params: {
  orgId: string;
  userId: string;
  title: string;
  text: string;
  fileName?: string;
  localPath?: string;
  source?: OrgLegalCaseMaterial['source'];
}): OrgLegalCaseFile {
  const hints = extractLegalCaseHints(params.text);
  const caseFile = createCase(params.orgId, params.userId, {
    title: params.title || hints.caseNumber || params.fileName || '远程案件材料',
    caseNumber: hints.caseNumber || '',
    court: hints.court || '',
    cause: hints.cause || '',
    hearingDate: hints.hearingDate || '',
    notes: params.text.slice(0, 4000),
    stage: 'consultation',
  });
  addMaterial(params.orgId, params.userId, caseFile.id, {
    type: 'evidence',
    title: params.fileName || params.title || '远程案件材料',
    content: params.text,
    fileName: params.fileName,
    localPath: params.localPath,
    source: params.source || 'feishu',
  });
  return getCase(params.orgId, caseFile.id) || caseFile;
}
