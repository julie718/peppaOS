function splitList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

function splitLines(value?: string): string[] {
  return String(value || '').split(/\n|;/).map(s => s.trim()).filter(Boolean);
}

function containsAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

export function buildJobDescription(args: {
  role?: string;
  level?: string;
  team?: string;
  responsibilities?: string | string[];
  requirements?: string | string[];
  sellingPoints?: string | string[];
  location?: string;
}) {
  const role = args.role || 'Role';
  const responsibilities = splitList(args.responsibilities);
  const requirements = splitList(args.requirements);
  const sellingPoints = splitList(args.sellingPoints);

  return {
    role,
    level: args.level || 'unspecified',
    team: args.team || '',
    location: args.location || '',
    jd: {
      summary: `${role} will join ${args.team || 'the team'} to own clear outcomes and collaborate across the business.`,
      responsibilities: responsibilities.length > 0 ? responsibilities : [
        'Own role-specific outcomes and communicate progress clearly.',
        'Collaborate with cross-functional partners to deliver business results.',
        'Improve process quality, documentation, and repeatability.',
      ],
      requirements: requirements.length > 0 ? requirements : [
        'Relevant experience or portfolio evidence for the role.',
        'Clear communication and structured problem solving.',
        'Ability to operate with accountability and good judgment.',
      ],
      sellingPoints: sellingPoints.length > 0 ? sellingPoints : [
        'Visible ownership area and direct business impact.',
        'Room to improve systems, processes, and team practices.',
      ],
    },
    fairnessChecks: [
      'Avoid age, gender, marital status, health, school pedigree, or other protected-class preferences.',
      'Separate must-have requirements from nice-to-have preferences.',
      'Use outcome language instead of vague traits such as young, aggressive, or stable.',
    ],
  };
}

export function summarizeResumeFit(args: {
  resumeText?: string;
  roleRequirements?: string | string[];
}) {
  const text = String(args.resumeText || '');
  const requirements = splitList(args.roleRequirements);
  const lower = text.toLowerCase();
  const matches = requirements.map(req => ({
    requirement: req,
    matched: containsAny(lower, [new RegExp(req.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')]),
  }));

  return {
    requirementMatches: matches,
    matchCount: matches.filter(item => item.matched).length,
    strengths: splitLines(text).filter(line => /led|built|owned|improved|launched|增长|负责|搭建|优化|上线|管理/i.test(line)).slice(0, 6),
    concernsToCheck: [
      ...requirements.filter((_, idx) => !matches[idx]?.matched).map(req => `No clear evidence for: ${req}`),
      'Confirm scope, depth, and recency of claimed experience in interview.',
      'Avoid inferring age, family status, health, or other protected attributes from resume content.',
    ],
    interviewFocus: [
      'Ask for one concrete project with context, action, result, and tradeoffs.',
      'Probe collaboration, ownership, learning speed, and role-specific judgment.',
      'Use the same evaluation criteria for comparable candidates.',
    ],
  };
}

export function buildInterviewPlan(args: {
  role?: string;
  competencies?: string | string[];
  interviewStage?: string;
}) {
  const competencies = splitList(args.competencies);
  const selected = competencies.length > 0 ? competencies : ['Role skill', 'Problem solving', 'Communication', 'Ownership'];
  return {
    role: args.role || 'role',
    interviewStage: args.interviewStage || 'main interview',
    plan: selected.map((competency, idx) => ({
      competency,
      minutes: idx === 0 ? 15 : 10,
      question: `Tell me about a time you demonstrated ${competency}. What was the context, action, result, and lesson?`,
      evidenceToListenFor: ['Specific example', 'Candidate-owned action', 'Measurable result', 'Reflection and tradeoff awareness'],
    })),
    scoring: selected.map(competency => ({ competency, scale: '1-5', anchor: 'Score evidence, not personal similarity.' })),
    closing: ['Candidate questions', 'Role reality preview', 'Next-step timeline'],
  };
}

export function compareCandidates(args: {
  candidatesText?: string;
  criteria?: string | string[];
}) {
  const criteria = splitList(args.criteria);
  const selected = criteria.length > 0 ? criteria : ['Role fit', 'Impact evidence', 'Communication', 'Risk'];
  const candidates = splitLines(args.candidatesText).map((line, idx) => ({
    candidate: line.split(/:|：|-|,/)[0]?.trim() || `Candidate ${idx + 1}`,
    notes: line,
    evaluation: selected.map(criterion => ({
      criterion,
      evidencePrompt: `What evidence in the notes supports ${criterion}?`,
      riskPrompt: `What evidence is missing or needs verification for ${criterion}?`,
    })),
  }));

  return {
    candidates,
    comparisonTable: selected,
    decisionGuidance: [
      'Choose based on role-critical evidence and constraints, not likeability alone.',
      'Document reasons consistently for hiring process fairness.',
      'Escalate compensation, level, or legal concerns before making an offer.',
    ],
  };
}

export function buildOnboardingChecklist(args: {
  role?: string;
  startDate?: string;
  manager?: string;
  systems?: string | string[];
}) {
  return {
    role: args.role || 'new hire',
    startDate: args.startDate || 'TBD',
    manager: args.manager || 'TBD',
    checklist: {
      beforeDayOne: ['Offer accepted and documents complete', 'Equipment and account access prepared', 'First-week calendar drafted'],
      weekOne: ['Team intro', 'Role expectations', 'Product/process walkthrough', 'First small task with feedback'],
      firstThirtyDays: ['Success metrics agreed', 'Regular 1:1 cadence', 'Stakeholder map', 'Learning gaps reviewed'],
      systems: splitList(args.systems),
    },
    managerPrompts: [
      'What does good performance look like in 30, 60, and 90 days?',
      'Who should the new hire meet first?',
      'What common mistakes should we proactively prevent?',
    ],
  };
}
