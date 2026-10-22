//! The data-fix operations (ADR-082): read one field's live value, and write one.
//!
//! R1 writes four fields and nothing else, each through the mutation shopify.dev documents for
//! it (read 22 Oct 2026): media alt text through `fileUpdate` (`write_files`; "Files must be in
//! `ready` state before they can be updated"), a product description through `productUpdate`
//! (`product: ProductUpdateInput`, `write_products`), a collection description through
//! `collectionUpdate` (`collection: CollectionUpdateInput`, `write_products`), and a page body
//! through `pageUpdate` (`id`, `page: PageUpdateInput`, `write_content` or
//! `write_online_store_pages`). Never a theme file (ADR-004). Every mutation's `userErrors` is
//! checked: a non-empty list is [`AdminError::User`].

use std::fmt;

use serde::Deserialize;
use serde_json::json;

use crate::AdminClient;
use crate::client::Query;
use crate::error::{AdminError, UserError};

/// The four resource types R1 writes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceKind {
    /// An image of a product (`gid://shopify/MediaImage/<id>`).
    MediaImage,
    /// A product.
    Product,
    /// A collection.
    Collection,
    /// A page of the online store.
    Page,
}

/// A field of a resource that a data fix changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    /// A media image's alt text (`alt`).
    Alt,
    /// A product's or collection's description (`description_html`).
    DescriptionHtml,
    /// A page's body (`body`).
    Body,
}

impl Field {
    /// The name stored in `data_fix_snapshots.field`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Alt => "alt",
            Self::DescriptionHtml => "description_html",
            Self::Body => "body",
        }
    }
}

/// Why a GID and field cannot be a data fix target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum TargetError {
    /// The text is not a Shopify GID of a supported resource type.
    #[error("not a supported Shopify resource id")]
    Gid,
    /// The field is not one R1 writes on that resource type.
    #[error("that field cannot be fixed on that resource")]
    Field,
}

/// A validated `(resource, field)` pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    gid: String,
    kind: ResourceKind,
    field: Field,
}

impl Target {
    /// Validates `gid` (`gid://shopify/<Type>/<digits>`) and `field` (as stored:
    /// `alt`, `description_html`, `body`).
    pub fn parse(gid: &str, field: &str) -> Result<Self, TargetError> {
        let rest = gid.strip_prefix("gid://shopify/").ok_or(TargetError::Gid)?;
        let (kind, id) = rest.split_once('/').ok_or(TargetError::Gid)?;
        if id.is_empty() || id.len() > 20 || !id.bytes().all(|b| b.is_ascii_digit()) {
            return Err(TargetError::Gid);
        }
        let kind = match kind {
            "MediaImage" => ResourceKind::MediaImage,
            "Product" => ResourceKind::Product,
            "Collection" => ResourceKind::Collection,
            "Page" => ResourceKind::Page,
            _ => return Err(TargetError::Gid),
        };
        let field = match (kind, field) {
            (ResourceKind::MediaImage, "alt") => Field::Alt,
            (ResourceKind::Product | ResourceKind::Collection, "description_html") => {
                Field::DescriptionHtml
            }
            (ResourceKind::Page, "body") => Field::Body,
            _ => return Err(TargetError::Field),
        };
        Ok(Self {
            gid: gid.to_owned(),
            kind,
            field,
        })
    }

    /// The GID.
    #[must_use]
    pub fn gid(&self) -> &str {
        &self.gid
    }

    /// The resource type.
    #[must_use]
    pub const fn kind(&self) -> ResourceKind {
        self.kind
    }

    /// The field.
    #[must_use]
    pub const fn field(&self) -> Field {
        self.field
    }

    const fn typename(&self) -> &'static str {
        match self.kind {
            ResourceKind::MediaImage => "MediaImage",
            ResourceKind::Product => "Product",
            ResourceKind::Collection => "Collection",
            ResourceKind::Page => "Page",
        }
    }
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.gid, self.field.as_str())
    }
}

/// Whether two values of a field are the same for the purpose of "nothing changed since": an
/// unset alt text and an empty one are the same (Shopify returns `null` for an alt that was
/// cleared with an empty string).
#[must_use]
pub fn same_value(_field: Field, a: Option<&str>, b: Option<&str>) -> bool {
    a.unwrap_or("") == b.unwrap_or("")
}

const VALUE: Query = Query {
    name: "RampsmithNodeValue",
    cost_hint: 2.0,
    text: r"query RampsmithNodeValue($id: ID!) {
  node(id: $id) {
    __typename id
    ... on MediaImage { alt status }
    ... on Product { descriptionHtml }
    ... on Collection { descriptionHtml }
    ... on Page { body }
  }
}",
};

const SET_ALT: Query = Query {
    name: "RampsmithSetMediaAlt",
    cost_hint: 10.0,
    text: r"mutation RampsmithSetMediaAlt($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) {
    files { id alt }
    userErrors { field message code }
  }
}",
};

const SET_PRODUCT: Query = Query {
    name: "RampsmithSetProductDescription",
    cost_hint: 10.0,
    text: r"mutation RampsmithSetProductDescription($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id descriptionHtml }
    userErrors { field message }
  }
}",
};

const SET_COLLECTION: Query = Query {
    name: "RampsmithSetCollectionDescription",
    cost_hint: 10.0,
    text: r"mutation RampsmithSetCollectionDescription($collection: CollectionUpdateInput!) {
  collectionUpdate(collection: $collection) {
    collection { id descriptionHtml }
    userErrors { field message }
  }
}",
};

const SET_PAGE: Query = Query {
    name: "RampsmithSetPageBody",
    cost_hint: 10.0,
    text: r"mutation RampsmithSetPageBody($id: ID!, $page: PageUpdateInput!) {
  pageUpdate(id: $id, page: $page) {
    page { id body }
    userErrors { field message code }
  }
}",
};

