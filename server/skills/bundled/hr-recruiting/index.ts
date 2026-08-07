import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  buildInterviewPlan,
  buildJobDescription,
  buildOnboardingChecklist,
  compareCandidates,
  summarizeResumeFit,
} from './logic';

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

const server = new McpServer({ name: 'hr-recruiting', version: '1.0.0' }, { capabilities: { tools: {} } });

server.registerTool('job_description_builder', {
  description: 'Build a fair, outcome-focused job description with responsibilities, requirements, selling points, and fairness checks.',
  inputSchema: {
    role: z.string().describe('Role title'),
    level: z.string().optional().describe('Level or seniority'),
    team: z.string().optional().describe('Team or department'),
    responsibilities: z.union([z.string(), z.array(z.string())]).optional().describe('Responsibilities'),
    requirements: z.union([z.string(), z.array(z.string())]).optional().describe('Requirements'),
    sellingPoints: z.union([z.string(), z.array(z.string())]).optional().describe('Role or company selling points'),
    location: z.string().optional().describe('Location or work mode'),
  },
}, async (args: any) => ok(buildJobDescription(args)));

server.registerTool('resume_fit_summary', {
  description: 'Summarize resume fit against role requirements, highlight strengths, concerns to verify, and interview focus areas.',
  inputSchema: {
    resumeText: z.string().describe('Resume or candidate notes'),
    roleRequirements: z.union([z.string(), z.array(z.string())]).describe('Role requirements to check'),
  },
}, async (args: any) => ok(summarizeResumeFit(args)));

server.registerTool('interview_plan_builder', {
  description: 'Create a structured interview plan with competency questions, evidence anchors, scoring, and closing steps.',
  inputSchema: {
    role: z.string().describe('Role title'),
    competencies: z.union([z.string(), z.array(z.string())]).optional().describe('Competencies to evaluate'),
    interviewStage: z.string().optional().describe('Interview stage'),
  },
}, async (args: any) => ok(buildInterviewPlan(args)));

server.registerTool('candidate_comparison', {
  description: 'Create a candidate comparison frame across criteria with evidence prompts and decision guidance.',
  inputSchema: {
    candidatesText: z.string().describe('Candidate notes, one candidate per line'),
    criteria: z.union([z.string(), z.array(z.string())]).optional().describe('Comparison criteria'),
  },
}, async (args: any) => ok(compareCandidates(args)));

server.registerTool('onboarding_checklist', {
  description: 'Create a role-specific onboarding checklist for before day one, week one, first 30 days, and system access.',
  inputSchema: {
    role: z.string().describe('Role title'),
    startDate: z.string().optional().describe('Start date'),
    manager: z.string().optional().describe('Manager name'),
    systems: z.union([z.string(), z.array(z.string())]).optional().describe('Systems/accounts needed'),
  },
}, async (args: any) => ok(buildOnboardingChecklist(args)));

const transport = new StdioServerTransport();
await server.connect(transport);
