'use strict';

const { id } = require('../core/ids');

const AGENT_TYPES = ['plan', 'implement', 'review', 'qa', 'security'];

const ROLE_BY_TYPE = {
  plan: 'planner',
  implement: 'implementer',
  review: 'reviewer',
  qa: 'qa',
  security: 'security',
};

function defaultAgents() {
  return [
    { id: 'agent-planner', name: 'Planner Prime', type: 'plan', role: 'planner', status: 'idle', createdAt: Date.now(), lastTaskAt: null, tasksDone: 0, tasksFailed: 0 },
    { id: 'agent-impl-1', name: 'Forge Builder', type: 'implement', role: 'implementer', status: 'idle', createdAt: Date.now(), lastTaskAt: null, tasksDone: 0, tasksFailed: 0 },
    { id: 'agent-reviewer-1', name: 'Sentinel Reviewer', type: 'review', role: 'reviewer', status: 'idle', createdAt: Date.now(), lastTaskAt: null, tasksDone: 0, tasksFailed: 0 },
    { id: 'agent-qa-1', name: 'Quality Warden', type: 'qa', role: 'qa', status: 'idle', createdAt: Date.now(), lastTaskAt: null, tasksDone: 0, tasksFailed: 0 },
    { id: 'agent-security-1', name: 'Cipher Guard', type: 'security', role: 'security', status: 'idle', createdAt: Date.now(), lastTaskAt: null, tasksDone: 0, tasksFailed: 0 },
  ];
}

// Agents registry. One agent per type is provisioned by default; extra agents
// of any type can be registered (auto-assignment picks idle-capable agents).
class AgentRegistry {
  constructor() {
    this.agents = defaultAgents();
  }

  list() {
    return this.agents;
  }

  get(agentId) {
    const a = this.agents.find((x) => x.id === agentId);
    if (!a) return null;
    return a;
  }

  requireAgent(agentId) {
    const a = this.get(agentId);
    if (!a) {
      const e = new Error(`Agent not found: ${agentId}`);
      e.code = 'FORGE_NOT_FOUND';
      throw e;
    }
    return a;
  }

  register({ name, type, backend }) {
    if (!AGENT_TYPES.includes(type)) {
      const e = new Error(`agent type must be one of [${AGENT_TYPES.join(', ')}]`);
      e.code = 'FORGE_INVALID_INPUT';
      throw e;
    }
    if (backend !== undefined && backend !== null && typeof backend !== 'string') {
      const e = new Error('agent backend must be a string adapter id or null');
      e.code = 'FORGE_INVALID_INPUT';
      throw e;
    }
    const role = ROLE_BY_TYPE[type];
    const agent = {
      id: id('agent'),
      name: name || `${type}-agent`,
      type,
      role,
      backend: backend || null, // external adapter id (codex/claude/...) or null = internal engine
      status: 'idle',
      createdAt: Date.now(),
      lastTaskAt: null,
      tasksDone: 0,
      tasksFailed: 0,
    };
    this.agents.push(agent);
    return agent;
  }

  byType(type) {
    return this.agents.filter((a) => a.type === type);
  }

  mark(agentId, status) {
    const a = this.requireAgent(agentId);
    a.status = status;
    a.lastTaskAt = Date.now();
    return a;
  }
}

// ---------------------------------------------------------------------------
// Unified message protocol. Every agent action posts a message with exactly:
//   id, agent, timestamp, task, status, input, output, artifacts, dependencies
// ---------------------------------------------------------------------------
function postMessage(store, { agentId, taskId, status, input, output, artifacts, dependencies }) {
  if (!Array.isArray(store)) {
    const e = new Error('message store must be an array');
    e.code = 'FORGE_INVALID_INPUT';
    throw e;
  }
  const msg = {
    id: id('msg'),
    agent: agentId || null,
    timestamp: Date.now(),
    task: taskId || null,
    status: status || null,
    input: input === undefined ? null : input,
    output: output === undefined ? null : output,
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    dependencies: Array.isArray(dependencies) ? dependencies : [],
  };
  store.push(msg);
  if (store.length > 4000) store.splice(0, store.length - 4000);
  return msg;
}

module.exports = { AgentRegistry, AGENT_TYPES, ROLE_BY_TYPE, postMessage, defaultAgents };
