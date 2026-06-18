#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

function fail(message) {
  console.error(`Error: ${message}`);
  process.exitCode = 1;
}

function uploadFile(server, token, filePath, size) {
  return new Promise((resolve, reject) => {
    const url = new URL('/api/upload', server.endsWith('/') ? server : `${server}/`);
    const client = url.protocol === 'https:' ? https : http;
    if (!['http:', 'https:'].includes(url.protocol)) {
      reject(new Error('CLAWDROP_SERVER must use http:// or https://'));
      return;
    }

    const boundary = `----clawdrop-${crypto.randomBytes(18).toString('hex')}`;
    const fileName = path.basename(filePath).replace(/["\r\n]/g, '_');
    const prefix = Buffer.from(
      `--${boundary}\r\n`
      + `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`
      + 'Content-Type: application/octet-stream\r\n\r\n'
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);

    const request = client.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': prefix.length + size + suffix.length
      }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Server returned ${response.statusCode || 'an error'}: ${body?.error || text || 'empty response'}`));
          return;
        }
        resolve(body);
      });
    });

    request.on('error', reject);
    request.write(prefix);
    const input = fs.createReadStream(filePath);
    input.on('error', request.destroy.bind(request));
    input.on('end', () => request.end(suffix));
    input.pipe(request, { end: false });
  });
}

async function main() {
  const fileArg = process.argv[2];
  const server = process.env.CLAWDROP_SERVER;
  const token = process.env.CLAWDROP_UPLOAD_TOKEN;

  if (!fileArg) {
    fail('Usage: node scripts/upload.js <file>');
    return;
  }
  if (!server) {
    fail('CLAWDROP_SERVER is not set');
    return;
  }
  if (!token) {
    fail('CLAWDROP_UPLOAD_TOKEN is not set');
    return;
  }

  const filePath = path.resolve(fileArg);
  let stats;
  try {
    stats = await fsp.stat(filePath);
  } catch {
    fail(`File not found: ${fileArg}`);
    return;
  }
  if (!stats.isFile()) {
    fail(`Not a regular file: ${fileArg}`);
    return;
  }

  try {
    const result = await uploadFile(server, token, filePath, stats.size);
    const base = server.endsWith('/') ? server : `${server}/`;
    console.log(`Uploaded: ${result.file.originalName}`);
    console.log(`File ID: ${result.file.id}`);
    console.log(`Size: ${result.file.size} bytes`);
    console.log(`Download: ${new URL(result.file.downloadUrl.replace(/^\//, ''), base).href}`);
    console.log(`Preview: ${new URL(result.file.previewUrl.replace(/^\//, ''), base).href}`);
  } catch (error) {
    fail(error.message);
  }
}

main();
