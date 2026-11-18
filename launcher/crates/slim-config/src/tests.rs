use super::*;
use serde_json::json;
use tempfile::TempDir;

struct Fixture {
    root: TempDir,
    profile: PathBuf,
    cwd: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        let cwd = root.path().join("project/nested/deep");
        Self { root, profile, cwd }
    }

    fn write(&self, relative: &str, value: &Value) {
        self.raw(relative, &value.to_string());
    }

    fn raw(&self, relative: &str, value: &str) {
        let file = self.root.path().join(relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, value).unwrap();
    }

    fn resolve(&self, scope: Scope) -> Resolution {
        Resolver::new()
            .unwrap()
            .resolve(&self.profile, &self.cwd, scope)
    }
}

#[test]
fn embedded_defaults_are_valid_and_missing_files_are_read_only() {
    let fixture = Fixture::new();
    let result = fixture.resolve(Scope::Effective);
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    assert_eq!(result.value, schema["default"]);
    assert!(result.diagnostics.is_empty());
    assert_eq!(
        result.origin("launcher.defaultCliVersion").unwrap().source,
        Source::Default
    );
    assert_eq!(fs::read_dir(fixture.root.path()).unwrap().count(), 0);
}

#[test]
fn invalid_leaf_retains_an_earlier_value_without_discarding_valid_siblings() {
    let fixture = Fixture::new();
    fixture.write("project/uapkg.json", &json!({"kind":"project"}));
    fixture.write(
        "profile/config.json",
        &json!({"launcher":{"defaultCliVersion":"1.2.3","autoLauncherUpdate":false}}),
    );
    fixture.write(
        "project/.uapkg/config.json",
        &json!({"launcher":{"defaultCliVersion":"2.0.0","autoCLIUpdate":false}}),
    );
    fixture.write(
        "project/nested/.uapkg/config.json",
        &json!({"launcher":{"autoLauncherUpdate":true}}),
    );
    fixture.write(
        "project/nested/deep/.uapkg/config.json",
        &json!({"launcher":{"defaultCliVersion":{},"autoCLIUpdate":true}}),
    );
    let local_path = fixture.cwd.join(".uapkg/config.json");
    let before = fs::read(&local_path).unwrap();
    let result = fixture.resolve(Scope::Effective);
    assert_eq!(
        result.value,
        json!({"launcher":{"defaultCliVersion":"2.0.0","autoLauncherUpdate":true,"autoCLIUpdate":true,"autoUpdate":{"minimumReleaseAge":"3d"}}})
    );
    assert_eq!(
        result.origin("launcher.defaultCliVersion").unwrap().source,
        Source::Intermediary
    );
    assert_eq!(
        result.origin("launcher.autoCLIUpdate").unwrap().source,
        Source::Local
    );
    let trace = &result.trace["launcher.defaultCliVersion"];
    assert_eq!(trace.last().unwrap().status, TraceStatus::Ignored);
    assert_eq!(
        trace.last().unwrap().origin.file.as_ref(),
        Some(&local_path)
    );
    assert_eq!(result.diagnostics.len(), 1);
    let message = result.diagnostics[0].to_string();
    for expected in [
        "Ignored launcher.defaultCliVersion",
        "local config",
        "an object",
        "2.0.0",
        "intermediary config",
    ] {
        assert!(message.contains(expected), "{message}");
    }
    assert_eq!(fs::read(local_path).unwrap(), before);
}

#[test]
fn global_scope_preserves_management_command_semantics() {
    let fixture = Fixture::new();
    fixture.write(
        "profile/config.json",
        &json!({"launcher":{"defaultCliVersion":"1.2.3","autoCLIUpdate":false}}),
    );
    fixture.write(
        "project/nested/deep/.uapkg/config.json",
        &json!({"launcher":{"defaultCliVersion":"2.0.0","autoCLIUpdate":true}}),
    );
    let result = fixture.resolve(Scope::Global);
    assert_eq!(
        result.get("launcher.defaultCliVersion"),
        Some(&json!("1.2.3"))
    );
    assert_eq!(result.get("launcher.autoCLIUpdate"), Some(&json!(false)));
    assert_eq!(
        result.origin("launcher.defaultCliVersion").unwrap().source,
        Source::Global
    );
}

