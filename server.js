// ===== SERVIDOR LOCAL - BM Gestão Financeira =====
// Execute: node server.js
// Acesse: http://localhost:3000 (local) ou http://SEU_IP:3000 (rede)

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 3000;
const ROOT = __dirname;

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.webmanifest': 'application/manifest+json'
};

const server = http.createServer((req, res) => {
    let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);

    // Security: prevent directory traversal
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // SPA fallback: serve index.html for missing routes
                fs.readFile(path.join(ROOT, 'index.html'), (err2, indexData) => {
                    if (err2) {
                        res.writeHead(500);
                        res.end('Server Error');
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(indexData);
                });
            } else {
                res.writeHead(500);
                res.end('Server Error');
            }
            return;
        }
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔═══════════════════════════════════════════════╗');
    console.log('║     🏦 BM Gestão Financeira - Servidor Local     ║');
    console.log('╠═══════════════════════════════════════════════╣');
    console.log(`║  Local:   http://localhost:${PORT}              ║`);

    // Get local network IP
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`║  Rede:    http://${iface.address}:${PORT}        ║`);
            }
        }
    }

    console.log('╠═══════════════════════════════════════════════╣');
    console.log('║  Compartilhe o link "Rede" com outros        ║');
    console.log('║  dispositivos na mesma rede Wi-Fi!            ║');
    console.log('╚═══════════════════════════════════════════════╝');
    console.log('');
});
