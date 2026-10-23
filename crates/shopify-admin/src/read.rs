//! The read operations (ADR-081). Every field below was checked on shopify.dev for 2026-10 or
//! `latest` on 22 Oct 2026; ADR-081 lists what each page confirmed and what it did not show.
//!
//! The wire types are camelCase as Shopify sends them; the public types are `snake_case` and
//! are what `ctl` stores in `scan_inputs.payload` for the engine (ADR-081 defines each kind).

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::AdminClient;
use crate::client::Query;
use crate::error::AdminError;

/// How many connection nodes a page asks for. Costs are `2 + first x (1 + children)`, kept far
/// under the 1,000-point ceiling for one query.
pub const PAGE_SIZE: u32 = 20;
/// Media per product in one page; more is reported through `media_truncated`.
pub const MEDIA_PER_PRODUCT: u32 = 20;

const SHOP: Query = Query {
    name: "RampsmithShop",
    cost_hint: 6.0,
    text: r"query RampsmithShop {
  shop { id name myshopifyDomain primaryDomain { host url } }
  shopLocales { locale primary published }
  themes(first: 1, roles: [MAIN]) { nodes { id name role updatedAt } }
}",
};

/// The owner's address, in a query of its own so that a store that will not show it (a missing
/// grant, a changed field) still has its shop, locales and theme read (audit L4, ADR-277).
const SHOP_OWNER: Query = Query {
    name: "RampsmithShopOwner",
    cost_hint: 1.0,
    text: r"query RampsmithShopOwner {
  shop { email }
}",
};

/// The grant check: the smallest query that needs no access scope, so only a dead grant (or an
/// outage) can make it fail. Shopify's own `shopify-app-express` package proves a token the
/// same way, with `{ shop { name } }`, and reads only a 401 as "re-authenticate".
const GRANT: Query = Query {
    name: "RampsmithGrant",
    cost_hint: 1.0,
    text: r"query RampsmithGrant {
  shop { id }
}",
};

const PRODUCTS: Query = Query {
    name: "RampsmithProducts",
    cost_hint: 520.0,
    text: r"query RampsmithProducts($first: Int!, $after: String, $media: Int!) {
  products(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle status descriptionHtml onlineStoreUrl templateSuffix
      media(first: $media) {
        pageInfo { hasNextPage }
        nodes {
          __typename id alt
          ... on MediaImage { status image { url width height } }
        }
      }
    }
  }
}",
};

const OWNER: Query = Query {
    name: "RampsmithOwner",
    cost_hint: 30.0,
    text: r"query RampsmithOwner($id: ID!, $media: Int!) {
  node(id: $id) {
    __typename id
    ... on Product {
      title handle status descriptionHtml onlineStoreUrl templateSuffix
      media(first: $media) {
        pageInfo { hasNextPage }
        nodes {
          __typename id alt
          ... on MediaImage { status image { url width height } }
        }
      }
    }
    ... on Collection {
      title handle descriptionHtml templateSuffix image { url altText width height }
    }
    ... on Page { title handle body isPublished templateSuffix }
  }
}",
};

const COLLECTIONS: Query = Query {
    name: "RampsmithCollections",
    cost_hint: 60.0,
    text: r"query RampsmithCollections($first: Int!, $after: String) {
  collections(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle descriptionHtml templateSuffix image { url altText width height } }
  }
}",
};

const PAGES: Query = Query {
    name: "RampsmithPages",
    cost_hint: 50.0,
    text: r"query RampsmithPages($first: Int!, $after: String) {
  pages(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle body isPublished templateSuffix updatedAt }
  }
}",
};

const ARTICLES: Query = Query {
    name: "RampsmithArticles",
    cost_hint: 80.0,
    text: r"query RampsmithArticles($first: Int!, $after: String) {
  articles(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle body summary isPublished templateSuffix blog { handle } image { url altText width height } }
  }
}",
};

const MENUS: Query = Query {
    name: "RampsmithMenus",
    cost_hint: 120.0,
    text: r"query RampsmithMenus($first: Int!, $after: String) {
  menus(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id handle title
      items { id title url type items { id title url type items { id title url type } } }
    }
  }
}",
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    #[serde(default)]
    end_cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection<T> {
    page_info: PageInfo,
    nodes: Vec<T>,
}

/// One page of a connection, with where to continue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Page<T> {
    /// The nodes.
    pub items: Vec<T>,
    /// The cursor to pass as `after` for the next page, when there is one.
    pub next: Option<String>,
}

