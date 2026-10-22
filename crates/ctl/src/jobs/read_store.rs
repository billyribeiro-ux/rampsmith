//! `shopify.read_store@1` (ADR-035, ADR-081): reads the store through the Admin API into
//! `scan_inputs`, then queues `audit.data@1` for each batch and `scan.plan@1` for the scan.
//!
//! The engine never holds a token; everything it knows about the store is what this handler
//! wrote. The read is all-or-nothing: batches and jobs are stored in one transaction after
//! every read succeeded, so a retry (the whole read is repeated) leaves no half-stored scan.
//! Storing a batch again replaces it and keeps its id, and each job has an idempotency key.

use std::future::Future;

use billing::entitlements::RenderSampling;
use billing::stored::{entitlements_of, state_of};
use contracts::{AuditData, ScanPlan, ShopifyReadStore};
use db::repo::{jobs as job_repo, scan_inputs, scans, shop_billing, shopify as shops};
use domain::{ScanId, ShopId, SiteId, TenantId};
use queue::{ClaimedJob, Failure, NewJob};
use serde_json::{Value, json};
use shopify_admin::{
    AdminClient, AdminError, Article, Collection, Menu, MenuItem, Owner, Page, Product, ShopInfo,
    ShopPage,
};
use tracing::{info, instrument};

use super::{Jobs, admin, database, failure, payload, tenant_of};

/// Most pages read of each kind. Products are 20 to a page and cost the most, so R1 reads at
/// most 1,000 products; the rest of a larger catalogue is reported as `truncated`.
const MAX_PRODUCT_PAGES: usize = 50;
const MAX_OTHER_PAGES: usize = 25;

/// Handles one `shopify.read_store@1` job.
#[instrument(skip_all, fields(job = %job.lease.job_id), err(Debug))]
pub async fn handle(jobs: &Jobs, job: ClaimedJob) -> Result<(), Failure> {
    let ShopifyReadStore {
        scan_id,
        site_id,
        shop_id,
    } = payload(&job, ShopifyReadStore::SCHEMA)?;
    let tenant = tenant_of(&job)?;
    let scan = ScanId::from_uuid(scan_id);
    let result = run(
        jobs,
        tenant,
        scan,
        SiteId::from_uuid(site_id),
        ShopId::from_uuid(shop_id),
    )
    .await;
    // A read that can never succeed ends the scan, so the merchant sees it fail instead of wait.
    if let Err(Failure::Permanent(error)) = &result {
        let code = error.code.clone();
        let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
        scans::fail(&mut tx, scan, &code)
            .await
            .map_err(|e| database(&e))?;
        tx.commit().await.map_err(|e| database(&e))?;
    }
    result
}

async fn run(
    jobs: &Jobs,
    tenant: TenantId,
    scan: ScanId,
    site: SiteId,
    shop: ShopId,
) -> Result<(), Failure> {
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let found = scans::get(&mut tx, scan).await.map_err(|e| database(&e))?;
    let shop_row = shops::get(&mut tx, shop).await.map_err(|e| database(&e))?;
    tx.rollback().await.map_err(|e| database(&e))?;
    let Some(found) = found.filter(|s| s.site_id == site) else {
        return Err(failure(
            false,
            "scan_not_found",
            "no such scan for this tenant",
        ));
    };
    if !matches!(
        found.status,
        domain::ScanStatus::Queued | domain::ScanStatus::Running
    ) {
        return Ok(());
    }
    if shop_row.is_none_or(|s| s.site_id != site) {
        return Err(failure(
            false,
            "shop_not_found",
            "no such shop for this site",
        ));
    }
    let Some(client) = jobs.client(tenant, shop).await? else {
        return Err(failure(
            false,
            "shop_not_connected",
            "the shop is not installed or its grant was revoked",
        ));
    };

    let data = StoreData::read(&client).await?;
    persist(jobs, tenant, scan, site, shop, &data).await
}

/// Everything one read returned.
struct StoreData {
    info: ShopInfo,
    products: Read<Product>,
    collections: Read<Collection>,
    pages: Read<ShopPage>,
    articles: Read<Article>,
    menus: Read<Menu>,
}

impl StoreData {
    async fn read(client: &AdminClient) -> Result<Self, Failure> {
        let info = client.shop().await.map_err(|e| admin(&e))?;
        let products = read_all(MAX_PRODUCT_PAGES, |after| async move {
            client.products(after.as_deref()).await
        })
        .await?;
        let collections = read_all(MAX_OTHER_PAGES, |after| async move {
            client.collections(after.as_deref()).await
        })
        .await?;
        let pages = read_all(MAX_OTHER_PAGES, |after| async move {
            client.pages(after.as_deref()).await
        })
        .await?;
        let articles = read_all(MAX_OTHER_PAGES, |after| async move {
            client.articles(after.as_deref()).await
        })
        .await?;
        let menus = read_all(MAX_OTHER_PAGES, |after| async move {
            client.menus(after.as_deref()).await
        })
        .await?;

        Ok(Self {
            info,
            products,
            collections,
            pages,
            articles,
            menus,
        })
    }
}