#[derive(Debug, Deserialize)]
struct NodeData {
    node: Option<NodeWire>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeWire {
    #[serde(rename = "__typename")]
    typename: String,
    id: String,
    #[serde(default)]
    alt: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    description_html: Option<String>,
    #[serde(default)]
    body: Option<String>,
}

/// A field's live value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveValue {
    /// The value; `None` for an alt text that is unset.
    pub value: Option<String>,
    /// For a media image, its processing status (`READY` is required before alt can change).
    pub media_status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileUpdateData {
    file_update: FilePayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilePayload {
    #[serde(default)]
    files: Option<Vec<FileWire>>,
    #[serde(default)]
    user_errors: Vec<UserError>,
}

#[derive(Debug, Deserialize)]
struct FileWire {
    #[serde(default)]
    alt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductUpdateData {
    product_update: ProductPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionUpdateData {
    collection_update: CollectionPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageUpdateData {
    page_update: PagePayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductPayload {
    #[serde(default)]
    product: Option<ProductWire>,
    #[serde(default)]
    user_errors: Vec<UserError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionPayload {
    #[serde(default)]
    collection: Option<CollectionWire>,
    #[serde(default)]
    user_errors: Vec<UserError>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProductWire {
    description_html: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CollectionWire {
    description_html: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PagePayload {
    #[serde(default)]
    page: Option<BodyWire>,
    #[serde(default)]
    user_errors: Vec<UserError>,
}

#[derive(Debug, Deserialize)]
struct BodyWire {
    body: String,
}

fn user_errors(errors: Vec<UserError>) -> Result<(), AdminError> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(AdminError::User(errors))
    }
}

impl AdminClient {
    /// The live value of `target`'s field. [`AdminError::ResourceMissing`] when the object was
    /// deleted, or is another type than the GID says.
    pub async fn live_value(&self, target: &Target) -> Result<LiveValue, AdminError> {
        let data: NodeData = self.run(&VALUE, &json!({ "id": target.gid })).await?;
        let node = data.node.ok_or(AdminError::ResourceMissing)?;
        if node.typename != target.typename() || node.id != target.gid {
            return Err(AdminError::ResourceMissing);
        }
        let value = match target.field {
            Field::Alt => node.alt,
            Field::DescriptionHtml => Some(node.description_html.ok_or(AdminError::Decode)?),
            Field::Body => Some(node.body.ok_or(AdminError::Decode)?),
        };
        Ok(LiveValue {
            value,
            media_status: node.status,
        })
    }

    /// Writes `value` to `target`'s field and returns the value Shopify reports back. A
    /// non-empty `userErrors` is [`AdminError::User`]; nothing is assumed written then.
    pub async fn write_value(&self, target: &Target, value: &str) -> Result<String, AdminError> {
        match (target.kind, target.field) {
            (_, Field::Alt) => {
                let input = json!({ "files": [{ "id": target.gid, "alt": value }] });
                let data: FileUpdateData = self.run(&SET_ALT, &input).await?;
                user_errors(data.file_update.user_errors)?;
                let files = data.file_update.files.ok_or(AdminError::Decode)?;
                let file = files.into_iter().next().ok_or(AdminError::Decode)?;
                Ok(file.alt.unwrap_or_default())
            }
            (ResourceKind::Product, _) => {
                let input = json!({ "product": { "id": target.gid, "descriptionHtml": value } });
                let data: ProductUpdateData = self.run(&SET_PRODUCT, &input).await?;
                user_errors(data.product_update.user_errors)?;
                let product = data.product_update.product.ok_or(AdminError::Decode)?;
                Ok(product.description_html)
            }
            (ResourceKind::Collection, _) => {
                let input = json!({ "collection": { "id": target.gid, "descriptionHtml": value } });
                let data: CollectionUpdateData = self.run(&SET_COLLECTION, &input).await?;
                user_errors(data.collection_update.user_errors)?;
                let collection = data
                    .collection_update
                    .collection
                    .ok_or(AdminError::Decode)?;
                Ok(collection.description_html)
            }
            (ResourceKind::Page | ResourceKind::MediaImage, _) => {
                let input = json!({ "id": target.gid, "page": { "body": value } });
                let data: PageUpdateData = self.run(&SET_PAGE, &input).await?;
                user_errors(data.page_update.user_errors)?;
                Ok(data.page_update.page.ok_or(AdminError::Decode)?.body)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_target_must_be_a_supported_gid_with_a_field_that_fits() {
        assert!(Target::parse("gid://shopify/MediaImage/1", "alt").is_ok());
        assert!(Target::parse("gid://shopify/Product/9", "description_html").is_ok());
        assert!(Target::parse("gid://shopify/Collection/9", "description_html").is_ok());
        assert!(Target::parse("gid://shopify/Page/9", "body").is_ok());
        assert_eq!(
            Target::parse("gid://shopify/Product/9", "alt"),
            Err(TargetError::Field)
        );
        assert_eq!(
            Target::parse("gid://shopify/Page/9", "description_html"),
            Err(TargetError::Field)
        );
        for bad in [
            "",
            "gid://shopify/Product/",
            "gid://shopify/Product/x1",
            "gid://shopify/OnlineStoreTheme/1",
            "gid://shopify/Product/1/extra",
            "https://evil.example/Product/1",
        ] {
            assert_eq!(
                Target::parse(bad, "description_html"),
                Err(TargetError::Gid),
                "{bad}"
            );
        }
    }

    #[test]
    fn unset_and_empty_alt_text_are_the_same_value() {
        assert!(same_value(Field::Alt, None, Some("")));
        assert!(!same_value(Field::Alt, None, Some("a cat")));
    }
}
