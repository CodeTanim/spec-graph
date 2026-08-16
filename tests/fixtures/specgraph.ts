import type { SpecGraphApi } from "../../lib/api-client";
import type {
  ChangeFilter,
  ChangeItem,
  DashboardSnapshot,
  FindingAction,
  RunItem,
  StartRunInput,
} from "../../lib/contracts/specgraph";

const changes: ChangeItem[] = [
  {
    id: "refund-window",
    runId: "run-refund-window",
    title: "Refund validation window changed",
    source: "src/refunds/policy.ts",
    sourceUrl: "https://github.com/acme/platform-api/blob/abc123/src/refunds/policy.ts",
    occurredAt: "2026-08-15T14:12:00.000Z",
    status: "open",
    affected: 1,
    summary:
      "The refund window changed from 30 to 60 days. Connected resources still describe the old behavior.",
    evidence: "The code and listed resources refer to the same refund-window rule.",
    artifacts: [
      {
        id: "finding-customer-refund-guide",
        name: "Customer Refund Guide",
        kind: "Confluence",
        location: "Customer Operations / Refunds / Eligibility",
        excerpt: "Refunds are available within 30 days of the original charge.",
        reason: "The page still contains the previous refund window.",
        externalUrl: "https://acme.atlassian.net/wiki/spaces/OPS/pages/100/refunds",
      },
    ],
  },
  {
    id: "refund-reason",
    runId: "run-refund-reason",
    title: "Reason is now required for refund requests",
    source: "api/openapi.yaml",
    sourceUrl: "https://github.com/acme/platform-api/blob/def456/api/openapi.yaml",
    occurredAt: "2026-08-15T13:50:00.000Z",
    status: "open",
    affected: 2,
    summary: "The API contract now requires a reason.",
    evidence: "The affected resources create the RefundRequest object.",
    artifacts: [
      {
        id: "finding-refund-sdk",
        name: "Refund SDK",
        kind: "Code",
        location: "packages/sdk/src/refunds.ts / createRefund",
        excerpt: "createRefund({ transactionId })",
        reason: "The SDK still omits the new reason field.",
        externalUrl: "https://github.com/acme/platform-api/blob/def456/packages/sdk/src/refunds.ts",
      },
      {
        id: "finding-refund-docs",
        name: "API request guide",
        kind: "Markdown",
        location: "docs/api/refunds.md / Request body",
        excerpt: "{ \"transactionId\": \"txn_123\" }",
        reason: "The request example still omits the reason field.",
        externalUrl: "https://github.com/acme/platform-api/blob/def456/docs/api/refunds.md",
      },
    ],
  },
  {
    id: "payout-schema",
    runId: "run-payout-schema",
    title: "Payout response schema expanded",
    source: "api/openapi.yaml",
    sourceUrl: null,
    occurredAt: "2026-08-14T17:00:00.000Z",
    status: "open",
    affected: 1,
    summary: "The response now includes settlementStatus.",
    evidence: "The guide contains an example of the changed response schema.",
    artifacts: [
      {
        id: "finding-payout-guide",
        name: "Payout API guide",
        kind: "Markdown",
        location: "docs/api/payouts.md / Response",
        excerpt: "{ \"id\": \"po_123\", \"amount\": 4200 }",
        reason: "The response example does not include settlementStatus.",
        externalUrl: null,
      },
    ],
  },
  {
    id: "webhook-retry",
    runId: "run-webhook-retry",
    title: "Webhook retry behavior adjusted",
    source: "worker/retry.ts",
    sourceUrl: null,
    occurredAt: "2026-08-15T12:00:00.000Z",
    status: "processing",
    affected: 0,
    summary: "SpecGraph is checking which resources describe the retry policy.",
    evidence: "",
    artifacts: [],
  },
  {
    id: "auth-wording",
    runId: "run-auth-wording",
    title: "Authentication guide wording updated",
    source: "Confluence / Authentication",
    sourceUrl: null,
    occurredAt: "2026-08-14T15:00:00.000Z",
    status: "checked",
    affected: 0,
    summary: "A documentation clarification was reviewed against the repository README.",
    evidence: "The README and page describe the same authentication flow.",
    artifacts: [],
  },
  {
    id: "runbook-owner",
    runId: "run-runbook-owner",
    title: "Settlement runbook owner changed",
    source: "Confluence / Settlement Operations",
    sourceUrl: null,
    occurredAt: "2026-08-13T15:00:00.000Z",
    status: "checked",
    affected: 0,
    summary: "The runbook owner changed.",
    evidence: "The ownership entry was reviewed.",
    artifacts: [],
  },
];

