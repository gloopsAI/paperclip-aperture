import { readFocusMetadata } from "./contracts.js";
import { attachReviewState, mergeStoredFrames, type FrameLane, type StoredFrameCandidate } from "./frame-model.js";
import { createEmptySnapshot, type AttentionReviewState, type AttentionSnapshot, type StoredAttentionFrame } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasViewerBlockedInboxOwner(metadata: Record<string, unknown> | null, viewerUserId: string): boolean {
  const blockedInboxAttention = asRecord(metadata?.blockedInboxAttention);
  const owner = asRecord(blockedInboxAttention?.owner);
  return owner?.type === "board" || (owner?.type === "user" && owner.userId === viewerUserId);
}

function hasViewerRecoveryOwner(metadata: Record<string, unknown> | null, viewerUserId: string): boolean {
  const recovery = asRecord(metadata?.activeRecoveryAction);
  if (recovery?.status !== "active" && recovery?.status !== "escalated") return false;
  return recovery.ownerType === "board"
    || (recovery.ownerType === "user" && recovery.ownerUserId === viewerUserId);
}

/**
 * The personal Focus surface is an action queue, not an operations dashboard.
 * Keep telemetry in the reconciled snapshot/export, but only project records
 * with explicit human authority into the display snapshot.
 */
export function isOperatorActionFrame(frame: StoredAttentionFrame, viewerUserId: string): boolean {
  if (!viewerUserId) return false;
  const focus = readFocusMetadata(frame);
  const metadata = asRecord(frame.metadata);

  // Event-derived approval frames predate the host approval overlay and do not
  // carry host metadata. Their typed response contract is sufficient because
  // the corresponding approval resolution event removes the frame.
  if (frame.responseSpec?.kind === "approval" && focus.approvalStatus === undefined) return true;

  if (
    focus.entityType === "approval"
    && (focus.approvalStatus === "pending" || focus.approvalStatus === "revision_requested")
  ) {
    return true;
  }

  if (focus.entityType !== "issue") return false;
  if (focus.issueAssigneeUserId === viewerUserId) return true;
  if (hasViewerBlockedInboxOwner(metadata, viewerUserId)) return true;
  if (hasViewerRecoveryOwner(metadata, viewerUserId)) return true;

  return false;
}

function snapshotCandidates(snapshot: AttentionSnapshot, viewerUserId: string): StoredFrameCandidate[] {
  const candidates: StoredFrameCandidate[] = [];
  const append = (frame: StoredAttentionFrame | null, lane: FrameLane) => {
    if (frame && isOperatorActionFrame(frame, viewerUserId)) candidates.push({ frame, lane });
  };

  append(snapshot.now, "now");
  snapshot.next.forEach((frame) => append(frame, "next"));
  snapshot.ambient.forEach((frame) => append(frame, "ambient"));
  return candidates;
}

export function projectOperatorActionSnapshot(
  snapshot: AttentionSnapshot,
  review: AttentionReviewState | null,
  viewerUserId: string,
): AttentionSnapshot {
  const candidates = snapshotCandidates(snapshot, viewerUserId);
  if (candidates.length === 0) {
    return attachReviewState({
      ...createEmptySnapshot(snapshot.companyId),
      updatedAt: snapshot.updatedAt,
      lastEvent: snapshot.lastEvent,
    }, review);
  }

  return mergeStoredFrames(
    {
      ...createEmptySnapshot(snapshot.companyId),
      updatedAt: snapshot.updatedAt,
      lastEvent: snapshot.lastEvent,
    },
    snapshot.companyId,
    candidates,
    review,
    snapshot.updatedAt,
  );
}
