//! Curriculum bundling, loading, and DAG validation (Appendix D, blocklist #49).
//!
//! The 12 domain JSON files (Algebra → Astrophysics, ~420 concepts) are bundled
//! as build-time resources via `include_str!`. On first launch (and on a
//! version bump) the loader validates the whole graph and writes every concept
//! — INCLUDING learning_objectives, error_patterns, and difficulty_tier (v1
//! dropped these; the prompt builder depends on them) — into the `concepts`
//! table.
//!
//! DAG validation hard-fails on: a concept id not matching `^[a-z]{2,4}_[0-9]{3}$`,
//! a duplicate id, a prerequisite that resolves to no concept (including
//! cross-domain), or a cycle (topological sort must succeed).
//!
//! The graph is DATA ONLY — no runtime graph library, no d3 (#49). The M4
//! dashboard renders a static build-time SVG.

use std::collections::{HashMap, HashSet, VecDeque};

use rusqlite::{params, Connection};
use serde::Deserialize;

use crate::validate::is_valid_concept_id;

/// Bump when the bundled curriculum content changes so the loader re-imports.
pub const CURRICULUM_VERSION: i64 = 1;

/// The 12 bundled domain files (Appendix D.2 ordering by phase).
const DOMAIN_FILES: &[&str] = &[
    include_str!("data/algebra.json"),
    include_str!("data/trigonometry.json"),
    include_str!("data/precalculus.json"),
    include_str!("data/single_variable_calculus.json"),
    include_str!("data/multivariable_calculus.json"),
    include_str!("data/linear_algebra.json"),
    include_str!("data/differential_equations.json"),
    include_str!("data/classical_mechanics.json"),
    include_str!("data/electromagnetism.json"),
    include_str!("data/thermodynamics.json"),
    include_str!("data/quantum_mechanics.json"),
    include_str!("data/astrophysics.json"),
];

#[derive(Debug, Deserialize)]
pub struct DomainFile {
    pub domain: String,
    #[allow(dead_code)]
    pub display_name: String,
    #[allow(dead_code)]
    pub phase: i64,
    pub modules: Vec<Module>,
}

#[derive(Debug, Deserialize)]
pub struct Module {
    pub id: String,
    #[allow(dead_code)]
    pub title: String,
    pub concepts: Vec<RawConcept>,
}

#[derive(Debug, Deserialize)]
pub struct RawConcept {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub prerequisites: Vec<String>,
    pub learning_objectives: Vec<String>,
    pub error_patterns: Vec<String>,
    pub difficulty_tier: i64,
}

/// A fully resolved concept ready to persist (carries its domain + module id).
#[derive(Debug, Clone)]
pub struct LoadedConcept {
    pub id: String,
    pub domain: String,
    pub module: String,
    pub title: String,
    pub prerequisites: Vec<String>,
    pub learning_objectives: Vec<String>,
    pub error_patterns: Vec<String>,
    pub difficulty_tier: i64,
}

/// Parse all bundled domain files into a flat concept list.
pub fn parse_bundled() -> Result<Vec<LoadedConcept>, String> {
    let mut out = Vec::new();
    for raw in DOMAIN_FILES {
        let domain: DomainFile =
            serde_json::from_str(raw).map_err(|e| format!("curriculum JSON parse error: {e}"))?;
        for module in &domain.modules {
            for c in &module.concepts {
                out.push(LoadedConcept {
                    id: c.id.clone(),
                    domain: domain.domain.clone(),
                    module: module.id.clone(),
                    title: c.title.clone(),
                    prerequisites: c.prerequisites.clone(),
                    learning_objectives: c.learning_objectives.clone(),
                    error_patterns: c.error_patterns.clone(),
                    difficulty_tier: c.difficulty_tier,
                });
            }
        }
    }
    Ok(out)
}

/// Validate the curriculum graph (Appendix D.4). Hard-fails with a clear error.
pub fn validate(concepts: &[LoadedConcept]) -> Result<(), String> {
    // 1) Unique ids that match the required pattern; collect per-concept fields.
    let mut ids: HashSet<&str> = HashSet::with_capacity(concepts.len());
    for c in concepts {
        if !is_valid_concept_id(&c.id) {
            return Err(format!(
                "concept id {:?} does not match ^[a-z]{{2,4}}_[0-9]{{3}}$",
                c.id
            ));
        }
        if !ids.insert(c.id.as_str()) {
            return Err(format!("duplicate concept id: {}", c.id));
        }
        if c.learning_objectives.is_empty() {
            return Err(format!("concept {} has no learning_objectives", c.id));
        }
        if c.error_patterns.is_empty() {
            return Err(format!("concept {} has no error_patterns", c.id));
        }
        if !(1..=5).contains(&c.difficulty_tier) {
            return Err(format!(
                "concept {} difficulty_tier {} out of 1..=5",
                c.id, c.difficulty_tier
            ));
        }
    }

    // 2) Every prerequisite resolves to a real concept (including cross-domain).
    for c in concepts {
        for p in &c.prerequisites {
            if !ids.contains(p.as_str()) {
                return Err(format!(
                    "concept {} has dangling prerequisite {:?}",
                    c.id, p
                ));
            }
        }
    }

    // 3) No cycles — Kahn topological sort must consume every node.
    topo_sort_ok(concepts)
}

