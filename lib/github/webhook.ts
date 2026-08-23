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
import { ApiError } from "../server/http";
import { GitHubClient } from "./client";
import { getGitHubAppConfig } from "./config";
import {
  executeGitHubPullRequestAnalysis,
  executeGitHubPushAnalysis,
  type GitHubPushAnalysisInput,
} from "./analysis";

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

function changedPushPaths(payload: JsonObject): string[] {
  const commits = Array.isArray(payload.commits) ? payload.commits : [];
  const headCommit = object(payload.head_commit);
  const paths = new Set<string>();
  for (const commit of [...commits, ...(headCommit ? [headCommit] : [])]) {
    const item = object(commit);
    if (!item) continue;
    for (const field of ["added", "modified", "removed"] as const) {
      const values = Array.isArray(item[field]) ? item[field] : [];
      for (const value of values) {
        const path = text(value);
        if (path) paths.add(path);
      }
    }
  }
  return [...paths].slice(0, 5_000);
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
  const changedPaths = changedPushPaths(payload);
  const commitMessage = text(headCommit?.message)?.split("\n")[0] || null;
  const actor = text(sender?.login) || text(pusher?.name);
  const occurredAt = text(headCommit?.timestamp) || new Date().toISOString();
  return {
    kind: "push",
    source,
    title: commitMessage || `Push to ${source.defaultBranch}`,
    target: source.defaultBranch,
    summary: `${changedPaths.length} changed ${changedPaths.length === 1 ? "file" : "files"} in ${source.name}.`,
    sourceLabel: `${source.name}@${afterRevision.slice(0, 7)}`,
    sourceUrl: text(payload.compare),
    beforeRevision,
    afterRevision,
    actor,
    occurredAt,
    push: {
      branch: source.defaultBranch,
      beforeRevision,
      afterRevision,
      changedPaths,
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
    return {
      status: 202,
      body: { accepted: true, duplicate, deliveryId, status: "ignored", reason },
    };
  }
  if (!source) {
    const reason = "Ignored event for a repository that is not connected.";
    await markDelivery(deliveryId, "ignored", reason, db);
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
    throw error;
  }
  if (typeof normalized === "string") {
    await markDelivery(deliveryId, "ignored", normalized, db);
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
    "SpecGraph checked unchanged linked documentation for code changes, and linked code, tests, or documentation for documentation changes.";
  await db
    .insert(changeEvents)
    .values({
      id: changeId,
      workspaceId: source.workspaceId,
      sourceId: source.id,
      trigger: "github",
      title: normalized.title,
      summary: normalized.summary,
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
