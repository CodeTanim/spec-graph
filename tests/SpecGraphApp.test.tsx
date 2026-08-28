import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpecGraphApp } from "../app/specgraph-app";
import { emptyDashboardSnapshot } from "../lib/contracts/specgraph";
import { createFakeApi, dashboardFixture } from "./fixtures/specgraph";

function renderApp() {
  render(
    <SpecGraphApp
      api={createFakeApi()}
      initialData={dashboardFixture}
      loadOnMount={false}
    />,
  );
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("SpecGraphApp", () => {
  it("guides a fresh workspace directly into source setup", async () => {
    const user = userEvent.setup();
    render(
      <SpecGraphApp
        api={createFakeApi(emptyDashboardSnapshot)}
        initialData={emptyDashboardSnapshot}
        loadOnMount={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Connect your first source" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Everything is up to date")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Change filters")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Connect your first source" }));
    expect(
      screen.getByRole("dialog", { name: "Add your first source" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close source chooser" }));
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(
      screen.getByRole("dialog", { name: "Add your first source" }),
    ).toBeInTheDocument();
  });

  it("shows when connected sources are still being prepared", async () => {
    const user = userEvent.setup();
    const source = {
      ...dashboardFixture.sources.items[0],
      status: "syncing" as const,
      lastSyncedAt: null,
    };
    const snapshot = {
      ...emptyDashboardSnapshot,
      sources: {
        items: [source],
        groups: [{ id: "group-preparing", sources: [source] }],
      },
    };
    render(
      <SpecGraphApp
        api={createFakeApi(snapshot)}
        initialData={snapshot}
        loadOnMount={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Preparing your sources" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByText("Indexing now")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Check platform-api for updates" }),
    ).toBeDisabled();
  });

  it("offers the first check only after a source is ready", async () => {
    const user = userEvent.setup();
    const source = dashboardFixture.sources.items[0];
    const snapshot = {
      ...emptyDashboardSnapshot,
      sources: {
        items: [source],
        groups: [{ id: "group-ready", sources: [source] }],
      },
    };
    render(
      <SpecGraphApp
        api={createFakeApi(snapshot)}
        initialData={snapshot}
        loadOnMount={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Ready for your first check" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Run your first check" }));
    expect(screen.getByRole("dialog", { name: "Analyze now" })).toBeInTheDocument();
  });

  it("only says everything is up to date after a completed check", () => {
    const source = dashboardFixture.sources.items[0];
    const completedRun = {
      ...dashboardFixture.runs.items[0],
      findingsCount: 0,
      status: "succeeded" as const,
    };
    const snapshot = {
      changes: {
        items: [],
        counts: { open: 0, total: 0 },
        lastCheckedAt: completedRun.completedAt,
      },
      runs: { items: [completedRun] },
      sources: {
        items: [source],
        groups: [{ id: "group-checked", sources: [source] }],
      },
    };
    render(
      <SpecGraphApp
        api={createFakeApi(snapshot)}
        initialData={snapshot}
        loadOnMount={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Everything is up to date" }),
    ).toBeInTheDocument();
  });

  it("directs source failures to the source screen", async () => {
    const user = userEvent.setup();
    const source = {
      ...dashboardFixture.sources.items[0],
      status: "error" as const,
    };
    const snapshot = {
      ...emptyDashboardSnapshot,
      sources: {
        items: [source],
        groups: [{ id: "group-error", sources: [source] }],
      },
    };
    render(
      <SpecGraphApp
        api={createFakeApi(snapshot)}
        initialData={snapshot}
        loadOnMount={false}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "A source needs attention" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review sources" }));
    expect(screen.getByRole("heading", { name: "Connected sources" })).toBeInTheDocument();
    expect(screen.getByText("The last check failed")).toBeInTheDocument();
  });

  it("starts with only changes that need attention", async () => {
    const user = userEvent.setup();
    renderApp();

    expect(
      screen.getByRole("heading", { name: "3 changes need your attention" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Refund validation window changed/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Authentication guide wording updated/ }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "All 6" }));

    expect(
      screen.getByRole("button", { name: /Authentication guide wording updated/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Webhook retry behavior adjusted/ }),
    ).toBeInTheDocument();
  });

  it("reveals linked impact details only after a change is opened", async () => {
    const user = userEvent.setup();
    renderApp();

    expect(screen.queryByText("What may need updating")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Refund validation window changed/ }),
    );

    expect(
      screen.getByRole("dialog", { name: "Refund validation window changed" }),
    ).toBeInTheDocument();
    const affectedHeading = screen.getByRole("heading", {
      name: /What may need updating/,
    });
    const changedToggle = screen.getByRole("button", { name: /What changed/ });
    expect(
      affectedHeading.compareDocumentPosition(changedToggle) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(changedToggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("link", { name: /src\/refunds\/policy\.ts/ }),
    ).not.toBeInTheDocument();

    await user.click(changedToggle);
    expect(changedToggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("link", { name: /src\/refunds\/policy\.ts/ }),
    ).toHaveAttribute(
      "href",
      "https://github.com/acme/platform-api/blob/abc123/src/refunds/policy.ts",
    );
    await user.click(screen.getByRole("button", { name: /Customer Refund Guide/ }));

    const causalSummary = document.querySelector(".causal-summary");
    expect(causalSummary).toHaveTextContent(
      "Customer Refund Guide may need updating because policy.ts changed.",
    );
    expect(causalSummary?.querySelectorAll("a")[0]).toHaveAttribute(
      "href",
      "https://acme.atlassian.net/wiki/spaces/OPS/pages/100/refunds",
    );
    expect(causalSummary?.querySelectorAll("a")[1]).toHaveAttribute(
      "href",
      "https://github.com/acme/platform-api/blob/abc123/src/refunds/policy.ts#L18-L21",
    );
    await user.click(screen.getByText("Why SpecGraph flagged this"));
    expect(
      screen.getByText("Refunds are available within 30 days of the original charge."),
    ).toBeInTheDocument();
    const relationshipEvidence = screen.getByLabelText("Verified relationship evidence");
    expect(relationshipEvidence).toHaveTextContent("Exact identifier · 95% confidence");
    expect(relationshipEvidence).toHaveTextContent(
      "src/refunds/policy.ts:18",
    );
    expect(screen.getByRole("link", { name: "Open policy.ts" })).toHaveAttribute(
      "href",
      "https://github.com/acme/platform-api/blob/abc123/src/refunds/policy.ts#L18-L21",
    );
    expect(
      screen.getByRole("link", { name: "Open Customer Refund Guide" }),
    ).toHaveAttribute(
      "href",
      "https://acme.atlassian.net/wiki/spaces/OPS/pages/100/refunds",
    );

    await user.click(screen.getByRole("button", { name: /How did we find these/ }));
    expect(
      screen.getByText("The code and listed resources refer to the same refund-window rule."),
    ).toBeInTheDocument();
  });

  it("expands affected-item evidence directly beneath the selected row", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(
      screen.getByRole("button", { name: /Reason is now required for refund requests/ }),
    );
    const artifactButton = screen.getByRole("button", { name: /Refund SDK/ });
    const detailsId = artifactButton.getAttribute("aria-controls");

    expect(detailsId).toBeTruthy();
    await user.click(artifactButton);

    const details = document.getElementById(detailsId!);
    expect(artifactButton).toHaveAttribute("aria-expanded", "true");
    expect(artifactButton).toHaveTextContent("packages/sdk/src/refunds.ts / createRefund");
    expect(details).toHaveTextContent("createRefund({ transactionId })");
    expect(details?.previousElementSibling).toBe(artifactButton);
  });

  it("queues a manual analysis through the API and shows it in Runs", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Analyze" }));
    const target = screen.getByRole("textbox", { name: "What should we check?" });
    await user.clear(target);
    await user.type(target, "release/2026.08");
    await user.click(screen.getByRole("button", { name: "Run analysis" }));

    expect(
      screen.getByRole("dialog", { name: "Analysis in progress" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/SpecGraph is checking release\/2026\.08/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue in background" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent activity" })).toBeInTheDocument();
    expect(screen.getByText("Checking release/2026.08")).toBeInTheDocument();
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("polls a persisted run and shows its completed result", async () => {
    const queuedRun = {
      ...dashboardFixture.runs.items[0],
      id: "run-polling",
      title: "Checking #842",
      target: "#842",
      status: "queued" as const,
      progress: 0,
      findingsCount: 0,
      completedAt: null,
    };
    const completedRun = {
      ...queuedRun,
      status: "succeeded" as const,
      progress: 100,
      findingsCount: 1,
      completedAt: "2026-08-17T01:00:00.000Z",
    };
    const api = createFakeApi();
    let runListLoads = 0;
    api.loadRuns = async () => ({
      items: [runListLoads++ === 0 ? queuedRun : completedRun],
    });
    api.loadRun = vi.fn(async () => completedRun);

    render(
      <SpecGraphApp
        api={api}
        initialData={{
          ...dashboardFixture,
          runs: { items: [queuedRun] },
        }}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Runs" }));

    expect(screen.getByText("Queued")).toBeInTheDocument();
    expect(await screen.findByText("1 finding", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(api.loadRun).toHaveBeenCalledWith("run-polling");
  });

  it("does not repeatedly reload the full workspace while the page is idle", async () => {
    vi.useFakeTimers();
    const api = createFakeApi({
      ...dashboardFixture,
      runs: { items: [] },
    });
    api.loadChanges = vi.fn(api.loadChanges);
    api.loadRuns = vi.fn(api.loadRuns);
    api.loadSources = vi.fn(api.loadSources);

    render(
      <SpecGraphApp
        api={api}
        initialData={{
          ...dashboardFixture,
          runs: { items: [] },
        }}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.loadChanges).toHaveBeenCalledTimes(1);
    expect(api.loadRuns).toHaveBeenCalledTimes(1);
    expect(api.loadSources).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(api.loadChanges).toHaveBeenCalledTimes(1);
    expect(api.loadRuns).toHaveBeenCalledTimes(1);
    expect(api.loadSources).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("persists one suggestion review without silently closing the whole change", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(
      screen.getByRole("button", { name: /Refund validation window changed/ }),
    );
    await user.click(screen.getByRole("button", { name: /Customer Refund Guide/ }));
    await user.click(
      screen.getByRole("button", { name: "Mark suggestion resolved" }),
    );

    expect(screen.getByText("Resolved")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reopen suggestion" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reopen all 1 suggestion" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Customer Refund Guide resolved",
    );

    await user.click(screen.getByRole("button", { name: "Close change details" }));

    expect(
      screen.queryByRole("button", { name: /Refund validation window changed/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps mixed review decisions visible and labels bulk actions explicitly", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(
      screen.getByRole("button", {
        name: /Reason is now required for refund requests/,
      }),
    );
    await user.click(screen.getByRole("button", { name: /Refund SDK/ }));
    await user.click(
      screen.getByRole("button", { name: "Mark suggestion resolved" }),
    );

    expect(
      screen.getByRole("button", { name: "Resolve all 1 open suggestion" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Dismiss all 1 open suggestion" }),
    );

    await user.click(screen.getByRole("button", { name: "All 6" }));
    const reviewedChange = screen.getByRole("button", {
      name: /Reason is now required for refund requests.*Reviewed/,
    });
    expect(reviewedChange).toBeInTheDocument();
    await user.click(reviewedChange);
    expect(screen.getAllByText("Resolved").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Dismissed").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /API request guide/ }));
    await user.click(screen.getByRole("button", { name: "Reopen suggestion" }));
    expect(
      screen.getByRole("button", { name: "Mark suggestion resolved" }),
    ).toBeInTheDocument();
  });

  it("opens the completed run's actual findings from View results", async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    const completedRunId = "run-completed-manual";
    api.startRun = vi.fn(async () => ({
      run: {
        ...dashboardFixture.runs.items[0],
        id: completedRunId,
        status: "succeeded" as const,
        progress: 100,
      },
    }));
    api.loadChanges = vi.fn(async () => ({
      ...dashboardFixture.changes,
      items: [
        {
          ...dashboardFixture.changes.items[0],
          runId: completedRunId,
        },
        ...dashboardFixture.changes.items.slice(1),
      ],
    }));
    render(
      <SpecGraphApp
        api={api}
        initialData={dashboardFixture}
        loadOnMount={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await user.type(
      screen.getByRole("textbox", { name: "What should we check?" }),
      "refund policy",
    );
    await user.click(screen.getByRole("button", { name: "Run analysis" }));
    await user.click(screen.getByRole("button", { name: "View results" }));

    expect(
      await screen.findByRole("dialog", {
        name: "Refund validation window changed",
      }),
    ).toBeInTheDocument();
  });

  it("keeps connected sources understandable", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Sources" }));

    expect(screen.getByRole("heading", { name: "Connected sources" })).toBeInTheDocument();
    expect(screen.getByText("platform-api")).toBeInTheDocument();
    expect(screen.getByText("16 indexed files of source code")).toBeInTheDocument();
    expect(screen.getByText("8 indexed files of repository documentation")).toBeInTheDocument();
    expect(screen.getByText("GitHub repository")).toBeInTheDocument();
    expect(screen.getByText("Confluence space")).toBeInTheDocument();
    expect(screen.getByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("12 indexed pages")).toBeInTheDocument();
    expect(screen.queryByText("Tracking each other")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(
        "Connected source group containing platform-api, Engineering",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add source" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect source" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "+ Add documentation" })).not.toBeInTheDocument();
    expect(screen.queryByText("Alex Kim")).not.toBeInTheDocument();
  });

  it("keeps the source chooser neutral and connects from either provider", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Sources" }));
    await user.click(screen.getByRole("button", { name: "+ Add source" }));

    expect(
      screen.getByRole("dialog", { name: "Connect more sources together" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /GitHub repository/ })).toHaveAttribute("href", "/api/github/connect");
    expect(screen.getByRole("link", { name: /Confluence documentation/ })).toHaveAttribute("href", "/api/confluence/connect");
    expect(screen.getByText("Notion documentation")).toBeInTheDocument();
    expect(screen.getByText("Google Docs")).toBeInTheDocument();
    expect(screen.getAllByText("Connection coming next")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /Notion documentation/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Google Docs/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close source chooser" }));
    await user.click(screen.getByRole("button", { name: "Connect source" }));
    expect(
      screen.getByRole("dialog", { name: "Connect more sources together" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /GitHub repository/ })).toHaveAttribute(
      "href",
      "/api/github/connect?group_id=group-platform",
    );
    expect(screen.getByRole("link", { name: /Confluence documentation/ })).toHaveAttribute(
      "href",
      "/api/confluence/connect?group_id=group-platform",
    );
    expect(screen.getByText("Notion documentation")).toBeInTheDocument();
    expect(screen.getByText("Google Docs")).toBeInTheDocument();
  });

  it("dismisses post-auth source selection and restarts from the source chooser", async () => {
    const user = userEvent.setup();
    const api = createFakeApi();
    api.loadConfluenceConnectionSession = vi.fn(async () => ({
      items: [
        {
          id: "space-software",
          key: "SD",
          name: "Software development",
          cloudId: "cloud-acme",
          siteName: "codetanim",
          siteUrl: "https://codetanim.atlassian.net",
        },
      ],
      expiresAt: "2026-08-26T23:00:00.000Z",
      sourceGroupId: "group-platform",
    }));
    window.history.replaceState({}, "", "/?confluence_session=session-1");

    render(
      <SpecGraphApp api={api} initialData={dashboardFixture} />,
    );

    const dialog = await screen.findByRole("dialog", { name: "Choose documentation" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("main")).not.toHaveTextContent("Choose documentation");
    expect(screen.getByRole("combobox", { name: "Space" })).toHaveValue(
      "space-software",
    );

    await user.click(screen.getByRole("button", { name: "Close documentation chooser" }));
    expect(
      screen.queryByRole("dialog", { name: "Choose documentation" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Continue connecting source")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "+ Add source" }));
    expect(
      screen.getByRole("dialog", { name: "Connect more sources together" }),
    ).toBeInTheDocument();
  });

  it("turns an expired provider session into a fresh source choice", async () => {
    const api = createFakeApi();
    api.loadConfluenceConnectionSession = vi.fn(async () => {
      throw new Error("That Confluence connection expired. Start again.");
    });
    window.history.replaceState({}, "", "/?confluence_session=expired-session");

    render(<SpecGraphApp api={api} initialData={dashboardFixture} />);

    const dialog = await screen.findByRole("dialog", {
      name: "Connect more sources together",
    });
    expect(dialog).toHaveTextContent(
      "That Confluence connection expired. Choose a source to start again.",
    );
    expect(screen.queryByText("SpecGraph couldn’t load this source.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Confluence documentation/ })).toHaveAttribute(
      "href",
      "/api/confluence/connect",
    );
  });

  it("renders the account action in the top navigation", () => {
    render(
      <SpecGraphApp
        api={createFakeApi()}
        accountAction={<button type="button">Log out</button>}
        initialData={dashboardFixture}
        loadOnMount={false}
      />,
    );

    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("treats two documentation sources as equal members of one group", async () => {
    const documentation = dashboardFixture.sources.items.find(
      (source) => source.provider === "confluence",
    )!;
    const secondDocumentation = {
      ...documentation,
      id: "source-confluence-product",
      name: "Product requirements",
      detail: "Acme / PRODUCT",
    };
    const api = createFakeApi({
      ...dashboardFixture,
      sources: {
        items: [documentation, secondDocumentation],
        groups: [{
          id: "group-documentation",
          sources: [documentation, secondDocumentation],
        }],
      },
    });
    render(
      <SpecGraphApp
        api={api}
        initialData={{
          ...dashboardFixture,
          sources: {
            items: [documentation, secondDocumentation],
            groups: [{
              id: "group-documentation",
              sources: [documentation, secondDocumentation],
            }],
          },
        }}
        loadOnMount={false}
      />,
    );
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Sources" }));
    expect(
      screen.getByLabelText(
        "Connected source group containing Engineering, Product requirements",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect source" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Connect source" }));
    expect(screen.getByRole("link", { name: /GitHub repository/ })).toHaveAttribute(
      "href",
      "/api/github/connect?group_id=group-documentation",
    );
    expect(screen.getByRole("link", { name: /Confluence documentation/ })).toHaveAttribute(
      "href",
      "/api/confluence/connect?group_id=group-documentation",
    );
  });

  it("confirms before removing a connected repository", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Sources" }));
    await user.click(screen.getByRole("button", { name: "Remove platform-api" }));

    expect(
      screen.getByRole("dialog", { name: "Stop watching platform-api?" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Existing findings and run history will remain available/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove source" }));

    expect(screen.queryByText("platform-api")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "acme/platform-api is no longer being watched",
    );
  });
});
