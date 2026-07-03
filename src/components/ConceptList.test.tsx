import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConceptList } from "./ConceptList";
import { useCurriculumStore } from "../stores/useCurriculumStore";
import type { Concept } from "../types/contract";

function concept(partial: Partial<Concept> & Pick<Concept, "id">): Concept {
  return {
    domain: "algebra",
    module: "alg_m01",
    title: partial.id,
    prerequisites: [],
    learningObjectives: [],
    difficultyTier: 1,
    errorPatterns: [],
    masteryScore: 0,
    effectiveMastery: 0,
    easeFactor: 2.5,
    intervalDays: 0,
    nextReview: null,
    lastAttemptAt: null,
    state: "unlocked",
    ...partial,
  };
}

// Text a screen reader can announce: skips aria-hidden subtrees.
function announcedText(el: Element): string {
  if (el.getAttribute("aria-hidden") === "true") return "";
  let out = "";
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      out += announcedText(child as Element);
    }
  }
  return out;
}

function renderList() {
  return render(
    <MemoryRouter>
      <ConceptList />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useCurriculumStore.setState({ concepts: {} });
});

describe("ConceptList domains", () => {
  it("orders domains by curriculum phase: Trigonometry BEFORE Pre-Calculus", () => {
    useCurriculumStore.getState().setConcepts([
      concept({ id: "prec_001", domain: "precalculus", module: "prec_m01" }),
      concept({ id: "trig_001", domain: "trigonometry", module: "trig_m01" }),
      concept({ id: "alg_001", domain: "algebra", module: "alg_m01" }),
    ]);
    renderList();
    const headings = screen
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["Algebra", "Trigonometry", "Pre-Calculus"]);
  });

  it("uses the curriculum display_name for headings", () => {
    useCurriculumStore.getState().setConcepts([
      concept({ id: "thm_001", domain: "thermodynamics", module: "thm_m01" }),
      concept({
        id: "svc_001",
        domain: "single_variable_calculus",
        module: "svc_m01",
      }),
    ]);
    renderList();
    expect(
      screen.getByRole("heading", {
        name: "Thermodynamics & Statistical Mechanics",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Single-Variable Calculus" }),
    ).toBeInTheDocument();
  });
});

describe("ConceptList row status", () => {
  it("announces a locked row's status exactly once", () => {
    useCurriculumStore
      .getState()
      .setConcepts([
        concept({ id: "alg_002", title: "Linear Equations", state: "locked" }),
      ]);
    renderList();
    const row = screen.getByRole("listitem");
    // Visually the row may show the state twice (subtitle + end marker)…
    expect((row.textContent ?? "").match(/Locked/g)).toHaveLength(2);
    // …but assistive tech hears it exactly ONCE (the subtitle).
    expect(announcedText(row).match(/Locked/g)).toHaveLength(1);
    expect(row).toHaveAttribute("aria-disabled", "true");
    // The old sr-only duplicate prefix is gone.
    expect(row.querySelector(".sr-only")).toBeNull();
  });

  it("unlocked rows expose a Start action and announce one status", () => {
    useCurriculumStore
      .getState()
      .setConcepts([concept({ id: "alg_001", title: "Real Numbers" })]);
    renderList();
    const row = screen.getByRole("listitem");
    expect(
      within(row).getByRole("button", { name: "Start" }),
    ).toBeInTheDocument();
    expect(announcedText(row).match(/Available/g)).toHaveLength(1);
  });
});
