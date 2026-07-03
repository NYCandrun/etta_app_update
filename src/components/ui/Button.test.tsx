import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "./Button";
import { LABELS } from "../../lib/labels";

describe("Button design-system component", () => {
  it("renders the standardized quiz advance labels", () => {
    render(<Button variant="primary">{LABELS.next}</Button>);
    expect(screen.getByRole("button")).toHaveTextContent("Next");
  });

  it("defaults to type=button to avoid accidental form submits", () => {
    render(<Button>Click</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("applies the danger variant tokens", () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole("button").className).toContain("bg-danger");
  });
});
