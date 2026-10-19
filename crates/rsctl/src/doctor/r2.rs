//! R2: three tokens, each proved for what it is allowed to do and no more (ADR-152, ADR-091).
//!
//! | Token | Variables | Allowed | Check |
//! | --- | --- | --- | --- |
//! | engine | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Object Read & Write, evidence bucket only | `r2.evidence`: write, read back, delete; `r2.engine-not-backups`: refused on the backups bucket |
//! | backup service | `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY` | Object Read & Write, backups bucket only | `r2.backup-token`: write, read back, delete |
//! | restore drill | `DRILL_R2_ACCESS_KEY_ID`, `DRILL_R2_SECRET_ACCESS_KEY` | Object Read only, backups bucket only | `r2.drill-token`: reads, and a write is refused |
//!
//! The engine's token never has to reach the backups bucket, so `--strict` never asks it to: the
//! check on that bucket is the other way round, a negative one that fails when the engine's token
//! is accepted there. R2 answers a token that does not cover the bucket or the operation with
//! HTTP 403 and S3 code `AccessDenied` (Cloudflare R2 documentation, "Error codes", 10003).
//!
//! R2's S3 API at `https://<account>.r2.cloudflarestorage.com`, region `auto`, path-style
//! (`/<bucket>/<key>`), `SigV4` with service `s3` and a signed `x-amz-content-sha256`. A probe
//! writes `rsctl-doctor/<time>.txt`, reads it back, compares it and deletes it, so nothing is
//! left behind even when the read fails; the checks that expect a refusal delete the object if
//! the write was accepted after all. The bucket's lifecycle rule is the founder's dashboard step
//! and is not checked: reading it needs a broader token.

use reqwest::Method;

use super::common::{AwsScope, Step, aws_request, gather, send, xml_tag};
use super::{Ctx, ProbeFuture};
use crate::http::Reply;
use crate::report::Outcome;
use crate::sigv4::{Credentials, PathMode};
use crate::util::{compact_timestamp, safe_token, uri_encode};
use crate::vars::Var;

/// The two variables of one R2 token.
#[derive(Debug, Clone, Copy)]
struct Token {
    key: Var,
    secret: Var,
}

const ENGINE: Token = Token {
    key: Var::R2AccessKeyId,
    secret: Var::R2SecretAccessKey,
};
const BACKUP: Token = Token {
    key: Var::BackupR2AccessKeyId,
    secret: Var::BackupR2SecretAccessKey,
};
const DRILL: Token = Token {
    key: Var::DrillR2AccessKeyId,
    secret: Var::DrillR2SecretAccessKey,
};

/// The engine's token on the evidence bucket (C row 6).
pub(super) const READS_EVIDENCE: &[Var] = &[
    Var::R2AccountId,
    Var::R2AccessKeyId,
    Var::R2SecretAccessKey,
    Var::R2BucketEvidence,
];
/// The engine's token on the backups bucket, which must be refused (C row 6).
pub(super) const READS_ENGINE_REFUSED: &[Var] = &[
    Var::R2AccountId,
    Var::R2AccessKeyId,
    Var::R2SecretAccessKey,
    Var::R2BucketBackups,
];
/// The backup service's token on the backups bucket (C row 16).
pub(super) const READS_BACKUP_TOKEN: &[Var] = &[
    Var::R2AccountId,
    Var::BackupR2AccessKeyId,
    Var::BackupR2SecretAccessKey,
    Var::R2BucketBackups,
];
/// The restore drill's token on the backups bucket (C row 16).
pub(super) const READS_DRILL_TOKEN: &[Var] = &[
    Var::R2AccountId,
    Var::DrillR2AccessKeyId,
    Var::DrillR2SecretAccessKey,
    Var::R2BucketBackups,
];

const SCOPE: AwsScope<'static> = AwsScope {
    region: "auto",
    service: "s3",
    mode: PathMode::S3,
    content_sha256: true,
};

pub(super) fn run_evidence(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move {
        round_trip(ctx, 6, READS_EVIDENCE, ENGINE, Var::R2BucketEvidence)
            .await
            .unwrap_or_else(|outcome| outcome)
    })
}

pub(super) fn run_backup_token(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move {
        round_trip(ctx, 16, READS_BACKUP_TOKEN, BACKUP, Var::R2BucketBackups)
            .await
            .unwrap_or_else(|outcome| outcome)
    })
}

