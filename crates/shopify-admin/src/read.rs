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

const PRODUCTS: Query = Query {
    name: "RampsmithProducts",
    cost_hint: 520.0,
    text: r"query RampsmithProducts($first: Int!, $after: String, $media: Int!) {
  products(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title handle status descriptionHtml onlineStoreUrl
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

const COLLECTIONS: Query = Query {
    name: "RampsmithCollections",
    cost_hint: 60.0,
    text: r"query RampsmithCollections($first: Int!, $after: String) {
  collections(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle descriptionHtml image { url altText width height } }
  }
}",
};

const PAGES: Query = Query {
    name: "RampsmithPages",
    cost_hint: 50.0,
    text: r"query RampsmithPages($first: Int!, $after: String) {
  pages(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle body isPublished updatedAt }
  }
}",
};

const ARTICLES: Query = Query {
    name: "RampsmithArticles",
    cost_hint: 80.0,
    text: r"query RampsmithArticles($first: Int!, $after: String) {
  articles(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes { id title handle body summary isPublished blog { handle } image { url altText width height } }
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

/// The shop, its locales and its live theme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShopInfo {
    /// The shop's GID.
    pub gid: String,
    /// The shop's name.
    pub name: String,
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageWire {
    id: String,
    title: String,
    handle: String,
    body: String,
    is_published: bool,
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

fn variables(first: u32, after: Option<&str>) -> serde_json::Value {
    json!({ "first": first, "after": after })
}

impl AdminClient {
    /// The shop, its locales and its live theme. Also the cheapest call that proves the access
    /// token still works.
    pub async fn shop(&self) -> Result<ShopInfo, AdminError> {
        let data: ShopWire = self.run(&SHOP, &json!({})).await?;
        Ok(ShopInfo {
            gid: data.shop.id,
            name: data.shop.name,
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
