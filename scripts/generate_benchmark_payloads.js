require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const OUTPUT_DIR = path.join(__dirname, "../benchmark_payloads");

const TRUSTED_ISSUER_PRIVATE_KEY = process.env.TRUSTED_ISSUER_PRIVATE_KEY || "";
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY || "";
const RAW_PROVIDER_ADDRESS =
    process.env.PROVIDER_ADDRESS || process.env.GATEWAY_PROVIDER_ADDRESS || "";

const DEFAULT_REQUIRED_SCOPE = process.env.DEFAULT_REQUIRED_SCOPE || "PUBLIC_MARKET_DATA";
const DEFAULT_REQUIRED_PERM = Number(process.env.DEFAULT_REQUIRED_PERM || 1);
const DEFAULT_CAP_EXPIRY_SECONDS = Number(process.env.DEFAULT_CAP_EXPIRY_SECONDS || 86400);
const PROVIDER_SERVICE_COST = Number(process.env.PROVIDER_SERVICE_COST || 8);

// 每档生成多少条。先用 5000 调试，后面可改成 20000/30000
const PAYLOAD_COUNT_PER_FILE = Number(process.env.BENCH_PAYLOAD_COUNT || 5000);

// 生成 6 档文件
const TARGETS = [10, 50, 100, 200, 500, 1000];

if (!TRUSTED_ISSUER_PRIVATE_KEY) {
    throw new Error("Missing TRUSTED_ISSUER_PRIVATE_KEY in .env");
}
if (!BUYER_PRIVATE_KEY) {
    throw new Error("Missing BUYER_PRIVATE_KEY in .env");
}
if (!RAW_PROVIDER_ADDRESS) {
    throw new Error("Missing PROVIDER_ADDRESS or GATEWAY_PROVIDER_ADDRESS in .env");
}

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const issuerWallet = new ethers.Wallet(TRUSTED_ISSUER_PRIVATE_KEY);
const buyerWallet = new ethers.Wallet(BUYER_PRIVATE_KEY);
const PROVIDER_ADDRESS = ethers.utils.getAddress(RAW_PROVIDER_ADDRESS);

function computeScopeHash(requiredScope) {
    return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(requiredScope));
}

function computeCapabilityId(capability) {
    return ethers.utils.solidityKeccak256(
        ["address", "address", "uint256", "uint256", "uint256", "bytes32", "uint256", "bytes32"],
        [
            capability.issuer,
            capability.holder,
            capability.perms,
            capability.budget,
            capability.expiry,
            capability.parentId,
            capability.nonce,
            capability.scopeHash
        ]
    );
}

function buildCapabilityMessageHash(capability) {
    return ethers.utils.solidityKeccak256(
        ["address", "address", "uint256", "uint256", "uint256", "bytes32", "uint256", "bytes32"],
        [
            capability.issuer,
            capability.holder,
            capability.perms,
            capability.budget,
            capability.expiry,
            capability.parentId,
            capability.nonce,
            capability.scopeHash
        ]
    );
}

async function buildRoundContext(roundIndex) {
    const scopeHash = computeScopeHash(DEFAULT_REQUIRED_SCOPE);
    const nowSec = Math.floor(Date.now() / 1000);
    const deadline = nowSec + DEFAULT_CAP_EXPIRY_SECONDS;

    const taskId = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
            ["address", "uint256", "string", "uint256"],
            [buyerWallet.address, Date.now(), "benchmark payload round", roundIndex]
        )
    );

    const taskMeta = {
        taskId,
        maxSubcalls: 100000000,
        deadline
    };

    const rootNonce = (BigInt(Date.now()) * 1000n + BigInt(roundIndex)).toString();

    const rootCapability = {
        issuer: issuerWallet.address,
        holder: buyerWallet.address,
        perms: DEFAULT_REQUIRED_PERM.toString(),
        budget: "1000000000",
        expiry: deadline,
        parentId: ethers.constants.HashZero,
        nonce: rootNonce,
        scopeHash
    };

    const rootMsgHash = buildCapabilityMessageHash(rootCapability);
    const rootSignature = await issuerWallet.signMessage(
        ethers.utils.arrayify(rootMsgHash)
    );
    const rootCapId = computeCapabilityId(rootCapability);

    const roundNonceBase =
        BigInt(Date.now()) * 1000000n + BigInt(roundIndex) * 100000000000n;

    return {
        scopeHash,
        taskMeta,
        rootCapability,
        rootSignature,
        rootCapId,
        roundNonceBase
    };
}

async function buildRequestBody(ctx, seq, tag) {
    const childNonce = (ctx.roundNonceBase + BigInt(seq)).toString();

    const childCapability = {
        issuer: ctx.rootCapability.issuer,
        holder: PROVIDER_ADDRESS,
        perms: DEFAULT_REQUIRED_PERM.toString(),
        budget: String(PROVIDER_SERVICE_COST),
        expiry: ctx.rootCapability.expiry,
        parentId: ctx.rootCapId,
        nonce: childNonce,
        scopeHash: ctx.scopeHash
    };

    const childMsgHash = buildCapabilityMessageHash(childCapability);
    const childSignature = await buyerWallet.signMessage(
        ethers.utils.arrayify(childMsgHash)
    );

    return {
        caller: buyerWallet.address,
        requestPayload: {
            operationName: `benchmark request ${tag} #${seq}`,
            requiredPerm: DEFAULT_REQUIRED_PERM,
            requiredScope: DEFAULT_REQUIRED_SCOPE
        },
        taskMeta: ctx.taskMeta,
        rootCapability: ctx.rootCapability,
        rootSignature: ctx.rootSignature,
        childCapability,
        childSignature
    };
}

async function main() {
    console.log(`输出目录: ${OUTPUT_DIR}`);
    console.log(`每个文件生成 ${PAYLOAD_COUNT_PER_FILE} 条`);

    for (let i = 0; i < TARGETS.length; i++) {
        const concurrency = TARGETS[i];
        const roundIndex = i + 1;
        const tag = `c${concurrency}`;
        const ctx = await buildRoundContext(roundIndex);

        const outPath = path.join(OUTPUT_DIR, `${tag}.jsonl`);
        const ws = fs.createWriteStream(outPath, { encoding: "utf-8" });

        console.log(`开始生成 ${tag}.jsonl ...`);

        for (let seq = 1; seq <= PAYLOAD_COUNT_PER_FILE; seq++) {
            const body = await buildRequestBody(ctx, seq, tag);
            ws.write(JSON.stringify(body) + "\n");
        }

        await new Promise((resolve) => ws.end(resolve));
        console.log(`完成: ${outPath}`);
    }

    console.log("全部合法请求文件已生成。");
}

main().catch((err) => {
    console.error("生成失败:", err);
    process.exit(1);
});