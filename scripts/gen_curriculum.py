#!/usr/bin/env python3
"""Generate the 12 bundled curriculum domain JSON files (Appendix D).

Run from repo root:  python3 scripts/gen_curriculum.py
Output: src-tauri/src/curriculum/data/<domain>.json

The output is DAG-valid by construction:
- ids match ^[a-z]{2,4}_[0-9]{3}$ (prefix + zero-padded 3-digit counter)
- within a module, each concept depends on the previous one
- the first concept of a module depends on the last concept of the previous
  module in the same domain
- each domain's first concept depends on a real "anchor" concept from one of its
  prerequisite domains (cross-domain edge); Linear Algebra and Differential
  Equations both anchor on Single-Variable Calculus so they progress in PARALLEL
- light bridge concepts are inserted at jarring transitions
All edges point from earlier ids to later ids, so no cycle is possible.
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "src-tauri", "src", "curriculum", "data")

# A small bank of error-pattern fragments to compose snake_case patterns from.
EP = [
    "sign_error_in_manipulation",
    "confuses_definition_with_example",
    "drops_units_in_calculation",
    "misapplies_a_rule_out_of_domain",
    "off_by_one_in_indexing",
    "forgets_boundary_conditions",
    "swaps_dependent_and_independent_variables",
    "ignores_domain_restrictions",
    "confuses_necessary_and_sufficient",
    "memorizes_without_understanding",
]


def errs(seed):
    return [EP[(seed + k) % len(EP)] for k in range(3 + (seed % 2))]


def objs(title):
    return [
        f"State the precise definition behind {title}",
        f"Apply {title} to standard worked problems",
        f"Connect {title} to its prerequisite ideas and recognize when it applies",
    ]


# (domain, display_name, phase, prefix, prereq_anchor_id_or_None, modules)
# Each module is (module_title, [concept_title, ...]).
# Counts are tuned to total ~420 across all domains (Appendix D.2).

def m(title, concepts):
    return (title, concepts)


def topics(prefix, n):
    # generic filler topic titles when we need to reach a target count
    return [f"{prefix} Topic {i+1}" for i in range(n)]


DOMAINS = []

# ---- Phase 1 ----
DOMAINS.append(dict(
    domain="algebra", display_name="Algebra", phase=1, prefix="alg",
    description="Foundations of algebra: numbers, expressions, equations, functions.",
    prereqs=[], anchor=None,
    modules=[
        m("Numbers and Operations", ["Real Number System", "Integer Operations", "Fractions and Decimals", "Exponents and Powers", "Order of Operations", "Absolute Value", "Number Properties", "Scientific Notation"]),
        m("Expressions", ["Variables and Terms", "Combining Like Terms", "Distributive Property", "Evaluating Expressions", "Polynomial Basics", "Factoring Common Terms", "Factoring Trinomials", "Special Products"]),
        m("Linear Equations", ["One-Step Equations", "Two-Step Equations", "Multi-Step Equations", "Equations with Variables Both Sides", "Literal Equations", "Linear Inequalities", "Compound Inequalities", "Absolute Value Equations"]),
        m("Functions and Graphs", ["Coordinate Plane", "Slope of a Line", "Slope-Intercept Form", "Point-Slope Form", "Graphing Linear Functions", "Function Notation", "Domain and Range", "Systems of Linear Equations"]),
        m("Quadratics and Beyond", ["Quadratic Expressions", "Solving by Factoring", "Completing the Square", "Quadratic Formula", "The Discriminant", "Graphing Parabolas", "Exponential Expressions", "Rational Expressions"]),
        m("Advanced Algebra", ["Radical Expressions", "Rational Exponents", "Logarithm Basics", "Properties of Logarithms", "Sequences", "Series and Summation", "Function Composition", "Inverse Functions"]),
        m("Synthesis", ["Word Problems and Modeling", "Systems with Three Variables", "Matrices Introduction", "Determinants Introduction", "Binomial Theorem", "Mathematical Induction", "Complex Numbers Introduction", "Algebra Capstone"]),
    ],
))

DOMAINS.append(dict(
    domain="trigonometry", display_name="Trigonometry", phase=1, prefix="trig",
    description="Angles, triangles, the unit circle, and periodic functions.",
    prereqs=["algebra"], anchor="alg_001",
    modules=[
        m("Angles and Triangles", ["Angle Measure and Degrees", "Radian Measure", "Right Triangle Ratios", "The Pythagorean Theorem", "Special Right Triangles", "Solving Right Triangles", "Angles of Elevation and Depression"]),
        m("The Unit Circle", ["Unit Circle Definition", "Sine and Cosine", "Tangent and Reciprocals", "Reference Angles", "Coterminal Angles", "Signs Across Quadrants", "Exact Values"]),
        m("Trigonometric Functions", ["Graphing Sine and Cosine", "Amplitude and Period", "Phase Shift", "Graphing Tangent", "Inverse Trig Functions", "Domain and Range of Inverses", "Modeling Periodic Phenomena"]),
        m("Identities and Equations", ["Pythagorean Identities", "Sum and Difference Formulas", "Double Angle Formulas", "Law of Sines", "Law of Cosines", "Solving Trig Equations", "Trig Capstone"]),
    ],
))

DOMAINS.append(dict(
    domain="precalculus", display_name="Pre-Calculus", phase=1, prefix="prec",
    description="Bridge from algebra and trig to calculus: limits and analysis.",
    prereqs=["algebra", "trigonometry"], anchor="trig_001",
    modules=[
        m("Functions Deep Dive", ["Function Transformations", "Piecewise Functions", "Even and Odd Functions", "Polynomial Functions", "Rational Functions and Asymptotes", "Exponential Functions", "Logarithmic Functions"]),
        m("Analytic Geometry", ["Conic Sections Overview", "Circles and Ellipses", "Parabolas and Hyperbolas", "Parametric Equations", "Polar Coordinates", "Vectors in the Plane"]),
        m("Toward Calculus", ["Sequences and Limits Intuition", "Limit of a Function (Informal)", "One-Sided Limits", "Continuity Intuition", "Rates of Change", "Bridge: Precalc Limits to Epsilon-Delta", "Tangent Line Problem", "Area Problem Preview", "Infinite Series Preview", "Precalculus Capstone", "Binomial and Combinatorics Preview", "Mathematical Modeling Review"]),
    ],
))

# ---- Phase 2 ----
DOMAINS.append(dict(
    domain="single_variable_calculus", display_name="Single-Variable Calculus", phase=2, prefix="svc",
    description="Limits, derivatives, integrals of single-variable functions.",
    prereqs=["precalculus"], anchor="prec_001",
    modules=[
        m("Limits and Continuity", ["Epsilon-Delta Definition", "Limit Laws", "Limits at Infinity", "Indeterminate Forms", "Squeeze Theorem", "Continuity and Discontinuities", "Intermediate Value Theorem"]),
        m("Derivatives", ["Definition of the Derivative", "Power Rule", "Product Rule", "Quotient Rule", "Chain Rule", "Implicit Differentiation", "Derivatives of Trig Functions", "Derivatives of Exp and Log"]),
        m("Applications of Derivatives", ["Related Rates", "Linear Approximation", "Extrema and Critical Points", "Mean Value Theorem", "First Derivative Test", "Concavity and Inflection", "Optimization Problems", "L'Hopital's Rule"]),
        m("Integration", ["Antiderivatives", "Riemann Sums", "Definite Integral", "Fundamental Theorem of Calculus", "u-Substitution", "Integration by Parts", "Trigonometric Integrals", "Partial Fractions"]),
        m("Applications of Integration", ["Area Between Curves", "Volumes of Revolution", "Arc Length", "Average Value", "Improper Integrals", "Sequences", "Convergence Tests", "Taylor and Maclaurin Series", "Power Series", "Numerical Integration", "Differential Equations Preview", "SVC Capstone"]),
    ],
))

DOMAINS.append(dict(
    domain="multivariable_calculus", display_name="Multivariable Calculus", phase=2, prefix="mvc",
    description="Calculus of several variables: partial derivatives and multiple integrals.",
    prereqs=["single_variable_calculus"], anchor="svc_001",
    modules=[
        m("Vectors and Geometry of Space", ["Vectors in Three Dimensions", "Dot Product", "Cross Product", "Lines and Planes", "Cylinders and Quadric Surfaces", "Vector-Valued Functions", "Arc Length in Space"]),
        m("Partial Derivatives", ["Functions of Several Variables", "Limits and Continuity in Higher Dimensions", "Partial Derivatives", "The Chain Rule (Multivariable)", "Directional Derivatives", "The Gradient", "Tangent Planes", "Extrema of Multivariable Functions", "Lagrange Multipliers"]),
        m("Multiple Integrals", ["Double Integrals", "Double Integrals in Polar Coordinates", "Triple Integrals", "Cylindrical Coordinates", "Spherical Coordinates", "Change of Variables and Jacobians", "Applications of Multiple Integrals"]),
        m("Vector Calculus", ["Vector Fields", "Line Integrals", "The Fundamental Theorem for Line Integrals", "Green's Theorem", "Curl and Divergence", "Surface Integrals", "Stokes' Theorem", "The Divergence Theorem", "MVC Capstone", "Bridge: Error Propagation in Measurements"]),
    ],
))

DOMAINS.append(dict(
    domain="linear_algebra", display_name="Linear Algebra", phase=2, prefix="lin",
    description="Vector spaces, matrices, eigenvalues, and linear transformations.",
    prereqs=["single_variable_calculus"], anchor="svc_001",
    modules=[
        m("Linear Systems", ["Systems of Linear Equations", "Row Reduction and Echelon Forms", "Vector Equations", "The Matrix Equation Ax=b", "Solution Sets of Linear Systems", "Linear Independence", "Linear Transformations Intro"]),
        m("Matrix Algebra", ["Matrix Operations", "The Inverse of a Matrix", "Characterizations of Invertible Matrices", "Partitioned Matrices", "Matrix Factorizations (LU)", "Subspaces of R^n", "Dimension and Rank"]),
        m("Determinants and Spaces", ["Introduction to Determinants", "Properties of Determinants", "Cramer's Rule", "Vector Spaces and Subspaces", "Null Spaces and Column Spaces", "Basis and Coordinate Systems", "Change of Basis"]),
        m("Eigenvalues and Applications", ["Eigenvalues and Eigenvectors", "The Characteristic Equation", "Diagonalization", "Inner Product and Orthogonality", "Orthogonal Projections", "Gram-Schmidt Process", "Symmetric Matrices and SVD", "Linear Algebra Capstone", "Bridge: Vectors as Data Representations"]),
    ],
))

DOMAINS.append(dict(
    domain="differential_equations", display_name="Differential Equations", phase=2, prefix="de",
    description="Ordinary differential equations and their solution methods.",
    prereqs=["single_variable_calculus"], anchor="svc_001",
    modules=[
        m("First-Order ODEs", ["Introduction to Differential Equations", "Separable Equations", "Linear First-Order Equations", "Exact Equations", "Integrating Factors", "Autonomous Equations and Stability", "Euler's Method"]),
        m("Higher-Order Linear ODEs", ["Second-Order Linear Equations", "Homogeneous Equations with Constant Coefficients", "Method of Undetermined Coefficients", "Variation of Parameters", "Mechanical and Electrical Vibrations", "Resonance Phenomena"]),
        m("Transforms and Systems", ["The Laplace Transform", "Inverse Laplace Transforms", "Solving IVPs with Laplace", "Step and Impulse Functions", "Systems of First-Order Equations", "Phase Plane Analysis"]),
        m("Series and Advanced", ["Series Solutions of ODEs", "Regular Singular Points", "Fourier Series", "Partial Differential Equations Intro", "The Heat Equation", "Boundary Value Problems", "Differential Equations Capstone", "Bridge: Stochastic Differential Equations Preview"]),
    ],
))

# ---- Phase 3 ----
DOMAINS.append(dict(
    domain="classical_mechanics", display_name="Classical Mechanics", phase=3, prefix="cm",
    description="Newtonian, Lagrangian, and Hamiltonian mechanics.",
    prereqs=["multivariable_calculus", "differential_equations", "linear_algebra"], anchor="mvc_001",
    modules=[
        m("Kinematics and Newton's Laws", ["Position, Velocity, Acceleration", "Newton's Laws of Motion", "Free-Body Diagrams", "Friction and Drag", "Projectile Motion", "Uniform Circular Motion", "Reference Frames"]),
        m("Energy and Momentum", ["Work and Kinetic Energy", "Potential Energy and Conservation", "Power", "Linear Momentum", "Collisions", "Center of Mass", "Systems of Particles"]),
        m("Rotational Dynamics", ["Angular Kinematics", "Torque", "Moment of Inertia", "Angular Momentum", "Rolling Motion", "Gyroscopic Motion", "Static Equilibrium"]),
        m("Advanced Formulations", ["Oscillations and SHM", "Damped and Driven Oscillations", "Central Force Motion", "Kepler's Laws", "Lagrangian Mechanics", "The Euler-Lagrange Equation", "Hamiltonian Mechanics", "Normal Modes", "Coupled Oscillators", "Noether's Theorem", "Chaos and Nonlinear Dynamics", "Classical Mechanics Capstone"]),
    ],
))

DOMAINS.append(dict(
    domain="electromagnetism", display_name="Electromagnetism", phase=3, prefix="em",
    description="Electric and magnetic fields, Maxwell's equations, and waves.",
    prereqs=["multivariable_calculus", "differential_equations", "linear_algebra"], anchor="mvc_001",
    modules=[
        m("Electrostatics", ["Electric Charge and Coulomb's Law", "The Electric Field", "Electric Flux and Gauss's Law", "Electric Potential", "Capacitance", "Dielectrics", "Energy in Electric Fields"]),
        m("Currents and Magnetism", ["Electric Current and Resistance", "DC Circuits and Kirchhoff's Laws", "The Magnetic Field", "Magnetic Force on Currents", "The Biot-Savart Law", "Ampere's Law"]),
        m("Induction and Maxwell", ["Faraday's Law of Induction", "Inductance", "RL and RC Transients", "Maxwell's Equations", "The Displacement Current", "AC Circuits"]),
        m("Waves and Radiation", ["Electromagnetic Waves", "The Poynting Vector", "Polarization", "Reflection and Refraction", "Waveguides", "Radiation from Accelerating Charges", "Electromagnetism Capstone"]),
    ],
))

DOMAINS.append(dict(
    domain="thermodynamics", display_name="Thermodynamics & Statistical Mechanics", phase=3, prefix="thm",
    description="Heat, entropy, and the statistical basis of thermodynamics.",
    prereqs=["multivariable_calculus", "differential_equations", "linear_algebra"], anchor="mvc_001",
    modules=[
        m("Classical Thermodynamics", ["Temperature and the Zeroth Law", "Heat and the First Law", "Work in Thermodynamic Processes", "Ideal Gas Law", "Heat Capacity", "Thermodynamic Processes"]),
        m("Entropy and the Second Law", ["The Second Law", "Entropy", "The Carnot Cycle", "Refrigerators and Heat Pumps", "Thermodynamic Potentials", "Maxwell Relations"]),
        m("Statistical Mechanics", ["Microstates and Macrostates", "The Boltzmann Distribution", "Bridge: Maxwell-Boltzmann Speed Distribution", "The Partition Function", "Equipartition Theorem", "Quantum Statistics Preview"]),
        m("Applications", ["Phase Transitions", "Real Gases and van der Waals", "Bridge: Fluctuations and Error Analysis", "Thermodynamics Capstone", "Blackbody Radiation Preview"]),
    ],
))

DOMAINS.append(dict(
    domain="quantum_mechanics", display_name="Quantum Mechanics", phase=3, prefix="qm",
    description="Wavefunctions, operators, and the Schrodinger equation.",
    prereqs=["multivariable_calculus", "differential_equations", "linear_algebra"], anchor="lin_001",
    modules=[
        m("Foundations", ["The Photoelectric Effect", "Wave-Particle Duality", "The de Broglie Hypothesis", "The Uncertainty Principle", "The Wavefunction", "Probability and Normalization", "Bridge: Probability Amplitudes and Statistics"]),
        m("The Schrodinger Equation", ["The Time-Dependent Schrodinger Equation", "The Time-Independent Schrodinger Equation", "The Infinite Square Well", "The Finite Square Well", "Quantum Tunneling", "The Harmonic Oscillator"]),
        m("Formalism", ["Operators and Observables", "Eigenvalues and Expectation Values", "Hermitian Operators", "Commutators", "Dirac Notation", "Hilbert Spaces"]),
        m("Three Dimensions and Spin", ["The Hydrogen Atom", "Angular Momentum", "Spherical Harmonics", "Electron Spin", "The Pauli Exclusion Principle", "Identical Particles", "Perturbation Theory", "The Variational Method", "Quantum Mechanics Capstone", "Multi-Electron Atoms", "Entanglement Basics", "Quantum Measurement"]),
    ],
))

# ---- Phase 4 ----
DOMAINS.append(dict(
    domain="astrophysics", display_name="Astrophysics", phase=4, prefix="astr",
    description="Stars, galaxies, cosmology, and the physics of the universe.",
    prereqs=["classical_mechanics", "electromagnetism", "thermodynamics", "quantum_mechanics"], anchor="cm_001",
    modules=[
        m("Observational Foundations", ["Celestial Coordinates", "The Magnitude System", "Parallax and Distance", "Telescopes and Detectors", "Spectroscopy in Astronomy", "Bridge: Statistical Error in Observations", "Blackbody Radiation and Stars", "The Doppler Effect in Astronomy"]),
        m("Stellar Physics", ["Stellar Spectra and Classification", "The Hertzsprung-Russell Diagram", "Hydrostatic Equilibrium", "Energy Transport in Stars", "Nuclear Fusion in Stars", "Stellar Structure Equations", "Main Sequence Lifetimes", "Stellar Nucleosynthesis"]),
        m("Stellar Evolution and Remnants", ["Star Formation", "Post-Main-Sequence Evolution", "White Dwarfs", "The Chandrasekhar Limit", "Supernovae", "Neutron Stars and Pulsars", "Black Holes", "Accretion Disks", "Gravitational Waves"]),
        m("Galaxies and the Interstellar Medium", ["The Interstellar Medium", "The Milky Way Structure", "Galaxy Classification", "Galactic Rotation and Dark Matter", "Active Galactic Nuclei", "Galaxy Clusters", "Galaxy Formation and Evolution"]),
        m("Cosmology", ["The Expanding Universe", "Hubble's Law", "The Cosmic Microwave Background", "Big Bang Nucleosynthesis", "The Friedmann Equations", "Dark Energy and Acceleration", "Inflation", "Large-Scale Structure", "The Fate of the Universe", "General Relativity Primer", "Cosmological Parameters", "Astrophysics Capstone", "Exoplanets and Habitability", "Multimessenger Astronomy", "Astrophysics Synthesis"]),
    ],
))


def gen():
    os.makedirs(OUT, exist_ok=True)
    total = 0
    # map domain -> first concept id, for cross-domain anchors already set by id
    for d in DOMAINS:
        prefix = d["prefix"]
        counter = 0
        modules_out = []
        prev_concept_id = None  # last concept id in previous module (same domain)
        first_concept_id = None
        for order, (mtitle, ctitles) in enumerate(d["modules"], start=1):
            mid = f"{prefix}_m{order:02d}"
            concepts_out = []
            prev_in_module = None
            for ci, title in enumerate(ctitles):
                counter += 1
                cid = f"{prefix}_{counter:03d}"
                prereqs = []
                if prev_in_module is not None:
                    prereqs.append(prev_in_module)
                elif prev_concept_id is not None:
                    # first concept of a non-first module: chain to prior module
                    prereqs.append(prev_concept_id)
                elif d["anchor"] is not None:
                    # first concept of the domain: cross-domain anchor edge
                    prereqs.append(d["anchor"])
                tier = min(5, max(1, 1 + (counter - 1) * 5 // max(1, len(ctitles) * len(d["modules"]))))
                concepts_out.append({
                    "id": cid,
                    "title": title,
                    "prerequisites": prereqs,
                    "learning_objectives": objs(title),
                    "error_patterns": errs(counter),
                    "difficulty_tier": tier,
                })
                if first_concept_id is None:
                    first_concept_id = cid
                prev_in_module = cid
            prev_concept_id = prev_in_module
            modules_out.append({"id": mid, "title": mtitle, "order": order, "concepts": concepts_out})
        out = {
            "domain": d["domain"],
            "display_name": d["display_name"],
            "phase": d["phase"],
            "description": d["description"],
            "prerequisites": d["prereqs"],
            "modules": modules_out,
        }
        path = os.path.join(OUT, f"{d['domain']}.json")
        with open(path, "w") as f:
            json.dump(out, f, indent=2)
            f.write("\n")
        total += counter
        print(f"{d['domain']:32s} {counter:4d} concepts -> {os.path.relpath(path)}")
    print(f"TOTAL: {total} concepts across {len(DOMAINS)} domains")


if __name__ == "__main__":
    gen()
