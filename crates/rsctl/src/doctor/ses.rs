//! C row 7: Amazon SES (ADR-152). The probe never sends mail.
//!
//! `GET /v2/email/account` says whether the account is out of the sandbox
//! (`ProductionAccessEnabled`) and may send (`SendingEnabled`). `GET /v2/email/identities/{id}`
//! says whether the sending identity is verified (`VerifiedForSendingStatus`); the domain of
//! `EMAIL_FROM` is tried first, then the exact address. Both are `SigV4`-signed for service `ses`
//! and need the read permissions `ses:GetAccount` and `ses:GetEmailIdentity`.

use reqwest::Method;
use serde::Deserialize;

use super::common::{AwsScope, Step, aws_request, gather, send};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::sigv4::{Credentials, PathMode};
use crate::util::{safe_token, uri_encode};
use crate::vars::Var;

pub(super) const READS: &[Var] = &[
    Var::SesRegion,
    Var::SesAccessKeyId,
    Var::SesSecretAccessKey,
    Var::EmailFrom,
    // Read when set: the sender needs it for marketing mail only (CAN-SPAM, ADR-191).
    Var::EmailPostalAddress,
    // Read when set: the configuration set and the SNS topic that carry bounces and complaints
    // back to the api (ADR-278). Checked for shape only.
    Var::SesConfigurationSet,
    Var::SesSnsTopicArn,
];

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Account {
    #[serde(default)]
    production_access_enabled: bool,
    #[serde(default = "yes")]
    sending_enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Identity {
    #[serde(default)]
    verified_for_sending_status: bool,
    verification_status: Option<String>,
}

const fn yes() -> bool {
    true
}

pub(super) fn run(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { probe(ctx).await.unwrap_or_else(|outcome| outcome) })
}

/// The address in `EMAIL_FROM`, which may be `name@example.com` or `Name <name@example.com>`.
fn address(from: &str) -> Option<&str> {
    let candidate = match (from.rfind('<'), from.rfind('>')) {
        (Some(open), Some(close)) if open < close => from.get(open + 1..close)?,
        _ => from,
    }
    .trim();
    let (local, domain) = candidate.split_once('@')?;
    // Plain address characters only: the address is printed, so it must not be able to carry
    // anything else (SES identities are domains and ordinary addresses).
    let valid = !local.is_empty()
        && domain.contains('.')
        && !domain.contains('@')
        && candidate.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'+' | b'%' | b'@')
        });
    valid.then_some(candidate)
}

fn region_ok(region: &str) -> bool {
    !region.is_empty()
        && region.len() <= 20
        && region
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A fixed-text reading of an AWS error, from `x-amzn-ErrorType` (`Name:http://...`).
fn aws_error(reply: &crate::http::Reply) -> Option<String> {
    reply
        .header("x-amzn-errortype")
        .map(|value| safe_token(value.split(':').next().unwrap_or_default()))
        .filter(|name| !name.is_empty())
}

fn failure(what: &str, reply: &crate::http::Reply) -> Outcome {
    let code = aws_error(reply);
    let meaning = match (reply.status, code.as_deref()) {
        (_, Some("AccessDeniedException")) => {
            "; the IAM user needs the read permissions ses:GetAccount and ses:GetEmailIdentity (the doctor never sends)"
        }
        (
            _,
            Some(
                "UnrecognizedClientException"
                | "InvalidSignatureException"
                | "SignatureDoesNotMatch",
            ),
        )
        | (401 | 403, _) => {
            "; AWS rejected the access key (check SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY and SES_REGION)"
        }
        _ => "",
    };
    Outcome::fail(format!(
        "{what} failed: HTTP {}{}{meaning}",
        reply.status,
        code.map_or_else(String::new, |code| format!(" {code}"))
    ))
}

/// What every SES request needs.
struct Session<'a> {
    ctx: &'a Ctx,
    origin: String,
    region: &'a str,
    credentials: Credentials,
}

