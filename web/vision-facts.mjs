/**
 * Source-bound suggestions from already imported observations, without a model
 * call, unit/tolerance assignment, assembly inference, or engineering approval.
 * Keep this independent of the UI and of all private experiment artifacts.
 */
export const VISION_FACT_RULES_VERSION = 'drawing-observed-facts-v1.0';
const UNIT = '(?:mm|cm|m|[µμu]m|inches|inch|in|毫米|厘米|米|英寸)';
const unitDeclaration = () => new RegExp('(?:\\bDIMENSIONS?\\s+(?:ARE\\s+)?IN\\s+|\\bUNITS?\\s*[:=]\\s*|尺寸单位\\s*[:：]?\\s*)' +
  '(?<primary>' + UNIT + ')(?![A-Za-z])(?:\\s*\\[\\s*(?<secondary>' + UNIT + ')\\s*\\])?', 'gi');
const generalTolerance = () => /(?<label>(?<places>[1-9][0-9]*)\s*(?:PLC|PLACES?)\s*DEC(?:IMAL)?S?|ANGLES?|角度)\s*(?:[:：]\s*)?(?:±|\+\/-)\s*(?<amplitude>(?:[0-9]*\.[0-9]+|[0-9]+|[-−–—]))(?:\s*\[\s*(?<secondary>[0-9]*\.[0-9]+|[0-9]+|[-−–—])\s*\])?/gi;
const packageWord = /\b(?:REEL|BAG|BOX|TRAY|BULK|LOOSE\s+(?:PC|PCS|PIECE|PIECES))\b|卷盘|散装|袋装|盒装|托盘/i;
const packageRow = /^(?<prefix>.*?)(?<quantity>[0-9][0-9,]*|[-−–—])\s+(?<package>ON\s+TAPE\s*,?\s*REEL|TAPE\s*(?:AND|&|,)?\s*REEL|LOOSE\s+(?:PIECES?|PCS?)(?:\s*,?\s*(?:BAG|BOX))?|BAG|BOX|TRAY|REEL|BULK|卷盘|散装|袋装|盒装|托盘)\s+(?<part>[A-Za-z0-9][A-Za-z0-9_.\-/]*)\s*$/id;
const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));

