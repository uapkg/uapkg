use super::*;
use serde_json::json;

fn timestamp(value: &str) -> Timestamp {
    value.parse().unwrap()
}

fn index() -> Index {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "product": "cli",
        "aliases": {"latest": "1.3.0"},
        "releases": [
            {"version":"1.0.0", "date":"2026-11-01", "files":["linux-x64"]},
            {"version":"1.1.0", "date":"2026-11-14T12:00:00Z", "files":["linux-x64"]},
            {"version":"1.2.0", "date":"2026-11-15T12:00:00Z", "files":["linux-x64"]},
            {"version":"1.3.0", "date":"2026-11-18T12:00:00Z", "files":["linux-x64"]},
            {"version":"2.0.0-alpha.1", "date":"2026-11-01", "files":["linux-x64"]}
        ]
    }))
    .unwrap()
}

#[test]
fn compact_durations_use_fixed_days_and_weeks_and_preserve_zeroes() {
    for (value, seconds) in [
        ("0", 0),
        ("0s", 0),
        ("0w0d0h0m0s", 0),
        (
            "000000000000000000000000000000000000000000000000000000000000000s",
            0,
        ),
        ("1s", 1),
        ("1m", 60),
        ("1h", 3600),
        ("3d", 259200),
        ("1w2d3h4m5s", 788645),
        ("0003d", 259200),
        ("25h", 90000),
    ] {
        assert_eq!(
            MinimumReleaseAge::parse(value),
            MinimumReleaseAge::Finite(SignedDuration::from_secs(seconds)),
            "{value}"
        );
    }
    let huge = MinimumReleaseAge::parse(
        "999999999999999999999999999999999999999999999999999999999999999w",
    );
    assert_eq!(huge, MinimumReleaseAge::BeyondTimestampRange);
    assert!(!huge.eligible("0001-01-01", Some(timestamp("2026-11-18T12:00:00Z"))));
}

#[test]
fn timestamps_accept_legacy_dates_fractional_seconds_and_offsets() {
    let expected = timestamp("2026-11-18T12:34:56.123456789Z");
    for value in [
        "2026-11-18T12:34:56.123456789Z",
        "2026-11-18T14:34:56.123456789+02:00",
        "2026-11-18T10:34:56.123456789-02:00",
    ] {
        assert_eq!(publication_time(value), Some(expected));
    }
    assert_eq!(
        publication_time("2024-02-29"),
        Some(timestamp("2024-02-29T00:00:00Z"))
    );
    for value in [
        "",
        "2026-02-29",
        "2026-02-30T00:00:00Z",
        "2026-11-18T24:00:00Z",
        "2026-11-18T12:60:00Z",
        "2026-11-18T12:00:60Z",
        "2026-11-18T12:00:00",
        "2026-11-18T12:00:00+24:00",
        "2026-11-18T12:00:00+00:60",
        "2026-11-18T12:00:00.Z",
        "2026-11-18T12:00:00.1234567890Z",
        "2026-11-18T12:00:00Z\n",
        "2026-11-18garbage",
        "éééééééééé",
    ] {
        assert!(publication_time(value).is_none(), "{value}");
    }
}

#[test]
fn eligibility_is_inclusive_and_handles_subday_future_and_missing_dates() {
    let now = Some(timestamp("2026-11-18T12:00:00.250Z"));
    let minimum = MinimumReleaseAge::parse("1s");
    assert!(minimum.eligible("2026-11-18T11:59:59.250Z", now));
    assert!(!minimum.eligible("2026-11-18T11:59:59.251Z", now));
    assert!(!minimum.eligible("2026-11-19", now));
    assert!(!minimum.eligible("", now));
    assert!(!minimum.eligible("invalid", now));
    assert!(!minimum.eligible("2026-11-01", None));
    assert!(MinimumReleaseAge::parse("12h").eligible("2026-11-18", now));
    for value in ["", "invalid", "2026-11-19"] {
        assert!(MinimumReleaseAge::parse("0").eligible(value, None));
    }
}

