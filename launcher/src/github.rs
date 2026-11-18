use crate::{
    archive,
    model::{exact_version, relative_path},
    storage::{ContextPaths, atomic_json},
};
use anyhow::{Context, Result, ensure};
use minisign_verify::{PublicKey, Signature};
use reqwest::{Url, blocking::Client, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
    path::Path,
    time::Duration,
};

pub fn catalog_key() -> &'static str {
    #[cfg(test)]
    {
        include_str!("../../tools/release/fixtures/metadata.pub")
    }
    #[cfg(not(test))]
    {
        include_str!("../../docs/release-catalog-signing.pub")
    }
}

const ARTIFACT_PUBLIC_KEY: &str = include_str!("../../docs/release-signing.pub");
const METADATA_LIMIT: u64 = 2 * 1024 * 1024;
const DOWNLOAD_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
pub const ORIGIN: &str = "https://releases.uapkg.dev";

fn allowed_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some(
            "releases.uapkg.dev"
                | "github.com"
                | "release-assets.githubusercontent.com"
                | "objects.githubusercontent.com"
        )
    )
}
pub fn client() -> Result<Client> {
    client_with_timeout(Duration::from_secs(300))
}

pub fn client_with_timeout(timeout: Duration) -> Result<Client> {
    Ok(Client::builder()
        .user_agent(concat!("uapkg-launcher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
        .redirect(Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" || !allowed_host(attempt.url()) {
                attempt.error("Refusing a redirect outside UAPKG and GitHub release hosting")
            } else if attempt.previous().len() >= 10 {
                attempt.error("Too many redirects")
            } else {
                attempt.follow()
            }
        }))
        .build()?)
}
pub fn product(value: &str) -> Result<()> {
    ensure!(
        matches!(value, "cli" | "launcher"),
        "Unknown release product."
    );
    Ok(())
}
pub fn url(product_name: &str, version: Option<&str>, name: &str) -> Result<Url> {
    product(product_name)?;
    ensure!(
        relative_path(name)?.components().count() == 1,
        "Invalid release filename."
    );
    let mut url = Url::parse(ORIGIN)?;
    let mut segments = url
        .path_segments_mut()
        .map_err(|()| anyhow::anyhow!("Invalid release URL."))?;
    segments.push(product_name);
    if let Some(version) = version {
        exact_version(version)?;
        segments.push(version);
    }
    segments.push(name);
    drop(segments);
    Ok(url)
}
pub fn verify(bytes: &[u8], signature: &str, key: &str) -> Result<()> {
    let lines: Vec<_> = key
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("untrusted comment:"))
        .collect();
    ensure!(lines.len() == 1, "Invalid embedded UAPKG verification key.");
    PublicKey::from_base64(lines[0])
        .context("Invalid embedded UAPKG verification key.")?
        .verify(
            bytes,
            &Signature::decode(signature).context("Invalid release signature.")?,
            false,
        )
        .context("Release signature verification failed. Nothing was installed.")
}
fn metadata(client: &Client, url: Url) -> Result<Vec<u8>> {
    metadata_with_timeout(client, url, Duration::from_secs(10))
}

