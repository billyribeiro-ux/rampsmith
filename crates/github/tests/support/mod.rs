//! Shared fixtures: a throwaway RSA key generated per test run, a manual clock, a span
//! recorder, and a fake GitHub REST API on loopback. Nothing here talks to github.com.

#![allow(
    dead_code,
    unreachable_pub,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::missing_panics_doc,
    clippy::too_many_lines
)]

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::fmt::{self, Write as _};
use std::sync::{Arc, Mutex, OnceLock};

use aws_lc_rs::encoding::AsDer;
use aws_lc_rs::rsa::{KeyPair, KeySize};
use aws_lc_rs::signature::{KeyPair as _, RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::Response;
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use github::{AppCredentials, AppIssuer, AppPrivateKey, ClientConfig, Clock, GitHub};
use secrecy::SecretString;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing_subscriber::layer::{Context, Layer};

pub const CLIENT_ID: &str = "Iv23liTestClient";
pub const OWNER: &str = "octo-shop";
pub const REPO: &str = "dawn-theme";
pub const INSTALLATION: u64 = 4242;

/// A test-only RSA key, generated once per test binary. Never a real credential.
pub struct TestKey {
    pub pkcs8: Vec<u8>,
    pub pkcs1: Vec<u8>,
    pub public: Vec<u8>,
}

pub fn key() -> &'static TestKey {
    static KEY: OnceLock<TestKey> = OnceLock::new();
    KEY.get_or_init(|| {
        let pair = KeyPair::generate(KeySize::Rsa2048).unwrap();
        let pkcs8 = pair.as_der().unwrap().as_ref().to_vec();
        let pkcs1 = pkcs8_to_pkcs1(&pkcs8);
        let public = pair.public_key().as_ref().to_vec();
        TestKey {
            pkcs8,
            pkcs1,
            public,
        }
    })
}

fn read_tlv(input: &[u8]) -> (u8, &[u8], &[u8]) {
    let tag = input[0];
    let (len, header) = match input[1] {
        n if n < 0x80 => (usize::from(n), 2),
        0x81 => (usize::from(input[2]), 3),
        0x82 => ((usize::from(input[2]) << 8) | usize::from(input[3]), 4),
        other => panic!("unsupported DER length form {other:#x}"),
    };
    (tag, &input[header..header + len], &input[header + len..])
}

/// PKCS#8 `PrivateKeyInfo` wraps the PKCS#1 `RSAPrivateKey` in its third field.
fn pkcs8_to_pkcs1(pkcs8: &[u8]) -> Vec<u8> {
    let (_, info, _) = read_tlv(pkcs8);
    let (_, _version, rest) = read_tlv(info);
    let (_, _algorithm, rest) = read_tlv(rest);
    let (tag, key, _) = read_tlv(rest);
    assert_eq!(tag, 0x04, "privateKey is an OCTET STRING");
    key.to_vec()
}

pub fn pem(label: &str, der: &[u8]) -> String {
    let body = STANDARD.encode(der);
    let lines: Vec<&str> = body
        .as_bytes()
        .chunks(64)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect();
    format!(
        "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
        lines.join("\n")
    )
}

/// The key as GitHub hands it out: PKCS#1 PEM.
pub fn pkcs1_pem() -> SecretString {
    SecretString::from(pem("RSA PRIVATE KEY", &key().pkcs1))
}

pub fn pkcs8_pem() -> SecretString {
    SecretString::from(pem("PRIVATE KEY", &key().pkcs8))
}

pub fn credentials() -> AppCredentials {
    AppCredentials::new(
        AppIssuer::client_id(CLIENT_ID).unwrap(),
        AppPrivateKey::from_pem(&pkcs1_pem()).unwrap(),
    )
}

/// A clock tests move by hand.
#[derive(Debug)]
pub struct TestClock(Mutex<OffsetDateTime>);

impl TestClock {
    pub fn at(unix: i64) -> Arc<Self> {
        Arc::new(Self(Mutex::new(
            OffsetDateTime::from_unix_timestamp(unix).unwrap(),
        )))
    }

    pub fn advance(&self, by: Duration) {
        let mut now = self.0.lock().unwrap();
        *now += by;
    }

    pub fn now_for_test(&self) -> OffsetDateTime {
        *self.0.lock().unwrap()
    }
}

impl Clock for TestClock {
    fn now(&self) -> OffsetDateTime {
        *self.0.lock().unwrap()
    }
}

/// 2026-10-17T00:00:00Z.
pub const START: i64 = 1_792_195_200;