async function sha(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function isPackagingHeader(text) {
  return /\b(?:PACKAGE|PACKAGING)\s+TYPE\b|包装(?:方式|类型)/i.test(text) &&
    /\bPART\s*(?:NO\.?|NUMBER)\b|料号|零件号/i.test(text) && /\b(?:QUANTITY|QTY)\b|数量/i.test(text);
}

function inputParts(input) {
  const result = input?.result ?? input;
  const payload = result?.payload;
  if (!payload || !Array.isArray(payload.observations) || !Array.isArray(result.sources)) {
    throw new TypeError('Vision facts require result.payload.observations and result.sources');
  }
  if (payload.observations.length > 2000) throw new RangeError('Too many observations');
  const sources = new Map(result.sources.map(source => [source.image_id, source]));
  const ids = new Set();
  for (const row of payload.observations) {
    if (!row || typeof row.id !== 'string' || ids.has(row.id) || !sources.has(row.image_id)) {
      throw new TypeError('Observation identity/source is invalid');
    }
    if (row.raw_text != null && (typeof row.raw_text !== 'string' || row.raw_text.length > 200000)) {
      throw new TypeError('Observation text is invalid');
    }
    ids.add(row.id);
  }
  return { payload, sources };
}

/** Return independent candidates only. Caller must not auto-apply or approve. */
export async function deriveVisionFacts(input) {
  const { payload, sources } = inputParts(input);
  const sourceCache = new Map();
  async function sourceFor(row) {
    if (!sourceCache.has(row.id)) {
      const source = sources.get(row.image_id);
      sourceCache.set(row.id, {
        image_id: row.image_id, observation_id: row.id, page: source.page ?? null,
        document_sha256: source.document_sha256 ?? null,
        original_image_sha256: source.original_image_sha256 ?? null,
        observation_raw_text_sha256: await sha(row.raw_text ?? ''), region: copy(row.region ?? null),
      });
    }
    return copy(sourceCache.get(row.id));
  }
  const readable = payload.observations.filter(row => row.kind === 'visible_text' && row.legibility !== 'unreadable' && row.raw_text);
  const referenceSuggestions = [];
  async function suggestion(row, kind, match) {
    return {
      id: kind + '-' + (await sha(row.image_id + '\0' + row.id + '\0' + [...row.raw_text.slice(0, match.index)].length)).slice(0, 16),
      kind, source_category: 'browser_rule_suggestion', rules_version: VISION_FACT_RULES_VERSION,
      generated_in: 'browser_import', status: 'pending_review', engineering_value_approved: false,
      applicability: 'requires_review', applied_to_field_ids: [], source: await sourceFor(row),
      evidence_ids: [row.id], raw_text: row.raw_text, matched_text: match[0],
      match_span: [match.index, match.index + match[0].length], span_encoding: 'utf16_code_units',
    };
  }
  for (const row of readable) {
    for (const match of row.raw_text.matchAll(unitDeclaration())) {
      referenceSuggestions.push({ ...await suggestion(row, 'global_unit_declaration', match),
        primary_unit_raw: match.groups.primary, secondary_unit_raw: match.groups.secondary ?? null });
    }
    if (/\bTOLERANCES?\b|公差/i.test(row.raw_text)) {
      for (const match of row.raw_text.matchAll(generalTolerance())) {
        const { amplitude, secondary, label, places } = match.groups;
        referenceSuggestions.push({ ...await suggestion(row, 'general_tolerance_declaration', match),
          label_raw: label, decimal_places_raw: places ?? null,
          amplitude_raw: /[0-9]/.test(amplitude) ? amplitude : null,
          secondary_amplitude_raw: secondary && /[0-9]/.test(secondary) ? secondary : null,
          value_status: /[0-9]/.test(amplitude) ? 'observed' : 'not_provided', units_assigned: false });
      }
    }
  }
  const headers = readable.filter(row => isPackagingHeader(row.raw_text));
  const headerIds = new Set(headers.map(row => row.id));
  const packagingVariants = [], unparsedRows = [];
  for (const row of readable) {
    if (headerIds.has(row.id) || !packageWord.test(row.raw_text)) continue;
    const candidates = headers.filter(header => header.image_id === row.image_id);
    if (!candidates.length) continue;
    const match = /[\r\n]/.test(row.raw_text) ? null : packageRow.exec(row.raw_text);
    if (candidates.length !== 1 || !match) {
      unparsedRows.push({ raw_text: row.raw_text, source: await sourceFor(row), evidence_ids: [row.id],
        status: 'pending_review', reason: candidates.length !== 1 ? 'ambiguous_packaging_header' : 'unsupported_row_layout' });
      continue;
    }
    const header = candidates[0], values = match.groups, spans = match.indices.groups;
    packagingVariants.push({
      id: 'package-' + (await sha(row.image_id + '\0' + row.id)).slice(0, 16),
      classification: 'packaging_variant', classification_status: 'pending_review',
      source_category: 'browser_rule_candidate', generated_in: 'browser_import', rules_version: VISION_FACT_RULES_VERSION,
      raw_text: row.raw_text, source: await sourceFor(row), header_source: await sourceFor(header),
      header_raw_text: header.raw_text, evidence_ids: [header.id, row.id], engineering_value_approved: false,
      quantity_meaning: 'packaging_amount_not_per_assembly', package_quantity_raw: /[0-9]/.test(values.quantity) ? values.quantity : null,
      quantity_cell_raw: values.quantity, package_type_raw: values.package, part_number_raw: values.part,
      unassigned_prefix_raw: values.prefix, assembly_quantity_raw: null, item_number_raw: null,
      literal_spans: { quantity_cell_raw: spans.quantity, package_type_raw: spans.package,
        part_number_raw: spans.part, unassigned_prefix_raw: spans.prefix }, span_encoding: 'utf16_code_units',
    });
  }
  // Final provenance checks also guard future changes to the extraction rules.
  for (const item of referenceSuggestions) {
    if (item.raw_text.slice(...item.match_span) !== item.matched_text || item.applied_to_field_ids.length || item.engineering_value_approved) {
      throw new TypeError('Reference suggestion provenance failed');
    }
  }
  for (const item of packagingVariants) {
    for (const [key, span] of Object.entries(item.literal_spans)) {
      if (item[key] !== item.raw_text.slice(...span)) throw new TypeError('Packaging literal provenance failed');
    }
  }
  return {
    referenceSuggestions, packagingVariants,
    tableAnalysis: { unparsed_table_rows: unparsedRows,
      packaging_headers: await Promise.all(headers.map(async row => ({ raw_text: row.raw_text, source: await sourceFor(row) }))),
      assembly_bom_candidates_unchanged: true, classification_is_human_verified: false },
    derivedFactsValidation: { literal_provenance_valid: true, field_values_modified: false,
      image_content_verified: false, engineering_value_approved: false }, rulesVersion: VISION_FACT_RULES_VERSION,
  };
}
