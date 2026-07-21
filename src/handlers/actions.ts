import type { Issue, PluginContext } from "@paperclipai/plugin-sdk";
import type { AttentionSignal } from "@tomismeta/aperture-core";
import type { ApertureCompanyStore } from "../aperture/core-store.js";
import { readFocusMetadata } from "../aperture/contracts.js";
import { mapDecisionToResponse } from "../aperture/response-mapper.js";
import { parseTaskId, taskIdMatchesKind, taskKind } from "../aperture/task-ref.js";
import { createEmptyReviewState, createEmptySnapshot, type AttentionLedgerOverlayResponseEntry, type AttentionLedgerResponseEntry, type AttentionLedgerSignalEntry, type AttentionReviewState, type AttentionSnapshot, type StoredAttentionFrame } from "../aperture/types.js";
import { listPendingApprovals, submitApprovalDecision } from "../host/paperclip-approvals.js";
import {
  emitAttentionUpdate,
  logFocusActivity,
  requireAuthenticatedUser,
  requireCompanyId,
  requireStringParam,
  runAttentionMutation,
  runUserReviewMutation,
  trackFocusTelemetry,
  type PluginRequestContext,
} from "./shared.js";

function viewerOwnsIssueAction(issue: Issue, viewerUserId: string): boolean {
  if (issue.assigneeUserId === viewerUserId) return true;

  const blockedOwner = issue.blockedInboxAttention?.owner;
  if (blockedOwner?.type === "board") return true;
  if (blockedOwner?.type === "user" && blockedOwner.userId === viewerUserId) return true;

  const recovery = issue.activeRecoveryAction;
  if (recovery?.status !== "active" && recovery?.status !== "escalated") return false;
  if (recovery.ownerType === "board") return true;
  return recovery.ownerType === "user" && recovery.ownerUserId === viewerUserId;
}

function assertInteractionMatchesTask(taskId: string, interactionId: string): void {
  if (!interactionId.startsWith(`${taskId}:`)) {
    throw new Error("Focus interaction target does not match the selected frame.");
  }
}

async function assertViewerCanActOnTask(
  ctx: PluginContext,
  companyId: string,
  viewerUserId: string,
  taskId: string,
  interactionId?: string,
): Promise<void> {
  if (interactionId) assertInteractionMatchesTask(taskId, interactionId);

  const taskRef = parseTaskId(taskId);
  if (!taskRef) throw new Error("Focus action requires a valid task target.");
  if (taskRef.kind === "approval") {
    const config = await ctx.config.get();
    const approvals = await listPendingApprovals(ctx, companyId, config);
    if (!approvals.some((approval) => (
      approval.id === taskRef.id
      && approval.companyId === companyId
      && (approval.status === "pending" || approval.status === "revision_requested")
    ))) {
      throw new Error("Focus approval target is not a current pending approval in the active company.");
    }
    return;
  }
  if (taskRef.kind !== "issue") {
    throw new Error("Focus action target is not a current user or board action.");
  }

  const issue = await ctx.issues.get(taskRef.id, companyId);
  if (!issue || !viewerOwnsIssueAction(issue, viewerUserId)) {
    throw new Error("Focus action target is not assigned to the authenticated user or board.");
  }
}

function buildSeenReviewState(
  review: AttentionReviewState,
  companyId: string,
  taskIds: string[],
  suppress = false,
): AttentionReviewState {
  const now = new Date().toISOString();
  const nextReview: AttentionReviewState = {
    ...review,
    updatedAt: now,
    lastSeenAt: now,
    frames: { ...review.frames },
  };

  for (const taskId of taskIds) {
    const current = nextReview.frames[taskId] ?? {};
    nextReview.frames[taskId] = {
      ...current,
      lastSeenAt: now,
      ...(suppress ? { suppressedAt: now } : {}),
    };
  }

  return nextReview;
}

function snapshotContainsTask(snapshot: AttentionSnapshot | null, taskId: string): boolean {
  if (!snapshot) return false;
  const frames: StoredAttentionFrame[] = [
    ...(snapshot.now ? [snapshot.now] : []),
    ...snapshot.next,
    ...snapshot.ambient,
  ];
  return frames.some((frame) => frame.taskId === taskId);
}