const runs: RunItem[] = changes.map((change) => ({
  id: change.runId,
  title: change.title,
  trigger: change.source.startsWith("Confluence") ? "confluence" : "github",
  target: change.source,
  status:
    change.status === "processing"
      ? "running"
      : change.status === "checked" || change.status === "open"
        ? "succeeded"
        : "failed",
  createdAt: change.occurredAt,
  completedAt: change.status === "processing" ? null : change.occurredAt,
  findingsCount: change.affected,
  errorMessage: null,
}));

export const dashboardFixture: DashboardSnapshot = {
  changes: {
    items: changes.filter((change) => change.status === "open"),
    counts: { open: 3, total: 6 },
    lastCheckedAt: "2026-08-15T14:12:00.000Z",
  },
  runs: { items: runs },
  sources: {
    items: [
      {
        id: "source-github",
        provider: "github",
        name: "acme/platform-api",
        detail: "main",
        status: "connected",
        lastSyncedAt: "2026-08-15T14:12:00.000Z",
        artifactCount: 24,
        codeArtifactCount: 16,
        documentationArtifactCount: 8,
      },
      {
        id: "source-confluence",
        provider: "confluence",
        name: "Engineering",
        detail: "API Platform",
        status: "connected",
        lastSyncedAt: "2026-08-15T14:00:00.000Z",
        artifactCount: 12,
        codeArtifactCount: 0,
        documentationArtifactCount: 12,
      },
    ],
  },
};

export function createFakeApi(snapshot = dashboardFixture): SpecGraphApi {
  let currentChanges = snapshot.changes.items.length === changes.length
    ? [...snapshot.changes.items]
    : [...changes];
  let currentRuns = [...snapshot.runs.items];
  let currentSources = [...snapshot.sources.items];

  function changeResponse(filter: ChangeFilter) {
    return {
      items:
        filter === "open"
          ? currentChanges.filter((change) => change.status === "open")
          : [...currentChanges],
      counts: {
        open: currentChanges.filter((change) => change.status === "open").length,
        total: currentChanges.length,
      },
      lastCheckedAt: snapshot.changes.lastCheckedAt,
    };
  }

  return {
    async loadChanges(filter) {
      return changeResponse(filter);
    },
    async loadChange(id) {
      const item = currentChanges.find((change) => change.id === id);
      if (!item) throw new Error("Change not found");
      return item;
    },
    async updateChange(id, action: FindingAction) {
      const nextStatus = action === "reopen" ? "open" : "checked";
      currentChanges = currentChanges.map((change) =>
        change.id === id ? { ...change, status: nextStatus } : change,
      );
      const item = currentChanges.find((change) => change.id === id);
      if (!item) throw new Error("Change not found");
      return item;
    },
    async loadRuns() {
      return { items: [...currentRuns] };
    },
    async loadRun(id) {
      const run = currentRuns.find((item) => item.id === id);
      if (!run) throw new Error("Run not found");
      return run;
    },
    async startRun(input: StartRunInput) {
      const run: RunItem = {
        id: `run-manual-${currentRuns.length}`,
        title: `Checking ${input.target}`,
        trigger: "manual",
        target: input.target,
        status: "queued",
        createdAt: "2026-08-15T15:00:00.000Z",
        completedAt: null,
        findingsCount: 0,
        errorMessage: null,
      };
      currentRuns = [run, ...currentRuns];
      return { run };
    },
    async loadSources() {
      return { items: [...currentSources] };
    },
    async loadGitHubStatus() {
      return { configured: true };
    },
    async loadGitHubConnectionSession() {
      return { items: [], expiresAt: "2026-08-15T16:00:00.000Z" };
    },
    async connectGitHubSource() {
      throw new Error("No GitHub connection session in this fixture.");
    },
    async syncSource(id) {
      const source = currentSources.find((item) => item.id === id);
      if (!source) throw new Error("Source not found");
      return { source };
    },
    async removeSource(id) {
      if (!currentSources.some((source) => source.id === id)) {
        throw new Error("Source not found");
      }
      currentSources = currentSources.filter((source) => source.id !== id);
      return { removedSourceId: id };
    },
  };
}
