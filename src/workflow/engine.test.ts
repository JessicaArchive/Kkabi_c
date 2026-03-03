import { describe, it, expect } from "vitest";
import { resolveExecutionOrder } from "./engine.js";
import type { WorkflowStep } from "../types.js";

describe("resolveExecutionOrder", () => {
  it("returns single step as one batch", () => {
    const steps: WorkflowStep[] = [
      { id: "a", agentId: "agent1", prompt: "do A" },
    ];
    const batches = resolveExecutionOrder(steps);
    expect(batches).toEqual([["a"]]);
  });

  it("groups independent steps into one batch", () => {
    const steps: WorkflowStep[] = [
      { id: "a", agentId: "agent1", prompt: "do A" },
      { id: "b", agentId: "agent2", prompt: "do B" },
    ];
    const batches = resolveExecutionOrder(steps);
    expect(batches).toEqual([["a", "b"]]);
  });

  it("creates sequential batches for dependencies", () => {
    const steps: WorkflowStep[] = [
      { id: "a", agentId: "agent1", prompt: "do A" },
      { id: "b", agentId: "agent2", prompt: "do B", dependsOn: ["a"] },
    ];
    const batches = resolveExecutionOrder(steps);
    expect(batches).toEqual([["a"], ["b"]]);
  });

  it("handles diamond dependencies", () => {
    const steps: WorkflowStep[] = [
      { id: "a", agentId: "a1", prompt: "A" },
      { id: "b", agentId: "a2", prompt: "B", dependsOn: ["a"] },
      { id: "c", agentId: "a3", prompt: "C", dependsOn: ["a"] },
      { id: "d", agentId: "a4", prompt: "D", dependsOn: ["b", "c"] },
    ];
    const batches = resolveExecutionOrder(steps);
    expect(batches).toEqual([["a"], ["b", "c"], ["d"]]);
  });

  it("throws on circular dependency", () => {
    const steps: WorkflowStep[] = [
      { id: "a", agentId: "a1", prompt: "A", dependsOn: ["b"] },
      { id: "b", agentId: "a2", prompt: "B", dependsOn: ["a"] },
    ];
    expect(() => resolveExecutionOrder(steps)).toThrow("Circular");
  });
});
