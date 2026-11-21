// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's reference CSV
// reader). Returns exactly what csv-reader returns for {text, header}:
// {columns, rows, errors}, following its broken-row policy:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote, and each CRLF or lone CR inside
//     it is read as LF; what follows its closing quote, up to the next comma
//     or line break, is appended as it stands (quote_junk, when the field
//     ends); a quote that never closes is a literal character, and the text
//     after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met, a field's
//     quote_junk when the field ends and a record's short_row or long_row
//     when the record ends; line is the 1-based line its record starts on,
//     counting every LF, CRLF and lone CR inside quotes, and row its
//     record's index in rows, null for the header.
//
// Speed comes from never building a field one character at a time: unquoted
// fields are located with indexOf (native search) and taken with slice,
// quoted fields are located the same way and only rebuilt when they contain
// doubled quotes or line breaks. The common path therefore does O(1) JS
// work per field instead of O(field length).

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Errors report these, not the current line.
  let recLine = 1;
  let recRow = null;

  function error(code) {
    errors.push({ code, line: recLine, row: recRow });
  }

  // The field just read: its value, how it ended, and how many characters
  // the unquoted scan kept (only used for quote_junk).
  let fv = '';
  let fe = END;
  let fa = 0;

  // Reads unquoted characters onto `init` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Sets fv/fe/fa.
  function scanUnquoted(init) {
    const comma = text.indexOf(',', pos);
    const nl = text.indexOf('\n', pos);
    let end;
    if (comma === -1 && nl === -1) {
      end = n;
      fe = END;
    } else if (nl === -1 || (comma !== -1 && comma < nl)) {
      end = comma;
      fe = COMMA;
    } else {
      end = nl;
      fe = LINE_BREAK;
    }
    const cr = text.indexOf('\r', pos);
    if (cr === -1 || cr >= end) {
      // No CR in the segment: take it whole, except a CR that is half of
      // the CRLF ending the field.
      if (fe === LINE_BREAK && end > pos && text.charCodeAt(end - 1) === 13) {
        fv = init + text.slice(pos, end - 1);
        pos = end + 1;
      } else {
        fv = init + text.slice(pos, end);
        pos = fe === END ? n : end + 1;
      }
      if (fe === LINE_BREAK) line += 1;
      fa = fv.length - init.length;
      return;
    }
    // Slow path: the segment holds CRs. A CR that is half of the CRLF
    // ending the field is the terminator; every other CR is stray.
    const last = fe === LINE_BREAK && text.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const pieces = [];
    let chunk = pos;
    let i = pos;
    while (i < last) {
      if (text.charCodeAt(i) === 13) {
        if (i > chunk) pieces.push(text.slice(chunk, i));
        error('stray_cr');
        i += 1;
        chunk = i;
      } else {
        i += 1;
      }
    }
    if (last > chunk) pieces.push(text.slice(chunk, last));
    fv = init + pieces.join('');
    pos = fe === END ? n : end + 1;
    if (fe === LINE_BREAK) line += 1;
    fa = fv.length - init.length;
  }

  // Reads a quoted field whose opening quote is at pos. Sets fv/fe/fa.
  function scanQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
    let doubled = false;
    let close = -1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        doubled = true;
        pos = q + 2;
        continue;
      }
      close = q;
      break;
    }
    if (close === -1) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      scanUnquoted('"');
      return;
    }
    const start = open + 1;
    if (!doubled) {
      const cr = text.indexOf('\r', start);
      const lf = text.indexOf('\n', start);
      if ((cr === -1 || cr >= close) && (lf === -1 || lf >= close)) {
        fv = text.slice(start, close);
        pos = close + 1;
      } else {
        fv = rebuildQuoted(start, close);
        pos = close + 1;
      }
    } else {
      fv = rebuildQuoted(start, close);
      pos = close + 1;
    }
    if (pos >= n) {
      fe = END;
      fa = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fe = COMMA;
    } else if (c === 10) {
      pos += 1;
      line += 1;
      fe = LINE_BREAK;
    } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fe = LINE_BREAK;
    } else {
      // What follows the closing quote is appended as it stands, up to
      // the next comma or line break.
      scanUnquoted(fv);
      if (fa > 0) error('quote_junk');
    }
  }

  // Rebuilds a quoted field's span [start, close): "" becomes one quote,
  // each CRLF or lone CR becomes LF (and counts a line).
  function rebuildQuoted(start, close) {
    const pieces = [];
    let chunk = start;
    let i = start;
    while (i < close) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        // A doubled quote: the scan only stopped at a lone one, so the
        // next character here is a quote too.
        if (i > chunk) pieces.push(text.slice(chunk, i));
        pieces.push('"');
        i += 2;
        chunk = i;
      } else if (c === 13) {
        if (i > chunk) pieces.push(text.slice(chunk, i));
        pieces.push('\n');
        line += 1;
        i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
        chunk = i;
      } else if (c === 10) {
        if (i > chunk) pieces.push(text.slice(chunk, i));
        pieces.push('\n');
        line += 1;
        i += 1;
        chunk = i;
      } else {
        i += 1;
      }
    }
    if (close > chunk) pieces.push(text.slice(chunk, close));
    return pieces.join('');
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recLine = line;
    recRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      if (quoted) scanQuoted();
      else scanUnquoted('');
      fields.push(fv);
    } while (fe === COMMA);

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