impl Session<'_> {
    /// A signed `GET` of `path` (already encoded), or the reply that was not a success.
    async fn get(&self, path: &str) -> Step<crate::http::Reply> {
        let scope = AwsScope {
            region: self.region,
            service: "ses",
            mode: PathMode::Standard,
            content_sha256: false,
        };
        let builder = aws_request(
            self.ctx,
            Method::GET,
            &format!("{}{path}", self.origin),
            &self.credentials,
            scope,
            &[],
        )?;
        send(self.ctx, "Amazon SES", builder).await
    }

    /// Out of the sandbox, and allowed to send.
    async fn account(&self) -> Step<()> {
        let reply = self.get("/v2/email/account").await?;
        if !reply.is_success() {
            return Err(failure("GET /v2/email/account", &reply));
        }
        let Some(account) = reply.json::<Account>() else {
            return Err(Outcome::fail(
                "GET /v2/email/account answered 200 but not with the documented account object",
            ));
        };
        if !account.production_access_enabled {
            return Err(Outcome::fail(format!(
                "the SES account is still in the sandbox in {}; request production access",
                self.region
            )));
        }
        if !account.sending_enabled {
            return Err(Outcome::fail(format!(
                "sending is paused on the SES account in {}",
                self.region
            )));
        }
        Ok(())
    }

    /// The sending identity: the domain first, then the exact address.
    async fn identity(&self, domain: &str, address: &str) -> Step<Outcome> {
        let mut seen = Vec::new();
        for identity in [domain, address] {
            let reply = self
                .get(&format!(
                    "/v2/email/identities/{}",
                    uri_encode(identity, true)
                ))
                .await?;
            if reply.status == 404 {
                seen.push(identity.to_owned());
                continue;
            }
            if !reply.is_success() {
                return Err(failure("GET /v2/email/identities", &reply));
            }
            let Some(found) = reply.json::<Identity>() else {
                return Err(Outcome::fail(
                    "GET /v2/email/identities answered 200 but not with the documented identity object",
                ));
            };
            return Ok(if found.verified_for_sending_status {
                Outcome::pass(format!(
                    "out of the sandbox in {}; identity {} is verified for sending",
                    self.region, identity
                ))
            } else {
                Outcome::fail(format!(
                    "identity {identity} exists but is not verified for sending (status {})",
                    found
                        .verification_status
                        .as_deref()
                        .map_or_else(|| "unknown".to_owned(), safe_token)
                ))
            });
        }
        Ok(Outcome::fail(format!(
            "SES in {} has no identity for {}; verify the domain (or the address) in SES",
            self.region,
            seen.join(" or ")
        )))
    }
}

/// Longest postal address the sender accepts (`packages/email`, `settings.ts`).
const MAX_POSTAL_ADDRESS: usize = 300;

/// What is wrong with `EMAIL_POSTAL_ADDRESS`, when it is set. Unset is not a fault: only marketing
/// mail needs it (CAN-SPAM, ADR-191), and R1 sends none.
fn postal_problem(text: &str) -> Option<String> {
    let lines = text.lines().filter(|line| !line.trim().is_empty()).count();
    if text.trim().chars().count() > MAX_POSTAL_ADDRESS {
        Some(format!(
            "EMAIL_POSTAL_ADDRESS is longer than {MAX_POSTAL_ADDRESS} characters; the sender refuses it"
        ))
    } else if lines < 2 {
        Some(
            "EMAIL_POSTAL_ADDRESS should be a street address on at least two lines (street, then city, region, postal code and country)"
                .to_owned(),
        )
    } else {
        None
    }
}

