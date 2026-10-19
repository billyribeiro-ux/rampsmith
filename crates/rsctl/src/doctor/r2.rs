//! C row 6, R2: the access key writes, reads and deletes an object in each bucket (ADR-152).
//!
//! R2's S3 API at `https://<account>.r2.cloudflarestorage.com`, region `auto`, path-style
//! (`/<bucket>/<key>`), `SigV4` with service `s3` and a signed `x-amz-content-sha256`. The probe
//! writes `rsctl-doctor/<time>.txt`, reads it back, compares it and deletes it, so nothing is
//! left behind even when the read fails. The bucket's lifecycle rule is the founder's
//! dashboard step and is not checked: reading it needs a broader token.

use reqwest::Method;

use super::common::{AwsScope, Step, aws_request, gather, send, xml_tag};
use super::{Ctx, ProbeFuture};
use crate::report::Outcome;
use crate::sigv4::{Credentials, PathMode};
use crate::util::{compact_timestamp, safe_token, uri_encode};
use crate::vars::Var;

pub(super) const READS_EVIDENCE: &[Var] = &[
    Var::R2AccountId,
    Var::R2AccessKeyId,
    Var::R2SecretAccessKey,
    Var::R2BucketEvidence,
];
pub(super) const READS_BACKUPS: &[Var] = &[
    Var::R2AccountId,
    Var::R2AccessKeyId,
    Var::R2SecretAccessKey,
    Var::R2BucketBackups,
];

pub(super) fn run_evidence(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move {
        probe(ctx, READS_EVIDENCE, Var::R2BucketEvidence)
            .await
            .unwrap_or_else(|outcome| outcome)
    })
}

pub(super) fn run_backups(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move {
        probe(ctx, READS_BACKUPS, Var::R2BucketBackups)
            .await
            .unwrap_or_else(|outcome| outcome)
    })
}

/// R2 bucket names: 3 to 63 characters of lower-case letters, digits and hyphens.
fn bucket_ok(name: &str) -> bool {
    (3..=63).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !name.starts_with('-')
        && !name.ends_with('-')
}

fn account_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn failure(step: &str, reply: &crate::http::Reply) -> Outcome {
    let code = xml_tag(&reply.body, "Code").map(|code| safe_token(&code));
    let meaning = match code.as_deref() {
        Some("AccessDenied") => " (the token lacks Object Read & Write on this bucket)",
        Some("NoSuchBucket") => " (no such bucket for this account, or the token cannot see it)",
        Some("InvalidAccessKeyId") => " (R2_ACCESS_KEY_ID is not an R2 access key)",
        Some("SignatureDoesNotMatch") => " (R2_SECRET_ACCESS_KEY does not match the access key)",
        _ => "",
    };
    Outcome::fail(format!(
        "{step} failed: HTTP {}{}{meaning}",
        reply.status,
        code.map_or_else(String::new, |code| format!(" {code}"))
    ))
}

async fn probe(ctx: &Ctx, needs: &[Var], bucket_var: Var) -> Step<Outcome> {
    let inputs = gather(ctx, 6, needs)?;
    let account = inputs.text(Var::R2AccountId);
    if !account_ok(account) {
        return Ok(Outcome::fail(
            "R2_ACCOUNT_ID is not a Cloudflare account id (32 hexadecimal characters)",
        ));
    }
    let bucket = inputs.text(bucket_var);
    if !bucket_ok(bucket) {
        return Ok(Outcome::fail(format!(
            "{} is not a valid bucket name (3 to 63 characters: a-z, 0-9, hyphen)",
            bucket_var.name()
        )));
    }
    let credentials = Credentials {
        access_key_id: inputs.secret(Var::R2AccessKeyId),
        secret_access_key: inputs.secret(Var::R2SecretAccessKey),
    };
    let origin = ctx.endpoints.r2.as_deref().map_or_else(
        || format!("https://{account}.r2.cloudflarestorage.com"),
        |origin| origin.trim_end_matches('/').to_owned(),
    );
    let now = ctx.now();
    let key = format!(
        "rsctl-doctor/{}-{:09}.txt",
        compact_timestamp(now),
        now.nanosecond()
    );
    let url = format!(
        "{origin}/{}/{}",
        uri_encode(bucket, true),
        uri_encode(&key, false)
    );
    let payload = format!("rsctl doctor probe {key}");
    let scope = AwsScope {
        region: "auto",
        service: "s3",
        mode: PathMode::S3,
        content_sha256: true,
    };

    // 1. Write.
    let builder = aws_request(
        ctx,
        Method::PUT,
        &url,
        &credentials,
        scope,
        payload.as_bytes(),
    )?;
    let reply = send(ctx, "R2", builder).await?;
    if !reply.is_success() {
        return Ok(failure("writing the probe object", &reply));
    }

    // 2. Read it back, then 3. delete it whatever the read said.
    let read = match aws_request(ctx, Method::GET, &url, &credentials, scope, &[]) {
        Ok(builder) => send(ctx, "R2", builder).await,
        Err(outcome) => Err(outcome),
    };
    let delete = match aws_request(ctx, Method::DELETE, &url, &credentials, scope, &[]) {
        Ok(builder) => send(ctx, "R2", builder).await,
        Err(outcome) => Err(outcome),
    };

    let read = read?;
    if !read.is_success() {
        return Ok(failure("reading the probe object back", &read));
    }
    if read.body != payload.as_bytes() {
        return Ok(Outcome::fail(
            "the object read back differs from the one written",
        ));
    }
    let delete = delete?;
    if !delete.is_success() {
        return Ok(failure(
            "deleting the probe object (it was left in the bucket)",
            &delete,
        ));
    }
    Ok(Outcome::pass(format!(
        "wrote, read back and deleted a probe object in bucket `{}`",
        safe_token(bucket)
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_and_account_names_are_checked() {
        assert!(bucket_ok("rampsmith-evidence"));
        assert!(!bucket_ok("ab"));
        assert!(!bucket_ok("Has-Upper"));
        assert!(!bucket_ok("-leading"));
        assert!(!bucket_ok("with/slash"));
        assert!(account_ok("0123456789abcdef0123456789abcdef"));
        assert!(!account_ok("not hex"));
        assert!(!account_ok(""));
    }
}