#[test]
fn greatest_eligible_stable_is_selected_without_redefining_aliases_or_downgrading() {
    let index = index();
    index.validate("cli").unwrap();
    let age = MinimumReleaseAge::parse("3d");
    let now = Some(timestamp("2026-11-18T12:00:00Z"));
    let candidate = |current, minimum| {
        automatic_candidate(&index, "latest", current, "linux-x64", minimum, now)
    };
    assert_eq!(candidate("1.0.0", age), Some("1.2.0"));
    assert_eq!(candidate("1.2.0", age), None);
    assert_eq!(candidate("1.3.0", age), None);
    assert_eq!(
        candidate("1.0.0", MinimumReleaseAge::parse("0")),
        Some("1.3.0")
    );
    assert_eq!(index.aliases["latest"], "1.3.0");
    assert_eq!(
        automatic_candidate(&index, "latest", "1.0.0", "win-x64", age, now),
        None
    );
}

#[test]
fn safety_platform_and_bad_metadata_are_independent_candidate_filters() {
    let mut index = index();
    index.releases[2].date = "invalid".into();
    index.validate("cli").unwrap();
    let now = Some(timestamp("2026-11-18T12:00:00Z"));
    assert_eq!(
        automatic_candidate(
            &index,
            "latest",
            "1.0.0",
            "linux-x64",
            MinimumReleaseAge::parse("3d"),
            now
        ),
        Some("1.1.0")
    );
    index.releases[1].yanked = Some(crate::catalog::ReleaseStatus {
        at: "2026-11-18T00:00:00Z".into(),
        reason: "withdrawn".into(),
        extra_fields: Default::default(),
    });
    assert_eq!(
        automatic_candidate(
            &index,
            "latest",
            "1.0.0",
            "linux-x64",
            MinimumReleaseAge::parse("3d"),
            now
        ),
        None
    );
    index.releases[2].files.clear();
    index.releases[2].quarantined = index.releases[1].yanked.clone();
    assert_eq!(
        automatic_candidate(
            &index,
            "latest",
            "1.0.0",
            "linux-x64",
            MinimumReleaseAge::parse("0"),
            now
        ),
        Some("1.3.0")
    );
}

#[test]
fn preview_candidates_keep_the_published_base_stage_and_promotion_boundary() {
    let mut index = index();
    index
        .aliases
        .insert("2.0.0-beta".into(), "2.0.0-beta.3".into());
    for (version, date) in [
        ("2.0.0-alpha.9", "2026-11-01"),
        ("2.0.0-beta.2", "2026-11-01"),
        ("2.0.0-beta.3", "2026-11-18"),
        ("2.0.0", "2026-11-01"),
        ("2.1.0-beta.9", "2026-11-01"),
    ] {
        index.releases.push(crate::catalog::Release {
            version: version.into(),
            date: date.into(),
            files: vec!["linux-x64".into()],
            yanked: None,
            quarantined: None,
            extra_fields: Default::default(),
        });
    }
    let now = Some(timestamp("2026-11-18T12:00:00Z"));
    let candidate = |index: &Index| {
        automatic_candidate(
            index,
            "2.0.0-beta",
            "2.0.0-beta.1",
            "linux-x64",
            MinimumReleaseAge::parse("3d"),
            now,
        )
        .map(str::to_owned)
    };
    assert_eq!(candidate(&index).as_deref(), Some("2.0.0-beta.2"));
    index.aliases.insert("2.0.0-beta".into(), "2.0.0".into());
    assert_eq!(candidate(&index).as_deref(), Some("2.0.0"));
}

#[test]
fn missing_or_invalid_publication_time_does_not_reject_otherwise_valid_indexes() {
    let mut value = serde_json::to_value(index()).unwrap();
    value["releases"][0].as_object_mut().unwrap().remove("date");
    value["releases"][1]["date"] = json!("invalid");
    let index: Index = serde_json::from_value(value).unwrap();
    index.validate("cli").unwrap();
    assert_eq!(index.target("latest").unwrap(), "1.3.0");
    index.ensure_runnable("1.0.0").unwrap();
    index.supports("1.0.0", "linux-x64").unwrap();
}