async fn persist(
    jobs: &Jobs,
    tenant: TenantId,
    scan: ScanId,
    site: SiteId,
    shop: ShopId,
    data: &StoreData,
) -> Result<(), Failure> {
    let StoreData {
        info,
        products,
        collections,
        pages,
        articles,
        menus,
    } = data;
    let summary = json!({
        "products": counted(products),
        "collections": counted(collections),
        "pages": counted(pages),
        "articles": counted(articles),
        "menus": counted(menus),
    });
    let mut tx = jobs.db.tenant(tenant).await.map_err(|e| database(&e))?;
    let mut stored = Stored { scan, site };
    stored
        .batches(
            &mut tx,
            "products",
            products.batches.iter().map(|b| products_payload(b)),
        )
        .await?;
    stored
        .batches(
            &mut tx,
            "collections",
            collections.batches.iter().map(|b| collections_payload(b)),
        )
        .await?;
    stored
        .batches(
            &mut tx,
            "pages",
            pages.batches.iter().map(|b| pages_payload(b)),
        )
        .await?;
    stored
        .batches(
            &mut tx,
            "articles",
            articles.batches.iter().map(|b| articles_payload(b)),
        )
        .await?;
    stored
        .batches(
            &mut tx,
            "menus",
            menus.batches.iter().map(|b| menus_payload(b)),
        )
        .await?;
    // The engine samples pages by the plan: Free's when no plan is confirmed (ADR-084).
    let granted = entitlements_of(&state_of(
        shop_billing::get(&mut tx, shop)
            .await
            .map_err(|e| database(&e))?
            .as_ref(),
    ));
    scan_inputs::put(
        &mut tx,
        scan,
        site,
        "shop",
        0,
        &shop_payload(info, &summary, granted.render_sampling()),
    )
    .await
    .map_err(|e| database(&e))?
    .ok_or_else(|| failure(false, "scan_not_found", "no such scan for this tenant"))?;
    let locales: Vec<String> = info.locales.iter().map(|l| l.locale.clone()).collect();
    shops::set_info(
        &mut tx,
        shop,
        info.primary_domain.as_ref().map(|d| d.host.as_str()),
        &locales,
    )
    .await
    .map_err(|e| database(&e))?;
    // Shopify's own id for the shop, which the Partner API names it by (ADR-084).
    shops::set_shop_gid(&mut tx, shop, &info.gid)
        .await
        .map_err(|e| database(&e))?;
    job_repo::enqueue(
        &mut tx,
        NewJob::new(
            ScanPlan::QUEUE,
            ScanPlan::SCHEMA,
            json!({"scan_id": scan.as_uuid(), "site_id": site.as_uuid()}),
        )
        .idempotency_key(format!("{}:{}", ScanPlan::QUEUE, scan.as_uuid())),
    )
    .await
    .map_err(|e| database(&e))?;
    tx.commit().await.map_err(|e| database(&e))?;
    info!(%scan, "store read");
    Ok(())
}

struct Read<T> {
    batches: Vec<Vec<T>>,
    truncated: bool,
}

fn counted<T>(read: &Read<T>) -> Value {
    json!({
        "items": read.batches.iter().map(Vec::len).sum::<usize>(),
        "batches": read.batches.len(),
        "truncated": read.truncated,
    })
}

/// Reads pages until the connection ends or `max` pages were read.
async fn read_all<T, F, Fut>(max: usize, mut fetch: F) -> Result<Read<T>, Failure>
where
    F: FnMut(Option<String>) -> Fut,
    Fut: Future<Output = Result<Page<T>, AdminError>>,
{
    let mut batches = Vec::new();
    let mut after = None;
    let mut truncated = false;
    loop {
        if batches.len() >= max {
            truncated = true;
            break;
        }
        let page = fetch(after).await.map_err(|e| admin(&e))?;
        if !page.items.is_empty() {
            batches.push(page.items);
        }
        match page.next {
            Some(next) => after = Some(next),
            None => break,
        }
    }
    Ok(Read { batches, truncated })
}

/// Where a scan's batches go.
struct Stored {
    scan: ScanId,
    site: SiteId,
}

impl Stored {
    /// Stores each payload as the next batch of `kind` and queues its audit.
    async fn batches(
        &mut self,
        tx: &mut db::TenantTx,
        kind: &str,
        payloads: impl Iterator<Item = Value>,
    ) -> Result<(), Failure> {
        for (seq, payload) in payloads.enumerate() {
            let seq = i32::try_from(seq).map_err(|_| failure(false, "too_many_batches", kind))?;
            let id = scan_inputs::put(tx, self.scan, self.site, kind, seq, &payload)
                .await
                .map_err(|e| database(&e))?
                .ok_or_else(|| failure(false, "scan_not_found", "no such scan for this tenant"))?;
            job_repo::enqueue(
                tx,
                NewJob::new(
                    AuditData::QUEUE,
                    AuditData::SCHEMA,
                    json!({
                        "scan_id": self.scan.as_uuid(),
                        "site_id": self.site.as_uuid(),
                        "input_id": id,
                    }),
                )
                .idempotency_key(format!("{}:{id}", AuditData::QUEUE)),
            )
            .await
            .map_err(|e| database(&e))?;
        }
        Ok(())
    }
}