fn metadata_with_timeout(client: &Client, url: Url, timeout: Duration) -> Result<Vec<u8>> {
    let response = client
        .get(url)
        .timeout(timeout)
        .send()?
        .error_for_status()?;
    ensure!(
        response.url().host_str() == Some("releases.uapkg.dev"),
        "Release metadata must be hosted on releases.uapkg.dev."
    );
    let mut bytes = Vec::new();
    response.take(METADATA_LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= METADATA_LIMIT,
        "Release metadata is too large."
    );
    Ok(bytes)
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedDocument {
    bytes: String,
    signature: String,
}
fn parse<T: DeserializeOwned>(document: &SignedDocument, key: &str) -> Result<T> {
    ensure!(
        document.bytes.len() as u64 <= METADATA_LIMIT && document.signature.len() < 4096,
        "Cached metadata is too large."
    );
    verify(document.bytes.as_bytes(), &document.signature, key)?;
    serde_json::from_str(&document.bytes).context("Invalid signed release metadata.")
}

fn catalog_cache(context: &ContextPaths, product_name: &str, name: &str) -> std::path::PathBuf {
    context
        .home
        .join("catalog")
        .join(product_name)
        .join(format!("{name}.verified.json"))
}

fn fetch_document(
    client: &Client,
    product_name: &str,
    name: &str,
    timeout: Duration,
) -> Result<SignedDocument> {
    Ok(SignedDocument {
        bytes: String::from_utf8(metadata_with_timeout(
            client,
            url(product_name, None, name)?,
            timeout,
        )?)?,
        signature: String::from_utf8(metadata_with_timeout(
            client,
            url(product_name, None, &format!("{name}.minisig"))?,
            timeout,
        )?)?,
    })
}

fn accept_document<T: DeserializeOwned>(
    cache: &Path,
    document: &SignedDocument,
    key: &str,
    validate: impl FnOnce(&T) -> Result<()>,
) -> Result<T> {
    let value = parse(document, key)?;
    validate(&value)?;
    atomic_json(cache, document)?;
    Ok(value)
}

/// Optional upgrade attempts only install from fresh authenticated metadata.
pub fn refresh_document<T: DeserializeOwned>(
    context: &ContextPaths,
    product_name: &str,
    name: &str,
    validate: impl FnOnce(&T) -> Result<()>,
) -> Result<T> {
    let key = catalog_key();
    let timeout = Duration::from_secs(3);
    let document = fetch_document(&client_with_timeout(timeout)?, product_name, name, timeout)?;
    accept_document(
        &catalog_cache(context, product_name, name),
        &document,
        key,
        validate,
    )
}

/// Only network unavailability falls back to authenticated cached metadata.
/// Invalid signatures and malformed successful responses always fail closed.
pub fn document<T: DeserializeOwned>(
    context: &ContextPaths,
    product_name: &str,
    name: &str,
    offline: bool,
) -> Result<T> {
    document_validated(context, product_name, name, offline, |_| Ok(()))
}

pub fn network_unavailable(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.downcast_ref::<reqwest::Error>().is_some())
}

