import { describe, expect, it } from "vitest";
import { projectOperatorActionSnapshot } from "../src/aperture/operator-actions.js";
import { createEmptyReviewState, createEmptySnapshot, type StoredAttentionFrame } from "../src/aperture/types.js";

const companyId = "company-operator-actions";

function frame(
  taskId: string,
  metadata: Record<string, unknown>,
  responseKind: "none" | "acknowledge" | "approval" = "acknowledge",
): StoredAttentionFrame {
  return {
    id: `frame:${taskId}`,
    taskId,
    interactionId: `${taskId}:interaction`,
    source: { id: "paperclip:test", kind: "paperclip", label: "Paperclip" },
    version: 1,
    mode: "status",
    tone: "focused",
    consequence: "medium",
    title: taskId,
    responseSpec: responseKind === "none"
      ? { kind: "none" }
      : responseKind === "approval"
        ? { kind: "approval", actions: [{ id: "approve", label: "Approve", kind: "approve", emphasis: "primary" }] }
        : { kind: "acknowledge", actions: [{ id: "ack", label: "Acknowledge", kind: "acknowledge", emphasis: "primary" }] },
    provenance: { factors: [] },
    timing: { createdAt: "2026-07-21T00:00:00.000Z", updatedAt: "2026-07-21T00:00:00.000Z" },
    metadata,
  };
}

describe("personal operator action projection", () => {
  it("removes autonomous telemetry while preserving it in the source snapshot", () => {
    const source = {
      ...createEmptySnapshot(companyId),
      updatedAt: "2026-07-21T00:00:00.000Z",
      now: frame("agent:error", { entityType: "agent", agentStatus: "error" }),
      next: [
        frame("issue:blocked", { entityType: "issue", issueStatus: "blocked" }),
        frame("issue:review", { entityType: "issue", issueStatus: "in_review" }),
        frame("issue:update", { entityType: "issue", issueStatus: "in_progress" }, "none"),
      ],
      counts: { now: 1, next: 3, ambient: 0, total: 4 },
    };

    const projected = projectOperatorActionSnapshot(source, createEmptyReviewState(companyId));

    expect(projected.counts).toEqual({ now: 0, next: 0, ambient: 0, total: 0 });
    expect(projected.review?.unread.total).toBe(0);
    expect(source.counts.total).toBe(4);
  });

  it("keeps pending approvals and explicitly user-owned issue actions", () => {
    const source = {
      ...createEmptySnapshot(companyId),
      updatedAt: "2026-07-21T00:00:00.000Z",
      next: [
        frame("approval:1", { entityType: "approval", approvalStatus: "pending" }, "approval"),
        frame("issue:user", { entityType: "issue", issueAssigneeUserId: "user-1" }),
        frame("issue:board-recovery", {
          entityType: "issue",
          activeRecoveryAction: { ownerType: "board", status: "active" },
        }),
        frame("issue:user-blocker", {
          entityType: "issue",
          blockedInboxAttention: { owner: { type: "user", userId: "user-1" } },
        }),
      ],
      counts: { now: 0, next: 4, ambient: 0, total: 4 },
    };

    const projected = projectOperatorActionSnapshot(source, createEmptyReviewState(companyId));

    expect(projected.counts.total).toBe(4);
    expect([projected.now, ...projected.next].map((item) => item?.taskId)).toEqual(expect.arrayContaining([
      "approval:1",
      "issue:user",
      "issue:board-recovery",
      "issue:user-blocker",
    ]));
    expect(projected.review?.unread.total).toBe(4);
  });

  it("drops resolved approvals and machine-owned recoveries", () => {
    const source = {
      ...createEmptySnapshot(companyId),
      updatedAt: "2026-07-21T00:00:00.000Z",
      next: [
        frame("approval:resolved", { entityType: "approval", approvalStatus: "approved" }, "approval"),
        frame("issue:system", {
          entityType: "issue",
          activeRecoveryAction: { ownerType: "system", status: "active" },
        }),
        frame("issue:agent", {
          entityType: "issue",
          blockedInboxAttention: { owner: { type: "agent", agentId: "agent-1" } },
        }),
      ],
      counts: { now: 0, next: 3, ambient: 0, total: 3 },
    };

    expect(projectOperatorActionSnapshot(source, createEmptyReviewState(companyId)).counts.total).toBe(0);
  });
});
