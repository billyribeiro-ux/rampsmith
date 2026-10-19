//! Repository operations through the REST API (PLAN §15, ADR-125): read the theme tree and
//! files, build fix commits through the Git database, move `rampsmith/` branches, open or
//! update the pull request and report the check run.
//!
//! Endpoints checked on docs.github.com on 2026-10-17:
//! - Git database: `GET /repos/{owner}/{repo}/git/ref/{ref}` (`heads/<branch>`, 404 when
//!   absent), `GET .../git/commits/{commit_sha}`, `GET .../git/trees/{tree_sha}?recursive=1`
//!   (`truncated` when over 100,000 entries or 7 MB; symlinks are blobs with mode `120000`),
//!   `GET .../git/blobs/{file_sha}` (raw with `application/vnd.github.raw+json`),
//!   `POST .../git/blobs` (`content`, `encoding` utf-8 or base64), `POST .../git/trees`
//!   (`base_tree`, `tree[]` of `path`, `mode`, `type`, `sha`), `POST .../git/commits`
//!   (`message`, `tree`, `parents`; author and committer default to the authenticated App),
//!   `POST .../git/refs` (`ref` fully qualified, `sha`), `PATCH .../git/refs/{ref}` (`sha`,
//!   `force` default false) — <https://docs.github.com/en/rest/git>.
//! - Pulls: `GET .../pulls?state=open&head=owner:branch&base=...`, `POST .../pulls` (`title`,
//!   `head`, `base`, `body`), `PATCH .../pulls/{pull_number}` (`title`, `body`) —
//!   <https://docs.github.com/en/rest/pulls/pulls>.
//! - Checks: `POST .../check-runs`, `PATCH .../check-runs/{check_run_id}`; only GitHub Apps
//!   may create them — <https://docs.github.com/en/rest/checks/runs>.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use http::Method;
use serde::{Deserialize, Serialize};

use crate::client::{ACCEPT_RAW, Auth, GitHub, Op, Request};
use crate::error::GitHubError;
use crate::guard::{BranchName, RefUpdate, ThemePath, WritableBranch, check_theme_structure};
use crate::pr::{CheckRun, FileMode, PullRequestPlan};
use crate::token::TokenScope;
use crate::types::{CheckRunId, InstallationId, RepoRef, Sha};

/// A file in a theme directory that is safe to read: its path passed the [`ThemePath`]
/// allowlist and it is a regular blob, not a symlink or submodule, so reading it can never
/// follow a link out of the theme. Only [`Repository::tree`] creates one, so its blob id always
/// comes from GitHub's own listing of that path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeFile {
    path: ThemePath,
    sha: Sha,
    mode: FileMode,
}

impl ThemeFile {
    /// The path.
    #[must_use]
    pub fn path(&self) -> &ThemePath {
        &self.path
    }

    /// The blob.
    #[must_use]
    pub fn sha(&self) -> &Sha {
        &self.sha
    }

    /// Its mode.
    #[must_use]
    pub fn mode(&self) -> FileMode {
        self.mode
    }
}

/// A recursive listing of one commit's tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositoryTree {
    /// The commit's root tree.
    pub tree: Sha,
    /// Every blob path, for the theme structure check.
    pub paths: Vec<String>,
    /// The blobs Rampsmith may read.
    pub theme_files: Vec<ThemeFile>,
}

/// One entry of a tree Rampsmith creates. Only theme paths can be written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    /// The file.
    pub path: ThemePath,
    /// Its mode.
    pub mode: FileMode,
    /// The blob holding its new content.
    pub blob: Sha,
}

/// A fix pull request, as GitHub reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRequest {
    /// The global id.
    pub id: u64,
    /// The number within the repository.
    pub number: u64,
    /// Its page.
    pub html_url: String,
    /// The head commit.
    pub head_sha: Sha,
}

#[derive(Deserialize)]
struct ShaOnly {
    sha: Sha,
}

#[derive(Deserialize)]
struct RefResponse {
    object: ShaOnly,
}

#[derive(Deserialize)]
struct CommitResponse {
    tree: ShaOnly,
}

#[derive(Deserialize)]
struct TreeResponse {
    truncated: bool,
    tree: Vec<TreeItem>,
}

