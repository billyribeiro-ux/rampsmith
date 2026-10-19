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
    let valid = !local.is_empty()
        && domain.contains('.')
        && !candidate.contains(char::is_whitespace)
        && !domain.contains('@');
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
                seen.push(safe_token(identity));
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
                    self.region,
                    safe_token(identity)
                ))
            } else {
                Outcome::fail(format!(
                    "identity {} exists but is not verified for sending (status {})",
                    safe_token(identity),
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

async fn probe(ctx: &Ctx) -> Step<Outcome> {
    let inputs = gather(ctx, 7, READS)?;
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
    fn regions_are_plain_names() {
        assert!(region_ok("eu-west-1"));
        assert!(!region_ok(""));
        assert!(!region_ok("EU/west"));
        assert!(!region_ok("evil.example.com/"));
    }
}