#[test]
fn nearest_manifest_is_only_a_boundary_and_is_never_parsed() {
    let fixture = Fixture::new();
    fixture.write("project/uapkg.json", &json!({"kind":"project"}));
    fixture.write(
        "project/.uapkg/config.json",
        &json!({"launcher":{"defaultCliVersion":"1.2.3"}}),
    );
    fixture.raw(
        "project/nested/uapkg.json",
        "invalid manifest which is not slim-config's concern",
    );
    fixture.write(
        "project/nested/.uapkg/config.json",
        &json!({"launcher":{"defaultCliVersion":"2.0.0"}}),
    );
    let result = fixture.resolve(Scope::Effective);
    assert_eq!(
        result.get("launcher.defaultCliVersion"),
        Some(&json!("2.0.0"))
    );
    assert!(result.diagnostics.is_empty());
    assert_eq!(result.trace["launcher.defaultCliVersion"].len(), 2);
}

#[test]
fn no_manifest_means_no_parent_config_search() {
    let fixture = Fixture::new();
    fixture.write(
        "project/.uapkg/config.json",
        &json!({"launcher":{"defaultCliVersion":"1.2.3"}}),
    );
    fixture.write(
        "project/nested/deep/.uapkg/config.json",
        &json!({"launcher":{"autoCLIUpdate":false}}),
    );
    let result = fixture.resolve(Scope::Effective);
    assert_eq!(
        result.origin("launcher.defaultCliVersion").unwrap().source,
        Source::Default
    );
    assert_eq!(result.get("launcher.autoCLIUpdate"), Some(&json!(false)));
}

#[test]
fn malformed_unreadable_and_wrong_root_files_warn_and_retain_defaults() {
    let fixture = Fixture::new();
    for contents in ["{", "[]", "null", "false", "42", "\"config\""] {
        fixture.raw("profile/config.json", contents);
        let result = fixture.resolve(Scope::Effective);
        assert_eq!(result.diagnostics.len(), 1, "{contents}");
        assert_eq!(
            result.value,
            serde_json::from_str::<Value>(SCHEMA).unwrap()["default"]
        );
        assert!(
            result.diagnostics[0]
                .to_string()
                .contains("built-in default")
        );
        let attempt = result.trace["launcher.defaultCliVersion"].last().unwrap();
        assert_eq!(attempt.status, TraceStatus::Ignored);
        assert_eq!(attempt.origin.source, Source::Global);
        assert!(attempt.reason.as_ref().unwrap().contains("Ancestor $"));
    }
    fs::remove_file(fixture.profile.join("config.json")).unwrap();
    fs::create_dir(fixture.profile.join("config.json")).unwrap();
    let result = fixture.resolve(Scope::Effective);
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(result.diagnostics[0].received, "an unreadable file");
    assert_eq!(
        result.trace["launcher.defaultCliVersion"]
            .last()
            .unwrap()
            .status,
        TraceStatus::Ignored
    );
}

#[test]
fn invalid_containers_do_not_apply_and_unconsumed_properties_are_not_exposed() {
    let fixture = Fixture::new();
    fixture.write("profile/config.json", &json!({"launcher":{"defaultCliVersion":"1.2.3"},"credentials":{"token":"must-not-appear"}}));
    fixture.write(
        "project/nested/deep/.uapkg/config.json",
        &json!({"launcher":["must-not-appear"],"secret":"must-not-appear"}),
    );
    let result = fixture.resolve(Scope::Effective);
    assert_eq!(
        result.get("launcher.defaultCliVersion"),
        Some(&json!("1.2.3"))
    );
    assert_eq!(result.diagnostics[0].path, "launcher");
    let ignored = result.trace["launcher.defaultCliVersion"].last().unwrap();
    assert_eq!(ignored.status, TraceStatus::Ignored);
    assert!(
        ignored
            .reason
            .as_ref()
            .unwrap()
            .contains("Ancestor launcher")
    );
    assert_eq!(ignored.value, Value::Null);
    assert!(
        !result.diagnostics[0]
            .to_string()
            .contains("must-not-appear")
    );
    assert!(result.value.get("credentials").is_none());
    fixture.write(
        "project/nested/deep/.uapkg/config.json",
        &json!({"launcher":{"futureSetting":{"secret":"must-not-appear"},"cliSource":"npm"}}),
    );
    assert!(fixture.resolve(Scope::Effective).diagnostics.is_empty());
}

