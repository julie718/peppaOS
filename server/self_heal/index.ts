// 阶段二·自诊疗模块 — 入口汇总
// 对外暴露：引擎（runSelfHeal/manualTrigger）、模板库、断言库、路由挂载、存储。
export * from './types';
export { buildStandardAssertions } from './assertions';
export { REPAIR_TEMPLATES } from './templates';
export { checkSyntax, createSnapshot, rollbackFromSnapshot, appendRollbackLog, dryRunTemplateFix } from './editor';
export { runLocalRegression, runFullRegression, verifyAfterRepair } from './regression';
export { runSelfHeal, manualTrigger, computeHealthScore, judgeVerdict, listSourceFiles } from './engine';
export { saveSelfHealRecord, listSelfHealRecords, countOpenDefects, listRepairHistory, getSelfHealDbPath, closeSelfHealDb } from './store';
export { mountSelfHealRoutes } from './routes';
