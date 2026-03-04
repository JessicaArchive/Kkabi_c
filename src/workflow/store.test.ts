import { describe, it, expect, beforeEach } from "vitest";
import {
  loadWorkflows,
  getWorkflow,
  saveWorkflow,
  removeWorkflow,
  reloadWorkflows,
} from "./store.js";
import type { Workflow } from "../types.js";

describe("workflow store", () => {
  const testIds: string[] = [];

  function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
    return {
      id: "test-wf",
      name: "Test Workflow",
      enabled: true,
      steps: [
        { id: "step1", agentId: "agent1", prompt: "Do something" },
      ],
      channelType: "slack",
      chatId: "C123",
      ...overrides,
    };
  }

  function saveTestWorkflow(wf: Workflow) {
    testIds.push(wf.id);
    return saveWorkflow(wf);
  }

  beforeEach(() => {
    for (const id of testIds) {
      removeWorkflow(id);
    }
    testIds.length = 0;
    reloadWorkflows();
  });

  it("saves and retrieves a workflow", () => {
    const wf = makeWorkflow({ id: "test-save" });
    saveTestWorkflow(wf);
    reloadWorkflows();
    const found = getWorkflow("test-save");
    expect(found).toBeDefined();
    expect(found!.id).toBe("test-save");
    expect(found!.name).toBe("Test Workflow");
    expect(found!.steps).toHaveLength(1);
  });

  it("updates an existing workflow", () => {
    saveTestWorkflow(makeWorkflow({ id: "test-upd", name: "Original" }));
    saveTestWorkflow(makeWorkflow({ id: "test-upd", name: "Updated" }));
    reloadWorkflows();
    expect(getWorkflow("test-upd")!.name).toBe("Updated");
  });

  it("removes a workflow", () => {
    saveTestWorkflow(makeWorkflow({ id: "test-rm" }));
    expect(removeWorkflow("test-rm")).toBe(true);
    reloadWorkflows();
    expect(getWorkflow("test-rm")).toBeUndefined();
  });

  it("returns false when removing non-existent workflow", () => {
    expect(removeWorkflow("test-nope-999")).toBe(false);
  });

  it("getWorkflow returns undefined for missing id", () => {
    expect(getWorkflow("test-missing-999")).toBeUndefined();
  });

  it("loadWorkflows returns an array", () => {
    expect(Array.isArray(loadWorkflows())).toBe(true);
  });

  it("toggleWorkflow flips enabled state", async () => {
    const { toggleWorkflow } = await import("./store.js");
    saveTestWorkflow(makeWorkflow({ id: "test-tog", enabled: true }));
    const toggled = toggleWorkflow("test-tog");
    expect(toggled).not.toBeNull();
    expect(toggled!.enabled).toBe(false);
  });
});