/// Every span name, field and event a test produced, as text.
#[derive(Clone, Default)]
pub struct Captured(Arc<Mutex<Vec<String>>>);

impl Captured {
    pub fn text(&self) -> String {
        self.0.lock().unwrap().join("\n")
    }
}

struct Recorder<'a>(&'a mut Vec<String>);

impl Visit for Recorder<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.0.push(format!("{}={value:?}", field.name()));
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.push(format!("{}={value}", field.name()));
    }
}

impl<S: tracing::Subscriber> Layer<S> for Captured {
    fn on_new_span(&self, attrs: &Attributes<'_>, _id: &Id, _ctx: Context<'_, S>) {
        let mut out = self.0.lock().unwrap();
        out.push(format!("span {}", attrs.metadata().name()));
        attrs.record(&mut Recorder(&mut out));
    }

    fn on_record(&self, _id: &Id, values: &Record<'_>, _ctx: Context<'_, S>) {
        values.record(&mut Recorder(&mut self.0.lock().unwrap()));
    }

    fn on_event(&self, event: &tracing::Event<'_>, _ctx: Context<'_, S>) {
        event.record(&mut Recorder(&mut self.0.lock().unwrap()));
    }
}

/// One request the fake received.
#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl Recorded {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }
}

/// A canned response returned for the next request instead of the normal handling.
#[derive(Debug, Clone)]
pub struct Injected {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Injected {
    #[allow(clippy::needless_pass_by_value)]
    pub fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: body.to_string().into_bytes(),
        }
    }

    pub fn header(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.headers.push((name, value.into()));
        self
    }
}

#[derive(Debug, Clone)]
pub struct TreeItem {
    pub mode: String,
    pub kind: String,
    pub sha: String,
}

#[derive(Debug, Clone)]
pub struct CommitObject {
    pub tree: String,
    pub parents: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct FakePull {
    pub number: u64,
    pub head: String,
    pub base: String,
    pub title: String,
    pub body: String,
}

/// The fake's state: a tiny Git object store plus pulls and check runs.
#[derive(Debug)]
pub struct FakeState {
    pub clock: Arc<TestClock>,
    pub requests: Vec<Recorded>,
    pub inject: VecDeque<Injected>,
    pub token_ttl: Duration,
    pub tokens: HashMap<String, OffsetDateTime>,
    pub minted: Vec<String>,
    pub jwts: Vec<String>,
    pub blobs: HashMap<String, Vec<u8>>,
    pub trees: HashMap<String, BTreeMap<String, TreeItem>>,
    pub commits: HashMap<String, CommitObject>,
    pub refs: HashMap<String, String>,
    pub pulls: Vec<FakePull>,
    pub check_runs: Vec<(u64, Value)>,
    pub truncate_trees: bool,
}

pub type Shared = Arc<Mutex<FakeState>>;

fn object_id(kind: &str, content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update([0]);
    hasher.update(content);
    let digest = hasher.finalize();
    digest[..20].iter().fold(String::new(), |mut out, b| {
        write!(out, "{b:02x}").unwrap();
        out
    })
}

impl FakeState {
    pub fn add_blob(&mut self, content: &[u8]) -> String {
        let sha = object_id("blob", content);
        self.blobs.insert(sha.clone(), content.to_vec());
        sha
    }

    pub fn add_tree(&mut self, entries: BTreeMap<String, TreeItem>) -> String {
        let listing = entries.iter().fold(String::new(), |mut out, (p, e)| {
            writeln!(out, "{} {} {} {p}", e.mode, e.kind, e.sha).unwrap();
            out
        });
        let sha = object_id("tree", listing.as_bytes());
        self.trees.insert(sha.clone(), entries);
        sha
    }

    pub fn add_commit(&mut self, tree: &str, parents: Vec<String>, message: &str) -> String {
        let sha = object_id(
            "commit",
            format!("{tree} {} {message}", parents.join(",")).as_bytes(),
        );
        self.commits.insert(
            sha.clone(),
            CommitObject {
                tree: tree.to_owned(),
                parents,
                message: message.to_owned(),
            },
        );
        sha
    }

