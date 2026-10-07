// Everything the API sends to the browser passes through here, so that responses carry
// only Loanbazaar AI branding: no upstream URLs, fetch diagnostics or provider names.

const BRAND = 'Loanbazaar AI';
const SOURCE_NAME = /screener(?:\.in)?/gi;
const SOURCE_NAME_TEST = /screener/i;
const LOOKS_LIKE_URL = /^(?:https?:)?\/\//i;

function scrubText(text) {
  if (typeof text !== 'string' || !SOURCE_NAME_TEST.test(text)) return text;
  // A link to the source is dropped outright; a mention in prose is rebranded
  if (LOOKS_LIKE_URL.test(text.trim())) return '';
  return text.replace(/(?:https?:\/\/)?(?:www\.)?screener\.in\S*/gi, BRAND).replace(SOURCE_NAME, BRAND);
}

function scrubDeep(value) {
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[scrubText(key)] = scrubDeep(item);
    return out;
  }
  return value;
}

function toPublicRegistry(registry) {
  if (!registry) return undefined;
  const { sourceUrl, ...rest } = registry;
  return rest;
}

// Company dossier as the browser receives it: the fetch log and source-side ids stay on the
// server. The company's Screener page is passed on only as a plain reference link for the
// card, next to the NSE, BSE and website links; nothing labels it as where the data comes from.
function toPublicCompany(data) {
  const { requestLogs, url, warehouseId, companyId, registry, ...rest } = data;
  const company = scrubDeep({ ...rest, registry: toPublicRegistry(registry) });
  if (url) company.screenerUrl = url;
  return company;
}

const PUBLIC_FAILURES = {
  UNLISTED: { status: 404, code: 'UNLISTED', error: 'This is an unlisted company, so its data is not available.' },
  NOT_ON_SCREENER: { status: 404, code: 'NOT_COVERED', error: 'Company data is not available for this listed company.' },
  MULTIPLE_MATCHES: { status: 409, code: 'MULTIPLE_MATCHES', error: 'More than one company matches. Please pick one.' },
  CIN_UNRESOLVED: { status: 404, code: 'CIN_UNRESOLVED', error: 'This CIN could not be resolved to a company.' },
  NOT_FOUND: { status: 404, code: 'NOT_FOUND', error: 'Company not found.' },
  SCREENER_UNAVAILABLE: {
    status: 503,
    code: 'DATA_UNAVAILABLE',
    error: 'Company data is not available right now. Please try again in a minute.',
  },
};

const GENERIC_FAILURE = { status: 500, error: 'Company data is not available right now.' };

// Lookup failure as the browser receives it. The detailed reason belongs in the server log.
function toPublicFailure(error) {
  const known = PUBLIC_FAILURES[error && error.code];
  if (!known) return { status: GENERIC_FAILURE.status, body: { error: GENERIC_FAILURE.error } };

  const details = error.details || {};
  const body = { error: known.error, code: known.code };
  if (details.cin) body.cin = details.cin;
  if (details.registry) body.registry = scrubDeep(toPublicRegistry(details.registry));
  if (details.candidates) {
    body.candidates = details.candidates.map((candidate) => ({ name: candidate.name, symbol: candidate.symbol }));
  }
  return { status: known.status, body };
}

// Rebrands streamed model text. A chunk can end partway through the source name, so a
// trailing fragment that could still become it is held back until the next chunk.
function createStreamScrubber(emit) {
  const longest = 'screener.in'.length;
  let held = '';

  return {
    push(text) {
      const combined = held + text;
      let keep = 0;
      for (let size = Math.min(longest - 1, combined.length); size > 0; size--) {
        if ('screener.in'.startsWith(combined.slice(-size).toLowerCase())) {
          keep = size;
          break;
        }
      }
      held = keep ? combined.slice(-keep) : '';
      const ready = keep ? combined.slice(0, -keep) : combined;
      if (ready) emit(ready.replace(SOURCE_NAME, BRAND));
    },
    flush() {
      if (held) emit(held.replace(SOURCE_NAME, BRAND));
      held = '';
    },
  };
}

const scrubModelText = (text) => (typeof text === 'string' ? text.replace(SOURCE_NAME, BRAND) : text);

module.exports = {
  BRAND,
  scrubDeep,
  scrubModelText,
  createStreamScrubber,
  toPublicCompany,
  toPublicFailure,
};
