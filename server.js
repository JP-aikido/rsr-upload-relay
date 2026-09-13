/* ============================================================================
   rsr-upload-relay  —  small always-on relay (hosted on Render, not Vercel)
   ----------------------------------------------------------------------------
   PURPOSE: FileMaker Server's own Data API returns an invalid CORS setup for
   direct browser-to-server requests (confirmed after several server-side
   fix attempts — it appears to be handled by a proprietary FileMaker Apache
   module that doesn't respect standard rewrite-phase short-circuiting).
   Rather than depend on FileMaker Server's own broken config, the browser
   uploads to THIS relay (CORS handled entirely in code below), and this
   relay forwards the file to FileMaker Server SERVER-TO-SERVER — server-to-
   server HTTP calls are never subject to browser CORS restrictions at all.

   This also sidesteps Vercel's ~4.5MB serverless request-body cap (files here
   are up to 300MB) — Render's free web-service tier has no such limit.

   FLOW (confirmed working, after three earlier design mistakes ruled out):
     1. Create the new (Pending Review) Ryushin_DB catalog record FIRST, via
        the "Contributor Upload Intake (server)" script — NO file yet. This
        used to try to "Export Field Contents" a copy of the file out to a
        static path under httpsRoot, but FileMaker Server does not support
        that script step writing to the filesystem when a script runs in
        this server-triggered context (confirmed: reported success, wrote
        nothing anywhere on the server). The script now just creates the
        record and returns its internal RecordID as "ok:<id>".
     2. Upload the actual file directly into THAT NEW record's own
        "Technique URL" container field (POST, not PATCH — the dedicated
        container endpoint only accepts POST, confirmed via its own
        "Allow: POST" 405 response when PATCH was tried).
     That's it — this relay does NOT touch the "URL" text field at all.
     FileMaker's own container-hosting URL (what you'd get by reading the
     container field back) requires authentication to fetch (confirmed: 401
     even with a valid bearer token), so it's useless for public embedding.
     Instead, a genuine FileMaker Server SCHEDULE ("Export Pending Uploads
     (scheduled)", configured in Admin Console, not triggered via the Data
     API) periodically finds rows with a populated container but a still-
     empty URL, exports each one to a real static file under httpsRoot, and
     sets URL to that public path — a true Schedule may have fuller
     server-side file access than a Data-API-triggered script does. This
     relay leaving URL blank is exactly the signal that script polls for.

   POST /upload (multipart/form-data, FIELDS BEFORE THE FILE — the file
   handler buffers the file into memory and only starts step 1 once all
   fields have already arrived, which requires the browser to append text
   fields to its FormData before the file):
     token         - FileMaker Data API bearer token (from /api/rsr-upload-auth
                     on Vercel, scoped to the restricted write-only
                     "Contributor" account)
     host          - FileMaker Server host (aikido-db.biz)
     database      - RSR_Video_WEB
     recordId      - the CONTRIBUTOR's FileMaker internal record id (used only
                     to have an authenticated record context to trigger the
                     intake script from)
     contributorId - the Contributor::ID# value, passed straight through into
                     the new Ryushin_DB record's Contributor ID# field
     catalog, technique, category, instructor, format - per-file metadata
     file          - the actual media file
   ============================================================================ */

const http = require('http');
const https = require('https');
const Busboy = require('busboy');
const FormData = require('form-data');

const PORT = process.env.PORT || 10000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://aikido-db.ca').split(',').map((s) => s.trim());
const MAX_FILE_BYTES = 300 * 1024 * 1024;
const CATALOG_LAYOUT = 'List'; // the Ryushin_DB layout the intake script and this relay both use

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function fmRequest(host, method, path, token, body, cb) {
  const payload = body ? JSON.stringify(body) : null;
  const headers = { Authorization: 'Bearer ' + token };
  if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
  const req = https.request({ hostname: host, port: 443, path, method, headers }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => { let json = {}; try { json = JSON.parse(data); } catch (_) {} cb(null, { status: res.statusCode, json }); });
  });
  req.on('error', (e) => cb(e));
  if (payload) req.write(payload);
  req.end();
}

