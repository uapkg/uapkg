//! Optional update policy; selectors and required acquisition never use this filter.
use crate::catalog::{Index, Selector, selector};
use jiff::{SignedDuration, SpanRelativeTo, Timestamp, fmt::friendly::SpanParser};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MinimumReleaseAge {
    Finite(SignedDuration),
    BeyondTimestampRange,
}

impl MinimumReleaseAge {
    /// Input has already passed the shared compact-duration schema. Jiff accepts
    /// additional spellings, but those are deliberately not configuration syntax.
    pub(crate) fn parse(value: &str) -> Self {
        if value == "0" {
            return Self::Finite(SignedDuration::ZERO);
        }
        // Strip leading zeroes before parsing so long zero-valued components do
        // not overflow a parser's numeric accumulator.
        let mut normalized = String::new();
        for component in value.split_inclusive(|c: char| c.is_ascii_alphabetic()) {
            let (number, unit) = component.split_at(component.len().saturating_sub(1));
            let number = number.trim_start_matches('0');
            normalized.push_str(if number.is_empty() { "0" } else { number });
            normalized.push_str(unit);
        }
        SpanParser::new()
            .parse_span(normalized)
            .and_then(|span| span.to_duration(SpanRelativeTo::days_are_24_hours()))
            .map(Self::Finite)
            // A positive duration outside the supported range cannot be met by
            // any representable release age. Never turn overflow into no delay.
            .unwrap_or(Self::BeyondTimestampRange)
    }

    fn eligible(self, date: &str, now: Option<Timestamp>) -> bool {
        match self {
            Self::Finite(age) if age.is_zero() => true,
            Self::Finite(age) => now
                .zip(publication_time(date))
                .is_some_and(|(now, released)| now.duration_since(released) >= age),
            Self::BeyondTimestampRange => false,
        }
    }
}

pub(crate) fn now() -> Option<Timestamp> {
    Timestamp::try_from(std::time::SystemTime::now()).ok()
}

/// Readers accept the timestamp contract and historical UTC calendar dates.
/// Unsupported or malformed timestamps affect only optional update eligibility.
pub(crate) fn publication_time(value: &str) -> Option<Timestamp> {
    let bytes = value.as_bytes();
    if bytes.len() < 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || !bytes[..10]
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 4 | 7) || b.is_ascii_digit())
    {
        return None;
    }
    if bytes.len() == 10 {
        return format!("{value}T00:00:00Z").parse().ok();
    }
    if bytes.len() < 20
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || !bytes[11..19]
            .iter()
            .enumerate()
            .all(|(i, b)| matches!(i, 2 | 5) || b.is_ascii_digit())
        || &bytes[17..19] >= b"60".as_slice()
    {
        return None;
    }
    let mut offset = 19;
    if bytes[offset] == b'.' {
        offset += 1;
        let start = offset;
        while offset < bytes.len() && bytes[offset].is_ascii_digit() {
            offset += 1;
        }
        if !(1..=9).contains(&(offset - start)) {
            return None;
        }
    }
    let suffix = &bytes[offset..];
    if suffix != b"Z"
        && !(suffix.len() == 6
            && matches!(suffix[0], b'+' | b'-')
            && suffix[3] == b':'
            && [1, 2, 4, 5].iter().all(|&i| suffix[i].is_ascii_digit())
            && &suffix[1..3] < b"24".as_slice()
            && &suffix[4..6] < b"60".as_slice())
    {
        return None;
    }
    value.parse().ok()
}

pub(crate) fn automatic_candidate<'a>(
    index: &'a Index,
    requested: &str,
    current: &str,
    platform: &str,
    minimum_age: MinimumReleaseAge,
    now: Option<Timestamp>,
) -> Option<&'a str> {
    let channel = selector(requested).ok()?;
    let target = semver::Version::parse(index.aliases.get(requested)?).ok()?;
    let current = semver::Version::parse(current).ok()?;
    index
        .releases
        .iter()
        .filter_map(|release| {
            if release.unavailable().is_some()
                || !release.files.iter().any(|file| file == platform)
                || !minimum_age.eligible(&release.date, now)
            {
                return None;
            }
            let version = semver::Version::parse(&release.version).ok()?;
            let matches_channel = match &channel {
                Selector::Latest => version.pre.is_empty(),
                Selector::Preview { base, stage } => {
                    format!("{}.{}.{}", version.major, version.minor, version.patch) == *base
                        && (version.pre.as_str().starts_with(&format!("{stage}."))
                            || (version.pre.is_empty() && target.pre.is_empty()))
                }
                Selector::Exact => false,
            };
            (matches_channel
                && version.cmp_precedence(&current).is_gt()
                && !version.cmp_precedence(&target).is_gt())
            .then_some((version, release))
        })
        .max_by(|(left, a), (right, b)| {
            left.cmp_precedence(right)
                .then_with(|| a.version.cmp(&b.version))
        })
        .map(|(_, release)| release.version.as_str())
}

#[cfg(test)]
mod tests;
