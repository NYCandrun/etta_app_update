//! Mathematical-equivalence checker for fill_in_blank grading (blocklist #11).
//!
//! v1 graded fill-in-blank with `eq_ignore_ascii_case` string compare, so "1/2"
//! and "0.5" were marked different. We instead EVALUATE both sides to a number
//! and compare within a tolerance: 1/2 == 0.5 == 0.50, sqrt(2)/2 == 1/sqrt(2),
//! 2^3 == 8, etc. Trivial formatting (whitespace, surrounding $, commas as
//! thousands separators, a trailing "=") is ignored.
//!
//! A tiny self-contained recursive-descent parser over `+ - * / ^`,
//! parentheses, unary minus, and the constants/functions students actually type
//! (pi, e, sqrt). No external crate — this is intentionally small.

const EPS: f64 = 1e-9;

/// True if `a` and `b` denote the same numeric value. If either side cannot be
/// parsed as a math expression, fall back to a normalized case-insensitive
/// string compare (so symbolic answers like "undefined" still work).
pub fn equivalent(a: &str, b: &str) -> bool {
    match (eval(a), eval(b)) {
        (Some(x), Some(y)) => approx_eq(x, y),
        _ => normalize_text(a) == normalize_text(b),
    }
}

fn approx_eq(x: f64, y: f64) -> bool {
    if x == y {
        return true;
    }
    let diff = (x - y).abs();
    // Absolute tolerance near zero, relative tolerance otherwise.
    diff <= EPS || diff <= EPS * x.abs().max(y.abs())
}

fn normalize_text(s: &str) -> String {
    s.trim()
        .trim_end_matches('=')
        .trim()
        .replace(['$', ' '], "")
        .to_ascii_lowercase()
}

/// Evaluate an expression string to f64, or None if it isn't a parseable
/// numeric expression.
pub fn eval(s: &str) -> Option<f64> {
    // Strip trivial formatting: surrounding $, whitespace, thousands commas, a
    // single trailing '=' (as in "x = ____" answers typed as "x=4" → "4").
    let cleaned: String = s
        .trim()
        .trim_start_matches("x=")
        .trim_start_matches("x =")
        .chars()
        .filter(|c| *c != '$' && *c != ',' && !c.is_whitespace())
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    let tokens = tokenize(&cleaned)?;
    let mut p = Parser { tokens, pos: 0 };
    let v = p.parse_expr()?;
    if p.pos != p.tokens.len() {
        return None; // trailing junk
    }
    v.is_finite().then_some(v)
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Plus,
    Minus,
    Star,
    Slash,
    Caret,
    LParen,
    RParen,
    Sqrt,
}

fn tokenize(s: &str) -> Option<Vec<Tok>> {
    let bytes = s.as_bytes();
    let mut toks = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        match c {
            '+' => {
                toks.push(Tok::Plus);
                i += 1;
            }
            '-' => {
                toks.push(Tok::Minus);
                i += 1;
            }
            '*' => {
                toks.push(Tok::Star);
                i += 1;
            }
            '/' => {
                toks.push(Tok::Slash);
                i += 1;
            }
            '^' => {
                toks.push(Tok::Caret);
                i += 1;
            }
            '(' => {
                toks.push(Tok::LParen);
                i += 1;
            }
            ')' => {
                toks.push(Tok::RParen);
                i += 1;
            }
            c if c.is_ascii_digit() || c == '.' => {
                let start = i;
                while i < bytes.len()
                    && ((bytes[i] as char).is_ascii_digit() || bytes[i] as char == '.')
                {
                    i += 1;
                }
                let num: f64 = s[start..i].parse().ok()?;
                toks.push(Tok::Num(num));
            }
            c if c.is_ascii_alphabetic() => {
                let start = i;
                while i < bytes.len() && (bytes[i] as char).is_ascii_alphabetic() {
                    i += 1;
                }
                match &s[start..i] {
                    "pi" => toks.push(Tok::Num(std::f64::consts::PI)),
                    "e" => toks.push(Tok::Num(std::f64::consts::E)),
                    "sqrt" => toks.push(Tok::Sqrt),
                    _ => return None, // unknown identifier → not a math expr
                }
            }
            _ => return None,
        }
    }
    Some(toks)
}

struct Parser {
    tokens: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.tokens.get(self.pos)
    }

    fn bump(&mut self) -> Option<Tok> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    // expr := term (('+' | '-') term)*
    fn parse_expr(&mut self) -> Option<f64> {
        let mut acc = self.parse_term()?;
        while let Some(op) = self.peek() {
            match op {
                Tok::Plus => {
                    self.bump();
                    acc += self.parse_term()?;
                }
                Tok::Minus => {
                    self.bump();
                    acc -= self.parse_term()?;
                }
                _ => break,
            }
        }
        Some(acc)
    }

    // term := factor (('*' | '/') factor)*
    fn parse_term(&mut self) -> Option<f64> {
        let mut acc = self.parse_factor()?;
        while let Some(op) = self.peek() {
            match op {
                Tok::Star => {
                    self.bump();
                    acc *= self.parse_factor()?;
                }
                Tok::Slash => {
                    self.bump();
                    let d = self.parse_factor()?;
                    acc /= d;
                }
                _ => break,
            }
        }
        Some(acc)
    }

    // factor := unary ('^' factor)?   (right-associative power)
    fn parse_factor(&mut self) -> Option<f64> {
        let base = self.parse_unary()?;
        if let Some(Tok::Caret) = self.peek() {
            self.bump();
            let exp = self.parse_factor()?;
            return Some(base.powf(exp));
        }
        Some(base)
    }

    // unary := '-' unary | atom
    fn parse_unary(&mut self) -> Option<f64> {
        if let Some(Tok::Minus) = self.peek() {
            self.bump();
            return Some(-self.parse_unary()?);
        }
        self.parse_atom()
    }

    // atom := Num | '(' expr ')' | 'sqrt' '(' expr ')'
    fn parse_atom(&mut self) -> Option<f64> {
        match self.bump()? {
            Tok::Num(n) => Some(n),
            Tok::LParen => {
                let v = self.parse_expr()?;
                matches!(self.bump(), Some(Tok::RParen)).then_some(v)
            }
            Tok::Sqrt => {
                matches!(self.bump(), Some(Tok::LParen)).then_some(())?;
                let v = self.parse_expr()?;
                matches!(self.bump(), Some(Tok::RParen)).then_some(v.sqrt())
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Required test: fill-in-blank grader returns equal for "1/2" vs "0.5".
    #[test]
    fn half_equals_decimal() {
        assert!(equivalent("1/2", "0.5"));
        assert!(equivalent("0.50", "1/2"));
        assert!(equivalent("$1/2$", " 0.5 "));
    }

    #[test]
    fn sqrt_forms_are_equivalent() {
        assert!(equivalent("sqrt(2)/2", "1/sqrt(2)"));
    }

    #[test]
    fn powers_and_parens() {
        assert!(equivalent("2^3", "8"));
        assert!(equivalent("-(3-5)", "2"));
        assert!(equivalent("2*pi", "6.283185307179586"));
    }

    #[test]
    fn distinct_values_not_equivalent() {
        assert!(!equivalent("1/2", "1/3"));
        assert!(!equivalent("4", "5"));
    }

    #[test]
    fn non_numeric_falls_back_to_text() {
        assert!(equivalent("undefined", "Undefined"));
        assert!(!equivalent("undefined", "infinity"));
    }
}