fn paged<T>(connection: Connection<T>) -> Page<T> {
    let next = if connection.page_info.has_next_page {
        connection.page_info.end_cursor
    } else {
        None
    };
    Page {
        items: connection.nodes,
        next,
    }
}

/// The shop owner's email address. Personal data: `Debug` never prints it, so a `{:?}` of the
/// shop that holds it (a log line, a panic message) cannot leak it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OwnerEmail(String);

impl OwnerEmail {
    /// The address, as Shopify wrote it.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for OwnerEmail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OwnerEmail(..)")
    }
}

/// The shop, its locales and its live theme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShopInfo {
    /// The shop's GID.
    pub gid: String,
    /// The shop's name.
    pub name: String,
    /// The shop owner's address, for the emails Rampsmith sends about the shop (ADR-272). It is
    /// personal data: callers store it in `shop_contacts` and never log it, and it is never
    /// serialised (the shop is stored as a scan input for the engine, which does not need it).
    /// `None` when Shopify reported none or the separate read of it failed.
    #[serde(skip_serializing)]
    pub email: Option<OwnerEmail>,
    /// The permanent `*.myshopify.com` host.
    pub myshopify_domain: String,
    /// The primary domain, when the shop has one.
    pub primary_domain: Option<Domain>,
    /// The shop's locales.
    pub locales: Vec<Locale>,
    /// The published (MAIN) theme. Read only; Rampsmith never writes a theme (ADR-004).
    pub live_theme: Option<Theme>,
}

/// A domain of the shop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Domain {
    /// The host.
    pub host: String,
    /// The `https://` URL.
    pub url: String,
}

/// A locale of the shop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Locale {
    /// The ISO code, such as `en` or `pt-BR`.
    pub locale: String,
    /// Whether it is the default.
    pub primary: bool,
    /// Whether buyers can see it.
    pub published: bool,
}

/// A theme, by identity only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Theme {
    /// The theme's GID.
    pub gid: String,
    /// Its name.
    pub name: String,
    /// Its role, such as `MAIN`.
    pub role: String,
    /// When it last changed.
    pub updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShopWire {
    shop: ShopNode,
    #[serde(default)]
    shop_locales: Vec<Locale>,
    themes: Connection2<ThemeWire>,
}

#[derive(Debug, Deserialize)]
struct ShopOwnerWire {
    shop: ShopOwnerNode,
}

#[derive(Debug, Deserialize)]
struct ShopOwnerNode {
    #[serde(default)]
    email: Option<OwnerEmail>,
}

#[derive(Debug, Deserialize)]
struct Connection2<T> {
    nodes: Vec<T>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShopNode {
    id: String,
    name: String,
    myshopify_domain: String,
    #[serde(default)]
    primary_domain: Option<Domain>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThemeWire {
    id: String,
    name: String,
    role: String,
    #[serde(default)]
    updated_at: Option<String>,
}

/// An image, as the storefront shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageRef {
    /// The CDN URL.
    pub url: String,
    /// The image's own alt text, where the object has one.
    #[serde(default, alias = "altText")]
    pub alt_text: Option<String>,
    /// Width in pixels.
    #[serde(default)]
    pub width: Option<u32>,
    /// Height in pixels.
    #[serde(default)]
    pub height: Option<u32>,
}

/// A product with its media.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Product {
    /// The product's GID.
    pub gid: String,
    /// Its title.
    pub title: String,
    /// Its handle.
    pub handle: String,
    /// `ACTIVE`, `DRAFT` or `ARCHIVED`; only active products show on the storefront.
    pub status: String,
    /// Its description as HTML.
    pub description_html: String,
    /// The storefront URL, when the product is published to the online store.
    pub online_store_url: Option<String>,
    /// The theme template suffix, when the resource uses an alternate template.
    pub template_suffix: Option<String>,
    /// Its media, first page.
    pub media: Vec<MediaItem>,
    /// Whether the product has more media than were read.
    pub media_truncated: bool,
}

