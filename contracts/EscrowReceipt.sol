// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title EscrowReceipt
 * @dev route-B 版本：
 * - payer: 用户/issuer，预算池所有者
 * - caller: buyer / orchestrator agent（如 DeepSeek）
 * - orchestrator: 编排方收益接收者（当前通常等于 caller）
 * - provider: 下游服务提供者（如 gateway / Qwen）
 *
 * 资金流：
 * - payer 先向预算池充值
 * - buyer 持 root capability，并派生 child capability 给 provider
 * - provider 交付服务后签 sigP
 * - buyer/orchestrator 再签 sigC
 * - settleReceipt() 从 payer 的预算池中扣除 totalAmount
 *   并分别向 provider 和 orchestrator 分账
 */
contract EscrowReceipt {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    mapping(address => uint256) public escrowBalance;
    mapping(bytes32 => bool) public isSettled;

    address public trustedCrossChainEndpoint;

    constructor(address _endpoint) {
        trustedCrossChainEndpoint = _endpoint;
    }

    modifier onlyTrustedEndpoint() {
        require(
            msg.sender == trustedCrossChainEndpoint,
            "Security: Only Trusted Cross-Chain Endpoint Allowed"
        );
        _;
    }

    event Deposited(address indexed payer, uint256 amount);

    event ReceiptSettled(
        bytes32 indexed callId,
        address indexed payer,
        address indexed provider,
        address orchestrator,
        uint256 providerAmount,
        uint256 orchestratorFee
    );

    struct Receipt {
        bytes32 callId;

        // route-B: 显式区分 root / child capability
        bytes32 rootCapId;
        bytes32 childCapId;

        address payer;                 // issuer / user / budget owner
        address caller;                // buyer / DeepSeek
        address payable orchestrator;  // 编排方收益接收者
        address payable provider;      // 下游服务商 / gateway

        uint256 providerAmount;        // provider 收款
        uint256 orchestratorFee;       // orchestrator 收益

        uint256 timestamp;
        bytes32 reqHash;
        bytes32 respHash;

        bytes sigP; // provider 对完整 receipt 签名
        bytes sigC; // caller 对 (providerMsgHash, sigP) 二次签名
    }

    function depositFor(address payer) external payable {
        require(payer != address(0), "Invalid payer");
        require(msg.value > 0, "Deposit amount must be greater than 0");

        escrowBalance[payer] += msg.value;
        emit Deposited(payer, msg.value);
    }

    function settleReceipt(Receipt calldata r) external onlyTrustedEndpoint {
        require(!isSettled[r.callId], "Receipt already settled");
        require(r.payer != address(0), "Invalid payer");
        require(r.caller != address(0), "Invalid caller");
        require(r.orchestrator != address(0), "Invalid orchestrator");
        require(r.provider != address(0), "Invalid provider");

        uint256 totalAmount = r.providerAmount + r.orchestratorFee;
        require(totalAmount > 0, "Invalid total amount");
        require(escrowBalance[r.payer] >= totalAmount, "Insufficient escrow balance");

        // Provider 签名内容：
        // (callId, rootCapId, childCapId, payer, caller, orchestrator, provider,
        //  providerAmount, orchestratorFee, timestamp, reqHash, respHash)
        bytes32 providerMsgHash = keccak256(
            abi.encodePacked(
                r.callId,
                r.rootCapId,
                r.childCapId,
                r.payer,
                r.caller,
                r.orchestrator,
                r.provider,
                r.providerAmount,
                r.orchestratorFee,
                r.timestamp,
                r.reqHash,
                r.respHash
            )
        );

        require(
            providerMsgHash.toEthSignedMessageHash().recover(r.sigP) == r.provider,
            "Invalid Provider Signature"
        );

        // Caller 二次签名内容：(providerMsgHash, sigP)
        bytes32 callerMsgHash = keccak256(abi.encodePacked(providerMsgHash, r.sigP));

        require(
            callerMsgHash.toEthSignedMessageHash().recover(r.sigC) == r.caller,
            "Invalid Caller Signature"
        );

        isSettled[r.callId] = true;
        escrowBalance[r.payer] -= totalAmount;

        // 分账
        r.provider.transfer(r.providerAmount);
        if (r.orchestratorFee > 0) {
            r.orchestrator.transfer(r.orchestratorFee);
        }

        emit ReceiptSettled(
            r.callId,
            r.payer,
            r.provider,
            r.orchestrator,
            r.providerAmount,
            r.orchestratorFee
        );
    }
}