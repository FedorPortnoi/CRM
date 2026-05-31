const http = require('http');
const crypto = require('crypto');

// Get token first via HTTP login
const loginData = JSON.stringify({ email: 'smoke@test.com', password: 'Smoke123!' });
const loginReq = http.request({
  hostname: 'localhost', port: 3000, path: '/api/v1/auth/login', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginData) }
}, (res) => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    const token = JSON.parse(body).data?.token;
    if (!token) { console.error('No token:', body); process.exit(1); }
    testWs(token);
  });
});
loginReq.write(loginData);
loginReq.end();

function testWs(token) {
  const key = crypto.randomBytes(16).toString('base64');
  const req = http.request({
    hostname: 'localhost', port: 3000,
    path: `/api/v1/ws?token=${encodeURIComponent(token)}`,
    method: 'GET',
    headers: {
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13'
    }
  }, (res) => {
    console.log('HTTP status:', res.statusCode, '(expected: upgrade)');
  });

  req.on('upgrade', (res, socket) => {
    console.log('WS UPGRADE OK - status:', res.statusCode);
    console.log('WS endpoint works correctly');
    socket.destroy();
    process.exit(0);
  });

  req.on('error', e => { console.error('WS error:', e.message); process.exit(1); });
  req.setTimeout(5000, () => { console.error('Timeout'); process.exit(1); });
  req.end();
}