/// The shop input: what the planner needs to choose pages.
fn sampling_payload(sampling: RenderSampling) -> Value {
    match sampling {
        RenderSampling::HomePagePlus { pages } => json!({"mode": "home_plus", "pages": pages}),
        RenderSampling::PerTemplate {
            samples,
            every_variant,
        } => json!({"mode": "per_template", "samples": samples, "every_variant": every_variant}),
    }
}

fn shop_payload(info: &ShopInfo, read: &Value, sampling: RenderSampling) -> Value {
    let primary = info
        .locales
        .iter()
        .find(|l| l.primary)
        .map(|l| l.locale.as_str());
    json!({
        "gid": info.gid,
        "name": info.name,
        "myshopify_domain": info.myshopify_domain,
        "primary_domain": info.primary_domain.as_ref().map(|d| d.host.as_str()),
        "primary_locale": primary,
        "locales": info.locales.iter().map(|l| json!({
            "locale": l.locale, "primary": l.primary, "published": l.published,
        })).collect::<Vec<_>>(),
        "live_theme": info.live_theme.as_ref().map(|t| json!({
            "gid": t.gid, "name": t.name, "updated_at": t.updated_at,
        })),
        "sampling": sampling_payload(sampling),
        "read": read,
    })
}

/// Products, with image media only: the audit is about image alt text, and a video or a 3D
/// model has none to check.
pub(super) fn products_payload(items: &[Product]) -> Value {
    json!({"items": items.iter().map(|p| json!({
        "id": p.gid,
        "handle": p.handle,
        "title": p.title,
        "status": p.status,
        "template_suffix": p.template_suffix,
        "description_html": p.description_html,
        "media_truncated": p.media_truncated,
        "media": p.media.iter().filter(|m| m.kind == "MediaImage").map(|m| {
            let url = m.image.as_ref().map(|i| i.url.as_str());
            json!({
                "id": m.gid,
                "alt": m.alt,
                "status": m.status,
                "url": url,
                "file_name": url.and_then(file_name),
            })
        }).collect::<Vec<_>>(),
    })).collect::<Vec<_>>()})
}

/// The batch a verification scan reads: the one owner, in the shape of its kind's batch, with
/// the `kind` named so the engine need not guess.
pub(super) fn owner_payload(owner: &Owner) -> Value {
    let (kind, mut batch) = match owner {
        Owner::Product(p) => ("products", products_payload(std::slice::from_ref(p))),
        Owner::Collection(c) => ("collections", collections_payload(std::slice::from_ref(c))),
        Owner::Page(p) => ("pages", pages_payload(std::slice::from_ref(p))),
    };
    if let Some(map) = batch.as_object_mut() {
        map.insert("kind".to_owned(), json!(kind));
    }
    batch
}

/// The last path segment of an image URL, without its query.
fn file_name(url: &str) -> Option<&str> {
    let path = url.split(['?', '#']).next()?;
    let name = path.rsplit('/').next()?;
    (!name.is_empty()).then_some(name)
}

pub(super) fn collections_payload(items: &[Collection]) -> Value {
    json!({"items": items.iter().map(|c| json!({
        "id": c.gid,
        "handle": c.handle,
        "title": c.title,
        "template_suffix": c.template_suffix,
        "description_html": c.description_html,
    })).collect::<Vec<_>>()})
}

pub(super) fn pages_payload(items: &[ShopPage]) -> Value {
    json!({"items": items.iter().map(|p| json!({
        "id": p.gid,
        "handle": p.handle,
        "title": p.title,
        "template_suffix": p.template_suffix,
        "is_published": p.is_published,
        "body": p.body,
    })).collect::<Vec<_>>()})
}

fn articles_payload(items: &[Article]) -> Value {
    json!({"items": items.iter().map(|a| json!({
        "id": a.gid,
        "handle": a.handle,
        "blog_handle": a.blog_handle,
        "title": a.title,
        "template_suffix": a.template_suffix,
        "is_published": a.is_published,
        "body": a.body,
    })).collect::<Vec<_>>()})
}

fn menus_payload(items: &[Menu]) -> Value {
    fn entries(items: &[MenuItem]) -> Vec<Value> {
        items
            .iter()
            .map(|i| {
                json!({
                    "id": i.gid,
                    "title": i.title,
                    "url": i.url,
                    "type": i.kind,
                    "items": entries(&i.items),
                })
            })
            .collect()
    }
    json!({"items": items.iter().map(|m| json!({
        "id": m.gid,
        "handle": m.handle,
        "title": m.title,
        "items": entries(&m.items),
    })).collect::<Vec<_>>()})
}

#[cfg(test)]
mod tests {
    use super::file_name;

    #[test]
    fn a_file_name_is_the_last_segment_without_query() {
        assert_eq!(
            file_name("https://cdn.shopify.com/s/files/1/a/IMG_0042.jpg?v=1700"),
            Some("IMG_0042.jpg")
        );
        assert_eq!(file_name("https://cdn.shopify.com/"), None);
    }
}