#[derive(Deserialize)]
struct TreeItem {
    path: String,
    mode: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
}

#[derive(Deserialize)]
struct PullHead {
    sha: Sha,
}

#[derive(Deserialize)]
struct PullResponse {
    id: u64,
    number: u64,
    html_url: String,
    head: PullHead,
}

impl From<PullResponse> for PullRequest {
    fn from(p: PullResponse) -> Self {
        Self {
            id: p.id,
            number: p.number,
            html_url: p.html_url,
            head_sha: p.head.sha,
        }
    }
}

#[derive(Deserialize)]
struct IdOnly {
    id: u64,
}

#[derive(Serialize)]
struct NewBlob<'a> {
    content: &'a str,
    encoding: &'static str,
}

#[derive(Serialize)]
struct NewTreeItem<'a> {
    path: &'a str,
    mode: &'static str,
    #[serde(rename = "type")]
    kind: &'static str,
    sha: &'a str,
}

#[derive(Serialize)]
struct NewTree<'a> {
    base_tree: &'a str,
    tree: Vec<NewTreeItem<'a>>,
}

#[derive(Serialize)]
struct NewCommit<'a> {
    message: &'a str,
    tree: &'a str,
    parents: [&'a str; 1],
}

#[derive(Serialize)]
struct NewRef<'a> {
    #[serde(rename = "ref")]
    reference: String,
    sha: &'a str,
}

#[derive(Serialize)]
struct MoveRef<'a> {
    sha: &'a str,
    force: bool,
}

#[derive(Serialize)]
struct NewPull<'a> {
    title: &'a str,
    head: &'a str,
    base: &'a str,
    body: &'a str,
}

#[derive(Serialize)]
struct EditPull<'a> {
    title: &'a str,
    body: &'a str,
}

/// A check run update: everything but `head_sha`, which the update endpoint does not take.
#[derive(Serialize)]
struct CheckRunUpdate<'a> {
    name: &'a str,
    status: &'a str,
    conclusion: crate::pr::Conclusion,
    completed_at: &'a str,
    details_url: &'a str,
    external_id: &'a str,
    output: &'a crate::pr::CheckOutput,
}

/// One repository, acting as one installation with one token scope.
#[derive(Debug)]
pub struct Repository<'a> {
    github: &'a GitHub,
    installation: InstallationId,
    repo: RepoRef,
    scope: TokenScope,
}

impl GitHub {
    /// Operations on `repo` as `installation`, with tokens narrowed to `scope`.
    #[must_use]
    pub fn repository(
        &self,
        installation: InstallationId,
        repo: RepoRef,
        scope: TokenScope,
    ) -> Repository<'_> {
        Repository {
            github: self,
            installation,
            repo,
            scope,
        }
    }
}

