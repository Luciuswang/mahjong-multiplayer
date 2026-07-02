/**
 * GitHub Webhook 自动部署服务
 * 收到 main 分支 push 后拉取最新代码并重启 mahjong 服务。
 */

const http = require('http');
const { exec } = require('child_process');
const crypto = require('crypto');

const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT || 9000);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'mahjong-auto-deploy-2024';
const PROJECT_PATH = process.env.PROJECT_PATH || '/opt/mahjong-multiplayer';
const DEPLOY_TIMEOUT_MS = Number(process.env.DEPLOY_TIMEOUT_MS || 180000);

let isDeploying = false;
let queuedDeploy = false;
let lastDeploy = {
    status: 'idle',
    startedAt: null,
    finishedAt: null,
    message: 'No deploy has run yet'
};

function log(...args) {
    console.log(new Date().toISOString(), ...args);
}

function send(res, statusCode, body, contentType = 'text/plain; charset=utf-8') {
    res.writeHead(statusCode, { 'Content-Type': contentType });
    res.end(body);
}

function safeTimingEqual(a, b) {
    const left = Buffer.from(a || '');
    const right = Buffer.from(b || '');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifySignature(payload, signature) {
    if (!signature) return false;
    const hmac = crypto.createHmac('sha256', WEBHOOK_SECRET);
    const digest = 'sha256=' + hmac.update(payload).digest('hex');
    return safeTimingEqual(signature, digest);
}

function runDeployCommand(callback) {
    // GitHub occasionally drops TLS on the server; retry fetch and reset FETCH_HEAD only after success.
    const commands = `
        set -e
        cd "${PROJECT_PATH}"
        git config --global --add safe.directory "${PROJECT_PATH}" || true
        git config --global http.version HTTP/1.1 || true

        FETCH_OK=0
        for i in 1 2 3 4 5; do
          echo "fetch attempt $i"
          if git -c http.version=HTTP/1.1 fetch --depth=1 origin main; then
            FETCH_OK=1
            git reset --hard FETCH_HEAD
            break
          fi
          sleep 5
        done

        if [ "$FETCH_OK" != "1" ]; then
          echo "git fetch failed after retries" >&2
          exit 2
        fi

        npm install
        pm2 describe mahjong >/dev/null 2>&1 && pm2 restart mahjong || pm2 start server.js --name mahjong
        pm2 save
        echo "deployed commit: $(git rev-parse --short HEAD)"
    `;

    exec(commands, {
        shell: '/bin/bash',
        timeout: DEPLOY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 8
    }, callback);
}

function deploy(reason = 'webhook') {
    if (isDeploying) {
        queuedDeploy = true;
        log('Deploy already running; queued another deploy');
        return;
    }

    isDeploying = true;
    lastDeploy = {
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        message: reason
    };
    log('Starting deploy:', reason);

    runDeployCommand((error, stdout, stderr) => {
        isDeploying = false;
        lastDeploy.finishedAt = new Date().toISOString();

        if (stdout) log('Deploy stdout:\n' + stdout.trim());
        if (stderr) log('Deploy stderr:\n' + stderr.trim());

        if (error) {
            lastDeploy.status = 'failed';
            lastDeploy.message = error.message;
            log('Deploy failed:', error.message);
        } else {
            lastDeploy.status = 'success';
            lastDeploy.message = 'Deploy completed';
            log('Deploy completed successfully');
        }

        if (queuedDeploy) {
            queuedDeploy = false;
            setTimeout(() => deploy('queued deploy'), 1000);
        }
    });
}

function handleWebhook(req, res, body) {
    const event = req.headers['x-github-event'] || 'unknown';

    if (event === 'ping') {
        send(res, 200, 'pong');
        return;
    }

    if (WEBHOOK_SECRET && WEBHOOK_SECRET !== 'mahjong-auto-deploy-2024') {
        const signature = req.headers['x-hub-signature-256'];
        if (!verifySignature(body, signature)) {
            log('Signature verification failed');
            send(res, 401, 'Unauthorized');
            return;
        }
    }

    let payload;
    try {
        payload = JSON.parse(body || '{}');
    } catch (error) {
        log('Invalid JSON payload:', error.message);
        send(res, 400, 'Bad Request');
        return;
    }

    if (payload.ref !== 'refs/heads/main') {
        log('Skipped non-main push:', payload.ref);
        send(res, 200, 'OK - Skipped');
        return;
    }

    const message = payload.head_commit?.message || 'main push';
    log('Received main push:', message);
    deploy(message);
    send(res, 202, 'OK - Deploying');
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, JSON.stringify({
            ok: true,
            deploying: isDeploying,
            queuedDeploy,
            lastDeploy
        }, null, 2), 'application/json; charset=utf-8');
        return;
    }

    if (req.method !== 'POST' || req.url !== '/webhook') {
        send(res, 404, 'Not Found');
        return;
    }

    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
        if (body.length > 5 * 1024 * 1024) {
            req.destroy();
        }
    });
    req.on('end', () => handleWebhook(req, res, body));
});

server.on('error', error => {
    log(`Webhook server failed on port ${WEBHOOK_PORT}:`, error.message);
    process.exit(1);
});

server.listen(WEBHOOK_PORT, '0.0.0.0', () => {
    log(`Webhook service listening on 0.0.0.0:${WEBHOOK_PORT}`);
    log(`Health check: http://127.0.0.1:${WEBHOOK_PORT}/health`);
});