pub fn document_validated<T: DeserializeOwned>(
    context: &ContextPaths,
    product_name: &str,
    name: &str,
    offline: bool,
    validate: impl Fn(&T) -> Result<()>,
) -> Result<T> {
    product(product_name)?;
    let key = catalog_key();
    let cache = catalog_cache(context, product_name, name);
    if !offline {
        let client = client()?;
        match fetch_document(&client, product_name, name, Duration::from_secs(10)) {
            Ok(document) => {
                return accept_document(&cache, &document, key, validate);
            }
            Err(error)
                if error
                    .chain()
                    .any(|cause| cause.downcast_ref::<reqwest::Error>().is_some()) => {}
            Err(error) => return Err(error),
        }
    }
    let document: SignedDocument = crate::model::read_json(&cache)
        .with_context(|| format!("No verified {product_name} {name} is available offline. Connect to releases.uapkg.dev and retry."))?;
    let parsed = parse(&document, key)?;
    validate(&parsed)?;
    Ok(parsed)
}
pub fn checksum(bytes: &[u8], name: &str) -> Result<String> {
    let content = std::str::from_utf8(bytes)?;
    let mut entries = BTreeMap::new();
    for line in content.lines() {
        let (hash, file) = line.split_once("  ").context("Invalid checksum entry.")?;
        ensure!(
            hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "Invalid SHA-256 checksum."
        );
        ensure!(
            relative_path(file)?.components().count() == 1,
            "Invalid checksum filename."
        );
        ensure!(
            entries.insert(file, hash).is_none(),
            "Duplicate checksum filename."
        );
    }
    Ok(entries
        .get(name)
        .context("The signed checksum list does not contain the selected artifact.")?
        .to_string())
}
pub fn artifact_name(product_name: &str, version: &str, platform: &str) -> Result<String> {
    product(product_name)?;
    exact_version(version)?;
    ensure!(
        crate::catalog::PLATFORMS.contains(&platform),
        "Unsupported release platform."
    );
    Ok(format!("uapkg-{product_name}-{version}-{platform}.tar.gz"))
}
pub fn download_artifact(
    client: &Client,
    product_name: &str,
    version: &str,
    platform: &str,
    path: &Path,
) -> Result<()> {
    let sums = metadata(client, url(product_name, Some(version), "SHASUMS256.txt")?)?;
    let signature = metadata(
        client,
        url(product_name, Some(version), "SHASUMS256.txt.minisig")?,
    )?;
    verify(&sums, std::str::from_utf8(&signature)?, ARTIFACT_PUBLIC_KEY)?;
    let name = artifact_name(product_name, version, platform)?;
    let hash = checksum(&sums, &name)?;
    download(
        client,
        url(product_name, Some(version), &name)?,
        path,
        DOWNLOAD_LIMIT,
    )?;
    ensure!(
        archive::sha256(path)? == hash.to_ascii_lowercase(),
        "Artifact checksum verification failed. Nothing was installed."
    );
    fs::write(path.with_extension("checksums"), sums)?;
    Ok(())
}
pub fn download(client: &Client, url: Url, path: &Path, maximum: u64) -> Result<()> {
    ensure!(
        url.scheme() == "https" && allowed_host(&url),
        "Download URLs must use trusted HTTPS release hosting."
    );
    let mut response = client.get(url).send()?.error_for_status()?;
    ensure!(
        matches!(
            response.url().host_str(),
            Some(
                "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        ),
        "Release artifacts must download from GitHub Releases."
    );
    let length = response.content_length();
    save_download(&mut response, length, path, maximum)
}
fn save_download(
    reader: &mut impl Read,
    length: Option<u64>,
    path: &Path,
    maximum: u64,
) -> Result<()> {
    if let Some(length) = length {
        ensure!(length <= maximum, "Download exceeds its size limit.");
    }
    let mut output = File::create(path)?;
    let copied = std::io::copy(&mut reader.take(maximum + 1), &mut output)?;
    ensure!(
        copied > 0 && copied <= maximum,
        "Download is empty or exceeds its size limit."
    );
    output.flush()?;
    output.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_signed_schema_cannot_replace_previously_verified_cached_policy() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("index.json.verified.json");
        let document = SignedDocument {
            bytes: include_str!("../../tools/release/fixtures/moderated-cli.json").into(),
            signature: include_str!("../../tools/release/fixtures/moderated-cli.json.minisig")
                .into(),
        };
        accept_document::<crate::catalog::Index>(&cache, &document, catalog_key(), |index| {
            index.validate("cli")
        })
        .unwrap();
        let before = fs::read(&cache).unwrap();
        assert!(
            accept_document::<crate::catalog::Index>(&cache, &document, catalog_key(), |index| {
                index.validate("launcher")
            })
            .is_err()
        );
        assert_eq!(fs::read(&cache).unwrap(), before);
        let invalid = SignedDocument {
            bytes: "{}".into(),
            signature: document.signature,
        };
        assert!(
            accept_document::<crate::catalog::Index>(&cache, &invalid, catalog_key(), |index| {
                index.validate("cli")
            })
            .is_err()
        );
        assert_eq!(fs::read(&cache).unwrap(), before);
    }

    #[test]
    fn embedded_production_keys_are_valid_distinct_and_separate_from_test_keys() {
        let catalog = include_str!("../../docs/release-catalog-signing.pub");
        let artifact = ARTIFACT_PUBLIC_KEY;
        let fixture_catalog = include_str!("../../tools/release/fixtures/metadata.pub");
        let fixture_artifact = include_str!("../../tools/release/fixtures/artifact.pub");
        let keys = [catalog, artifact, fixture_catalog, fixture_artifact];
        let mut encodings = std::collections::BTreeSet::new();
        for key in keys {
            PublicKey::decode(key).expect("Embedded Minisign keys must be well formed");
            let encoding = key
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.starts_with("untrusted comment:"))
                .unwrap();
            assert!(
                encodings.insert(encoding),
                "Signing keys must be independent"
            );
        }
        assert_eq!(catalog_key(), fixture_catalog);
        assert!(
            verify(
                include_bytes!("../../tools/release/fixtures/index.json"),
                include_str!("../../tools/release/fixtures/index.json.minisig"),
                catalog,
            )
            .is_err()
        );
        assert!(
            verify(
                include_bytes!("../../tools/release/fixtures/SHASUMS256.txt"),
                include_str!("../../tools/release/fixtures/SHASUMS256.txt.minisig"),
                artifact,
            )
            .is_err()
        );
    }

    #[test]
    fn downloads_are_bounded_with_or_without_content_length() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("artifact");
        save_download(&mut &b"archive"[..], None, &path, 10).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"archive");
        save_download(&mut &b"archive"[..], Some(7), &path, 10).unwrap();
        assert!(save_download(&mut &b"archive"[..], None, &path, 3).is_err());
        assert!(save_download(&mut &b"archive"[..], Some(100), &path, 10).is_err());
        assert!(save_download(&mut &b""[..], None, &path, 10).is_err());
    }
}
