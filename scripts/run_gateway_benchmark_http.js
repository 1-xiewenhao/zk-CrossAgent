require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "http://localhost:3000";
const DURATION_SECONDS = Number(process.env.BENCH_DURATION_SECONDS || 10);

// 只测试到 500 并发
const TARGETS = [10, 50, 100, 200, 500];

const PAYLOAD_DIR = path.join(__dirname, "../benchmark_payloads");

function fmt(n, digits = 2) {
    return Number(n || 0).toFixed(digits);
}

function percentile(sortedArr, p) {
    if (sortedArr.length === 0) return 0;
    const idx = Math.min(
        sortedArr.length - 1,
        Math.ceil((p / 100) * sortedArr.length) - 1
    );
    return sortedArr[idx];
}

function loadJsonlBodies(filePath) {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw.split("\n").map(x => x.trim()).filter(Boolean);
}

function makeClient(baseUrl, maxSockets) {
    const u = new URL(baseUrl);
    const isHttps = u.protocol === "https:";
    const transport = isHttps ? https : http;

    const agent = isHttps
        ? new https.Agent({
            keepAlive: true,
            maxSockets,
            maxFreeSockets: Math.min(maxSockets, 256)
        })
        : new http.Agent({
            keepAlive: true,
            maxSockets,
            maxFreeSockets: Math.min(maxSockets, 256)
        });

    async function post(bodyStr) {
        return new Promise((resolve) => {
            const started = process.hrtime.bigint();

            const req = transport.request(
                {
                    protocol: u.protocol,
                    hostname: u.hostname,
                    port: u.port,
                    path: "/invoke",
                    method: "POST",
                    agent,
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(bodyStr)
                    },
                    timeout: 30000
                },
                (res) => {
                    let errBuf = "";

                    res.on("data", (chunk) => {
                        if ((res.statusCode || 0) >= 400) {
                            errBuf += chunk.toString();
                        }
                    });

                    res.on("end", () => {
                        const ended = process.hrtime.bigint();
                        const latencyMs = Number(ended - started) / 1e6;
                        resolve({
                            ok: (res.statusCode || 0) < 400,
                            status: res.statusCode || 0,
                            latencyMs,
                            errorText: errBuf
                        });
                    });
                }
            );

            req.on("timeout", () => {
                req.destroy(new Error("timeout"));
            });

            req.on("error", (err) => {
                const ended = process.hrtime.bigint();
                const latencyMs = Number(ended - started) / 1e6;
                resolve({
                    ok: false,
                    status: "REQ_ERR",
                    latencyMs,
                    errorText: err.message || String(err)
                });
            });

            req.write(bodyStr);
            req.end();
        });
    }

    function destroy() {
        agent.destroy();
    }

    return { post, destroy };
}

async function runOne(concurrency, bodies) {
    const client = makeClient(GATEWAY_BASE_URL, Math.max(concurrency * 2, 64));
    const endAt = Date.now() + DURATION_SECONDS * 1000;

    let cursor = 0;
    let success = 0;
    let errors = 0;
    const latencies = [];
    const statusCount = {};
    const sampleErrors = [];

    function nextBody() {
        const idx = cursor;
        cursor += 1;
        if (idx >= bodies.length) return null;
        return bodies[idx];
    }

    async function worker() {
        while (Date.now() < endAt) {
            const body = nextBody();
            if (!body) break;

            const result = await client.post(body);
            latencies.push(result.latencyMs);

            if (result.ok) {
                success += 1;
            } else {
                errors += 1;
                const key = String(result.status);
                statusCount[key] = (statusCount[key] || 0) + 1;
                if (sampleErrors.length < 5) {
                    sampleErrors.push({
                        status: result.status,
                        msg: result.errorText
                    });
                }
            }
        }
    }

    const actualStart = Date.now();
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    const actualEnd = Date.now();
    client.destroy();

    const elapsedSec = (actualEnd - actualStart) / 1000;
    latencies.sort((a, b) => a - b);

    const totalCompleted = success + errors;
    const tps = elapsedSec > 0 ? totalCompleted / elapsedSec : 0;
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);

    return {
        concurrency,
        totalCompleted,
        elapsedSec,
        success,
        errors,
        tps,
        p50,
        p95,
        p99,
        statusCount,
        sampleErrors
    };
}

async function main() {
    console.log("==================================================");
    console.log("gateway /invoke benchmark (direct HTTP, self-measured)");
    console.log(`target = ${GATEWAY_BASE_URL}/invoke`);
    console.log(`duration per round = ${DURATION_SECONDS}s`);
    console.log(`payload dir = ${PAYLOAD_DIR}`);
    console.log(`concurrency set = ${TARGETS.join(", ")}`);
    console.log("==================================================\n");

    const allResults = [];

    for (const c of TARGETS) {
        const filePath = path.join(PAYLOAD_DIR, `c${c}.jsonl`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Missing payload file: ${filePath}`);
        }

        const bodies = loadJsonlBodies(filePath);
        console.log(`\n================ Round: concurrency=${c} ================`);
        console.log(`Loaded ${bodies.length} bodies`);

        const r = await runOne(c, bodies);
        allResults.push(r);

        console.log("[Round Summary]");
        console.log(`elapsedSec=${fmt(r.elapsedSec)} totalCompleted=${r.totalCompleted} success=${r.success} errors=${r.errors}`);
        console.log(`TPS=${fmt(r.tps)} P50=${fmt(r.p50)}ms P95=${fmt(r.p95)}ms P99=${fmt(r.p99)}ms`);
        console.log(`statusCount=${JSON.stringify(r.statusCount)}`);
        if (r.sampleErrors.length > 0) {
            console.log(`sampleErrors=${JSON.stringify(r.sampleErrors, null, 2)}`);
        }
    }

    console.log("\n==================================================");
    console.log("Final CSV");
    console.log("Concurrent Agents,Total Requests,Duration(s),TPS,P99 Latency (ms),Errors");
    for (const r of allResults) {
        console.log(`${r.concurrency},${r.totalCompleted},${fmt(r.elapsedSec)},${fmt(r.tps)},${fmt(r.p99)},${r.errors}`);
    }
    console.log("==================================================");
}

main().catch((err) => {
    console.error("benchmark failed:", err);
    process.exit(1);
});