import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { z } from "zod";
import type { Agent } from "../types.js";

const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  model: z.string().optional(),
  persona: z.string().optional(),
  workingDir: z.string().optional(),
  timeoutMs: z.number().positive().optional(),
});

const AgentsFileSchema = z.object({
  version: z.literal(1),
  agents: z.array(AgentSchema),
});

const AGENTS_FILE = resolve(process.cwd(), "data", "agents.json");

let cache: Agent[] | null = null;

export function loadAgents(): Agent[] {
  if (cache) return cache;
  if (!existsSync(AGENTS_FILE)) {
    cache = [];
    return cache;
  }
  const raw = readFileSync(AGENTS_FILE, "utf-8");
  const parsed = AgentsFileSchema.parse(JSON.parse(raw));
  cache = parsed.agents;
  return cache;
}

export function getAgent(id: string): Agent | undefined {
  return loadAgents().find((a) => a.id === id);
}

export function saveAgent(agent: Agent): void {
  const agents = loadAgents();
  const idx = agents.findIndex((a) => a.id === agent.id);
  if (idx >= 0) {
    agents[idx] = agent;
  } else {
    agents.push(agent);
  }
  writeAgents(agents);
}

export function removeAgent(id: string): boolean {
  const agents = loadAgents();
  const idx = agents.findIndex((a) => a.id === id);
  if (idx === -1) return false;
  agents.splice(idx, 1);
  writeAgents(agents);
  return true;
}

export function reloadAgents(): Agent[] {
  cache = null;
  return loadAgents();
}

function writeAgents(agents: Agent[]): void {
  mkdirSync(dirname(AGENTS_FILE), { recursive: true });
  const data = { version: 1, agents };
  writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2), "utf-8");
  cache = agents;
}