#[test]
fn empty_and_bom_trimmed_files_match_node_reading() {
    let fixture = Fixture::new();
    for contents in [
        "",
        " \r\n\t",
        "\u{feff} \n",
        "\u{feff}{\"launcher\":{\"autoCLIUpdate\":false}}\u{feff}",
    ] {
        fixture.raw("profile/config.json", contents);
        let result = fixture.resolve(Scope::Effective);
        assert!(result.diagnostics.is_empty(), "{contents:?}");
    }
    assert_eq!(
        fixture.resolve(Scope::Global).get("launcher.autoCLIUpdate"),
        Some(&json!(false))
    );
}

#[test]
fn invalid_selectors_and_flags_are_ignored_individually() {
    let fixture = Fixture::new();
    fixture.write(
        "profile/config.json",
        &json!({"launcher":{"defaultCliVersion":"1.2.3"}}),
    );
    for selector in [
        json!("^1.2.3"),
        json!("1.2.3-rc.1"),
        json!("v1.2.3"),
        json!("1.2.3\n"),
        json!("9007199254740992.0.0"),
        json!(null),
    ] {
        fixture.write("project/nested/deep/.uapkg/config.json", &json!({"launcher":{"defaultCliVersion":selector,"autoCLIUpdate":"false","autoLauncherUpdate":false}}));
        let result = fixture.resolve(Scope::Effective);
        assert_eq!(
            result.get("launcher.defaultCliVersion"),
            Some(&json!("1.2.3")),
            "{selector}"
        );
        assert_eq!(
            result.get("launcher.autoLauncherUpdate"),
            Some(&json!(false))
        );
        assert_eq!(
            result.origin("launcher.autoCLIUpdate").unwrap().source,
            Source::Default
        );
        assert_eq!(result.diagnostics.len(), 2);
    }
}

#[test]
fn shared_typescript_and_rust_resolution_fixtures() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../fixtures/resolution.json")).unwrap();
    for case in fixtures.as_array().unwrap() {
        let fixture = Fixture::new();
        let name = case["name"].as_str().unwrap();
        for manifest in case["manifests"].as_array().unwrap() {
            fixture.raw(
                manifest.as_str().unwrap(),
                "manifest contents are deliberately not parsed",
            );
        }
        for (file, text) in case["files"].as_object().unwrap() {
            fixture.raw(file, text.as_str().unwrap());
        }
        let cwd = fixture.root.path().join(case["cwd"].as_str().unwrap());
        let result = Resolver::new()
            .unwrap()
            .resolve(&fixture.profile, &cwd, Scope::Effective);
        assert_eq!(result.value, case["expected"], "{name}");
        for (path, source) in case["origins"].as_object().unwrap() {
            assert_eq!(
                result.origin(path).unwrap().source.as_str(),
                source.as_str().unwrap(),
                "{name}: {path}"
            );
        }
        let mut ignored: Vec<_> = result
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.path.as_str())
            .collect();
        let mut expected_ignored: Vec<_> = case["ignored"]
            .as_array()
            .unwrap()
            .iter()
            .map(|path| path.as_str().unwrap())
            .collect();
        ignored.sort();
        expected_ignored.sort();
        assert_eq!(ignored, expected_ignored, "{name}");
    }
}

#[test]
fn shared_selector_grammar_and_numeric_boundaries() {
    let cases: Value = serde_json::from_str(include_str!("../fixtures/selectors.json")).unwrap();
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    let leaf = &schema["properties"]["launcher"]["properties"]["defaultCliVersion"];
    let validator = jsonschema::draft202012::options().build(leaf).unwrap();
    for case in cases.as_array().unwrap() {
        assert_eq!(
            validator.is_valid(&case["value"]),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["value"]
        );
    }
}

#[test]
fn same_physical_file_has_both_trace_roles_but_one_warning() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join(".uapkg");
    fs::create_dir(&profile).unwrap();
    let file = profile.join("config.json");
    fs::write(&file, r#"{"launcher":{"defaultCliVersion":{}}}"#).unwrap();
    let result = Resolver::new()
        .unwrap()
        .resolve(&profile, root.path(), Scope::Effective);
    assert_eq!(result.diagnostics.len(), 1);
    let trace = &result.trace["launcher.defaultCliVersion"];
    assert_eq!(trace.len(), 3);
    assert_eq!(trace[1].origin.source, Source::Global);
    assert_eq!(trace[2].origin.source, Source::Local);
    assert_eq!(trace[1].origin.file, trace[2].origin.file);
    assert_eq!(trace[1].status, TraceStatus::Ignored);
    assert_eq!(trace[2].status, TraceStatus::Ignored);
}
