import { and, eq, inArray } from "drizzle-orm";
import { getDb, type SpecGraphDb } from "../../db";
import {
  analysisRuns,
  changeEvents,
  githubInstallations,
  sources,
  webhookDeliveries,
} from "../../db/schema";
import { failRunAttempt } from "../analysis/run-lifecycle";
import { structuredLog } from "../observability/structured-log";
import { ApiError } from "../server/http";
import { GitHubClient } from "./client";
import { getGitHubAppConfig } from "./config";
import {
  executeGitHubPullRequestAnalysis,
  executeGitHubPushAnalysis,
  type GitHubPushAnalysisInput,
} from "./analysis";
import { changedArtifactSnapshot } from "./artifacts";
import type { ChangedArtifact } from "../contracts/specgraph";

const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);

type JsonObject = Record<string, unknown>;

type ConnectedGitHubSource = {
  id: string;
  workspaceId: string;
  name: string;
  defaultBranch: string;
};

export type NormalizedGitHubChange = {
  kind: "push" | "pull_request";
  source: ConnectedGitHubSource;
  title: string;
  target: string;
  summary: string;
  sourceLabel: string;
  sourceUrl: string | null;
  beforeRevision: string | null;
  afterRevision: string | null;
  actor: string | null;
  occurredAt: string;
  changedArtifacts: ChangedArtifact[];
  pullRequestNumber?: number;
  push?: GitHubPushAnalysisInput;
};

export type GitHubWebhookAcceptance = {
  status: 200 | 202;
  body: {
    accepted: true;
    duplicate: boolean;
    deliveryId: string;
    status: "received" | "processed" | "ignored" | "failed";
    runId?: string;
    reason?: string;
  };
  job?: GitHubWebhookJob;
};

export type GitHubWebhookJob = {
  deliveryId: string;
  runId: string;
  change: NormalizedGitHubChange;
};

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  return new Uint8Array(value.match(/.{2}/g)!.map((pair) => Number.parseInt(pair, 16)));
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function verifyGitHubWebhookSignature(
  payload: Uint8Array,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const signature = hexToBytes(signatureHeader.slice("sha256=".length));
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    new Uint8Array(signature),
    new Uint8Array(payload),
  );
}

function repositoryContext(payload: JsonObject) {
  const repository = object(payload.repository);
  const installation = object(payload.installation);
  return {
    fullName: text(repository?.full_name),
    installationId: numeric(installation?.id)?.toString() || null,
  };
}

async function findSource(
  payload: JsonObject,
  db: SpecGraphDb,
): Promise<ConnectedGitHubSource | null> {
  const context = repositoryContext(payload);
  if (!context.fullName) return null;
  const rows = await db
    .select({
      id: sources.id,
      workspaceId: sources.workspaceId,
      name: sources.name,
      defaultBranch: sources.defaultBranch,
      installationId: githubInstallations.externalInstallationId,
    })
    .from(sources)
    .innerJoin(
      githubInstallations,
      eq(sources.githubInstallationId, githubInstallations.id),
    )
    .where(
      and(
        eq(sources.provider, "github"),
        eq(sources.name, context.fullName),
        inArray(sources.status, ["connected", "syncing", "error"]),
      ),
    );
  const match = rows.find(
    (row) => !context.installationId || row.installationId === context.installationId,
  );
  if (!match?.defaultBranch) return null;
  return {
    id: match.id,
    workspaceId: match.workspaceId,
    name: match.name,
    defaultBranch: match.defaultBranch,
  };
}

type PushPathChange = {
  path: string;
  changeType: "added" | "modified" | "deleted";
};

