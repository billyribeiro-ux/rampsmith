//! The list of schemas `gen-schemas` writes.

use schemars::{Schema, schema_for};

use crate::job::{JobError, ScanPage, ShopifyTokenRefresh};
use crate::problem::Problem;

/// A JSON Schema and the file stem it is written under.
#[derive(Debug)]
pub struct NamedSchema {
    /// Kebab-case file stem: `<name>.schema.json`.
    pub name: &'static str,
    /// The generated JSON Schema (draft 2020-12).
    pub schema: Schema,
}

/// Every contract schema, sorted by name.
#[must_use]
pub fn schemas() -> Vec<NamedSchema> {
    vec![
        NamedSchema {
            name: "job-error",
            schema: schema_for!(JobError),
        },
        NamedSchema {
            name: "problem",
            schema: schema_for!(Problem),
        },
        NamedSchema {
            name: "scan-page",
            schema: schema_for!(ScanPage),
        },
        NamedSchema {
            name: "shopify-token-refresh",
            schema: schema_for!(ShopifyTokenRefresh),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_unique_kebab_case_and_sorted() {
        let names: Vec<&str> = schemas().iter().map(|s| s.name).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(names, sorted);
        for name in names {
            assert!(
                name.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
                "{name}"
            );
        }
    }

    #[test]
    fn the_problem_schema_requires_the_rfc_members_and_the_code() {
        let problem = schemas().into_iter().find(|s| s.name == "problem").unwrap();
        let value = serde_json::to_value(&problem.schema).unwrap();
        let required: Vec<&str> = value["required"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        for member in ["type", "title", "status", "code"] {
            assert!(
                required.contains(&member),
                "{member} missing from {required:?}"
            );
        }
    }
}