function entityTypeFromTaskId(taskId: string): string {
  return taskKind(taskId) ?? "unknown";
}

function laneForTask(snapshot: AttentionSnapshot | null, taskId: string): "now" | "next" | "ambient" | "ui_only" {
  if (!snapshot) return "ui_only";
  if (snapshot.now?.taskId === taskId) return "now";
  if (snapshot.next.some((frame) => frame.taskId === taskId)) return "next";
  if (snapshot.ambient.some((frame) => frame.taskId === taskId)) return "ambient";
  return "ui_only";
}

function createSignalLedgerEntry(input: {
  taskId: string;
  interactionId: string;
  occurredAt?: string;
  sourceEventType: string;
  sourceEntityId?: string;
  signal: {
    kind: AttentionSignal["kind"];
    surface?: string;
    section?: string;
    timeoutMs?: number;
    metadata?: Record<string, unknown>;
  };
}): AttentionLedgerSignalEntry {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  return {
    kind: "signal",
    id: `${input.taskId}:${input.signal.kind}:${occurredAt}`,
    occurredAt,
    source: {
      eventType: input.sourceEventType,
      entityId: input.sourceEntityId ?? input.taskId,
      entityType: entityTypeFromTaskId(input.taskId),
    },
    apertureSignal: {
      ...input.signal,
      taskId: input.taskId,
      interactionId: input.interactionId,
      timestamp: occurredAt,
    } as AttentionSignal,
  };
}

function focusDimensions(
  snapshot: AttentionSnapshot | null,
  taskId: string,
): Record<string, string | number | boolean> {
  const lane = laneForTask(snapshot, taskId);
  const entityType = entityTypeFromTaskId(taskId);
  const frame = lane === "ui_only"
    ? null
    : lane === "now"
      ? snapshot?.now ?? null
      : lane === "next"
        ? snapshot?.next.find((candidate) => candidate.taskId === taskId) ?? null
        : snapshot?.ambient.find((candidate) => candidate.taskId === taskId) ?? null;

  const dimensions: Record<string, string | number | boolean> = {
    entityType,
    lane,
  };

  if (frame?.mode) dimensions.mode = frame.mode;
  if (frame?.source?.kind) dimensions.sourceKind = frame.source.kind;
  if (frame) {
    const metadata = readFocusMetadata(frame);
    if (typeof metadata.liveReconciled === "boolean") dimensions.liveReconciled = metadata.liveReconciled;
  }

  return dimensions;
}

function approvalIdFromTaskId(taskId: string): string | null {
  const taskRef = parseTaskId(taskId);
  return taskRef?.kind === "approval" ? taskRef.id : null;
}