pub(super) fn run_drill_token(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { read_only(ctx).await.unwrap_or_else(|outcome| outcome) })
}

pub(super) fn run_engine_refused(ctx: &Ctx) -> ProbeFuture<'_> {
    Box::pin(async move { refused(ctx).await.unwrap_or_else(|outcome| outcome) })
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

fn code_of(reply: &Reply) -> Option<String> {
    xml_tag(&reply.body, "Code").map(|code| safe_token(&code))
}

fn failure(step: &str, reply: &Reply, token: Token) -> Outcome {
    let code = code_of(reply);
    let meaning = match code.as_deref() {
        Some("AccessDenied") => {
            " (the token lacks the permission it needs on this bucket)".to_owned()
        }
        Some("NoSuchBucket") => {
            " (no such bucket for this account, or the token cannot see it)".to_owned()
        }
        Some("InvalidAccessKeyId") => format!(" ({} is not an R2 access key)", token.key.name()),
        Some("SignatureDoesNotMatch") => {
            format!(" ({} does not match the access key)", token.secret.name())
        }
        _ => String::new(),
    };
    Outcome::fail(format!(
        "{step} failed: HTTP {}{}{meaning}",
        reply.status,
        code.map_or_else(String::new, |code| format!(" {code}"))
    ))
}

/// An opened session: validated inputs, signing credentials, the bucket and its origin.
struct Session<'a> {
    ctx: &'a Ctx,
    credentials: Credentials,
    origin: String,
    bucket: String,
    key: String,
}

impl<'a> Session<'a> {
    fn open(ctx: &'a Ctx, row: u8, needs: &[Var], token: Token, bucket_var: Var) -> Step<Self> {
        if row == 16 {
            // Row 16's own variables decide between skip and fail: the account id and the bucket
            // name belong to row 6 and are set long before anyone creates the backup tokens.
            gather(ctx, row, &[token.key, token.secret])?;
        }
        let inputs = gather(ctx, row, needs)?;
        let account = inputs.text(Var::R2AccountId);
        if !account_ok(account) {
            return Err(Outcome::fail(
                "R2_ACCOUNT_ID is not a Cloudflare account id (32 hexadecimal characters)",
            ));
        }
        let bucket = inputs.text(bucket_var);
        if !bucket_ok(bucket) {
            return Err(Outcome::fail(format!(
                "{} is not a valid bucket name (3 to 63 characters: a-z, 0-9, hyphen)",
                bucket_var.name()
            )));
        }
        let credentials = Credentials {
            access_key_id: inputs.secret(token.key),
            secret_access_key: inputs.secret(token.secret),
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
        Ok(Self {
            ctx,
            credentials,
            origin,
            bucket: bucket.to_owned(),
            key,
        })
    }

    fn payload(&self) -> String {
        format!("rsctl doctor probe {}", self.key)
    }

    fn url(&self) -> String {
        format!(
            "{}/{}/{}",
            self.origin,
            uri_encode(&self.bucket, true),
            uri_encode(&self.key, false)
        )
    }

    async fn call(&self, method: Method, body: &[u8]) -> Step<Reply> {
        let builder = aws_request(
            self.ctx,
            method,
            &self.url(),
            &self.credentials,
            SCOPE,
            body,
        )?;
        send(self.ctx, "R2", builder).await
    }

    fn bucket_name(&self) -> String {
        safe_token(&self.bucket)
    }
}

/// Write, read back and delete one object: the token has Object Read & Write on the bucket.
async fn round_trip(
    ctx: &Ctx,
    row: u8,
    needs: &[Var],
    token: Token,
    bucket_var: Var,
) -> Step<Outcome> {
    let session = Session::open(ctx, row, needs, token, bucket_var)?;
    let payload = session.payload();

    // 1. Write.
    let reply = session.call(Method::PUT, payload.as_bytes()).await?;
    if !reply.is_success() {
        return Ok(failure("writing the probe object", &reply, token));
    }

    // 2. Read it back, then 3. delete it whatever the read said.
    let read = session.call(Method::GET, &[]).await;
    let delete = session.call(Method::DELETE, &[]).await;

    let read = read?;
    if !read.is_success() {
        return Ok(failure("reading the probe object back", &read, token));
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
            token,
        ));
    }
    Ok(Outcome::pass(format!(
        "wrote, read back and deleted a probe object in bucket `{}`",
        session.bucket_name()
    )))
}