/// Kahn's algorithm: succeed only if all nodes are ordered (no cycle).
fn topo_sort_ok(concepts: &[LoadedConcept]) -> Result<(), String> {
    // edge: prerequisite -> dependent. in_degree counts prerequisites.
    let mut in_degree: HashMap<&str, usize> = HashMap::with_capacity(concepts.len());
    let mut dependents: HashMap<&str, Vec<&str>> = HashMap::new();
    for c in concepts {
        in_degree.entry(c.id.as_str()).or_insert(0);
        for p in &c.prerequisites {
            *in_degree.entry(c.id.as_str()).or_insert(0) += 1;
            dependents
                .entry(p.as_str())
                .or_default()
                .push(c.id.as_str());
        }
    }

    let mut queue: VecDeque<&str> = in_degree
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(&id, _)| id)
        .collect();

    let mut visited = 0usize;
    while let Some(id) = queue.pop_front() {
        visited += 1;
        if let Some(deps) = dependents.get(id) {
            for &d in deps {
                let e = in_degree.get_mut(d).unwrap();
                *e -= 1;
                if *e == 0 {
                    queue.push_back(d);
                }
            }
        }
    }

    if visited != concepts.len() {
        return Err(format!(
            "curriculum contains a cycle ({} of {} concepts orderable)",
            visited,
            concepts.len()
        ));
    }
    Ok(())
}

/// Load the bundled curriculum into the `concepts` table if not already loaded
/// at the current `CURRICULUM_VERSION`. Validates before writing — a validation
/// failure aborts the load (and is fatal at startup). Idempotent across runs.
pub fn load_into_db(conn: &Connection) -> Result<usize, String> {
    let loaded_version: Option<i64> = crate::settings::get_curriculum_version(conn)?;
    if loaded_version == Some(CURRICULUM_VERSION) {
        return Ok(0);
    }

    let concepts = parse_bundled()?;
    validate(&concepts)?;

    let count = upsert_concepts(conn, &concepts)?;
    crate::settings::set_curriculum_version(conn, CURRICULUM_VERSION)?;
    tracing::info!(count, version = CURRICULUM_VERSION, "curriculum loaded");
    Ok(count)
}

/// Upsert concept rows. Preserves a learner's progress columns (mastery_score,
/// ease_factor, etc.) on re-import — only the authored curriculum fields are
/// overwritten.
fn upsert_concepts(conn: &Connection, concepts: &[LoadedConcept]) -> Result<usize, String> {
    let json = |v: &[String]| serde_json::to_string(v).unwrap_or_else(|_| "[]".into());
    let mut n = 0;
    for c in concepts {
        conn.execute(
            "INSERT INTO concepts \
               (id, domain, module, title, prerequisites, learning_objectives, \
                difficulty_tier, error_patterns) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
             ON CONFLICT(id) DO UPDATE SET \
               domain = excluded.domain, module = excluded.module, title = excluded.title, \
               prerequisites = excluded.prerequisites, \
               learning_objectives = excluded.learning_objectives, \
               difficulty_tier = excluded.difficulty_tier, \
               error_patterns = excluded.error_patterns",
            params![
                c.id,
                c.domain,
                c.module,
                c.title,
                json(&c.prerequisites),
                json(&c.learning_objectives),
                c.difficulty_tier,
                json(&c.error_patterns),
            ],
        )
        .map_err(|e| format!("upsert concept {}: {e}", c.id))?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn concept(id: &str, prereqs: &[&str]) -> LoadedConcept {
        LoadedConcept {
            id: id.into(),
            domain: "algebra".into(),
            module: "alg_m01".into(),
            title: "T".into(),
            prerequisites: prereqs.iter().map(|s| s.to_string()).collect(),
            learning_objectives: vec!["o1".into(), "o2".into(), "o3".into()],
            error_patterns: vec!["e1".into(), "e2".into(), "e3".into()],
            difficulty_tier: 1,
        }
    }

    /// Required test: DAG validation rejects a cycle.
    #[test]
    fn rejects_cycle() {
        let c = vec![
            concept("alg_001", &["alg_002"]),
            concept("alg_002", &["alg_001"]),
        ];
        let err = validate(&c).unwrap_err();
        assert!(err.contains("cycle"), "got: {err}");
    }

    /// Required test: DAG validation rejects a dangling prerequisite.
    #[test]
    fn rejects_dangling_prerequisite() {
        let c = vec![concept("alg_001", &["alg_999"])];
        let err = validate(&c).unwrap_err();
        assert!(err.contains("dangling prerequisite"), "got: {err}");
    }

    #[test]
    fn accepts_valid_dag() {
        let c = vec![
            concept("alg_001", &[]),
            concept("alg_002", &["alg_001"]),
            concept("alg_003", &["alg_001", "alg_002"]),
        ];
        assert!(validate(&c).is_ok());
    }

    /// The bundled curriculum itself must be valid (~420 concepts, DAG-valid,
    /// all carry objectives/error_patterns/tier). This is the real acceptance
    /// guard, run against real data.
    #[test]
    fn bundled_curriculum_is_valid() {
        let concepts = parse_bundled().expect("parse bundled domains");
        validate(&concepts).expect("bundled curriculum must be DAG-valid");
        assert!(
            (380..=460).contains(&concepts.len()),
            "expected ~420 concepts, got {}",
            concepts.len()
        );
    }
}
