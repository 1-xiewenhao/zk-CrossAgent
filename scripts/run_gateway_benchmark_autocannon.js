require("dotenv").config();

const fs = require("fs");
const path = require("path");
const autocannon = require("autocannon");

const GATEWAY_BASE_URL = process.env.GATEWAY_BASE_URL || "http://localhost:3000";
const DURATION_SECONDS = Number(process.env.BENCH_DURATION_SECONDS || 10);

const TARGETS = [10, 50, 100, 200, 500];

const PAYLOAD_DIR = path.join(__dirname, "../benchmark_payloads");

function fmt(n, digits = 2) {
    return Number(n || 0).toFixed(digits);
}

function loadJsonlBodies(filePath) {
    const raw = fs.readFileSync(filePath, "utf-8");
    return raw
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);
}

function runOne(concurrency, bodies) {
    let cursor = 0;
    let errorResponses = 0;
    let totalResponses = 0;

    return new Promise((resolve, reject) => {
        const instance = autocannon({
            url: GATEWAY_BASE_URL,
            connections: concurrency,
            duration: DURATION_SECONDS,
            pipelining: 1,
            requests: [
                {
                    method: "POST",
                    path: "/invoke",
                    headers: {
                        "content-type": "application/json"
                    },
                    setupRequest: (req) => {
                        const body = bodies[cursor % bodies.length];
                        cursor += 1;

                        req.method = "POST";
                        req.path = "/invoke";
                        req.headers = {
                            "content-type": "application/json",
                            "content-length": Buffer.byteLength(body)
                        };
                        req.body = body;

                        return req;
                    }
                }
            ],
            setupClient: (client) => {
                client.on("response", (statusCode) => {
                    totalResponses += 1;
                    if (statusCode >= 400) {
                        errorResponses += 1;
                    }
                });
            }
        });

        autocannon.track(instance, {
            renderProgressBar: true,
            renderLatencyTable: true,
            renderResultsTable: true,
            renderStatusCodes: true
        });

        instance.on("done", (result) => {
            try {
                const durationSec =
                    (result.duration && result.duration > 0)
                        ? result.duration
                        : DURATION_SECONDS;

                const requestsTotal =
                    result.requests && typeof result.requests.total === "number"
                        ? result.requests.total
                        : totalResponses;

                const tps =
                    durationSec > 0 ? requestsTotal / durationSec : 0;

                const p99 =
                    result.latency && typeof result.latency.p99 === "number"
                        ? result.latency.p99
                        : 0;

                const timeouts =
                    typeof result.timeouts === "number" ? result.timeouts : 0;

                resolve({
                    concurrency,
                    requestsTotal,
                    durationSec,
                    tps,
                    p99,
                    errors: errorResponses,
                    timeouts
                });
            } catch (err) {
                reject(err);
            }
        });

        instance.on("error", reject);
    });
}

async function main() {
    console.log("==================================================");
    console.log("🧪 gateway /invoke benchmark (autocannon + fixed payload files)");
    console.log(`🌐 target = ${GATEWAY_BASE_URL}/invoke`);
    console.log(`⏱️ duration per round = ${DURATION_SECONDS}s`);
    console.log(`📈 concurrency set = ${TARGETS.join(", ")}`);
    console.log(`📂 payload dir = ${PAYLOAD_DIR}`);
    console.log("==================================================\n");

    const allResults = [];

    for (const c of TARGETS) {
        const filePath = path.join(PAYLOAD_DIR, `c${c}.jsonl`);
        if (!fs.existsSync(filePath)) {
            throw new Error(`Missing payload file: ${filePath}`);
        }

        const bodies = loadJsonlBodies(filePath);
        console.log(`\n================ Round: concurrency=${c} ================`);
        console.log(`Loaded ${bodies.length} request bodies from ${filePath}\n`);

        const r = await runOne(c, bodies);
        allResults.push(r);

        console.log("\n[Round Summary]");
        console.log("Concurrent Agents, Total Requests, Duration(s), TPS, P99(ms), Errors, Timeouts");
        console.log(
            `${r.concurrency}, ${r.requestsTotal}, ${fmt(r.durationSec)}, ${fmt(r.tps)}, ${fmt(r.p99)}, ${r.errors}, ${r.timeouts}`
        );
    }

    console.log("\n==================================================");
    console.log("Final CSV");
    console.log("Concurrent Agents,Total Requests,Duration(s),TPS,P99 Latency (ms),Errors,Timeouts");
    for (const r of allResults) {
        console.log(
            `${r.concurrency},${r.requestsTotal},${fmt(r.durationSec)},${fmt(r.tps)},${fmt(r.p99)},${r.errors},${r.timeouts}`
        );
    }
    console.log("==================================================");
}

main().catch((err) => {
    console.error("❌ benchmark failed:", err);
    process.exit(1);
});