/// What is wrong with `SES_CONFIGURATION_SET` or `SES_SNS_TOPIC_ARN`, when either is set. Unset is
/// not a fault for the identity check; `LAUNCH.md` section E tracks the live bounce check.
fn bounce_problem(set: &str, topic: &str, region: &str) -> Option<String> {
    let set = set.trim();
    let set_ok = set.len() <= 64
        && set
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    if !set.is_empty() && !set_ok {
        return Some(
            "SES_CONFIGURATION_SET is not a configuration set name (letters, digits, - and _, at most 64)"
                .to_owned(),
        );
    }
    let topic = topic.trim();
    if topic.is_empty() {
        return None;
    }
    let parts: Vec<&str> = topic.split(':').collect();
    let shaped = matches!(
        parts.as_slice(),
        ["arn", "aws", "sns", topic_region, account, name]
            if region_ok(topic_region)
                && account.len() == 12
                && account.bytes().all(|b| b.is_ascii_digit())
                && !name.is_empty()
                && name.len() <= 256
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    );
    if !shaped {
        return Some(
            "SES_SNS_TOPIC_ARN must look like arn:aws:sns:<region>:<12-digit account>:<topic name>"
                .to_owned(),
        );
    }
    // The topic must be in SES's region: SNS delivers from the topic's own region.
    if parts.get(3).copied() != Some(region) {
        return Some(format!(
            "SES_SNS_TOPIC_ARN is in a different region than SES_REGION ({region}); create the topic in the SES region"
        ));
    }
    None
}

async fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(
        ctx,
        7,
        &[
            Var::SesRegion,
            Var::SesAccessKeyId,
            Var::SesSecretAccessKey,
            Var::EmailFrom,
        ],
    )?;
    let region = inputs.text(Var::SesRegion);
    if !region_ok(region) {
        return Ok(Outcome::fail(
            "SES_REGION is not an AWS region name such as eu-west-1",
        ));
    }
    let Some(address) = address(inputs.text(Var::EmailFrom)) else {
        return Ok(Outcome::fail(
            "EMAIL_FROM has no email address (use name@example.com or Name <name@example.com>)",
        ));
    };
    if let Ok(found) = ctx.vars.gather(7, &[Var::EmailPostalAddress])
        && let Some(problem) = postal_problem(found.text(Var::EmailPostalAddress))
    {
        return Ok(Outcome::fail(problem));
    }
    // Each is optional on its own, so each is read on its own.
    let set = ctx.vars.gather(7, &[Var::SesConfigurationSet]).ok();
    let topic = ctx.vars.gather(7, &[Var::SesSnsTopicArn]).ok();
    if let Some(problem) = bounce_problem(
        set.as_ref()
            .map_or("", |found| found.text(Var::SesConfigurationSet)),
        topic
            .as_ref()
            .map_or("", |found| found.text(Var::SesSnsTopicArn)),
        region,
    ) {
        return Ok(Outcome::fail(problem));
    }
    let domain = address
        .rsplit_once('@')
        .map_or("", |(_, domain)| domain)
        .to_ascii_lowercase();
    let session = Session {
        ctx,
        origin: ctx.endpoints.ses.as_deref().map_or_else(
            || format!("https://email.{region}.amazonaws.com"),
            |origin| origin.trim_end_matches('/').to_owned(),
        ),
        region,
        credentials: Credentials {
            access_key_id: inputs.secret(Var::SesAccessKeyId),
            secret_access_key: inputs.secret(Var::SesSecretAccessKey),
        },
    };
    session.account().await?;
    session.identity(&domain, address).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses_come_from_plain_and_display_name_forms() {
        assert_eq!(address("hello@example.com"), Some("hello@example.com"));
        assert_eq!(
            address("Rampsmith <hello@example.com>"),
            Some("hello@example.com")
        );
        assert_eq!(address("  <a@b.co>  "), Some("a@b.co"));
        assert_eq!(address("hello"), None);
        assert_eq!(address("Name <nope>"), None);
        assert_eq!(address("two words@example.com"), None);
        assert_eq!(address("a@b"), None);
    }

    #[test]
    fn a_postal_address_needs_a_street_and_a_place_and_a_sane_length() {
        assert_eq!(
            postal_problem("1 Main St\nSpringfield, EX 00000\nUnited States"),
            None
        );
        assert!(postal_problem("1 Main St, Springfield").is_some());
        assert!(postal_problem("").is_some());
        assert!(postal_problem(&format!("a\n{}", "b".repeat(400))).is_some());
    }

    #[test]
    fn regions_are_plain_names() {
        assert!(region_ok("eu-west-1"));
        assert!(!region_ok(""));
        assert!(!region_ok("EU/west"));
        assert!(!region_ok("evil.example.com/"));
    }
}
