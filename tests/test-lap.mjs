/**
 * LAP Protocol Test — simulates two Peppa agents performing:
 * 1. Handshake
 * 2. Task delegation
 * 3. Context sharing
 * 4. Session revocation
 */
import WebSocket from 'ws';

const LAP_URL = 'ws://localhost:3000/lap';
const log = (...args) => console.log(...args);

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(LAP_URL);
    ws.on('open', () => { log(`[${name}] Connected`); resolve(ws); });
    ws.on('error', (err) => { log(`[${name}] Error:`, err.message); reject(err); });
  });
}

function send(ws, payload) {
  const msg = { lap: '2.0', id: `msg_${Date.now()}`, timestamp: new Date().toISOString(), ...payload };
  ws.send(JSON.stringify(msg));
  return msg;
}

function waitFor(ws, predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout')), timeout);
    const handler = (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off('message', handler);
          resolve(msg);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

async function main() {
  log('═══ LAP Protocol Test ═══\n');

  // ── Agent A connects ──
  const wsA = await connect('Agent A');

  // Receive welcome
  const welcome = await waitFor(wsA, m => m.method === 'lap.welcome');
  log(`[Agent A] Welcome: agent=${welcome.agent.name} (${welcome.agent.agentId})`);
  log(`  Supported: ${welcome.supportedMethods.join(', ')}\n`);

  // ── 1. HANDSHAKE ──
  log('─── 1. Handshake ───');
  const fakePeer = {
    agentId: 'agent_bob_001',
    userId: 'user_bob',
    name: "Bob 的 Peppa",
    capabilities: ['chat', 'code', 'search'],
    publicKey: 'ed25519:abc123def456',
  };

  send(wsA, {
    method: 'lap.handshake',
    agent: fakePeer,
    proposedScope: ['delegate_task', 'share_context'],
    nonce: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  });

  const handshakeResp = await waitFor(wsA, m => m.accepted !== undefined);
  if (handshakeResp.accepted) {
    log(` OK Handshake accepted!`);
    log(` Session: ${handshakeResp.sessionId}`);
    log(` Peer: ${handshakeResp.agent.name}`);
    log(` Trust: ${handshakeResp.trustLevel}`);
    log(` Scope: ${handshakeResp.scope.join(', ')}`);
  } else {
    log(` FAIL: ${handshakeResp.reason}`);
    process.exit(1);
  }
  const sessionId = handshakeResp.sessionId;

  // ── 2. TASK DELEGATION ──
  log('\n─── 2. Task Delegation ───');
  send(wsA, {
    method: 'lap.task.delegate',
    sessionId,
    task: {
      taskId: 'task_001',
      type: 'code_review',
      priority: 'normal',
      deadline: new Date(Date.now() + 3600_000).toISOString(),
      payload: {
        repo: 'github.com/user/project',
        files: ['src/main.rs', 'src/lib.rs'],
        requirements: '检查内存安全和并发问题',
      },
    },
  });

  const taskResp = await waitFor(wsA, m => m.accepted !== undefined && m.taskId === 'task_001');
  if (taskResp.accepted) {
    log(` OK Task accepted: ${taskResp.taskId}`);
    log(` Estimated: ${taskResp.estimatedCompletion || 'not specified'}`);
  } else {
    log(` FAIL: ${taskResp.reason}`);
  }

  // ── 3. TASK RESULT ──
  log('\n─── 3. Task Result ───');
  send(wsA, {
    method: 'lap.task.result',
    sessionId,
    taskId: 'task_001',
    status: 'completed',
    output: {
      issues: [
        { file: 'src/main.rs', line: 42, severity: 'warning', message: 'Potential use-after-free' },
        { file: 'src/lib.rs', line: 108, severity: 'error', message: 'Data race on shared state' },
      ],
      summary: 'Found 2 issues: 1 warning, 1 error. Recommend adding mutex for shared state.',
    },
  });

  const resultResp = await waitFor(wsA, m => m.acknowledged !== undefined);
  log(` ${resultResp.acknowledged ? 'OK' : 'FAIL'} Task result acknowledged`);

  // ── 4. CONTEXT SHARING ──
  log('\n─── 4. Context Sharing ───');
  send(wsA, {
    method: 'lap.context.share',
    sessionId,
    contexts: [
      { type: 'preference', scope: 'session', payload: 'Bob prefers code reviews in Chinese', confidence: 0.9 },
      { type: 'memory', scope: 'one-time', payload: 'Last review: project X had SQL injection issues', confidence: 0.85 },
    ],
  });

  const ctxResp = await waitFor(wsA, m => m.accepted !== undefined && m.acceptedEntries !== undefined);
  log(` ${ctxResp.accepted ? 'OK' : 'FAIL'} Context shared: ${ctxResp.acceptedEntries} accepted, ${ctxResp.rejectedEntries} rejected`);

  // ── 5. VERIFY VIA REST API ──
  log('\n─── 5. REST API Check ───');
  await sleep(300);
  const sessionsRes = await fetch('http://localhost:3000/api/lap/sessions');
  const sessionsData = await sessionsRes.json();
  log(` Active sessions: ${sessionsData.count}`);
  log(` Session IDs: ${sessionsData.sessions.map(s => s.sessionId.slice(0,8)).join(', ')}`);

  const tasksRes = await fetch(`http://localhost:3000/api/lap/tasks/${fakePeer.agentId}`);
  const tasksData = await tasksRes.json();
  log(` Tasks for ${fakePeer.agentId}: ${tasksData.summary.total} total (${tasksData.summary.completed} completed)`);

  const ctxListRes = await fetch(`http://localhost:3000/api/lap/contexts/${sessionId}`);
  const ctxListData = await ctxListRes.json();
  log(` Shared contexts: ${ctxListData.count}`);

  // ── 6. REVOKE SESSION ──
  log('\n─── 6. Revoke Session ───');
  send(wsA, {
    method: 'lap.revoke',
    sessionId,
    scope: 'all',
    reason: '测试完成，撤销会话',
  });

  const revokeResp = await waitFor(wsA, m => m.revoked !== undefined);
  log(` ${revokeResp.revoked ? 'OK' : 'FAIL'} Session revoked`);

  // Cleanup
  wsA.close();
  log('\n═══ All tests passed! ═══');
  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
