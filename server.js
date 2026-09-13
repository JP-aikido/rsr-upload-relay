/* ============================================================================
   rsr-upload-relay  —  small always-on relay (hosted on Render, not Vercel)
   ----------------------------------------------------------------------------
   PURPOSE: FileMaker Server's own Data API returns an invalid CORS setup for
   direct browser-to-server requests (confirmed: even after fixing the
   Access-Control-Allow-Origin value and adding an OPTIONS-preflight
   short-circuit in Apache, the Data API endpoint itself still fails the
   browser's CORS preflight check — it appears to be handled by a proprietary
   FileMaker Apache module that doesn't respect standard rewrite-phase
   short-circuiting). Rather than depend on FileMaker Server's own broken
   config, the browser instead uploads to THIS relay (CORS handled entirely
   in code below, fully within our control), and this relay forwards the file
   to FileMaker Server SERVER-TO-SERVER — server-to-server HTTP calls are
   never subject to browser CORS restrictions at all.

   This also sidesteps Vercel's ~4.5MB serverless request-body cap (files here
   are up to 300MB) — Render's free web-service tier has no such limit.

   POST /upload  (multipart/form-data, FIELDS BEFORE THE FILE — the file
   handler below reads already-parsed field values, so the browser must
   append text fields to its FormData before the file):
     token        - FileMaker Data API bearer token (minted by
                    /api/rsr-upload-auth on Vercel, scoped to the restricted
                    write-only "Contributor" account)
     host         - FileMaker Server host (aikido-db.biz)
     database     - RSR_Video_WEB
     layout       - Contributor
     recordId     - the contributor's FileMaker internal record id
     catalog, technique, category, instructor, format - the per-file metadata
     file         - the actual media file

   Does two things against FileMaker Server, in order:
     1. PATCH the file into Contributor::Upload (the container field)
     2. PATCH the record again with script="Contributor Upload Intake
        (server)" + script.param carrying the metadata, which does the actual
        httpsRoot export + Ryushin_DB record creation FileMaker-side.
   ============================================================================ */

const http = require('http');
const https = require('https');
const Busboy = require('busboy');
const FormData = require('form-data');

const PORT = process.env.PORT || 10000;
// Comma-separated list if more than one origin ever needs this.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://aikido-db.ca').split(',').map((s) => s.trim());
const MAX_FILE_BYTES = 300 * 1024 * 1024;

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

function fmContainerUpload({ host, database, layout, recordId, token }, fileStream, filename, cb) {
  const form = new FormData();
  form.append('upload', fileStream, { filename: filename || 'upload.bin' });
  const path = `/fmi/data/vLatest/databases/${encodeURIComponent(database)}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}/containers/Upload/1`;
  const headers = Object.assign({ Authorization: 'Bearer ' + token }, form.getHeaders());
  const req = https.request({ hostname: host, port: 443, path, method: 'PATCH', headers }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => { let json = {}; try { json = JSON.parse(data); } catch (_) {} cb(null, { status: res.statusCode, json }); });
  });
  req.on('error', (e) => cb(e));
  form.pipe(req);
}

function fmScriptTrigger({ host, database, layout, recordId, token, scriptParam }, cb) {
  const path = `/fmi/data/vLatest/databases/${encodeURIComponent(database)}/layouts/${encodeURIComponent(layout)}/records/${encodeURIComponent(recordId)}`
    + `?script=${encodeURIComponent('Contributor Upload Intake (server)')}&script.param=${encodeURIComponent(scriptParam)}`;
  const payload = JSON.stringify({ fieldData: {} });
  const req = https.request({
    hostname: host, port: 443, path, method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: 'Bearer ' + token },
  }, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => { let json = {}; try { json = JSON.parse(data); } catch (_) {} cb(null, { status: res.statusCode, json }); });
  });
  req.on('error', (e) => cb(e));
  req.write(payload);
  req.end();
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
    const { host, database, layout, recordId, token } = fields;
    if (!host || !database || !layout || !recordId || !token) {
      fileStream.resume();
      fail(400, 'Missing session information — please sign in again.');
      return;
    }

    fileStream.on('limit', () => fail(413, 'File is larger than the 300 MB limit.'));

    fmContainerUpload({ host, database, layout, recordId, token }, fileStream, info.filename, (err, uploadResult) => {
      if (handled) return;
      if (err) return fail(502, 'Upload to FileMaker Server failed: ' + err.message);
      if (uploadResult.status !== 200) return fail(502, 'FileMaker Server rejected the file upload.', uploadResult.json);

      const scriptParam = JSON.stringify({
        'Catalog#': fields.catalog || '',
        'Technique name': fields.technique || '',
        'Category': fields.category || '',
        "Instructor's name": fields.instructor || '',
        'Video Format': fields.format || '',
      });
      fmScriptTrigger({ host, database, layout, recordId, token, scriptParam }, (err2, finishResult) => {
        if (handled) return;
        if (err2) return fail(502, 'Finalizing the submission failed: ' + err2.message);
        const scriptError = finishResult.json.response && finishResult.json.response.scriptError;
        const scriptResult = (finishResult.json.response && finishResult.json.response.scriptResult) || '';
        if (finishResult.status !== 200 || (scriptError && String(scriptError) !== '0')) {
          return fail(502, scriptResult || 'Processing the upload into the catalog failed.', finishResult.json);
        }
        handled = true;
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, scriptResult }));
      });
    });
  });

  bb.on('error', (err) => fail(400, err.message));

  req.pipe(bb);
});

server.listen(PORT, () => console.log('rsr-upload-relay listening on ' + PORT));
