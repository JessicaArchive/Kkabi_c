import { describe, it, expect } from "vitest";
import { parseCronTags } from "./cronParser.js";

describe("parseCronTags", () => {
  it("parses a CRON_JOB tag", () => {
    const input = 'Sure!\n<!--CRON_JOB:{"schedule":"0 9 * * *","prompt":"Review PRs"}-->';
    const { actions, cleanedResponse } = parseCronTags(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: "add", schedule: "0 9 * * *", prompt: "Review PRs" });
    expect(cleanedResponse).toBe("Sure!");
  });

  it("parses a CRON_JOB tag with agentId", () => {
    const input = 'OK\n<!--CRON_JOB:{"schedule":"*/30 * * * *","prompt":"Check status","agentId":"reviewer"}-->';
    const { actions, cleanedResponse } = parseCronTags(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      type: "add",
      schedule: "*/30 * * * *",
      prompt: "Check status",
      agentId: "reviewer",
    });
    expect(cleanedResponse).toBe("OK");
  });

  it("parses a CRON_REMOVE tag", () => {
    const input = 'Removed.\n<!--CRON_REMOVE:{"id":"abc12345"}-->';
    const { actions, cleanedResponse } = parseCronTags(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: "remove", id: "abc12345" });
    expect(cleanedResponse).toBe("Removed.");
  });

  it("parses a CRON_LIST tag", () => {
    const input = "Here are your jobs:\n<!--CRON_LIST-->";
    const { actions, cleanedResponse } = parseCronTags(input);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({ type: "list" });
    expect(cleanedResponse).toBe("Here are your jobs:");
  });

  it("parses multiple tags in one response", () => {
    const input = [
      "Done!",
      '<!--CRON_JOB:{"schedule":"0 9 * * *","prompt":"Morning check"}-->',
      '<!--CRON_REMOVE:{"id":"old123"}-->',
    ].join("\n");
    const { actions } = parseCronTags(input);

    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe("add");
    expect(actions[1].type).toBe("remove");
  });

  it("skips malformed JSON tags", () => {
    const input = "Hi\n<!--CRON_JOB:not-json-->\n<!--CRON_REMOVE:{bad}-->";
    const { actions, cleanedResponse } = parseCronTags(input);

    expect(actions).toHaveLength(0);
    expect(cleanedResponse).toBe("Hi");
  });

  it("returns empty actions when no tags present", () => {
    const input = "Just a normal response.";
    const { actions, cleanedResponse } = parseCronTags(input);

    expect(actions).toHaveLength(0);
    expect(cleanedResponse).toBe("Just a normal response.");
  });

  it("does not include agentId when not provided", () => {
    const input = '<!--CRON_JOB:{"schedule":"0 9 * * *","prompt":"test"}-->';
    const { actions } = parseCronTags(input);

    expect(actions[0]).toEqual({ type: "add", schedule: "0 9 * * *", prompt: "test" });
    expect("agentId" in actions[0]).toBe(false);
  });
});
