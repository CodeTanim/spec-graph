import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SpecGraphApp } from "../app/page";

describe("SpecGraphApp", () => {
  it("starts with only changes that need attention", async () => {
    const user = userEvent.setup();
    render(<SpecGraphApp />);

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

  it("reveals impact details only after a change is opened", async () => {
    const user = userEvent.setup();
    render(<SpecGraphApp />);

    expect(screen.queryByText("What may need updating")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Refund validation window changed/ }),
    );

    expect(
      screen.getByRole("dialog", { name: "Refund validation window changed" }),
    ).toBeInTheDocument();
    expect(screen.getByText("What may need updating")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Customer Refund Guide/ }));
    expect(
      screen.getByText(
        "Refunds are available within 30 days of the original charge.",
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /How did we find these/ }));
    expect(
      screen.getByText(
        "The code and every listed resource refer to the same refund-window rule.",
      ),
    ).toBeInTheDocument();
  });

  it("adds a manual analysis to the same change list", async () => {
    const user = userEvent.setup();
    render(<SpecGraphApp />);

    await user.click(screen.getByRole("button", { name: "Analyze" }));
    const target = screen.getByRole("textbox", { name: "What should we check?" });
    await user.clear(target);
    await user.type(target, "release/2026.08");
    await user.click(screen.getByRole("button", { name: "Run analysis" }));

    expect(
      screen.getByRole("button", { name: /Checking release\/2026\.08/ }),
    ).toHaveTextContent("Analyzing…");
  });

  it("keeps sources understandable without workspace chrome", async () => {
    const user = userEvent.setup();
    render(<SpecGraphApp />);

    await user.click(screen.getByRole("button", { name: "Sources" }));

    expect(
      screen.getByRole("heading", { name: "Connected sources" }),
    ).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.getByText("Confluence")).toBeInTheDocument();
    expect(screen.queryByText("Alex Kim")).not.toBeInTheDocument();
  });
});
