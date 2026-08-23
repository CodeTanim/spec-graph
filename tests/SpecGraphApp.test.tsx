import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SpecGraphApp } from "../app/specgraph-app";
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

describe("SpecGraphApp", () => {
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
    await user.click(screen.getByRole("button", { name: /Customer Refund Guide/ }));

    expect(
      screen.getByText("Refunds are available within 30 days of the original charge."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open source/ })).toHaveAttribute(
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

  it("persists a review action through the API contract", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(
      screen.getByRole("button", { name: /Refund validation window changed/ }),
    );
    await user.click(screen.getByRole("button", { name: "Mark resolved" }));

    expect(
      screen.queryByRole("button", { name: /Refund validation window changed/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Change resolved");
  });

  it("keeps connected sources understandable", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Sources" }));

    expect(screen.getByRole("heading", { name: "Connected sources" })).toBeInTheDocument();
    expect(screen.getByText("platform-api")).toBeInTheDocument();
    expect(screen.getByText("Source code — 16 indexed files")).toBeInTheDocument();
    expect(
      screen.getByText("Repository documentation — 8 indexed files"),
    ).toBeInTheDocument();
    expect(screen.getByText("Confluence — Engineering")).toBeInTheDocument();
    expect(screen.getByText("12 indexed pages")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add source" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add documentation" })).toBeInTheDocument();
    expect(screen.queryByText("Alex Kim")).not.toBeInTheDocument();
  });

  it("keeps the generic source chooser minimal and scopes repository documentation", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: "Sources" }));
    await user.click(screen.getByRole("button", { name: "+ Add source" }));

    expect(screen.getByRole("dialog", { name: "Add source" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /GitHub repository/ })).toHaveAttribute("href", "/api/github/connect");
    expect(screen.getByRole("link", { name: /Confluence documentation/ })).toHaveAttribute("href", "/api/confluence/connect");
    expect(screen.getByText("Notion documentation")).toBeInTheDocument();
    expect(screen.getByText("Google Docs")).toBeInTheDocument();
    expect(screen.getAllByText("Connection coming next")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: /Notion documentation/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Google Docs/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close source chooser" }));
    await user.click(screen.getByRole("button", { name: "+ Add documentation" }));
    expect(screen.getByRole("dialog", { name: "Add documentation" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /GitHub repository/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Confluence documentation/ })).toHaveAttribute(
      "href",
      "/api/confluence/connect?repository_source_id=source-github",
    );
    expect(screen.getByText("Notion documentation")).toBeInTheDocument();
    expect(screen.getByText("Google Docs")).toBeInTheDocument();
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
