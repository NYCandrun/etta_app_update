//! Small shared utilities.

/// Escape a string for safe interpolation into the XML-tagged AI prompt.
/// Apply to EVERY interpolated field, trusted or not (Appendix A.4 / blocklist
/// #41). The local SQLite DB is unencrypted, so even "trusted" curriculum and
/// cache content must be escaped — this is the prompt-injection defense.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_all_five_entities() {
        assert_eq!(
            xml_escape("<a href=\"x\">b & 'c'</a>"),
            "&lt;a href=&quot;x&quot;&gt;b &amp; &apos;c&apos;&lt;/a&gt;"
        );
    }

    #[test]
    fn leaves_plain_text_untouched() {
        assert_eq!(xml_escape("plain text 123"), "plain text 123");
    }
}