/// The restore drill's token: it reads, and a write is refused. A token that can write is a
/// failure, because the drill's job is only to restore.
async fn read_only(ctx: &Ctx) -> Step<Outcome> {
    let session = Session::open(ctx, 16, READS_DRILL_TOKEN, DRILL, Var::R2BucketBackups)?;
    let payload = session.payload();

    // 1. Read an object that is not there. An authorized read answers 404; a token without
    //    Object Read answers 403 AccessDenied.
    let read = session.call(Method::GET, &[]).await?;
    let not_found = read.status == 404 && code_of(&read).as_deref() != Some("NoSuchBucket");
    if !read.is_success() && !not_found {
        return Ok(failure("reading from the bucket", &read, DRILL));
    }

    // 2. A write must be refused.
    let write = session.call(Method::PUT, payload.as_bytes()).await?;
    if write.is_success() {
        // Too wide: clean up with the same token, then fail.
        let _ = session.call(Method::DELETE, &[]).await;
        return Ok(Outcome::fail(format!(
            "{} can write to bucket `{}`: the drill's token must be Object Read only (the probe object was deleted)",
            DRILL.key.name(),
            session.bucket_name()
        )));
    }
    if write.status != 403 || code_of(&write).as_deref() != Some("AccessDenied") {
        return Ok(failure(
            "the write, which was expected to be refused with AccessDenied,",
            &write,
            DRILL,
        ));
    }
    Ok(Outcome::pass(format!(
        "reads bucket `{}` and is refused a write (HTTP 403 AccessDenied), as an Object Read only token must be",
        session.bucket_name()
    )))
}

/// The engine's token on the backups bucket: refused for a write and for a read. The check
/// passes when R2 says no.
async fn refused(ctx: &Ctx) -> Step<Outcome> {
    let session = Session::open(ctx, 6, READS_ENGINE_REFUSED, ENGINE, Var::R2BucketBackups)?;
    let payload = session.payload();
    let bucket = session.bucket_name();

    let write = session.call(Method::PUT, payload.as_bytes()).await?;
    if write.is_success() {
        let _ = session.call(Method::DELETE, &[]).await;
        return Ok(Outcome::fail(format!(
            "{} can write to the backups bucket `{bucket}`: the evidence token must cover the evidence bucket only (the probe object was deleted)",
            ENGINE.key.name()
        )));
    }
    if write.status != 403 || code_of(&write).as_deref() != Some("AccessDenied") {
        return Ok(failure(
            "the write, which was expected to be refused with AccessDenied,",
            &write,
            ENGINE,
        ));
    }

    let read = session.call(Method::GET, &[]).await?;
    let readable = read.is_success()
        || (read.status == 404 && code_of(&read).as_deref() != Some("NoSuchBucket"));
    if readable {
        return Ok(Outcome::fail(format!(
            "{} can read the backups bucket `{bucket}`: the evidence token must cover the evidence bucket only",
            ENGINE.key.name()
        )));
    }
    if read.status != 403 || code_of(&read).as_deref() != Some("AccessDenied") {
        return Ok(failure(
            "the read, which was expected to be refused with AccessDenied,",
            &read,
            ENGINE,
        ));
    }
    Ok(Outcome::pass(format!(
        "{} is refused on the backups bucket `{bucket}` for write and read (HTTP 403 AccessDenied), as the evidence token must be",
        ENGINE.key.name()
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

    #[test]
    fn the_three_tokens_read_three_different_pairs_of_variables() {
        let pairs = [ENGINE, BACKUP, DRILL].map(|token| (token.key, token.secret));
        for (index, pair) in pairs.iter().enumerate() {
            assert!(!pairs[index + 1..].contains(pair), "{pair:?} is shared");
        }
        // The engine's pair reaches the evidence bucket and the negative check only.
        assert!(!READS_BACKUP_TOKEN.contains(&Var::R2AccessKeyId));
        assert!(!READS_DRILL_TOKEN.contains(&Var::R2AccessKeyId));
        assert!(!READS_EVIDENCE.contains(&Var::R2BucketBackups));
        assert!(!READS_ENGINE_REFUSED.contains(&Var::R2BucketEvidence));
    }
}