export function registerActionHandlers(ctx: PluginContext, store: ApertureCompanyStore): void {
  ctx.actions.register("set-focus-presence", async (params, context?: PluginRequestContext) => {
    const companyId = requireCompanyId(params);
    requireAuthenticatedUser(context, companyId);
    const requestedPresence = requireStringParam(params, "presence");
    const presence = requestedPresence === "absent" ? "absent" : "present";
    return {
      ok: true,
      operatorPresence: store.setOperatorPresence(companyId, presence),
    };
  });

  ctx.actions.register("mark-attention-viewed", async (params, context?: PluginRequestContext) => {
    const companyId = requireCompanyId(params);
    const viewerUserId = requireAuthenticatedUser(context, companyId);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    await assertViewerCanActOnTask(ctx, companyId, viewerUserId, taskId, interactionId);
    const surface = typeof params.surface === "string" && params.surface.trim().length > 0
      ? params.surface.trim()
      : "focus";

    const currentSnapshot = store.getSnapshot(companyId);
    const signalEntry = createSignalLedgerEntry({
      taskId,
      interactionId,
      sourceEventType: "plugin.local.viewed",
      signal: {
        kind: "viewed",
        surface,
      },
    });
    const { snapshot, changed } = await runAttentionMutation(ctx, store, companyId, () => {
      const { ledger, snapshot, changed } = store.applySignal(companyId, signalEntry);
      return { ledger, snapshot, changed };
    });

    if (changed) {
      emitAttentionUpdate(ctx, {
        companyId,
        reason: "action",
        eventType: "plugin.local.viewed",
        updatedAt: snapshot.updatedAt,
        counts: snapshot.counts,
      });
    }

    await trackFocusTelemetry(ctx, "frame_viewed", {
      ...focusDimensions(currentSnapshot, taskId),
      surface,
    });

    return { ok: true, snapshot, changed };
  });

  ctx.actions.register("engage-focus", async (params, context?: PluginRequestContext) => {
    const companyId = requireCompanyId(params);
    const viewerUserId = requireAuthenticatedUser(context, companyId);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    await assertViewerCanActOnTask(ctx, companyId, viewerUserId, taskId, interactionId);
    const durationMs = typeof params.durationMs === "number" && Number.isFinite(params.durationMs)
      ? Math.max(25, Math.floor(params.durationMs))
      : undefined;
    const reason = typeof params.reason === "string" && params.reason.trim().length > 0
      ? params.reason.trim()
      : "operator_interaction";

    const currentSnapshot = store.getSnapshot(companyId);
    const occurredAt = new Date().toISOString();
    const signalEntries = [
      createSignalLedgerEntry({
        taskId,
        interactionId,
        occurredAt,
        sourceEventType: "plugin.local.engage.viewed",
        signal: {
          kind: "viewed",
          surface: "focus",
        },
      }),
      ...(reason === "show_context" || reason === "comment_compose"
        ? [
            createSignalLedgerEntry({
              taskId,
              interactionId,
              occurredAt,
              sourceEventType: "plugin.local.engage.context_expanded",
              signal: {
                kind: "context_expanded",
                surface: "focus",
                section: reason === "show_context" ? "now_context" : "comment_compose",
              },
            }),
          ]
        : []),
    ];
    const { snapshot, changed } = await runAttentionMutation(ctx, store, companyId, () => {
      const engaged = store.engage(companyId, taskId, interactionId, { durationMs });
      let ledger = store.getLedger(companyId);
      let latestSnapshot = engaged.snapshot;
      let signalChanged = false;
      for (const entry of signalEntries) {
        const result = store.applySignal(companyId, entry);
        ledger = result.ledger;
        latestSnapshot = result.snapshot;
        signalChanged ||= result.changed;
      }
      return {
        ledger,
        snapshot: latestSnapshot,
        changed: engaged.changed || signalChanged,
      };
    });

    if (changed) {
      emitAttentionUpdate(ctx, {
        companyId,
        reason: "action",
        eventType: "plugin.local.engage",
        updatedAt: snapshot.updatedAt,
        counts: snapshot.counts,
      });
    }

    await trackFocusTelemetry(ctx, "focus_engaged", {
      ...focusDimensions(currentSnapshot, taskId),
      actionKind: "engage",
      reason,
      ...(durationMs ? { durationMs } : {}),
    });

    return { ok: true, snapshot, changed };
  });

  ctx.actions.register("acknowledge-frame", async (params, context?: PluginRequestContext) => {
    const companyId = requireCompanyId(params);
    const viewerUserId = requireAuthenticatedUser(context, companyId);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    await assertViewerCanActOnTask(ctx, companyId, viewerUserId, taskId, interactionId);
    const currentSnapshot = store.getSnapshot(companyId);
    let snapshot = currentSnapshot ?? createEmptySnapshot(companyId);
    if (taskIdMatchesKind(taskId, "approval")) {
      const response = mapDecisionToResponse({ taskId, interactionId, action: "acknowledge" });
      const ledgerEntry: AttentionLedgerResponseEntry = {
        kind: "response",
        id: `${taskId}:acknowledge:${Date.now()}`,
        occurredAt: new Date().toISOString(),
        source: {
          eventType: "plugin.local.acknowledge",
          entityId: taskId,
        },
        apertureResponse: response,
      };
      ({ snapshot } = await runAttentionMutation(ctx, store, companyId, () => {
        const { ledger, snapshot } = store.applyResponse(companyId, ledgerEntry);
        return { ledger, snapshot };
      }));
    } else {
      await runUserReviewMutation(ctx, companyId, viewerUserId, (currentReview) => {
        const review = buildSeenReviewState(currentReview, companyId, [taskId], true);
        return { review, result: undefined };
      });
    }
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: "plugin.local.acknowledge",
      updatedAt: snapshot.updatedAt,
      counts: snapshot.counts,
    });
    await trackFocusTelemetry(ctx, "frame_acknowledged", {
      ...focusDimensions(currentSnapshot, taskId),
    });
    return { ok: true, snapshot };
  });

  ctx.actions.register("comment-on-issue", async (params, context?: PluginRequestContext) => {
    const companyId = requireCompanyId(params);
    const viewerUserId = requireAuthenticatedUser(context, companyId);
    const taskId = requireStringParam(params, "taskId");
    const issueId = requireStringParam(params, "issueId");
    const body = requireStringParam(params, "body").trim();

    const taskRef = parseTaskId(taskId);
    if (!taskRef || taskRef.kind !== "issue") {
      throw new Error("Comments can only be posted on issue-backed frames.");
    }
    if (taskRef.id !== issueId) {
      throw new Error("Issue comment target does not match the selected frame.");
    }
    await assertViewerCanActOnTask(ctx, companyId, viewerUserId, taskId);

    const comment = await ctx.issues.createComment(issueId, body, companyId);
    const currentSnapshot = store.getSnapshot(companyId);
    let review: AttentionReviewState | null = null;
    try {
      ({ review } = await runUserReviewMutation(ctx, companyId, viewerUserId, (currentReview) => {
        const review = buildSeenReviewState(currentReview, companyId, [taskId], false);
        return { review, result: undefined };
      }));
    } catch (error) {
      // The host comment is the authoritative side effect and may already be
      // durable. Do not report it as failed (and invite a duplicate retry)
      // merely because the optional viewer-read marker could not be stored.
      ctx.logger.warn("Issue comment succeeded but viewer review state could not be updated.", {
        companyId,
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    let snapshot = store.getSnapshot(companyId) ?? createEmptySnapshot(companyId);
    try {
      ({ snapshot } = await runAttentionMutation(ctx, store, companyId, () => {
        store.invalidateHostCache(companyId, {
          keys: [
            `issue:${issueId}:detail`,
            `issue:${issueId}:comments`,
          ],
          prefixes: ["issues:blocked", "issues:in_review"],
        });
        return {
          ledger: store.getLedger(companyId),
          snapshot: store.getSnapshot(companyId) ?? createEmptySnapshot(companyId),
        };
      }));
    } catch (error) {
      ctx.logger.warn("Issue comment succeeded but local attention bookkeeping could not be persisted.", {
        companyId,
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: "plugin.local.comment",
      updatedAt: snapshot.updatedAt,
      counts: snapshot.counts,
    });
    await trackFocusTelemetry(ctx, "issue_comment_submitted", {
      ...focusDimensions(currentSnapshot, taskId),
      actionKind: "comment",
    });
    await logFocusActivity(ctx, {
      companyId,
      message: "Posted an issue comment from Focus.",
      entityType: "issue",
      entityId: issueId,
      metadata: {
        source: "focus",
        taskId,
      },
    });
    return { ok: true, comment, review };
  });

  ctx.actions.register("record-approval-response", async (params, context?: PluginRequestContext) => {
    const companyId = requireCompanyId(params);
    const viewerUserId = requireAuthenticatedUser(context, companyId);
    const taskId = requireStringParam(params, "taskId");
    const interactionId = requireStringParam(params, "interactionId");
    const decision = requireStringParam(params, "decision");
    await assertViewerCanActOnTask(ctx, companyId, viewerUserId, taskId, interactionId);

    if (!taskIdMatchesKind(taskId, "approval")) {
      throw new Error("Approval responses can only be recorded for approval-backed frames.");
    }
    if (!["approve", "reject", "request-revision"].includes(decision)) {
      throw new Error("decision must be approve, reject, or request-revision.");
    }

    const response = mapDecisionToResponse({
      taskId,
      interactionId,
      action: decision as "approve" | "reject" | "request-revision",
    });
    const ledgerEntry: AttentionLedgerResponseEntry = {
      kind: "response",
      id: `${taskId}:${decision}:${Date.now()}`,
      occurredAt: new Date().toISOString(),
      source: {
        eventType: `plugin.local.approval.${decision}`,
        entityId: taskId,
      },
      apertureResponse: response,
    };
    const approvalId = approvalIdFromTaskId(taskId);
    if (!approvalId) {
      throw new Error("Approval responses require a durable approval id.");
    }

    const config = await ctx.config.get();
    await submitApprovalDecision(ctx, approvalId, decision as "approve" | "reject" | "request-revision", config);
    store.invalidateApprovals(companyId);

    const currentSnapshot = store.getSnapshot(companyId);
    const shouldIngest = snapshotContainsTask(currentSnapshot, taskId);

    let snapshot = currentSnapshot ?? createEmptySnapshot(companyId);
    try {
      ({ snapshot } = await runAttentionMutation(ctx, store, companyId, () => {
        if (shouldIngest) {
          const { ledger, snapshot } = store.applyResponse(companyId, ledgerEntry);
          return { ledger, snapshot };
        }

        const overlayEntry: AttentionLedgerOverlayResponseEntry = {
          kind: "overlay-response",
          id: ledgerEntry.id,
          occurredAt: ledgerEntry.occurredAt,
          source: ledgerEntry.source,
          apertureResponse: ledgerEntry.apertureResponse,
          overlay: {
            kind: "approval_overlay",
            reason: "Approval frame came from the Paperclip approvals display adapter, not the replayed Core snapshot.",
          },
        };
        const { ledger, snapshot } = store.applyOverlayResponse(companyId, overlayEntry);
        return {
          ledger,
          snapshot,
        };
      }));
    } catch (error) {
      ctx.logger.warn("Approval succeeded but local attention bookkeeping could not be persisted.", {
        companyId,
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    let review: AttentionReviewState | null = null;
    try {
      ({ review } = await runUserReviewMutation(ctx, companyId, viewerUserId, (currentReview) => {
        const review = buildSeenReviewState(currentReview, companyId, [taskId], true);
        return { review, result: undefined };
      }));
    } catch (error) {
      // The approval endpoint is authoritative and idempotent with respect to
      // the resulting status. A viewer-marker failure must not turn a real
      // approval into a misleading failed action.
      ctx.logger.warn("Approval succeeded but viewer review state could not be updated.", {
        companyId,
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: `plugin.local.approval.${decision}`,
      updatedAt: snapshot.updatedAt,
      counts: snapshot.counts,
    });
    await trackFocusTelemetry(ctx, "approval_response_recorded", {
      ...focusDimensions(currentSnapshot, taskId),
      decision: decision === "request-revision" ? "request_revision" : decision,
    });
    await logFocusActivity(ctx, {
      companyId,
      message:
        decision === "approve"
          ? "Approved a Focus approval."
          : decision === "reject"
            ? "Rejected a Focus approval."
            : "Requested revision on a Focus approval.",
      entityType: "approval",
      entityId: approvalId,
      metadata: {
        source: "focus",
        decision,
        taskId,
      },
    });
    return { ok: true, snapshot, review };
  });

  ctx.actions.register("mark-attention-seen", async (params, context?: PluginRequestContext) => {
    const companyId = requireCompanyId(params);
    const viewerUserId = requireAuthenticatedUser(context, companyId);
    const taskIds = Array.isArray(params.taskIds)
      ? params.taskIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (taskIds.length === 0) {
      throw new Error("taskIds must include at least one frame task id.");
    }
    await Promise.all(taskIds.map((taskId) => assertViewerCanActOnTask(ctx, companyId, viewerUserId, taskId)));
    const { review } = await runUserReviewMutation(ctx, companyId, viewerUserId, (currentReview) => {
      const review = buildSeenReviewState(currentReview, companyId, taskIds);
      return { review, result: undefined };
    });
    const snapshot = store.getSnapshot(companyId) ?? createEmptySnapshot(companyId);
    emitAttentionUpdate(ctx, {
      companyId,
      reason: "action",
      eventType: "plugin.local.seen",
      updatedAt: snapshot.updatedAt,
      counts: snapshot.counts,
    });
    await trackFocusTelemetry(ctx, "attention_seen_marked", {
      frameCount: taskIds.length,
    });
    return { ok: true, review, snapshot };
  });
}