function changedPushPaths(payload: JsonObject): PushPathChange[] {
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const headCommit = object(payload.head_commit);
  const pathChanges = new Map<string, PushPathChange["changeType"]>();
  const reportedCommits = commits.length ? commits : headCommit ? [headCommit] : [];
  for (const commit of reportedCommits) {
    const item = object(commit);
    if (!item) continue;
    for (const field of ["added", "modified", "removed"] as const) {
      const values = Array.isArray(item[field]) ? item[field] : [];
      for (const value of values) {
        const path = text(value);
        if (!path) continue;
        const previous = pathChanges.get(path);
        if (field === "added") {
          pathChanges.set(path, previous === "deleted" ? "modified" : "added");
        } else if (field === "modified") {
          if (previous !== "added") pathChanges.set(path, "modified");
        } else if (previous === "added") {
          // Added and then removed within the same push has no net artifact.
          pathChanges.delete(path);
        } else {
          pathChanges.set(path, "deleted");
        }
      }
    }
  }
  return [...pathChanges].slice(0, 5_000).map(([path, changeType]) => ({
    path,
    changeType,
  }));
}

function normalizePush(
  payload: JsonObject,
  source: ConnectedGitHubSource,
): NormalizedGitHubChange | string {
  const ref = text(payload.ref);
  const expectedRef = `refs/heads/${source.defaultBranch}`;
  if (ref !== expectedRef) return `Ignored push for untracked ref ${ref || "unknown"}.`;
  if (payload.deleted === true) return "Ignored deletion of the tracked branch.";
  const afterRevision = text(payload.after);
  if (!afterRevision) throw new ApiError(422, "GITHUB_WEBHOOK_INVALID", "Push event is missing its revision.");
  const beforeRevision = text(payload.before);
  const sender = object(payload.sender);
  const pusher = object(payload.pusher);
  const headCommit = object(payload.head_commit);
  const pathChanges = changedPushPaths(payload);
  const changedPaths = pathChanges.map((change) => change.path);
  const commitMessage = text(headCommit?.message)?.split("\n")[0] || null;
  const actor = text(sender?.login) || text(pusher?.name);
  const occurredAt = text(headCommit?.timestamp) || new Date().toISOString();
  const sourceUrl = text(payload.compare);
  return {
    kind: "push",
    source,
    title: commitMessage || `Push to ${source.defaultBranch}`,
    target: source.defaultBranch,
    summary: `${changedPaths.length} changed ${changedPaths.length === 1 ? "file" : "files"} in ${source.name}.`,
    sourceLabel: `${source.name}@${afterRevision.slice(0, 7)}`,
    sourceUrl,
    beforeRevision,
    afterRevision,
    actor,
    occurredAt,
    changedArtifacts: pathChanges.map(({ path, changeType }) =>
      changedArtifactSnapshot(path, sourceUrl, changeType),
    ),
    push: {
      branch: source.defaultBranch,
      beforeRevision,
      afterRevision,
      changedPaths,
      changeTypes: Object.fromEntries(
        pathChanges.map(({ path, changeType }) => [path, changeType]),
      ),
    },
  };
}

function normalizePullRequest(
  payload: JsonObject,
  source: ConnectedGitHubSource,
): NormalizedGitHubChange | string {
  const action = text(payload.action);
  if (!action || !SUPPORTED_PULL_REQUEST_ACTIONS.has(action)) {
    return `Ignored pull_request action ${action || "unknown"}.`;
  }
  const pull = object(payload.pull_request);
  if (!pull) {
    throw new ApiError(422, "GITHUB_WEBHOOK_INVALID", "Pull request event is missing its pull request data.");
  }
  const base = object(pull?.base);
  const head = object(pull?.head);
  const user = object(pull?.user);
  const branch = text(base?.ref);
  if (branch !== source.defaultBranch) {
    return `Ignored pull request targeting untracked branch ${branch || "unknown"}.`;
  }
  const number = numeric(payload.number) || numeric(pull?.number);
  const title = text(pull?.title);
  if (!number || !title) {
    throw new ApiError(422, "GITHUB_WEBHOOK_INVALID", "Pull request event is missing its number or title.");
  }
  return {
    kind: "pull_request",
    source,
    title: `PR #${number}: ${title}`,
    target: `#${number}`,
    summary: `GitHub reported a ${action} update for ${source.name}.`,
    sourceLabel: `${source.name}#${number}`,
    sourceUrl: text(pull?.html_url),
    beforeRevision: text(base?.sha),
    afterRevision: text(head?.sha),
    actor: text(user?.login),
    occurredAt: text(pull?.updated_at) || new Date().toISOString(),
    changedArtifacts: [],
    pullRequestNumber: number,
  };
}