    /// Seeds `main` with a commit whose tree holds `files` (path -> content) as regular blobs
    /// plus any `extra` entries (such as symlinks).
    pub fn seed(&mut self, files: &[(&str, &str)], extra: &[(&str, &str, &str)]) -> String {
        let mut entries = BTreeMap::new();
        for (path, content) in files {
            let sha = self.add_blob(content.as_bytes());
            entries.insert(
                (*path).to_owned(),
                TreeItem {
                    mode: "100644".to_owned(),
                    kind: "blob".to_owned(),
                    sha,
                },
            );
        }
        for (path, mode, target) in extra {
            let sha = self.add_blob(target.as_bytes());
            entries.insert(
                (*path).to_owned(),
                TreeItem {
                    mode: (*mode).to_owned(),
                    kind: "blob".to_owned(),
                    sha,
                },
            );
        }
        let tree = self.add_tree(entries);
        let commit = self.add_commit(&tree, vec![], "initial theme");
        self.refs.insert("main".to_owned(), commit.clone());
        commit
    }

    /// The file contents a commit's tree holds.
    pub fn files_at(&self, commit: &str) -> BTreeMap<String, String> {
        let tree = &self.trees[&self.commits[commit].tree];
        tree.iter()
            .map(|(p, e)| {
                (
                    p.clone(),
                    String::from_utf8(self.blobs[&e.sha].clone()).unwrap(),
                )
            })
            .collect()
    }

    fn descends_from(&self, commit: &str, ancestor: &str) -> bool {
        let mut stack = vec![commit.to_owned()];
        while let Some(c) = stack.pop() {
            if c == ancestor {
                return true;
            }
            if let Some(obj) = self.commits.get(&c) {
                stack.extend(obj.parents.iter().cloned());
            }
        }
        false
    }
}

pub struct Fake {
    pub base_url: String,
    pub state: Shared,
    pub clock: Arc<TestClock>,
}

impl Fake {
    pub async fn start() -> Self {
        let clock = TestClock::at(START);
        let state = Arc::new(Mutex::new(FakeState {
            clock: Arc::clone(&clock),
            requests: Vec::new(),
            inject: VecDeque::new(),
            token_ttl: Duration::hours(1),
            tokens: HashMap::new(),
            minted: Vec::new(),
            jwts: Vec::new(),
            blobs: HashMap::new(),
            trees: HashMap::new(),
            commits: HashMap::new(),
            refs: HashMap::new(),
            pulls: Vec::new(),
            check_runs: Vec::new(),
            truncate_trees: false,
        }));
        let router = Router::new()
            .fallback(handle)
            .with_state(Arc::clone(&state));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            base_url: format!("http://{addr}"),
            state,
            clock,
        }
    }

    pub fn client(&self) -> GitHub {
        self.client_with(ClientConfig {
            base_url: self.base_url.clone(),
            ..ClientConfig::default()
        })
    }

    pub fn client_with(&self, config: ClientConfig) -> GitHub {
        GitHub::new(config, credentials(), self.clock.clone()).unwrap()
    }

    pub fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.state.lock().unwrap()
    }

    pub fn inject(&self, response: Injected) {
        self.state().inject.push_back(response);
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.state().requests.clone()
    }
}

fn reply(status: u16, body: &Value) -> Response {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("x-github-request-id", "FAKE:REQ:0001")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn not_found() -> Response {
    reply(404, &json!({"message": "Not Found"}))
}

/// Verifies an App JWT the way GitHub would: RS256 over the test public key, `iss` the client
/// ID, a lifetime of at most 10 minutes, and `exp` in the future.
fn valid_jwt(token: &str, now: OffsetDateTime) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    let [header, claims, signature] = parts.as_slice() else {
        return false;
    };
    let signed = format!("{header}.{claims}");
    let Ok(sig) = URL_SAFE_NO_PAD.decode(signature) else {
        return false;
    };
    if UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, &key().public)
        .verify(signed.as_bytes(), &sig)
        .is_err()
    {
        return false;
    }
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).unwrap()).unwrap();
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(claims).unwrap()).unwrap();
    let (iat, exp) = (
        claims["iat"].as_i64().unwrap(),
        claims["exp"].as_i64().unwrap(),
    );
    header == json!({"alg": "RS256", "typ": "JWT"})
        && claims["iss"] == CLIENT_ID
        && exp - iat <= 600
        && exp > now.unix_timestamp()
        && iat <= now.unix_timestamp()
}

