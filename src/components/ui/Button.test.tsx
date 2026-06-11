import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Button } from "./Button";
import { LABELS } from "../../lib/labels";

describe("Button design-system component", () => {
  it("renders the standardized Check Answer label", () => {
    render(<Button variant="primary">{LABELS.checkAnswer}</Button>);
    expect(screen.getByRole("button")).toHaveTextContent("Check Answer");
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
