use cargo_cyclonedx::{
    SbomGenerator,
    config::{SbomConfig, Target},
};
use cargo_metadata::{CargoOpt, MetadataCommand};
use cyclonedx_bom::{
    external_models::uri::Uri,
    models::{
        bom::SpecVersion,
        component::Component,
        external_reference::{ExternalReference, ExternalReferenceType, ExternalReferences},
        license::{License, LicenseChoice, LicenseIdentifier, Licenses},
    },
};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    env,
    error::Error,
    fs::File,
    io::{BufWriter, Write},
    path::PathBuf,
};

const OVERRIDES: &str = "../tools/release/license-overrides.json";

#[derive(Deserialize)]
struct LicenseOverride {
    id: String,
    references: Vec<String>,
}

fn declares_license(choice: &LicenseChoice) -> bool {
    let value = match choice {
        LicenseChoice::Expression(expression) => expression.to_string(),
        LicenseChoice::License(license) => match &license.license_identifier {
            LicenseIdentifier::SpdxId(id) => id.to_string(),
            LicenseIdentifier::Name(name) => name.to_string(),
        },
    };
    let label = value.trim().to_ascii_uppercase();
    let mut words = label.split_whitespace();
    let file_reference =
        words.by_ref().take(3).eq(["SEE", "LICENSE", "IN"]) && words.next().is_some();
    !matches!(
        label.as_str(),
        "" | "NOASSERTION" | "NONE" | "UNKNOWN" | "UNLICENSED" | "N/A" | "UNSPECIFIED"
    ) && !file_reference
}

fn apply_overrides(
    component: &mut Component,
    overrides: &BTreeMap<String, LicenseOverride>,
) -> Result<(), Box<dyn Error>> {
    if let Some(children) = &mut component.components {
        for child in &mut children.0 {
            apply_overrides(child, overrides)?;
        }
    }
    let Some(entry) = component
        .purl
        .as_ref()
        .and_then(|purl| overrides.get(purl.as_ref()))
    else {
        return Ok(());
    };
    if component
        .licenses
        .as_ref()
        .is_some_and(|licenses| licenses.0.iter().any(declares_license))
    {
        return Ok(());
    }
    let mut license = License::license_id(&entry.id);
    license.url = Some(Uri::new(
        entry
            .references
            .first()
            .ok_or("license override requires a source URL")?,
    ));
    component.licenses = Some(Licenses(vec![LicenseChoice::License(license)]));
    let references = &mut component
        .external_references
        .get_or_insert_with(|| ExternalReferences(Vec::new()))
        .0;
    for url in &entry.references {
        let source = ExternalReference::new(ExternalReferenceType::License, Uri::new(url));
        if !references.iter().any(|r| {
            r.external_reference_type == ExternalReferenceType::License && r.url == source.url
        }) {
            references.push(source);
        }
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    println!("cargo::rerun-if-env-changed=SOURCE_DATE_EPOCH");
    for path in [
        "build.rs",
        "Cargo.toml",
        "Cargo.lock",
        "crates/slim-config/Cargo.toml",
        OVERRIDES,
    ] {
        println!("cargo::rerun-if-changed={path}");
    }

    let target = env::var("TARGET")?;
    let mut command = MetadataCommand::new();
    command.other_options(vec![
        "--locked".into(),
        "--filter-platform".into(),
        target.clone(),
    ]);

    // Match the features of the enclosing build, including --no-default-features.
    let workspace = MetadataCommand::new().no_deps().exec()?;
    let launcher = workspace.root_package().ok_or("missing launcher package")?;
    let enabled = launcher
        .features
        .keys()
        .filter(|feature| {
            let key = format!(
                "CARGO_FEATURE_{}",
                feature.to_ascii_uppercase().replace('-', "_")
            );
            env::var_os(key).is_some()
        })
        .cloned()
        .collect();
    command.features(CargoOpt::NoDefaultFeatures);
    command.features(CargoOpt::SomeFeatures(enabled));

    let config = SbomConfig {
        target: Some(Target::SingleTarget(target)),
        only_normal_deps: Some(true),
        spec_version: Some(SpecVersion::V1_6),
        ..Default::default()
    };
    let mut generated = SbomGenerator::create_sboms(command.exec()?, &config)?
        .into_iter()
        .find(|sbom| sbom.package_name == env!("CARGO_PKG_NAME"))
        .ok_or("cargo-cyclonedx did not generate the launcher SBOM")?;
    let overrides = serde_json::from_reader(File::open(OVERRIDES)?)?;
    if let Some(product) = generated
        .bom
        .metadata
        .as_mut()
        .and_then(|m| m.component.as_mut())
    {
        apply_overrides(product, &overrides)?;
    }
    if let Some(components) = &mut generated.bom.components {
        for component in &mut components.0 {
            apply_overrides(component, &overrides)?;
        }
    }
    let path =
        PathBuf::from(env::var_os("OUT_DIR").ok_or("missing OUT_DIR")?).join("launcher.cdx.json");
    let mut output = BufWriter::new(File::create(path)?);
    generated
        .bom
        .output_as_json(&mut output, SpecVersion::V1_6)?;
    output.flush()?;
    Ok(())
}
