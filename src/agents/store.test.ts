import { describe, it, expect, beforeEach } from "vitest";
import { loadAgents, getAgent, saveAgent, removeAgent, reloadAgents } from "./store.js";

describe("agent store", () => {
  // Clean up any test agents after each test
  const testIds: string[] = [];

  function saveTestAgent(...args: Parameters<typeof saveAgent>) {
    testIds.push(args[0].id);
    return saveAgent(...args);
  }

  beforeEach(() => {
    // Remove leftover test agents from previous runs
    for (const id of testIds) {
      removeAgent(id);
    }
    testIds.length = 0;
    reloadAgents();
  });

  it("saves a new agent and retrieves it", () => {
    saveTestAgent({ id: "test-new", name: "Test Agent" });
    reloadAgents();
    const agent = getAgent("test-new");
    expect(agent).toBeDefined();
    expect(agent!.id).toBe("test-new");
    expect(agent!.name).toBe("Test Agent");
  });

  it("updates an existing agent", () => {
    saveTestAgent({ id: "test-up", name: "Original" });
    saveTestAgent({ id: "test-up", name: "Updated" });
    reloadAgents();
    const agent = getAgent("test-up");
    expect(agent!.name).toBe("Updated");
  });

  it("saves agent with optional fields", () => {
    saveTestAgent({ id: "test-full", name: "Full", model: "opus", workingDir: "/tmp", timeoutMs: 5000 });
    reloadAgents();
    const agent = getAgent("test-full");
    expect(agent!.model).toBe("opus");
    expect(agent!.workingDir).toBe("/tmp");
    expect(agent!.timeoutMs).toBe(5000);
  });

  it("removes an agent", () => {
    saveTestAgent({ id: "test-del", name: "To Delete" });
    expect(removeAgent("test-del")).toBe(true);
    reloadAgents();
    expect(getAgent("test-del")).toBeUndefined();
  });

  it("returns false when removing non-existent agent", () => {
    expect(removeAgent("test-nope-999")).toBe(false);
  });

  it("getAgent returns undefined for missing id", () => {
    expect(getAgent("test-missing-999")).toBeUndefined();
  });

  it("loadAgents returns an array", () => {
    const agents = loadAgents();
    expect(Array.isArray(agents)).toBe(true);
  });

  it("reloadAgents refreshes the cache", () => {
    saveTestAgent({ id: "test-cache", name: "Cached" });
    const before = loadAgents().find((a) => a.id === "test-cache");
    expect(before).toBeDefined();

    removeAgent("test-cache");
    reloadAgents();
    const after = getAgent("test-cache");
    expect(after).toBeUndefined();
  });
});