async function markDelivery(
  deliveryId: string,
  status: "processed" | "ignored" | "failed",
  errorMessage: string | null,
  db: SpecGraphDb,
) {
  const processedAt = new Date().toISOString();
  await db
    .update(webhookDeliveries)
    .set({ status, processedAt, errorMessage })
    .where(
      and(
        eq(webhookDeliveries.provider, "github"),
        eq(webhookDeliveries.providerDeliveryId, deliveryId),
      ),
    );
}

export async function processGitHubWebhookJob(
  job: GitHubWebhookJob,
  db: SpecGraphDb = getDb(),
) {
  const { deliveryId, runId, change } = job;
  try {
    const client = new GitHubClient(getGitHubAppConfig());
    if (change.kind === "pull_request") {
      await executeGitHubPullRequestAnalysis(
        change.source.workspaceId,
        runId,
        { sourceId: change.source.id, target: change.target },
        client,
        db,
      );
    } else if (change.push) {
      await executeGitHubPushAnalysis(
        change.source.workspaceId,
        runId,
        change.push,
        client,
        db,
      );
    }
    const [run] = await db
      .select({ status: analysisRuns.status, errorMessage: analysisRuns.errorMessage })
      .from(analysisRuns)
      .where(eq(analysisRuns.id, runId))
      .limit(1);
    if (run?.status === "succeeded") {
      await markDelivery(deliveryId, "processed", null, db);
    } else if (run?.status === "failed") {
      await markDelivery(deliveryId, "failed", run.errorMessage, db);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub webhook processing failed.";
    await failRunAttempt(
      runId,
      null,
      error,
      "GITHUB_WEBHOOK_FAILED",
      "GitHub webhook processing failed.",
      db,
    );
    await markDelivery(deliveryId, "failed", message, db);
  }
}

export async function processQueuedGitHubRun(
  runId: string,
  db: SpecGraphDb = getDb(),
): Promise<void> {
  const [record] = await db
    .select({
      runId: analysisRuns.id,
      target: analysisRuns.target,
      deliveryId: webhookDeliveries.providerDeliveryId,
      sourceId: sources.id,
      workspaceId: sources.workspaceId,
      sourceName: sources.name,
      defaultBranch: sources.defaultBranch,
      title: changeEvents.title,
      summary: changeEvents.summary,
      sourceLabel: changeEvents.sourceLabel,
      sourceUrl: changeEvents.sourceUrl,
      beforeRevision: changeEvents.beforeRevision,
      afterRevision: changeEvents.afterRevision,
      actor: changeEvents.actor,
      occurredAt: changeEvents.occurredAt,
      changedArtifactsJson: changeEvents.changedArtifactsJson,
    })
    .from(analysisRuns)
    .innerJoin(changeEvents, eq(analysisRuns.changeEventId, changeEvents.id))
    .innerJoin(sources, eq(analysisRuns.sourceId, sources.id))
    .innerJoin(webhookDeliveries, eq(webhookDeliveries.analysisRunId, analysisRuns.id))
    .where(
      and(
        eq(analysisRuns.id, runId),
        eq(analysisRuns.trigger, "github"),
        eq(webhookDeliveries.provider, "github"),
      ),
    )
    .limit(1);
  if (!record) {
    throw new Error("The queued GitHub change could not be reconstructed.");
  }
  const changedArtifacts = JSON.parse(record.changedArtifactsJson) as ChangedArtifact[];
  const pullRequest = record.target.startsWith("#");
  if (!pullRequest && !record.afterRevision) {
    throw new Error("The queued GitHub push has no target revision.");
  }
  const change: NormalizedGitHubChange = {
    kind: pullRequest ? "pull_request" : "push",
    source: {
      id: record.sourceId,
      workspaceId: record.workspaceId,
      name: record.sourceName,
      defaultBranch: record.defaultBranch || "main",
    },
    title: record.title,
    target: record.target,
    summary: record.summary,
    sourceLabel: record.sourceLabel,
    sourceUrl: record.sourceUrl,
    beforeRevision: record.beforeRevision,
    afterRevision: record.afterRevision,
    actor: record.actor,
    occurredAt: record.occurredAt,
    changedArtifacts,
    push: pullRequest
      ? undefined
      : {
          branch: record.target,
          beforeRevision: record.beforeRevision,
          afterRevision: record.afterRevision!,
          changedPaths: changedArtifacts.map((artifact) => artifact.location),
          changeTypes: Object.fromEntries(
            changedArtifacts.flatMap((artifact) => {
              const changeType = artifact.changeType;
              return changeType === "added" ||
                changeType === "modified" ||
                changeType === "deleted"
                ? [[artifact.location, changeType]]
                : [];
            }),
          ),
        },
  };
  await processGitHubWebhookJob(
    { deliveryId: record.deliveryId, runId: record.runId, change },
    db,
  );
}

export async function acceptGitHubWebhook(
  deliveryId: string,
  eventType: string,
  payloadBytes: Uint8Array,
  db: SpecGraphDb = getDb(),
): Promise<GitHubWebhookAcceptance> {
  let payload: JsonObject;
  try {
    payload = object(JSON.parse(new TextDecoder().decode(payloadBytes)))!;
    if (!payload) throw new Error("not an object");
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The webhook payload must be valid JSON.");
  }
  const payloadHash = await sha256(payloadBytes);
  const source = await findSource(payload, db);
  const receivedAt = new Date().toISOString();
  const deliveryRecordId = `wh_${(await sha256(`github:${deliveryId}`)).slice(0, 32)}`;
  const inserted = await db
    .insert(webhookDeliveries)
    .values({
      id: deliveryRecordId,
      sourceId: source?.id || null,
      provider: "github",
      providerDeliveryId: deliveryId,
      eventType,
      payloadHash,
      status: "received",
      receivedAt,
    })
    .onConflictDoNothing({
      target: [webhookDeliveries.provider, webhookDeliveries.providerDeliveryId],
    })
    .returning({ id: webhookDeliveries.id });
  const duplicate = inserted.length === 0;
  structuredLog("info", "github.webhook.received", {
    providerDeliveryId: deliveryId,
    eventType,
    duplicate,
    sourceId: source?.id || null,
    workspaceId: source?.workspaceId || null,
  });
  if (duplicate) {
    const [existing] = await db
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.provider, "github"),
          eq(webhookDeliveries.providerDeliveryId, deliveryId),
        ),
      )
      .limit(1);
    if (!existing || existing.payloadHash !== payloadHash) {
      throw new ApiError(409, "GITHUB_WEBHOOK_REPLAY_MISMATCH", "That delivery ID was already used with a different payload.");
    }
    if (existing.status !== "received") {
      return {
        status: 200,
        body: {
          accepted: true,
          duplicate: true,
          deliveryId,
          status: existing.status,
        },
      };
    }
  }

  if (eventType !== "push" && eventType !== "pull_request") {
    const reason = `Ignored unsupported GitHub event ${eventType}.`;
    await markDelivery(deliveryId, "ignored", reason, db);
    structuredLog("info", "github.webhook.ignored", {
      providerDeliveryId: deliveryId,
      eventType,
      reasonCode: "UNSUPPORTED_EVENT",
      sourceId: source?.id || null,
      workspaceId: source?.workspaceId || null,
    });
    return {
      status: 202,
      body: { accepted: true, duplicate, deliveryId, status: "ignored", reason },
    };
  }
  if (!source) {
    const reason = "Ignored event for a repository that is not connected.";
    await markDelivery(deliveryId, "ignored", reason, db);
    structuredLog("info", "github.webhook.ignored", {
      providerDeliveryId: deliveryId,
      eventType,
      reasonCode: "SOURCE_NOT_CONNECTED",
    });
    return {
      status: 202,
      body: { accepted: true, duplicate, deliveryId, status: "ignored", reason },
    };
  }

  let normalized: NormalizedGitHubChange | string;
  try {
    normalized = eventType === "push"
      ? normalizePush(payload, source)
      : normalizePullRequest(payload, source);
  } catch (error) {
    await markDelivery(
      deliveryId,
      "failed",
      error instanceof Error ? error.message : "Invalid GitHub event.",
      db,
    );
    structuredLog("error", "github.webhook.failed", {
      providerDeliveryId: deliveryId,
      eventType,
      sourceId: source.id,
      workspaceId: source.workspaceId,
      errorCode: error instanceof ApiError ? error.code : "INVALID_EVENT",
    });
    throw error;
  }
  if (typeof normalized === "string") {
    await markDelivery(deliveryId, "ignored", normalized, db);
    structuredLog("info", "github.webhook.ignored", {
      providerDeliveryId: deliveryId,
      eventType,
      sourceId: source.id,
      workspaceId: source.workspaceId,
      reasonCode: "UNTRACKED_CHANGE",
    });
    return {
      status: 202,
      body: {
        accepted: true,
        duplicate,
        deliveryId,
        status: "ignored",
        reason: normalized,
      },
    };
  }

  const idSuffix = (await sha256(`github:${deliveryId}`)).slice(0, 32);
  const changeId = `chg_wh_${idSuffix}`;
  const runId = `run_wh_${idSuffix}`;
  const evidenceSummary =
    "SpecGraph checked unchanged linked documentation for code changes, and linked primary code, schemas, or documentation for documentation changes. Related tests may also need review.";
  await db
    .insert(changeEvents)
    .values({
      id: changeId,
      workspaceId: source.workspaceId,
      sourceId: source.id,
      trigger: "github",
      title: normalized.title,
      summary: normalized.summary,
      changedArtifactsJson: JSON.stringify(normalized.changedArtifacts),
      evidenceSummary,
      sourceLabel: normalized.sourceLabel,
      sourceUrl: normalized.sourceUrl,
      beforeRevision: normalized.beforeRevision,
      afterRevision: normalized.afterRevision,
      actor: normalized.actor,
      occurredAt: normalized.occurredAt,
      createdAt: receivedAt,
    })
    .onConflictDoNothing({ target: changeEvents.id });
  await db
    .insert(analysisRuns)
    .values({
      id: runId,
      workspaceId: source.workspaceId,
      sourceId: source.id,
      changeEventId: changeId,
      requestedByUserId: null,
      trigger: "github",
      title: normalized.title,
      target: normalized.target,
      status: "queued",
      progress: 0,
      attempts: 0,
      createdAt: receivedAt,
      updatedAt: receivedAt,
    })
    .onConflictDoNothing({ target: analysisRuns.id });
  await db
    .update(webhookDeliveries)
    .set({ analysisRunId: runId })
    .where(
      and(
        eq(webhookDeliveries.provider, "github"),
        eq(webhookDeliveries.providerDeliveryId, deliveryId),
      ),
    );
  structuredLog("info", "github.webhook.queued", {
    providerDeliveryId: deliveryId,
    eventType,
    runId,
    sourceId: source.id,
    workspaceId: source.workspaceId,
  });
  return {
    status: 202,
    body: {
      accepted: true,
      duplicate,
      deliveryId,
      status: "received",
      runId,
    },
    job: { deliveryId, runId, change: normalized },
  };
}
