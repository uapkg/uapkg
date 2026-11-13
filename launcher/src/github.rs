use crate::{
    archive,
    model::{Artifact, REPOSITORY, Release, exact_version},
};
use anyhow::{Context, Result, bail, ensure};
use minisign_verify::{PublicKey, Signature};
use reqwest::{Url, blocking::Client, redirect::Policy};
use serde::Deserialize;
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
    time::Duration,
};

const METADATA_LIMIT: u64 = 2 * 1024 * 1024;

pub fn client() -> Result<Client> {
    Ok(Client::builder()
        .user_agent(concat!("uapkg-launcher/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .redirect(Policy::custom(|attempt| {
            if attempt.url().scheme() != "https" {
                attempt.error("Refusing a redirect without HTTPS")
            } else if attempt.previous().len() >= 10 {
                attempt.error("Too many redirects")
            } else {
                attempt.follow()
            }
        }))
        .build()?)
}

pub fn metadata(client: &Client, url: Url) -> Result<Vec<u8>> {
    let response = client
        .get(url.clone())
        .send()
        .with_context(|| {
            format!("Could not reach {url}. Cached CLI versions remain available offline.")
        })?
        .error_for_status()
        .with_context(|| {
            format!("Could not obtain {url}. No other version will be substituted.")
        })?;
    let mut bytes = Vec::new();
    response.take(METADATA_LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= METADATA_LIMIT,
        "Release metadata is too large."
    );
    Ok(bytes)
}

pub fn asset_url(version: &str, name: &str) -> Result<Url> {
    exact_version(version)?;
    let mut url = Url::parse(&format!(
        "https://github.com/{REPOSITORY}/releases/download/"
    ))?;
    url.path_segments_mut()
        .map_err(|()| anyhow::anyhow!("Invalid release URL."))?
        .pop_if_empty()
        .push(&format!("@uapkg/cli@{version}"))
        .push(name);
    Ok(url)
}

pub fn verify_descriptor(
    bytes: &[u8],
    signature: &str,
    public_key: &str,
    version: &str,
) -> Result<Release> {
    let key = PublicKey::from_base64(public_key.trim())
        .context("Invalid embedded UAPKG release public key.")?;
    let signature = Signature::decode(signature).context("Invalid release metadata signature.")?;
    key.verify(bytes, &signature, false)
        .context("Release metadata signature verification failed. Nothing was installed.")?;
    let release: Release =
        serde_json::from_slice(bytes).context("Invalid signed release metadata.")?;
    release.validate(version)?;
    Ok(release)
}

pub struct VerifiedRelease {
    pub release: Release,
    pub bytes: Vec<u8>,
    pub signature: Vec<u8>,
}

pub fn release(client: &Client, version: &str) -> Result<VerifiedRelease> {
    let public_key = option_env!("UAPKG_RELEASE_PUBLIC_KEY").filter(|key| !key.trim().is_empty())
        .context("This launcher was built without a release verification key. Install an official UAPKG launcher to download releases.")?;
    let bytes = metadata(client, asset_url(version, "release.json")?)?;
    let signature = metadata(client, asset_url(version, "release.json.minisig")?)?;
    let release = verify_descriptor(
        &bytes,
        std::str::from_utf8(&signature)?,
        public_key,
        version,
    )?;
    Ok(VerifiedRelease {
        release,
        bytes,
        signature,
    })
}

pub fn download(client: &Client, url: Url, path: &Path, maximum: u64) -> Result<()> {
    ensure!(url.scheme() == "https", "Download URLs must use HTTPS.");
    let mut response = client.get(url).send()?.error_for_status()?;
    if let Some(length) = response.content_length() {
        ensure!(length <= maximum, "Download exceeds its expected size.");
    }
    let mut output = File::create(path)?;
    let copied = std::io::copy(&mut response.by_ref().take(maximum + 1), &mut output)?;
    ensure!(copied <= maximum, "Download exceeds its expected size.");
    output.flush()?;
    output.sync_all()?;
    Ok(())
}

pub fn download_artifact(
    client: &Client,
    version: &str,
    artifact: &Artifact,
    path: &Path,
) -> Result<()> {
    download(
        client,
        asset_url(version, &artifact.file_name)?,
        path,
        artifact.size,
    )?;
    archive::verify_file(path, artifact.size, &artifact.sha256)
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

/// This is explicit update discovery, never part of normal command delegation.
/// All releases are filtered by our package tag; unrelated workspace packages
/// cannot accidentally become the launcher's update source.
pub fn release_versions(client: &Client) -> Result<Vec<semver::Version>> {
    let mut versions = Vec::new();
    for page in 1..=100 {
        let url = Url::parse(&format!(
            "https://api.github.com/repos/{REPOSITORY}/releases?per_page=100&page={page}"
        ))?;
        let releases: Vec<GithubRelease> = serde_json::from_slice(&metadata(client, url)?)?;
        let done = releases.len() < 100;
        for release in releases {
            if release.draft || release.prerelease {
                continue;
            }
            if let Some(version) = release.tag_name.strip_prefix("@uapkg/cli@")
                && let Ok(version) = exact_version(version)
                && version.pre.is_empty()
            {
                versions.push(version);
            }
        }
        if done {
            versions.sort();
            versions.reverse();
            return Ok(versions);
        }
    }
    bail!(
        "Release listing exceeded its page limit. Specify an exact launcher version with `uapkg self-update <version>`."
    )
}

pub fn is_not_found(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<reqwest::Error>()
            .is_some_and(|error| error.status() == Some(reqwest::StatusCode::NOT_FOUND))
    })
}

pub fn latest_version(client: &Client) -> Result<String> {
    for version in release_versions(client)? {
        match release(client, &version.to_string()) {
            Ok(release) => return Ok(release.release.cli_version),
            Err(error) if is_not_found(&error) => continue,
            Err(error) => return Err(error),
        }
    }
    bail!(
        "No signed stable CLI release is available. Choose an exact version after a launcher-enabled release is published."
    )
}
