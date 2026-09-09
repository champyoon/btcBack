import { pathToFileURL } from 'node:url';
import { parseArgs, run } from './test-coupang-deeplink.mjs';

export function samples(args) {
  const result = [
    { label: 'A Home', url: 'https://www.coupang.com/' },
    { label: 'B Product', url: 'https://www.coupang.com/vp/products/8279872054' },
    { label: 'D Search', url: 'https://www.coupang.com/np/search?q=생활용품' },
  ];
  let productAdded = false;
  let categories = 0;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], url = args[i + 1];
    if (!url || !['--product-options', '--category'].includes(flag)) throw Error('invalid_arguments');
    parseArgs([url]);
    if (flag === '--product-options') {
      const parsed = new URL(url);
      if (productAdded || !parsed.pathname.startsWith('/vp/products/') || !parsed.searchParams.get('itemId') || !parsed.searchParams.get('vendorItemId')) throw Error('invalid_product_options');
      productAdded = true;
      result.splice(2, 0, { label: 'C Product options', url });
    } else {
      if (++categories > 2) throw Error('too_many_categories');
      result.push({ label: `E Category/campaign ${categories}`, url });
    }
  }
  return result;
}

// Only display sanitized text. The request still receives the original URL unchanged.
function safeText(value, env) {
  if (value === null || value === undefined) return null;
  let text = String(value);
  for (const [name, secret] of Object.entries(env)) {
    if (secret && /KEY|SECRET|TOKEN|PASSWORD|AUTHORIZATION/i.test(name)) {
      for (const variant of [String(secret), encodeURIComponent(secret)]) text = text.split(variant).join('[redacted]');
    }
  }
  return text.replace(/(?:Bearer\s+|CEA\s+|(?:authorization|signature|secret|access[_-]?key)\s*(?:=|:|%3[dD]|%3[aA]))[^\s]*/gi, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

export async function diagnose(cases, { env = process.env, runner = run,
  pause = () => new Promise(resolve => setTimeout(resolve, 1000)), output = console.log } = {}) {
  const rows = [];
  for (const sample of cases) {
    for (const withSubId of [false, true]) {
      if (rows.length) await pause();
      let response;
      try { response = await runner({ url: sample.url, withSubId }, env); }
      catch { response = { httpStatus: null, rCode: null, rMessage: null }; }
      const hasUrl = value => typeof value === 'string' && value.length > 0;
      const row = {
        label: sample.label, inputUrl: safeText(sample.url, env),
        mode: withSubId ? 'with subId' : 'without subId',
        httpStatus: response.httpStatus,
        rCode: safeText(response.rCode, env), rMessage: safeText(response.rMessage, env),
        success: response.httpStatus >= 200 && response.httpStatus < 300 && String(response.rCode) === '0' && hasUrl(response.shortenUrl) && hasUrl(response.landingUrl),
        originalUrl: safeText(response.originalUrl, env),
        shortenUrlPresent: hasUrl(response.shortenUrl), landingUrlPresent: hasUrl(response.landingUrl),
      };
      rows.push(row);
      output(JSON.stringify(row));
    }
  }
  return rows;
}

export function summary(rows) {
  return [...new Set(rows.map(row => row.label))].map(label => {
    const pair = rows.filter(row => row.label === label);
    const status = row => !row || row.httpStatus === null ? 'INCONCLUSIVE' : row.success ? 'PASS' : 'FAIL';
    return { 'URL Type': label, 'without subId': status(pair[0]), 'with subId': status(pair[1]),
      rMessage: pair.map(row => `${row.mode}: ${row.rMessage ?? '(not returned)'}`).join(' | ') };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const cases = samples(process.argv.slice(2));
    for (const name of ['COUPANG_ACCESS_KEY', 'COUPANG_SECRET_KEY', 'COUPANG_TRACKING_CODE']) {
      if (!process.env[name]) throw Error('missing_configuration');
    }
    const rows = await diagnose(cases);
    console.table(summary(rows));
  } catch {
    console.error('Check environment and arguments: [--product-options "URL with itemId/vendorItemId"] [--category "actual category/campaign URL"] (max 2 categories). Details omitted for credential safety.');
    process.exitCode = 1;
  }
}
