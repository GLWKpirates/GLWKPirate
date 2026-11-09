// Shared, server-side cache for the KPIrates app's Google Sheet reads.
//
// Before this function existed, every visitor's browser read Google's public gviz/tq endpoint
// directly. That worked fine with one or two people testing, but it meant N visitors = N independent
// batches of requests hitting the same handful of spreadsheets, with zero sharing between them - at
// a couple hundred concurrent users that's thousands of requests a minute to Google for data that's
// only actually changing every few minutes. That volume is exactly what makes a public, undocumented
// endpoint like gviz start throttling or timing out requests unpredictably.
//
// This function is the one thing that actually calls Google now. kpirates-live.html's
// fetchSheetRows() calls THIS (same origin, plain fetch(), no more JSONP/CORS workaround needed) and
// this caches each sheet's rows in memory for CACHE_MS. Every visitor within that window gets served
// the same cached copy instead of causing a fresh Google request - so 200 people looking at the same
// district collapse into roughly one real upstream request per sheet per cache window, not 200.
//
// No Google Cloud service account, no API key, no sign-in: this reads the exact same public
// "anyone with the link can view" gviz URL the browser used to read directly, just centrally instead
// of once per visitor. Nothing here needs any ongoing setup or maintenance - it deploys with the
// rest of the site and the cache clears itself.

var ALLOWED_SHEETS = {
  '1THqEyy3eZpjd4Lhy7G5nioQw1v7B699uXd8fofVy1Pk': true, // main KPIrates workbook (RealTime_Data, DISTRICT tabs, stores, etc.)
  '1-AApV1SHjNRpNA61Qvet3mcpJVyubTd9EqB1glRmhPM': true  // Daily Ops Review workbook
};

var CACHE_MS = 90 * 1000; // matches roughly how often the sheet's own automation actually updates
// Lives only as long as this function instance does (Netlify may spin up more than one instance
// under heavy concurrent load, each with its own copy) - that's fine: worst case under a traffic
// spike is a few instances each making their own first request, which is still a tiny fraction of
// "every single browser makes its own request," not a step backwards from where the app was before.
var cache = {};

exports.handler = async function (event) {
  var params = event.queryStringParameters || {};
  var id = params.id;
  var sheetName = params.sheet;

  if (!id || !sheetName || !ALLOWED_SHEETS[id]) {
    return json(400, { error: 'unknown or missing spreadsheet id/sheet' });
  }

  var key = id + '::' + sheetName;
  var now = Date.now();
  var hit = cache[key];
  if (hit && (now - hit.at) < CACHE_MS) {
    return json(200, { rows: hit.rows, cached: true }, 30);
  }

  try {
    var rows = await fetchGviz(id, sheetName);
    cache[key] = { at: now, rows: rows };
    return json(200, { rows: rows, cached: false }, 30);
  } catch (e) {
    // Prefer a stale cached copy over an outright failure - a few-minutes-old number on screen
    // beats an error screen, especially during a brief upstream hiccup.
    if (hit) return json(200, { rows: hit.rows, cached: true, stale: true }, 10);
    return json(502, { error: String((e && e.message) || e) });
  }
};

async function fetchGviz(id, sheetName) {
  // headers=0 stops gviz from guessing which row is a "header" row and silently dropping it from
  // table.rows - several tabs (DISTRICT, for one) open with a decorative title/manager row that
  // gviz's own auto-detection can mistake for a header. Forcing headers=0 makes every row, including
  // row 1, come back as plain data.
  var url = 'https://docs.google.com/spreadsheets/d/' + id +
    '/gviz/tq?tqx=out:json&sheet=' + encodeURIComponent(sheetName) + '&headers=0';
  var res = await fetch(url);
  if (!res.ok) throw new Error('upstream ' + res.status + ' for ' + sheetName);
  var text = await res.text();
  // Without a responseHandler, gviz wraps its JSON in a JS callback
  // (`/*O_o*/\ngoogle.visualization.Query.setResponse({...});`) - pull the object literal out of it.
  var m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('unexpected response shape for ' + sheetName);
  var parsed = JSON.parse(m[0]);
  var table = parsed && parsed.table;
  return ((table && table.rows) || []).map(function (r) {
    return (r.c || []).map(function (cell) {
      if (!cell) return '';
      // .f is the cell's DISPLAYED text (e.g. "70%", "$1,234.56") - matching what a person sees in
      // the sheet; .v is the raw value, used only when a cell has no formatted form at all.
      if (cell.f != null) return cell.f;
      return cell.v == null ? '' : String(cell.v);
    });
  });
}

function json(statusCode, body, maxAge) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': maxAge ? 'public, max-age=' + maxAge : 'no-store'
    },
    body: JSON.stringify(body)
  };
}