// Step 1: create the catalog record (no file yet), via the Contributor
// record's own script-trigger endpoint.
function createCatalogRecord({ host, database, contributorRecordId, token, contributorId, catalog, technique, category, instructor, format }, cb) {
  const path = `/fmi/data/vLatest/databases/${encodeURIComponent(database)}/layouts/Contributor/records/${encodeURIComponent(contributorRecordId)}`;
  const scriptParam = JSON.stringify({
    ContributorID: contributorId || '',
    'Catalog#': catalog || '',
    'Technique name': technique || '',
    Category: category || '',
    "Instructor's name": instructor || '',
    'Video Format': format || '',
  });
  const body = { fieldData: {}, script: 'Contributor Upload Intake (server)', 'script.param': scriptParam };
  fmRequest(host, 'PATCH', path, token, body, (err, result) => {
    if (err) return cb(err);
    if (result.status !== 200) return cb(null, { ok: false, error: 'Could not create the catalog record.', detail: result.json });
    const scriptError = result.json.response && result.json.response.scriptError;
    const scriptResult = (result.json.response && result.json.response.scriptResult) || '';
    if (scriptError && String(scriptError) !== '0') return cb(null, { ok: false, error: scriptResult || 'Creating the catalog record failed.', detail: result.json });
    const m = /^ok:(\d+)$/.exec(scriptResult.trim());
    if (!m) return cb(null, { ok: false, error: scriptResult || 'Unexpected response creating the catalog record.', detail: result.json });
    cb(null, { ok: true, recordId: m[1] });
  });
}

// Step 2: upload the file into the NEW record's own container field.
function uploadContainer({ host, database, recordId, token }, fileBuffer, filename, cb) {
  const form = new FormData();
  form.append('upload', fileBuffer, { filename: filename || 'upload.bin' });
  const path = `/fmi/data/vLatest/databases/${encodeURIComponent(database)}/layouts/${encodeURIComponent(CATALOG_LAYOUT)}/records/${encodeURIComponent(recordId)}/containers/${encodeURIComponent('Technique URL')}/1`;
  const headers = Object.assign({ Authorization: 'Bearer ' + token }, form.getHeaders());
  const req = https.request({ hostname: host, port: 443, path, method: 'POST', headers }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => { let json = {}; try { json = JSON.parse(data); } catch (_) {} cb(null, { status: res.statusCode, json }); });
  });
  req.on('error', (e) => cb(e));
  form.pipe(req);
}

const server = http.createServer((req, res) => {
  setCors(req, res);

  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method === 'GET' && req.url === '/') { res.statusCode = 200; res.end('ok'); return; }
  if (req.method !== 'POST' || req.url !== '/upload') { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'Not found' })); return; }

  let bb;
  try {
    bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_FILE_BYTES } });
  } catch (e) {
    res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: 'Malformed upload request.' })); return;
  }

  const fields = {};
  let handled = false;
  const fail = (status, error, detail) => {
    if (handled) return;
    handled = true;
    res.statusCode = status;
    res.end(JSON.stringify({ ok: false, error, detail }));
  };

  bb.on('field', (name, val) => { fields[name] = val; });

  bb.on('file', (name, fileStream, info) => {
    if (name !== 'file') { fileStream.resume(); return; }

    const chunks = [];
    let tooLarge = false;
    fileStream.on('data', (c) => chunks.push(c));
    fileStream.on('limit', () => { tooLarge = true; });
    fileStream.on('end', () => {
      if (handled) return;
      if (tooLarge) return fail(413, 'File is larger than the 300 MB limit.');

      const { host, database, recordId, token, contributorId, catalog, technique, category, instructor, format } = fields;
      if (!host || !database || !recordId || !token) return fail(400, 'Missing session information — please sign in again.');

      const fileBuffer = Buffer.concat(chunks);

      createCatalogRecord({ host, database, contributorRecordId: recordId, token, contributorId, catalog, technique, category, instructor, format }, (err, createResult) => {
        if (handled) return;
        if (err) return fail(502, 'Creating the catalog record failed: ' + err.message);
        if (!createResult.ok) return fail(502, createResult.error, createResult.detail);

        uploadContainer({ host, database, recordId: createResult.recordId, token }, fileBuffer, info.filename, (err2, uploadResult) => {
          if (handled) return;
          if (err2) return fail(502, 'Uploading the file failed: ' + err2.message);
          if (uploadResult.status !== 200) return fail(502, 'FileMaker Server rejected the file upload.', uploadResult.json);

          // Deliberately stops here — the scheduled FileMaker Server script
          // picks up from the populated container + still-empty URL field.
          handled = true;
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true }));
        });
      });
    });
  });

  bb.on('error', (err) => fail(400, err.message));

  req.pipe(bb);
});

server.listen(PORT, () => console.log('rsr-upload-relay listening on ' + PORT));