impl Repository<'_> {
    fn path(&self, rest: &str) -> String {
        format!("/repos/{}/{}{rest}", self.repo.owner(), self.repo.name())
    }

    fn request(&self, op: Op, method: Method, rest: &str) -> Request<'_> {
        Request::new(
            op,
            method,
            self.path(rest),
            Auth::Installation(self.installation, &self.scope),
        )
    }

    /// The commit a branch points at, or `None` when the branch does not exist.
    pub async fn branch_head(&self, branch: &BranchName) -> Result<Option<Sha>, GitHubError> {
        let request = self.request(Op::GetRef, Method::GET, &format!("/git/ref/heads/{branch}"));
        match self.github.send(request).await {
            Ok(response) => Ok(Some(response.decode::<RefResponse>()?.object.sha)),
            Err(GitHubError::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// A commit's root tree.
    pub async fn commit_tree(&self, commit: &Sha) -> Result<Sha, GitHubError> {
        let request = self.request(
            Op::GetCommit,
            Method::GET,
            &format!("/git/commits/{commit}"),
        );
        Ok(self
            .github
            .send(request)
            .await?
            .decode::<CommitResponse>()?
            .tree
            .sha)
    }

    /// Lists a commit's files. A truncated listing is an error, because a partial listing
    /// could pass or fail the theme check wrongly.
    pub async fn tree(&self, commit: &Sha) -> Result<RepositoryTree, GitHubError> {
        let tree = self.commit_tree(commit).await?;
        let request = self
            .request(Op::GetTree, Method::GET, &format!("/git/trees/{tree}"))
            .query("recursive", "1");
        let listing: TreeResponse = self.github.send(request).await?.decode()?;
        if listing.truncated {
            return Err(GitHubError::TreeTruncated);
        }
        let mut paths = Vec::new();
        let mut theme_files = Vec::new();
        for item in listing.tree {
            if item.kind != "blob" {
                continue;
            }
            let mode = match item.mode.as_str() {
                "100644" => Some(FileMode::Regular),
                "100755" => Some(FileMode::Executable),
                _ => None,
            };
            if let (Some(mode), Ok(path), Ok(sha)) =
                (mode, ThemePath::parse(&item.path), Sha::parse(&item.sha))
            {
                theme_files.push(ThemeFile { path, sha, mode });
            }
            paths.push(item.path);
        }
        Ok(RepositoryTree {
            tree,
            paths,
            theme_files,
        })
    }

    /// Lists a commit's files and confirms the default Shopify theme structure at the root.
    pub async fn theme_tree(&self, commit: &Sha) -> Result<RepositoryTree, GitHubError> {
        let tree = self.tree(commit).await?;
        check_theme_structure(tree.paths.iter().map(String::as_str))?;
        Ok(tree)
    }

    /// Reads one theme file's bytes. Only a [`ThemeFile`] from [`Self::tree`] is accepted.
    pub async fn read_theme_file(&self, file: &ThemeFile) -> Result<Vec<u8>, GitHubError> {
        let request = self
            .request(
                Op::GetBlob,
                Method::GET,
                &format!("/git/blobs/{}", file.sha),
            )
            .accept(ACCEPT_RAW);
        Ok(self.github.send(request).await?.body.to_vec())
    }

    /// Stores content as a blob, base64-encoded so bytes arrive exactly as given.
    pub async fn create_blob(&self, content: &[u8]) -> Result<Sha, GitHubError> {
        let encoded = STANDARD.encode(content);
        let request = self
            .request(Op::CreateBlob, Method::POST, "/git/blobs")
            .json(&NewBlob {
                content: &encoded,
                encoding: "base64",
            })?;
        Ok(self.github.send(request).await?.decode::<ShaOnly>()?.sha)
    }

    /// A tree that is `base_tree` with `entries` replaced or added.
    pub async fn create_tree(
        &self,
        base_tree: &Sha,
        entries: &[TreeEntry],
    ) -> Result<Sha, GitHubError> {
        if entries.is_empty() {
            return Err(GitHubError::InvalidRequest(
                "a fix tree changes at least one file",
            ));
        }
        let tree = entries
            .iter()
            .map(|e| NewTreeItem {
                path: e.path.as_str(),
                mode: e.mode.as_str(),
                kind: "blob",
                sha: e.blob.as_str(),
            })
            .collect();
        let request = self
            .request(Op::CreateTree, Method::POST, "/git/trees")
            .json(&NewTree {
                base_tree: base_tree.as_str(),
                tree,
            })?;
        Ok(self.github.send(request).await?.decode::<ShaOnly>()?.sha)
    }

    /// A commit of `tree` on `parent`. Author and committer are left to GitHub, which uses the
    /// App.
    pub async fn create_commit(
        &self,
        message: &str,
        tree: &Sha,
        parent: &Sha,
    ) -> Result<Sha, GitHubError> {
        let request = self
            .request(Op::CreateCommit, Method::POST, "/git/commits")
            .json(&NewCommit {
                message,
                tree: tree.as_str(),
                parents: [parent.as_str()],
            })?;
        Ok(self.github.send(request).await?.decode::<ShaOnly>()?.sha)
    }

    /// Points a `rampsmith/` branch at `sha`: creates it when absent, leaves it when already
    /// there, and otherwise moves it, forcing only for [`RefUpdate::Rederive`].
    pub async fn set_branch(
        &self,
        branch: &WritableBranch,
        sha: &Sha,
        update: RefUpdate,
    ) -> Result<(), GitHubError> {
        match self.branch_head(branch.as_branch()).await? {
            None => {
                let request = self
                    .request(Op::CreateRef, Method::POST, "/git/refs")
                    .json(&NewRef {
                        reference: format!("refs/heads/{branch}"),
                        sha: sha.as_str(),
                    })?;
                self.github.send(request).await?;
            }
            Some(current) if current == *sha => {}
            Some(_) => {
                let request = self
                    .request(
                        Op::UpdateRef,
                        Method::PATCH,
                        &format!("/git/refs/heads/{branch}"),
                    )
                    .json(&MoveRef {
                        sha: sha.as_str(),
                        force: update.force(),
                    })?;
                self.github.send(request).await?;
            }
        }
        Ok(())
    }

    /// Builds the plan's commits on `base`, one per fix, then points the plan's head branch at
    /// the last one. Returns the head commit.
    pub async fn push(
        &self,
        plan: &PullRequestPlan,
        base: &Sha,
        update: RefUpdate,
    ) -> Result<Sha, GitHubError> {
        let mut tree = self.commit_tree(base).await?;
        let mut parent = base.clone();
        for commit in &plan.commits {
            let mut entries = Vec::with_capacity(commit.changes.len());
            for change in &commit.changes {
                entries.push(TreeEntry {
                    path: change.path.clone(),
                    mode: change.mode,
                    blob: self.create_blob(change.content.as_bytes()).await?,
                });
            }
            tree = self.create_tree(&tree, &entries).await?;
            parent = self.create_commit(&commit.message, &tree, &parent).await?;
        }
        self.set_branch(&plan.head, &parent, update).await?;
        Ok(parent)
    }

    /// Opens the plan's pull request into `base`, or updates the title and body of the open
    /// one with the same head.
    pub async fn open_or_update_pull_request(
        &self,
        plan: &PullRequestPlan,
        base: &BranchName,
    ) -> Result<PullRequest, GitHubError> {
        // The base may differ from the branch the plan was checked against.
        let head = WritableBranch::new(plan.head.as_str(), base.as_str())?;
        let list = self
            .request(Op::ListPulls, Method::GET, "/pulls")
            .query("state", "open")
            .query("head", format!("{}:{head}", self.repo.owner()))
            .query("base", base.as_str());
        let open: Vec<PullResponse> = self.github.send(list).await?.decode()?;
        let request = match open.first() {
            Some(existing) => self
                .request(
                    Op::UpdatePull,
                    Method::PATCH,
                    &format!("/pulls/{}", existing.number),
                )
                .json(&EditPull {
                    title: &plan.title,
                    body: &plan.body,
                })?,
            None => self
                .request(Op::CreatePull, Method::POST, "/pulls")
                .json(&NewPull {
                    title: &plan.title,
                    head: head.as_str(),
                    base: base.as_str(),
                    body: &plan.body,
                })?,
        };
        Ok(self
            .github
            .send(request)
            .await?
            .decode::<PullResponse>()?
            .into())
    }

    /// Creates the verification check run.
    pub async fn create_check_run(&self, run: &CheckRun) -> Result<CheckRunId, GitHubError> {
        let request = self
            .request(Op::CreateCheckRun, Method::POST, "/check-runs")
            .json(run)?;
        Ok(CheckRunId::new(
            self.github.send(request).await?.decode::<IdOnly>()?.id,
        ))
    }

    /// Updates an existing check run with a new result.
    pub async fn update_check_run(
        &self,
        id: CheckRunId,
        run: &CheckRun,
    ) -> Result<(), GitHubError> {
        let request = self
            .request(
                Op::UpdateCheckRun,
                Method::PATCH,
                &format!("/check-runs/{}", id.get()),
            )
            .json(&CheckRunUpdate {
                name: run.name,
                status: run.status,
                conclusion: run.conclusion,
                completed_at: &run.completed_at,
                details_url: &run.details_url,
                external_id: &run.external_id,
                output: &run.output,
            })?;
        self.github.send(request).await?;
        Ok(())
    }

    /// Updates the check run when one exists, otherwise creates it.
    pub async fn upsert_check_run(
        &self,
        existing: Option<CheckRunId>,
        run: &CheckRun,
    ) -> Result<CheckRunId, GitHubError> {
        match existing {
            Some(id) => self.update_check_run(id, run).await.map(|()| id),
            None => self.create_check_run(run).await,
        }
    }
}