/// One media item of a product.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MediaItem {
    /// The media GID; for an image, a `MediaImage`.
    pub gid: String,
    /// `MediaImage`, `Video`, `ExternalVideo` or `Model3d`.
    pub kind: String,
    /// The alt text; `None` when unset.
    pub alt: Option<String>,
    /// `READY` and so on, for images; alt text can be written only when `READY`.
    pub status: Option<String>,
    /// The image, once `READY`.
    pub image: Option<ImageRef>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductWire {
    id: String,
    title: String,
    handle: String,
    status: String,
    description_html: String,
    #[serde(default)]
    online_store_url: Option<String>,
    #[serde(default)]
    template_suffix: Option<String>,
    media: MediaWire,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaWire {
    page_info: MediaPageInfo,
    nodes: Vec<MediaNodeWire>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaPageInfo {
    has_next_page: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaNodeWire {
    #[serde(rename = "__typename")]
    typename: String,
    id: String,
    #[serde(default)]
    alt: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    image: Option<ImageRef>,
}

impl From<ProductWire> for Product {
    fn from(p: ProductWire) -> Self {
        Self {
            gid: p.id,
            title: p.title,
            handle: p.handle,
            status: p.status,
            description_html: p.description_html,
            online_store_url: p.online_store_url,
            template_suffix: p.template_suffix,
            media_truncated: p.media.page_info.has_next_page,
            media: p
                .media
                .nodes
                .into_iter()
                .map(|m| MediaItem {
                    gid: m.id,
                    kind: m.typename,
                    alt: m.alt,
                    status: m.status,
                    image: m.image,
                })
                .collect(),
        }
    }
}

/// A collection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Collection {
    /// The collection's GID.
    pub gid: String,
    /// Its title.
    pub title: String,
    /// Its handle.
    pub handle: String,
    /// Its description as HTML.
    pub description_html: String,
    /// Its image, with the alt text it carries.
    pub image: Option<ImageRef>,
    /// The theme template suffix, when the resource uses an alternate template.
    pub template_suffix: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionWire {
    id: String,
    title: String,
    handle: String,
    description_html: String,
    #[serde(default)]
    image: Option<ImageRef>,
    #[serde(default)]
    template_suffix: Option<String>,
}

/// A page of the online store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShopPage {
    /// The page's GID.
    pub gid: String,
    /// Its title.
    pub title: String,
    /// Its handle.
    pub handle: String,
    /// Its body as HTML.
    pub body: String,
    /// Whether it is visible.
    pub is_published: bool,
    /// The theme template suffix, when the resource uses an alternate template.
    pub template_suffix: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageWire {
    id: String,
    title: String,
    handle: String,
    body: String,
    is_published: bool,
    #[serde(default)]
    template_suffix: Option<String>,
}

/// A blog article.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Article {
    /// The article's GID.
    pub gid: String,
    /// Its title.
    pub title: String,
    /// Its handle.
    pub handle: String,
    /// The handle of its blog.
    pub blog_handle: String,
    /// Its body as HTML.
    pub body: String,
    /// Its summary as HTML.
    pub summary: Option<String>,
    /// Whether it is visible.
    pub is_published: bool,
    /// Its image.
    pub image: Option<ImageRef>,
    /// The theme template suffix, when the resource uses an alternate template.
    pub template_suffix: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArticleWire {
    id: String,
    title: String,
    handle: String,
    body: String,
    #[serde(default)]
    summary: Option<String>,
    is_published: bool,
    blog: BlogWire,
    #[serde(default)]
    image: Option<ImageRef>,
    #[serde(default)]
    template_suffix: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BlogWire {
    handle: String,
}

impl From<ArticleWire> for Article {
    fn from(a: ArticleWire) -> Self {
        Self {
            gid: a.id,
            title: a.title,
            handle: a.handle,
            blog_handle: a.blog.handle,
            body: a.body,
            summary: a.summary,
            is_published: a.is_published,
            image: a.image,
            template_suffix: a.template_suffix,
        }
    }
}

/// A navigation menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Menu {
    /// The menu's GID.
    pub gid: String,
    /// Its handle, such as `main-menu`.
    pub handle: String,
    /// Its title.
    pub title: String,
    /// Its items, three levels deep at most.
    pub items: Vec<MenuItem>,
}

/// An item of a menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MenuItem {
    /// The item's GID.
    pub gid: String,
    /// The link text.
    pub title: String,
    /// Where it points.
    pub url: Option<String>,
    /// `HTTP`, `COLLECTION`, `PRODUCT` and so on.
    #[serde(rename = "type")]
    pub kind: String,
    /// Child items.
    pub items: Vec<MenuItem>,
}

#[derive(Debug, Deserialize)]
struct MenuWire {
    id: String,
    handle: String,
    title: String,
    #[serde(default)]
    items: Vec<MenuItemWire>,
}

#[derive(Debug, Deserialize)]
struct MenuItemWire {
    id: String,
    title: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    items: Vec<MenuItemWire>,
}

impl From<MenuItemWire> for MenuItem {
    fn from(i: MenuItemWire) -> Self {
        Self {
            gid: i.id,
            title: i.title,
            url: i.url,
            kind: i.kind,
            items: i.items.into_iter().map(Self::from).collect(),
        }
    }
}

impl From<MenuWire> for Menu {
    fn from(m: MenuWire) -> Self {
        Self {
            gid: m.id,
            handle: m.handle,
            title: m.title,
            items: m.items.into_iter().map(MenuItem::from).collect(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ProductsData {
    products: Connection<ProductWire>,
}
#[derive(Debug, Deserialize)]
struct CollectionsData {
    collections: Connection<CollectionWire>,
}
#[derive(Debug, Deserialize)]
struct PagesData {
    pages: Connection<PageWire>,
}
#[derive(Debug, Deserialize)]
struct ArticlesData {
    articles: Connection<ArticleWire>,
}
#[derive(Debug, Deserialize)]
struct MenusData {
    menus: Connection<MenuWire>,
}

/// A resource that holds the field a data fix changes, as read again after the write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Owner {
    /// A product, with its media.
    Product(Product),
    /// A collection.
    Collection(Collection),
    /// A page.
    Page(ShopPage),
}

impl Owner {
    /// The handle, which names the storefront URL.
    #[must_use]
    pub fn handle(&self) -> &str {
        match self {
            Self::Product(p) => &p.handle,
            Self::Collection(c) => &c.handle,
            Self::Page(p) => &p.handle,
        }
    }

    /// The storefront path: `/products/<handle>` and so on.
    #[must_use]
    pub fn path(&self) -> String {
        let (dir, handle) = match self {
            Self::Product(p) => ("products", &p.handle),
            Self::Collection(c) => ("collections", &c.handle),
            Self::Page(p) => ("pages", &p.handle),
        };
        format!("/{dir}/{handle}")
    }
}

#[derive(Debug, Deserialize)]
struct OwnerData {
    node: Option<OwnerWire>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerWire {
    #[serde(rename = "__typename")]
    typename: String,
    id: String,
    title: Option<String>,
    handle: Option<String>,
    status: Option<String>,
    description_html: Option<String>,
    online_store_url: Option<String>,
    template_suffix: Option<String>,
    media: Option<MediaWire>,
    image: Option<ImageRef>,
    body: Option<String>,
    is_published: Option<bool>,
}

fn variables(first: u32, after: Option<&str>) -> serde_json::Value {
    json!({ "first": first, "after": after })
}

#[derive(Debug, Deserialize)]
struct GrantWire {
    #[allow(dead_code, reason = "read only to prove the answer is a shop")]
    shop: GrantShop,
}

#[derive(Debug, Deserialize)]
struct GrantShop {
    #[allow(dead_code, reason = "read only to prove the answer is a shop")]
    id: String,
}

impl AdminClient {
    /// Whether the access token still works: `Ok` when Shopify answers a `shop { id }` query,
    /// [`AdminError::Unauthorized`] (HTTP 401) when the grant is gone. Used before an
    /// unsigned `app/uninstalled` or `shop/redact` is allowed to change an installed shop.
    pub async fn grant_check(&self) -> Result<(), AdminError> {
        let _: GrantWire = self.run(&GRANT, &json!({})).await?;
        Ok(())
    }

    /// The shop, its locales and its live theme. Also the cheapest call that proves the access
    /// token still works.
    pub async fn shop(&self) -> Result<ShopInfo, AdminError> {
        let data: ShopWire = self.run(&SHOP, &json!({})).await?;
        // A failure of this second read is "none reported": the shop itself was read (audit L4).
        let owner: Result<ShopOwnerWire, AdminError> = self.run(&SHOP_OWNER, &json!({})).await;
        let email = owner.ok().and_then(|owner| owner.shop.email);
        Ok(ShopInfo {
            gid: data.shop.id,
            name: data.shop.name,
            email,
            myshopify_domain: data.shop.myshopify_domain,
            primary_domain: data.shop.primary_domain,
            locales: data.shop_locales,
            live_theme: data.themes.nodes.into_iter().next().map(|t| Theme {
                gid: t.id,
                name: t.name,
                role: t.role,
                updated_at: t.updated_at,
            }),
        })
    }

    /// One page of products with their media, in id order.
    pub async fn products(&self, after: Option<&str>) -> Result<Page<Product>, AdminError> {
        let mut vars = variables(PAGE_SIZE, after);
        if let Some(map) = vars.as_object_mut() {
            map.insert("media".to_owned(), json!(MEDIA_PER_PRODUCT));
        }
        let data: ProductsData = self.run(&PRODUCTS, &vars).await?;
        Ok(paged(Connection {
            page_info: data.products.page_info,
            nodes: data.products.nodes.into_iter().map(Product::from).collect(),
        }))
    }

    /// The product, collection or page `gid`, read again. [`AdminError::ResourceMissing`] when it
    /// is gone or is another kind of object.
    pub async fn owner(&self, gid: &str) -> Result<Owner, AdminError> {
        let data: OwnerData = self
            .run(&OWNER, &json!({ "id": gid, "media": MEDIA_PER_PRODUCT }))
            .await?;
        let node = data.node.ok_or(AdminError::ResourceMissing)?;
        if node.id != gid {
            return Err(AdminError::ResourceMissing);
        }
        let (Some(title), Some(handle)) = (node.title, node.handle) else {
            return Err(AdminError::ResourceMissing);
        };
        match node.typename.as_str() {
            "Product" => {
                let media = node.media.ok_or(AdminError::Decode)?;
                Ok(Owner::Product(Product::from(ProductWire {
                    id: node.id,
                    title,
                    handle,
                    status: node.status.ok_or(AdminError::Decode)?,
                    description_html: node.description_html.unwrap_or_default(),
                    online_store_url: node.online_store_url,
                    template_suffix: node.template_suffix,
                    media,
                })))
            }
            "Collection" => Ok(Owner::Collection(Collection {
                gid: node.id,
                title,
                handle,
                description_html: node.description_html.unwrap_or_default(),
                image: node.image,
                template_suffix: node.template_suffix,
            })),
            "Page" => Ok(Owner::Page(ShopPage {
                gid: node.id,
                title,
                handle,
                body: node.body.unwrap_or_default(),
                is_published: node.is_published.unwrap_or(false),
                template_suffix: node.template_suffix,
            })),
            _ => Err(AdminError::ResourceMissing),
        }
    }

    /// One page of collections.
    pub async fn collections(&self, after: Option<&str>) -> Result<Page<Collection>, AdminError> {
        let data: CollectionsData = self
            .run(&COLLECTIONS, &variables(PAGE_SIZE * 2, after))
            .await?;
        Ok(paged(Connection {
            page_info: data.collections.page_info,
            nodes: data
                .collections
                .nodes
                .into_iter()
                .map(|c| Collection {
                    gid: c.id,
                    title: c.title,
                    handle: c.handle,
                    description_html: c.description_html,
                    image: c.image,
                    template_suffix: c.template_suffix,
                })
                .collect(),
        }))
    }

    /// One page of online-store pages.
    pub async fn pages(&self, after: Option<&str>) -> Result<Page<ShopPage>, AdminError> {
        let data: PagesData = self.run(&PAGES, &variables(PAGE_SIZE * 2, after)).await?;
        Ok(paged(Connection {
            page_info: data.pages.page_info,
            nodes: data
                .pages
                .nodes
                .into_iter()
                .map(|p| ShopPage {
                    gid: p.id,
                    title: p.title,
                    handle: p.handle,
                    body: p.body,
                    is_published: p.is_published,
                    template_suffix: p.template_suffix,
                })
                .collect(),
        }))
    }

    /// One page of blog articles.
    pub async fn articles(&self, after: Option<&str>) -> Result<Page<Article>, AdminError> {
        let data: ArticlesData = self
            .run(&ARTICLES, &variables(PAGE_SIZE * 2, after))
            .await?;
        Ok(paged(Connection {
            page_info: data.articles.page_info,
            nodes: data.articles.nodes.into_iter().map(Article::from).collect(),
        }))
    }

    /// One page of navigation menus.
    pub async fn menus(&self, after: Option<&str>) -> Result<Page<Menu>, AdminError> {
        let data: MenusData = self.run(&MENUS, &variables(PAGE_SIZE, after)).await?;
        Ok(paged(Connection {
            page_info: data.menus.page_info,
            nodes: data.menus.nodes.into_iter().map(Menu::from).collect(),
        }))
    }
}