async fn handle(
    State(state): State<Shared>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut s = state.lock().unwrap();
    let now = s.clock.now();
    s.requests.push(Recorded {
        method: method.to_string(),
        path: uri.path().to_owned(),
        query: uri.query().unwrap_or("").to_owned(),
        headers: headers
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_owned()))
            .collect(),
        body: body.to_vec(),
    });
    if headers
        .get("x-github-api-version")
        .and_then(|v| v.to_str().ok())
        != Some("2026-03-10")
        || headers.get("user-agent").is_none()
        || headers.get("accept").is_none()
    {
        return reply(400, &json!({"message": "missing required headers"}));
    }
    if let Some(injected) = s.inject.pop_front() {
        let mut builder = Response::builder().status(injected.status);
        for (k, v) in &injected.headers {
            builder = builder.header(*k, v);
        }
        return builder.body(Body::from(injected.body)).unwrap();
    }
    let bearer = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .unwrap_or("")
        .to_owned();
    let path = uri.path().to_owned();
    let segments: Vec<&str> = path.trim_start_matches('/').split('/').collect();

    if segments.first() == Some(&"app") {
        if !valid_jwt(&bearer, now) {
            return reply(
                401,
                &json!({"message": "A JSON web token could not be decoded"}),
            );
        }
        s.jwts.push(bearer);
        return match (method.as_str(), segments.as_slice()) {
            ("GET", ["app"]) => reply(
                200,
                &json!({"id": 123, "slug": "rampsmith-test", "client_id": CLIENT_ID}),
            ),
            ("POST", ["app", "installations", id, "access_tokens"]) if *id == "4242" => {
                let n = s.minted.len() + 1;
                let token = format!("ghs_fake{n}SecretTokenValue{}", now.unix_timestamp());
                let expires = now + s.token_ttl;
                s.tokens.insert(token.clone(), expires);
                s.minted.push(token.clone());
                reply(
                    201,
                    &json!({
                        "token": token,
                        "expires_at": expires.format(&Rfc3339).unwrap(),
                        "permissions": {"contents": "write"},
                        "repository_selection": "selected"
                    }),
                )
            }
            _ => not_found(),
        };
    }

    match s.tokens.get(&bearer) {
        Some(expires) if *expires > now => {}
        _ => return reply(401, &json!({"message": "Bad credentials"})),
    }
    let ["repos", owner, repo, rest @ ..] = segments.as_slice() else {
        return not_found();
    };
    if *owner != OWNER || *repo != REPO {
        return not_found();
    }
    let input: Value = if body.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    match (method.as_str(), rest) {
        ("GET", ["git", "ref", "heads", branch @ ..]) => {
            let branch = branch.join("/");
            match s.refs.get(&branch) {
                Some(sha) => reply(
                    200,
                    &json!({"ref": format!("refs/heads/{branch}"), "object": {"type": "commit", "sha": sha}}),
                ),
                None => not_found(),
            }
        }
        ("GET", ["git", "commits", sha]) => match s.commits.get(*sha) {
            Some(c) => reply(200, &json!({"sha": sha, "tree": {"sha": c.tree}})),
            None => not_found(),
        },
        ("GET", ["git", "trees", sha]) => {
            assert_eq!(uri.query(), Some("recursive=1"));
            match s.trees.get(*sha) {
                Some(tree) => {
                    let items: Vec<Value> = tree
                        .iter()
                        .map(|(p, e)| json!({"path": p, "mode": e.mode, "type": e.kind, "sha": e.sha}))
                        .collect();
                    reply(
                        200,
                        &json!({"sha": sha, "truncated": s.truncate_trees, "tree": items}),
                    )
                }
                None => not_found(),
            }
        }
        ("GET", ["git", "blobs", sha]) => match s.blobs.get(*sha) {
            Some(content) => {
                assert_eq!(
                    headers.get("accept").unwrap(),
                    "application/vnd.github.raw+json"
                );
                Response::builder()
                    .status(200)
                    .body(Body::from(content.clone()))
                    .unwrap()
            }
            None => not_found(),
        },
        ("POST", ["git", "blobs"]) => {
            assert_eq!(input["encoding"], "base64");
            let content = STANDARD.decode(input["content"].as_str().unwrap()).unwrap();
            let sha = s.add_blob(&content);
            reply(201, &json!({"sha": sha, "url": "x"}))
        }
        ("POST", ["git", "trees"]) => {
            let base = input["base_tree"].as_str().unwrap();
            let Some(mut entries) = s.trees.get(base).cloned() else {
                return reply(422, &json!({"message": "base_tree is not a valid tree"}));
            };
            for item in input["tree"].as_array().unwrap() {
                let sha = item["sha"].as_str().unwrap().to_owned();
                if !s.blobs.contains_key(&sha) {
                    return reply(422, &json!({"message": "tree.sha is not a valid blob"}));
                }
                entries.insert(
                    item["path"].as_str().unwrap().to_owned(),
                    TreeItem {
                        mode: item["mode"].as_str().unwrap().to_owned(),
                        kind: item["type"].as_str().unwrap().to_owned(),
                        sha,
                    },
                );
            }
            let sha = s.add_tree(entries);
            reply(201, &json!({"sha": sha, "truncated": false, "tree": []}))
        }
        ("POST", ["git", "commits"]) => {
            let tree = input["tree"].as_str().unwrap().to_owned();
            let parents: Vec<String> = input["parents"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p.as_str().unwrap().to_owned())
                .collect();
            assert!(input.get("author").is_none() && input.get("committer").is_none());
            let sha = s.add_commit(&tree, parents, input["message"].as_str().unwrap());
            reply(201, &json!({"sha": sha, "tree": {"sha": tree}}))
        }
        ("POST", ["git", "refs"]) => {
            let full = input["ref"].as_str().unwrap();
            let branch = full.strip_prefix("refs/heads/").unwrap().to_owned();
            if s.refs.contains_key(&branch) {
                return reply(422, &json!({"message": "Reference already exists"}));
            }
            s.refs
                .insert(branch, input["sha"].as_str().unwrap().to_owned());
            reply(201, &json!({"ref": full, "object": {"sha": input["sha"]}}))
        }
        ("PATCH", ["git", "refs", "heads", branch @ ..]) => {
            let branch = branch.join("/");
            let new = input["sha"].as_str().unwrap().to_owned();
            let force = input["force"].as_bool().unwrap();
            let Some(current) = s.refs.get(&branch).cloned() else {
                return reply(422, &json!({"message": "Reference does not exist"}));
            };
            if !force && !s.descends_from(&new, &current) {
                return reply(422, &json!({"message": "Update is not a fast forward"}));
            }
            s.refs.insert(branch.clone(), new.clone());
            reply(
                200,
                &json!({"ref": format!("refs/heads/{branch}"), "object": {"sha": new}}),
            )
        }
        ("GET", ["pulls"]) => {
            let query: HashMap<String, String> = uri
                .query()
                .unwrap_or("")
                .split('&')
                .filter_map(|kv| kv.split_once('='))
                .map(|(k, v)| (k.to_owned(), v.replace("%3A", ":").replace("%2F", "/")))
                .collect();
            let head = query["head"].split_once(':').unwrap().1.to_owned();
            let open: Vec<Value> = s
                .pulls
                .iter()
                .filter(|p| p.head == head && p.base == query["base"])
                .map(|p| pull_json(&s, p))
                .collect();
            reply(200, &Value::Array(open))
        }
        ("POST", ["pulls"]) => {
            let pull = FakePull {
                number: s.pulls.len() as u64 + 1,
                head: input["head"].as_str().unwrap().to_owned(),
                base: input["base"].as_str().unwrap().to_owned(),
                title: input["title"].as_str().unwrap().to_owned(),
                body: input["body"].as_str().unwrap().to_owned(),
            };
            if !s.refs.contains_key(&pull.head) {
                return reply(422, &json!({"message": "Validation Failed"}));
            }
            let out = pull_json(&s, &pull);
            s.pulls.push(pull);
            reply(201, &out)
        }
        ("PATCH", ["pulls", number]) => {
            let n: u64 = number.parse().unwrap();
            let Some(index) = s.pulls.iter().position(|p| p.number == n) else {
                return not_found();
            };
            input["title"]
                .as_str()
                .unwrap()
                .clone_into(&mut s.pulls[index].title);
            input["body"]
                .as_str()
                .unwrap()
                .clone_into(&mut s.pulls[index].body);
            let out = pull_json(&s, &s.pulls[index]);
            reply(200, &out)
        }
        ("POST", ["check-runs"]) => {
            let id = 9000 + s.check_runs.len() as u64;
            s.check_runs.push((id, input));
            reply(201, &json!({"id": id}))
        }
        ("PATCH", ["check-runs", id]) => {
            let id: u64 = id.parse().unwrap();
            let Some(index) = s.check_runs.iter().position(|(i, _)| *i == id) else {
                return not_found();
            };
            s.check_runs[index].1 = input;
            reply(200, &json!({"id": id}))
        }
        _ => reply(
            StatusCode::NOT_FOUND.as_u16(),
            &json!({"message": "Not Found"}),
        ),
    }
}

fn pull_json(s: &FakeState, p: &FakePull) -> Value {
    json!({
        "id": 77_000 + p.number,
        "number": p.number,
        "state": "open",
        "html_url": format!("https://github.com/{OWNER}/{REPO}/pull/{}", p.number),
        "head": {"ref": p.head, "sha": s.refs.get(&p.head).cloned().unwrap_or_default()},
        "base": {"ref": p.base, "sha": s.refs.get(&p.base).cloned().unwrap_or_default()},
    })
}
